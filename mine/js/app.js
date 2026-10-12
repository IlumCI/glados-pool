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
    $('s-slots').textContent = miner.running
      ? d.slots.length ? 'Working ' + d.slots.join(', ') : 'Connected, waiting for a job.'
      : 'Not mining.';
  }
});

const addr = $('addr');
const go = $('go');
const duty = $('duty');
addr.value = store.get('address', '');
duty.value = store.get('duty', 75);
$('duty-out').textContent = duty.value + '%';

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
      await miner.start(a, duty.value / 100);
    } catch (e) {
      log({ t: Date.now(), text: e.message, level: 'err' });
    }
  }
  go.dataset.running = String(miner.running);
  go.textContent = miner.running ? 'Stop' : 'Start mining';
  addr.disabled = miner.running;
};

// A background tab is throttled by the browser; say so rather than let the
// rate drop look like a fault.
document.addEventListener('visibilitychange', () => {
  if (miner.running && document.hidden) log({ t: Date.now(), text: 'tab hidden: the browser may slow mining down', level: 'warn' });
});
