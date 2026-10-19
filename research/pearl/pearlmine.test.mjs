// node pearlmine.test.mjs [out.json]
// The reference miner's proofs, against our verifier -- and written out for
// Pearl's own (pearlcheck), which is the check that settles it.
import { writeFileSync } from "node:fs";
import { round, commit, siblingsFor, TILE } from "./pearlmine.mjs";
import { verifyShare, computeRoot, toBase64 } from "./pearlproof.mjs";

let passed = 0, failed = 0;
const ok = (c, w) => { c ? passed++ : failed++; console.log(`${c ? "ok  " : "FAIL"}  ${w}`); };
const hex = (u8) => Array.from(u8, (b) => b.toString(16).padStart(2, "0")).join("");
const ALL = (1n << 256n) - 1n;
const out = [];

// Pearl's tree, every shape: the siblings we pick must rebuild the root.
const key = new Uint8Array(32).fill(7);
for (const chunks of [2, 3, 5, 8, 13, 96]) {
  const c = commit(new Uint8Array(chunks * 1024).map((_, i) => i * 31), key);
  let good = true;
  for (const pick of [[0], [chunks - 1], [Math.floor(chunks / 2)], [0, 1], chunks > 3 ? [1, 2, 3] : [0]]) {
    const leaves = [...new Set(pick)].filter((i) => i < chunks).sort((a, b) => a - b);
    const p = { leafIndices: leaves, leafData: leaves.map((i) => c.padded.slice(i * 1024, (i + 1) * 1024)), totalLeaves: c.total, root: c.root, siblings: siblingsFor(c.levels, leaves, c.total) };
    const r = computeRoot(p, key);
    if (!r || hex(r) !== hex(c.root)) good = false;
  }
  ok(good, `siblings rebuild the root for a ${chunks}-leaf tree`);
}

const header = new Uint8Array(76).map((_, i) => (i * 37 + 11) & 255);
for (const [name, m, n] of [["64x64", 64, 64], ["48x32 (odd tree levels)", 48, 32]]) {
  const r = round(header, { m, n, k: 2048, rank: 128, s0: 0x1234567, s1: 0x89abcdef });
  let all = true, tiles = 0;
  for (let tr = 0; tr < m / TILE; tr++) for (let tc = 0; tc < n / TILE; tc++) {
    const proof = r.proof(tr, tc);
    const v = verifyShare(proof, header, { bound: ALL });
    const want = hex(r.tileHash(tr, tc));
    if (!v.ok || v.jackpotHash !== want || v.tile[0] !== tr || v.tile[1] !== tc) { all = false; console.log("   ", tr, tc, v.why || `${v.jackpotHash} != ${want}`); }
    tiles++;
    out.push({ name: `${name} tile ${tr},${tc}`, header: hex(header), proof_b64: toBase64(proof), jackpot_hash: want });
  }
  ok(all, `${name}: all ${tiles} tiles' proofs verify, with the reference's own hashes`);
  const sizes = new Set(out.slice(-tiles).map((x) => x.proof_b64.length));
  ok(sizes.size >= 1, `${name}: proofs are ${[...sizes].join("/")} base64 chars`);
}

if (process.argv[2]) { writeFileSync(process.argv[2], JSON.stringify(out)); console.log(`wrote ${out.length} proofs to ${process.argv[2]}`); }
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
