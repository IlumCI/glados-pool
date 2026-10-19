// The GPU on Pearl: rounds of pearl-gpu.js on whatever job the pool last sent,
// and a proof for every tile under the share bound.
//
// Speaks to miner.js the way gpu-worker.js does -- init/ready, duty, progress,
// lost/error -- plus `pearljob` in and `pearlshare` out. Progress is counted in
// multiply-accumulates, which is what Pearl itself calls a hash, so the page's
// H/s reads as Pearl's own TH/s.
//
// A round is one matrix product (m x n x 2048) and its commitment; at 8192 x
// 8192 that is ~0.1 s on a laptop RTX 3050, short enough to keep the page and
// the GPU watchdog happy, long enough that the commitment is a small part of it.

import { PearlGPU } from './pearl-gpu.js';
import { toBase64 } from './pearlproof.js';

const K = 2048, RANK = 128, MAC_PER_TILE = 16 * 16 * K;
const PROOFS_PER_ROUND = 4; // a fast card at a low share bound must not spend its round on proofs

let g = null, job = null, duty = 1, running = false;
const post = (m) => self.postMessage(m);
const unhex = (h) => Uint8Array.from(h.match(/../g), (b) => parseInt(b, 16));
const rand32 = () => crypto.getRandomValues(new Uint32Array(1))[0];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function init() {
  if (!self.navigator.gpu) throw new Error('WebGPU is not available in this worker');
  const ad = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!ad) throw new Error('no WebGPU adapter');
  const lim = ad.limits;
  const device = await ad.requestDevice({ requiredLimits: { maxStorageBufferBindingSize: lim.maxStorageBufferBindingSize, maxBufferSize: lim.maxBufferSize } });
  device.lost.then((info) => { job = null; post({ type: 'lost', text: info.message || info.reason || 'lost' }); });
  // The largest square a binding can hold: four matrices of size^2 x 2048 bytes.
  const cap = Math.min(lim.maxStorageBufferBindingSize, lim.maxBufferSize);
  const size = [8192, 4096, 2048, 1024].find((s) => s * K <= cap) || 1024;
  const src = async (f) => (await fetch(new URL(f, import.meta.url))).text();
  g = await PearlGPU.create(device, { m: size, n: size, k: K, rank: RANK, round: await src('./pearl-round.wgsl'), jackpot: await src('./jackpot.wgsl') });
  return size;
}

async function loop() {
  running = true;
  while (job) {
    const j = job;
    const t0 = performance.now();
    const r = await g.round(unhex(j.header), rand32(), rand32(), j.bits);
    const dt = performance.now() - t0;
    post({ type: 'progress', hashes: (g.m / 16) * (g.n / 16) * MAC_PER_TILE, found: [] });
    for (const [tr, tc] of r.hits.slice(0, PROOFS_PER_ROUND)) {
      if (job !== j) break; // a new job replaced this one; its proofs would be stale
      post({ type: 'pearlshare', job: j.job, proof: toBase64(await g.proof(tr, tc)) });
    }
    if (duty < 1) await sleep((dt * (1 - duty)) / duty);
  }
  running = false;
}

self.onmessage = async (e) => {
  const m = e.data;
  if (m.type === 'init') {
    try { post({ type: 'ready', size: await init() }); }
    catch (err) { post({ type: 'error', text: String(err && err.message ? err.message : err) }); }
  } else if (m.type === 'duty') {
    duty = Math.min(1, Math.max(0.1, Number(m.duty) || 1));
  } else if (m.type === 'pearljob') {
    if (!g) return;
    job = { job: m.job, header: m.header, bits: m.bits };
    if (!running) loop().catch((err) => { running = false; post({ type: 'error', text: String(err && err.message ? err.message : err) }); });
  } else if (m.type === 'stop') {
    job = null;
  }
};
