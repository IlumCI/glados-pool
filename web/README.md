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
```

Locally: `python3 -m http.server 8000` at the repo root, a bridge with
`--origin http://127.0.0.1:8000`, then open
`http://127.0.0.1:8000/mine/?bridge=ws://127.0.0.1:8080`.

The CPU path mines CPU-class jobs only (yespower). GPU-class jobs (neoscrypt,
sha256d, blake2s, heavyhash) wait for the WebGPU path.
