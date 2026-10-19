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

## The mining kernel (2026-10-19)

- `jackpot.wgsl` — the whole mining step on the GPU: tiled int8 GEMM over the
  pre-noised matrices (`dot4I8Packed`), the per-rank XOR fold into each 16x16
  tile's 16-word jackpot, and the keyed-BLAKE3 jackpot hash, reporting only
  tiles at or under the bound. `TM`x`TN` outputs per invocation.
- `jackpot-page.mjs`, `jackpotbench.cjs` — check every tile against `pearl.mjs`,
  then time it in 4 s bursts under a thermal guard (waits for <= 65 C before a
  burst, aborts at 78 C). `HEADED=1 node jackpotbench.cjs` (headless Chrome
  falls back to SwiftShader, not the GPU).

**Correct:** on the RTX 3050 laptop (NVIDIA Ampere), all 16 tiles of both square
vectors match `pearl.mjs` for both block shapes, and tile (0,0) equals the hash
Pearl's own verifier accepted.

**Speed:** m = n = 4096, k = 2048, rank 128:

| per-invocation | sustained | first burst |
|---|---|---|
| 4x4 | 1.59-1.73 TMAC/s (3.0-3.3 M tiles/s) | 1.73 |
| 8x8 | 0.66-0.89 TMAC/s (laptop pulls clocks) | 1.89 |

Peak 71 C / 35 W, guard never tripped. About 6-7x the first `gemm.wgsl` probe,
and an estimated ~30% of the card's DP4A peak, so perhaps 2x more is left.

**Units:** Pearl's difficulty is scaled by tile size x k, so one "H" is one int8
multiply-accumulate. A native desktop RTX 3050 does 31.3 TH/s on tensor cores
(hashrate.no), ~87% of its int8 tensor peak, which bears this out.

**Money (2026-10-19, PRL ~$1.90-1.95, network ~63-68 EH/s):** ~$0.032-0.036 per
TH/s per day (WhatToMine, hashrate.no). So the browser kernel is worth about
**$0.05-0.06/day per laptop 3050**: ~6x NeoScrypt's ~$0.009, ~5% of a native
3050 ($1.14/day), because WebGPU cannot reach tensor cores. A tuned kernel might
reach ~$0.10. **$1/day per browser miner is out of reach; $1/day for the pool
is ~16-20 such GPUs.** The PRL price has swung widely ($0.12-$1.95 across
sources), so this moves.

Not in the timing yet: regenerating the noise and recommitting A and B each
round. Both must run on the GPU (incremental BLAKE3 Merkle updates, noise from
the seeds), or they swamp the GEMM. Still to do after that: pool-side share
verification with `pearl.mjs`, and an upstream (2Miners runs a PRL pool at a
1% fee; MoneroOcean's `pearlhash` is unconfirmed).
