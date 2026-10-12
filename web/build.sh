#!/bin/sh
# Build both WebAssembly variants into mine/wasm/. The page picks one at
# runtime by asking the engine whether a SIMD instruction validates.
set -eu
cd "$(dirname "$0")/core"
cargo build --release --target wasm32-unknown-unknown
RUSTFLAGS="-C target-feature=+simd128" cargo build --release --target wasm32-unknown-unknown --target-dir target/simd
cp target/wasm32-unknown-unknown/release/glados_web_core.wasm ../../mine/wasm/core.wasm
cp target/simd/wasm32-unknown-unknown/release/glados_web_core.wasm ../../mine/wasm/core-simd.wasm
ls -l ../../mine/wasm
