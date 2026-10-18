// ?feed=http://127.0.0.1:8787 points the page at a local pool for testing.
const FEED = (() => {
  const q = new URLSearchParams(location.search).get("feed");
  return q && /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(q) ? q : "https://pool.aperture.institute";
})() + "/health.json";
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const WORD = { operational: "Operational", degraded: "Degraded", outage: "Outage", nodata: "No data" };
const HEAD = { operational: "All systems operational", degraded: "Some systems degraded", outage: "Partial outage" };

function num(v, d = 2) { return v == null || !isFinite(v) ? "n/a" : Number(v).toLocaleString(undefined, { maximumFractionDigits: d }); }
function usd(v) { return v == null || !isFinite(v) ? "n/a" : "$" + (v < 1 ? Number(v).toFixed(4) : Number(v).toLocaleString(undefined, { maximumFractionDigits: 2 })); }
function when(ms, dateOnly) {
  const d = new Date(ms);
  return dateOnly ? d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })
                  : d.toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}
function ago(ms) {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  return s < 90 ? `${s} s ago` : s < 5400 ? `${Math.round(s / 60)} min ago` : `${Math.round(s / 3600)} h ago`;
}

function renderComps(j) {
  const html = Object.entries(j.components).map(([key, c]) => {
    const days = c.days || [];
    const seen = days.filter((d) => d.uptime != null);
    const up = seen.length ? seen.reduce((a, d) => a + d.uptime, 0) / seen.length : null;
    const bars = days.map((d) => `<i class="${d.state}" title="${esc(d.day)}: ${d.uptime == null ? "no data" : (d.uptime * 100).toFixed(2) + "% up, " + WORD[d.state].toLowerCase()}"></i>`).join("");
    const meta = [c.miners != null ? `${c.miners} miner${c.miners === 1 ? "" : "s"}` : null, c.ms ? `${c.ms} ms` : null].filter(Boolean).join(" · ");
    return `<div class="comp">
      <div class="top"><b>${esc(c.name)}</b><span class="state ${c.state}">${WORD[c.state] || esc(c.state)}</span><span class="meta">${esc(meta)}</span></div>
      ${c.why ? `<p class="why">${esc(c.why)}</p>` : ""}
      <div class="bars" role="img" aria-label="${esc(c.name)}: ${up == null ? "no history yet" : (up * 100).toFixed(2) + "% uptime over the days with data"}">${bars}</div>
      <div class="axis"><span>90 days ago</span><span>${up == null ? "no history yet" : (up * 100).toFixed(2) + "% uptime"}</span><span>today</span></div>
    </div>`;
  }).join("");
  $("comps").innerHTML = html;
}

function renderPot(p) {
  const have = (p.rvnHeld || 0) + (p.rvnUnpaid || 0);
  const pct = p.threshold ? Math.min(100, (have / p.threshold) * 100) : 0;
  const eta = p.etaDays == null ? "no RVN coming in right now" : p.etaDays === 0 ? "ready to swap now" : `about ${Math.ceil(p.etaDays)} day${Math.ceil(p.etaDays) === 1 ? "" : "s"} at the current rate`;
  $("pot").innerHTML = `
    <div class="grid">
      <div><b>${num(p.rvnEarnedTotal)} RVN</b><span>earned by the pool, all time</span></div>
      <div><b>${num(p.rvnPerDay)} RVN</b><span>earned in the last day</span></div>
      <div><b>${num(have)} RVN</b><span>waiting to be swapped (${num(p.rvnHeld)} held, ${num(p.rvnUnpaid)} at zpool)</span></div>
      <div><b>${num(p.ethHeld, 6)} ETH</b><span>in the treasury, ready to pay out</span></div>
      <div><b>${usd(p.valueUsd)}</b><span>the whole pot in dollars</span></div>
      <div><b>${p.payouts == null ? "n/a" : num(p.payouts, 0)}</b><span>payouts made</span></div>
    </div>
    <div class="meter">
      <div class="track" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct.toFixed(0)}" aria-label="RVN collected toward the next swap"><div class="fill" style="width:${pct.toFixed(2)}%"></div></div>
      <p>${num(have)} of ${num(p.threshold)} RVN toward the next swap to ETH (${esc(p.thresholdFrom)}): ${eta}.</p>
    </div>
    <p class="note">Payouts are paid from the treasury's ETH. Mining income arrives as RVN and is swapped to ETH once it reaches the threshold above; ETH added to the treasury directly is paid out without waiting for a swap.</p>`;
  $("pot-at").textContent = p.factsAt ? `updated ${ago(p.factsAt)}` : "";
}

function renderIncs(list) {
  if (!list.length) { $("incs").innerHTML = `<p class="empty">No incidents recorded.</p>`; return; }
  $("incs").innerHTML = list.map((i) => {
    const span = i.resolvedAt ? `${when(i.startedAt, i.dateOnly)} to ${when(i.resolvedAt, i.dateOnly)}` : `since ${when(i.startedAt, i.dateOnly)}, ongoing`;
    const ups = [...i.updates].reverse().map((u) => `<li><b>${esc(u.status)}</b>${i.dateOnly ? "" : `<span class="when">${esc(when(u.at))} </span>`}${esc(u.text)}</li>`).join("");
    return `<div class="inc"><h3>${esc(i.title)} <span class="state ${i.resolvedAt ? "operational" : i.severity}">${i.resolvedAt ? "Resolved" : WORD[i.severity] || ""}</span></h3>
      <div class="when">${esc(span)}</div><ol>${ups}</ol></div>`;
  }).join("");
}

async function load() {
  try {
    const r = await fetch(FEED, { cache: "no-store" });
    const j = await r.json().catch(() => null);
    if (!r.ok || !j || !j.components) throw new Error((j && j.why) || `the feed answered ${r.status}`);
    const box = $("overall");
    box.className = "s-" + j.overall;
    $("ov-title").textContent = HEAD[j.overall] || j.overall;
    $("ov-sub").textContent = `Checked ${ago(j.generatedAt)}.`;
    $("feed").className = ""; $("feed").textContent = "";
    renderComps(j); renderPot(j.pot); renderIncs(j.incidents || []);
  } catch (e) {
    $("overall").className = "s-outage";
    $("ov-title").textContent = "Status feed unreachable";
    $("ov-sub").textContent = "The pool's status feed did not answer. The pool itself may be down.";
    $("feed").className = "err"; $("feed").textContent = `Reason: ${e.message}. Retrying every minute.`;
  }
}
load();
setInterval(load, 60_000);
