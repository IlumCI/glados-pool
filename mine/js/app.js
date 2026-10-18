// The page: wires the form to the controller. Nothing starts without a click.

import { detect, cpuThreads } from './hw.js';
import { Miner } from './miner.js';
import { bridgeUrl, checkAddress } from './proto.js';
import { gladosWei, whole, GATE_WEI, GATE_WHOLE } from './gate.js';
import { Progress } from './progress.js';

// ?bridge=ws://127.0.0.1:8080 points the page at a local bridge for testing.
// Only a local address is honoured; see proto.bridgeUrl. The default is the
// live edge-worker pool, which speaks the same protocol at /mine.
const BRIDGE = bridgeUrl(new URLSearchParams(location.search).get('bridge'), 'wss://pool.aperture.institute/mine');

// The pool's HTTP origin, from the same host the miner dials: wss -> https,
// ws -> http, the /mine path dropped. Used read-only for /payouts.json, so a
// returning miner sees whether a distribution has ever included their address.
function poolHttpBase(wss) {
  try { const u = new URL(wss); u.protocol = u.protocol === 'wss:' ? 'https:' : 'http:'; return u.origin; }
  catch { return null; }
}
const POOL_HTTP = poolHttpBase(BRIDGE);

const $ = (id) => document.getElementById(id);
const store = {
  get(k, d) {
    try { const v = localStorage.getItem('glados.' + k); return v == null ? d : JSON.parse(v); } catch { return d; }
  },
  set(k, v) {
    try { localStorage.setItem('glados.' + k, JSON.stringify(v)); } catch {}
  },
};

function fmtRate(h) {
  const u = ['H/s', 'kH/s', 'MH/s', 'GH/s'];
  let i = 0;
  while (h >= 1000 && i < u.length - 1) { h /= 1000; i++; }
  return h.toFixed(h < 10 ? 2 : h < 100 ? 1 : 0) + ' ' + u[i];
}

// The payout assets, by the codes the pool knows (see the pool's reward menu):
// the full name a miner reads, and the short ticker a revenue figure is in.
const ASSETS = {
  glados: ['$GLaDOS', 'GLaDOS'], nvda: ['NVIDIA', 'NVDA'], spcx: ['SpaceX', 'SPCX'],
  googl: ['Alphabet', 'GOOGL'], amzn: ['Amazon', 'AMZN'], gme: ['GameStop', 'GME'],
  spy: ['S&P 500', 'SPY'], chips: ['the Chips basket', 'chips'], os: ['the Big Tech basket', 'os'],
  index: ['the Index basket', 'index'], metals: ['the Metals basket', 'metals'],
};
const assetName = (c) => (ASSETS[c] || ASSETS.glados)[0];

let last = {}; // the most recent stats, so a reward change can re-render at once

// The status line: for each device, the algorithm it is working and how fast,
// at the current load. The coin the work is sold as is the pool's business,
// not a per-device readout.
function renderStatus(d) {
  const el = document.getElementById('s-slots');
  if (!miner.running) { el.textContent = 'Not mining.'; return; }
  const slots = d.slots || [];
  if (!slots.length) { el.textContent = 'Connected, waiting for a job.'; return; }
  const load = document.getElementById('duty').value + '% load';
  const of = (dev, rate) => {
    const algos = [...new Set(slots.filter((s) => s.dev === dev).map((s) => s.algo))];
    return algos.length ? `${dev} · ${algos.join(', ')} · ${fmtRate(rate)} · ${load}` : null;
  };
  el.textContent = [of('CPU', d.cpuRate), of('GPU', d.gpuRate)].filter(Boolean).join('\n');
}

// A money-ish amount: more fraction digits the smaller it is, so a fraction of
// a share still reads as a number instead of rounding to 0.
function fmtAmount(v) {
  const abs = Math.abs(v);
  // More fraction digits the smaller it is, down to the fine decimals a
  // fraction of a tokenised share needs early on, so it never rounds to 0.
  const digits = abs === 0 ? 0 : abs >= 1000 ? 0 : abs >= 1 ? 2 : abs >= 0.01 ? 4 : abs >= 0.0001 ? 6 : 8;
  return v.toLocaleString(undefined, { maximumFractionDigits: digits });
}

// The asset the miner receives, and what their work so far is worth in it. The
// revenue figure is an equal share of the pool's pot valued in that asset; the
// pool supplies it (stats.revenue), shown as a dash until it does and never
// invented here. The asset named is the one the pool is actually crediting
// (stats.asset) when it has said, so a fallback to $GLaDOS shows truthfully;
// before the first figure, the one chosen in the form.
function renderEarn(d) {
  const code = (d && d.asset) || document.getElementById('reward').value;
  const [name, ticker] = ASSETS[code] || ASSETS.glados;
  const rev = d && d.revenue;
  // The line appears only once the pool reports a figure; until then it is
  // hidden rather than showing a dash, since the browser never invents one.
  const el = document.getElementById('s-earn');
  el.style.display = rev != null ? '' : 'none';
  if (rev == null) return;
  document.getElementById('s-earn-val').textContent = `${fmtAmount(rev)} ${ticker}`;
  document.getElementById('s-earn-cap').textContent = `your mining revenue so far in ${name}, before power costs`;
}

// A rough "N minutes/hours ago" from a timestamp in ms.
function agoText(ts) {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 90) return 'just now';
  const m = Math.round(s / 60);
  if (m < 90) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 36 ? `${h} h ago` : `${Math.round(h / 24)} d ago`;
}

// The payout facts the pool sends with the revenue figure: how many miners the
// last distribution split between, the cadence, and when it last paid. Shown
// only once the pool reports them (while connected); never invented here.
function renderPayout(d) {
  const el = document.getElementById('s-payout-live');
  if (!d || d.epochMs == null) { el.style.display = 'none'; return; }
  el.style.display = '';
  const parts = [];
  if (d.recipients > 0) parts.push(`last round split among ${d.recipients} miner${d.recipients === 1 ? '' : 's'}`);
  parts.push(`distributions run about every ${Math.max(1, Math.round(d.epochMs / 60000))} min`);
  parts.push(d.lastAt ? `last one ${agoText(d.lastAt)}` : 'none have run yet');
  const s = parts.join(' · ');
  el.textContent = s.charAt(0).toUpperCase() + s.slice(1) + '.';
}

// Whether any distribution has ever paid the entered address, read from the
// pool's own /payouts.json. The latest address wins, as with the gate check.
let paidSeq = 0;
async function fetchPaid(a) {
  const el = document.getElementById('s-paid');
  if (!POOL_HTTP) { el.textContent = ''; return; }
  const seq = ++paidSeq;
  el.textContent = 'Checking your payout history…';
  try {
    const r = await fetch(POOL_HTTP + '/payouts.json', { cache: 'no-store' });
    if (!r.ok) throw new Error('http ' + r.status);
    const { epochs } = await r.json();
    if (seq !== paidSeq) return; // a newer address was entered meanwhile
    const lc = a.toLowerCase();
    const all = Array.isArray(epochs) ? epochs : [];
    const mine = all.filter((e) => Array.isArray(e.recipients) && e.recipients.includes(lc));
    if (!all.length) { el.textContent = 'No distribution has run yet. You could be in one of the pool’s first rounds.'; return; }
    if (!mine.length) { el.textContent = `No distribution has included you yet (${all.length} so far). You’re paid once your work clears a round’s floor.`; return; }
    const lastPaid = mine[0]; // /payouts.json is newest-first, so the first match is the most recent
    const when = typeof lastPaid.at === 'number' ? ` · most recent ${agoText(lastPaid.at)}` : '';
    el.textContent = `Paid in ${mine.length} of the last ${all.length} distributions${when}.`;
  } catch {
    if (seq !== paidSeq) return;
    el.textContent = ''; // the pool is the authority; say nothing rather than guess
  }
}

const logEl = $('log');
function log({ t, text, level }) {
  const line = document.createElement('div');
  line.className = level;
  line.textContent = new Date(t).toISOString().slice(11, 19) + '  ' + text;
  logEl.append(line);
  while (logEl.childElementCount > 300) logEl.firstChild.remove();
  logEl.scrollTop = logEl.scrollHeight;
}

const hw = await detect();
const threads = cpuThreads(hw);
$('hw').textContent =
  `${hw.cores} logical cores, mining on ${threads}` +
  ` · WebAssembly SIMD ${hw.simd ? 'yes' : 'no'}` +
  ` · WebGPU ${hw.webgpu ? hw.gpu : 'not available'}` +
  (hw.memoryGb ? ` · ${hw.memoryGb}+ GB` : '');

const miner = new Miner({
  bridge: BRIDGE,
  wasm: new URL(hw.simd ? '../wasm/core-simd.wasm' : '../wasm/core.wasm', import.meta.url).href,
  threads,
  gpu: hw.webgpu,
});

miner.on((kind, d) => {
  if (kind === 'log') log(d);
  if (kind === 'stats') {
    $('s-cpu').textContent = fmtRate(d.cpuRate);
    $('s-gpu').textContent = hw.webgpu ? fmtRate(d.gpuRate) : 'no WebGPU';
    $('s-acc').textContent = d.accepted;
    $('s-rej').textContent = d.rejected;
    $('s-hashes').textContent = d.hashes.toLocaleString();
    last = d;
    renderStatus(d);
    renderEarn(d);
    renderPayout(d);
    progress.tick(d);
  }
});

// The locally saved, always-climbing earnings line. It is pointed at a wallet
// and asset so a returning miner finds their progress where they left it.
const progress = new Progress({
  earn: $('p-earn'), earnCap: $('p-earn-cap'), chart: $('p-chart'),
  shares: $('p-shares'), hashes: $('p-hashes'), time: $('p-time'),
});
progress.setPool(POOL_HTTP); // sync the line across this wallet's devices

// The outage strip. A connection the miner lost, or a component the pool's
// own status feed calls not operational, is said in plain words with the
// pool's reason, with the reassurance that matters: progress is saved and the
// miner reconnects by itself. The feed is read at most once a minute, and only
// polled while something is wrong, so a healthy page costs it one read.
const STATUS_PAGE = 'https://glados-status.pages.dev'; // status.aperture.institute once the domain is attached
const linkDown = new Set();
let healthAt = 0, healthWhy = '';
async function poolTrouble() {
  if (!POOL_HTTP) return '';
  if (Date.now() - healthAt < 60_000) return healthWhy;
  healthAt = Date.now();
  try {
    const r = await fetch(POOL_HTTP + '/health.json', { cache: 'no-store' });
    const j = await r.json().catch(() => null);
    if (!r.ok) healthWhy = (j && j.why) || `the pool answered ${r.status}`;
    else {
      const bad = j && j.components ? Object.values(j.components).filter((c) => c.state !== 'operational') : [];
      healthWhy = bad.map((c) => `${c.name}: ${c.why || c.state}`).join('; ');
    }
  } catch {
    healthWhy = 'the pool could not be reached';
  }
  return healthWhy;
}
async function renderOutage() {
  const el = $('outage');
  const why = await poolTrouble();
  const down = [...linkDown].map((r) => (r === 'gpu' ? 'GPU' : 'CPU'));
  if (!down.length && !why) { el.hidden = true; return; }
  el.textContent = '';
  const head = document.createElement('b');
  head.textContent = down.length ? `${down.join(' and ')} mining is not connected right now.` : 'The pool is having trouble right now.';
  el.append(head, ` ${why ? why.charAt(0).toUpperCase() + why.slice(1) + '. ' : ''}Your saved progress is safe, and the miner reconnects on its own. `);
  const a = document.createElement('a');
  a.href = STATUS_PAGE; a.target = '_blank'; a.rel = 'noopener'; a.textContent = 'Live status';
  el.append(a);
  el.hidden = false;
}
miner.on((kind, d) => {
  if (kind !== 'link') return;
  if (d.up) linkDown.delete(d.role); else linkDown.add(d.role);
  renderOutage();
});
renderOutage(); // a visitor learns about trouble before pressing start
setInterval(() => { if (linkDown.size || !$('outage').hidden) renderOutage(); }, 60_000);

const addr = $('addr');
const go = $('go');
const duty = $('duty');
const reward = $('reward');
addr.value = store.get('address', '');
duty.value = store.get('duty', 75);
reward.value = store.get('reward', 'glados');
$('duty-out').textContent = duty.value + '%';
renderEarn(last);

// The holding gate, reflected on the controls. Stock and basket payouts are
// locked until the address is shown to hold 1,000,000 $GLaDOS; under that, the
// miner is paid in $GLaDOS (what the pool does regardless). A failed balance
// read does not lock a real holder out: it leaves the choice open with the
// requirement named, since the pool is the authority either way.
const gradeFmt = (wei) => whole(wei).toLocaleString();
let gateSeq = 0; // the latest address wins; a slow read for an old one is dropped

function applyGate(wei) {
  const holder = wei != null && wei >= GATE_WEI;
  const unread = wei == null;
  for (const opt of reward.options) if (opt.value !== 'glados') opt.disabled = !holder && !unread;
  if (!holder && !unread && reward.value !== 'glados') {
    reward.value = 'glados';
    store.set('reward', 'glados');
    renderEarn(last);
  }
  const g = $('gate');
  if (holder) g.textContent = `You hold ${gradeFmt(wei)} $GLaDOS. Stock and basket payouts unlocked.`;
  else if (unread) g.textContent = `Stock and basket payouts need 1,000,000 $GLaDOS. Couldn't check your balance just now; under that you're paid in $GLaDOS.`;
  else g.textContent = `You hold ${gradeFmt(wei)} of ${GATE_WHOLE.toLocaleString()} $GLaDOS. Mining $GLaDOS until you reach it; top up to unlock stock and basket payouts.`;
}

async function checkGate(a) {
  const seq = ++gateSeq;
  $('gate').textContent = 'Checking your $GLaDOS balance…';
  const wei = await gladosWei(a);
  if (seq !== gateSeq) return; // a newer address was entered meanwhile
  applyGate(wei);
}

// The gate and the payout history are both read off a valid address, so a
// newcomer sees what they'd be paid in and whether they've ever been paid.
function checkAddr(a) { checkGate(a); fetchPaid(a); progress.switchTo(a, reward.value); }

// Locked until an address proves the holding; this is the first thing a
// newcomer sees, so the progression is legible before anything is typed.
function lockRwa() {
  for (const opt of reward.options) if (opt.value !== 'glados') opt.disabled = true;
  $('gate').textContent = 'Hold 1,000,000 $GLaDOS to unlock stock and basket payouts. Enter your address to check.';
  paidSeq++; // drop any in-flight payout lookup for an old address
  $('s-paid').textContent = '';
}

reward.onchange = () => {
  store.set('reward', reward.value);
  renderEarn(last);
  progress.setAsset(reward.value);
};

addr.oninput = () => {
  clearTimeout(addr._t);
  const a = addr.value.trim();
  if (!checkAddress(a).ok) { lockRwa(); return; }
  addr._t = setTimeout(() => checkAddr(a), 400); // debounced: one read, not one a keystroke
};

// On load: locked, then checked at once if an address was remembered, so a
// returning holder sees their choices open and their payout history without retyping.
lockRwa();
progress.switchTo(addr.value.trim(), reward.value); // show the saved line at once, before any check
if (checkAddress(addr.value.trim()).ok) checkAddr(addr.value.trim());

// Persist the line when the tab goes away, so nothing a miner earned on screen
// is lost to a close or a reload.
addEventListener('pagehide', () => progress.save(true));
document.addEventListener('visibilitychange', () => { if (document.hidden) progress.save(true); });

duty.oninput = () => {
  $('duty-out').textContent = duty.value + '%';
  store.set('duty', Number(duty.value));
  miner.setDuty(duty.value / 100);
};

go.onclick = async () => {
  if (miner.running) {
    miner.stop();
  } else {
    const a = addr.value.trim();
    const c = checkAddress(a);
    if (!c.ok) {
      log({ t: Date.now(), text: c.why, level: 'err' });
      return;
    }
    if (c.warn) log({ t: Date.now(), text: c.warn, level: 'warn' });
    store.set('address', a);
    try {
      await miner.start(a, duty.value / 100, reward.value);
    } catch (e) {
      log({ t: Date.now(), text: e.message, level: 'err' });
    }
  }
  go.dataset.running = String(miner.running);
  go.textContent = miner.running ? 'Stop' : 'Start mining';
  if (!miner.running) { linkDown.clear(); renderOutage(); } // a stopped miner is not an outage
  const st = $('status'); // the title-bar lamp: LIVE while mining, else idle
  if (st) { st.dataset.on = String(miner.running); st.textContent = miner.running ? 'Live' : 'Idle'; }
  addr.disabled = miner.running;
  reward.disabled = miner.running;
};

// A background tab is throttled by the browser; say so rather than let the
// rate drop look like a fault.
document.addEventListener('visibilitychange', () => {
  if (miner.running && document.hidden) log({ t: Date.now(), text: 'tab hidden: the browser may slow mining down', level: 'warn' });
});
