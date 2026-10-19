// The pool's protocol, as the browser speaks it. No DOM, no sockets: pure
// functions over messages, so they can be tested outside a browser.
//
// Contract (design/pool.md, "The methods"):
//   header  80 bytes hex, nonce little-endian at offset 76
//   target  32 bytes hex, big-endian; the byte-reversed digest must not exceed it
//   nonce   submitted as 8 hex digits, big-endian
//   algo    a structure, never a name: yespower carries v10, n, r and hex pers

// Per-thread scratch cap for yespower: twice the largest real coin's 16 MiB.
export const YESPOWER_MAX_BYTES = 32 * 2 ** 20;

export const ALGO = { sha256d: 1, blake2s: 2, yespower: 3, neoscrypt: 4, heavyhash: 5 };

// Which device class an algorithm belongs on. yespower is built to resist
// GPUs; the rest are GPU or ASIC work, where a browser CPU earns nothing worth
// the electricity. The GPU path takes the second class once it exists.
export const CLASS = { yespower: 'cpu', neoscrypt: 'gpu', sha256d: 'gpu', blake2s: 'gpu', heavyhash: 'gpu' };

export function unhex(s) {
  if (typeof s !== 'string' || s.length % 2 || /[^0-9a-fA-F]/.test(s)) return null;
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(2 * i, 2 * i + 2), 16);
  return out;
}

export const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

/** A `glados.job`'s params, checked, or null with the reason. */
export function parseJob(p) {
  if (!p || typeof p !== 'object') return { error: 'job is not an object' };
  const header = unhex(p.header);
  const target = unhex(p.target);
  if (!header || header.length !== 80) return { error: 'header is not 80 bytes of hex' };
  if (!target || target.length !== 32) return { error: 'target is not 32 bytes of hex' };
  if (typeof p.job !== 'string' || !Number.isInteger(p.slot)) return { error: 'job needs a string id and an integer slot' };
  const a = p.algo || {};
  const name = a.name;
  const cls = CLASS[name] || null;
  let algo = null;
  if (name === 'yespower') {
    const ok = typeof a.v10 === 'boolean' && Number.isInteger(a.n) && Number.isInteger(a.r);
    // Refused rather than defaulted: a guessed N hashes a different function
    // correctly and every share it finds is rejected.
    if (!ok) return { error: 'yespower job without v10, n and r' };
    if (a.n < 1024 || a.n > 524288 || (a.n & (a.n - 1)) !== 0) return { error: `yespower N=${a.n} is not a power of two in 1024..524288` };
    if (a.r < 8 || a.r > 32) return { error: `yespower r=${a.r} is outside 8..32` };
    // Every worker holds 128*r*N bytes. Real coins stay at or under 16 MiB;
    // a job asking for gigabytes would trap each worker's wasm or take the
    // whole tab down with it, so it is refused here with the reason.
    const bytes = 128 * a.r * a.n;
    if (bytes > YESPOWER_MAX_BYTES) return { error: `yespower N=${a.n} r=${a.r} needs ${bytes / 2 ** 20} MiB of memory per thread, over the ${YESPOWER_MAX_BYTES / 2 ** 20} MiB cap` };
    const pers = a.pers === undefined || a.pers === null ? null : unhex(a.pers);
    if (a.pers != null && !pers) return { error: 'yespower pers is not hex' };
    if (pers && pers.length > 400) return { error: 'yespower pers is over 400 bytes' };
    algo = { id: ALGO.yespower, name, v10: a.v10, n: a.n, r: a.r, pers };
  } else if (name === 'sha256d' || name === 'blake2s' || name === 'neoscrypt' || name === 'heavyhash') {
    // A bare name is the whole algorithm for these: NeoScrypt's N, r and
    // rounds are its profile rather than settings a pool could vary, and
    // HeavyHash's matrix comes from the header, so there is nothing to carry.
    algo = { id: ALGO[name], name, v10: false, n: 0, r: 0, pers: null };
  }
  return {
    slot: p.slot,
    coin: typeof p.coin === 'string' ? p.coin : '',
    job: p.job,
    algo, // null: this build cannot hash it (yet)
    name: typeof name === 'string' ? name : '?',
    cls,
    header,
    target,
    echo: p.echo && typeof p.echo === 'object' ? p.echo : {},
    clean: p.clean === true,
  };
}

/**
 * A `glados.earn`'s params, checked, or null. The miner's accrued, unpaid
 * revenue valued in the asset the pool is actually crediting:
 *
 *   <- {"method":"glados.earn","params":{"asset":"nvda","value":0.0123}}
 *
 * Only the pool can produce this. Under the equal split every worker's share
 * is the epoch's pot over the recipient count, and `value` is that share
 * expressed in `asset`; the pool holds the pot, the count and the USD->asset
 * quote, and the browser holds none of the three, so the figure is read from
 * the wire and never computed here. It is gross of the miner's own power cost
 * and net of the pool's gas and swap, which come out of the pot before it is
 * split. `asset` is what is *really* being credited: if the chosen asset was
 * blocked this epoch and the pool fell back to $GLaDOS, it says `glados` here,
 * so the page can show the truth rather than the request. Optional and resent
 * as the figure moves; a malformed one returns null and the page keeps the
 * last good value rather than showing a wrong one.
 */
export function parseEarn(p) {
  if (!p || typeof p !== 'object') return null;
  const { asset, value } = p;
  if (typeof asset !== 'string' || !asset) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
  // The pool may also send payout facts: how many miners the last distribution
  // split between, the cadence in ms, and when it last paid. Each is kept only
  // when it is a sound non-negative number, so a malformed extra never shows.
  const out = { asset, value };
  const num = (x) => typeof x === 'number' && Number.isFinite(x) && x >= 0;
  if (num(p.usd)) out.usd = p.usd;
  if (num(p.recipients)) out.recipients = p.recipients;
  if (num(p.epochMs)) out.epochMs = p.epochMs;
  if (num(p.lastAt)) out.lastAt = p.lastAt;
  return out;
}

/** Whether a digest meets a big-endian target, read the way the pool reads it. */
export function belowTarget(digest, target) {
  for (let i = 0; i < 32; i++) {
    const d = digest[31 - i];
    if (d !== target[i]) return d < target[i];
  }
  return true;
}

export const nonceHex = (n) => (n >>> 0).toString(16).padStart(8, '0');

export const hello = (id, worker, agent, reward) =>
  JSON.stringify({ id, method: 'glados.hello', params: reward ? { v: 1, worker, agent, reward } : { v: 1, worker, agent } });

export const submit = (id, job, nonce, echo) =>
  JSON.stringify({ id, method: 'glados.submit', params: { job, nonce: nonceHex(nonce), echo } });

export const work = (id, slot) => JSON.stringify({ id, method: 'glados.work', params: { slot } });

/**
 * Split 2^32 nonces into `k` contiguous ranges. Contiguous rather than
 * interleaved so each worker's progress is one counter and "exhausted" is a
 * comparison, never a set.
 */
export function ranges(k) {
  const out = [];
  const step = Math.floor(2 ** 32 / k);
  for (let i = 0; i < k; i++) {
    const start = i * step;
    const end = i === k - 1 ? 2 ** 32 : start + step;
    out.push({ start, end });
  }
  return out;
}

/** Assign `n` workers across the CPU-class slots on offer, as evenly as possible. */
export function assign(n, slots) {
  const out = new Map(slots.map((s) => [s, 0]));
  if (!slots.length) return out;
  for (let i = 0; i < n; i++) out.set(slots[i % slots.length], out.get(slots[i % slots.length]) + 1);
  return out;
}

export const isAddress = (a) => /^0x[0-9a-fA-F]{40}$/.test(a || '');

/**
 * The bridge to connect to. An override is honoured only for a local
 * address: anything else would let a link silently send a visitor's hashrate
 * and payout address to somebody else's server while the page looks normal.
 */
export function bridgeUrl(override, fallback) {
  if (!override) return fallback;
  try {
    const u = new URL(override);
    const local = u.hostname === '127.0.0.1' || u.hostname === 'localhost' || u.hostname === '[::1]';
    if ((u.protocol === 'ws:' || u.protocol === 'wss:') && local) return u.href.replace(/\/$/, '');
  } catch {}
  return fallback;
}

// ---- Keccak-256 (the pre-NIST padding Ethereum uses), for EIP-55 ----
// BigInt lanes: a few hundred microseconds per address, which is nothing for
// a check run once when Start is pressed, and far less code to get wrong.
const RC = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n, 0x000000000000808bn,
  0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n, 0x000000000000008an, 0x0000000000000088n,
  0x0000000080008009n, 0x000000008000000an, 0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n,
  0x8000000000008003n, 0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an,
  0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
];
const ROT = [0, 1, 62, 28, 27, 36, 44, 6, 55, 20, 3, 10, 43, 25, 39, 41, 45, 15, 21, 8, 18, 2, 61, 56, 14];
const M64 = (1n << 64n) - 1n;
const rotl64 = (x, n) => (n === 0 ? x : ((x << BigInt(n)) | (x >> BigInt(64 - n))) & M64);

function keccakF(st) {
  for (let round = 0; round < 24; round++) {
    const c = [0, 1, 2, 3, 4].map((x) => st[x] ^ st[x + 5] ^ st[x + 10] ^ st[x + 15] ^ st[x + 20]);
    for (let x = 0; x < 5; x++) {
      const d = c[(x + 4) % 5] ^ rotl64(c[(x + 1) % 5], 1);
      for (let y = 0; y < 25; y += 5) st[y + x] ^= d;
    }
    const b = new Array(25);
    for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) b[y + 5 * ((2 * x + 3 * y) % 5)] = rotl64(st[x + 5 * y], ROT[x + 5 * y]);
    for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) st[x + 5 * y] = b[x + 5 * y] ^ (~b[(x + 1) % 5 + 5 * y] & M64 & b[(x + 2) % 5 + 5 * y]);
    st[0] ^= RC[round];
  }
}

export function keccak256Hex(data) {
  const rate = 136;
  const padded = new Uint8Array(Math.floor(data.length / rate) * rate + rate);
  padded.set(data);
  padded[data.length] ^= 0x01;
  padded[padded.length - 1] ^= 0x80;
  const st = new Array(25).fill(0n);
  for (let off = 0; off < padded.length; off += rate) {
    for (let i = 0; i < rate / 8; i++) {
      let lane = 0n;
      for (let k = 7; k >= 0; k--) lane = (lane << 8n) | BigInt(padded[off + 8 * i + k]);
      st[i] ^= lane;
    }
    keccakF(st);
  }
  let out = '';
  for (let i = 0; i < 4; i++) for (let k = 0; k < 8; k++) out += Number((st[i] >> BigInt(8 * k)) & 0xffn).toString(16).padStart(2, '0');
  return out;
}

/**
 * EIP-55. A mixed-case address carries a checksum and must satisfy it: a
 * single mistyped character then fails here rather than sending rewards to
 * an address nobody holds. An all-lower or all-upper one carries none and is
 * accepted with a warning, since that is how many wallets display addresses.
 */
export function checkAddress(a) {
  if (!isAddress(a)) return { ok: false, why: 'not a 0x address of 40 hex digits' };
  const body = a.slice(2);
  if (body === body.toLowerCase() || body === body.toUpperCase()) {
    return { ok: true, warn: 'this address has no checksum (all one case), so a typo cannot be caught; paste it from your wallet' };
  }
  const h = keccak256Hex(new TextEncoder().encode(body.toLowerCase()));
  for (let i = 0; i < 40; i++) {
    const c = body[i];
    if (/[a-f]/i.test(c) && (parseInt(h[i], 16) >= 8) !== (c === c.toUpperCase())) {
      return { ok: false, why: 'address checksum does not match: one or more characters is mistyped' };
    }
  }
  return { ok: true };
}

/**
 * A token bucket for submits. Taking by elapsed time rather than one per
 * tick is what survives a hidden tab: browsers throttle timers there to about
 * one a minute, and a one-per-tick pacer would then send one share a minute
 * and let the rest go stale. Capped at `burst`, under the bridge's own 40.
 */
export class Pacer {
  constructor(rate, burst) {
    this.rate = rate;
    this.burst = burst;
    this.tokens = burst;
    this.last = null;
  }
  take(now) {
    if (this.last !== null) this.tokens = Math.min(this.burst, this.tokens + ((now - this.last) / 1000) * this.rate);
    this.last = now;
    const n = Math.floor(this.tokens);
    this.tokens -= n;
    return n;
  }
  /** Give back what was taken and not used. */
  refund(n) {
    this.tokens = Math.min(this.burst, this.tokens + n);
  }
}
