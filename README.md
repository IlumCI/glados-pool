# The GLaDOS pool's published record

Layer 1 of this pool never holds a miner's coins. Each miner is paid by the
upstream, directly, in what they mined -- so there is no wallet to audit, no
treasury to inspect, and nothing to take on faith except arithmetic.

`design/pool.md` in [the kernel repository](https://github.com/IlumCI/GLaDOS)
calls the share log "the only thing standing in for trust". This repository is
that log, and the means to check it.

## What is here

| | |
|---|---|
| `shares.txt` | one line per accepted share: algorithm, header, nonce, target, worker |
| `ledger.json` | the per-worker tally the pool writes, and what a payout is built from |
| `index.html` | reads `ledger.json` and recomputes its digest in your browser |
| `.github/workflows/verify-shares.yml` | recomputes every share in `shares.txt`, daily and on demand |

## Why a tally is not enough

`ledger.json` says how much work each worker did. It cannot be re-verified: the
numbers in it are the operator's program's own answer, and reading them means
trusting that program. Publishing a number you cannot check is not an audit.

`shares.txt` carries what a share actually was -- the 80-byte header the pool
issued, the nonce the miner found, and the target it had to beat. That is enough
for anybody to recompute the hash and see for themselves.

## Check it yourself

You do not need this repository's CI, or its operator, or its word.

```bash
git clone https://github.com/IlumCI/GLaDOS
cd GLaDOS/pool
cargo build --release --target x86_64-unknown-linux-gnu
./target/x86_64-unknown-linux-gnu/release/glados-pool --verify ../../glados-pool/shares.txt
```

It prints one line per share that does not meet its target, and exits non-zero if
there are any:

```
13 share(s) recomputed and met their target, 0 did not, 0 unreadable
every share in shares.txt is arithmetic anybody can repeat
```

Change one hex digit of one nonce and it says so:

```
line 1: rig-alpha does NOT meet its target, digest a66682ae67fe6e12...
12 share(s) recomputed and met their target, 1 did not, 0 unreadable
```

**The verifier is the kernel's own hash code**, not a reimplementation.
`pool/src/lib.rs` reaches into `src/mine/` by `#[path]` -- the same bytes the
ring-0 miner compiles -- so there is no second yespower anywhere to disagree with
the first.

## Why the pool's source is not in this repository

Because copying it would break the only property that makes the verification
worth anything. `pool/src/lib.rs` says it plainly:

> Not copies: the same bytes the ring-0 miner compiles. A change to yespower that
> breaks agreement is a build failure or a failing vector here, in the same
> commit, rather than a share the pool rejects a week later for a reason nobody
> can find.

So the source lives in one place and this repository holds the running and the
record. The workflow checks out the kernel and builds the pool from there.

## What the CI here is not

**It is not the pool.** A GitHub runner has no inbound networking -- it dials
out, and nothing dials in -- so there is no port for a miner to connect to.
Share acceptance also has to happen inline, in milliseconds, while the job is
still live.

This is the audit rather than the service, which is the more useful half to run
in public: accepting a share is cheap and the operator does it anyway, while
independent re-verification is the one thing an operator cannot do for
themselves.

## Status

**Nothing is published yet.** The pool is built and driven but not deployed, and
`--sharelog` is off by default because it is unbounded by construction -- about
200 bytes per accepted share, forever. When a pool runs, its log lands here and
the workflow starts having something to check.
