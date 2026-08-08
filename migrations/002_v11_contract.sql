-- UC_MOMENTUM v1.1 — CONTRACT migration for D1 database: uc-portfolio-db
-- RUN ONLY AFTER the v1.1 Worker has been deployed, dry-run verified, real
-- refresh verified, and integrity checks pass. This migration is NOT backward-
-- compatible with the pre-v1.1 Worker.

PRAGMA foreign_keys=OFF;
BEGIN TRANSACTION;

-- Remove retired macro deployment-gate columns while preserving all data used by v1.1.
CREATE TABLE macro_state_v11_contract (
  id INTEGER PRIMARY KEY DEFAULT 1,
  brent_price REAL,
  vix REAL,
  vix_change REAL,
  nifty_close REAL,
  nifty_50dma REAL,
  nifty_200dma REAL,
  nifty500_close REAL,
  breadth_pct REAL,
  fii_net_cr REAL,
  dii_net_cr REAL,
  fii_net_buyers_5d INTEGER,
  fii_net_sellers_3d INTEGER,
  midcaps_outperforming INTEGER,
  systemic_stress INTEGER,
  regime TEXT DEFAULT 'NORMAL',
  regime_rationale TEXT,
  regime_missing_inputs TEXT,
  midcap_rs_20d REAL,
  regime_fail_safe INTEGER DEFAULT 0,
  fii_as_of_date TEXT,
  fii_fresh INTEGER DEFAULT 0,
  last_session_date TEXT,
  updated_at TEXT
);
INSERT INTO macro_state_v11_contract (
  id,brent_price,vix,vix_change,nifty_close,nifty_50dma,nifty_200dma,
  nifty500_close,breadth_pct,fii_net_cr,dii_net_cr,fii_net_buyers_5d,
  fii_net_sellers_3d,midcaps_outperforming,systemic_stress,regime,
  regime_rationale,regime_missing_inputs,midcap_rs_20d,regime_fail_safe,
  fii_as_of_date,fii_fresh,last_session_date,updated_at
)
SELECT
  id,brent_price,vix,vix_change,nifty_close,nifty_50dma,nifty_200dma,
  nifty500_close,breadth_pct,fii_net_cr,dii_net_cr,fii_net_buyers_5d,
  fii_net_sellers_3d,midcaps_outperforming,systemic_stress,regime,
  regime_rationale,regime_missing_inputs,midcap_rs_20d,regime_fail_safe,
  fii_as_of_date,fii_fresh,last_session_date,updated_at
FROM macro_state;
DROP TABLE macro_state;
ALTER TABLE macro_state_v11_contract RENAME TO macro_state;

-- Remove the obsolete rank-only automatic replacement field.
CREATE TABLE opportunities_v11_contract (
  symbol TEXT PRIMARY KEY,
  sector TEXT,
  roe REAL,
  de REAL,
  mcap REAL,
  ltp REAL,
  dma_200 REAL,
  dist_52w_pct REAL,
  return_6m_pct REAL,
  vol_1y_pct REAL,
  momentum_score REAL,
  rsi_14 REAL,
  mfi_14 REAL,
  rs_20d REAL,
  rs_60d REAL,
  traded_val_cr REAL,
  vol_threshold_cr REAL,
  band_used_pct REAL,
  credit_test TEXT,
  filters_passed INTEGER,
  failed_filters TEXT,
  verdict TEXT,
  is_holding INTEGER DEFAULT 0,
  sector_slot_available INTEGER DEFAULT 1,
  data_sufficiency TEXT,
  universe_rank INTEGER,
  scan_date TEXT,
  updated_at TEXT
);
INSERT INTO opportunities_v11_contract (
  symbol,sector,roe,de,mcap,ltp,dma_200,dist_52w_pct,return_6m_pct,vol_1y_pct,
  momentum_score,rsi_14,mfi_14,rs_20d,rs_60d,traded_val_cr,vol_threshold_cr,
  band_used_pct,credit_test,filters_passed,failed_filters,verdict,is_holding,
  sector_slot_available,data_sufficiency,universe_rank,scan_date,updated_at
)
SELECT
  symbol,sector,roe,de,mcap,ltp,dma_200,dist_52w_pct,return_6m_pct,vol_1y_pct,
  momentum_score,rsi_14,mfi_14,rs_20d,rs_60d,traded_val_cr,vol_threshold_cr,
  band_used_pct,credit_test,filters_passed,failed_filters,verdict,is_holding,
  sector_slot_available,data_sufficiency,universe_rank,scan_date,updated_at
FROM opportunities;
DROP TABLE opportunities;
ALTER TABLE opportunities_v11_contract RENAME TO opportunities;
CREATE INDEX IF NOT EXISTS idx_opportunities_scan_verdict
  ON opportunities(scan_date, verdict, is_holding);

INSERT OR REPLACE INTO config (key,value) VALUES ('version','v1.1');

COMMIT;
PRAGMA foreign_keys=ON;
