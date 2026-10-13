// Injected faults: the real worker files, run inside a wrapper that breaks
// one thing, with the claim that the failure is reported rather than silent.
//
//   NODE_PATH=... CHROMIUM=/path/to/chrome node web/e2e/faults.mjs
//
// 1. The GPU worker when the device cannot give it the memory it asks for.
//
// SwiftShader allocates from system RAM and offers 1 GiB per binding, so it
// never refuses the 64 MiB a NeoScrypt dispatch wants. To exercise the path a
// small real GPU takes, the real gpu-worker.js is loaded inside a wrapper
// worker that shrinks the device: any storage buffer over a cap is requested
// at a size WebGPU must reject, so the error the worker sees is a genuine
// WebGPU validation error arriving through its error scopes -- only the
// threshold is ours.
//
// Two cases. A device that holds a quarter of what is asked: the worker must
// shrink until it fits and then mine correctly, every share it returns
// re-checked here against the wasm. A device that holds less than one
// workgroup's scratch: the worker must say so and count no hashes.

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PORT = 18767;

const srv = spawn('python3', ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1', '--directory', ROOT], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 800));
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || undefined, args: ['--enable-unsafe-webgpu'] });
const page = await browser.newPage();
// The miner page's CSP refuses a blob worker, which is the point of it;
// this test runs from a bare page on the same origin instead.
await page.goto(`http://127.0.0.1:${PORT}/web/e2e/harness.html`);

const run = (capBytes) =>
  page.evaluate(async (cap) => {
    const P = await import('/mine/js/proto.js');
    const wrapper = `
      const cap = ${cap};
      let refused = 0, granted = [];
      const real = GPUDevice.prototype.createBuffer;
      GPUDevice.prototype.createBuffer = function (d) {
        if ((d.usage & GPUBufferUsage.STORAGE) && d.size > cap) {
          refused++;
          return real.call(this, { ...d, size: 2 ** 52 }); // WebGPU must reject this
        }
        if (d.usage & GPUBufferUsage.STORAGE && d.size > 4096) granted.push(d.size);
        return real.call(this, d);
      };
      self.addEventListener('message', (e) => {
        if (e.data?.type === 'probe') self.postMessage({ type: 'probe', refused, granted });
      });
      await import('${location.origin}/mine/js/gpu-worker.js');
      // The import is asynchronous: a message posted before it finishes
      // reaches no handler and is lost, so say when it is safe to talk.
      self.postMessage({ type: 'loaded' });
    `;
    const url = URL.createObjectURL(new Blob([wrapper], { type: 'text/javascript' }));
    const w = new Worker(url, { type: 'module' });
    const seen = [];
    w.onmessage = (e) => seen.push(e.data);
    const until = async (pred, ms) => {
      const t = performance.now();
      while (performance.now() - t < ms) {
        const hit = seen.find(pred);
        if (hit) return hit;
        await new Promise((r) => setTimeout(r, 50));
      }
      return null;
    };
    if (!(await until((m) => m.type === 'loaded', 20000))) return { error: 'wrapper never loaded gpu-worker.js' };
    // Absolute, as the page passes it: a blob worker has no base to resolve a path against.
    w.postMessage({ type: 'init', wasm: location.origin + '/mine/wasm/core.wasm' });
    if (!(await until((m) => m.type === 'ready' || m.type === 'error', 20000))) return { error: 'worker never became ready' };
    const header = Uint8Array.from({ length: 80 }, (_, i) => (i * 29 + 5) & 255);
    const target = new Uint8Array(32).fill(0xff);
    target[0] = 0x1f;
    w.postMessage({ type: 'job', key: '1:oom', name: 'neoscrypt', header, target, algo: P.ALGO.neoscrypt, v10: false, n: 0, r: 0, pers: null, start: 0, end: 256 });
    const end = await until((m) => m.type === 'exhausted' || m.type === 'error', 240000);
    w.postMessage({ type: 'probe' });
    const probe = await until((m) => m.type === 'probe', 5000);
    w.terminate();

    // Every share it returned, re-checked here.
    const { instance } = await WebAssembly.instantiateStreaming(fetch('/mine/wasm/core.wasm'));
    const x = instance.exports;
    const io = () => new Uint8Array(x.memory.buffer, x.io_ptr(), 1024);
    io().set(header, 0);
    io().set(target, 80);
    x.job_set(P.ALGO.neoscrypt, 0, 0, 0, -1);
    const shares = seen.filter((m) => m.type === 'progress').flatMap((m) => m.found.map((f) => f.nonce));
    let good = 0;
    for (const n of shares) {
      x.hash_one(n);
      if (P.belowTarget(io().slice(0, 32), target)) good++;
    }
    const want = [];
    for (let n = 0; n < 256; n++) {
      x.hash_one(n);
      if (P.belowTarget(io().slice(0, 32), target)) want.push(n);
    }
    return {
      ended: end?.type,
      errorText: seen.find((m) => m.type === 'error')?.text || null,
      hashes: seen.filter((m) => m.type === 'progress').reduce((a, m) => a + m.hashes, 0),
      shares: shares.length,
      good,
      want: want.length,
      same: JSON.stringify([...shares].sort((a, b) => a - b)) === JSON.stringify(want),
      refused: probe?.refused,
      granted: probe?.granted,
    };
  }, capBytes);

const claims = [];
const claim = (ok, text) => {
  claims.push(ok);
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${text}`);
};

// A device holding 16 MiB: the worker asks for 64, must halve twice.
const a = await run(16 * 2 ** 20);
if (a.error) console.log("     run error: " + a.error);
console.log(`     16 MiB device: refused ${a.refused} allocation(s), granted ${JSON.stringify((a.granted || []).map((b) => b / 2 ** 20 + ' MiB'))}, ended '${a.ended}'${a.errorText ? ': ' + a.errorText : ''}`);
claim(a.refused >= 1, 'the oversized scratch was really refused by WebGPU');
claim((a.granted || []).length > 0 && a.granted.every((b) => b <= 16 * 2 ** 20), 'the worker shrank its scratch until it fit');
claim(a.ended === 'exhausted' && a.hashes === 256, `it then searched the whole range (${a.hashes} of 256 nonces)`);
claim(a.same && a.good === a.shares && a.shares > 0, `and found exactly the wasm's shares (${a.shares} of ${a.want}, all valid)`);

// A device holding less than one 64-lane workgroup's 2 MiB: nothing fits.
const b = await run(1 * 2 ** 20);
console.log(`     1 MiB device: ended '${b.ended}'${b.errorText ? ': ' + b.errorText : ''}`);
claim(b.ended === 'error' && /could not allocate/.test(b.errorText || ''), 'a device that cannot fit one workgroup is reported by name');
claim(b.hashes === 0, `and no hashes are counted for work never done (${b.hashes})`);

// 2. A CPU worker whose wasm traps inside scan(), the way an abort does.
const t = await page.evaluate(async () => {
  const wrapper = `
    const real = WebAssembly.instantiateStreaming;
    WebAssembly.instantiateStreaming = async (...a) => {
      const r = await real(...a);
      const ex = { ...r.instance.exports, scan: () => { throw new WebAssembly.RuntimeError('unreachable'); } };
      return { ...r, instance: { exports: ex } };
    };
    await import('${location.origin}/mine/js/worker.js');
    self.postMessage({ type: 'loaded' });`;
  const w = new Worker(URL.createObjectURL(new Blob([wrapper], { type: 'text/javascript' })), { type: 'module' });
  const seen = [];
  w.onmessage = (e) => seen.push(e.data);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  for (let i = 0; i < 200 && !seen.some((m) => m.type === 'loaded'); i++) await wait(50);
  w.postMessage({ type: 'init', wasm: location.origin + '/mine/wasm/core.wasm' });
  for (let i = 0; i < 200 && !seen.some((m) => m.type === 'ready'); i++) await wait(50);
  w.postMessage({ type: 'job', key: '1:t', header: new Uint8Array(80), target: new Uint8Array(32), algo: 1, v10: false, n: 0, r: 0, pers: null, start: 0, end: 1000 });
  for (let i = 0; i < 40 && !seen.some((m) => m.type === 'error'); i++) await wait(50);
  // A second job after the failure: the loop must be able to start again.
  w.postMessage({ type: 'job', key: '1:u', header: new Uint8Array(80), target: new Uint8Array(32), algo: 1, v10: false, n: 0, r: 0, pers: null, start: 0, end: 1000 });
  await wait(500);
  w.terminate();
  return seen.filter((m) => m.type === 'error').map((m) => m.text);
});
claim(t.length >= 1 && /unreachable/.test(t[0]), `a trapping CPU worker reports it (${JSON.stringify(t[0])})`);
claim(t.length >= 2, 'and its loop can start again for the next job rather than staying wedged');

await browser.close();
srv.kill();
const failed = claims.filter((c) => !c).length;
console.log(`${claims.length - failed} of ${claims.length} claims hold`);
process.exit(failed ? 1 : 0);
