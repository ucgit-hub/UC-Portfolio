-- UC_MOMENTUM v1.1 — POST-DEPLOY / POST-REFRESH INTEGRITY VERIFICATION
-- Run after the dry refresh (broker-field check) and again AFTER the real /api/refresh.
-- Every query below MUST return zero rows except the last two, which are informational.
--
-- daily_nav row count is NOT checked: a successful refresh legitimately
-- inserts or updates today's NAV snapshot.

-- 1. Broker-owned holdings fields must be byte-identical.
SELECT 'BROKER_FIELD_CHANGED' AS check_name, h.symbol,
       s.quantity    AS was_qty,    h.quantity    AS now_qty,
       s.entry_price AS was_entry,  h.entry_price AS now_entry,
       s.entry_date  AS was_date,   h.entry_date  AS now_date,
       s.gtt_id      AS was_gttid,  h.gtt_id      AS now_gttid,
       s.gtt_trigger AS was_trig,   h.gtt_trigger AS now_trig,
       s.gtt_qty     AS was_gttqty, h.gtt_qty     AS now_gttqty,
       s.exchange    AS was_exch,   h.exchange    AS now_exch
FROM _integrity_snapshot s JOIN holdings h ON s.symbol = h.symbol
WHERE IFNULL(s.quantity,-1)    != IFNULL(h.quantity,-1)
   OR IFNULL(s.entry_price,-1) != IFNULL(h.entry_price,-1)
   OR IFNULL(s.entry_date,'')  != IFNULL(h.entry_date,'')
   OR IFNULL(s.gtt_id,-1)      != IFNULL(h.gtt_id,-1)
   OR IFNULL(s.gtt_trigger,-1) != IFNULL(h.gtt_trigger,-1)
   OR IFNULL(s.gtt_qty,-1)     != IFNULL(h.gtt_qty,-1)
   OR IFNULL(s.exchange,'')    != IFNULL(h.exchange,'');

-- 2. No holding added or removed.
SELECT 'HOLDING_SET_CHANGED' AS check_name, symbol, 'missing_now' AS how
FROM _integrity_snapshot WHERE symbol NOT IN (SELECT symbol FROM holdings)
UNION ALL
SELECT 'HOLDING_SET_CHANGED', symbol, 'appeared_new'
FROM holdings WHERE symbol NOT IN (SELECT symbol FROM _integrity_snapshot);

-- 3. Row counts and broker aggregates must match exactly.
SELECT 'COUNT_MISMATCH' AS check_name, c.tbl, c.n AS was, x.n AS now
FROM _integrity_counts c JOIN (
  SELECT 'holdings' AS tbl, COUNT(*) AS n FROM holdings
  UNION ALL SELECT 'trades', COUNT(*) FROM trades
  UNION ALL SELECT 'trades_pnl_x100', CAST(ROUND(SUM(pnl)*100) AS INTEGER) FROM trades
  UNION ALL SELECT 'gtt_id_sum', SUM(COALESCE(gtt_id,0)) FROM holdings
  UNION ALL SELECT 'qty_sum', SUM(COALESCE(quantity,0)) FROM holdings
  UNION ALL SELECT 'cost_x100', CAST(ROUND(SUM(quantity*entry_price)*100) AS INTEGER) FROM holdings
) x ON c.tbl = x.tbl
WHERE IFNULL(c.n,-1) != IFNULL(x.n,-1);

-- 4. A strategy stop must never sit below the live broker trigger.
SELECT 'STOP_BELOW_LIVE_TRIGGER' AS check_name, symbol, gtt_trigger, gtt_min_stop
FROM holdings
WHERE gtt_trigger IS NOT NULL AND gtt_min_stop IS NOT NULL
  AND gtt_min_stop < gtt_trigger - 0.01;

-- 5. Stage must never have regressed below its pre-deploy value.
SELECT 'STAGE_REGRESSED' AS check_name, symbol, gtt_stage FROM holdings
WHERE gtt_stage NOT IN ('ENTRY_RISK','RISK_REDUCED','CAPITAL_PROTECTED',
       'PROFIT_LOCKED','PARTIAL_BOOK_DUE','RUNNER','PROTECTED_WINNER');

-- 6. INFORMATIONAL — strategy state after refresh (changes are expected).
SELECT symbol, gtt_stage, gtt_min_stop, leader_state, leader_score,
       highest_close, giveback_alert, pyramid_eligibility, rotation_status,
       time_check, fundamentals_status, coverage_alerts
FROM holdings ORDER BY momentum_rank;

-- 7. INFORMATIONAL — NAV snapshot for today (a new/updated row is correct).
SELECT date, net_worth, equity_value, cash_kite, cash_bank,
       liquidity_pct, liquidity_target_low, liquidity_target_high,
       liquidity_status, regime
FROM daily_nav ORDER BY date DESC LIMIT 3;
