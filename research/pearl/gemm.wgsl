// How fast this GPU does the int8 x int8 -> int32 dot products that are Pearl's
// hot loop: the noised tile GEMM. Each invocation computes one h-length output
// accumulation over K, four int8 lanes at a time via dot4I8Packed (the GPU's
// int8 dot-product hardware). ITERS passes over the same data saturate the ALUs
// so the figure is compute, not memory.

struct Params { k_words: u32, iters: u32, _p0: u32, _p1: u32 };
@group(0) @binding(0) var<uniform> P: Params;
@group(0) @binding(1) var<storage, read> A: array<u32>;   // packed int8, one row of length K (K/4 words)
@group(0) @binding(2) var<storage, read> B: array<u32>;   // packed int8, one row of length K
@group(0) @binding(3) var<storage, read_write> OUT: array<i32>;

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let id = gid.x;
  var acc: i32 = 0;
  // Each invocation walks A and B with a per-invocation stride so neighbours
  // read neighbouring words (coalesced), ITERS times.
  for (var it: u32 = 0u; it < P.iters; it++) {
    var a_off = (id * 4u) % (P.k_words - 4u);
    for (var w: u32 = 0u; w < P.k_words; w++) {
      let ia = (a_off + w) % P.k_words;
      acc = dot4I8Packed(A[ia], B[w]) + acc;
    }
  }
  OUT[id] = acc;
}
