// node pearlproof.test.mjs vectors.json
// The share codec and the pool-side verifier, held to Pearl's own answers.
import { readFileSync } from "node:fs";
import { decodeProof, encodeProof, fromBase64, toBase64, verifyShare, nbitsToTarget, scaleTarget, adjustmentFactor } from "./pearlproof.mjs";

let pass = 0, fail = 0;
const ok = (c, w) => { c ? pass++ : fail++; console.log(`${c ? "ok  " : "FAIL"}  ${w}`); };
const unhex = (s) => Uint8Array.from(Buffer.from(s, "hex"));
const same = (x, y) => x.length === y.length && x.every((v, i) => v === y[i]);

for (const t of JSON.parse(readFileSync(process.argv[2], "utf8"))) {
  const wire = fromBase64(t.plain_proof_b64);
  const header = unhex(t.header.bytes);
  const salted = t.seed_derivation === "Salted";
  const p = decodeProof(wire);
  ok(p.m === t.m && p.n === t.n && p.k === t.config.k && p.rank === t.config.rank, `${t.name}: decodes (m=${p.m} n=${p.n} k=${p.k} rank=${p.rank})`);
  ok(same(encodeProof(p), wire) && toBase64(wire) === t.plain_proof_b64, `${t.name}: re-encodes to the same ${wire.length} bytes`);

  const r = verifyShare(wire, header, { nbits: t.header.nbits, salted });
  if (t.config.rows.length !== 16 || t.config.cols.length !== 16) {
    ok(!r.ok && /16 x 16/.test(r.why), `${t.name}: refused as a tile shape this pool does not mine (${r.why})`);
    continue;
  }
  ok(r.ok, `${t.name}: Pearl's accepted proof is accepted${r.ok ? "" : ` -- ${r.why}`}`);
  if (r.ok) {
    ok(r.jackpotHash === t.jackpot_hash, `${t.name}: jackpot hash matches Pearl's (${r.jackpotHash.slice(0, 16)}...)`);
    ok(r.tile[0] * 16 === t.t_rows && r.tile[1] * 16 === t.t_cols, `${t.name}: at tile (${r.tile})`);
  }
  for (const x of t.tampered) {
    const v = verifyShare(fromBase64(x.plain_proof_b64), header, { nbits: t.header.nbits, salted });
    ok(v.ok === x.pearl_accepts, `${t.name}: ${x.what} -> ${v.ok ? "accepted" : `refused (${v.why})`}, as Pearl did`);
  }
  // Consistent proofs -- every Merkle path checks -- that are still wrong. Each
  // must be refused, and by the check meant for it rather than an earlier one.
  for (const x of t.honest_but_wrong || []) {
    const v = verifyShare(fromBase64(x.plain_proof_b64), unhex(x.header), { nbits: x.nbits, salted: true });
    const why = /outside/.test(x.what) ? /outside \[-64, 64\]/ : /above the target/;
    ok(v.ok === x.pearl_accepts && !v.ok && why.test(v.why), `${t.name}: ${x.what} -> ${v.ok ? "accepted" : `refused (${v.why})`}, as Pearl did`);
  }
  // The other seed derivation gives other noise, so other hash.
  const wrong = verifyShare(wire, header, { nbits: t.header.nbits, salted: !salted });
  ok(!wrong.ok || wrong.jackpotHash !== t.jackpot_hash, `${t.name}: the other seed derivation does not give Pearl's hash`);
  // A bound one below the hash refuses it; the hash itself passes.
  const h = BigInt("0x" + Buffer.from(unhex(t.jackpot_hash)).reverse().toString("hex"));
  ok(!verifyShare(wire, header, { bound: h - 1n, salted }).ok && verifyShare(wire, header, { bound: h, salted }).ok, `${t.name}: refused one below its hash, accepted at it`);
  // A different header is a different job key: the roots no longer verify.
  const h2 = header.slice(); h2[10] ^= 1;
  const v2 = verifyShare(wire, h2, { nbits: t.header.nbits, salted });
  ok(!v2.ok && /root/.test(v2.why), `${t.name}: refused under another job's header (${v2.why})`);
}

ok(nbitsToTarget(0x1d00ffff) === 0xffffn << 208n, "nbits: Bitcoin's genesis bits decode to its target");
ok(scaleTarget(nbitsToTarget(0x207fffff), adjustmentFactor(2048, 128)) === (1n << 256n) - 1n, "an easy target scaled past 2^256 saturates, as Pearl's scale() does");
ok(adjustmentFactor(2048, 128) === 524288 && adjustmentFactor(4096, 256) === 524288, "the rank-penalised factor is tile x k / rank x 128");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
