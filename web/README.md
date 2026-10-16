# The browser miner

| | |
|---|---|
| `core/` | yespower 0.5/1.0, SHA-256d, BLAKE2s, NeoScrypt, HeavyHash (SHA3-256) in Rust for wasm32, checked against published vectors |
| `../mine/` | the page GitHub Pages serves at `/mine/`, and the built `.wasm` it loads |
| `../bridge/` | WebSocket to the pool's line protocol |
| `e2e/` | protocol unit tests, and a headless-Chromium run against a fake pool |

```bash
./web/build.sh                                         # rebuild mine/wasm/*.wasm
cargo test --release --manifest-path web/core/Cargo.toml
node --test web/e2e/proto.test.mjs
NODE_PATH=/path/to/node_modules node web/e2e/run.mjs   # needs playwright + chromium
NODE_PATH=... CHROMIUM=/path/to/chrome node web/e2e/gpu.mjs
```

`gpu.mjs` runs each WGSL kernel over 32,768 nonces ending at the 2^32 wrap and
requires the set of nonces it finds to equal the wasm scan's exactly. The full
Chromium binary is needed for WebGPU (the headless shell has none); without a
GPU it runs on SwiftShader, which proves correctness and says nothing about
speed.

Locally: `python3 -m http.server 8000` at the repo root, a bridge with
`--origin http://127.0.0.1:8000`, then open
`http://127.0.0.1:8000/mine/?bridge=ws://127.0.0.1:8080`.

CPU and GPU mine at the same time on different jobs: the CPU takes CPU-class
work (yespower), the GPU takes GPU-class work it has a kernel for (sha256d,
blake2s, neoscrypt, heavyhash), one slot at a time, asking the pool for fresh
work when a job's nonce space is spent.

Submits are paced at 8 a second, under the bridge's per-connection bucket, so
a burst of shares queues in the page instead of getting the connection closed.
`E2E_GPU_ALGO=neoscrypt` runs the end-to-end test with NeoScrypt as the GPU
slot.

## The revenue feed

The pool may push a fifth message, a notification with no id like `glados.job`:

```
<- {"method":"glados.earn","params":{"asset":"nvda","value":0.0123}}
```

It is the worker's accrued, unpaid revenue valued in the asset the pool is
actually crediting. Under the equal split every worker takes the same share of
the epoch's pot — the pot over the recipient count — and `value` is that share
in `asset`; the pool holds the pot, the count and the USD→asset quote, so only
it can produce the figure. The browser shows a dash until one arrives and
never computes one. `value` is gross of the miner's own power cost and net of
the pool's gas and swap, which leave the pot before it is split. `asset` is
what is really being credited: a fallback to `$GLaDOS` says `glados` here, so
the page names the truth rather than the request. The message is optional and
resent as the figure moves; the client drops a malformed one and keeps the
last good value (`proto.parseEarn`).

## Stress tests

| | |
|---|---|
| `stress/diff.sh` | the Rust hashes against openwall's and ghostlander's C on random inputs: both yespower versions, N/r/pers edge cases, NeoScrypt; 0 mismatches of 5,000 |
| `bridge/tests/stress.rs` | ping flood, dead pool, sockets that never handshake, total cap, slow-loris |
| `e2e/miner.test.mjs` | the controller with fake workers: exhaustion, reassignment, crash restart, pacing |
| `E2E_CHAOS=1 e2e/run.mjs` | a hostile pool: bad JSON, bad headers, a 2 GiB yespower job, unknown algorithm, a 200-job flood, a 1 MiB line, a dropped connection |
| `GPU_FUZZ=n e2e/gpu.mjs` | every kernel against the wasm scan on random headers and nonce ranges |
| `stress/load.mjs` | 1,000 bridge connections at 2 msg/s for 20 s |
| `e2e/faults.mjs` | the real workers with one thing broken: a GPU that refuses the scratch buffer (shrink until it fits; or report it), a wasm that traps (report it, restart) |
