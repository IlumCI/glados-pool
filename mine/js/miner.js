// The controller: one socket to the bridge, a pool of CPU workers, and the
// bookkeeping between them. Owns no DOM; the page subscribes to `on`.

import * as P from './proto.js';

const AGENT = 'glados-web/0.1';

export class Miner {
  constructor({ bridge, wasm, threads }) {
    this.bridge = bridge;
    this.wasm = wasm;
    this.threads = threads;
    this.listeners = new Set();
    this.reset();
  }

  reset() {
    this.ws = null;
    this.running = false;
    this.workers = []; // { w, ready, key, slot }
    this.jobs = new Map(); // slot -> parsed job
    this.exhausted = new Map(); // job key -> workers done
    this.pending = new Map(); // submit id -> nonce
    this.nextId = 2;
    this.retry = 1000;
    this.stats = { hashes: 0, rate: 0, found: 0, accepted: 0, rejected: 0, bad: 0, slots: [] };
    this.window = { hashes: 0, t: performance.now() };
  }

  on(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  emit(kind, data) {
    for (const fn of this.listeners) fn(kind, data);
  }
  log(text, level = 'info') {
    this.emit('log', { t: Date.now(), text, level });
  }

  async start(worker, duty) {
    if (this.running) return;
    if (!P.isAddress(worker)) throw new Error('a 0x address is needed: shares are credited to it');
    this.worker = worker;
    this.duty = duty;
    this.running = true;
    for (let i = 0; i < this.threads; i++) {
      const w = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
      const slot = { w, ready: false, key: null, slot: null };
      w.onmessage = (e) => this.fromWorker(slot, e.data);
      w.postMessage({ type: 'init', wasm: this.wasm });
      this.workers.push(slot);
    }
    this.tick = setInterval(() => this.sample(), 1000);
    this.connect();
    this.log(`${this.threads} CPU thread(s), ${this.wasm.includes('simd') ? 'SIMD' : 'baseline'} build`);
  }

  stop() {
    if (!this.running) return;
    clearInterval(this.tick);
    clearTimeout(this.reconnect);
    for (const s of this.workers) s.w.terminate();
    if (this.ws) this.ws.close();
    const keep = this.listeners;
    this.reset();
    this.listeners = keep;
    this.log('stopped');
    this.emit('stats', this.stats);
  }

  setDuty(d) {
    this.duty = d;
    for (const s of this.workers) s.w.postMessage({ type: 'duty', duty: d });
  }

  connect() {
    if (!this.running) return;
    this.log(`connecting to ${this.bridge}`);
    const ws = new WebSocket(this.bridge);
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 1000;
      ws.send(P.hello(1, this.worker, AGENT));
    };
    ws.onmessage = (e) => this.fromPool(e.data);
    ws.onclose = (e) => {
      if (this.ws !== ws || !this.running) return;
      this.log(`disconnected${e.reason ? ': ' + e.reason : ''}, retrying in ${this.retry / 1000} s`, 'warn');
      this.jobs.clear();
      this.plan();
      this.reconnect = setTimeout(() => this.connect(), this.retry);
      this.retry = Math.min(this.retry * 2, 60_000);
    };
  }

  send(text) {
    if (this.ws && this.ws.readyState === 1) this.ws.send(text);
  }

  fromPool(text) {
    let m;
    try {
      m = JSON.parse(text);
    } catch {
      return this.log('pool sent something that is not JSON', 'warn');
    }
    if (m.method === 'glados.job') {
      const j = P.parseJob(m.params);
      if (j.error) return this.log('refused a job: ' + j.error, 'warn');
      this.jobs.set(j.slot, j);
      this.plan();
      return;
    }
    if (m.id === 1) {
      if (m.error) {
        // The pool's own words: a refused greeting says why.
        this.log('refused by the pool: ' + (typeof m.error === 'string' ? m.error : JSON.stringify(m.error)), 'err');
        return this.stop();
      }
      this.log(`connected, session ${m.result?.session ?? '?'}`);
      return;
    }
    if (this.pending.has(m.id)) {
      const nonce = this.pending.get(m.id);
      this.pending.delete(m.id);
      if (m.result?.ok) {
        this.stats.accepted++;
        this.log(`share ${P.nonceHex(nonce)} accepted`);
      } else {
        this.stats.rejected++;
        const why = m.error || m.result?.reason || 'rejected';
        this.log(`share ${P.nonceHex(nonce)}: ${typeof why === 'string' ? why : JSON.stringify(why)}`, 'warn');
      }
      this.emit('stats', this.stats);
    }
  }

  /** Put every worker on the CPU-class job it should be working, if any. */
  plan() {
    const cpu = [...this.jobs.values()].filter((j) => j.cls === 'cpu' && j.algo);
    if (!cpu.length && this.jobs.size) {
      const names = [...new Set([...this.jobs.values()].map((j) => j.name))].join(', ');
      this.log(`no CPU job on offer (pool is sending ${names}); waiting`, 'warn');
    }
    const per = P.assign(this.workers.length, cpu.map((j) => j.slot));
    let w = 0;
    for (const j of cpu) {
      const k = per.get(j.slot);
      const key = j.slot + ':' + j.job;
      const rs = P.ranges(k);
      for (let i = 0; i < k; i++, w++) {
        const s = this.workers[w];
        if (s.key === key) continue;
        s.key = key;
        s.slot = j.slot;
        this.post(s, { type: 'job', key, ...this.wire(j), ...rs[i] });
      }
    }
    for (; w < this.workers.length; w++) {
      const s = this.workers[w];
      if (s.key) this.post(s, { type: 'stop' });
      s.key = s.slot = null;
    }
    this.stats.slots = cpu.map((j) => `${j.coin || 'slot ' + j.slot} (${j.name} N=${j.algo.n} r=${j.algo.r})`);
    this.emit('stats', this.stats);
  }

  wire(j) {
    const a = j.algo;
    return { header: j.header, target: j.target, algo: a.id, v10: a.v10, n: a.n, r: a.r, pers: a.pers };
  }

  post(s, msg) {
    if (s.ready) s.w.postMessage(msg);
    else s.queued = msg; // delivered once its wasm is loaded
  }

  fromWorker(s, m) {
    if (m.type === 'ready') {
      s.ready = true;
      s.w.postMessage({ type: 'duty', duty: this.duty });
      if (s.queued) s.w.postMessage(s.queued);
      s.queued = null;
    } else if (m.type === 'progress') {
      this.window.hashes += m.hashes;
      this.stats.hashes += m.hashes;
      for (const f of m.found) this.share(m.key, f.nonce);
    } else if (m.type === 'exhausted') {
      // Every worker on this job has searched its whole range: ask for fresh
      // work for the slot rather than rescanning nonces already searched.
      const n = (this.exhausted.get(m.key) || 0) + 1;
      this.exhausted.set(m.key, n);
      const slot = Number(m.key.split(':')[0]);
      const k = this.workers.filter((w) => w.key === m.key).length;
      if (n >= k) {
        this.send(P.work(this.nextId++, slot));
        this.exhausted.delete(m.key);
      }
    } else if (m.type === 'bad') {
      this.stats.bad++;
      this.log(`hash core and re-check disagree on ${P.nonceHex(m.nonce)}; dropped`, 'err');
    } else if (m.type === 'refused') {
      this.log('this build refused the job parameters', 'err');
    }
  }

  share(key, nonce) {
    const [slot, id] = [Number(key.split(':')[0]), key.slice(key.indexOf(':') + 1)];
    const j = this.jobs.get(slot);
    // A share for a job the pool has replaced is stale; it would only be refused.
    if (!j || j.job !== id) return;
    this.stats.found++;
    const sid = this.nextId++;
    this.pending.set(sid, nonce);
    this.send(P.submit(sid, j.job, nonce, j.echo));
  }

  sample() {
    const now = performance.now();
    const r = (this.window.hashes * 1000) / Math.max(1, now - this.window.t);
    this.window = { hashes: 0, t: now };
    this.stats.rate = this.stats.rate ? this.stats.rate * 0.7 + r * 0.3 : r;
    this.emit('stats', this.stats);
  }
}
