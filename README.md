# UC-Portfolio — Momentum Dashboard & API

Cloudflare Worker + D1 database powering a portfolio dashboard and analysis API for the UC_MOMENTUM trading system.

## Architecture 

```
Yahoo Finance (free) → Cloudflare Worker → D1 Database
                              ↓
                  Dashboard (HTML)  +  API (JSON for Claude)
```

## Quick Setup

### 1. Prerequisites
- Node.js 18+
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/install-and-update/)

```bash
npm install -g wrangler
wrangler login
```

### 2. Create D1 Database

```bash
wrangler d1 create uc-portfolio-db
```

Copy the `database_id` from the output and paste it into `wrangler.toml`.

### 3. Initialize Schema + Seed Data

```bash
wrangler d1 execute uc-portfolio-db --file=./schema.sql
wrangler d1 execute uc-portfolio-db --file=./seed.sql
```

### 4. Deploy

```bash
wrangler deploy
```

Your dashboard is live at: `https://uc-portfolio.<your-subdomain>.workers.dev`

## API Endpoints

| Endpoint | Method | Description | Used By |
|---|---|---|---|
| `/` | GET | Dashboard HTML | Browser |
| `/api/portfolio` | GET | Full portfolio snapshot | Claude |
| `/api/holdings` | GET | All holdings with indicators | Claude |
| `/api/trades` | GET | Trade history | Dashboard |
| `/api/alerts` | GET | Active alerts | Dashboard + Claude |
| `/api/watchlist` | GET | Pipeline candidates | Dashboard |
| `/api/nav` | GET | Historical NAV | Dashboard chart |
| `/api/macro` | GET | Regime + macro state | Claude |
| `/api/scan` | POST | Run 8-filter scanner | Claude |
| `/api/refresh` | GET | Manual data refresh | Admin |

### Scan endpoint example
```bash
curl -X POST https://uc-portfolio.*.workers.dev/api/scan \
  -H "Content-Type: application/json" \
  -d '{"symbol":"GABRIEL","roe":34.7,"de":0.11,"mcap":20397,"regime":"NORMAL"}'
```

## Cron Schedule

Daily at **4:15 PM IST** (10:45 UTC), the worker:
1. Fetches latest candles from Yahoo Finance for all holdings
2. Computes indicators (DMA, RSI, ATR, etc.)
3. Updates D1 database
4. Dashboard reflects new data on next page load

## GitHub Workflow

```bash
git init
git add .
git commit -m "Initial UC-Portfolio dashboard"
git remote add origin https://github.com/YOUR_USERNAME/uc-portfolio.git
git push -u origin main
```

### Auto-deploy on push (optional)
Connect your GitHub repo to Cloudflare:
1. Go to Cloudflare Dashboard → Workers → your worker
2. Settings → Builds → Connect to Git
3. Select your repo — deploys on every push to main

## File Structure

```
uc-portfolio/
├── wrangler.toml          # Worker config + D1 binding + cron
├── schema.sql             # Database schema
├── seed.sql               # Initial portfolio data
├── src/
│   ├── index.js           # Worker: routes + API + scanner + cron
│   └── dashboard.html     # Single-page dashboard (served by worker)
└── README.md
```

## Data Sources

| Data | Source | Refresh |
|---|---|---|
| Candle OHLCV | Yahoo Finance HTTP API | Daily cron |
| Fundamentals (ROE, D/E) | Screener.in CSV (manual) | On new scan |
| Portfolio state | D1 (updated via API) | On trade |
| Macro (Brent, VIX) | Entered via Claude or manual | Per session |

## Token Savings

| Operation | Before (Kite through chat) | After (Worker API) |
|---|---|---|
| Morning scan 11 stocks | ~80,000 tokens | ~2,000 tokens |
| Validate 7 candidates | ~50,000 tokens | ~1,500 tokens |
| After-market audit | ~60,000 tokens | ~1,000 tokens |
