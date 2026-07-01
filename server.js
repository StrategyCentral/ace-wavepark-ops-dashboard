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

// ── /trades  (real fills from Hub bot_events) ─────────────────────────────────
// Each trade is tagged with its STRATEGY by joining bot_status on (license, hardware) — bot_events
// has no strategy column of its own. Times are formatted to US Eastern (handles EST/EDT) server-side.
const RECENT_SQL =
  "select t.license_key, t.strat, t.event_type, t.action, t.price, t.pnl, t.detail, t.est from (" +
  "select e.license_key, s.strategy as strat, e.event_type, e.action, e.price, e.pnl, e.detail, " +
  "to_char(e.occurred_at at time zone 'America/New_York','Mon DD, HH12:MI AM') as est, e.occurred_at, " +
  "row_number() over (partition by e.license_key order by e.occurred_at desc) rn " +
  "from bot_events e left join bot_status s on s.license_key=e.license_key and s.hardware_id=e.hardware_id" +
  ") t where t.rn <= 12 order by t.license_key, t.occurred_at desc";

const AGG_SQL =
  "select e.license_key, coalesce(s.strategy,'?') as strat, " +
  "count(*) filter (where e.event_type='exit') as trades, " +
  "coalesce(sum(case when e.event_type='exit' and e.pnl>0 then 1 else 0 end),0) as wins, " +
  "round(coalesce(sum(e.pnl),0)) as pnl " +
  "from bot_events e left join bot_status s on s.license_key=e.license_key and s.hardware_id=e.hardware_id " +
  "where e.occurred_at >= now() - interval '24 hours' group by 1,2";

const tradesCache = cached(60000);
async function buildTrades() {
  if (!HUB_TOKEN) return { groups: {}, count: 0, source: "no HUB_MGMT_TOKEN set" };
  const [recent, agg] = await Promise.all([hubQuery(RECENT_SQL), hubQuery(AGG_SQL)]);
  const byLic = {};
  const rec = (k) => (byLic[k] = byLic[k] || { recent: [], byStrat: {}, strategy: null, last: null });
  (recent || []).forEach((r) => {
    if (!r.license_key) return;
    rec(r.license_key).recent.push({
      type: r.event_type, action: r.action,
      price: r.price != null ? Number(r.price) : null,
      pnl: r.pnl != null ? Number(r.pnl) : null,
      est: r.est, strat: r.strat, detail: r.detail,
    });
  });
  (agg || []).forEach((a) => {
    if (!a.license_key) return;
    const strat = a.strat && a.strat !== "?" ? a.strat : "Other";
    rec(a.license_key).byStrat[strat] = { trades: Number(a.trades) || 0, wins: Number(a.wins) || 0, pnl: Number(a.pnl) || 0 };
  });
  const groups = {};
  Object.keys(byLic).forEach((k) => {
    const r = byLic[k];
    r.last = r.recent[0] || null;
    r.strategy = (r.last && r.last.strat) || Object.keys(r.byStrat)[0] || null;
    bothGroups(k).forEach((g) => (groups[g] = r));
  });
  return { groups, count: Object.keys(groups).length, source: "hub" };
}
app.get("/trades", async (_req, res) => {
  res.set("Cache-Control", "no-store");
  try { res.json(await tradesCache(buildTrades)); }
  catch (e) { res.json({ groups: {}, count: 0, source: "error: " + e.message }); }
});

// ── /signals  (signals SENT per strategy — Hub-derived so it works even if relay /stats is down) ──
// A "signal" = one distinct entry-minute across that strategy's subscribers (all children enter
// together when the master fires). MASTERTESTER fires ~every 2 min.
const SIGNALS_SQL =
  "select coalesce(s.strategy,'?') as strat, " +
  "count(distinct date_trunc('minute', e.occurred_at)) filter (where e.occurred_at >= now()-interval '24 hours') as today, " +
  "count(distinct date_trunc('minute', e.occurred_at)) filter (where e.occurred_at >= now()-interval '1 hour') as last_hr, " +
  "to_char(max(e.occurred_at) at time zone 'America/New_York','Mon DD, HH12:MI AM') as last_est, " +
  "extract(epoch from max(e.occurred_at)) as last_epoch " +
  "from bot_events e left join bot_status s on s.license_key=e.license_key and s.hardware_id=e.hardware_id " +
  "where e.event_type='entry' group by 1";
const signalsCache = cached(15000);
async function buildSignals() {
  if (!HUB_TOKEN) return { strategies: {}, source: "no HUB_MGMT_TOKEN set" };
  const rows = await hubQuery(SIGNALS_SQL);
  const strategies = {};
  (rows || []).forEach((r) => {
    const k = r.strat && r.strat !== "?" ? r.strat : "Other";
    strategies[k] = {
      today: Number(r.today) || 0, lastHr: Number(r.last_hr) || 0,
      lastEst: r.last_est || null, lastMs: r.last_epoch ? Math.round(Number(r.last_epoch) * 1000) : null,
    };
  });
  return { strategies, source: "hub" };
}
app.get("/signals", async (_req, res) => {
  res.set("Cache-Control", "no-store");
  try { res.json(await signalsCache(buildSignals)); }
  catch (e) { res.json({ strategies: {}, source: "error: " + e.message }); }
});

// Static dashboard (the page also calls the licensing + relay APIs directly).
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
