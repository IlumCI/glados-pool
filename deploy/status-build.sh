#!/bin/sh
# Assemble the public status site (status.aperture.institute) into dist-status/:
# the page, its script, and the aperture mark it shares with the miner. Its own
# Cloudflare Pages project, glados-status; the data comes live from
# https://pool.aperture.institute/health.json, so nothing here goes stale.
#
#   sh deploy/status-build.sh
#   npx wrangler pages deploy dist-status --project-name=glados-status --branch=main
set -eu
cd "$(dirname "$0")/.."

rm -rf dist-status
mkdir -p dist-status/img
cp status/index.html status/status.js dist-status/
cp mine/img/logo.svg dist-status/img/

echo "staged dist-status/:"
find dist-status -type f | sort | sed 's/^/  /'
