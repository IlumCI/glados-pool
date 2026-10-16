#!/bin/sh
# Assemble the Cloudflare Pages site into dist/: the published record and the
# browser miner, and nothing else from the repository. Idempotent -- it clears
# dist/ first, so a file deleted here is deleted from the next deploy.
#
# The .wasm the miner loads is committed under mine/wasm/; rebuild it with
# web/build.sh when web/core changes, before deploying.
set -eu
cd "$(dirname "$0")/.."

rm -rf dist
mkdir -p dist

# The record: the audit page and the data it reads and republishes.
cp index.html ledger.json shares.txt dist/

# The miner: its page, its modules, and the built wasm it fetches.
cp -R mine dist/mine

# Nothing staged should carry local build output.
rm -rf dist/mine/wasm/*.d 2>/dev/null || true

echo "staged dist/:"
find dist -type f | sort | sed 's/^/  /'
