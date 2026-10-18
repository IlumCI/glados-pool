// Measures int8 dot-product throughput of gemm.wgsl on the real GPU, and prints
// giga-ops/s (one op = one int8 multiply-accumulate) plus the implied Pearl
// tiles/s and a rough $/day, against Pearl's published RTX 3090 figures.
const { chromium } = require("/home/lummy/.npm-global/lib/node_modules/agent-browser/node_modules/playwright-core");
const http = require("http"), fs = require("fs"), path = require("path");
const dir = __dirname;
const srv = http.createServer((q, r) => {
  const f = q.url.split("?")[0] === "/" ? "gb.html" : q.url.slice(1).split("?")[0];
  try { const b = fs.readFileSync(path.join(dir, f)); r.setHeader("content-type", f.endsWith(".wgsl") ? "text/plain" : "text/html"); r.end(b); } catch { r.statusCode = 404; r.end(); }
}).listen(18903, "127.0.0.1");
fs.writeFileSync(path.join(dir, "gb.html"), "<!doctype html><title>gemm</title>");
const HARNESS = `
window.bench = async (threads, kWords, iters, secs) => {
  const ad = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
  const dev = await ad.requestDevice();
  const code = await (await fetch("gemm.wgsl")).text();
  const mod = dev.createShaderModule({ code });
  const info = await mod.getCompilationInfo();
  const errs = info.messages.filter(m => m.type === "error");
  if (errs.length) return { error: errs.map(m => m.lineNum + ": " + m.message).join(" | ") };
  const pipe = await dev.createComputePipelineAsync({ layout: "auto", compute: { module: mod, entryPoint: "main" } });
  const K = kWords * 4;
  const A = new Int8Array(K), B = new Int8Array(K);
  for (let i = 0; i < K; i++) { A[i] = ((i * 37) % 255) - 127; B[i] = ((i * 53) % 255) - 127; }
  const mk = (arr, usage) => { const b = dev.createBuffer({ size: arr.byteLength, usage, mappedAtCreation: true }); new Uint8Array(b.getMappedRange()).set(new Uint8Array(arr.buffer)); b.unmap(); return b; };
  const params = dev.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  dev.queue.writeBuffer(params, 0, new Uint32Array([kWords, iters, 0, 0]));
  const ab = mk(A, GPUBufferUsage.STORAGE), bb = mk(B, GPUBufferUsage.STORAGE);
  const out = dev.createBuffer({ size: threads * 4, usage: GPUBufferUsage.STORAGE });
  const bind = dev.createBindGroup({ layout: pipe.getBindGroupLayout(0), entries: [
    { binding: 0, resource: { buffer: params } }, { binding: 1, resource: { buffer: ab } },
    { binding: 2, resource: { buffer: bb } }, { binding: 3, resource: { buffer: out } } ] });
  const run = () => { const e = dev.createCommandEncoder(); const p = e.beginComputePass(); p.setPipeline(pipe); p.setBindGroup(0, bind); p.dispatchWorkgroups(Math.ceil(threads / 256)); p.end(); dev.queue.submit([e.finish()]); };
  run(); await dev.queue.onSubmittedWorkDone();           // warm-up
  let n = 0; const t0 = performance.now();
  while (performance.now() - t0 < secs * 1000) { run(); await dev.queue.onSubmittedWorkDone(); n++; }
  const sec = (performance.now() - t0) / 1000;
  const macs = n * threads * kWords * 4 * iters;          // int8 multiply-accumulates
  return { adapter: ad.info ? ad.info.vendor + " " + ad.info.architecture : "?", dispatches: n, seconds: sec, gops: macs / sec / 1e9 };
};`;
fs.writeFileSync(path.join(dir, "harness-gb.js"), HARNESS);
fs.writeFileSync(path.join(dir, "gb.html"), '<!doctype html><title>gemm</title><script src="harness-gb.js"></script>');
(async () => {
  const b = await chromium.launch({ executablePath: process.env.HOME + "/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome",
    headless: process.env.HEADLESS === "1", args: ["--enable-unsafe-webgpu", "--enable-features=Vulkan", "--ignore-gpu-blocklist"] });
  const p = await b.newPage();
  p.on("console", (m) => m.type() === "error" && console.log("[page]", m.text()));
  await p.goto("http://127.0.0.1:18903/");
  await p.waitForFunction(() => window.bench);
  const r = await p.evaluate(([t, k, it, s]) => window.bench(t, k, it, s),
    [Number(process.env.THREADS || 262144), Number(process.env.KWORDS || 256), Number(process.env.ITERS || 64), Number(process.env.SECS || 6)]);
  console.log(JSON.stringify(r, null, 1));
  await b.close(); srv.close();
})().catch((e) => { console.error("ERR", e.message); srv.close(); process.exit(1); });
