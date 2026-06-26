// ACE Wave Park — Signal Relay Live Ops Dashboard
// Read-only static server. Serves /public. No upstream writes, no proxying of mutations.
const express = require("express");
const path = require("path");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 3000;

// Static dashboard (the page calls the licensing + relay APIs directly from the browser).
app.use(
  express.static(path.join(__dirname, "public"), {
    etag: false,
    setHeaders(res) {
      res.setHeader("Cache-Control", "no-store, max-age=0");
    },
  })
);

// ---------------------------------------------------------------------------
// /names — read-only map of relay group id -> { label, email }
//
// Source: the Hub Supabase project (active licenses joined to profiles), queried
// via the Supabase Management API. The token is read from process.env.HUB_MGMT_TOKEN
// and is NEVER committed (this repo is public). Result is cached in memory for 60s
// so the Hub is not hit on every dashboard refresh. On any failure we return {} so
// the dashboard still renders without names.
// ---------------------------------------------------------------------------
const HUB_PROJECT_REF = "ecsabdrcoiivtgnoemux";
const HUB_QUERY =
  "select l.license_key, p.discord_display_name, p.discord_username, " +
  "p.full_name, p.first_name, p.email " +
  "from hub_licenses l join profiles p on p.id = l.user_id " +
  "where l.status = 'active';";
const STRATEGIES = ["SKIMBOARD", "MASTERTESTER"];
const NAMES_TTL_MS = 60 * 1000;

let namesCache = { ts: 0, data: {} };

// Relay group id for (licenseKey, strategy) — VERIFIED to match the live /api/groups.
function groupId(licenseKey, strategy) {
  const prefix = String(strategy).toLowerCase().replace(/[^a-z0-9]/g, "");
  const h = crypto
    .createHash("sha256")
    .update(licenseKey + prefix)
    .digest("hex");
  return prefix + "-" + h.substring(0, 12);
}

// First non-empty of: discord_display_name -> discord_username -> full_name
// -> first_name -> email local-part.
function pickLabel(row) {
  const candidates = [
    row.discord_display_name,
    row.discord_username,
    row.full_name,
    row.first_name,
  ];
  for (const c of candidates) {
    if (c && String(c).trim()) return String(c).trim();
  }
  if (row.email && String(row.email).indexOf("@") > -1) {
    return String(row.email).split("@")[0];
  }
  return null;
}

async function fetchNamesFromHub() {
  const token = process.env.HUB_MGMT_TOKEN;
  if (!token) {
    console.warn("[ops-dashboard] HUB_MGMT_TOKEN not set — /names returns {}");
    return {};
  }
  const res = await fetch(
    "https://api.supabase.com/v1/projects/" + HUB_PROJECT_REF + "/database/query",
    {
      method: "POST",
      headers: {
        Authorization: "Bearer " + token,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query: HUB_QUERY }),
    }
  );
  if (!res.ok) {
    throw new Error("Hub query HTTP " + res.status);
  }
  const rows = await res.json();
  if (!Array.isArray(rows)) {
    throw new Error("Hub query returned non-array");
  }
  const map = {};
  for (const row of rows) {
    if (!row || !row.license_key) continue;
    const entry = { label: pickLabel(row), email: row.email || null };
    // A user appears under both strategies — map every group id to the same record.
    for (const strat of STRATEGIES) {
      map[groupId(row.license_key, strat)] = entry;
    }
  }
  return map;
}

app.get("/names", async (_req, res) => {
  res.setHeader("Cache-Control", "no-store, max-age=0");
  const now = Date.now();
  if (namesCache.data && now - namesCache.ts < NAMES_TTL_MS) {
    return res.json(namesCache.data);
  }
  try {
    const data = await fetchNamesFromHub();
    namesCache = { ts: now, data };
    return res.json(data);
  } catch (err) {
    console.error("[ops-dashboard] /names error:", err && err.message);
    // Serve a stale cache if we have one; otherwise empty so the page still renders.
    if (namesCache.data && Object.keys(namesCache.data).length) {
      return res.json(namesCache.data);
    }
    return res.json({});
  }
});

// Simple health endpoint for Railway / uptime checks.
app.get("/healthz", (_req, res) => {
  res.json({ status: "ok", service: "wavepark-ops-dashboard", ts: new Date().toISOString() });
});

app.get("/", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`[ops-dashboard] listening on :${PORT}`);
});
