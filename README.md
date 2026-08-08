# UC-Portfolio — Momentum Dashboard & API

Cloudflare Worker + D1 database powering the UC_MOMENTUM portfolio dashboard,
strategy evaluation and analysis API.

## Architecture

```text
Market / benchmark data → Cloudflare Worker → D1 database
                               ↓
                         Dashboard + API
```

The Worker + D1 own candle-derived calculations and deterministic UC_MOMENTUM
strategy state. Broker data remains authoritative for holdings, quantities,
orders, trades and GTT execution state.

## UC_MOMENTUM v1.1 release

v1.1 moves deterministic strategy rules into `src/strategy.js` and adds:

- session-aware regime logic and fail-safe handling;
- MFI, RS20/RS60, higher-low, sufficiency and universe-ranking fields;
- real Nifty-100 membership support and financial-sector quality substitutes;
- forward-only GTT strategy floors, leader/giveback/pyramid/time-review state;
- review-only rotation logic rather than rank-only automatic replacement;
- regime-aware liquidity targets;
- dry-run refresh support that suppresses D1 writes.

Notifications are intentionally outside this release and are not a deployment
dependency.

## Runtime files

```text
src/index.js          Cloudflare Worker entry point
src/strategy.js       Pure deterministic v1.1 strategy logic
src/dashboard.html    Runtime dashboard imported by src/index.js
wrangler.toml         Worker, cron and D1 binding
```

**Important:** the repository-root `dashboard.html` is a legacy/reference copy.
The Worker imports `src/dashboard.html`; edit that file for production UI changes.
The root copy is not part of the Worker runtime.

## D1 and migrations

`wrangler.toml` binds `DB` to **`uc-portfolio-db`**. Production migration is an
EXPAND → deploy → verify → CONTRACT sequence:

```text
migrations/000_integrity_snapshot.sql  broker-owned pre-change integrity snapshot
migrations/001_v11_expand.sql          additive/backward-compatible v1.1 schema
migrations/002_v11_contract.sql        later cleanup after v1.1 is proven stable
migrations/003_integrity_verify.sql     integrity verification after refresh
```

`001_v11_expand.sql` deliberately preserves the legacy gate and rotation columns
needed by the currently deployed Worker. `002_v11_contract.sql` must not run
until v1.1 is live and verified.

`schema.sql` is a **historical bootstrap reference**, not an authoritative copy
of the current production schema. `seed.sql` is intentionally empty and must
not be used to recreate production portfolio state. Production backups/exports
belong outside GitHub.

See `DEPLOY.md` for the controlled production sequence. Neither migration is an
application startup migration.

## Development

Prerequisites: Node.js 18+ and Wrangler.

```bash
npm install -g wrangler
wrangler login
wrangler dev
```

Do not use `schema.sql` or `seed.sql` as a production initialization shortcut.
The old `db:init` script has been removed.

## Tests

Existing strategy/pre-production/freshness/cron coverage plus release-engineering
checks live under `test/`.

```bash
node test/unit.test.mjs
node test/preprod.test.mjs
node test/freshness.test.mjs
sed 's|^import DASHBOARD_HTML.*|const DASHBOARD_HTML="";|' src/index.js > src/index.build.js
node test/cron.dryrun.mjs
rm src/index.build.js
python3 test/schema_compat.py
node test/dashboard.test.mjs
```

The cron D1 mock validates SQL placeholder/bind arity, so mismatched `.bind()`
arguments fail the test rather than being silently accepted.

## API endpoints

| Endpoint | Method | Purpose |
|---|---|---|
| `/` / `/dashboard` | GET | Dashboard |
| `/api/dashboard-data` | GET | Consolidated dashboard payload |
| `/api/portfolio` | GET | Portfolio snapshot |
| `/api/holdings` | GET | Holdings + strategy state |
| `/api/trades` | GET | Trade history |
| `/api/alerts` | GET | Active alerts |
| `/api/opportunities` | GET | Scanned opportunities |
| `/api/watchlist` | GET | Watchlist |
| `/api/nav` | GET | NAV history |
| `/api/macro` | GET | Regime/macro state |
| `/api/ranking` | GET | Momentum ranking |
| `/api/scan-status` | GET | Scanner status |
| `/api/scan` | POST | On-demand candidate scan |
| `/api/refresh?dry=1` | GET | Full refresh with writes suppressed |
| `/api/refresh` | GET | Real refresh |
| `/api/kite-sync` | POST | Broker/manual authoritative inputs |

## Cron

`wrangler.toml` schedules weekdays at 10:45 UTC / 4:15 PM IST. The scheduled
handler refreshes market data, recomputes strategy state, updates NAV/liquidity
and scans the eligible universe.

## Deployment model

The repository has historically been used with Cloudflare native Git builds.
Treat any push to `main` as potentially production-impacting. Prepare releases
on a release branch, validate there, and coordinate D1 + Worker rollout before
merging the tested production commit into `main`.
