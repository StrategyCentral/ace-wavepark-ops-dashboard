// ACE Wave Park — Signal Relay Live Ops Dashboard
// Read-only. Serves /public + two server-side Hub proxies:
//   /names   relay GROUP IDs -> Discord display names      (Hub: hub_licenses + profiles)
//   /trades  relay GROUP IDs -> real fills (entry/exit/PnL) (Hub: bot_events telemetry)
// No upstream writes. The Hub management token is read from the environment, never committed.
const express = require("express");
const path = require("path");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 3000;

// ── Customer Hub Supabase (source of Discord names + bot_events trade telemetry) ──
// Railway env vars (NOT committed — repo is public):
//   HUB_MGMT_TOKEN   Supabase management token (sbp_...)
//   HUB_PROJECT_REF  Hub project ref (default below)
const HUB_TOKEN = process.env.HUB_MGMT_TOKEN || "";
const HUB_REF = process.env.HUB_PROJECT_REF || "ecsabdrcoiivtgnoemux";
const PREFIXES = ["skimboard", "mastertester"];

// group id = "<prefix>-" + sha256(licenseKey + prefix) first 12 hex (verified against live data)
function groupId(licenseKey, prefix) {
  return prefix + "-" + crypto.createHash("sha256").update(licenseKey + prefix).digest("hex").slice(0, 12);
}
function bothGroups(licenseKey) {
  return PREFIXES.map((p) => groupId(licenseKey, p));
}

async function hubQuery(sql) {
  const r = await fetch(`https://api.supabase.com/v1/projects/${HUB_REF}/database/query`, {
    method: "POST",
    headers: { Authorization: `Bearer ${HUB_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query: sql }),
  });
  if (!r.ok) throw new Error("hub " + r.status);
  return r.json(); // array of rows
}

// 60s cache wrapper
function cached(ttl) {
  let at = 0, data = null, inflight = null;
  return async function (producer) {
    if (data && Date.now() - at < ttl) return data;
    if (inflight) return inflight;
    inflight = producer()
      .then((d) => { data = d; at = Date.now(); inflight = null; return d; })
      .catch((e) => { inflight = null; throw e; });
    return inflight;
  };
}

// ── /names ──────────────────────────────────────────────────────────────────
const NAMES_SQL =
  process.env.NAMES_SQL ||
  "select l.license_key as license_key, " +
  "coalesce(nullif(p.discord_display_name,''), nullif(p.discord_username,''), nullif(p.full_name,'')) as discord_name " +
  "from hub_licenses l join profiles p on p.id = l.user_id " +
  "where coalesce(nullif(p.discord_display_name,''), nullif(p.discord_username,''), nullif(p.full_name,'')) is not null";

const namesCache = cached(60000);
async function buildNames() {
  if (!HUB_TOKEN) return { groups: {}, count: 0, source: "no HUB_MGMT_TOKEN set" };
  const rows = await hubQuery(NAMES_SQL);
  const groups = {};
  (rows || []).forEach((row) => {
    const key = row.license_key, name = row.discord_name;
    if (key && name) bothGroups(key).forEach((g) => (groups[g] = name));
  });
  return { groups, count: Object.keys(groups).length, source: "hub" };
}
app.get("/names", async (_req, res) => {
  res.set("Cache-Control", "no-store");
  try { res.json(await namesCache(buildNames)); }
  catch (e) { res.json({ groups: {}, count: 0, source: "error: " + e.message }); }
});

// ── /trades  (PUBLIC-SAFE — aggregate performance ONLY) ───────────────────────
// SECURITY (Kruges 2026-07-01): the response must NEVER contain entry/stop/target/exit PRICES,
// trade DIRECTION, exact trade TIMES, or a per-trade list — that raw data lets anyone clone the
// strategy straight from the browser Network tab. We return ONLY aggregate proof: 24h
// trades/wins/PnL per strategy + a coarse last-outcome (win/loss + age in whole minutes).
const AGG_SQL =
  "select e.license_key, coalesce(s.strategy,'?') as strat, " +
  "count(*) filter (where e.event_type='exit') as trades, " +
  "coalesce(sum(case when e.event_type='exit' and e.pnl>0 then 1 else 0 end),0) as wins, " +
  "round(coalesce(sum(e.pnl),0)) as pnl " +
  "from bot_events e left join bot_status s on s.license_key=e.license_key and s.hardware_id=e.hardware_id " +
  "where e.occurred_at >= now() - interval '24 hours' group by 1,2";
// last_result/last_age = the last COMPLETED trade (exit). open_now = the newest event is an entry
// AND it's recent (<45 min) — otherwise a missing exit-telemetry leaves a stale entry that would
// wrongly read "in a trade now" for hours. These strategies close within minutes, so >45 min open
// = a dropped exit event, not a live position.
const LAST_SQL =
  "with lastev as (" +
  "select distinct on (license_key) license_key, event_type as t, " +
  "floor(extract(epoch from now()-occurred_at)/60)::int as age_min " +
  "from bot_events order by license_key, occurred_at desc), " +
  "lastexit as (" +
  "select distinct on (license_key) license_key, " +
  "(case when coalesce(pnl,0)>=0 then 'win' else 'loss' end) as result, " +
  "floor(extract(epoch from now()-occurred_at)/60)::int as age_min " +
  "from bot_events where event_type='exit' order by license_key, occurred_at desc) " +
  "select le.license_key, lx.result as last_result, lx.age_min as last_age_min, " +
  "(le.t='entry' and le.age_min < 45) as open_now " +
  "from lastev le left join lastexit lx using(license_key)";
const tradesCache = cached(60000);
async function buildTrades() {
  if (!HUB_TOKEN) return { groups: {}, count: 0, source: "no HUB_MGMT_TOKEN set" };
  const [agg, last] = await Promise.all([hubQuery(AGG_SQL), hubQuery(LAST_SQL)]);
  const byLic = {};
  const rec = (k) => (byLic[k] = byLic[k] || { byStrat: {}, strategy: null, lastResult: null, lastAgeMin: null, openNow: false });
  (agg || []).forEach((a) => {
    if (!a.license_key) return;
    const strat = a.strat && a.strat !== "?" ? a.strat : "Other";
    rec(a.license_key).byStrat[strat] = { trades: Number(a.trades) || 0, wins: Number(a.wins) || 0, pnl: Number(a.pnl) || 0 };
  });
  (last || []).forEach((l) => {
    if (!l.license_key) return;
    const r = rec(l.license_key);
    r.lastResult = l.last_result || null;
    r.lastAgeMin = l.last_age_min != null ? Number(l.last_age_min) : null;
    r.openNow = l.open_now === true || l.open_now === "true";
  });
  const groups = {};
  Object.keys(byLic).forEach((k) => {
    const r = byLic[k];
    r.strategy = Object.keys(r.byStrat)[0] || null;
    bothGroups(k).forEach((g) => (groups[g] = r));
  });
  return { groups, count: Object.keys(groups).length, source: "hub" };
}
app.get("/trades", async (_req, res) => {
  res.set("Cache-Control", "no-store");
  try { res.json(await tradesCache(buildTrades)); }
  catch (e) { res.json({ groups: {}, count: 0, source: "error: " + e.message }); }
});

// ── /relaystats  (proxy the relay's /stats) ──────────────────────────────────
// The relay only sends CORS Access-Control-Allow-Origin: https://acetradingbots.com, so the
// browser CANNOT fetch it directly from this dashboard's origin (it shows "relay down" even
// though the relay is healthy). We fetch it server-side (no CORS) and hand it back same-origin.
const RELAY_STATS_URL = process.env.RELAY_STATS_URL || "https://ace-relay-production.up.railway.app/stats";
app.get("/relaystats", async (_req, res) => {
  res.set("Cache-Control", "no-store");
  try {
    const r = await fetch(RELAY_STATS_URL, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) return res.status(502).json({ __down: true, status: r.status });
    const j = await r.json();
    // SECURITY: strip the ABSOLUTE lastMessageAt (a signal's exact wall-clock fire time is IP).
    // Expose only counts + a coarse age (rounded to 30s) — enough for the "hot"/animation, not
    // enough to pin the strategy's signal clock.
    const now = Date.now();
    const groups = (j.groups || []).map((g) => {
      let ageSec = null;
      if (g.lastMessageAt) {
        const a = Math.max(0, Math.round((now - new Date(g.lastMessageAt).getTime()) / 1000));
        ageSec = Math.round(a / 30) * 30;
      }
      return { group: g.group, children: g.children || 0, masters: g.masters || 0, messagesToday: g.messagesToday || 0, ageSec };
    });
    res.json({ uptimeSeconds: j.uptimeSeconds, groups });
  } catch (e) {
    res.status(502).json({ __down: true, error: e.message });
  }
});

// Static dashboard (the page also calls the licensing API directly).
app.use(express.static(path.join(__dirname, "public"), {
  etag: false,
  setHeaders(res) { res.setHeader("Cache-Control", "no-store, max-age=0"); },
}));

app.get("/healthz", (_req, res) =>
  res.json({ status: "ok", service: "wavepark-ops-dashboard", hubNames: !!HUB_TOKEN, ts: new Date().toISOString() })
);
app.get("/", (_req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

app.listen(PORT, () =>
  console.log(`[ops-dashboard] listening on :${PORT}  (hub: ${HUB_TOKEN ? "enabled" : "DISABLED — set HUB_MGMT_TOKEN"})`)
);
