// A Pearl miner's round, in plain JavaScript: the reference the GPU path is
// checked against, and small enough to read.
//
// One round, on one job header:
//   1. Draw A (m x k) and B^t (n x k), every value in [-64, 64], from a seed.
//      Any matrices are valid work; drawing them from a seed means the GPU can
//      make them in place and either side can make any row again.
//   2. Commit each: the BLAKE3 Merkle tree of its row-major bytes, keyed by the
//      job key, in Pearl's tree shape (pearl-blake3's MerkleProof). Every level
//      is kept, because a proof needs siblings from them.
//   3. The noise seeds from the two roots, and the noise for every row.
//   4. The jackpot of every 16 x 16 tile, and its hash.
//   5. For a tile under the bound: the proof Pearl wants -- the tile's rows as
//      1024-byte leaves, their indices, the tree size, the root and the
//      siblings in the order Pearl's verifier reads them.
//
// Proofs built here are checked by Pearl's own verify_plain_proof (pearlcheck).

import { blake3, seedsFromRoots, computeNoise, computeJackpot, jackpotHash, leafCV, parentOf, rootOf } from "./pearl.mjs";
import { configBytes, encodeProof } from "./pearlproof.mjs";

export const CHUNK = 1024, TILE = 16;

// ------------------------------------------------------------ matrices ------
// A 32-bit integer hash (PCG's output function over an LCG step), cheap on a
// GPU and the same in WGSL: element i of a matrix is mix(mix(i ^ s0) + s1),
// folded onto [-64, 64]. The fold's slight bias toward small values costs
// nothing -- Pearl accepts any matrix in range.
export const mix = (x) => {
  const s = (Math.imul(x >>> 0, 747796405) + 2891336453) >>> 0;
  const w = Math.imul(((s >>> ((s >>> 28) + 4)) ^ s) >>> 0, 277803737) >>> 0;
  return ((w >>> 22) ^ w) >>> 0;
};
export const element = (i, s0, s1) => (mix((mix((i ^ s0) >>> 0) + s1) >>> 0) % 129) - 64;

/** rows x k int8, row-major, from (s0, s1). */
export function drawMatrix(rows, k, s0, s1) {
  const out = new Int8Array(rows * k);
  for (let i = 0; i < out.length; i++) out[i] = element(i, s0, s1);
  return out;
}

// ------------------------------------------------------------ Merkle --------
/** Every level of Pearl's tree over `bytes` (padded to whole chunks), and the root. */
export function commit(bytes, key) {
  const n = Math.ceil(bytes.length / CHUNK);
  const padded = new Uint8Array(n * CHUNK);
  padded.set(bytes);
  const leaves = [];
  for (let i = 0; i < n; i++) leaves.push(leafCV(padded.subarray(i * CHUNK, (i + 1) * CHUNK), i, key));
  const levels = [leaves];
  let cur = leaves;
  while (cur.length > 2) {
    const next = [];
    for (let i = 0; i < cur.length; i += 2) next.push(i + 1 < cur.length ? parentOf(cur[i], cur[i + 1], key) : cur[i]);
    levels.push(next);
    cur = next;
  }
  const root = cur.length === 2 ? rootOf(cur[0], cur[1], key) : cur[0];
  return { levels, root, total: n, padded };
}

/** The siblings Pearl's compute_root reads for `leafIndices`, in its order. */
export function siblingsFor(levels, leafIndices, total) {
  const s = [];
  if (total === 1) return s;
  let cur = new Set(leafIndices), len = total, lv = 0;
  while (len > 2) {
    const next = new Set();
    for (const i of [...cur].sort((a, b) => a - b)) {
      if (i % 2 === 0) {
        if (!cur.has(i + 1) && i + 1 < len) s.push(levels[lv][i + 1]);
        next.add(i / 2);
      } else if (!cur.has(i - 1)) {
        s.push(levels[lv][i - 1]);
        next.add((i - 1) / 2);
      }
    }
    cur = next;
    len = Math.ceil(len / 2);
    lv++;
  }
  if (!cur.has(0)) s.push(levels[lv][0]);
  if (!cur.has(1)) s.push(levels[lv][1]);
  return s;
}

// ------------------------------------------------------------ a round -------
/**
 * One round on `header` (76 bytes). Answers everything the GPU path must
 * reproduce, plus `proof(tr, tc)` for any tile.
 */
export function round(header, { m, n, k, rank, s0, s1, salted = true }) {
  const jobKey = blake3(new Uint8Array([...header, ...configBytes(k, rank)]), null);
  const A = drawMatrix(m, k, s0, s1);
  const Bt = drawMatrix(n, k, s0 ^ 0x9e3779b9, s1 ^ 0x7f4a7c15);
  const ca = commit(new Uint8Array(A.buffer), jobKey), cb = commit(new Uint8Array(Bt.buffer), jobKey);
  const { bNoiseSeed, aNoiseSeed } = seedsFromRoots(jobKey, ca.root, cb.root, m, n, salted);
  const rowsOf = (M, rows) => rows.map((r) => M.subarray(r * k, (r + 1) * k));
  const tileHash = (tr, tc) => {
    const rows = [...Array(TILE).keys()].map((i) => tr * TILE + i), cols = [...Array(TILE).keys()].map((j) => tc * TILE + j);
    const noise = computeNoise(k, rank, bNoiseSeed, aNoiseSeed, rows, cols);
    return jackpotHash(computeJackpot(rowsOf(A, rows), rowsOf(Bt, cols), noise, k, rank), aNoiseSeed);
  };
  const side = (c, rowIdx) => {
    const first = (rowIdx[0] * k) / CHUNK, count = (TILE * k) / CHUNK; // aligned: k is a multiple of 64, rows of 16
    const leafIndices = [...Array(count).keys()].map((i) => first + i);
    return {
      leafData: leafIndices.map((i) => c.padded.slice(i * CHUNK, (i + 1) * CHUNK)),
      leafIndices, totalLeaves: c.total, root: c.root, siblings: siblingsFor(c.levels, leafIndices, c.total), rowIndices: rowIdx,
    };
  };
  const proof = (tr, tc) => encodeProof({
    m, n, k, rank,
    a: side(ca, [...Array(TILE).keys()].map((i) => tr * TILE + i)),
    bt: side(cb, [...Array(TILE).keys()].map((j) => tc * TILE + j)),
  });
  return { jobKey, A, Bt, rootA: ca.root, rootB: cb.root, bNoiseSeed, aNoiseSeed, tileHash, proof };
}
