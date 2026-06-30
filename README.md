# ACE Wave Park — Signal Relay Live Ops Dashboard

A **read-only** live ops view of the Wave Park signal relay:

```
MASTER (MASTERTESTER / SKIMBOARD)  →  ACE RELAY  →  each subscriber's BoardShop child
```

Top = the two animated signal feeds (MASTERTESTER test feed + SKIMBOARD live feed).
Below = the flow: master (left) → relay (middle) → one line per subscriber (right), with
animated "cables" carrying signal pulses. Auto-refreshes every 10s. Never writes to anything.

## What each user line shows

- **Discord display name** (from the Hub via `/names`). Falls back to a short anonymized group
  id if no name is set — **real customer names are never shown**.
- **Feed chips** — `SKIMBOARD` (live trades) and `MASTERTESTER` (test), each lit when that
  feed's child is connected, with the last-signal time on that feed.
- **Took signal** — `✓ took signal on <FEED>` when the subscriber's child is connected and a
  signal arrived recently (received + acting). Shows which feed it came on.
- **child** flag — relay `/stats` `children > 0`.

Row / cable colour: **green pulse = live child**, **amber = stale**, **grey = disconnected**.

> Note: "took signal" = child connected at signal time (delivery + active link). True trade-execution
> confirmation needs child trade telemetry persisted (the licensing `trade_logs` table is currently
> empty); when that's wired, the line can show the actual fill.

## Data sources (all read-only)

| Source | URL |
|--------|-----|
| Subscribers (SKIMBOARD)  | `…/api/groups?strategy=SKIMBOARD` |
| Subscribers (MASTERTESTER) | `…/api/groups?strategy=MASTERTESTER` |
| Relay per-group stats    | `https://ace-relay-production.up.railway.app/stats` |
| Discord names            | this service's own `/names` (proxies the Hub, server-side) |

## Setup — Discord names

`/names` maps relay group ids → Discord display names by reading the **Customer Hub** Supabase
server-side (group id = `"<prefix>-" + sha256(licenseKey + prefix)` first 12 hex). Set these
Railway env vars (token is in `MEMORY/shared/master-credentials.md` — **do not commit it**, this repo is public):

- `HUB_MGMT_TOKEN` — Hub Supabase management token (`sbp_…`)
- `HUB_PROJECT_REF` — Hub project ref (defaults to `ecsabdrcoiivtgnoemux`)
- `NAMES_SQL` *(optional)* — override the lookup SQL if the Hub schema differs; must return
  rows of `(license_key, discord_name)`.

Without `HUB_MGMT_TOKEN` the dashboard still runs and shows anonymized group ids (no names).
If names don't appear after setting the token, the Hub table/column differs from the default
guesses — set `NAMES_SQL` (or send the Hub schema for `license_key ↔ discord_display_name`).

## Run locally

```bash
cd ops-dashboard
npm install
npm start          # http://localhost:3000 ; health at /healthz
```

## Deploy to Railway

Standard Node/Express service (`railway.toml` sets start `node server.js`, health `/healthz`).
Deploy via your usual path (GitHub push or `railway up`), then set the env vars above in the
Railway service for Discord names to resolve.
