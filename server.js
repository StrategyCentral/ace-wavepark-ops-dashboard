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
const TRADES_SQL =
  "with last_ev as (" +
  "  select distinct on (license_key) license_key, event_type, action, price, pnl, occurred_at" +
  "  from bot_events order by license_key, occurred_at desc)," +
  "agg as (" +
  "  select license_key," +
  "    count(*) filter (where event_type='exit' and occurred_at >= now() - interval '24 hours') as exits_24h," +
  "    coalesce(sum(pnl) filter (where occurred_at >= now() - interval '24 hours'),0) as pnl_24h," +
  "    coalesce(sum(case when event_type='exit' and pnl>0 and occurred_at >= now() - interval '24 hours' then 1 else 0 end),0) as wins_24h" +
  "  from bot_events group by 1)" +
  "select l.license_key, l.event_type as last_type, l.action as last_action, l.price as last_price," +
  "       l.pnl as last_pnl, l.occurred_at as last_at," +
  "       coalesce(a.exits_24h,0) as exits_24h, coalesce(a.pnl_24h,0) as pnl_24h, coalesce(a.wins_24h,0) as wins_24h " +
  "from last_ev l left join agg a using (license_key)";

const tradesCache = cached(60000);
async function buildTrades() {
  if (!HUB_TOKEN) return { groups: {}, count: 0, source: "no HUB_MGMT_TOKEN set" };
  const rows = await hubQuery(TRADES_SQL);
  const groups = {};
  (rows || []).forEach((row) => {
    const key = row.license_key;
    if (!key) return;
    const rec = {
      lastType: row.last_type, lastAction: row.last_action,
      lastPrice: row.last_price != null ? Number(row.last_price) : null,
      lastPnl: row.last_pnl != null ? Number(row.last_pnl) : null,
      lastAt: row.last_at,
      exits24h: Number(row.exits_24h) || 0,
      pnl24h: Number(row.pnl_24h) || 0,
      wins24h: Number(row.wins_24h) || 0,
    };
    bothGroups(key).forEach((g) => (groups[g] = rec));
  });
  return { groups, count: Object.keys(groups).length, source: "hub" };
}
app.get("/trades", async (_req, res) => {
  res.set("Cache-Control", "no-store");
  try { res.json(await tradesCache(buildTrades)); }
  catch (e) { res.json({ groups: {}, count: 0, source: "error: " + e.message }); }
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
