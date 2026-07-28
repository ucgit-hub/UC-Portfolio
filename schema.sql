-- UC-Portfolio D1 Schema
-- Run: wrangler d1 execute uc-portfolio-db --file=./schema.sql

-- Portfolio holdings (source of truth)
CREATE TABLE IF NOT EXISTS holdings (
  symbol TEXT PRIMARY KEY,
  exchange TEXT DEFAULT 'NSE',
  sector TEXT NOT NULL,
  entry_date TEXT NOT NULL,
  entry_price REAL NOT NULL,
  quantity INTEGER NOT NULL,
  highest_close REAL,
  highest_close_date TEXT,
  gtt_stage TEXT DEFAULT 'ENTRY_RISK',
  gtt_trigger REAL,
  gtt_limit REAL,
  gtt_qty INTEGER,
  gtt_id INTEGER,
  leader_state TEXT DEFAULT 'UNPROVEN',
  leader_score INTEGER DEFAULT 0,
  leader_streak INTEGER DEFAULT 0,
  atr_pct REAL,
  last_audit TEXT,
  notes TEXT
);

-- Daily NAV snapshots (for performance chart)
CREATE TABLE IF NOT EXISTS daily_nav (
  date TEXT PRIMARY KEY,
  equity_value REAL,
  liquidbees_value REAL,
  cash_kite REAL,
  cash_bank REAL,
  net_worth REAL,
  nifty_close REAL,
  nifty_return_pct REAL,
  portfolio_return_pct REAL,
  positions_count INTEGER,
  cash_ratio_pct REAL
);

-- Trade log (every entry/exit)
CREATE TABLE IF NOT EXISTS trades (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol TEXT NOT NULL,
  trade_date TEXT NOT NULL,
  trade_type TEXT NOT NULL, -- BUY, SELL, STOP, BOOK, EXIT
  quantity INTEGER NOT NULL,
  price REAL NOT NULL,
  value REAL NOT NULL,
  pnl REAL DEFAULT 0,
  pnl_pct REAL DEFAULT 0,
  reason TEXT,
  tag TEXT,
  gtt_triggered INTEGER DEFAULT 0
);

-- Candle cache (daily OHLCV from Yahoo)
CREATE TABLE IF NOT EXISTS candle_cache (
  symbol TEXT NOT NULL,
  date TEXT NOT NULL,
  open REAL,
  high REAL,
  low REAL,
  close REAL,
  volume INTEGER,
  PRIMARY KEY (symbol, date)
);

-- Computed indicators (refreshed daily at 4:15 PM)
CREATE TABLE IF NOT EXISTS indicators (
  symbol TEXT PRIMARY KEY,
  ltp REAL,
  dma_200 REAL,
  dma_20 REAL,
  high_52w REAL,
  low_52w REAL,
  dist_52w_pct REAL,
  return_6m_pct REAL,
  vol_1y_pct REAL,
  momentum_score REAL,
  rsi_14 REAL,
  atr_14 REAL,
  atr_pct REAL,
  traded_val_cr REAL,
  above_200_dma INTEGER,
  above_20_dma INTEGER,
  higher_highs INTEGER,
  updated_at TEXT
);

-- Watchlist / pipeline candidates
CREATE TABLE IF NOT EXISTS watchlist (
  symbol TEXT PRIMARY KEY,
  sector TEXT,
  roe REAL,
  de REAL,
  mcap REAL,
  momentum_score REAL,
  filters_passed INTEGER,
  failed_filters TEXT,
  verdict TEXT,
  results_date TEXT,
  entry_zone_low REAL,
  entry_zone_high REAL,
  status TEXT DEFAULT 'MONITORING', -- DEPLOY_READY, BLOCKED_RESULTS, BLOCKED_RSI, MONITORING
  notes TEXT,
  updated_at TEXT
);

-- Alerts / actions to monitor
CREATE TABLE IF NOT EXISTS alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL,
  alert_type TEXT NOT NULL, -- GTT_NEAR, RESULTS_DUE, GIVEBACK, MILESTONE_DUE, REGIME_CHANGE, LEADER_CHANGE
  symbol TEXT,
  severity TEXT DEFAULT 'INFO', -- INFO, WARNING, CRITICAL
  message TEXT NOT NULL,
  resolved INTEGER DEFAULT 0,
  resolved_at TEXT
);

-- Macro state (latest regime indicators)
CREATE TABLE IF NOT EXISTS macro_state (
  id INTEGER PRIMARY KEY DEFAULT 1,
  brent_price REAL,
  vix REAL,
  nifty_close REAL,
  nifty_50dma REAL,
  regime TEXT DEFAULT 'NORMAL',
  freeze_active INTEGER DEFAULT 0,
  gate_brent INTEGER DEFAULT 0,
  gate_vix INTEGER DEFAULT 0,
  gate_nifty INTEGER DEFAULT 0,
  fii_net_cr REAL,
  dii_net_cr REAL,
  updated_at TEXT
);

-- Config / constants
CREATE TABLE IF NOT EXISTS config (
  key TEXT PRIMARY KEY,
  value TEXT
);

INSERT OR REPLACE INTO config VALUES ('baseline', '650393');
INSERT OR REPLACE INTO config VALUES ('start_date', '2026-03-20');
INSERT OR REPLACE INTO config VALUES ('regime', 'NORMAL');
INSERT OR REPLACE INTO config VALUES ('version', '2.0');
