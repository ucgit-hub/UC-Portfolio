-- UC_MOMENTUM v1.1 — EXPAND migration for D1 database: uc-portfolio-db
-- ADDITIVE / BACKWARD-COMPATIBLE ONLY.
-- Safe deployment property: the currently deployed pre-v1.1 Worker must keep
-- working after this migration. Retired v1.0 columns are deliberately preserved.
--
-- DO NOT run against an unknown schema. First verify the live D1 schema matches
-- the pre-v1.1 assumptions documented in DEPLOY.md.

PRAGMA foreign_keys=OFF;
BEGIN TRANSACTION;

-- indicators: v1.1 technicals, relative strength, sufficiency and ranking
ALTER TABLE indicators ADD COLUMN mfi_14 REAL;
ALTER TABLE indicators ADD COLUMN rs_20d REAL;
ALTER TABLE indicators ADD COLUMN rs_60d REAL;
ALTER TABLE indicators ADD COLUMN higher_lows INTEGER;
ALTER TABLE indicators ADD COLUMN candles_n INTEGER;
ALTER TABLE indicators ADD COLUMN data_sufficiency TEXT;
ALTER TABLE indicators ADD COLUMN universe_rank INTEGER;
ALTER TABLE indicators ADD COLUMN universe_rank_pct REAL;

-- holdings: strategy-owned state only. Broker-owned columns remain untouched.
ALTER TABLE holdings ADD COLUMN gtt_min_stop REAL;
ALTER TABLE holdings ADD COLUMN deterioration_streak INTEGER DEFAULT 0;
ALTER TABLE holdings ADD COLUMN rs_20d REAL;
ALTER TABLE holdings ADD COLUMN rs_60d REAL;
ALTER TABLE holdings ADD COLUMN giveback_alert TEXT;
ALTER TABLE holdings ADD COLUMN pyramid_eligibility TEXT;
ALTER TABLE holdings ADD COLUMN rotation_status TEXT;
ALTER TABLE holdings ADD COLUMN time_check TEXT;
ALTER TABLE holdings ADD COLUMN coverage_alerts TEXT;
ALTER TABLE holdings ADD COLUMN fundamentals_status TEXT DEFAULT 'OK';

-- real Nifty-100 membership and financial-sector substitute quality fields
ALTER TABLE nifty500 ADD COLUMN in_nifty100 INTEGER DEFAULT 0;
ALTER TABLE fundamentals_cache ADD COLUMN crar REAL;
ALTER TABLE fundamentals_cache ADD COLUMN gross_npa REAL;
ALTER TABLE fundamentals_cache ADD COLUMN net_npa REAL;

-- daily NAV liquidity/regime audit trail
ALTER TABLE daily_nav ADD COLUMN liquidity_pct REAL;
ALTER TABLE daily_nav ADD COLUMN liquidity_target_low REAL;
ALTER TABLE daily_nav ADD COLUMN liquidity_target_high REAL;
ALTER TABLE daily_nav ADD COLUMN liquidity_status TEXT;
ALTER TABLE daily_nav ADD COLUMN regime TEXT;

-- macro_state: additive v1.1 fields. IMPORTANT: freeze_active, gate_brent,
-- gate_vix and gate_nifty are intentionally retained until CONTRACT.
ALTER TABLE macro_state ADD COLUMN vix_change REAL;
ALTER TABLE macro_state ADD COLUMN nifty_200dma REAL;
ALTER TABLE macro_state ADD COLUMN breadth_pct REAL;
ALTER TABLE macro_state ADD COLUMN fii_net_buyers_5d INTEGER;
ALTER TABLE macro_state ADD COLUMN fii_net_sellers_3d INTEGER;
ALTER TABLE macro_state ADD COLUMN midcaps_outperforming INTEGER;
ALTER TABLE macro_state ADD COLUMN systemic_stress INTEGER;
ALTER TABLE macro_state ADD COLUMN regime_rationale TEXT;
ALTER TABLE macro_state ADD COLUMN regime_missing_inputs TEXT;
ALTER TABLE macro_state ADD COLUMN midcap_rs_20d REAL;
ALTER TABLE macro_state ADD COLUMN regime_fail_safe INTEGER DEFAULT 0;
ALTER TABLE macro_state ADD COLUMN fii_as_of_date TEXT;
ALTER TABLE macro_state ADD COLUMN fii_fresh INTEGER DEFAULT 0;
ALTER TABLE macro_state ADD COLUMN last_session_date TEXT;

-- opportunities: additive v1.1 fields. IMPORTANT: rotation_replaces remains
-- available for the currently deployed Worker until CONTRACT.
ALTER TABLE opportunities ADD COLUMN mfi_14 REAL;
ALTER TABLE opportunities ADD COLUMN rs_20d REAL;
ALTER TABLE opportunities ADD COLUMN rs_60d REAL;
ALTER TABLE opportunities ADD COLUMN vol_threshold_cr REAL;
ALTER TABLE opportunities ADD COLUMN band_used_pct REAL;
ALTER TABLE opportunities ADD COLUMN credit_test TEXT;
ALTER TABLE opportunities ADD COLUMN data_sufficiency TEXT;
ALTER TABLE opportunities ADD COLUMN universe_rank INTEGER;

-- discretionary action / rotation ledger
CREATE TABLE IF NOT EXISTS action_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  action_date TEXT NOT NULL,
  symbol TEXT,
  kind TEXT NOT NULL,
  discretionary INTEGER NOT NULL,
  approved_by TEXT,
  notes TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_action_log_date ON action_log(action_date);
CREATE INDEX IF NOT EXISTS idx_opportunities_scan_verdict
  ON opportunities(scan_date, verdict, is_holding);
CREATE INDEX IF NOT EXISTS idx_indicators_universe_rank
  ON indicators(universe_rank);

-- safe, forward-only backfills
UPDATE holdings SET gtt_stage='PROTECTED_WINNER' WHERE gtt_stage='PROTECTED_ALPHA';
UPDATE holdings SET gtt_stage='ENTRY_RISK'
 WHERE gtt_stage IS NULL OR gtt_stage NOT IN
 ('ENTRY_RISK','RISK_REDUCED','CAPITAL_PROTECTED','PROFIT_LOCKED',
  'PARTIAL_BOOK_DUE','RUNNER','PROTECTED_WINNER');
UPDATE holdings
 SET gtt_min_stop=gtt_trigger
 WHERE gtt_min_stop IS NULL AND gtt_trigger IS NOT NULL;
UPDATE holdings
 SET fundamentals_status='FUNDAMENTALS_DATA_INCOMPLETE'
 WHERE symbol NOT IN (SELECT symbol FROM fundamentals_cache);

-- Retire legacy notification credential state. The old Worker treats absence of
-- this config key as a no-op, so EXPAND remains backward-compatible.
DELETE FROM config WHERE key='resend_key';
INSERT OR REPLACE INTO config (key,value) VALUES ('version','v1.1-expand');

COMMIT;
PRAGMA foreign_keys=ON;
