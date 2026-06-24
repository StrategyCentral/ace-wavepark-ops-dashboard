# ACE Wave Park — Signal Relay Live Ops Dashboard

A **read-only** live ops view of the Wave Park signal relay. Shows the flow:

```
MASTER (MASTERTESTER / SKIMBOARD)  →  ACE RELAY  →  each subscriber's BoardShop child
```

Left = the master. Middle = the relay. Right = one line per subscriber, with live "cables"
connecting master → relay → each user. Auto-refreshes every 10 seconds.

This service **never writes** to any upstream system. It only issues HTTP `GET` requests
(with a cache-bust param) to the licensing and relay APIs, straight from the browser.

---

## What each user line shows

- License key (masked, e.g. `WAVE-8827-...`) + short group id
- **in-group** flag — yes if the license also appears in the MASTERTESTER strategy (paired/eligible)
- **child connected** flag — from relay `/stats` `children > 0`, falling back to licensing `last_seen` freshness
- **Last validation** — from `/api/groups` `last_seen`
- **Last signal** — from relay `/stats` `lastMessageAt` (shows `—` until `/stats` JSON ships)

Cable / row colour: **green pulse = live**, **amber = stale (seen in last 24h)**, **grey = disconnected**.

---

## Data sources (all read-only GET)

| Source | URL |
|--------|-----|
| Subscribers (SKIMBOARD) | `…/api/groups?strategy=SKIMBOARD` |
| Masters (MASTERTESTER)  | `…/api/groups?strategy=MASTERTESTER` |
| Relay per-group stats   | `https://ace-relay-production.up.railway.app/stats` |
| Licensing health        | `…/health` |

`/stats` is handled defensively: it currently returns plain text `ACE Relay: OK`
(relay alive, no per-group JSON yet). The dashboard still renders every subscriber from
`/api/groups` and shows "online (no per-group stats yet)". When the parallel task ships the
JSON shape `{groups:[{group,children,masters,lastMessageAt,messagesToday}],uptime}`, the rows
light up automatically (joined by `group` id) — no code change needed. A 404 shows
"relay stats unavailable" and still renders users.

---

## Run locally

```bash
cd ops-dashboard
npm install
npm start          # http://localhost:3000
```

---

## Deploy to Railway

This is a standard Node/Express static service. Pick one:

### Option 1 — Railway CLI (fastest)
```bash
npm i -g @railway/cli
railway login
cd ops-dashboard
railway init            # create a new project, e.g. "ace-wavepark-ops-dashboard"
railway up              # build + deploy from this folder
railway domain          # generate a public *.up.railway.app URL
```

### Option 2 — GitHub + Railway dashboard
1. Push this `ops-dashboard/` folder to a new repo (e.g. `StrategyCentral/ace-wavepark-ops-dashboard`).
2. In Railway → **New Project → Deploy from GitHub repo** → pick the repo.
3. Railway auto-detects Node (Nixpacks), runs `npm install`, then `node server.js` (from `railway.toml`).
4. Settings → **Networking → Generate Domain** to get the public URL.

No environment variables are required. The upstream API URLs are hard-coded in
`public/index.html` (they are public production URLs). `PORT` is provided by Railway automatically.

### Health check
`GET /healthz` → `{"status":"ok",...}` (wired into `railway.toml`).

---

## Files

```
ops-dashboard/
  public/index.html   ← the whole dashboard (inline CSS + vanilla JS, no build, no deps)
  server.js           ← tiny Express static server
  package.json        ← express only
  railway.toml        ← start command + health check
  .gitignore
  README.md
```
