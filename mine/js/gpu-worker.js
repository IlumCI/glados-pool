// The GPU miner, in its own worker so the page never waits on the device.
//
// The patterns are the ones a browser GPU forces: a dispatch sized to stay
// near 100 ms (long enough that submission overhead is noise, short enough
// that the browser's GPU watchdog never fires and a new job is picked up
// promptly), hits collected through an atomic counter into 64 slots, and
// every hit re-hashed on the CPU before it may leave -- a kernel bug must be
// loud here rather than a stream of rejected shares at the pool.

import { KERNELS, params } from './kernels.js';
import { belowTarget, hex } from './proto.js';

let x = null; // wasm, for midstates and the re-check
let device = null;
const pipes = new Map();
let job = null;
let duty = 1;
let looping = false;
let groups = 64;
const ITERS = 16;

const io = () => new Uint8Array(x.memory.buffer, x.io_ptr(), 1024);

self.onmessage = async (e) => {
  const m = e.data;
  try {
    if (m.type === 'init') await init(m.wasm);
    else if (m.type === 'job') setJob(m);
    else if (m.type === 'duty') duty = Math.max(0.1, Math.min(1, m.duty));
    else if (m.type === 'stop') job = null;
  } catch (err) {
    job = null;
    self.postMessage({ type: 'error', text: String(err.message || err) });
  }
};

async function init(wasm) {
  const { instance } = await WebAssembly.instantiateStreaming(fetch(wasm));
  x = instance.exports;
  const adapter = navigator.gpu && (await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' }));
  if (!adapter) throw new Error('no WebGPU adapter in this worker');
  device = await adapter.requestDevice();
  // Allocation and validation failures in WebGPU are reported
  // asynchronously, not thrown; unhandled, a dispatch that did nothing
  // would still count its nonces as searched.
  device.onuncapturederror = (ev) => {
    job = null;
    self.postMessage({ type: 'error', text: 'GPU: ' + (ev.error?.message || 'uncaptured error') });
  };
  device.lost.then((i) => {
    device = null;
    job = null;
    self.postMessage({ type: 'lost', text: i.message || i.reason || 'device lost' });
  });
  self.postMessage({ type: 'ready' });
}

async function pipeline(name) {
  if (pipes.has(name)) return pipes.get(name);
  const k = KERNELS[name];
  const module = device.createShaderModule({ code: k.wgsl });
  const info = await module.getCompilationInfo();
  const err = info.messages.find((msg) => msg.type === 'error');
  if (err) throw new Error(`${name} kernel: ${err.message} (line ${err.lineNum})`);
  const pipe = await device.createComputePipelineAsync({ layout: 'auto', compute: { module, entryPoint: 'main' } });

  const uniSize = k.full ? 128 : 96;
  const res = device.createBuffer({ size: 65 * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST });
  // A memory-hard kernel owns `scratch` words per invocation, so the number
  // of invocations in flight is fixed by how much storage one binding may
  // hold; the dispatch grows by nonces per invocation instead.
  let scratch = null;
  let lanes = 0;
  if (k.scratch) {
    const per = k.scratch * 4;
    const cap = Math.min(device.limits.maxStorageBufferBindingSize, device.limits.maxBufferSize, 64 * 1024 * 1024);
    lanes = Math.max(k.wg, Math.floor(cap / per / k.wg) * k.wg);
    // A low-memory GPU may refuse this; halve until it fits or give up.
    for (;;) {
      device.pushErrorScope('out-of-memory');
      device.pushErrorScope('validation');
      scratch = device.createBuffer({ size: lanes * per, usage: GPUBufferUsage.STORAGE });
      const bad = (await device.popErrorScope()) || (await device.popErrorScope());
      if (!bad) break;
      scratch.destroy();
      if (lanes <= k.wg) throw new Error(`${name}: GPU could not allocate scratch (${bad.message})`);
      lanes = Math.max(k.wg, (lanes >> 1) - ((lanes >> 1) % k.wg));
    }
  }
  const uni = device.createBuffer({ size: uniSize, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  const read = device.createBuffer({ size: 65 * 4, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
  const entries = [
    { binding: 0, resource: { buffer: uni } },
    { binding: 1, resource: { buffer: res } },
  ];
  if (scratch) entries.push({ binding: 2, resource: { buffer: scratch } });
  const bind = device.createBindGroup({ layout: pipe.getBindGroupLayout(0), entries });
  const p = { kernel: k, pipe, uni, res, read, bind, lanes, iters: 1 };
  pipes.set(name, p);
  return p;
}

function setJob(m) {
  if (!KERNELS[m.name]) throw new Error(`no GPU kernel for ${m.name}`);
  const b = io();
  b.set(m.header, 0);
  b.set(m.target, 80);
  if (!x.job_set(m.algo, 0, 0, 0, -1)) throw new Error('wasm refused the job');
  const mid = new Uint32Array(8);
  if (!KERNELS[m.name].full) {
    if (!x.job_mid()) throw new Error('wasm has no midstate for ' + m.name);
    const dv = new DataView(b.buffer, b.byteOffset, 32);
    for (let i = 0; i < 8; i++) mid[i] = dv.getUint32(4 * i, true);
  }
  job = { key: m.key, name: m.name, header: m.header, target: m.target, mid, next: m.start, end: m.end };
  if (!looping) loop();
}

// The loop runs detached from the message handler, so its failures --
// a scratch buffer the device cannot hold, a shader that does not compile --
// are caught here or nowhere. Uncaught, the loop died silently and `looping`
// stayed true, so no later job could ever start it again.
async function loop() {
  looping = true;
  try {
    await mine();
  } catch (err) {
    job = null;
    self.postMessage({ type: 'error', text: String(err?.message || err) });
  } finally {
    looping = false;
  }
}

async function mine() {
  const zero = new Uint32Array(65);
  while (job && device) {
    const j = job;
    const left = j.end - j.next;
    if (left <= 0) {
      self.postMessage({ type: 'exhausted', key: j.key });
      job = null;
      break;
    }
    const g = await pipeline(j.name);
    const iters = g.lanes ? g.iters : ITERS;
    const wg = g.kernel.wg || 256;
    const per = g.lanes ? g.lanes * iters : groups * 256 * ITERS;
    const limit = Math.min(per, left);
    device.queue.writeBuffer(g.uni, 0, params(g.kernel, j.mid, j.header, j.target, j.next, limit, iters));
    device.queue.writeBuffer(g.res, 0, zero);
    const t0 = performance.now();
    const enc = device.createCommandEncoder();
    const pass = enc.beginComputePass();
    pass.setPipeline(g.pipe);
    pass.setBindGroup(0, g.bind);
    pass.dispatchWorkgroups(Math.ceil(limit / (wg * iters)));
    pass.end();
    enc.copyBufferToBuffer(g.res, 0, g.read, 0, 65 * 4);
    device.queue.submit([enc.finish()]);
    let out;
    try {
      await g.read.mapAsync(GPUMapMode.READ);
      out = new Uint32Array(g.read.getMappedRange().slice(0));
      g.read.unmap();
    } catch {
      break; // device lost mid-dispatch; `lost` reports it
    }
    const dt = performance.now() - t0;
    const found = [];
    if (job === j && out[0]) {
      // The job the kernel searched is still the wasm's job, so hash_one
      // re-checks against the same header and target.
      for (let i = 0; i < Math.min(64, out[0]); i++) {
        const nonce = out[i + 1];
        x.hash_one(nonce);
        const d = io().slice(0, 32);
        if (belowTarget(d, j.target)) found.push({ nonce, digest: hex(d) });
        else self.postMessage({ type: 'bad', key: j.key, nonce });
      }
      // More than 64 hits in one dispatch means some were dropped. Quarter the
      // dispatch so the next one cannot, and say so: a target this easy for
      // this device is the pool's to raise.
      if (out[0] > 64) {
        groups = Math.max(1, groups >> 2);
        g.iters = Math.max(1, g.iters >> 2);
        self.postMessage({ type: 'overflow', key: j.key, hits: out[0] });
      }
    }
    j.next += limit;
    self.postMessage({ type: 'progress', key: j.key, hashes: limit, found });
    if (out && out[0] > 32) {
      // Near the slot limit: grow no further, whatever the timing says.
    } else if (g.lanes) {
      if (dt < 60 && g.iters < 1024) g.iters *= 2;
      else if (dt > 160 && g.iters > 1) g.iters >>= 1;
    } else if (dt < 60 && groups < 65535) groups = Math.min(65535, groups * 2);
    else if (dt > 160 && groups > 1) groups = Math.max(1, groups >> 1);
    const rest = duty >= 1 ? 0 : (dt * (1 - duty)) / duty;
    await new Promise((r) => setTimeout(r, rest));
  }
}
