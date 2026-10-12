// The pool's protocol, as the browser speaks it. No DOM, no sockets: pure
// functions over messages, so they can be tested outside a browser.
//
// Contract (design/pool.md, "The methods"):
//   header  80 bytes hex, nonce little-endian at offset 76
//   target  32 bytes hex, big-endian; the byte-reversed digest must not exceed it
//   nonce   submitted as 8 hex digits, big-endian
//   algo    a structure, never a name: yespower carries v10, n, r and hex pers

export const ALGO = { sha256d: 1, blake2s: 2, yespower: 3, neoscrypt: 4 };

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
    const pers = a.pers === undefined || a.pers === null ? null : unhex(a.pers);
    if (a.pers != null && !pers) return { error: 'yespower pers is not hex' };
    algo = { id: ALGO.yespower, name, v10: a.v10, n: a.n, r: a.r, pers };
  } else if (name === 'sha256d' || name === 'blake2s' || name === 'neoscrypt') {
    // A bare name is the whole algorithm for these: NeoScrypt's N, r and
    // rounds are its profile rather than settings a pool could vary.
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

/** Whether a digest meets a big-endian target, read the way the pool reads it. */
export function belowTarget(digest, target) {
  for (let i = 0; i < 32; i++) {
    const d = digest[31 - i];
    if (d !== target[i]) return d < target[i];
  }
  return true;
}

export const nonceHex = (n) => (n >>> 0).toString(16).padStart(8, '0');

export const hello = (id, worker, agent) =>
  JSON.stringify({ id, method: 'glados.hello', params: { v: 1, worker, agent } });

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
