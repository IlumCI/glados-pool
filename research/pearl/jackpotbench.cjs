// node jackpotbench.cjs
// Checks jackpot.wgsl against Pearl's vectors, then times it on the real GPU in
// short bursts under a thermal guard: before each burst it waits for the GPU to
// cool to COOL_C, and it aborts a burst the moment the GPU reaches MAX_C.
const { chromium } = require("/home/lummy/.npm-global/lib/node_modules/agent-browser/node_modules/playwright-core");
const http = require("http"), fs = require("fs"), path = require("path"), { execFileSync } = require("child_process");

const MAX_C = Number(process.env.MAX_C || 78), COOL_C = Number(process.env.COOL_C || 65);
const BURST_S = Number(process.env.BURST_S || 4), BURSTS = Number(process.env.BURSTS || 3);
const dir = __dirname, PORT = 18907;
const TYPES = { ".mjs": "text/javascript", ".js": "text/javascript", ".wgsl": "text/plain", ".html": "text/html", ".json": "application/json" };
const srv = http.createServer((q, r) => {
  const f = q.url.split("?")[0] === "/" ? "jb.html" : q.url.slice(1).split("?")[0];
  try { r.setHeader("content-type", TYPES[path.extname(f)] || "text/plain"); r.end(fs.readFileSync(path.join(dir, path.basename(f)))); } catch { r.statusCode = 404; r.end(); }
}).listen(PORT, "127.0.0.1");
fs.writeFileSync(path.join(dir, "jb.html"), '<!doctype html><title>jackpot</title><script type="module" src="jackpot-page.mjs"></script>');

const gpu = () => {
  try {
    const [t, p, u] = execFileSync("nvidia-smi", ["--query-gpu=temperature.gpu,power.draw,utilization.gpu", "--format=csv,noheader,nounits"]).toString().trim().split(",").map((x) => parseFloat(x));
    return { t, p, u };
  } catch { return { t: NaN, p: NaN, u: NaN }; }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let peak = 0, peakW = 0;

async function cool() {
  for (let i = 0; i < 120; i++) { const g = gpu(); if (!(g.t > COOL_C)) return g.t; await sleep(1000); }
  throw new Error(`GPU did not cool below ${COOL_C} C in 2 min; stopping`);
}

// One burst with the guard watching; trips window.stop at MAX_C.
async function burst(page) {
  await cool();
  let tripped = false;
  const watch = setInterval(async () => {
    const g = gpu(); peak = Math.max(peak, g.t || 0); peakW = Math.max(peakW, g.p || 0);
    if (g.t >= MAX_C && !tripped) { tripped = true; await page.evaluate(() => { window.stop = true; }).catch(() => {}); }
  }, 500);
  try { return { ...(await page.evaluate((s) => window.benchBurst(s), BURST_S)), tripped }; }
  finally { clearInterval(watch); }
}

(async () => {
  console.log(`guard: wait for <= ${COOL_C} C before each burst, abort at ${MAX_C} C; idle now ${gpu().t} C`);
  const b = await chromium.launch({ executablePath: process.env.HOME + "/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome",
    headless: process.env.HEADED !== "1", args: ["--enable-unsafe-webgpu", "--enable-features=Vulkan", "--use-angle=vulkan", "--ignore-gpu-blocklist"] });
  const page = await b.newPage();
  page.on("console", (m) => m.type() === "error" && console.log("[page]", m.text()));
  page.on("pageerror", (e) => console.log("[pageerror]", e.message));
  await page.goto(`http://127.0.0.1:${PORT}/`);
  await page.waitForFunction(() => window.kat && window.benchBurst, null, { timeout: 15000 });

  const vectors = JSON.parse(fs.readFileSync(path.join(dir, "vectors.json"), "utf8")).filter((t) => t.tile_rows.length === 16 && t.tile_cols.length === 16);
  const shapes = (process.env.SHAPES || "4x4,8x8").split(",").map((s) => s.split("x").map(Number));
  let allOk = true;
  for (const [tm, tn] of shapes) for (const t of vectors) {
    const r = await page.evaluate(([t, tm, tn]) => window.kat(t, tm, tn), [t, tm, tn]);
    const ok = r.mismatched === 0 && r.tile0MatchesPearl;
    allOk &&= ok;
    console.log(`KAT ${tm}x${tn} ${r.name}: ${r.tiles - r.mismatched}/${r.tiles} tiles match pearl.mjs, tile(0,0) = Pearl's verified hash: ${r.tile0MatchesPearl}  [${r.adapter}]`);
  }
  if (!allOk) { console.log("KAT FAILED: not benchmarking a wrong kernel"); await b.close(); srv.close(); process.exit(1); }
  if (process.env.KAT_ONLY === "1") { await b.close(); srv.close(); return; }

  const M = Number(process.env.M || 4096), K = Number(process.env.K || 2048), R = Number(process.env.R || 128);
  for (const [tm, tn] of shapes) {
    await page.evaluate(([tm, tn, m, k, r]) => window.benchSetup(tm, tn, m, m, k, r), [tm, tn, M, K, R]);
    const rows = [];
    for (let i = 0; i < BURSTS; i++) {
      const r = await burst(page);
      rows.push(r);
      console.log(`  ${tm}x${tn} m=n=${M} k=${K} r=${R}: ${r.tmacs.toFixed(3)} TMAC/s, ${(r.tilesPerSec / 1e3).toFixed(1)}k tiles/s, ${r.msPerDispatch.toFixed(1)} ms/dispatch${r.tripped ? "  [GUARD TRIPPED]" : ""}`);
      if (r.tripped) break;
    }
    const best = rows.reduce((a, r) => (r.tmacs > a.tmacs ? r : a));
    console.log(`BEST ${tm}x${tn}: ${best.tmacs.toFixed(3)} TMAC/s (${(best.tilesPerSec / 1e3).toFixed(1)}k tiles/s)`);
    await page.evaluate(() => { window.stop = false; });
  }
  console.log(`thermals: peak ${peak} C, peak ${peakW} W, now ${gpu().t} C`);
  await b.close(); srv.close();
})().catch((e) => { console.error("ERR", e.message); srv.close(); process.exit(1); });
