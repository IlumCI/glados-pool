#!/bin/sh
# Assemble the Cloudflare Pages site into dist/: the browser miner, served at
# the site root, and nothing else from the repository. Idempotent -- it clears
# dist/ first, so a file deleted here is deleted from the next deploy.
#
# The miner is the whole site. The published share-log record (the repo's root
# index.html, ledger.json, shares.txt) is deliberately not shipped.
#
# The .wasm the miner loads is committed under mine/wasm/; rebuild it with
# web/build.sh when web/core changes, before deploying.
set -eu
cd "$(dirname "$0")/.."

rm -rf dist
mkdir -p dist

# The miner is the site: its page at the root, its modules and the built wasm
# it fetches beside it. `mine/.` copies the contents of mine/, not the folder,
# so index.html lands at dist/index.html and is served at /.
cp -R mine/. dist/

# Nothing staged should carry local build output.
rm -rf dist/wasm/*.d 2>/dev/null || true

echo "staged dist/:"
find dist -type f | sort | sed 's/^/  /'
