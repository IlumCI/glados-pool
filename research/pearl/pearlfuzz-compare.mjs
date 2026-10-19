// node pearlfuzz-compare.mjs <cases.json> <pearl-verdicts.json>
// Our verifier against Pearl's on the same broken proofs. A case we accept
// and Pearl refuses -- or accept with another hash -- is a bug; Pearl
// accepting what we refuse is us being stricter, and is listed, not failed.
import { readFileSync } from "node:fs";
const cases = JSON.parse(readFileSync(process.argv[2], "utf8")), pearl = JSON.parse(readFileSync(process.argv[3], "utf8"));
let bugs = 0, stricter = 0, agree = 0, panics = 0;
cases.forEach((c, i) => {
  const p = pearl[i];
  if (!p || p.name !== c.name) throw new Error(`verdicts out of step at ${i}`);
  if (p.why && /PANIC/.test(p.why)) panics++;
  if (c.ours && !p.accepts) { bugs++; console.log(`BUG  we accept, Pearl refuses: ${c.name} -- Pearl: ${p.why}`); }
  else if (c.ours && p.accepts && c.ours_hash !== p.jackpot_hash) { bugs++; console.log(`BUG  both accept, hashes differ: ${c.name}`); }
  else if (!c.ours && p.accepts) { stricter++; console.log(`stricter than Pearl: ${c.name} -- ours: ${c.ours_why}`); }
  else agree++;
});
console.log(`\n${cases.length} cases: ${agree} agree, ${stricter} where we are stricter, ${bugs} BUGS; Pearl's verifier panicked on ${panics}`);
process.exit(bugs ? 1 : 0);
