// Bridge load: 1000 connections, 2 msg/s each, 20 s. Run from the repo root after
// `cargo build --release` in bridge/. Prints delivery, CPU and memory.
import net from 'node:net';
import { spawn } from 'node:child_process';
const N = 1000, SECS = 20, RATE = 2;
const pool = net.createServer((s) => { let b = ''; s.on('data', (c) => { b += c; let i; while ((i = b.indexOf('\n')) >= 0) { const l = b.slice(0, i); b = b.slice(i + 1); s.write(l + '\n'); } }); s.on('error', () => {}); });
await new Promise((r) => pool.listen(13399, '127.0.0.1', r));
const br = spawn('bridge/target/release/glados-bridge', ['--listen', '127.0.0.1:18099', '--pool', '127.0.0.1:13399', '--origin', 'http://ok.test', '--max-conns', '1024', '--max-per-ip', '2000'], { stdio: ['ignore', 'ignore', 'ignore'] });
await new Promise((r) => setTimeout(r, 500));
let sent = 0, got = 0, open = 0, failed = 0;
const socks = [];
for (let i = 0; i < N; i++) {
  const w = new WebSocket('ws://127.0.0.1:18099/', { headers: { origin: 'http://ok.test' } });
  w.onopen = () => open++;
  w.onmessage = () => got++;
  w.onerror = () => failed++;
  socks.push(w);
  if (i % 100 === 99) await new Promise((r) => setTimeout(r, 50));
}
await new Promise((r) => setTimeout(r, 2000));
const fs = await import('node:fs');
const mem = () => Number(fs.readFileSync(`/proc/${br.pid}/status`, 'utf8').match(/VmRSS:\s+(\d+)/)[1]) / 1024;
const cpu = () => { const f = fs.readFileSync(`/proc/${br.pid}/stat`, 'utf8').split(') ')[1].split(' '); return (Number(f[11]) + Number(f[12])) / 100; };
console.log(`${open} of ${N} open, ${failed} errors; bridge RSS ${mem().toFixed(1)} MiB`);
const c0 = cpu(), t0 = Date.now();
const tick = setInterval(() => { for (const w of socks) if (w.readyState === 1) { w.send('{"id":1,"method":"glados.work","params":{"slot":1}}'); sent++; } }, 1000 / RATE);
await new Promise((r) => setTimeout(r, SECS * 1000));
clearInterval(tick);
await new Promise((r) => setTimeout(r, 1500));
const used = cpu() - c0, wall = (Date.now() - t0) / 1000;
console.log(`sent ${sent}, echoed back ${got} (${(100 * got / sent).toFixed(2)}%); ${(sent / wall).toFixed(0)} msg/s each way`);
console.log(`bridge CPU ${(100 * used / wall).toFixed(1)}% of one core, RSS ${mem().toFixed(1)} MiB, still open ${socks.filter((w) => w.readyState === 1).length}`);
for (const w of socks) w.close();
await new Promise((r) => setTimeout(r, 1500));
console.log(`after close: RSS ${mem().toFixed(1)} MiB`);
br.kill(); pool.close(); process.exit(0);
