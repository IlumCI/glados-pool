// node pearlfuzz.mjs <out.json> [seed]
// Broken copies of valid proofs, with our verifier's verdict on each, for
// pearlcheck to give Pearl's on the same. The verdicts are compared by
// pearlfuzz-compare.mjs: anything we accept that Pearl refuses is a bug.
import { writeFileSync } from "node:fs";
import { round } from "./pearlmine.mjs";
import { verifyShare, decodeProof, encodeProof, toBase64 } from "./pearlproof.mjs";

const out = process.argv[2], seed = Number(process.argv[3] || 7);
let s = seed >>> 0;
const rnd = () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 2 ** 32; };
const pick = (n) => Math.floor(rnd() * n);
const hex = (u8) => Array.from(u8, (b) => b.toString(16).padStart(2, "0")).join("");
const ALL = (1n << 256n) - 1n;
const header = new Uint8Array(76).map((_, i) => (i * 29 + 3) & 255);

const items = [];
let throws = 0;
const add = (name, bytes) => {
  let v;
  try { v = verifyShare(bytes, header, { bound: ALL }); } catch (e) { throws++; v = { ok: false, why: `THREW ${e.message}` }; }
  items.push({ name, header: hex(header), proof_b64: toBase64(bytes), ours: v.ok, ours_hash: v.jackpotHash || null, ours_why: v.why || null });
};
// Rebuild after changing the decoded structure (a "structured" mutation).
const edit = (base, f) => { const p = decodeProof(base); f(p); return encodeProof(p); };

for (const [m, n, tr, tc] of [[64, 64, 1, 2], [128, 64, 7, 0], [48, 32, 2, 1]]) {
  const r = round(header, { m, n, k: 2048, rank: 128, s0: 0xabc + m, s1: 0xdef + n });
  const base = r.proof(tr, tc);
  const tag = `${m}x${n}@${tr},${tc}`;
  add(`${tag} untouched`, base);

  // 1. Single random byte flips anywhere.
  for (let i = 0; i < 120; i++) { const b = base.slice(); const at = pick(b.length); b[at] ^= 1 + pick(255); add(`${tag} flip @${at}`, b); }
  // 2. Truncated and extended.
  for (const cut of [1, 7, 8, 100, 1024, base.length - 1, base.length - 33]) add(`${tag} truncated to ${base.length - cut}`, base.slice(0, base.length - cut));
  for (const extra of [1, 8, 33]) { const b = new Uint8Array(base.length + extra); b.set(base); add(`${tag} +${extra} trailing bytes`, b); }
  // 3. Every scalar field, nudged and blown up.
  for (const [field, set] of [
    ["m", (p, v) => (p.m = v)], ["n", (p, v) => (p.n = v)], ["k", (p, v) => (p.k = v)], ["rank", (p, v) => (p.rank = v)],
    ["a.totalLeaves", (p, v) => (p.a.totalLeaves = v)], ["bt.totalLeaves", (p, v) => (p.bt.totalLeaves = v)],
  ]) {
    const orig = decodeProof(base);
    const cur = field.includes(".") ? orig[field.split(".")[0]][field.split(".")[1]] : orig[field];
    for (const v of [cur + 1, cur - 1, cur * 2, Math.floor(cur / 2), 0, 1, 2 ** 24, 2 ** 31]) if (v >= 0 && v !== cur) add(`${tag} ${field}=${v}`, edit(base, (p) => set(p, v)));
  }
  // 4. Indices: shift the claimed tile, break order, duplicate.
  add(`${tag} a.rows shifted by 16`, edit(base, (p) => { p.a.rowIndices = p.a.rowIndices.map((x) => x + 16); }));
  add(`${tag} a.rows shifted by 1`, edit(base, (p) => { p.a.rowIndices = p.a.rowIndices.map((x) => x + 1); }));
  add(`${tag} a.rows reversed`, edit(base, (p) => { p.a.rowIndices.reverse(); }));
  add(`${tag} a.rows 15 only`, edit(base, (p) => { p.a.rowIndices.pop(); }));
  add(`${tag} a.leafIndices shifted by 32`, edit(base, (p) => { p.a.leafIndices = p.a.leafIndices.map((x) => x + 32); }));
  add(`${tag} a.leafIndices + rows shifted together`, edit(base, (p) => { p.a.leafIndices = p.a.leafIndices.map((x) => x + 32); p.a.rowIndices = p.a.rowIndices.map((x) => x + 16); }));
  add(`${tag} a.leafIndices swapped pair`, edit(base, (p) => { const t = p.a.leafIndices[0]; p.a.leafIndices[0] = p.a.leafIndices[1]; p.a.leafIndices[1] = t; }));
  add(`${tag} leaf duplicated`, edit(base, (p) => { p.a.leafIndices[1] = p.a.leafIndices[0]; p.a.leafData[1] = p.a.leafData[0]; }));
  // 5. Leaves and siblings.
  add(`${tag} leaf data swapped`, edit(base, (p) => { const t = p.a.leafData[0]; p.a.leafData[0] = p.a.leafData[1]; p.a.leafData[1] = t; }));
  add(`${tag} last leaf dropped`, edit(base, (p) => { p.a.leafData.pop(); p.a.leafIndices.pop(); }));
  add(`${tag} extra leaf`, edit(base, (p) => { const i = p.a.leafIndices[p.a.leafIndices.length - 1] + 1; p.a.leafIndices.push(i); p.a.leafData.push(new Uint8Array(1024)); }));
  add(`${tag} last sibling dropped`, edit(base, (p) => { p.a.siblings.pop(); }));
  add(`${tag} extra sibling`, edit(base, (p) => { p.a.siblings.push(new Uint8Array(32)); }));
  add(`${tag} siblings reversed`, edit(base, (p) => { p.a.siblings.reverse(); }));
  add(`${tag} A and B swapped`, edit(base, (p) => { const t = p.a; p.a = p.bt; p.bt = t; const mm = p.m; p.m = p.n; p.n = mm; }));
  add(`${tag} root zeroed`, edit(base, (p) => { p.a.root = new Uint8Array(32); }));
  add(`${tag} value 65 committed in place`, edit(base, (p) => { p.a.leafData[0] = p.a.leafData[0].slice(); p.a.leafData[0][0] = 65; }));
}

writeFileSync(out, JSON.stringify(items));
const acc = items.filter((x) => x.ours).length;
console.log(`${items.length} cases (seed ${seed}); ours accepts ${acc}; verifier threw on ${throws}`);
