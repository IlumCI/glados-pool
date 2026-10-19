// Pearl's mining step on the GPU: the noised tile GEMM, the jackpot fold and
// the jackpot hash, for one block of the m x n output per workgroup.
//
// Inputs are the matrices with their noise already added (A' = A + E_A, m rows
// of k; B'^t = B^t + E_B, n rows of k), packed four int8 to a word. Signal is
// in [-64, 64] and noise in [-63, 63], so every noised value fits an int8 and
// dot4I8Packed is exactly Pearl's multiply-accumulate.
//
// Each invocation owns a TM x TN patch of outputs, which always lies inside one
// 16 x 16 jackpot tile (TM and TN divide 16). Every `rank` values of k the
// patch's accumulators are XOR-ed into its tile's word, and the tile's jackpot
// word (ll / rank - 1) % 16 is rotated left 13 and XOR-ed with it -- Pearl's
// mine.rs loop. At the end each tile hashes its 16 words with keyed BLAKE3
// (key = a_noise_seed) and reports itself if the hash is at or under the bound.
//
// TM and TN are substituted by the host before compiling.

const TM: u32 = {{TM}}u;
const TN: u32 = {{TN}}u;
const BM: u32 = 16u * TM;          // block rows: 16 x 16 invocations
const BN: u32 = 16u * TN;
const KCW: u32 = 8u;               // packed words of k staged per step (32 values)
const KS: u32 = KCW + 1u;          // shared-memory row stride, padded off the banks
const TPR: u32 = BN / 16u;         // jackpot tiles per block row
const NT: u32 = (BM / 16u) * TPR;  // jackpot tiles per block

struct Params {
  m: u32, n: u32, kw: u32, rw: u32,   // rows of A', rows of B'^t, k and rank in words
  debug: u32, cap: u32, _p0: u32, _p1: u32,
  key: array<vec4<u32>, 2>,           // a_noise_seed as 8 little-endian words
  bound: array<vec4<u32>, 2>,         // the share bound, a little-endian 256-bit integer
};

struct Hits { count: atomic<u32>, _p: u32, at: array<vec2<u32>> };

@group(0) @binding(0) var<uniform> P: Params;
@group(0) @binding(1) var<storage, read> A: array<u32>;
@group(0) @binding(2) var<storage, read> B: array<u32>;
@group(0) @binding(3) var<storage, read_write> H: Hits;
@group(0) @binding(4) var<storage, read_write> DBG: array<u32>; // every tile's hash, debug only

var<workgroup> As: array<u32, BM * KS>;
var<workgroup> Bs: array<u32, BN * KS>;
var<workgroup> fold: array<atomic<u32>, NT>;
var<workgroup> jack: array<u32, NT * 16u>;

fn word(a: array<vec4<u32>, 2>, i: u32) -> u32 { return a[i / 4u][i % 4u]; }

// ---------------------------------------------------------------- BLAKE3 ----
const IV = array<u32, 8>(0x6a09e667u, 0xbb67ae85u, 0x3c6ef372u, 0xa54ff53au, 0x510e527fu, 0x9b05688cu, 0x1f83d9abu, 0x5be0cd19u);
const PERM = array<u32, 16>(2u, 6u, 3u, 10u, 7u, 0u, 4u, 13u, 1u, 11u, 12u, 5u, 9u, 14u, 15u, 8u);

fn rotr(x: u32, n: u32) -> u32 { return (x >> n) | (x << (32u - n)); }

// The jackpot hash: one keyed BLAKE3 compression of the 64-byte jackpot, the
// whole input in a single chunk (CHUNK_START | CHUNK_END | ROOT | KEYED).
fn jackpot_hash(t: u32) -> array<u32, 8> {
  var v: array<u32, 16>;
  var w: array<u32, 16>;
  for (var i = 0u; i < 8u; i++) { v[i] = word(P.key, i); v[i + 8u] = select(0u, IV[i], i < 4u); }
  v[12] = 0u; v[13] = 0u; v[14] = 64u; v[15] = 1u | 2u | 8u | 16u;
  for (var i = 0u; i < 16u; i++) { w[i] = jack[t * 16u + i]; }
  for (var r = 0u; r < 7u; r++) {
    for (var q = 0u; q < 8u; q++) {
      // columns, then diagonals
      let a = select(q, q - 4u, q >= 4u);
      let b = select(4u + q, 4u + (q - 4u + 1u) % 4u, q >= 4u);
      let c = select(8u + q, 8u + (q - 4u + 2u) % 4u, q >= 4u);
      let d = select(12u + q, 12u + (q - 4u + 3u) % 4u, q >= 4u);
      v[a] = v[a] + v[b] + w[2u * q];      v[d] = rotr(v[d] ^ v[a], 16u);
      v[c] = v[c] + v[d];                  v[b] = rotr(v[b] ^ v[c], 12u);
      v[a] = v[a] + v[b] + w[2u * q + 1u]; v[d] = rotr(v[d] ^ v[a], 8u);
      v[c] = v[c] + v[d];                  v[b] = rotr(v[b] ^ v[c], 7u);
    }
    var n: array<u32, 16>;
    for (var i = 0u; i < 16u; i++) { n[i] = w[PERM[i]]; }
    w = n;
  }
  var out: array<u32, 8>;
  for (var i = 0u; i < 8u; i++) { out[i] = v[i] ^ v[i + 8u]; }
  return out;
}

// h <= bound, both little-endian 256-bit: compare from the top word down.
fn under(h: array<u32, 8>) -> bool {
  for (var i = 7; i >= 0; i--) {
    let b = word(P.bound, u32(i));
    if (h[i] < b) { return true; }
    if (h[i] > b) { return false; }
  }
  return true;
}

@compute @workgroup_size(256)
fn main(@builtin(local_invocation_index) li: u32, @builtin(workgroup_id) wg: vec3<u32>) {
  let tx = li % 16u;
  let ty = li / 16u;
  let row0 = wg.y * BM;
  let col0 = wg.x * BN;
  let mine = (ty * TM / 16u) * TPR + (tx * TN / 16u); // this invocation's jackpot tile

  for (var i = li; i < NT * 16u; i += 256u) { jack[i] = 0u; }
  if (li < NT) { atomicStore(&fold[li], 0u); }

  var acc: array<i32, TM * TN>;
  let steps = P.kw / KCW;
  let every = P.rw / KCW;

  for (var s = 0u; s < steps; s++) {
    let k0 = s * KCW;
    for (var i = li; i < BM * KCW; i += 256u) {
      let r = i / KCW; let c = i % KCW;
      As[r * KS + c] = A[(row0 + r) * P.kw + k0 + c];
    }
    for (var i = li; i < BN * KCW; i += 256u) {
      let r = i / KCW; let c = i % KCW;
      Bs[r * KS + c] = B[(col0 + r) * P.kw + k0 + c];
    }
    workgroupBarrier();
    for (var c = 0u; c < KCW; c++) {
      var a: array<u32, TM>;
      var b: array<u32, TN>;
      for (var i = 0u; i < TM; i++) { a[i] = As[(ty * TM + i) * KS + c]; }
      for (var j = 0u; j < TN; j++) { b[j] = Bs[(tx * TN + j) * KS + c]; }
      for (var i = 0u; i < TM; i++) {
        for (var j = 0u; j < TN; j++) { acc[i * TN + j] = dot4I8Packed(a[i], b[j]) + acc[i * TN + j]; }
      }
    }
    workgroupBarrier();

    if ((s + 1u) % every == 0u) {
      var x = 0u;
      for (var e = 0u; e < TM * TN; e++) { x ^= bitcast<u32>(acc[e]); }
      atomicXor(&fold[mine], x);
      workgroupBarrier();
      if (li < NT) {
        let tid = ((s + 1u) / every - 1u) % 16u;
        let x2 = atomicExchange(&fold[li], 0u);
        let j0 = jack[li * 16u + tid];
        jack[li * 16u + tid] = ((j0 << 13u) | (j0 >> 19u)) ^ x2;
      }
      workgroupBarrier();
    }
  }

  if (li < NT) {
    let h = jackpot_hash(li);
    let tr = wg.y * (BM / 16u) + li / TPR;   // tile coordinates in the whole output
    let tc = wg.x * TPR + li % TPR;
    if (P.debug != 0u) {
      let base = (tr * (P.n / 16u) + tc) * 8u;
      for (var i = 0u; i < 8u; i++) { DBG[base + i] = h[i]; }
    }
    if (under(h)) {
      let at = atomicAdd(&H.count, 1u);
      if (at < P.cap) { H.at[at] = vec2<u32>(tr, tc); }
    }
  }
}
