// Browser side of jackpotbench.cjs: compiles jackpot.wgsl, checks it tile for
// tile against pearl.mjs on Pearl's own vectors, and times it.
import { commitmentSeeds, computeNoise, computeJackpot, jackpotHash, jobKey, padChunk } from "./pearl.mjs";

const unhex = (s) => Uint8Array.from(s.match(/../g).map((h) => parseInt(h, 16)));
const hex = (u8) => Array.from(u8, (b) => b.toString(16).padStart(2, "0")).join("");
const b64 = (s) => new Int8Array(Uint8Array.from(atob(s), (c) => c.charCodeAt(0)).buffer);
const words = (u8) => new Uint32Array(u8.slice().buffer);

let dev, adapterInfo;
const pipes = new Map();
window.stop = false;

async function device() {
  if (dev) return dev;
  const ad = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
  if (!ad) throw new Error("no WebGPU adapter");
  adapterInfo = ad.info ? `${ad.info.vendor} ${ad.info.architecture} ${ad.info.description || ""}`.trim() : "?";
  dev = await ad.requestDevice({ requiredLimits: { maxStorageBufferBindingSize: ad.limits.maxStorageBufferBindingSize, maxBufferSize: ad.limits.maxBufferSize } });
  return dev;
}

async function pipeline(tm, tn) {
  const key = `${tm}x${tn}`;
  if (pipes.has(key)) return pipes.get(key);
  const d = await device();
  const src = (await (await fetch("jackpot.wgsl")).text()).replaceAll("{{TM}}", tm).replaceAll("{{TN}}", tn);
  const mod = d.createShaderModule({ code: src });
  const errs = (await mod.getCompilationInfo()).messages.filter((m) => m.type === "error");
  if (errs.length) throw new Error(errs.map((m) => `${m.lineNum}:${m.linePos} ${m.message}`).join(" | "));
  const p = await d.createComputePipelineAsync({ layout: "auto", compute: { module: mod, entryPoint: "main" } });
  pipes.set(key, p);
  return p;
}

// One run of the kernel over packed A' (m x kw words) and B'^t (n x kw words).
async function setup(tm, tn, Aw, Bw, m, n, kw, rw, key, bound, debug) {
  const d = await device(), p = await pipeline(tm, tn);
  const buf = (data, usage) => { const b = d.createBuffer({ size: Math.max(16, data.byteLength), usage, mappedAtCreation: true }); new Uint32Array(b.getMappedRange()).set(data); b.unmap(); return b; };
  const params = new Uint32Array(24);
  params.set([m, n, kw, rw, debug ? 1 : 0, 1024, 0, 0]); params.set(key, 8); params.set(bound, 16);
  const pb = buf(params, GPUBufferUsage.UNIFORM);
  const ab = buf(Aw, GPUBufferUsage.STORAGE), bb = buf(Bw, GPUBufferUsage.STORAGE);
  const hits = d.createBuffer({ size: 8 + 1024 * 8, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST });
  const dbgWords = debug ? (m / 16) * (n / 16) * 8 : 4;
  const dbg = d.createBuffer({ size: dbgWords * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
  const bind = d.createBindGroup({ layout: p.getBindGroupLayout(0), entries: [pb, ab, bb, hits, dbg].map((b, i) => ({ binding: i, resource: { buffer: b } })) });
  const grid = [n / (16 * tn), m / (16 * tm)];
  const encode = (e) => { const ps = e.beginComputePass(); ps.setPipeline(p); ps.setBindGroup(0, bind); ps.dispatchWorkgroups(grid[0], grid[1]); ps.end(); };
  const read = async (b, words) => { const r = d.createBuffer({ size: words * 4, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST }); const e = d.createCommandEncoder(); e.copyBufferToBuffer(b, 0, r, 0, words * 4); d.queue.submit([e.finish()]); await r.mapAsync(GPUMapMode.READ); const out = new Uint32Array(r.getMappedRange()).slice(); r.unmap(); r.destroy(); return out; };
  const free = () => [pb, ab, bb, hits, dbg].forEach((b) => b.destroy());
  return { d, encode, hits, dbg, dbgWords, read, free };
}

// Pack int8 rows of length k into words, padding the row count up to `rows`.
const pack = (rowsArr, rows, k) => { const u8 = new Uint8Array(rows * k); rowsArr.forEach((r, i) => { for (let l = 0; l < k; l++) u8[i * k + l] = r[l] & 255; }); return words(u8); };

// Check every 16 x 16 tile of a vector's product against pearl.mjs.
window.kat = async (t, tm, tn) => {
  const k = t.config.k, r = t.config.rank, m = t.m, n = t.n, salted = t.seed_derivation === "Salted";
  const A = b64(t.a_b64_row_major), B = b64(t.b_b64_row_major_k_by_n);
  const jk = jobKey(unhex(t.header.bytes), unhex(t.config.bytes));
  const bT = new Uint8Array(n * k);
  for (let i = 0; i < k; i++) for (let j = 0; j < n; j++) bT[j * k + i] = B[i * n + j] & 255;
  const { bNoiseSeed, aNoiseSeed } = commitmentSeeds(jk, padChunk(Uint8Array.from(A, (x) => x & 255)), padChunk(bT), m, n, salted);
  const allRows = [...Array(m).keys()], allCols = [...Array(n).keys()];
  const noise = computeNoise(k, r, bNoiseSeed, aNoiseSeed, allRows, allCols);
  const aRows = allRows.map((i) => Int8Array.from({ length: k }, (_, l) => A[i * k + l]));
  const bRows = allCols.map((j) => Int8Array.from({ length: k }, (_, l) => B[l * n + j]));
  const aN = aRows.map((row, i) => row.map((x, l) => x + noise.a[i][l]));
  const bN = bRows.map((row, j) => row.map((x, l) => x + noise.b[j][l]));
  const M = Math.ceil(m / (16 * tm)) * 16 * tm, N = Math.ceil(n / (16 * tn)) * 16 * tn; // pad to whole blocks
  const run = await setup(tm, tn, pack(aN, M, k), pack(bN, N, k), M, N, k / 4, r / 4, words(aNoiseSeed), new Uint32Array(8).fill(0xffffffff), true);
  const e = run.d.createCommandEncoder(); run.encode(e); run.d.queue.submit([e.finish()]);
  const got = await run.read(run.dbg, run.dbgWords);
  run.free();
  let bad = 0, checked = 0;
  for (let tr = 0; tr < m / 16; tr++) for (let tc = 0; tc < n / 16; tc++) {
    const rows = [...Array(16).keys()].map((i) => tr * 16 + i), cols = [...Array(16).keys()].map((j) => tc * 16 + j);
    const jp = computeJackpot(rows.map((i) => aRows[i]), cols.map((j) => bRows[j]), { a: rows.map((i) => noise.a[i]), b: cols.map((j) => noise.b[j]) }, k, r);
    const want = hex(jackpotHash(jp, aNoiseSeed));
    const off = (tr * (N / 16) + tc) * 8;
    const have = hex(new Uint8Array(got.slice(off, off + 8).buffer));
    checked++; if (have !== want) bad++;
  }
  const off0 = 0, tile0 = hex(new Uint8Array(got.slice(off0, off0 + 8).buffer));
  return { name: t.name, tiles: checked, mismatched: bad, tile0MatchesPearl: tile0 === t.jackpot_hash, adapter: adapterInfo };
};

// Time back-to-back dispatches for `secs` (or until window.stop). Random
// noised-range data; the bound is 0 so nothing is written back but the work
// cannot be skipped.
let benchRun = null;
window.benchSetup = async (tm, tn, m, n, k, r) => {
  if (benchRun) benchRun.free();
  const rand = new Uint32Array((Math.max(m, n) * k) / 4);
  for (let i = 0; i < rand.length; i++) rand[i] = ((Math.random() * 2 ** 32) >>> 0) & 0x7f7f7f7f; // bytes in [0,127]
  benchRun = await setup(tm, tn, rand.subarray(0, (m * k) / 4), rand.subarray(0, (n * k) / 4), m, n, k / 4, r / 4, new Uint32Array(8), new Uint32Array(8), false);
  benchRun.shape = { m, n, k };
  const e = benchRun.d.createCommandEncoder(); benchRun.encode(e); benchRun.d.queue.submit([e.finish()]);
  await benchRun.d.queue.onSubmittedWorkDone(); // warm-up / compile
  return adapterInfo;
};
window.benchBurst = async (secs) => {
  const { d, encode, shape } = benchRun;
  let n = 0; const t0 = performance.now();
  while (!window.stop && performance.now() - t0 < secs * 1000) {
    const e = d.createCommandEncoder(); encode(e); encode(e); d.queue.submit([e.finish()]);
    await d.queue.onSubmittedWorkDone(); n += 2;
  }
  const s = (performance.now() - t0) / 1000;
  const macs = n * shape.m * shape.n * shape.k;
  return { dispatches: n, seconds: s, msPerDispatch: (s * 1000) / n, tmacs: macs / s / 1e12, tilesPerSec: (n * (shape.m / 16) * (shape.n / 16)) / s, stopped: window.stop };
};
