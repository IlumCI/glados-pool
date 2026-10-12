// The controller, without a browser: fake workers and a fake socket, so the
// paths a real run cannot reach in reasonable time are driven directly --
// exhausting a job's nonce space, a worker crashing, reassignment, pacing.
//
//   node --test web/e2e/miner.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';

const posted = []; // every message any fake worker received
class FakeWorker {
  static all = [];
  constructor(url) {
    this.url = String(url);
    this.kind = this.url.includes('gpu') ? 'gpu' : 'cpu';
    this.got = [];
    this.terminated = false;
    FakeWorker.all.push(this);
  }
  postMessage(m) {
    this.got.push(m);
    posted.push({ w: this, m });
    if (m.type === 'init') queueMicrotask(() => this.onmessage({ data: { type: 'ready' } }));
  }
  terminate() { this.terminated = true; }
  emit(data) { this.onmessage({ data }); }
  lastJob() { return [...this.got].reverse().find((m) => m.type === 'job' || m.type === 'stop'); }
}
class FakeSocket {
  static last = null;
  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.sent = [];
    FakeSocket.last = this;
    queueMicrotask(() => { this.readyState = 1; this.onopen?.(); });
  }
  send(t) { this.sent.push(JSON.parse(t)); }
  close() { this.readyState = 3; }
  serverSays(obj) { this.onmessage({ data: JSON.stringify(obj) }); }
  drop() { this.readyState = 3; this.onclose({ reason: 'test' }); }
}
globalThis.Worker = FakeWorker;
globalThis.WebSocket = FakeSocket;

const { Miner } = await import('../../mine/js/miner.js');
const tick = () => new Promise((r) => setTimeout(r, 0));
const ADDR = '0x' + 'ab'.repeat(20);
const jobMsg = (slot, job, name, extra = {}) => ({
  method: 'glados.job',
  params: { slot, job, header: '00'.repeat(80), target: 'ff'.repeat(32), algo: name === 'yespower' ? { name, v10: true, n: 2048, r: 8 } : { name }, ...extra },
});

// Every miner a test starts is stopped afterwards whether or not the test
// passed: a failed assertion that skipped m.stop() left its timers running
// and hung the runner instead of reporting the failure.
const live = new Set();
test.afterEach(() => {
  for (const m of live) m.stop();
  live.clear();
});

async function started(threads = 3, gpu = true) {
  FakeWorker.all = [];
  const m = new Miner({ bridge: 'ws://127.0.0.1:1', wasm: 'x.wasm', threads, gpu });
  const logs = [];
  m.on((k, d) => k === 'log' && logs.push(d.text));
  await m.start(ADDR, 1);
  live.add(m);
  await tick();
  FakeSocket.last.serverSays({ id: 1, result: { session: 's' }, error: null });
  return { m, ws: FakeSocket.last, logs };
}

test('CPU workers split one job into disjoint ranges covering 2^32', async () => {
  const { m, ws } = await started(3);
  ws.serverSays(jobMsg(1, 'a', 'yespower'));
  const jobs = m.workers.map((s) => s.w.lastJob());
  assert.ok(jobs.every((j) => j.type === 'job' && j.key === '1:a'));
  const r = jobs.map((j) => [j.start, j.end]).sort((x, y) => x[0] - y[0]);
  assert.equal(r[0][0], 0);
  assert.equal(r[2][1], 2 ** 32);
  assert.equal(r[1][0], r[0][1]);
  m.stop();
});

test('work is asked for only once every CPU worker has spent its range', async () => {
  const { m, ws } = await started(3);
  ws.serverSays(jobMsg(1, 'a', 'yespower'));
  const asks = () => ws.sent.filter((x) => x.method === 'glados.work').length;
  m.workers[0].w.emit({ type: 'exhausted', key: '1:a' });
  m.workers[1].w.emit({ type: 'exhausted', key: '1:a' });
  assert.equal(asks(), 0, 'two of three done is not done');
  m.workers[2].w.emit({ type: 'exhausted', key: '1:a' });
  assert.equal(asks(), 1);
  assert.deepEqual(ws.sent.at(-1).params, { slot: 1 });
  m.stop();
});

test('a reassignment mid-job restarts the exhausted count instead of over-counting', async () => {
  const { m, ws } = await started(4);
  ws.serverSays(jobMsg(1, 'a', 'yespower'));
  m.workers[0].w.emit({ type: 'exhausted', key: '1:a' });
  m.workers[1].w.emit({ type: 'exhausted', key: '1:a' });
  // A second CPU slot arrives: the four workers split two and two.
  ws.serverSays(jobMsg(2, 'b', 'yespower'));
  const onA = m.workers.filter((s) => s.key === '1:a').length;
  assert.equal(onA, 2);
  // The two exhaustions from the old four-way split must not count toward
  // the new two-way one: one more report is not "both done".
  const asks = () => ws.sent.filter((x) => x.method === 'glados.work').length;
  m.workers.find((s) => s.key === '1:a').w.emit({ type: 'exhausted', key: '1:a' });
  assert.equal(asks(), 0);
  m.stop();
});

test('the GPU takes a GPU-class job, moves on when it is spent, and asks for more', async () => {
  const { m, ws } = await started(2);
  ws.serverSays(jobMsg(1, 'y', 'yespower'));
  ws.serverSays(jobMsg(2, 's', 'sha256d'));
  ws.serverSays(jobMsg(3, 'n', 'neoscrypt'));
  assert.equal(m.gpu.w.lastJob().key, '2:s', 'lowest GPU slot first');
  assert.ok(m.workers.every((s) => s.key === '1:y'), 'CPU stays on CPU work');
  m.gpu.w.emit({ type: 'exhausted', key: '2:s' });
  assert.deepEqual(ws.sent.at(-1), { id: ws.sent.at(-1).id, method: 'glados.work', params: { slot: 2 } });
  assert.equal(m.gpu.w.lastJob().key, '3:n', 'moves to the next unspent GPU job');
  ws.serverSays(jobMsg(2, 's2', 'sha256d'));
  assert.equal(m.gpu.w.lastJob().key, '2:s2', 'fresh work for the lower slot is taken up');
  m.stop();
});

test('a crashed worker is replaced and put back to work, a bounded number of times', async () => {
  const { m, ws, logs } = await started(2, false);
  ws.serverSays(jobMsg(1, 'a', 'yespower'));
  for (let i = 0; i < 4; i++) {
    const s = m.workers[0];
    s.w.onerror({ message: 'RuntimeError: unreachable', preventDefault() {} });
    await tick();
    if (i < 3) {
      assert.notEqual(m.workers[0], s, 'replaced');
      assert.ok(s.w.terminated);
      assert.equal(m.workers[0].w.lastJob()?.key, '1:a', 'and given the job again');
    }
  }
  assert.equal(logs.filter((l) => /restarting/.test(l)).length, 3);
  assert.equal(logs.filter((l) => /giving up/.test(l)).length, 1);
  m.stop();
});

test('shares are paced, stale ones dropped, and a dropped socket forgets in-flight submits', async () => {
  const { m, ws } = await started(1, false);
  ws.serverSays(jobMsg(1, 'a', 'yespower'));
  const found = Array.from({ length: 50 }, (_, i) => ({ nonce: i, digest: '' }));
  m.workers[0].w.emit({ type: 'progress', key: '1:a', hashes: 1, found });
  m.drain();
  const submits = () => ws.sent.filter((x) => x.method === 'glados.submit').length;
  assert.equal(submits(), 30, 'one burst, not all fifty');
  ws.serverSays(jobMsg(1, 'b', 'yespower')); // the job is replaced
  m.pacer.tokens = 30;
  m.drain();
  assert.equal(submits(), 30, 'the twenty left were for a replaced job and are not sent');
  assert.ok(m.pending.size > 0);
  ws.drop();
  assert.equal(m.pending.size, 0);
  m.stop();
});

test('a job the page cannot run safely is refused and leaves workers on safe work', async () => {
  const { m, ws, logs } = await started(2, false);
  ws.serverSays(jobMsg(1, 'a', 'yespower'));
  ws.serverSays({ method: 'glados.job', params: { slot: 1, job: 'huge', header: '00'.repeat(80), target: 'ff'.repeat(32), algo: { name: 'yespower', v10: true, n: 524288, r: 32 } } });
  assert.ok(logs.some((l) => /MiB of memory per thread/.test(l)));
  assert.ok(m.workers.every((s) => s.key === '1:a'), 'still on the job it had');
  m.stop();
});
