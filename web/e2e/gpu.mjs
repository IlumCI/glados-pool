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
await page.goto(`http://127.0.0.1:${PORT}/mine/index.html?fuzz=${process.env.GPU_FUZZ || 0}`);

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
  // sha256d and blake2s: 32,768 nonces at 1 in 64. neoscrypt is ~10^5 times
  // costlier per nonce and SwiftShader runs it on the CPU, so 512 at 1 in 8.
  // Then random headers and random ranges (GPU_FUZZ=n of each), so a kernel
  // that is right for one header layout and wrong for another is caught.
  const FUZZ = Number(new URLSearchParams(location.search).get('fuzz') || 0);
  let seed = 0x9e3779b9;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0), seed);
  const CASES = [
    { name: 'sha256d', count: 32768, step: 1024, top: 0x03, base: 2 ** 32 - 32768, fixed: true },
    { name: 'blake2s', count: 32768, step: 1024, top: 0x03, base: 2 ** 32 - 32768, fixed: true },
    { name: 'neoscrypt', count: 512, step: 128, top: 0x1f, base: 2 ** 32 - 512, fixed: true },
  ];
  for (let f = 0; f < FUZZ; f++) {
    CASES.push({ name: 'sha256d', count: 4096, step: 1024, top: 0x07, base: rnd() & ~4095 });
    CASES.push({ name: 'blake2s', count: 4096, step: 1024, top: 0x07, base: rnd() & ~4095 });
    if (f < 3) CASES.push({ name: 'neoscrypt', count: 128, step: 128, top: 0x3f, base: rnd() & ~127 });
  }
  for (const { name, count: COUNT, step: STEP, top, base: BASE, fixed } of CASES) {
    const header = fixed
      ? Uint8Array.from({ length: 80 }, (_, i) => (i * 13 + name.length) & 255)
      : Uint8Array.from({ length: 80 }, () => rnd() & 255);
    const target = new Uint8Array(32).fill(0xff);
    target[0] = top;
    io().set(header, 0);
    io().set(target, 80);
    const k = KERNELS[name];
    if (!x.job_set(P.ALGO[name], 0, 0, 0, -1)) return { error: 'wasm refused ' + name };
    const mid = new Uint32Array(8);
    if (!k.full) {
      if (!x.job_mid()) return { error: 'no midstate for ' + name };
      const dv = new DataView(io().buffer, io().byteOffset, 32);
      for (let i = 0; i < 8; i++) mid[i] = dv.getUint32(4 * i, true);
    }
    // wasm's answer, nonce by nonce.
    const want = [];
    for (let n = BASE; n < BASE + COUNT; n++) {
      x.hash_one(n >>> 0);
      if (P.belowTarget(io().slice(0, 32), target)) want.push(n >>> 0);
    }
    const module = device.createShaderModule({ code: k.wgsl });
    const info = await module.getCompilationInfo();
    const err = info.messages.find((m) => m.type === 'error');
    if (err) return { error: `${name}: ${err.message} line ${err.lineNum}` };
    const pipe = await device.createComputePipelineAsync({ layout: 'auto', compute: { module, entryPoint: 'main' } });
    const uni = device.createBuffer({ size: k.full ? 128 : 96, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const res = device.createBuffer({ size: 260, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST });
    const read = device.createBuffer({ size: 260, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    const wg = k.wg || 256;
    const iters = k.scratch ? 1 : 16;
    const entries = [{ binding: 0, resource: { buffer: uni } }, { binding: 1, resource: { buffer: res } }];
    if (k.scratch) {
      const sb = device.createBuffer({ size: STEP * k.scratch * 4, usage: GPUBufferUsage.STORAGE });
      entries.push({ binding: 2, resource: { buffer: sb } });
    }
    const bind = device.createBindGroup({ layout: pipe.getBindGroupLayout(0), entries });
    const got = [];
    let overflow = false;
    for (let base = BASE; base < BASE + COUNT; base += STEP) {
      device.queue.writeBuffer(uni, 0, params(k, mid, header, target, base, STEP, iters));
      device.queue.writeBuffer(res, 0, new Uint32Array(65));
      const enc = device.createCommandEncoder();
      const pass = enc.beginComputePass();
      pass.setPipeline(pipe);
      pass.setBindGroup(0, bind);
      pass.dispatchWorkgroups(Math.ceil(STEP / (wg * iters)));
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
    out.push({ name, want: want.length, got: got.length, same, overflow, min: Math.max(4, COUNT / 512), base: BASE >>> 0 });
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
    const ok = r.same && !r.overflow && r.want > r.min;
    if (!ok) failed++;
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${r.name} @${r.base.toString(16)}: kernel found ${r.got}, wasm found ${r.want}, identical sets: ${r.same}, overflow: ${r.overflow}`);
  }
}
await browser.close();
srv.kill();
process.exit(failed ? 1 : 0);
