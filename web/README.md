# The browser miner

| | |
|---|---|
| `core/` | yespower 0.5/1.0, SHA-256d, BLAKE2s in Rust for wasm32, checked against published vectors |
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
blake2s), one slot at a time, asking the pool for fresh work when a job's
nonce space is spent. neoscrypt and heavyhash are GPU-class with no kernel yet.
