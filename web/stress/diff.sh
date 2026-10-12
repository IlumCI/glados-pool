#!/bin/sh
# Differential test: the Rust hashes against the upstream C references on
# random inputs. Downloads the references (BSD-2) into a temp dir; nothing
# from them is committed.
#   ./web/stress/diff.sh [seed] [yespower cases] [neoscrypt cases]
set -eu
here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../.." && pwd)
seed=${1:-7}; ny=${2:-3000}; nn=${3:-2000}
w=$(mktemp -d)
trap 'rm -rf "$w"' EXIT
for f in yespower-ref.c yespower.h sha256.c sha256.h insecure_memzero.h sysendian.h; do
  curl -sSf -o "$w/$f" "https://raw.githubusercontent.com/openwall/yespower/main/$f"
done
for f in neoscrypt.c neoscrypt.h; do
  curl -sSf -o "$w/$f" "https://raw.githubusercontent.com/ghostlander/NeoScrypt/master/$f"
done
cp "$here/ref.c" "$w/"
gcc -O2 -w -o "$w/ref" "$w/ref.c" "$w/yespower-ref.c" "$w/sha256.c" "$w/neoscrypt.c"
cargo build -q --release --manifest-path "$root/web/core/Cargo.toml" --example diff
python3 -I "$here/gen.py" "$seed" "$ny" "$nn" > "$w/cases"
"$w/ref" < "$w/cases" > "$w/c.out"
"$root/web/core/target/release/examples/diff" < "$w/cases" > "$w/rs.out"
fails=$(grep -c FAILED "$w/c.out" || true)
paste -d' ' "$w/c.out" "$w/rs.out" | awk -v f="$fails" '$1!=$2{bad++} END{print (bad+0) " mismatches of " NR " (" f " refused by both)"; exit bad>0}'
