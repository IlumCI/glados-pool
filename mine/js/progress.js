// Progress: the part a miner comes back for. It keeps a running, locally saved
// tally of what this wallet has done, and shows the earnings the POOL actually
// reports -- never an invented figure.
//
// The earnings number is the pool's own `glados.earn`: this wallet's equal
// share of the real pot, valued in the chosen asset (what it would be paid if a
// payout went out now). It is small, because the pool's income is small; that
// is the truth, and it is better than a number we cannot pay. The first version
// multiplied accepted shares by a made-up per-share rate, which showed tens of
// dollars of a stock over a day when the real figure was a few millionths of a
// share -- a number that reads as a scam the moment a payout does not match it.
//
// Shares, hashes and time are exactly what the miner reported, and carry the
// sense of progress. Saved per wallet and asset. Key bumped to v2 so the old,
// inflated lines are dropped rather than shown.

const KEY = 'glados.progress.v2';
const CAP = 160; // points kept for the chart

const now = () => Date.now();
const keyFor = (addr, asset) => `${KEY}.${(addr || 'anon').toLowerCase()}.${asset || 'glados'}`;

function load(addr, asset) {
  try {
    const raw = localStorage.getItem(keyFor(addr, asset));
    if (raw) {
      const r = JSON.parse(raw);
      if (r && typeof r === 'object') return normalize(r);
    }
  } catch {}
  return normalize({});
}
function normalize(r) {
  return {
    est: Number(r.est) || 0,
    shares: Number(r.shares) || 0,
    hashes: Number(r.hashes) || 0,
    seconds: Number(r.seconds) || 0,
    rate: Number(r.rate) || 0, // learned per-share rate, 0 until known
    series: Array.isArray(r.series) ? r.series.filter((p) => p && isFinite(p.t) && isFinite(p.v)).slice(-CAP) : [],
  };
}

// A number formatted with more decimals the smaller it is, so a fraction of a
// tokenised share still reads as a figure instead of rounding to zero.
function fmt(v) {
  const a = Math.abs(v);
  const d = a === 0 ? 2 : a >= 1000 ? 0 : a >= 1 ? 2 : a >= 0.01 ? 4 : a >= 0.0001 ? 6 : 8;
  return v.toLocaleString(undefined, { maximumFractionDigits: d });
}
function fmtInt(v) { return Math.round(v).toLocaleString(); }
function fmtDur(s) {
  s = Math.round(s);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 48 ? `${h}h ${m % 60}m` : `${Math.floor(h / 24)}d ${h % 24}h`;
}

// A green area chart from a series of {t, v}. Pure SVG string, scaled to its
// box; the line only rises because v is monotonic.
function areaSvg(series, h = 118) {
  const w = 320, pad = 6;
  const vals = series.map((p) => p.v);
  const pts = vals.length >= 2 ? vals : vals.length ? [vals[0], vals[0]] : [0, 0];
  const min = Math.min(...pts), max = Math.max(...pts), span = (max - min) || 1;
  const n = pts.length;
  const X = (i) => pad + (i / (n - 1)) * (w - 2 * pad);
  const Y = (v) => h - pad - ((v - min) / span) * (h - 2 * pad);
  let line = '';
  pts.forEach((v, i) => { line += `${i ? 'L' : 'M'}${X(i).toFixed(1)} ${Y(v).toFixed(1)} `; });
  const area = `${line}L${X(n - 1).toFixed(1)} ${h - pad} L${X(0).toFixed(1)} ${h - pad} Z`;
  const flat = max === min;
  return `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" width="100%" height="100%" aria-hidden="true">
    <defs><linearGradient id="pg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#27d87f" stop-opacity="0.42"/>
      <stop offset="1" stop-color="#27d87f" stop-opacity="0"/>
    </linearGradient></defs>
    <path d="${area}" fill="url(#pg)"/>
    <path d="${line}" fill="none" stroke="#2fe88a" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"${flat ? ' stroke-opacity="0.5"' : ''}/>
  </svg>`;
}

export class Progress {
  // els: { earn, earnCap, chart, shares, hashes, time }
  constructor(els) {
    this.els = els;
    this.addr = '';
    this.asset = 'glados';
    this.rec = normalize({});
    this.lastShares = 0; this.lastHashes = 0; this.lastTick = 0;
    this.lastPoint = 0; this.lastSave = 0;
    this.pool = ''; this.syncSeq = 0; this.lastPush = 0;
  }

  // The pool's HTTP base, so the line can sync across a wallet's devices. When
  // unset, progress stays local-only and everything else still works.
  setPool(url) { this.pool = url || ''; }

  // A real wallet (not the anonymous local line) is what we sync.
  syncable() { return this.pool && /^0x[0-9a-f]{40}$/i.test(this.addr); }

  // Merge the server's copy into ours. Only the cumulative work counters cross
  // devices (by maximum, so none lowers them). The earnings figure and its
  // chart are never taken from the server: they are the pool's live number for
  // this session, so a stale or (pre-v2) inflated stored est can never come
  // back through sync.
  mergeIn(s) {
    if (!s || typeof s !== 'object') return;
    this.rec.shares = Math.max(this.rec.shares, Number(s.shares) || 0);
    this.rec.hashes = Math.max(this.rec.hashes, Number(s.hashes) || 0);
    this.rec.seconds = Math.max(this.rec.seconds, Number(s.seconds) || 0);
  }

  // Fetch this wallet's saved line and fold it in. Guarded so a slow read for a
  // wallet we have since switched away from is dropped.
  async pull() {
    if (!this.syncable()) return;
    const seq = this.syncSeq;
    try {
      const r = await fetch(`${this.pool}/progress?address=${this.addr}&asset=${this.asset}`, { cache: 'no-store' });
      if (!r.ok) return;
      const { rec } = await r.json();
      if (seq !== this.syncSeq || !rec) return; // switched wallet/asset meanwhile
      this.mergeIn(rec);
      this.render();
      this.save(true, true); // persist the merged line locally, no second push
    } catch {}
  }

  // Send our line up, throttled. The server merges it by maximum, so this only
  // ever raises the shared line.
  async push() {
    if (!this.syncable()) return;
    const t = now();
    if (t - this.lastPush < 8000) return;
    this.lastPush = t;
    try {
      await fetch(`${this.pool}/progress?address=${this.addr}&asset=${this.asset}`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ rec: this.rec }), keepalive: true,
      });
    } catch {}
  }

  // Point at a wallet and asset: load its saved line and show it. Called when a
  // valid address is entered and when the payout asset changes.
  switchTo(addr, asset) {
    this.save(true); // flush the line we are leaving
    this.syncSeq++;
    this.addr = addr || this.addr;
    this.asset = asset || this.asset;
    this.rec = load(this.addr, this.asset);
    this.lastShares = 0; this.lastHashes = 0; this.lastTick = 0; this.lastPoint = 0;
    this.render();
    this.pull(); // fold in this wallet's saved line from the server, if any
  }

  setAsset(asset) { if (asset && asset !== this.asset) this.switchTo(this.addr, asset); }

  // Fold one stats frame into the running tally. `d` is the miner's stats; it
  // only grows the line while actually mining (shares or hashes advancing).
  tick(d) {
    const t = now();
    const shares = Number(d.accepted) || 0;
    const hashes = Number(d.hashes) || 0;
    // Deltas, robust to a session counter that reset back to a smaller number.
    const dS = shares >= this.lastShares ? shares - this.lastShares : shares;
    const dH = hashes >= this.lastHashes ? hashes - this.lastHashes : hashes;
    this.lastShares = shares; this.lastHashes = hashes;

    const mining = (Number(d.cpuRate) || 0) + (Number(d.gpuRate) || 0) > 0 || dS > 0 || dH > 0;
    if (this.lastTick && mining) this.rec.seconds += Math.min(30, (t - this.lastTick) / 1000);
    this.lastTick = t;

    // The earnings figure is the pool's own, nothing else: the dollar value of
    // this wallet's equal share of the real pot (asset-independent, so the same
    // whatever you are paid in). Shown only once the pool has sent one; until
    // then it stays at zero, because that is what the pool is crediting. Never
    // shares x an invented rate.
    if (Number.isFinite(Number(d.usd)) && Number(d.usd) >= 0) this.rec.est = Number(d.usd);
    if (dS > 0) this.rec.shares += dS;
    if (dH > 0) this.rec.hashes += dH;

    // Add a chart point at most every ~2s so the line stays smooth and bounded.
    if (!this.lastPoint || t - this.lastPoint > 2000) {
      this.rec.series.push({ t, v: this.rec.est });
      if (this.rec.series.length > CAP) this.rec.series = this.rec.series.slice(-CAP);
      this.lastPoint = t;
    }
    this.render();
    if (t - this.lastSave > 3000) this.save();
  }

  render() {
    const { els, rec, asset } = this;
    if (els.earn) els.earn.textContent = '$' + fmt(rec.est);
    if (els.earnCap) els.earnCap.textContent = rec.est > 0
      ? `worth of ${asset === 'glados' ? '$GLaDOS' : asset.toUpperCase()} so far: your equal share of the pot, before power`
      : 'your first payout is building; its value shows here once the pool has one';
    if (els.shares) els.shares.textContent = fmtInt(rec.shares);
    if (els.hashes) els.hashes.textContent = fmtInt(rec.hashes);
    if (els.time) els.time.textContent = fmtDur(rec.seconds);
    if (els.chart) els.chart.innerHTML = areaSvg(rec.series);
  }

  save(force, noPush) {
    const t = now();
    if (!force && t - this.lastSave < 1500) return;
    this.lastSave = t;
    try { localStorage.setItem(keyFor(this.addr, this.asset), JSON.stringify(this.rec)); } catch {}
    if (!noPush) this.push(); // also sync up, throttled inside push()
  }
}
