// The WGSL kernels against the wasm scan, in a real browser's WebGPU.
//
//   NODE_PATH=... CHROMIUM=/path/to/chrome node web/e2e/gpu.mjs
//
// For each GPU algorithm: one job, an easy target (one nonce in 64), a range
// of nonces that ends at 2^32 exactly, and the claim that the kernel finds
// exactly the nonces the wasm scan finds -- the same set, not merely the same
// count, since a kernel that read the nonce from the wrong byte would find a
// plausible number of hits that are all wrong. Under SwiftShader this proves
// correctness and nothing at all about speed.

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PORT = 18766;

const srv = spawn('python3', ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1', '--directory', ROOT], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 800));
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || undefined, args: ['--enable-unsafe-webgpu'] });
const page = await browser.newPage();
await page.goto(`http://127.0.0.1:${PORT}/mine/index.html`);

const result = await page.evaluate(async () => {
  const { KERNELS, params } = await import('/mine/js/kernels.js');
  const P = await import('/mine/js/proto.js');
  const { instance } = await WebAssembly.instantiateStreaming(fetch('/mine/wasm/core.wasm'));
  const x = instance.exports;
  const io = () => new Uint8Array(x.memory.buffer, x.io_ptr(), 1024);
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) return { error: 'no adapter' };
  const device = await adapter.requestDevice();
  const out = [];
  const COUNT = 256 * 16 * 8; // 32768 nonces
  const BASE = 2 ** 32 - COUNT; // the last range, ending exactly at the wrap
  for (const name of ['sha256d', 'blake2s']) {
    const header = Uint8Array.from({ length: 80 }, (_, i) => (i * 13 + name.length) & 255);
    const target = new Uint8Array(32).fill(0xff);
    target[0] = 0x03; // ~1 in 64
    io().set(header, 0);
    io().set(target, 80);
    if (!x.job_set(P.ALGO[name], 0, 0, 0, -1) || !x.job_mid()) return { error: 'wasm refused ' + name };
    const dv = new DataView(io().buffer, io().byteOffset, 32);
    const mid = Uint32Array.from({ length: 8 }, (_, i) => dv.getUint32(4 * i, true));
    // wasm's answer, nonce by nonce.
    const want = [];
    for (let n = BASE; n < 2 ** 32; n++) {
      x.hash_one(n >>> 0);
      if (P.belowTarget(io().slice(0, 32), target)) want.push(n >>> 0);
    }
    // The kernel's, in dispatches small enough that 64 result slots cannot overflow.
    const k = KERNELS[name];
    const module = device.createShaderModule({ code: k.wgsl });
    const info = await module.getCompilationInfo();
    const err = info.messages.find((m) => m.type === 'error');
    if (err) return { error: `${name}: ${err.message} line ${err.lineNum}` };
    const pipe = await device.createComputePipelineAsync({ layout: 'auto', compute: { module, entryPoint: 'main' } });
    const uni = device.createBuffer({ size: 96, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const res = device.createBuffer({ size: 260, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST });
    const read = device.createBuffer({ size: 260, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    const bind = device.createBindGroup({ layout: pipe.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: uni } }, { binding: 1, resource: { buffer: res } }] });
    const got = [];
    let overflow = false;
    const STEP = 1024; // ~16 hits expected, far under the 64 slots
    for (let base = BASE; base < 2 ** 32; base += STEP) {
      device.queue.writeBuffer(uni, 0, params(k, mid, header, target, base, STEP, 16));
      device.queue.writeBuffer(res, 0, new Uint32Array(65));
      const enc = device.createCommandEncoder();
      const pass = enc.beginComputePass();
      pass.setPipeline(pipe);
      pass.setBindGroup(0, bind);
      pass.dispatchWorkgroups(1); // 256 invocations x 16 iters covers 4096 >= STEP
      pass.end();
      enc.copyBufferToBuffer(res, 0, read, 0, 260);
      device.queue.submit([enc.finish()]);
      await read.mapAsync(GPUMapMode.READ);
      const r = new Uint32Array(read.getMappedRange().slice(0));
      read.unmap();
      if (r[0] > 64) overflow = true;
      for (let i = 0; i < Math.min(64, r[0]); i++) got.push(r[i + 1]);
    }
    got.sort((a, b) => a - b);
    const same = got.length === want.length && got.every((v, i) => v === want[i]);
    out.push({ name, want: want.length, got: got.length, same, overflow });
  }
  const info = adapter.info || {};
  return { adapter: `${info.vendor} ${info.architecture}`, out };
});

let failed = 0;
if (result.error) {
  console.log('FAIL ' + result.error);
  failed++;
} else {
  console.log('     adapter: ' + result.adapter);
  for (const r of result.out) {
    const ok = r.same && !r.overflow && r.want > 100;
    if (!ok) failed++;
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${r.name}: kernel found ${r.got}, wasm found ${r.want}, identical sets: ${r.same}, overflow: ${r.overflow}`);
  }
}
await browser.close();
srv.kill();
process.exit(failed ? 1 : 0);
