// The status page: reads the pool's /health.json once a minute and lays it out
// the way every status page does. ?feed=http://127.0.0.1:8787 points it at a
// local pool for testing; nothing else is accepted.
const FEED = (() => {
  const q = new URLSearchParams(location.search).get("feed");
  return q && /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(q) ? q : "https://pool.aperture.institute";
})() + "/health.json";
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const WORD = { operational: "Operational", degraded: "Degraded Performance", outage: "Outage", nodata: "No data" };
const DAYS_OF_INCIDENTS = 15;

function headline(j) {
  const states = Object.values(j.components).map((c) => c.state);
  if (states.every((s) => s === "operational")) return "All Systems Operational";
  if (states.every((s) => s === "outage")) return "Major System Outage";
  if (states.includes("outage")) return "Partial System Outage";
  return "Degraded Performance";
}
function num(v, d = 2) { return v == null || !isFinite(v) ? "n/a" : Number(v).toLocaleString(undefined, { maximumFractionDigits: d }); }
function usd(v) { return v == null || !isFinite(v) ? "n/a" : "$" + (v < 1 ? Number(v).toFixed(4) : Number(v).toLocaleString(undefined, { maximumFractionDigits: 2 })); }
const dateOf = (ms) => new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
const timeOf = (ms) => new Date(ms).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
function ago(ms) {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  return s < 90 ? `${s} s ago` : s < 5400 ? `${Math.round(s / 60)} min ago` : `${Math.round(s / 3600)} h ago`;
}
const capital = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
// A reason naming the payout plumbing (the exchange, the source chain's
// explorer, the coin the pool is paid in) is said plainly instead.
const clean = (s) => (/changenow|blockbook|ravencoin|\brvn\b|swap/i.test(String(s || "")) ? "part of the payout system is not responding" : s);

function renderComps(j) {
  $("comps").innerHTML = Object.values(j.components).map((c) => {
    const days = c.days || [];
    const seen = days.filter((d) => d.uptime != null);
    const up = seen.length ? seen.reduce((a, d) => a + d.uptime, 0) / seen.length : null;
    const bars = days.map((d) => `<i class="${d.state}" title="${esc(d.day)}: ${d.uptime == null ? "no data" : (d.uptime * 100).toFixed(2) + "% uptime"}"></i>`).join("");
    const why = c.state !== "operational" && c.why ? `<p class="why">${esc(capital(clean(c.why)))}</p>` : "";
    const upTxt = up == null ? "no data yet" : `${(up * 100).toFixed(2)} % uptime`;
    return `<div class="comp">
      <div class="row"><span class="name">${esc(c.name)}</span><span class="state ${c.state}">${WORD[c.state] || esc(c.state)}</span></div>${why}
      <div class="bars" role="img" aria-label="${esc(c.name)}, ${upTxt} over the past 90 days">${bars}</div>
      <div class="axis"><span class="ninety">90 days ago</span><span class="rule"></span><span>${upTxt}</span><span class="rule"></span><span>Today</span></div>
    </div>`;
  }).join("");
}

function renderPot(p) {
  const have = (p.rvnHeld || 0) + (p.rvnUnpaid || 0);
  const pct = p.threshold ? Math.min(100, (have / p.threshold) * 100) : 0;
  // Everything here is in dollars: what the pool has mined, what is ready to
  // pay out, and how far the pot is from the next payout round.
  const px = p.prices || {};
  const dollars = (rvn) => (px.rvn && rvn != null ? rvn * px.rvn : null);
  const ready = px.eth ? (p.ethHeld || 0) * px.eth : null;
  const eta = p.etaDays == null ? "waiting for mining to resume" : p.etaDays === 0 ? "ready to go out"
    : `about ${Math.ceil(p.etaDays)} day${Math.ceil(p.etaDays) === 1 ? "" : "s"} away at the current pace`;
  $("pot").innerHTML = `
    <div class="metrics">
      <div><b>${usd(dollars(p.rvnEarnedTotal))}</b><span>mined by the pool, all time</span></div>
      <div><b>${usd(dollars(p.rvnPerDay))}</b><span>mined in the last day</span></div>
      <div><b>${usd(ready)}</b><span>ready to pay out now</span></div>
      <div><b>${usd(p.valueUsd)}</b><span>in the payout pot</span></div>
      <div><b>${p.payouts == null ? "n/a" : num(p.payouts, 0)}</b><span>payouts made</span></div>
    </div>
    <div class="meter">
      <div class="track" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct.toFixed(0)}" aria-label="Progress toward the next payout round"><div class="fill" style="width:${pct.toFixed(2)}%"></div></div>
      <p>The pot is ${pct < 1 && pct > 0 ? "under 1" : pct.toFixed(0)}% of the way to the next payout round: ${eta}. Every payout is split equally between the miners who did the work.</p>
    </div>`;
  $("pot-at").textContent = p.factsAt ? `Updated ${ago(p.factsAt)}` : "";
}

// Past incidents the Statuspage way: the last DAYS_OF_INCIDENTS days, a heading
// each, with the incidents that started that day or "No incidents reported."
function renderIncs(list) {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  let html = "";
  for (let i = 0; i < DAYS_OF_INCIDENTS; i++) {
    const start = today.getTime() - i * 86_400_000, end = start + 86_400_000;
    const those = list.filter((x) => x.startedAt >= start && x.startedAt < end);
    const body = those.length ? those.map((x) => {
      const cls = x.resolvedAt ? "resolved" : x.severity;
      const ups = [...x.updates].reverse().map((u) =>
        `<p class="upd"><b>${esc(capital(u.status))}</b> - ${esc(clean(u.text))}${x.dateOnly ? "" : `<span class="t">${esc(timeOf(u.at))}</span>`}</p>`).join("");
      return `<div class="inc"><div class="title ${cls}">${esc(x.title)}</div>${ups}</div>`;
    }).join("") : `<p class="none">No incidents reported.</p>`;
    html += `<div class="day"><h3>${esc(dateOf(start))}</h3>${body}</div>`;
  }
  $("incs").innerHTML = html;
}

async function load() {
  try {
    const r = await fetch(FEED, { cache: "no-store" });
    const j = await r.json().catch(() => null);
    if (!r.ok || !j || !j.components) throw new Error((j && j.why) || `the feed answered ${r.status}`);
    const b = $("banner");
    b.className = j.overall;
    b.firstChild.textContent = headline(j);
    $("banner-sub").textContent = j.overall === "operational" ? "Mining and payouts are running normally." : "Details for each part of the pool are below.";
    $("checked").textContent = `Checked ${ago(j.generatedAt)}`;
    $("feed").hidden = true;
    renderComps(j); renderPot(j.pot); renderIncs(j.incidents || []);
  } catch (e) {
    const b = $("banner");
    b.className = "outage";
    b.firstChild.textContent = "Status Unavailable";
    $("banner-sub").textContent = "The pool's status feed did not answer, so the pool itself may be down.";
    $("feed").hidden = false;
    $("feed").textContent = `Reason: ${capital(e.message)}. Retrying every minute.`;
  }
}
load();
setInterval(load, 60_000);
