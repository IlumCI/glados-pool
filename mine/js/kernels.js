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

export const KERNELS = {
  sha256d: { wgsl: SHA256D, tailBigEndian: true },
  blake2s: { wgsl: BLAKE2S, tailBigEndian: false },
};

/** The 96-byte uniform for one dispatch. */
export function params(kernel, mid, header, target, base, limit, iters) {
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
