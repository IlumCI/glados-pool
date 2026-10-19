// The controller: one or two sockets to the pool, a pool of CPU workers, one
// GPU worker, and the bookkeeping between them. Owns no DOM; the page
// subscribes to `on`.
//
// **Why two sockets.** The edge-worker pool is single-slot (SWITCH): it serves
// CPU work at /mine and GPU work at a separate /mine/gpu, so to mine on both
// devices the browser holds a connection to each. A plain bridge (a local test,
// or ws.aperture.institute) is multi-slot on one URL, so there the GPU rides
// the one connection. The rule: if the endpoint path ends in /mine, open a
// second link to /mine/gpu for the GPU; otherwise one link carries everything.

import * as P from './proto.js';

const AGENT = 'glados-web/0.3';

// Submits per second, kept under the pool's per-connection bucket so a burst of
// shares queues here instead of getting the connection closed there.
const SUBMIT_RATE = 8;
const SUBMIT_BURST = 30;
const QUEUE_MAX = 256;
const RESPAWNS = 3; // per worker slot, so a worker that crashes on every job cannot loop

// The algorithms the GPU worker has kernels for (kernels.js).
const GPU_ALGOS = new Set(['sha256d', 'blake2s', 'neoscrypt', 'heavyhash']);

export class Miner {
  // gpuAlgo: 'neoscrypt' (the pool's GPU coins, /mine/gpu) or 'pearl' (/mine/pearl).
  constructor({ bridge, wasm, threads, gpu, gpuAlgo = 'neoscrypt' }) {
    this.bridge = bridge;
    this.wasm = wasm;
    this.threads = threads;
    this.useGpu = !!gpu;
    this.gpuAlgo = gpuAlgo;
    this.listeners = new Set();
    this.reset();
  }

  reset() {
    this.running = false;
    this.workers = []; // CPU: { w, ready, key, kind }
    this.gpu = null; // the one GPU worker, same shape
    this.spent = new Set(); // job keys whose whole nonce space the GPU searched
    this.jobs = new Map(); // "role:slot" -> parsed job (a new job on a slot replaces)
    this.exhausted = new Map(); // full job key -> workers done
    this.assigned = new Map(); // full job key -> CPU workers given a range of it
    this.nextId = 2;
    this.links = []; // the open connections; links[0] is the CPU/primary one
    this.cpuLink = null;
    this.gpuLink = null; // the GPU's own connection, or null when it shares the CPU link
    this.stats = { hashes: 0, rate: 0, cpuRate: 0, gpuRate: 0, found: 0, accepted: 0, rejected: 0, bad: 0, slots: [] };
    this.window = { cpu: 0, gpu: 0, t: performance.now() };
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

  makeLink(role, url) {
    return { role, url, ws: null, pending: new Map(), queue: [], pacer: new P.Pacer(SUBMIT_RATE, SUBMIT_BURST), retry: 1000, reconnect: null };
  }

  async start(worker, duty, reward) {
    if (this.running) return;
    if (!P.isAddress(worker)) throw new Error('a 0x address is needed: shares are credited to it');
    this.worker = worker;
    this.duty = duty;
    this.reward = reward || 'glados';
    this.running = true;
    // The links. A GPU link only when the endpoint is the edge worker's /mine,
    // whose GPU work lives at /mine/gpu; otherwise the one link carries both.
    this.cpuLink = this.makeLink('cpu', this.bridge);
    this.links = [this.cpuLink];
    // Pearl is the GPU's other choice: its own endpoint and worker, and a proof
    // per share rather than a nonce. It exists only on the edge pool.
    this.pearl = this.useGpu && this.gpuAlgo === 'pearl' && /\/mine$/.test(this.bridge);
    const gpuUrl = /\/mine$/.test(this.bridge) ? this.bridge + (this.pearl ? '/pearl' : '/gpu') : null;
    if (this.useGpu && gpuUrl) {
      this.gpuLink = this.makeLink(this.pearl ? 'pearl' : 'gpu', gpuUrl);
      this.links.push(this.gpuLink);
    }
    for (let i = 0; i < this.threads; i++) this.workers.push(this.spawn('./worker.js', 'cpu'));
    if (this.useGpu) this.gpu = this.spawn(this.pearl ? './pearl-worker.js' : './gpu-worker.js', 'gpu');
    this.tick = setInterval(() => this.sample(), 1000);
    this.drainer = setInterval(() => this.drain(), 1000 / SUBMIT_RATE);
    // Report this device's hashrate so the pool can show the combined figure.
    // On its own socket per device, so the pool's cross-shard sum is the total.
    this.rateTimer = setInterval(() => this.reportRates(), 10_000);
    for (const link of this.links) this.connect(link);
    this.log(`${this.threads} CPU thread(s), ${this.wasm.includes('simd') ? 'SIMD' : 'baseline'} build${this.gpuLink ? '; GPU on a second connection' : ''}`);
  }

  spawn(file, kind, respawns = 0) {
    const w = new Worker(new URL(file, import.meta.url), { type: 'module' });
    const s = { w, ready: false, key: null, kind, file, respawns };
    w.onmessage = (e) => this.fromWorker(s, e.data);
    // A worker that throws or traps otherwise goes silent: its share of the
    // nonce space stops being searched and nothing on the page says so.
    w.onerror = (e) => {
      e.preventDefault?.();
      this.crashed(s, e.message || 'worker crashed');
    };
    w.onmessageerror = () => this.crashed(s, 'unreadable message from worker');
    w.postMessage({ type: 'init', wasm: this.wasm });
    return s;
  }

  crashed(s, why) {
    if (!this.running || s.dead) return;
    s.dead = true;
    s.w.terminate();
    const again = s.respawns < RESPAWNS;
    this.log(`${s.kind.toUpperCase()} worker crashed (${why})${again ? ', restarting it' : ', giving up on it'}`, 'err');
    if (!again) return;
    const fresh = this.spawn(s.file, s.kind, s.respawns + 1);
    if (s.kind === 'gpu') this.gpu = fresh;
    else this.workers[this.workers.indexOf(s)] = fresh;
    this.plan();
  }

  stop() {
    if (!this.running) return;
    clearInterval(this.tick);
    clearInterval(this.drainer);
    clearInterval(this.rateTimer);
    for (const link of this.links) {
      clearTimeout(link.reconnect);
      if (link.ws) link.ws.close();
    }
    for (const s of this.workers) s.w.terminate();
    if (this.gpu) this.gpu.w.terminate();
    const keep = this.listeners;
    this.reset();
    this.listeners = keep;
    this.log('stopped');
    this.emit('stats', this.stats);
  }

  setDuty(d) {
    this.duty = d;
    for (const s of this.all()) s.w.postMessage({ type: 'duty', duty: d });
  }

  connect(link) {
    if (!this.running) return;
    this.log(`connecting to ${link.url}`);
    const ws = new WebSocket(link.url);
    link.ws = ws;
    ws.onopen = () => {
      link.retry = 1000;
      this.emit('link', { role: link.role, up: true });
      ws.send(P.hello(1, this.worker, AGENT, this.reward));
    };
    ws.onmessage = (e) => this.fromPool(link, e.data);
    ws.onclose = (e) => {
      if (link.ws !== ws || !this.running) return;
      this.stats.disconnects = (this.stats.disconnects || 0) + 1;
      this.emit('link', { role: link.role, up: false, reason: e.reason || '' });
      this.log(`disconnected from ${link.role}${e.reason ? ': ' + e.reason : ''}, retrying in ${link.retry / 1000} s`, 'warn');
      // Drop this link's jobs and in-flight submits; they will never be answered.
      for (const [k, j] of this.jobs) if (j.link === link) this.jobs.delete(k);
      link.pending.clear();
      link.queue.length = 0;
      this.plan();
      // Jittered, so every page does not come back in the same second.
      link.reconnect = setTimeout(() => this.connect(link), link.retry * (0.5 + Math.random()));
      link.retry = Math.min(link.retry * 2, 60_000);
    };
  }

  all() {
    return this.gpu ? [...this.workers, this.gpu] : this.workers;
  }

  // The link a given role's traffic belongs on, with the CPU link as the default
  // (which is where everything rides when there is no separate GPU link).
  linkFor(role) {
    return (role === 'gpu' && this.gpuLink) || this.cpuLink;
  }

  fromPool(link, text) {
    let m;
    try {
      m = JSON.parse(text);
    } catch {
      return this.log('pool sent something that is not JSON', 'warn');
    }
    if (!m || typeof m !== 'object') return this.log('pool sent JSON that is not a message', 'warn');
    if (m.method === 'glados.job') {
      const j = P.parseJob(m.params);
      if (j.error) return this.log('refused a job: ' + j.error, 'warn');
      j.link = link;
      j.full = `${link.role}:${j.slot}:${j.job}`;
      this.jobs.set(`${link.role}:${j.slot}`, j);
      this.plan();
      return;
    }
    if (m.method === 'glados.pearl.job') {
      const p = m.params || {};
      if (!/^[0-9a-fA-F]{152}$/.test(p.header || '') || !Number.isInteger(p.bits)) return this.log('refused a Pearl job this page cannot read', 'warn');
      if (this.gpu && !this.gpu.dead) this.post(this.gpu, { type: 'pearljob', job: p.job, header: p.header, bits: p.bits });
      this.pearlJob = true;
      this.plan();
      return;
    }
    if (m.method === 'glados.earn') {
      // The pool's figure for this worker, valued in the asset it credits. A
      // malformed one is ignored, leaving the last good value on the page.
      const e = P.parseEarn(m.params);
      if (e) {
        this.stats.revenue = e.value;
        this.stats.asset = e.asset;
        if (e.usd !== undefined) this.stats.usd = e.usd;
        // Payout facts, when the pool sends them; left as-is otherwise so a
        // message without them never erases what the page already shows.
        if (e.recipients !== undefined) this.stats.recipients = e.recipients;
        if (e.epochMs !== undefined) this.stats.epochMs = e.epochMs;
        if (e.lastAt !== undefined) this.stats.lastAt = e.lastAt;
        this.emit('stats', this.stats);
      }
      return;
    }
    if (m.id === 1) {
      if (m.error) {
        // The pool's own words: a refused greeting says why. Only the CPU link
        // refusing stops everything; a GPU link refused leaves CPU mining.
        this.log(`refused by the pool (${link.role}): ` + (typeof m.error === 'string' ? m.error : JSON.stringify(m.error)), 'err');
        if (link === this.cpuLink) return this.stop();
        return;
      }
      this.log(`connected to ${link.role}, session ${m.result?.session ?? '?'}`);
      return;
    }
    if (link.pending.has(m.id)) {
      const nonce = link.pending.get(m.id);
      link.pending.delete(m.id);
      const what = nonce === 'pearl' ? 'Pearl share' : `share ${P.nonceHex(nonce)}`;
      if (m.result?.ok) {
        this.stats.accepted++;
        this.log(`${what} accepted`);
      } else {
        this.stats.rejected++;
        const why = m.error || m.result?.reason || m.result?.why || m.result?.verdict || 'rejected';
        this.log(`${what}: ${typeof why === 'string' ? why : JSON.stringify(why)}`, 'warn');
      }
      this.emit('stats', this.stats);
    }
  }

  /** Put every worker on the job it should be working, if any. */
  plan() {
    const all = [...this.jobs.values()];
    const cpu = all.filter((j) => j.cls === 'cpu' && j.algo);
    if (!cpu.length && this.jobs.size && !this.warnedCpu) {
      const names = [...new Set(all.map((j) => j.name))].join(', ');
      this.log(`no CPU job on offer (pool is sending ${names}); CPU idle`, 'warn');
      this.warnedCpu = true;
    }
    if (cpu.length) this.warnedCpu = false;
    const gpuJob = this.planGpu();
    const per = P.assign(this.workers.length, cpu.map((j) => j.full));
    let w = 0;
    for (const j of cpu) {
      const k = per.get(j.full);
      const rs = P.ranges(k);
      if (this.assigned.get(j.full) !== k) {
        // A different split of this job means different ranges: what the
        // workers had covered no longer adds up, so the count starts again.
        this.assigned.set(j.full, k);
        this.exhausted.delete(j.full);
        for (let i = 0; i < k; i++) this.workers[w + i].key = null;
      }
      for (let i = 0; i < k; i++, w++) {
        const s = this.workers[w];
        if (s.key === j.full || s.dead) continue;
        s.key = j.full;
        this.post(s, { type: 'job', key: j.full, ...this.wire(j), ...rs[i] });
      }
    }
    for (; w < this.workers.length; w++) {
      const s = this.workers[w];
      if (s.key) this.post(s, { type: 'stop' });
      s.key = null;
    }
    // Per device, the algorithm being worked -- not the coin it is sold as.
    this.stats.slots = cpu.map((j) => ({ dev: 'CPU', algo: j.name }));
    if (gpuJob) this.stats.slots.push({ dev: 'GPU', algo: gpuJob.name });
    else if (this.pearl && this.pearlJob && this.gpu && !this.gpu.dead) this.stats.slots.push({ dev: 'GPU', algo: 'pearl' });
    this.emit('stats', this.stats);
  }

  /**
   * The GPU works one GPU-class job at a time, the lowest whose nonce space it
   * has not already spent; spending one asks the pool for fresh work and moves
   * on, so a fast card is never idle and never rescans.
   */
  planGpu() {
    const s = this.gpu;
    if (!s || s.dead) return null;
    const j = [...this.jobs.values()]
      .filter((j) => j.cls === 'gpu' && GPU_ALGOS.has(j.name) && !this.spent.has(j.full))
      .sort((a, b) => a.slot - b.slot)[0];
    if (!j) {
      if (s.key) this.post(s, { type: 'stop' });
      s.key = null;
      return null;
    }
    if (s.key !== j.full) {
      s.key = j.full;
      this.post(s, { type: 'job', key: j.full, name: j.name, ...this.wire(j), start: 0, end: 2 ** 32 });
    }
    return j;
  }

  wire(j) {
    const a = j.algo;
    return { header: j.header, target: j.target, algo: a.id, v10: a.v10, n: a.n, r: a.r, pers: a.pers };
  }

  post(s, msg) {
    if (s.ready) s.w.postMessage(msg);
    else s.queued = msg; // delivered once its wasm is loaded
  }

  // The job a worker's key names, if the pool still holds it, else null.
  jobOf(key) {
    const i = key.indexOf(':', key.indexOf(':') + 1); // past "role:slot"
    const j = this.jobs.get(key.slice(0, i));
    return j && j.full === key ? j : null;
  }

  fromWorker(s, m) {
    if (m.type === 'ready') {
      s.ready = true;
      s.w.postMessage({ type: 'duty', duty: this.duty });
      if (s.queued) s.w.postMessage(s.queued);
      s.queued = null;
    } else if (m.type === 'progress') {
      this.window[s.kind] += m.hashes;
      this.stats.hashes += m.hashes;
      for (const f of m.found) this.share(m.key, f.nonce);
    } else if (m.type === 'exhausted') {
      // Every worker on this job has searched its whole range: ask for fresh
      // work rather than rescanning nonces already searched.
      const n = (this.exhausted.get(m.key) || 0) + 1;
      this.exhausted.set(m.key, n);
      const [role, slot] = m.key.split(':');
      const link = this.linkFor(role);
      if (s.kind === 'gpu') {
        this.spent.add(m.key);
        s.key = null;
        this.sendOn(link, P.work(this.nextId++, Number(slot)));
        this.planGpu();
        return;
      }
      const k = this.assigned.get(m.key) || 1;
      if (n >= k) {
        this.sendOn(link, P.work(this.nextId++, Number(slot)));
        this.exhausted.delete(m.key);
      }
    } else if (m.type === 'pearlshare') {
      // A Pearl share is a ~90 KB proof and comes a few a minute at most, so it
      // goes straight out rather than through the nonce queue's pacer.
      this.stats.found++;
      const sid = this.nextId++;
      this.gpuLink.pending.set(sid, 'pearl');
      this.sendOn(this.gpuLink, JSON.stringify({ id: sid, method: 'glados.pearl.submit', params: { job: m.job, proof: m.proof } }) + '\n');
    } else if (m.type === 'bad') {
      this.stats.bad++;
      this.log(`hash core and re-check disagree on ${P.nonceHex(m.nonce)}; dropped`, 'err');
    } else if (m.type === 'error' && s.kind === 'cpu') {
      // A CPU worker reporting its own failure (a wasm trap) is a crash.
      this.crashed(s, m.text);
    } else if (m.type === 'lost' || m.type === 'error') {
      // The GPU is gone or cannot run this; the CPU path does not depend on it.
      if (s.kind === 'gpu') s.dead = true;
      this.log(`GPU ${m.type === 'lost' ? 'device lost' : 'error'}: ${m.text}; CPU mining continues`, 'err');
    } else if (m.type === 'overflow') {
      this.log(`GPU found ${m.hits} hits in one dispatch, more than it can return; dispatch shrunk`, 'warn');
    } else if (m.type === 'refused') {
      this.log('this build refused the job parameters', 'err');
    }
  }

  share(key, nonce) {
    const j = this.jobOf(key);
    // A share for a job the pool has replaced is stale; it would only be refused.
    if (!j) return;
    this.stats.found++;
    const q = j.link.queue;
    if (q.length >= QUEUE_MAX) {
      q.shift();
      this.stats.dropped = (this.stats.dropped || 0) + 1;
    }
    q.push({ key, nonce });
  }

  sendOn(link, text) {
    if (link && link.ws && link.ws.readyState === 1) link.ws.send(text);
  }

  /**
   * Send what each link's pacer allows, skipping shares whose job has been
   * replaced. Tokens accrue by elapsed time, so a tick delayed by a hidden tab
   * sends the backlog it owes rather than one share.
   */
  drain() {
    const now = performance.now();
    for (const link of this.links) {
      if (!link.ws || link.ws.readyState !== 1 || !link.queue.length) continue;
      let n = link.pacer.take(now);
      while (n > 0 && link.queue.length) {
        const item = link.queue.shift();
        const j = this.jobOf(item.key);
        if (!j) continue; // stale now; it would only be refused
        const sid = this.nextId++;
        link.pending.set(sid, item.nonce);
        link.ws.send(P.submit(sid, j.job, item.nonce, j.echo));
        n--;
      }
      link.pacer.refund(n);
    }
  }

  sample() {
    const now = performance.now();
    const dt = Math.max(1, now - this.window.t);
    const ewma = (old, r) => (old ? old * 0.7 + r * 0.3 : r);
    this.stats.cpuRate = ewma(this.stats.cpuRate, (this.window.cpu * 1000) / dt);
    this.stats.gpuRate = ewma(this.stats.gpuRate, (this.window.gpu * 1000) / dt);
    this.stats.rate = this.stats.cpuRate + this.stats.gpuRate;
    this.window = { cpu: 0, gpu: 0, t: now };
    this.emit('stats', this.stats);
  }

  // Tell the pool this device's hashrate, for the combined-pool figure. Each
  // link reports only its own device's rate; when the GPU shares the CPU link,
  // the CPU link reports the sum. A display number, not mining work.
  reportRates() {
    if (!this.running) return;
    const msg = (hs) => JSON.stringify({ method: 'glados.rate', params: { hs: Math.max(0, Math.round(hs)) } }) + '\n';
    if (this.gpuLink) {
      this.sendOn(this.cpuLink, msg(this.stats.cpuRate));
      this.sendOn(this.gpuLink, msg(this.stats.gpuRate));
    } else {
      this.sendOn(this.cpuLink, msg(this.stats.cpuRate + this.stats.gpuRate));
    }
  }
}
