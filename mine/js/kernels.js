// WGSL kernels for the GPU-class algorithms, and how to lay out their inputs.
//
// Every kernel shares one binding layout and one contract:
//   params.mid     the midstate after the header's first 64 bytes (from wasm)
//   params.tail    header bytes 64..76 as the algorithm reads words
//   params.tgt     the share target as big-endian words, most significant first
//   params.base    first nonce of this dispatch; params.limit nonces in total
//   res[0]         how many hits; res[1..64] the nonces
// and every kernel turns its digest into "comparison words": the digest read
// as the little-endian 256-bit integer the pool compares, most significant
// word first, so the target test is one shared lexicographic compare.

const COMMON = /* wgsl */ `
struct Params {
  mid: array<vec4<u32>, 2>,
  tail: vec4<u32>,
  tgt: array<vec4<u32>, 2>,
  base: u32, limit: u32, iters: u32, pad: u32,
};
@group(0) @binding(0) var<uniform> p: Params;
@group(0) @binding(1) var<storage, read_write> res: array<atomic<u32>, 65>;

fn word(a: array<vec4<u32>, 2>, i: u32) -> u32 { return a[i / 4u][i % 4u]; }

fn meets(c: array<u32, 8>) -> bool {
  for (var i = 0u; i < 8u; i++) {
    let t = word(p.tgt, i);
    if (c[i] != t) { return c[i] < t; }
  }
  return true;
}

fn record(nonce: u32) {
  let slot = atomicAdd(&res[0], 1u);
  if (slot < 64u) { atomicStore(&res[slot + 1u], nonce); }
}

fn bswap(x: u32) -> u32 {
  return ((x & 0xffu) << 24u) | ((x & 0xff00u) << 8u) | ((x >> 8u) & 0xff00u) | (x >> 24u);
}
`;

// One invocation scans `iters` consecutive nonces, so a dispatch of G groups
// covers G * 256 * iters of them and the CPU sends one command per ~100 ms.
const MAIN = (body) => /* wgsl */ `
@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  for (var it = 0u; it < p.iters; it++) {
    let off = gid.x * p.iters + it;
    if (off >= p.limit) { return; }
    let nonce = p.base + off;
    ${body}
  }
}`;

const K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];
const u = (x) => '0x' + (x >>> 0).toString(16) + 'u';

const SHA256D = COMMON + /* wgsl */ `
var<private> K: array<u32, 64> = array<u32, 64>(${K.map(u).join(', ')});

fn rotr(x: u32, n: u32) -> u32 { return (x >> n) | (x << (32u - n)); }

fn compress(h: ptr<function, array<u32, 8>>, blk: array<u32, 16>) {
  var w: array<u32, 64>;
  for (var i = 0u; i < 16u; i++) { w[i] = blk[i]; }
  for (var i = 16u; i < 64u; i++) {
    let s0 = rotr(w[i - 15u], 7u) ^ rotr(w[i - 15u], 18u) ^ (w[i - 15u] >> 3u);
    let s1 = rotr(w[i - 2u], 17u) ^ rotr(w[i - 2u], 19u) ^ (w[i - 2u] >> 10u);
    w[i] = w[i - 16u] + s0 + w[i - 7u] + s1;
  }
  var a = (*h)[0]; var b = (*h)[1]; var c = (*h)[2]; var d = (*h)[3];
  var e = (*h)[4]; var f = (*h)[5]; var g = (*h)[6]; var k = (*h)[7];
  for (var i = 0u; i < 64u; i++) {
    let t1 = k + (rotr(e, 6u) ^ rotr(e, 11u) ^ rotr(e, 25u)) + ((e & f) ^ (~e & g)) + K[i] + w[i];
    let t2 = (rotr(a, 2u) ^ rotr(a, 13u) ^ rotr(a, 22u)) + ((a & b) ^ (a & c) ^ (b & c));
    k = g; g = f; f = e; e = d + t1; d = c; c = b; b = a; a = t1 + t2;
  }
  (*h)[0] += a; (*h)[1] += b; (*h)[2] += c; (*h)[3] += d;
  (*h)[4] += e; (*h)[5] += f; (*h)[6] += g; (*h)[7] += k;
}
` + MAIN(/* wgsl */ `
    var h: array<u32, 8>;
    for (var i = 0u; i < 8u; i++) { h[i] = word(p.mid, i); }
    var b1 = array<u32, 16>(p.tail.x, p.tail.y, p.tail.z, bswap(nonce), 0x80000000u,
                            0u, 0u, 0u, 0u, 0u, 0u, 0u, 0u, 0u, 0u, 640u);
    compress(&h, b1);
    var h2 = array<u32, 8>(0x6a09e667u, 0xbb67ae85u, 0x3c6ef372u, 0xa54ff53au,
                           0x510e527fu, 0x9b05688cu, 0x1f83d9abu, 0x5be0cd19u);
    var b2 = array<u32, 16>(h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 0x80000000u,
                            0u, 0u, 0u, 0u, 0u, 0u, 256u);
    compress(&h2, b2);
    // The digest's bytes are each word big-endian, and the pool reads the
    // 32 bytes as a little-endian integer: so its top word is bswap(h2[7]).
    var c: array<u32, 8>;
    for (var i = 0u; i < 8u; i++) { c[i] = bswap(h2[7u - i]); }
    if (meets(c)) { record(nonce); }
`);

const SIGMA = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
  [14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3],
  [11, 8, 12, 0, 5, 2, 15, 13, 10, 14, 3, 6, 7, 1, 9, 4],
  [7, 9, 3, 1, 13, 12, 11, 14, 2, 6, 5, 10, 4, 0, 15, 8],
  [9, 0, 5, 7, 2, 4, 10, 15, 14, 1, 11, 12, 6, 8, 3, 13],
  [2, 12, 6, 10, 0, 11, 8, 3, 4, 13, 7, 5, 15, 14, 1, 9],
  [12, 5, 1, 15, 14, 13, 4, 10, 0, 7, 6, 3, 9, 2, 8, 11],
  [13, 11, 7, 14, 12, 1, 3, 9, 5, 0, 15, 4, 8, 6, 2, 10],
  [6, 15, 14, 9, 11, 3, 0, 8, 12, 2, 13, 7, 1, 4, 10, 5],
  [10, 2, 8, 4, 7, 6, 1, 5, 15, 11, 9, 14, 3, 12, 13, 0],
];

// Unrolled here rather than looped in WGSL, so every message index is a
// constant: a runtime index into a private array is a spill on some GPUs.
// Message words 4..15 are zero for an 80-byte header's last block, and are
// dropped from the sums outright.
function blakeRounds() {
  const g = (a, b, c, d, x, y) => {
    const mx = x < 4 ? ` + m${x}` : '';
    const my = y < 4 ? ` + m${y}` : '';
    return `v${a} = v${a} + v${b}${mx}; v${d} = rotr(v${d} ^ v${a}, 16u); v${c} = v${c} + v${d}; v${b} = rotr(v${b} ^ v${c}, 12u);
    v${a} = v${a} + v${b}${my}; v${d} = rotr(v${d} ^ v${a}, 8u); v${c} = v${c} + v${d}; v${b} = rotr(v${b} ^ v${c}, 7u);`;
  };
  return SIGMA.map((s) =>
    [
      g(0, 4, 8, 12, s[0], s[1]), g(1, 5, 9, 13, s[2], s[3]), g(2, 6, 10, 14, s[4], s[5]), g(3, 7, 11, 15, s[6], s[7]),
      g(0, 5, 10, 15, s[8], s[9]), g(1, 6, 11, 12, s[10], s[11]), g(2, 7, 8, 13, s[12], s[13]), g(3, 4, 9, 14, s[14], s[15]),
    ].join('\n    '),
  ).join('\n    ');
}

const B2_IV = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];

const BLAKE2S = COMMON + /* wgsl */ `
fn rotr(x: u32, n: u32) -> u32 { return (x >> n) | (x << (32u - n)); }
` + MAIN(/* wgsl */ `
    let m0 = p.tail.x; let m1 = p.tail.y; let m2 = p.tail.z; let m3 = nonce;
    ${[0, 1, 2, 3, 4, 5, 6, 7].map((i) => `var v${i} = word(p.mid, ${i}u);`).join(' ')}
    var v8 = ${u(B2_IV[0])}; var v9 = ${u(B2_IV[1])}; var v10 = ${u(B2_IV[2])}; var v11 = ${u(B2_IV[3])};
    var v12 = ${u(B2_IV[4] ^ 80)}; var v13 = ${u(B2_IV[5])}; var v14 = ${u(~B2_IV[6])}; var v15 = ${u(B2_IV[7])};
    ${blakeRounds()}
    // Output words are little-endian bytes, so the integer's top word is h[7].
    var c: array<u32, 8>;
    ${[0, 1, 2, 3, 4, 5, 6, 7].map((i) => `c[${7 - i}] = word(p.mid, ${i}u) ^ v${i} ^ v${i + 8};`).join(' ')}
    if (meets(c)) { record(nonce); }
`);


// NeoScrypt: N = 128, r = 2, ChaCha20/20 and Salsa20/20, FastKDF-BLAKE2s.
// Each invocation owns 32 KiB of the scratch buffer for V; FastKDF's byte
// buffers are one byte per u32 in private memory, because its pointer lands
// on any byte and a packed array would turn every access into shifts. This is
// the plain version: correct first, a cooperative-workgroup layout later if a
// real GPU says the private arrays are the cost.
const NEOSCRYPT = /* wgsl */ `
struct Params {
  header: array<vec4<u32>, 5>,
  tgt: array<vec4<u32>, 2>,
  base: u32, limit: u32, iters: u32, pad: u32,
};
@group(0) @binding(0) var<uniform> p: Params;
@group(0) @binding(1) var<storage, read_write> res: array<atomic<u32>, 65>;
@group(0) @binding(2) var<storage, read_write> scratch: array<u32>;

const VW: u32 = 8192u; // 128 * 64 words per invocation

fn tword(i: u32) -> u32 { return p.tgt[i / 4u][i % 4u]; }
fn hbyte(i: u32, nonce: u32) -> u32 {
  if (i >= 76u) { return (nonce >> (8u * (i - 76u))) & 0xffu; }
  let w = p.header[i / 16u][(i / 4u) % 4u];
  return (w >> (8u * (i % 4u))) & 0xffu;
}
fn rotr(x: u32, n: u32) -> u32 { return (x >> n) | (x << (32u - n)); }
fn rotl(x: u32, n: u32) -> u32 { return (x << n) | (x >> (32u - n)); }

var<private> A: array<u32, 320>;
var<private> B: array<u32, 320>;
var<private> X: array<u32, 64>;
var<private> Z: array<u32, 64>;

const SIG = array<u32, 160>(
  0u,1u,2u,3u,4u,5u,6u,7u,8u,9u,10u,11u,12u,13u,14u,15u,
  14u,10u,4u,8u,9u,15u,13u,6u,1u,12u,0u,2u,11u,7u,5u,3u,
  11u,8u,12u,0u,5u,2u,15u,13u,10u,14u,3u,6u,7u,1u,9u,4u,
  7u,9u,3u,1u,13u,12u,11u,14u,2u,6u,5u,10u,4u,0u,15u,8u,
  9u,0u,5u,7u,2u,4u,10u,15u,14u,1u,11u,12u,6u,8u,3u,13u,
  2u,12u,6u,10u,0u,11u,8u,3u,4u,13u,7u,5u,15u,14u,1u,9u,
  12u,5u,1u,15u,14u,13u,4u,10u,0u,7u,6u,3u,9u,2u,8u,11u,
  13u,11u,7u,14u,12u,1u,3u,9u,5u,0u,15u,4u,8u,6u,2u,10u,
  6u,15u,14u,9u,11u,3u,0u,8u,12u,2u,13u,7u,1u,4u,10u,5u,
  10u,2u,8u,4u,7u,6u,1u,5u,15u,11u,9u,14u,3u,12u,13u,0u);

fn b2(h: ptr<function, array<u32, 8>>, m: array<u32, 16>, count: u32, last: bool) {
  var v = array<u32, 16>((*h)[0], (*h)[1], (*h)[2], (*h)[3], (*h)[4], (*h)[5], (*h)[6], (*h)[7],
    0x6a09e667u, 0xbb67ae85u, 0x3c6ef372u, 0xa54ff53au, 0x510e527fu ^ count, 0x9b05688cu, 0x1f83d9abu, 0x5be0cd19u);
  if (last) { v[14] = ~v[14]; }
  for (var r = 0u; r < 10u; r++) {
    for (var k = 0u; k < 8u; k++) {
      // The eight G calls of a round: four columns, then four diagonals.
      var a: u32; var b: u32; var c: u32; var d: u32;
      switch (k) {
        case 0u: { a = 0u; b = 4u; c = 8u; d = 12u; }
        case 1u: { a = 1u; b = 5u; c = 9u; d = 13u; }
        case 2u: { a = 2u; b = 6u; c = 10u; d = 14u; }
        case 3u: { a = 3u; b = 7u; c = 11u; d = 15u; }
        case 4u: { a = 0u; b = 5u; c = 10u; d = 15u; }
        case 5u: { a = 1u; b = 6u; c = 11u; d = 12u; }
        case 6u: { a = 2u; b = 7u; c = 8u; d = 13u; }
        default: { a = 3u; b = 4u; c = 9u; d = 14u; }
      }
      let x = m[SIG[r * 16u + 2u * k]];
      let y = m[SIG[r * 16u + 2u * k + 1u]];
      v[a] = v[a] + v[b] + x; v[d] = rotr(v[d] ^ v[a], 16u); v[c] = v[c] + v[d]; v[b] = rotr(v[b] ^ v[c], 12u);
      v[a] = v[a] + v[b] + y; v[d] = rotr(v[d] ^ v[a], 8u); v[c] = v[c] + v[d]; v[b] = rotr(v[b] ^ v[c], 7u);
    }
  }
  for (var i = 0u; i < 8u; i++) { (*h)[i] = (*h)[i] ^ v[i] ^ v[i + 8u]; }
}

// Keyed BLAKE2s-256 of A[ap..ap+64] under B[bp..bp+32], into out[0..32] bytes.
fn prf(ap: u32, bp: u32) -> array<u32, 32> {
  var h = array<u32, 8>(0x6a09e667u ^ 0x01012020u, 0xbb67ae85u, 0x3c6ef372u, 0xa54ff53au,
                        0x510e527fu, 0x9b05688cu, 0x1f83d9abu, 0x5be0cd19u);
  var m: array<u32, 16>;
  for (var i = 0u; i < 8u; i++) {
    let o = bp + 4u * i;
    m[i] = B[o] | (B[o + 1u] << 8u) | (B[o + 2u] << 16u) | (B[o + 3u] << 24u);
  }
  for (var i = 8u; i < 16u; i++) { m[i] = 0u; }
  b2(&h, m, 64u, false);
  for (var i = 0u; i < 16u; i++) {
    let o = ap + 4u * i;
    m[i] = A[o] | (A[o + 1u] << 8u) | (A[o + 2u] << 16u) | (A[o + 3u] << 24u);
  }
  b2(&h, m, 128u, true);
  var out: array<u32, 32>;
  for (var i = 0u; i < 32u; i++) { out[i] = (h[i / 4u] >> (8u * (i % 4u))) & 0xffu; }
  return out;
}

// The 32 FastKDF iterations over A (password) and B (salt), already filled.
// Returns the final buffer pointer.
fn kdf_rounds() -> u32 {
  var ptr = 0u;
  for (var it = 0u; it < 32u; it++) {
    let o = prf(ptr, ptr);
    var s = 0u;
    for (var i = 0u; i < 32u; i++) { s += o[i]; }
    ptr = s & 255u;
    for (var i = 0u; i < 32u; i++) { B[ptr + i] ^= o[i]; }
    if (ptr < 32u) {
      for (var i = 0u; i < 32u - ptr; i++) { B[256u + ptr + i] = B[ptr + i]; }
    } else if (256u - ptr < 32u) {
      for (var i = 0u; i < 32u - (256u - ptr); i++) { B[i] = B[256u + i]; }
    }
  }
  return ptr;
}

fn fill_password(nonce: u32) {
  for (var i = 0u; i < 256u; i++) { A[i] = hbyte(i % 80u, nonce); }
  for (var i = 0u; i < 64u; i++) { A[256u + i] = hbyte(i, nonce); }
}

fn salsa(o: u32, z: bool) {
  var v: array<u32, 16>;
  for (var i = 0u; i < 16u; i++) { if (z) { v[i] = Z[o + i]; } else { v[i] = X[o + i]; } }
  var w = v;
  for (var r = 0u; r < 10u; r++) {
    w[4] ^= rotl(w[0] + w[12], 7u);  w[8] ^= rotl(w[4] + w[0], 9u);   w[12] ^= rotl(w[8] + w[4], 13u);  w[0] ^= rotl(w[12] + w[8], 18u);
    w[9] ^= rotl(w[5] + w[1], 7u);   w[13] ^= rotl(w[9] + w[5], 9u);  w[1] ^= rotl(w[13] + w[9], 13u);  w[5] ^= rotl(w[1] + w[13], 18u);
    w[14] ^= rotl(w[10] + w[6], 7u); w[2] ^= rotl(w[14] + w[10], 9u); w[6] ^= rotl(w[2] + w[14], 13u);  w[10] ^= rotl(w[6] + w[2], 18u);
    w[3] ^= rotl(w[15] + w[11], 7u); w[7] ^= rotl(w[3] + w[15], 9u);  w[11] ^= rotl(w[7] + w[3], 13u);  w[15] ^= rotl(w[11] + w[7], 18u);
    w[1] ^= rotl(w[0] + w[3], 7u);   w[2] ^= rotl(w[1] + w[0], 9u);   w[3] ^= rotl(w[2] + w[1], 13u);   w[0] ^= rotl(w[3] + w[2], 18u);
    w[6] ^= rotl(w[5] + w[4], 7u);   w[7] ^= rotl(w[6] + w[5], 9u);   w[4] ^= rotl(w[7] + w[6], 13u);   w[5] ^= rotl(w[4] + w[7], 18u);
    w[11] ^= rotl(w[10] + w[9], 7u); w[8] ^= rotl(w[11] + w[10], 9u); w[9] ^= rotl(w[8] + w[11], 13u);  w[10] ^= rotl(w[9] + w[8], 18u);
    w[12] ^= rotl(w[15] + w[14], 7u); w[13] ^= rotl(w[12] + w[15], 9u); w[14] ^= rotl(w[13] + w[12], 13u); w[15] ^= rotl(w[14] + w[13], 18u);
  }
  for (var i = 0u; i < 16u; i++) { if (z) { Z[o + i] = v[i] + w[i]; } else { X[o + i] = v[i] + w[i]; } }
}

fn chacha(o: u32, z: bool) {
  var v: array<u32, 16>;
  for (var i = 0u; i < 16u; i++) { if (z) { v[i] = Z[o + i]; } else { v[i] = X[o + i]; } }
  var w = v;
  for (var r = 0u; r < 10u; r++) {
    for (var k = 0u; k < 8u; k++) {
      var a: u32; var b: u32; var c: u32; var d: u32;
      switch (k) {
        case 0u: { a = 0u; b = 4u; c = 8u; d = 12u; }
        case 1u: { a = 1u; b = 5u; c = 9u; d = 13u; }
        case 2u: { a = 2u; b = 6u; c = 10u; d = 14u; }
        case 3u: { a = 3u; b = 7u; c = 11u; d = 15u; }
        case 4u: { a = 0u; b = 5u; c = 10u; d = 15u; }
        case 5u: { a = 1u; b = 6u; c = 11u; d = 12u; }
        case 6u: { a = 2u; b = 7u; c = 8u; d = 13u; }
        default: { a = 3u; b = 4u; c = 9u; d = 14u; }
      }
      w[a] += w[b]; w[d] = rotl(w[d] ^ w[a], 16u);
      w[c] += w[d]; w[b] = rotl(w[b] ^ w[c], 12u);
      w[a] += w[b]; w[d] = rotl(w[d] ^ w[a], 8u);
      w[c] += w[d]; w[b] = rotl(w[b] ^ w[c], 7u);
    }
  }
  for (var i = 0u; i < 16u; i++) { if (z) { Z[o + i] = v[i] + w[i]; } else { X[o + i] = v[i] + w[i]; } }
}

// blkmix for r = 2: four chained blocks, then the middle pair swapped.
fn blkmix(z: bool) {
  for (var i = 0u; i < 4u; i++) {
    let prev = ((i + 3u) % 4u) * 16u;
    for (var k = 0u; k < 16u; k++) {
      if (z) { Z[i * 16u + k] ^= Z[prev + k]; } else { X[i * 16u + k] ^= X[prev + k]; }
    }
    if (z) { chacha(i * 16u, true); } else { salsa(i * 16u, false); }
  }
  for (var k = 0u; k < 16u; k++) {
    if (z) { let t = Z[16u + k]; Z[16u + k] = Z[32u + k]; Z[32u + k] = t; }
    else { let t = X[16u + k]; X[16u + k] = X[32u + k]; X[32u + k] = t; }
  }
}

fn smix(z: bool, vb: u32) {
  for (var i = 0u; i < 128u; i++) {
    for (var k = 0u; k < 64u; k++) { if (z) { scratch[vb + i * 64u + k] = Z[k]; } else { scratch[vb + i * 64u + k] = X[k]; } }
    blkmix(z);
  }
  for (var i = 0u; i < 128u; i++) {
    var j: u32;
    if (z) { j = (Z[48] & 127u) * 64u; } else { j = (X[48] & 127u) * 64u; }
    for (var k = 0u; k < 64u; k++) { if (z) { Z[k] ^= scratch[vb + j + k]; } else { X[k] ^= scratch[vb + j + k]; } }
    blkmix(z);
  }
}

fn meets(c: array<u32, 8>) -> bool {
  for (var i = 0u; i < 8u; i++) {
    let t = tword(i);
    if (c[i] != t) { return c[i] < t; }
  }
  return true;
}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let vb = gid.x * VW;
  for (var it = 0u; it < p.iters; it++) {
    let off = gid.x * p.iters + it;
    if (off >= p.limit) { return; }
    let nonce = p.base + off;

    // X = FastKDF(header, header)
    fill_password(nonce);
    for (var i = 0u; i < 256u; i++) { B[i] = hbyte(i % 80u, nonce); }
    for (var i = 0u; i < 32u; i++) { B[256u + i] = hbyte(i, nonce); }
    var ptr = kdf_rounds();
    for (var w = 0u; w < 64u; w++) {
      var x = 0u;
      for (var b = 0u; b < 4u; b++) {
        let i = 4u * w + b;
        var byte: u32;
        if (i < 256u - ptr) { byte = B[ptr + i] ^ A[i]; } else { byte = B[i - (256u - ptr)] ^ A[i]; }
        x |= byte << (8u * b);
      }
      X[w] = x;
      Z[w] = x;
    }

    smix(true, vb);   // ChaCha first
    smix(false, vb);  // Salsa second
    for (var w = 0u; w < 64u; w++) { X[w] ^= Z[w]; }

    // out = FastKDF(header, X), 32 bytes
    fill_password(nonce);
    for (var i = 0u; i < 256u; i++) { B[i] = (X[i / 4u] >> (8u * (i % 4u))) & 0xffu; }
    for (var i = 0u; i < 32u; i++) { B[256u + i] = B[i]; }
    ptr = kdf_rounds();
    var d: array<u32, 8>;
    for (var w = 0u; w < 8u; w++) {
      var x = 0u;
      for (var b = 0u; b < 4u; b++) {
        let i = 4u * w + b;
        var byte: u32;
        if (i < 256u - ptr) { byte = B[ptr + i] ^ A[i]; } else { byte = B[i - (256u - ptr)] ^ A[i]; }
        x |= byte << (8u * b);
      }
      d[w] = x;
    }
    // Little-endian digest: the integer's top word is d[7].
    var c: array<u32, 8>;
    for (var i = 0u; i < 8u; i++) { c[i] = d[7u - i]; }
    if (meets(c)) {
      let slot = atomicAdd(&res[0], 1u);
      if (slot < 64u) { atomicStore(&res[slot + 1u], nonce); }
    }
  }
}`;

export const KERNELS = {
  sha256d: { wgsl: SHA256D, tailBigEndian: true },
  blake2s: { wgsl: BLAKE2S, tailBigEndian: false },
  // scratch: words of storage each invocation owns; wg: workgroup size.
  neoscrypt: { wgsl: NEOSCRYPT, scratch: 8192, wg: 64, full: true },
};

/** The uniform for one dispatch: 96 bytes, or 128 for a full-header kernel. */
export function params(kernel, mid, header, target, base, limit, iters) {
  if (kernel.full) {
    const buf = new ArrayBuffer(128);
    const w = new Uint32Array(buf);
    const hv = new DataView(header.buffer, header.byteOffset, 80);
    for (let i = 0; i < 20; i++) w[i] = hv.getUint32(4 * i, true);
    const tv = new DataView(target.buffer, target.byteOffset, 32);
    for (let i = 0; i < 8; i++) w[20 + i] = tv.getUint32(4 * i, false);
    w[28] = base >>> 0;
    w[29] = limit >>> 0;
    w[30] = iters;
    return buf;
  }
  const buf = new ArrayBuffer(96);
  const w = new Uint32Array(buf);
  w.set(mid, 0);
  const dv = new DataView(header.buffer, header.byteOffset, 80);
  for (let i = 0; i < 3; i++) w[8 + i] = dv.getUint32(64 + 4 * i, !kernel.tailBigEndian);
  const tv = new DataView(target.buffer, target.byteOffset, 32);
  for (let i = 0; i < 8; i++) w[12 + i] = tv.getUint32(4 * i, false);
  w[20] = base >>> 0;
  w[21] = limit >>> 0;
  w[22] = iters;
  return buf;
}
