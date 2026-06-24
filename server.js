// ACE Wave Park — Signal Relay Live Ops Dashboard
// Read-only static server. Serves /public. No upstream writes, no proxying of mutations.
const express = require("express");
const path = require("path");

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
