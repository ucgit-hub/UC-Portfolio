-- UC_MOMENTUM v1.1.1 — queue scan orchestration state.
-- ADDITIVE ONLY. No broker-owned table or column is modified.
-- Cloudflare D1 executes migration files in its own transaction context.

CREATE TABLE IF NOT EXISTS scan_runs (
  run_id TEXT PRIMARY KEY,
  version TEXT NOT NULL,
  dry_run INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL,
  status TEXT NOT NULL,
  total_items INTEGER NOT NULL DEFAULT 0,
  completed_items INTEGER NOT NULL DEFAULT 0,
  successful_items INTEGER NOT NULL DEFAULT 0,
  failed_items INTEGER NOT NULL DEFAULT 0,
  eligible_universe INTEGER NOT NULL DEFAULT 0,
  batch_count INTEGER NOT NULL DEFAULT 0,
  buy_candidates INTEGER NOT NULL DEFAULT 0,
  regime TEXT,
  summary_json TEXT,
  errors_json TEXT,
  last_error TEXT,
  queue_attempts INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  started_at TEXT,
  finished_at TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS scan_staging (
  run_id TEXT NOT NULL,
  symbol TEXT NOT NULL,
  sector TEXT,
  roe REAL,
  de REAL,
  mcap REAL,
  crar REAL,
  gross_npa REAL,
  net_npa REAL,
  in_nifty100 INTEGER NOT NULL DEFAULT 0,
  is_candidate INTEGER NOT NULL DEFAULT 0,
  is_watch INTEGER NOT NULL DEFAULT 0,
  indicator_json TEXT,
  error TEXT,
  completed_at TEXT,
  PRIMARY KEY (run_id, symbol)
);

CREATE INDEX IF NOT EXISTS idx_scan_runs_status_created
  ON scan_runs(status, created_at);
CREATE INDEX IF NOT EXISTS idx_scan_staging_run_completed
  ON scan_staging(run_id, completed_at);
CREATE INDEX IF NOT EXISTS idx_scan_staging_run_candidate
  ON scan_staging(run_id, is_candidate);
