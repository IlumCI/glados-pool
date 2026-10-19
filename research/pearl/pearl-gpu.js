// The host side of a Pearl round on WebGPU: pearl-round.wgsl for the matrices,
// the commitment and the noise, jackpot.wgsl for the tiles, and the proof for
// any tile that hits, assembled from what the GPU holds.
//
//   const g = await PearlGPU.create(device, { m, n, k, rank, round: wgsl, jackpot: wgsl, tm: 4, tn: 4 });
//   const r = await g.round(header76, s0, s1, bits);   // { rootA, rootB, hits: [[tr, tc], ...] }
//   const proof = await g.proof(tr, tc);                // bincode PlainProof bytes, for the last round
//
// One CPU stop a round: the two trees' top nodes come back so the roots -- and
// from them the noise seeds and permutations -- can be made, which is a few
// dozen hashes. Everything else stays on the GPU.

import { blake3, seedsFromRoots, permMatrix, SEED_LABEL_A, SEED_LABEL_B, rootOf } from "./pearl.mjs";
import { configBytes, encodeProof } from "./pearlproof.mjs";
import { siblingsFor, CHUNK, TILE } from "./pearlmine.mjs";

const U = GPUBufferUsage;
const words = (u8) => new Uint32Array(u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength));

export class PearlGPU {
  static async create(device, opts) {
    const g = new PearlGPU();
    await g.init(device, opts);
    return g;
  }

  async init(device, { m, n, k, rank, round, jackpot, tm = 4, tn = 4, salted = true }) {
    Object.assign(this, { device, m, n, k, rank, tm, tn, salted });
    if (m % (16 * tm) || n % (16 * tn) || k % 64 || rank % 32) throw new Error("m, n must be whole blocks; k a multiple of 64; rank of 32");
    const mod = (code) => device.createShaderModule({ code });
    const check = async (mo, what) => {
      const e = (await mo.getCompilationInfo()).messages.filter((x) => x.type === "error");
      if (e.length) throw new Error(`${what}: ${e.map((x) => `${x.lineNum}:${x.linePos} ${x.message}`).join(" | ")}`);
    };
    const rm = mod(round), jm = mod(jackpot.replaceAll("{{TM}}", tm).replaceAll("{{TN}}", tn));
    await check(rm, "pearl-round.wgsl"); await check(jm, "jackpot.wgsl");
    const pipe = (module, entryPoint) => device.createComputePipelineAsync({ layout: "auto", compute: { module, entryPoint } });
    this.p = {
      draw: await pipe(rm, "draw"), leaves: await pipe(rm, "leaves"), parents: await pipe(rm, "parents"),
      noiseRows: await pipe(rm, "noiseRows"), noised: await pipe(rm, "noised"), jackpot: await pipe(jm, "main"),
    };
    const buf = (bytes, usage) => device.createBuffer({ size: Math.max(16, bytes), usage });
    const kw = k / 4;
    // Pearl's tree: level sizes down to the top pair, and where each starts.
    const levelPlan = (leaves) => {
      const lv = [{ off: 0, len: leaves }];
      while (lv[lv.length - 1].len > 2) { const p = lv[lv.length - 1]; lv.push({ off: p.off + p.len, len: Math.ceil(p.len / 2) }); }
      return { lv, nodes: lv.reduce((a, x) => a + x.len, 0) };
    };
    this.treeA = levelPlan((m * k) / CHUNK);
    this.treeB = levelPlan((n * k) / CHUNK);
    this.b = {
      Araw: buf(m * k, U.STORAGE | U.COPY_SRC), Braw: buf(n * k, U.STORAGE | U.COPY_SRC),
      Anz: buf(m * k, U.STORAGE), Bnz: buf(n * k, U.STORAGE),
      treeA: buf(this.treeA.nodes * 32, U.STORAGE | U.COPY_SRC), treeB: buf(this.treeB.nodes * 32, U.STORAGE | U.COPY_SRC),
      auxA: buf((k + (m * rank) / 4) * 4, U.STORAGE | U.COPY_DST), auxB: buf((k + (n * rank) / 4) * 4, U.STORAGE | U.COPY_DST),
      hits: buf(8 + 1024 * 8, U.STORAGE | U.COPY_SRC | U.COPY_DST), dbg: buf((m / 16) * (n / 16) * 32, U.STORAGE | U.COPY_SRC),
      jp: buf(96, U.UNIFORM | U.COPY_DST),
    };
    // One small uniform buffer per dispatch, so every write lands before its own pass.
    const uni = () => buf(96, U.UNIFORM | U.COPY_DST);
    const P = (o) => { const a = new Uint32Array(24); a.set([o.n || 0, o.s0 || 0, o.s1 || 0, kw, rank, o.a || 0, o.b || 0, o.c || 0]); if (o.key) a.set(words(o.key), 8); if (o.label) a.set(words(o.label), 16); return a; };
    this.P = P;
    const bind = (pl, entries) => device.createBindGroup({ layout: pl.getBindGroupLayout(0), entries: entries.map(([binding, buffer]) => ({ binding, resource: { buffer } })) });
    this.u = {};
    const stage = (name, pl, entries) => { const u = uni(); this.u[name] = { u, g: bind(pl, [[0, u], ...entries]) }; };
    stage("drawA", this.p.draw, [[1, this.b.Araw]]); stage("drawB", this.p.draw, [[1, this.b.Braw]]);
    stage("leavesA", this.p.leaves, [[1, this.b.Araw], [2, this.b.treeA]]); stage("leavesB", this.p.leaves, [[1, this.b.Braw], [2, this.b.treeB]]);
    for (const [t, tree] of [["A", this.treeA], ["B", this.treeB]]) for (let i = 1; i < tree.lv.length; i++) stage(`par${t}${i}`, this.p.parents, [[2, this.b[`tree${t}`]]]);
    stage("noiseA", this.p.noiseRows, [[2, this.b.auxA]]); stage("noiseB", this.p.noiseRows, [[2, this.b.auxB]]);
    stage("nzA", this.p.noised, [[1, this.b.Araw], [2, this.b.Anz], [3, this.b.auxA]]); stage("nzB", this.p.noised, [[1, this.b.Braw], [2, this.b.Bnz], [3, this.b.auxB]]);
    this.jg = bind(this.p.jackpot, [[0, this.b.jp], [1, this.b.Anz], [2, this.b.Bnz], [3, this.b.hits], [4, this.b.dbg]]);
    this.last = null;
  }

  wg(n, size) { const x = Math.ceil(n / size); return x <= 65535 ? [x, 1] : [65535, Math.ceil(x / 65535)]; }

  async read(buffer, offset, size) {
    const st = this.device.createBuffer({ size, usage: U.MAP_READ | U.COPY_DST });
    const e = this.device.createCommandEncoder(); e.copyBufferToBuffer(buffer, offset, st, 0, size); this.device.queue.submit([e.finish()]);
    await st.mapAsync(GPUMapMode.READ); const out = new Uint8Array(st.getMappedRange()).slice(); st.unmap(); st.destroy();
    return out;
  }

  pass(enc, pl, stage, o, x, y = 1) {
    this.device.queue.writeBuffer(this.u[stage].u, 0, this.P(o));
    const p = enc.beginComputePass(); p.setPipeline(pl); p.setBindGroup(0, this.u[stage].g); p.dispatchWorkgroups(x, y); p.end();
  }

  /** One round on a 76-byte header. `bits`: a tile counts when its hash is below 2^(256-bits). `debug` keeps every tile's hash. */
  async round(header, s0, s1, bits, { debug = false } = {}) {
    const { device, m, n, k, rank } = this, kw = k / 4;
    const jobKey = blake3(new Uint8Array([...header, ...configBytes(k, rank)]), null);
    let enc = device.createCommandEncoder();
    this.pass(enc, this.p.draw, "drawA", { n: m * kw, s0, s1 }, ...this.wg(m * kw, 256));
    this.pass(enc, this.p.draw, "drawB", { n: n * kw, s0: (s0 ^ 0x9e3779b9) >>> 0, s1: (s1 ^ 0x7f4a7c15) >>> 0 }, ...this.wg(n * kw, 256));
    for (const [t, tree, raw] of [["A", this.treeA], ["B", this.treeB]]) {
      this.pass(enc, this.p.leaves, `leaves${t}`, { n: tree.lv[0].len, b: 0, key: jobKey }, ...this.wg(tree.lv[0].len, 64));
      for (let i = 1; i < tree.lv.length; i++) {
        const below = tree.lv[i - 1], here = tree.lv[i];
        this.pass(enc, this.p.parents, `par${t}${i}`, { n: here.len, a: below.off, b: here.off, c: below.len, key: jobKey }, Math.ceil(here.len / 64));
      }
    }
    device.queue.submit([enc.finish()]);
    const top = async (tree, buffer) => { const t = tree.lv[tree.lv.length - 1]; const b = await this.read(buffer, t.off * 32, t.len * 32); return t.len === 2 ? rootOf(b.slice(0, 32), b.slice(32, 64), jobKey) : b.slice(0, 32); };
    const rootA = await top(this.treeA, this.b.treeA), rootB = await top(this.treeB, this.b.treeB);

    const { bNoiseSeed, aNoiseSeed } = seedsFromRoots(jobKey, rootA, rootB, m, n, this.salted);
    const perm = (label, seed) => Uint32Array.from(permMatrix(label, seed, k, rank), ([f, s]) => f | (s << 16));
    device.queue.writeBuffer(this.b.auxA, 0, perm(SEED_LABEL_A, aNoiseSeed));
    device.queue.writeBuffer(this.b.auxB, 0, perm(SEED_LABEL_B, bNoiseSeed));
    enc = device.createCommandEncoder();
    this.pass(enc, this.p.noiseRows, "noiseA", { n: (m * rank) / 32, b: k, key: aNoiseSeed, label: SEED_LABEL_A }, ...this.wg((m * rank) / 32, 64));
    this.pass(enc, this.p.noiseRows, "noiseB", { n: (n * rank) / 32, b: k, key: bNoiseSeed, label: SEED_LABEL_B }, ...this.wg((n * rank) / 32, 64));
    this.pass(enc, this.p.noised, "nzA", { n: m * kw, a: k }, ...this.wg(m * kw, 256));
    this.pass(enc, this.p.noised, "nzB", { n: n * kw, a: k }, ...this.wg(n * kw, 256));
    // The jackpot over every tile: bound 2^(256-bits) - 1 as eight little-endian words.
    const bound = new Uint32Array(8).fill(0xffffffff);
    for (let b = 0; b < bits; b++) { const bit = 255 - b; bound[bit >> 5] &= ~(1 << (bit & 31)); }
    const jp = new Uint32Array(24); jp.set([m, n, kw, rank / 4, debug ? 1 : 0, 1024, 0, 0]); jp.set(words(aNoiseSeed), 8); jp.set(bound, 16);
    device.queue.writeBuffer(this.b.jp, 0, jp);
    enc.clearBuffer(this.b.hits, 0, 8);
    const p = enc.beginComputePass(); p.setPipeline(this.p.jackpot); p.setBindGroup(0, this.jg); p.dispatchWorkgroups(n / (16 * this.tn), m / (16 * this.tm)); p.end();
    device.queue.submit([enc.finish()]);

    const h = new Uint32Array((await this.read(this.b.hits, 0, 8 + 1024 * 8)).buffer);
    const count = Math.min(h[0], 1024), hits = [];
    for (let i = 0; i < count; i++) hits.push([h[2 + 2 * i], h[3 + 2 * i]]);
    this.last = { jobKey, rootA, rootB, aNoiseSeed, bNoiseSeed };
    const out = { rootA, rootB, aNoiseSeed, bNoiseSeed, hits, found: h[0] };
    if (debug) out.tileHashes = await this.read(this.b.dbg, 0, (m / 16) * (n / 16) * 32);
    return out;
  }

  /** The proof for tile (tr, tc) of the last round, as Pearl's bincode PlainProof. */
  async proof(tr, tc) {
    const { m, n, k, rank } = this;
    const side = async (raw, treeBuf, tree, rows, root, first) => {
      const bytes = await this.read(raw, first * k, TILE * k);
      const flat = await this.read(treeBuf, 0, tree.nodes * 32);
      const levels = tree.lv.map((l) => Array.from({ length: l.len }, (_, i) => flat.slice((l.off + i) * 32, (l.off + i + 1) * 32)));
      const leafIndices = Array.from({ length: (TILE * k) / CHUNK }, (_, i) => (first * k) / CHUNK + i);
      return {
        leafData: leafIndices.map((_, i) => bytes.slice(i * CHUNK, (i + 1) * CHUNK)),
        leafIndices, totalLeaves: tree.lv[0].len, root, siblings: siblingsFor(levels, leafIndices, tree.lv[0].len),
        rowIndices: Array.from({ length: TILE }, (_, i) => first + i),
      };
    };
    return encodeProof({
      m, n, k, rank,
      a: await side(this.b.Araw, this.b.treeA, this.treeA, null, this.last.rootA, tr * TILE),
      bt: await side(this.b.Braw, this.b.treeB, this.treeB, null, this.last.rootB, tc * TILE),
    });
  }
}
