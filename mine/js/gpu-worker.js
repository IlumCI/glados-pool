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
  const uni = device.createBuffer({ size: 96, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  const res = device.createBuffer({ size: 65 * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST });
  const read = device.createBuffer({ size: 65 * 4, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
  const bind = device.createBindGroup({
    layout: pipe.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: uni } },
      { binding: 1, resource: { buffer: res } },
    ],
  });
  const p = { kernel: k, pipe, uni, res, read, bind };
  pipes.set(name, p);
  return p;
}

function setJob(m) {
  if (!KERNELS[m.name]) throw new Error(`no GPU kernel for ${m.name}`);
  const b = io();
  b.set(m.header, 0);
  b.set(m.target, 80);
  if (!x.job_set(m.algo, 0, 0, 0, -1) || !x.job_mid()) throw new Error('wasm refused the job');
  const mid = new Uint32Array(8);
  const dv = new DataView(b.buffer, b.byteOffset, 32);
  for (let i = 0; i < 8; i++) mid[i] = dv.getUint32(4 * i, true);
  job = { key: m.key, name: m.name, header: m.header, target: m.target, mid, next: m.start, end: m.end };
  if (!looping) loop();
}

async function loop() {
  looping = true;
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
    const per = groups * 256 * ITERS;
    const limit = Math.min(per, left);
    device.queue.writeBuffer(g.uni, 0, params(g.kernel, j.mid, j.header, j.target, j.next, limit, ITERS));
    device.queue.writeBuffer(g.res, 0, zero);
    const t0 = performance.now();
    const enc = device.createCommandEncoder();
    const pass = enc.beginComputePass();
    pass.setPipeline(g.pipe);
    pass.setBindGroup(0, g.bind);
    pass.dispatchWorkgroups(Math.ceil(limit / (256 * ITERS)));
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
        self.postMessage({ type: 'overflow', key: j.key, hits: out[0] });
      }
    }
    j.next += limit;
    self.postMessage({ type: 'progress', key: j.key, hashes: limit, found });
    if (out && out[0] > 32) {
      // Near the slot limit: grow no further, whatever the timing says.
    } else if (dt < 60 && groups < 65535) groups = Math.min(65535, groups * 2);
    else if (dt > 160 && groups > 1) groups = Math.max(1, groups >> 1);
    const rest = duty >= 1 ? 0 : (dt * (1 - duty)) / duty;
    await new Promise((r) => setTimeout(r, rest));
  }
  looping = false;
}
