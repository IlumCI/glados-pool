# Session 1 — a test run, and labelled as one

**This is not a payout record and nobody is owed anything for it.** It is the
first end-to-end run of the whole chain, kept because the arithmetic in it is
real and checkable even though the work was done by the operator's own machine
against a coin with no chain behind it.

## What actually happened

A GLaDOS miner ISO — 32.6 MB, no model, one activity — booted under QEMU with KVM
and found its pool from a config file on its own boot medium. It mined for 88
seconds and the pool credited every share it sent.

    hashing  293158 H/s over 25731072 hashes in 87772 ms,
             sharing the core with 7 task(s)
    shares   20 found, 20 accepted, 0 rejected
    best     28 leading zero bits

Two slices, each grinding its own quarter of the nonce space — visible in the
pool's log as two disjoint nonce ranges rather than two miners racing the same
numbers.

Validation cost the pool **127.7 µs a share**, which is what `--cpu-percent`
budgets against.

## Why it is a test and not a payout

- **The coin has no chain.** `glados:sha256d:18` is `Source::Local`: the pool
  builds its own headers, so these are real proof of work against a target only
  this pool recognises. Nothing was mined that anybody else would credit.
- **The worker name is a placeholder.** `0x…beef` is what the ISO shipped with,
  not a payout address. At the account-free venues the worker name *is* the
  address, which is why the image refuses to mine without one being set — and why
  this one was deliberately left as an obvious dummy.
- **No epoch was opened and nothing was bought or burnt.** The claim contract has
  never been deployed.

## What it does establish

The record below is recomputable by anybody, and that is the whole point of
publishing it:

    20 share(s) recomputed and met their target, 0 did not, 0 unreadable
    every share in shares.txt is arithmetic anybody can repeat

`ledger.json`'s digest also verifies, checked by a third implementation
(`tools/ledgercheck.py`) that shares no code with the writer.

So the chain from *a share the kernel found* to *a record a stranger can check*
is closed. What is not closed is everything after it: a real upstream, a funded
epoch, and a buy.
