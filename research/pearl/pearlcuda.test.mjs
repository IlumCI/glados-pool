// node pearlcuda.test.mjs <path to cuda/pearl> [out.json]
// cuda/pearl.cu's round against pearlmine.mjs: the same roots, every tile's
// hash, byte-identical proofs -- and the proofs written out for pearlcheck.
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { round } from "./pearlmine.mjs";
import { verifyShare, fromBase64, toBase64 } from "./pearlproof.mjs";

const bin = process.argv[2];
let passed = 0, failed = 0;
const ok = (c, w) => { c ? passed++ : failed++; console.log(`${c ? "ok  " : "FAIL"}  ${w}`); };
const hex = (u8) => Array.from(u8, (b) => b.toString(16).padStart(2, "0")).join("");
const header = new Uint8Array(76).map((_, i) => (i * 37 + 11) & 255);
const out = [];

const p = spawn(bin, [], { stdio: ["pipe", "pipe", "inherit"] });
let buf = "";
const lines = [];
p.stdout.on("data", (d) => { buf += d; let i; while ((i = buf.indexOf("\n")) >= 0) { lines.push(buf.slice(0, i)); buf = buf.slice(i + 1); } });
const next = async (pred) => { for (;;) { const i = lines.findIndex(pred); if (i >= 0) return lines.splice(0, i + 1).pop(); await new Promise((r) => setTimeout(r, 20)); } };

const ready = await next((l) => /^(ready|error)/.test(l));
ok(ready.startsWith("ready"), `the helper starts: ${ready}`);
for (const [m, n] of (process.env.SIZES ? JSON.parse(process.env.SIZES) : [[64, 64], [128, 64], [64, 128], [192, 128]])) {
  const s0 = 0x1234567, s1 = 0x89abcdef;
  p.stdin.write(`check ${m} ${n} ${s0} ${s1} ${hex(header)}\n`);
  const got = [];
  for (;;) { const l = await next(() => true); if (l === "checked" || l.startsWith("error")) { got.push(l); break; } got.push(l); }
  const ref = round(header, { m, n, k: 2048, rank: 128, s0, s1 });
  const roots = got.find((l) => l.startsWith("roots")).split(" ");
  ok(roots[1] === hex(ref.rootA) && roots[2] === hex(ref.rootB), `${m}x${n}: Merkle roots match the reference`);
  const tiles = got.filter((l) => l.startsWith("tile "));
  const same = tiles.filter((l) => { const [, tr, tc, h] = l.split(" "); return h === hex(ref.tileHash(+tr, +tc)); }).length;
  ok(tiles.length === (m / 16) * (n / 16) && same === tiles.length, `${m}x${n}: ${same}/${tiles.length} tile hashes match`);
  for (const l of got.filter((x) => x.startsWith("proof "))) {
    const [, tr, tc, b64] = l.split(" ");
    const mine = fromBase64(b64), theirs = ref.proof(+tr, +tc);
    ok(mine.length === theirs.length && mine.every((x, i) => x === theirs[i]), `${m}x${n}: proof for tile (${tr},${tc}) is byte-identical to the reference's`);
    ok(verifyShare(mine, header, { bound: (1n << 256n) - 1n }).ok, `${m}x${n}: and verifies`);
    out.push({ name: `cuda ${m}x${n} tile ${tr},${tc}`, header: hex(header), proof_b64: b64, jackpot_hash: hex(ref.tileHash(+tr, +tc)) });
  }
}
p.stdin.write("quit\n");
if (process.argv[3]) writeFileSync(process.argv[3], JSON.stringify(out));
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
