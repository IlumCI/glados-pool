// One mining thread: its own WebAssembly instance, one slice of one job.
//
// It yields to its own event loop between batches, which is how a new job or
// a stop arrives promptly: a batch is sized to about 100 ms, so nothing waits
// longer than that for the worker to look up.

import { belowTarget, hex } from './proto.js';

let x = null; // wasm exports
let job = null; // { key, start, end, next }
let duty = 1;
let looping = false;

const io = () => new Uint8Array(x.memory.buffer, x.io_ptr(), 1024);

self.onmessage = async (e) => {
  const m = e.data;
  if (m.type === 'init') {
    const { instance } = await WebAssembly.instantiateStreaming(fetch(m.wasm));
    x = instance.exports;
    self.postMessage({ type: 'ready' });
  } else if (m.type === 'job') {
    const b = io();
    b.set(m.header, 0);
    b.set(m.target, 80);
    if (m.pers) b.set(m.pers, 112);
    if (!x.job_set(m.algo, m.v10 ? 1 : 0, m.n, m.r, m.pers ? m.pers.length : -1)) {
      job = null;
      self.postMessage({ type: 'refused', key: m.key });
      return;
    }
    job = { key: m.key, start: m.start, end: m.end, next: m.start, target: m.target };
    if (!looping) loop();
  } else if (m.type === 'duty') {
    duty = Math.max(0.1, Math.min(1, m.duty));
  } else if (m.type === 'stop') {
    job = null;
  }
};

async function loop() {
  looping = true;
  let batch = 4;
  while (job) {
    const j = job;
    const left = j.end - j.next;
    if (left <= 0) {
      self.postMessage({ type: 'exhausted', key: j.key });
      job = null;
      break;
    }
    const count = Math.min(batch, left);
    const t0 = performance.now();
    const n = x.scan(j.next >>> 0, count);
    const dt = performance.now() - t0;
    const found = [];
    if (n) {
      const b = io();
      const view = new DataView(b.buffer, b.byteOffset + 512, n * 4);
      const nonces = Array.from({ length: n }, (_, i) => view.getUint32(i * 4, true));
      // Re-check each one with a second comparison that is not the one that
      // found it: Rust's said yes, JavaScript's must agree before it leaves.
      for (const nonce of nonces) {
        x.hash_one(nonce);
        const d = io().slice(0, 32);
        if (belowTarget(d, j.target)) found.push({ nonce, digest: hex(d) });
        else self.postMessage({ type: 'bad', key: j.key, nonce });
      }
    }
    if (job === j) j.next += count;
    self.postMessage({ type: 'progress', key: j.key, hashes: count, found });
    // Aim at ~100 ms a batch: long enough that messaging is noise, short
    // enough that a new job is picked up before it is stale.
    if (dt < 60) batch = Math.min(batch * 2, 1 << 20);
    else if (dt > 160 && batch > 1) batch = batch >> 1;
    const rest = duty >= 1 ? 0 : (dt * (1 - duty)) / duty;
    await new Promise((r) => setTimeout(r, rest));
  }
  looping = false;
}
