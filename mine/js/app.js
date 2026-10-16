// The page: wires the form to the controller. Nothing starts without a click.

import { detect, cpuThreads } from './hw.js';
import { Miner } from './miner.js';
import { bridgeUrl, checkAddress } from './proto.js';

// ?bridge=ws://127.0.0.1:8080 points the page at a local bridge for testing.
// Only a local address is honoured; see proto.bridgeUrl.
const BRIDGE = bridgeUrl(new URLSearchParams(location.search).get('bridge'), 'wss://ws.aperture.institute');

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
  const digits = abs === 0 ? 0 : abs >= 1000 ? 0 : abs >= 1 ? 2 : abs >= 0.01 ? 4 : 6;
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
  document.getElementById('s-earn-val').textContent = rev != null ? `${fmtAmount(rev)} ${ticker}` : '—';
  document.getElementById('s-earn-cap').textContent = rev != null
    ? `your mining revenue so far in ${name}, before power costs`
    : `your mining revenue in ${name} shows here once the pool reports it`;
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
  }
});

const addr = $('addr');
const go = $('go');
const duty = $('duty');
const reward = $('reward');
addr.value = store.get('address', '');
duty.value = store.get('duty', 75);
reward.value = store.get('reward', 'glados');
$('duty-out').textContent = duty.value + '%';
renderEarn(last);

reward.onchange = () => {
  store.set('reward', reward.value);
  renderEarn(last);
};

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
  addr.disabled = miner.running;
  reward.disabled = miner.running;
};

// A background tab is throttled by the browser; say so rather than let the
// rate drop look like a fault.
document.addEventListener('visibilitychange', () => {
  if (miner.running && document.hidden) log({ t: Date.now(), text: 'tab hidden: the browser may slow mining down', level: 'warn' });
});
