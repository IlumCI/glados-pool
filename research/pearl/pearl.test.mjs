// node pearl.test.mjs <vectors.json>
// Validates pearl.mjs stage by stage against vectors Pearl's own verifier accepted.
import { readFileSync } from "node:fs";
import { blake3, commitmentSeeds, computeNoise, computeJackpot, jackpotHash, jobKey, padChunk } from "./pearl.mjs";

let pass = 0, fail = 0;
const hex = (u8) => Buffer.from(u8).toString("hex");
const unhex = (s) => Uint8Array.from(Buffer.from(s, "hex"));
const b64 = (s) => new Int8Array(Buffer.from(s, "base64"));
const ok = (c, w) => { c ? pass++ : fail++; console.log(`${c ? "ok  " : "FAIL"}  ${w}`); };

// Base case: the official empty-input BLAKE3 vector, so a pass on the big
// matrices below is the multi-chunk tree and not a lucky collision.
ok(hex(blake3(new Uint8Array(0), null)) === "af1349b9f5f9a1a6a0404dea36dcc9499bcb25c9adc112b7cc9a93cae41f3262", "BLAKE3 of the empty string matches the published vector");

const vectors = JSON.parse(readFileSync(process.argv[2], "utf8"));
for (const t of vectors) {
  const k = t.config.k, r = t.config.rank, m = t.m, n = t.n, salted = t.seed_derivation === "Salted";
  const A = b64(t.a_b64_row_major);       // m*k, row-major
  const B = b64(t.b_b64_row_major_k_by_n); // k*n, row-major
  const jk = jobKey(unhex(t.header.bytes), unhex(t.config.bytes));
  ok(hex(jk) === t.job_key, `${t.name}: job_key`);

  // hash_a / hash_b are the matrices' Merkle roots, i.e. plain keyed BLAKE3.
  const aPadded = padChunk(Uint8Array.from(A, (x) => x & 255));
  ok(hex(blake3(aPadded, jk)) === t.hash_a, `${t.name}: hash_a (BLAKE3 over ${aPadded.length} bytes)`);
  const bT = new Uint8Array(n * k); // B^t, n rows of length k
  for (let i = 0; i < k; i++) for (let j = 0; j < n; j++) bT[j * k + i] = B[i * n + j] & 255;
  ok(hex(blake3(padChunk(bT), jk)) === t.hash_b, `${t.name}: hash_b`);

  const { bNoiseSeed, aNoiseSeed } = commitmentSeeds(jk, aPadded, padChunk(bT), m, n, salted);
  ok(hex(bNoiseSeed) === t.b_noise_seed, `${t.name}: b_noise_seed`);
  ok(hex(aNoiseSeed) === t.a_noise_seed, `${t.name}: a_noise_seed`);

  const noise = computeNoise(k, r, bNoiseSeed, aNoiseSeed, t.tile_rows, t.tile_cols);
  const noiseAok = noise.a.every((row, i) => hex(Uint8Array.from(row, (x) => x & 255)) === hex(Uint8Array.from(b64(t.noise_a_b64[i]), (x) => x & 255)));
  const noiseBok = noise.b.every((col, i) => hex(Uint8Array.from(col, (x) => x & 255)) === hex(Uint8Array.from(b64(t.noise_b_b64[i]), (x) => x & 255)));
  ok(noiseAok && noise.a.length === t.noise_a_b64.length, `${t.name}: noise A (${noise.a.length} rows x ${k})`);
  ok(noiseBok && noise.b.length === t.noise_b_b64.length, `${t.name}: noise B`);

  const secretA = t.tile_rows.map((row) => { const s = new Int8Array(k); for (let l = 0; l < k; l++) s[l] = A[row * k + l]; return s; });
  const secretB = t.tile_cols.map((col) => { const s = new Int8Array(k); for (let l = 0; l < k; l++) s[l] = B[l * n + col]; return s; });
  const jackpot = computeJackpot(secretA, secretB, noise, k, r);
  ok(Array.from(jackpot).every((w, i) => w === (t.jackpot[i] >>> 0)), `${t.name}: jackpot (16 words)`);
  ok(hex(jackpotHash(jackpot, aNoiseSeed)) === t.jackpot_hash, `${t.name}: jackpot_hash -> ${t.jackpot_hash.slice(0, 16)}...`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
