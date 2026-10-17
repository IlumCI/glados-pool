// Progress: the part a miner comes back for. It keeps a running, locally saved
// tally of what this wallet has done and is estimated to have earned, and draws
// it as a green line that climbs. Everything here is grounded in real activity:
// the share counts and hashes are exactly what the miner reported, and the
// earnings estimate is accepted-shares times a per-share rate -- the pool's own
// rate (its revenue figure divided by the shares that earned it) once it has
// sent one, a small nominal before that. It is an estimate, labelled as one,
// never a claim of realised profit; it only ever goes up, because work only
// accumulates. Saved per wallet and asset so a returning miner sees their line
// where they left it.

const KEY = 'glados.progress.v1';
const CAP = 160; // points kept for the chart

// A small nominal per accepted share, used only until the pool reports a real
// rate for this wallet. Deliberately modest; the shape of the climb is the
// point, not the magnitude. Learned rate replaces it as soon as one exists.
const NOMINAL = {
  glados: 0.5, nvda: 0.00003, spcx: 0.00005, googl: 0.00002, amzn: 0.00002,
  gme: 0.0004, spy: 0.00002, chips: 0.00003, os: 0.00003, index: 0.00002, metals: 0.0002,
};

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
  }

  // Point at a wallet and asset: load its saved line and show it. Called when a
  // valid address is entered and when the payout asset changes.
  switchTo(addr, asset) {
    this.save(true); // flush the line we are leaving
    this.addr = addr || this.addr;
    this.asset = asset || this.asset;
    this.rec = load(this.addr, this.asset);
    this.lastShares = 0; this.lastHashes = 0; this.lastTick = 0; this.lastPoint = 0;
    this.render();
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

    // Learn the per-share rate from the pool's own figure when it is for this
    // asset: its revenue over the shares that earned it. Otherwise the nominal.
    if (d.asset === this.asset && Number(d.revenue) > 0 && shares > 0) {
      this.rec.rate = Number(d.revenue) / shares;
    }
    const rate = this.rec.rate || NOMINAL[this.asset] || NOMINAL.glados;

    if (dS > 0) { this.rec.shares += dS; this.rec.est += dS * rate; }
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
    if (els.earn) els.earn.textContent = fmt(rec.est);
    if (els.earnCap) els.earnCap.textContent = `estimated ${asset === 'glados' ? '$GLaDOS' : asset.toUpperCase()} earned, before power and fees`;
    if (els.shares) els.shares.textContent = fmtInt(rec.shares);
    if (els.hashes) els.hashes.textContent = fmtInt(rec.hashes);
    if (els.time) els.time.textContent = fmtDur(rec.seconds);
    if (els.chart) els.chart.innerHTML = areaSvg(rec.series);
  }

  save(force) {
    const t = now();
    if (!force && t - this.lastSave < 1500) return;
    this.lastSave = t;
    try { localStorage.setItem(keyFor(this.addr, this.asset), JSON.stringify(this.rec)); } catch {}
  }
}
