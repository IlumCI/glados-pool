// HEADED=1 node pearlgpu-check.cjs
// The GPU Pearl round against the JavaScript reference on the real GPU, then
// full-size rounds timed in short bursts. Development only: a thermal guard
// (abort at MAX_C) keeps a laptop's fans and its owner's power bill civil; it
// is not part of anything that ships.
const { chromium } = require("/home/lummy/.npm-global/lib/node_modules/agent-browser/node_modules/playwright-core");
const http = require("http"), fs = require("fs"), path = require("path"), { execFileSync } = require("child_process");
const MAX_C = 78, dir = __dirname, PORT = 18908;
const TYPES = { ".mjs": "text/javascript", ".js": "text/javascript", ".wgsl": "text/plain", ".html": "text/html" };
const srv = http.createServer((q, r) => {
  const f = q.url.split("?")[0] === "/" ? "pg.html" : path.basename(q.url.split("?")[0]);
  try { r.setHeader("content-type", TYPES[path.extname(f)] || "text/plain"); r.end(fs.readFileSync(path.join(dir, f))); } catch { r.statusCode = 404; r.end(); }
}).listen(PORT, "127.0.0.1");
fs.writeFileSync(path.join(dir, "pg.html"), '<!doctype html><title>pearl gpu</title><script type="module" src="pearl-gpu-page.mjs"></script>');
const temp = () => { try { return Number(execFileSync("nvidia-smi", ["--query-gpu=temperature.gpu", "--format=csv,noheader,nounits"]).toString().trim()); } catch { return NaN; } };

(async () => {
  const b = await chromium.launch({ executablePath: process.env.HOME + "/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome",
    headless: process.env.HEADED !== "1", args: ["--enable-unsafe-webgpu", "--enable-features=Vulkan", "--ignore-gpu-blocklist"] });
  const page = await b.newPage();
  page.on("console", (m) => m.type() === "error" && console.log("[page]", m.text()));
  page.on("pageerror", (e) => console.log("[pageerror]", e.message));
  await page.goto(`http://127.0.0.1:${PORT}/`);
  await page.waitForFunction(() => window.check, null, { timeout: 20000 });
  let allOk = true;
  for (const [m, n] of [[64, 64], [128, 64], [64, 128]]) {
    const r = await page.evaluate(([m, n]) => window.check(m, n, 0x1234567, 0x89abcdef), [m, n]);
    const ok = r.rootA && r.rootB && r.tilesSame === r.tiles && r.proofsSame === 2 && r.proofsVerify === 2 && r.hits === r.tiles;
    allOk &&= ok;
    console.log(`${ok ? "ok  " : "FAIL"} ${m}x${n} on ${r.adapter}: roots ${r.rootA && r.rootB ? "match" : "DIFFER"}, tile hashes ${r.tilesSame}/${r.tiles} match, every tile reported ${r.hits}/${r.tiles}, proofs byte-identical ${r.proofsSame}/2, verify ${r.proofsVerify}/2`);
  }
  if (!allOk || process.env.CHECK_ONLY === "1") { await b.close(); srv.close(); process.exit(allOk ? 0 : 1); }

  for (const s of (process.env.SIZES || "4096").split(",").map(Number)) {
    await page.evaluate((s) => window.benchSetup(s, s), s);
    if (temp() >= MAX_C - 6) { console.log(`GPU at ${temp()} C; skipping the timing`); break; }
    const r = await page.evaluate(() => window.benchRounds(3, 20));
    console.log(`  ${s}x${s}, k 2048: ${r.msPerRound.toFixed(1)} ms a round (${r.rounds.join(", ")}), ${((s / 16) ** 2 / (r.msPerRound / 1000) / 1e6).toFixed(2)} M tiles/s whole-round, ${r.hits} hits at 20 bits; GPU ${temp()} C`);
  }
  await b.close(); srv.close();
})().catch((e) => { console.error("ERR", e.message); srv.close(); process.exit(1); });
