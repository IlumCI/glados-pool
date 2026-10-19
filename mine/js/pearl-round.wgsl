// Everything in a Pearl mining round before the jackpot, on the GPU. Each
// entry point is one step of pearlmine.mjs's `round`, and is checked against
// it: the same matrices, the same Merkle tree, the same noise, the same
// noised matrices handed to jackpot.wgsl.
//
//   draw       matrix word i <- four elements, element(j) = mix(mix(j ^ s0) + s1) folded to [-64, 64]
//   leaves     the keyed BLAKE3 chaining value of each 1024-byte chunk (counter = chunk index)
//   parents    one level of Pearl's tree: pairs hashed, a lone last node promoted
//   noiseRows  the uniform half of the noise (into Y from word P.b): row u, block j <- one keyed BLAKE3 of
//              (1 + u*r/32 + j | label), each output byte to (b & 63) - 32
//   noised     A' = A + E_L[row][p0[l]] - E_L[row][p1[l]], the permutation from the CPU
//
// Matrices are packed four int8 to a u32, little-endian, as the bytes the
// tree commits to are.

struct Params {
  n: u32,       // items in this dispatch
  s0: u32, s1: u32,
  kw: u32,      // words per matrix row (k / 4)
  r: u32,       // noise rank
  a: u32,       // parents: input node offset   | noised: word offset of E within Z
  b: u32,       // leaves/parents: output node offset
  c: u32,       // parents: input level length
  key: array<vec4<u32>, 2>,
  label: array<vec4<u32>, 2>,
};
@group(0) @binding(0) var<uniform> P: Params;
@group(0) @binding(1) var<storage, read_write> X: array<u32>;
@group(0) @binding(2) var<storage, read_write> Y: array<u32>;
@group(0) @binding(3) var<storage, read> Z: array<u32>;

fn w8(a: array<vec4<u32>, 2>, i: u32) -> u32 { return a[i / 4u][i % 4u]; }

// ------------------------------------------------------------------ draw ---
fn mix(x: u32) -> u32 {
  let s = x * 747796405u + 2891336453u;
  let w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u;
  return (w >> 22u) ^ w;
}
fn element(j: u32) -> u32 { return ((mix(mix(j ^ P.s0) + P.s1) % 129u) + 192u) & 255u; } // (v - 64) as a byte

@compute @workgroup_size(256)
fn draw(@builtin(global_invocation_id) g: vec3<u32>) {
  let i = g.x + g.y * 65535u * 256u;
  if (i >= P.n) { return; }
  let j = i * 4u;
  X[i] = element(j) | (element(j + 1u) << 8u) | (element(j + 2u) << 16u) | (element(j + 3u) << 24u);
}

// ---------------------------------------------------------------- BLAKE3 ---
const IV = array<u32, 8>(0x6a09e667u, 0xbb67ae85u, 0x3c6ef372u, 0xa54ff53au, 0x510e527fu, 0x9b05688cu, 0x1f83d9abu, 0x5be0cd19u);
const PERM = array<u32, 16>(2u, 6u, 3u, 10u, 7u, 0u, 4u, 13u, 1u, 11u, 12u, 5u, 9u, 14u, 15u, 8u);
const CHUNK_START = 1u; const CHUNK_END = 2u; const PARENT = 4u; const ROOT = 8u; const KEYED = 16u;

fn rotr(x: u32, n: u32) -> u32 { return (x >> n) | (x << (32u - n)); }

fn compress(cv: array<u32, 8>, msg: array<u32, 16>, counter: u32, blen: u32, flags: u32) -> array<u32, 8> {
  var v: array<u32, 16>;
  var w = msg;
  for (var i = 0u; i < 8u; i++) { v[i] = cv[i]; }
  v[8] = IV[0]; v[9] = IV[1]; v[10] = IV[2]; v[11] = IV[3];
  v[12] = counter; v[13] = 0u; v[14] = blen; v[15] = flags;
  for (var r = 0u; r < 7u; r++) {
    for (var q = 0u; q < 8u; q++) {
      let d = q >= 4u;
      let a = select(q, q - 4u, d);
      let b = select(4u + q, 4u + (q - 3u) % 4u, d);
      let c = select(8u + q, 8u + (q - 2u) % 4u, d);
      let e = select(12u + q, 12u + (q - 1u) % 4u, d);
      v[a] = v[a] + v[b] + w[2u * q];      v[e] = rotr(v[e] ^ v[a], 16u);
      v[c] = v[c] + v[e];                  v[b] = rotr(v[b] ^ v[c], 12u);
      v[a] = v[a] + v[b] + w[2u * q + 1u]; v[e] = rotr(v[e] ^ v[a], 8u);
      v[c] = v[c] + v[e];                  v[b] = rotr(v[b] ^ v[c], 7u);
    }
    var nw: array<u32, 16>;
    for (var i = 0u; i < 16u; i++) { nw[i] = w[PERM[i]]; }
    w = nw;
  }
  var out: array<u32, 8>;
  for (var i = 0u; i < 8u; i++) { out[i] = v[i] ^ v[i + 8u]; }
  return out;
}

fn keyWords() -> array<u32, 8> {
  var k: array<u32, 8>;
  for (var i = 0u; i < 8u; i++) { k[i] = w8(P.key, i); }
  return k;
}

// One chunk's chaining value: sixteen 64-byte blocks of matrix X.
@compute @workgroup_size(64)
fn leaves(@builtin(global_invocation_id) g: vec3<u32>) {
  let c = g.x + g.y * 65535u * 64u;
  if (c >= P.n) { return; }
  var cv = keyWords();
  for (var b = 0u; b < 16u; b++) {
    var m: array<u32, 16>;
    let base = c * 256u + b * 16u;
    for (var i = 0u; i < 16u; i++) { m[i] = X[base + i]; }
    let f = KEYED | select(0u, CHUNK_START, b == 0u) | select(0u, CHUNK_END, b == 15u);
    cv = compress(cv, m, c, 64u, f);
  }
  for (var i = 0u; i < 8u; i++) { Y[(P.b + c) * 8u + i] = cv[i]; }
}

// One level up, in Pearl's shape: pairs (2i, 2i+1), and a lone last node
// carried up unhashed.
@compute @workgroup_size(64)
fn parents(@builtin(global_invocation_id) g: vec3<u32>) {
  let i = g.x;
  if (i >= P.n) { return; }
  let l = P.a + 2u * i;
  if (2u * i + 1u < P.c) {
    var m: array<u32, 16>;
    for (var j = 0u; j < 16u; j++) { m[j] = Y[l * 8u + j]; }
    let cv = compress(keyWords(), m, 0u, 64u, KEYED | PARENT);
    for (var j = 0u; j < 8u; j++) { Y[(P.b + i) * 8u + j] = cv[j]; }
  } else {
    for (var j = 0u; j < 8u; j++) { Y[(P.b + i) * 8u + j] = Y[l * 8u + j]; }
  }
}

// The uniform noise rows: invocation (u, j) hashes block u*r/32 + j.
@compute @workgroup_size(64)
fn noiseRows(@builtin(global_invocation_id) g: vec3<u32>) {
  let idx = g.x + g.y * 65535u * 64u;
  if (idx >= P.n) { return; }
  var m: array<u32, 16>;
  m[0] = 1u + idx;
  for (var i = 0u; i < 8u; i++) { m[8u + i] = w8(P.label, i); }
  let h = compress(keyWords(), m, 0u, 64u, CHUNK_START | CHUNK_END | ROOT | KEYED);
  for (var q = 0u; q < 8u; q++) {
    var o = 0u;
    for (var e = 0u; e < 4u; e++) {
      let b = (h[q] >> (8u * e)) & 63u;
      o |= ((b + 224u) & 255u) << (8u * e); // (b - 32) as a byte
    }
    Y[P.b + idx * 8u + q] = o; // after the k permutation words noised reads first
  }
}

fn sbyte(w: u32, e: u32) -> i32 { return bitcast<i32>(w << ((3u - e) * 8u)) >> 24u; }
fn ebyte(i: u32) -> i32 { return sbyte(Z[P.a + i / 4u], i % 4u); }

// A' word i: four noised values of row i / kw.
@compute @workgroup_size(256)
fn noised(@builtin(global_invocation_id) g: vec3<u32>) {
  let i = g.x + g.y * 65535u * 256u;
  if (i >= P.n) { return; }
  let row = i / P.kw;
  let base = row * P.r;
  let src = X[i];
  var o = 0u;
  for (var e = 0u; e < 4u; e++) {
    let l = (i % P.kw) * 4u + e;
    let p = Z[l];
    let noise = ebyte(base + (p & 0xffffu)) - ebyte(base + (p >> 16u));
    let v = sbyte(src, e) + noise;
    o |= (bitcast<u32>(v) & 255u) << (8u * e);
  }
  Y[i] = o;
}
