// End to end: a real browser, the real bridge binary, the real page and wasm,
// against a fake pool that checks every share it is sent.
//
//   node web/e2e/run.mjs            (Playwright resolvable via NODE_PATH)
//
// The fake pool offers two slots at once: a yespower job (CPU class) and a
// sha256d job (GPU class). The claims are that the CPU mines the first and
// the GPU the second at the same time (or, with no WebGPU, that nothing is
// submitted for the second), and that every share it submits meets its
// target when the pool recomputes it. Exhausting a job's 2^32 nonces takes
// days at browser yespower rates, so the ask-for-work path is not reached
// here; web/e2e/proto.test.mjs covers the range arithmetic it rests on.
//
// The pool's re-check loads the baseline wasm in Node, a different engine
// instance from the browser's simd build -- it checks the plumbing (nonce
// byte order, header placement, target comparison, the wire format), while
// the hash itself is pinned by the published vectors in web/core.

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SITE_PORT = 18765;
const BRIDGE_PORT = 18080;
const POOL_PORT = 13334;
const ADDRESS = '0x00000000000000000000000000000000000000aa';

const claims = [];
const claim = (ok, text) => {
  claims.push({ ok, text });
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${text}`);
};

// ---------------------------------------------------------------- fake pool
const { instance } = await WebAssembly.instantiate(readFileSync(path.join(ROOT, 'mine/wasm/core.wasm')));
const x = instance.exports;
const io = () => new Uint8Array(x.memory.buffer, x.io_ptr(), 1024);
const unhex = (s) => Uint8Array.from(s.match(/../g), (b) => parseInt(b, 16));
const hex = (b) => Buffer.from(b).toString('hex');

// One in 16 nonces meets this target, so a few seconds of yespower find shares.
const EASY = '0f' + 'ff'.repeat(31);
// sha256d runs millions of times faster; its target is set so the GPU finds
// a few shares a second rather than flooding the result slots.
const HARD = '0000' + 'f'.repeat(60);
const header = (seed) => hex(Uint8Array.from({ length: 80 }, (_, i) => (i * 7 + seed) & 255));
let jobSeq = 0;
const jobs = new Map(); // id -> { algo, header, target }
function makeJob(slot, algo) {
  const id = 'j' + ++jobSeq;
  const j = { id, slot, algo, header: header(jobSeq), target: algo.name === 'sha256d' || algo.name === 'blake2s' ? HARD : EASY };
  jobs.set(id, j);
  return j;
}
const jobMsg = (j) =>
  JSON.stringify({
    method: 'glados.job',
    params: { slot: j.slot, coin: j.slot === 1 ? 'testzeny' : 'testbtc', job: j.id, algo: j.algo, header: j.header, target: j.target, echo: { e: j.id }, clean: true },
  }) + '\n';

const YES = { name: 'yespower', v10: true, n: 2048, r: 8 };
// E2E_GPU_ALGO=neoscrypt offers NeoScrypt as the GPU-class slot instead.
const GPU_ALGO = process.env.E2E_GPU_ALGO || 'sha256d';
const SHA = { name: GPU_ALGO };
const seen = { hello: null, submits: 0, verified: 0, wrongSlot: 0, badEcho: 0, workAsks: 0, bySlot: { 1: 0, 2: 0 } };

function verify(j, nonceHex) {
  const nonce = parseInt(nonceHex, 16) >>> 0;
  io().set(unhex(j.header), 0);
  io().set(unhex(j.target), 80);
  const algo = { yespower: 3, sha256d: 1, blake2s: 2, neoscrypt: 4 }[j.algo.name];
  x.job_set(algo, j.algo.v10 ? 1 : 0, j.algo.n || 0, j.algo.r || 0, -1);
  x.hash_one(nonce);
  const d = io().slice(0, 32);
  const t = unhex(j.target);
  for (let i = 0; i < 32; i++) if (d[31 - i] !== t[i]) return d[31 - i] < t[i];
  return true;
}

const pool = net.createServer((sock) => {
  let buf = '';
  sock.on('data', (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      const m = JSON.parse(line);
      if (m.method === 'glados.hello') {
        seen.hello = m.params;
        sock.write(JSON.stringify({ id: m.id, result: { v: 1, slots: 2, session: 'e2e' }, error: null }) + '\n');
        sock.write(jobMsg(makeJob(1, YES)));
        sock.write(jobMsg(makeJob(2, SHA)));
      } else if (m.method === 'glados.submit') {
        seen.submits++;
        const j = jobs.get(m.params.job);
        if (!j) seen.wrongSlot++;
        else seen.bySlot[j.slot]++;
        if (j && m.params.echo?.e !== j.id) seen.badEcho++;
        const ok = j && /^[0-9a-f]{8}$/.test(m.params.nonce) && verify(j, m.params.nonce);
        if (ok) seen.verified++;
        sock.write(JSON.stringify({ id: m.id, result: { ok: !!ok }, error: ok ? null : 'low difficulty' }) + '\n');
      } else if (m.method === 'glados.work') {
        seen.workAsks++;
        sock.write(jobMsg(makeJob(m.params.slot, m.params.slot === 1 ? YES : SHA)));
      }
    }
  });
  sock.on('error', () => {});
});
await new Promise((r) => pool.listen(POOL_PORT, '127.0.0.1', r));

// ------------------------------------------------------- bridge and the site
const children = [];
const run = (cmd, args) => {
  const c = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  c.stderr.on('data', (d) => process.env.E2E_VERBOSE && process.stderr.write('[' + path.basename(cmd) + '] ' + d));
  children.push(c);
  return c;
};
const bridgeBin = path.join(ROOT, 'bridge/target/release/glados-bridge');
run(bridgeBin, ['--listen', `127.0.0.1:${BRIDGE_PORT}`, '--pool', `127.0.0.1:${POOL_PORT}`, '--origin', `http://127.0.0.1:${SITE_PORT}`]);
run('python3', ['-m', 'http.server', String(SITE_PORT), '--bind', '127.0.0.1', '--directory', ROOT]);
await new Promise((r) => setTimeout(r, 1200));

// --------------------------------------------------------------- the browser
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || undefined, args: ['--enable-unsafe-webgpu'] });
const page = await browser.newPage();
const consoleErrors = [];
page.on('pageerror', (e) => consoleErrors.push(String(e)));
page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text() + ' ' + (m.location()?.url || '')));
await page.goto(`http://127.0.0.1:${SITE_PORT}/mine/?bridge=ws://127.0.0.1:${BRIDGE_PORT}`);
await page.waitForFunction(() => !document.getElementById('hw').textContent.startsWith('Reading'));
const hwLine = await page.textContent('#hw');
console.log('     ' + hwLine);

claim(seen.hello === null, 'nothing connects before start is pressed');
await page.fill('#addr', ADDRESS);
await page.click('#go');
await page.waitForTimeout(15000);

const accepted = Number(await page.textContent('#s-acc'));
const rejected = Number(await page.textContent('#s-rej'));
const rate = `CPU ${await page.textContent('#s-cpu')}, GPU ${await page.textContent('#s-gpu')}`;
const slots = await page.textContent('#s-slots');
console.log(`     page: ${rate}, ${accepted} accepted, ${rejected} rejected; ${slots}`);

const disconnects = await page.evaluate(() => [...document.querySelectorAll('#log div')].filter((d) => d.textContent.includes('disconnected')).length);
claim(disconnects === 0, `the page paces its submits and the bridge never cut it off (${disconnects} disconnects)`);
claim(seen.hello?.worker === ADDRESS, 'the hello carries the payout address as the worker');
claim(accepted >= 3, `the browser found and the pool accepted shares (${accepted})`);
claim(seen.verified === seen.submits && seen.submits > 0, `every submitted share meets its target on recompute (${seen.verified}/${seen.submits})`);
claim(rejected === 0, 'the page reports no rejections');
claim(seen.wrongSlot === 0, 'every share names a job the pool issued');
const gpu = /WebGPU (?!not)/.test(hwLine);
claim(seen.bySlot[1] > 0, `the CPU mined the yespower slot (${seen.bySlot[1]} shares)`);
if (gpu) claim(seen.bySlot[2] > 0, `the GPU mined the ${GPU_ALGO} slot at the same time (${seen.bySlot[2]} shares)`);
else claim(seen.bySlot[2] === 0, 'with no WebGPU, nothing was submitted for the GPU-class slot');
claim(seen.badEcho === 0, 'echo travels back verbatim');
claim(/CPU: testzeny/.test(slots) && (gpu ? /GPU: testbtc/.test(slots) : !/testbtc/.test(slots)), 'the page says which job each device is working');
claim(consoleErrors.length === 0, `no page errors${consoleErrors.length ? ': ' + consoleErrors[0] : ''}`);

await page.click('#go');
await page.waitForTimeout(500);
const after = seen.submits;
await page.waitForTimeout(3000);
claim(seen.submits === after, 'stop stops: no submits after it');

// A foreign origin must not get through the bridge to the pool.
const helloBefore = seen.hello;
seen.hello = null;
const foreign = await browser.newPage();
await foreign.goto('about:blank');
const refused = await foreign.evaluate(
  (u) => new Promise((r) => { const w = new WebSocket(u); w.onopen = () => r(false); w.onerror = () => r(true); }),
  `ws://127.0.0.1:${BRIDGE_PORT}`,
);
claim(refused && seen.hello === null, 'a page from another origin is refused by the bridge');
seen.hello = helloBefore;

await browser.close();
for (const c of children) c.kill();
pool.close();
const failed = claims.filter((c) => !c.ok).length;
console.log(`${claims.length - failed} of ${claims.length} claims hold`);
process.exit(failed ? 1 : 0);
