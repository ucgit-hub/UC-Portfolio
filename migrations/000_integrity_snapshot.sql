-- UC_MOMENTUM v1.1 — PRE-DEPLOY BROKER-FIELD INTEGRITY SNAPSHOT
-- Run BEFORE 001_v11_expand.sql. Captures only broker-owned state.
-- Strategy-owned fields (gtt_stage, gtt_min_stop, leader_*, highest_close,
-- momentum_rank, giveback_alert, pyramid_eligibility, rotation_status,
-- time_check, coverage_alerts, fundamentals_status) are DELIBERATELY excluded:
-- those are expected to change on the first refresh.

DROP TABLE IF EXISTS _integrity_snapshot;
CREATE TABLE _integrity_snapshot AS
SELECT symbol, exchange, quantity, entry_price, entry_date,
       gtt_id, gtt_trigger, gtt_qty
FROM holdings;

DROP TABLE IF EXISTS _integrity_counts;
CREATE TABLE _integrity_counts AS
SELECT 'holdings' AS tbl, COUNT(*) AS n FROM holdings
UNION ALL SELECT 'trades', COUNT(*) FROM trades
UNION ALL SELECT 'trades_pnl_x100', CAST(ROUND(SUM(pnl)*100) AS INTEGER) FROM trades
UNION ALL SELECT 'gtt_id_sum', SUM(COALESCE(gtt_id,0)) FROM holdings
UNION ALL SELECT 'qty_sum', SUM(COALESCE(quantity,0)) FROM holdings
UNION ALL SELECT 'cost_x100', CAST(ROUND(SUM(quantity*entry_price)*100) AS INTEGER) FROM holdings;

SELECT tbl, n FROM _integrity_counts ORDER BY tbl;
