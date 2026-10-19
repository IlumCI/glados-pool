// Browser side of pearlgpu-check.cjs: the GPU round against pearlmine.mjs's.
import { PearlGPU } from "./pearl-gpu.js";
import { round } from "./pearlmine.mjs";
import { verifyShare } from "./pearlproof.mjs";

const hex = (u8) => Array.from(u8, (b) => b.toString(16).padStart(2, "0")).join("");
let device;
const dev = async () => {
  if (device) return device;
  const ad = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
  device = await ad.requestDevice({ requiredLimits: { maxStorageBufferBindingSize: ad.limits.maxStorageBufferBindingSize, maxBufferSize: ad.limits.maxBufferSize } });
  window.adapterInfo = ad.info ? `${ad.info.vendor} ${ad.info.architecture}` : "?";
  return device;
};
const src = async () => ({ round: await (await fetch("pearl-round.wgsl")).text(), jackpot: await (await fetch("jackpot.wgsl")).text() });

window.check = async (m, n, s0, s1) => {
  const header = new Uint8Array(76).map((_, i) => (i * 37 + 11) & 255);
  const opts = { m, n, k: 2048, rank: 128 };
  const ref = round(header, { ...opts, s0, s1 });
  const g = await PearlGPU.create(await dev(), { ...opts, ...(await src()) });
  const r = await g.round(header, s0, s1, 0, { debug: true });
  const res = { adapter: window.adapterInfo, rootA: hex(r.rootA) === hex(ref.rootA), rootB: hex(r.rootB) === hex(ref.rootB), tiles: 0, tilesSame: 0, hits: r.found, proofsSame: 0, proofsVerify: 0 };
  for (let tr = 0; tr < m / 16; tr++) for (let tc = 0; tc < n / 16; tc++) {
    const off = (tr * (n / 16) + tc) * 32;
    res.tiles++;
    if (hex(r.tileHashes.slice(off, off + 32)) === hex(ref.tileHash(tr, tc))) res.tilesSame++;
  }
  for (const [tr, tc] of [[0, 0], [m / 16 - 1, n / 16 - 1]]) {
    const gp = await g.proof(tr, tc), rp = ref.proof(tr, tc);
    if (gp.length === rp.length && gp.every((x, i) => x === rp[i])) res.proofsSame++;
    if (verifyShare(gp, header, { bound: (1n << 256n) - 1n }).ok) res.proofsVerify++;
  }
  return res;
};

// Full-size rounds, timed: the whole round and the jackpot alone.
let big = null;
window.benchSetup = async (m, n) => { big = await PearlGPU.create(await dev(), { m, n, k: 2048, rank: 128, ...(await src()) }); return window.adapterInfo; };
window.benchRounds = async (count, bits) => {
  const header = new Uint8Array(76).map((_, i) => (i * 13 + 5) & 255);
  const t = [];
  let hits = 0;
  for (let i = 0; i < count; i++) {
    const t0 = performance.now();
    const r = await big.round(header, 1000 + i, 7 * i + 3, bits);
    t.push(performance.now() - t0);
    hits += r.found;
  }
  return { msPerRound: t.reduce((a, b) => a + b) / t.length, rounds: t.map((x) => +x.toFixed(1)), hits };
};
