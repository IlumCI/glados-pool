#!/bin/sh
# GLaDOS native miner for Linux and macOS: download it, check it, run it here.
#
#   curl -fsSL https://mine.aperture.institute/install.sh | sh -s -- 0xYOURADDRESS
#
# Options, after the address:
#   --reward ASSET   what you are paid in, as on the miner page (default: glados)
#   --duty PERCENT   how much of the time to work, 10-100 (default: 100)
#   --threads N      CPU threads (default: all but one)
#   --no-gpu         CPU only, even with an NVIDIA GPU present
#
# What it does, all of it: puts two files (three with an NVIDIA GPU) in
# ~/.local/share/glados-miner (macOS: ~/Library/Application Support/glados-miner),
# checks each against the release's SHA256SUMS, writes a `mine` script there so
# you can start again later, and starts mining in this terminal. Nothing runs
# in the background, nothing starts at boot, no sudo. Ctrl+C stops it; deleting
# that folder removes it.
#
# The miner is open source: https://github.com/IlumCI/GLaDOS (miner/, cuda/).
set -eu

VERSION="miner-v0.2.0"
BASE="${GLADOS_MINER_BASE:-https://github.com/IlumCI/GLaDOS/releases/download/$VERSION}"
POOL="${GLADOS_POOL:-wss://pool.aperture.institute}"

say() { printf '%s\n' "glados: $*"; }
die() { printf '%s\n' "glados: $*" >&2; exit 1; }

ADDR=""; REWARD="glados"; DUTY="100"; THREADS=""; GPU="auto"
while [ $# -gt 0 ]; do
	case "$1" in
		--reward) REWARD="${2:?--reward needs an asset}"; shift 2 ;;
		--duty) DUTY="${2:?--duty needs a percentage}"; shift 2 ;;
		--threads) THREADS="${2:?--threads needs a number}"; shift 2 ;;
		--no-gpu) GPU="no"; shift ;;
		-h|--help) sed -n '2,21p' "$0" 2>/dev/null || true; exit 0 ;;
		0x*) ADDR="$1"; shift ;;
		*) die "unknown option $1 (the address goes first: sh -s -- 0x...)" ;;
	esac
done

# Piped into sh, stdin is this script, so ask on the terminal itself.
if [ -z "$ADDR" ]; then
	if [ -r /dev/tty ]; then
		printf 'glados: your wallet address (0x...): ' > /dev/tty
		read -r ADDR < /dev/tty
	fi
	[ -n "$ADDR" ] || die "no address given: curl -fsSL https://mine.aperture.institute/install.sh | sh -s -- 0xYOURADDRESS"
fi
printf '%s' "$ADDR" | grep -Eq '^0x[0-9a-fA-F]{40}$' || die "$ADDR is not a 0x address of 40 hex digits"
case "$DUTY" in ''|*[!0-9]*) die "--duty wants a number from 10 to 100" ;; esac
[ "$DUTY" -ge 10 ] && [ "$DUTY" -le 100 ] || die "--duty wants a number from 10 to 100"

case "$(uname -s)-$(uname -m)" in
	Linux-x86_64|Linux-amd64) PLAT="linux-x86_64" ;;
	Linux-aarch64|Linux-arm64) PLAT="linux-arm64" ;;
	Darwin-arm64) PLAT="macos-arm64" ;;
	Darwin-x86_64) PLAT="macos-x86_64" ;;
	*) die "no build for $(uname -s) $(uname -m) yet" ;;
esac

case "$PLAT" in
	macos-*) DIR="$HOME/Library/Application Support/glados-miner" ;;
	*) DIR="${XDG_DATA_HOME:-$HOME/.local/share}/glados-miner" ;;
esac

command -v curl > /dev/null 2>&1 || die "curl is needed"
if command -v sha256sum > /dev/null 2>&1; then SHA="sha256sum"
elif command -v shasum > /dev/null 2>&1; then SHA="shasum -a 256"
else die "sha256sum or shasum is needed to check the download"; fi

mkdir -p "$DIR"
cd "$DIR"

say "fetching $VERSION for $PLAT into $DIR"
curl -fsSL -o SHA256SUMS "$BASE/SHA256SUMS" || die "could not download SHA256SUMS from $BASE"

# Download one release file under a local name, and refuse it unless it
# matches its line in SHA256SUMS.
fetch() {
	curl -fsSL -o "$2.part" "$BASE/$1" || die "could not download $1"
	want=$(awk -v f="$1" '$2 == f || $2 == "*" f { print $1 }' SHA256SUMS)
	[ -n "$want" ] || die "$1 is not listed in SHA256SUMS"
	have=$($SHA "$2.part" | awk '{ print $1 }')
	[ "$want" = "$have" ] || { rm -f "$2.part"; die "$1 does not match its checksum; not running it"; }
	mv "$2.part" "$2"
	chmod +x "$2"
	say "$1 checks out"
}

fetch "glados-miner-$PLAT" glados-miner

# The GPU helper exists for NVIDIA on Linux x86_64 (and Windows). Its absence
# is not an error: the CPU miner runs either way.
HAVE_GPU=0
if [ "$GPU" = "auto" ] && [ "$PLAT" = "linux-x86_64" ] && command -v nvidia-smi > /dev/null 2>&1 && nvidia-smi -L > /dev/null 2>&1; then
	fetch "xpu-linux-x86_64" xpu
	HAVE_GPU=1
else
	rm -f xpu
fi

T=""; [ -n "$THREADS" ] && T="--threads $THREADS"
cat > mine <<EOF
#!/bin/sh
# Start mining again with the settings install.sh was given. Ctrl+C stops it.
cd "\$(dirname "\$0")"
trap 'trap - INT TERM; kill 0' INT TERM
./glados-miner --pool $POOL/mine --worker $ADDR --reward $REWARD --duty $DUTY --cpu $T &
if [ -x ./xpu ]; then
	./glados-miner --pool $POOL/mine/gpu --worker $ADDR --reward $REWARD --duty $DUTY --gpu --xpu ./xpu &
fi
wait
EOF
chmod +x mine

say "installed. paid to $ADDR in $REWARD, $DUTY% load, CPU$( [ $HAVE_GPU = 1 ] && printf ' + NVIDIA GPU')"
say "Ctrl+C stops it. To start again later: \"$DIR/mine\""
say "to remove it: rm -rf \"$DIR\""
exec "$DIR/mine"
