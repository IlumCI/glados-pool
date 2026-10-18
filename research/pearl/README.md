# Pearl (PRL) browser-mining research

A browser-side reference for Pearl's proof-of-work, to decide whether the GPU
miner can mine Pearl (worth far more than NeoScrypt if a kernel is fast enough)
instead of heavyhash. **This branch is research only. It is never deployed and
is not merged into the miner.**

## What is here

- `pearl.mjs` — the plain (no-ZK) Pearl PoW in JavaScript: a from-scratch keyed
  BLAKE3 (the Merkle root of a matrix is standard BLAKE3 of its bytes), the
  job key, the v3-salted and legacy noise-seed derivations, the four noise
  matrices, the noised tile-GEMM jackpot, and the jackpot hash. Pure functions,
  so the same file runs under node and can feed a WGSL kernel its test inputs.
- `pearl.test.mjs` — validates `pearl.mjs` stage by stage against `vectors.json`,
  plus the published empty-string BLAKE3 vector.
- `vectors.json` — reference vectors produced by Pearl's own Rust and accepted
  by Pearl's own verifier (see `pearlref.rs`).
- `pearlref.rs` — the Rust generator: mines with Pearl's `try_mine_one`, verifies
  with `verify_plain_proof`, then dumps every intermediate.
- `gemm.wgsl`, `gemmbench.cjs` — a WebGPU int8 GEMM micro-benchmark (`dot4I8Packed`),
  the hot loop's throughput ceiling.

## Reproduce

Validate the browser reference (no GPU, no network):

    node pearl.test.mjs vectors.json      # 28 passed, 0 failed

Regenerate the vectors from Pearl's own code, in a network-isolated sandbox:

1. `git clone --depth 1 https://github.com/pearl-research-labs/pearl` (its `zk-pow` crate).
2. One visibility change so the generator can reach the verifier's jackpot
   helper: in `pearl/zk-pow/src/circuit/chip/mod.rs`, `mod jackpot;` -> `pub mod jackpot;`.
3. A tiny crate depending on `zk-pow` with `pearlref.rs` as its `main.rs`.
4. `cargo fetch` with a private `CARGO_HOME`, then build and run under
   `bwrap --unshare-net --clearenv` (empty env, no credentials visible to build
   scripts). The run writes `vectors.json`.

## Findings (2026-10-18)

- The browser reproduces Pearl's PoW **bit-for-bit, 28/28** across salted/legacy
  and square/rectangular configs.
- Measured **270 GOP/s** int8 on an RTX 3050 laptop via WebGPU `dot4I8Packed`,
  unoptimized (~2% of the card's DP4A peak; multi-TOP/s is reachable). WebGPU
  cannot reach tensor cores, so the browser is capped below native miners.
- Estimated **$0.05-0.20/day/GPU** vs NeoScrypt's ~$0.009/day. Pool/exchange
  route: MoneroOcean's `pearlhash` endpoint (XMR payout) -> ETH, unconfirmed.

Next: a tiled WGSL GEMM + full jackpot loop checked against `pearl.mjs`, a real
tiles/s benchmark, then a pool-only `pearlhash` upstream if the numbers hold.
