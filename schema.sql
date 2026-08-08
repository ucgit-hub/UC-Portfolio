-- HISTORICAL BOOTSTRAP REFERENCE ONLY — NOT THE AUTHORITATIVE PRODUCTION SCHEMA.
--
-- DO NOT execute this file against production. The live uc-portfolio-db schema
-- evolved beyond this early bootstrap definition before UC_MOMENTUM v1.1.
-- Reconcile any future bootstrap schema against a read-only export of the live
-- D1 schema first. v1.1 changes are managed through migrations/.

-- Portfolio holdings (historical bootstrap definition)
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

CREATE TABLE IF NOT EXISTS trades (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol TEXT NOT NULL,
  trade_date TEXT NOT NULL,
  trade_type TEXT NOT NULL,
  quantity INTEGER NOT NULL,
  price REAL NOT NULL,
  value REAL NOT NULL,
  pnl REAL DEFAULT 0,
  pnl_pct REAL DEFAULT 0,
  reason TEXT,
  tag TEXT,
  gtt_triggered INTEGER DEFAULT 0
);

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
  status TEXT DEFAULT 'MONITORING',
  notes TEXT,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL,
  alert_type TEXT NOT NULL,
  symbol TEXT,
  severity TEXT DEFAULT 'INFO',
  message TEXT NOT NULL,
  resolved INTEGER DEFAULT 0,
  resolved_at TEXT
);

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

CREATE TABLE IF NOT EXISTS config (
  key TEXT PRIMARY KEY,
  value TEXT
);
