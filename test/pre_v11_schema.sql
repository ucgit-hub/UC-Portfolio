-- Synthetic pre-v1.1 schema fixture for release compatibility tests.
-- It models the tables/columns used by the currently deployed Worker and
-- intentionally contains no production portfolio data.

CREATE TABLE holdings (
  symbol TEXT PRIMARY KEY, exchange TEXT DEFAULT 'NSE', sector TEXT,
  entry_date TEXT, entry_price REAL, quantity INTEGER,
  highest_close REAL, highest_close_date TEXT,
  gtt_stage TEXT DEFAULT 'ENTRY_RISK', gtt_trigger REAL, gtt_limit REAL,
  gtt_qty INTEGER, gtt_id INTEGER,
  leader_state TEXT DEFAULT 'UNPROVEN', leader_score INTEGER DEFAULT 0,
  leader_streak INTEGER DEFAULT 0, atr_pct REAL, last_audit TEXT, notes TEXT,
  momentum_score REAL, momentum_rank INTEGER, is_bottom_20 INTEGER DEFAULT 0
);
CREATE TABLE daily_nav (
  date TEXT PRIMARY KEY, equity_value REAL, liquidbees_value REAL,
  cash_kite REAL, cash_bank REAL, net_worth REAL, nifty_close REAL,
  nifty_return_pct REAL, portfolio_return_pct REAL, positions_count INTEGER,
  cash_ratio_pct REAL, nifty50_close REAL, nifty500_close REAL,
  vix_close REAL, brent_close REAL, day_change_pct REAL, day_change_abs REAL
);
CREATE TABLE trades (
  id INTEGER PRIMARY KEY AUTOINCREMENT, symbol TEXT, trade_date TEXT,
  trade_type TEXT, quantity INTEGER, price REAL, value REAL, pnl REAL DEFAULT 0,
  pnl_pct REAL DEFAULT 0, reason TEXT, tag TEXT, gtt_triggered INTEGER DEFAULT 0
);

CREATE TABLE candle_cache (
  symbol TEXT NOT NULL, date TEXT NOT NULL, open REAL, high REAL, low REAL,
  close REAL, volume INTEGER, PRIMARY KEY(symbol,date)
);
CREATE TABLE indicators (
  symbol TEXT PRIMARY KEY, ltp REAL, dma_200 REAL, dma_20 REAL, high_52w REAL,
  low_52w REAL, dist_52w_pct REAL, return_6m_pct REAL, vol_1y_pct REAL,
  momentum_score REAL, rsi_14 REAL, atr_14 REAL, atr_pct REAL,
  traded_val_cr REAL, above_200_dma INTEGER, above_20_dma INTEGER,
  higher_highs INTEGER, updated_at TEXT
);
CREATE TABLE watchlist (
  symbol TEXT PRIMARY KEY, sector TEXT, roe REAL, de REAL, mcap REAL,
  momentum_score REAL, filters_passed INTEGER, failed_filters TEXT,
  verdict TEXT, results_date TEXT, entry_zone_low REAL, entry_zone_high REAL,
  status TEXT, notes TEXT, updated_at TEXT
);
CREATE TABLE alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT NOT NULL, alert_type TEXT NOT NULL,
  symbol TEXT, severity TEXT, message TEXT NOT NULL, resolved INTEGER DEFAULT 0,
  resolved_at TEXT
);
CREATE TABLE macro_state (
  id INTEGER PRIMARY KEY DEFAULT 1, brent_price REAL, vix REAL,
  nifty_close REAL, nifty_50dma REAL, regime TEXT DEFAULT 'NORMAL',
  freeze_active INTEGER DEFAULT 0, gate_brent INTEGER DEFAULT 0,
  gate_vix INTEGER DEFAULT 0, gate_nifty INTEGER DEFAULT 0,
  fii_net_cr REAL, dii_net_cr REAL, updated_at TEXT, nifty500_close REAL
);
CREATE TABLE config (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE nifty500 (symbol TEXT PRIMARY KEY, industry TEXT);
CREATE TABLE fundamentals_cache (
  symbol TEXT PRIMARY KEY, roe REAL, de REAL, mcap REAL,
  in_nifty500 INTEGER DEFAULT 1
);
CREATE TABLE opportunities (
  symbol TEXT PRIMARY KEY, sector TEXT, roe REAL, de REAL, mcap REAL, ltp REAL,
  dma_200 REAL, dist_52w_pct REAL, return_6m_pct REAL, vol_1y_pct REAL,
  momentum_score REAL, rsi_14 REAL, traded_val_cr REAL,
  filters_passed INTEGER, failed_filters TEXT, verdict TEXT,
  is_holding INTEGER DEFAULT 0, sector_slot_available INTEGER DEFAULT 1,
  rotation_replaces TEXT, scan_date TEXT, updated_at TEXT
);
