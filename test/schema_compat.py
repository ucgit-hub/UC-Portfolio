#!/usr/bin/env python3
"""SQLite compatibility proof for UC_MOMENTUM v1.1 expand/contract migrations.
No network and no production D1 access.
"""
from pathlib import Path
import sqlite3
import sys

ROOT = Path(__file__).resolve().parents[1]
PRE = (ROOT / "test/pre_v11_schema.sql").read_text()
EXPAND = (ROOT / "migrations/001_v11_expand.sql").read_text()
CONTRACT = (ROOT / "migrations/002_v11_contract.sql").read_text()


def cols(db, table):
    return {r[1] for r in db.execute(f"PRAGMA table_info({table})")}


def fresh_db():
    db = sqlite3.connect(":memory:")
    db.executescript(PRE)
    db.execute("INSERT INTO holdings(symbol,exchange,sector,entry_date,entry_price,quantity,gtt_stage,gtt_trigger,gtt_qty,gtt_id,leader_state) VALUES ('SYN','NSE','Synthetic','2026-01-01',100,10,'ENTRY_RISK',92,10,1001,'UNPROVEN')")
    db.execute("INSERT INTO indicators(symbol,ltp,updated_at) VALUES ('SYN',100,datetime('now'))")
    db.execute("INSERT INTO watchlist(symbol,sector) VALUES ('WATCH','Synthetic')")
    db.execute("INSERT INTO macro_state(id,brent_price,vix,nifty_close,nifty_50dma,regime,freeze_active,gate_brent,gate_vix,gate_nifty,nifty500_close) VALUES(1,80,14,25000,24500,'NORMAL',0,1,1,1,22000)")
    db.execute("INSERT INTO nifty500(symbol,industry) VALUES ('CAND','Synthetic')")
    db.execute("INSERT INTO fundamentals_cache(symbol,roe,de,mcap,in_nifty500) VALUES ('CAND',20,0.2,50000,1)")
    db.execute("INSERT INTO opportunities(symbol,sector,roe,de,mcap,rotation_replaces,scan_date,updated_at) VALUES ('CAND','Synthetic',20,0.2,50000,'SYN',date('now'),datetime('now'))")
    db.execute("INSERT INTO config(key,value) VALUES ('resend_key','synthetic-test-only')")
    db.commit()
    return db


def old_worker_statements(db):
    db.execute('''INSERT OR REPLACE INTO macro_state
      (id,brent_price,vix,nifty_close,nifty_50dma,regime,freeze_active,gate_brent,gate_vix,gate_nifty,updated_at,nifty500_close)
      VALUES(1,?,?,?,?,?,?,?,?,?,datetime("now"),?)''',
      (81, 15, 25100, 24600, "NORMAL", 0, 1, 1, 1, 22100))

    db.execute('''INSERT OR REPLACE INTO indicators
      (symbol,ltp,dma_200,dma_20,high_52w,low_52w,dist_52w_pct,return_6m_pct,vol_1y_pct,
       momentum_score,rsi_14,atr_14,atr_pct,traded_val_cr,above_200_dma,above_20_dma,higher_highs,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,datetime("now"))''',
      ("SYN",101,90,98,110,70,-8,12,25,0.48,55,2,2,90,1,1,1))
    db.execute("UPDATE holdings SET momentum_score=?, momentum_rank=?, is_bottom_20=? WHERE symbol=?", (0.48,1,0,"SYN"))
    db.execute("UPDATE watchlist SET momentum_score=? WHERE symbol=?", (0.8,"WATCH"))
    db.execute('''INSERT OR REPLACE INTO daily_nav
      (date,equity_value,liquidbees_value,cash_kite,cash_bank,net_worth,nifty_close,portfolio_return_pct,
       positions_count,cash_ratio_pct,nifty50_close,nifty500_close,vix_close,brent_close,day_change_pct,day_change_abs)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)''',
      ("2026-08-08",1000,100,200,50,1350,25100,2.0,1,25,25100,22100,15,81,0.5,7))
    db.execute('''INSERT OR REPLACE INTO opportunities
      (symbol,sector,roe,de,mcap,ltp,dma_200,dist_52w_pct,return_6m_pct,vol_1y_pct,momentum_score,
       rsi_14,traded_val_cr,filters_passed,failed_filters,verdict,is_holding,sector_slot_available,
       rotation_replaces,scan_date,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,date("now"),datetime("now"))''',
      ("CAND","Synthetic",20,0.2,50000,101,90,-8,12,25,0.48,55,90,8,"[]","BUY_CANDIDATE",0,1,"SYN"))
    assert db.execute("SELECT value FROM config WHERE key='resend_key'").fetchone() is None
    db.commit()


def new_worker_statements(db):
    db.execute('''INSERT INTO macro_state
      (id,brent_price,vix,vix_change,nifty_close,nifty_50dma,nifty_200dma,nifty500_close,breadth_pct,
       midcap_rs_20d,midcaps_outperforming,regime,regime_rationale,regime_missing_inputs,
       regime_fail_safe,fii_fresh,last_session_date,updated_at)
      VALUES (1,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'))
      ON CONFLICT(id) DO UPDATE SET vix=excluded.vix,vix_change=excluded.vix_change,
       nifty_close=excluded.nifty_close,nifty_50dma=excluded.nifty_50dma,nifty_200dma=excluded.nifty_200dma,
       nifty500_close=excluded.nifty500_close,breadth_pct=excluded.breadth_pct,
       midcap_rs_20d=excluded.midcap_rs_20d,midcaps_outperforming=excluded.midcaps_outperforming,
       regime=excluded.regime,regime_rationale=excluded.regime_rationale,
       regime_missing_inputs=excluded.regime_missing_inputs,regime_fail_safe=excluded.regime_fail_safe,
       fii_fresh=excluded.fii_fresh,last_session_date=excluded.last_session_date,updated_at=excluded.updated_at''',
      (81,15,1,25100,24600,24000,22100,62,2.1,1,"NORMAL","synthetic","[]",0,1,"2026-08-08"))

    db.execute('''INSERT INTO indicators
      (symbol,ltp,dma_200,dma_20,high_52w,low_52w,dist_52w_pct,return_6m_pct,vol_1y_pct,momentum_score,
       rsi_14,mfi_14,atr_14,atr_pct,traded_val_cr,rs_20d,rs_60d,above_200_dma,above_20_dma,higher_highs,
       higher_lows,candles_n,data_sufficiency,universe_rank,universe_rank_pct,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'))
      ON CONFLICT(symbol) DO UPDATE SET ltp=excluded.ltp,mfi_14=excluded.mfi_14,rs_20d=excluded.rs_20d,
       rs_60d=excluded.rs_60d,higher_lows=excluded.higher_lows,candles_n=excluded.candles_n,
       data_sufficiency=excluded.data_sufficiency,updated_at=excluded.updated_at''',
      ("SYN",102,90,99,110,70,-7,13,25,0.52,56,54,2,2,90,1.2,2.4,1,1,1,1,270,"FULL",1,10))

    db.execute('''UPDATE holdings SET momentum_score=?,momentum_rank=?,is_bottom_20=?,highest_close=?,
      highest_close_date=COALESCE(?,highest_close_date),leader_score=?,leader_state=?,leader_streak=?,
      deterioration_streak=?,gtt_stage=?,gtt_min_stop=?,atr_pct=?,rs_20d=?,rs_60d=?,giveback_alert=?,
      pyramid_eligibility=?,rotation_status=?,time_check=?,coverage_alerts=?,fundamentals_status=?,
      last_audit=datetime('now') WHERE symbol=?''',
      (0.52,1,0,112,"2026-08-08",4,"LEADER_CANDIDATE",1,0,"RISK_REDUCED",97,2,1.2,2.4,None,
       "FULL_SIZE","HOLD",None,"[]","OK","SYN"))

    db.execute('''INSERT INTO opportunities
      (symbol,sector,roe,de,mcap,ltp,dma_200,dist_52w_pct,return_6m_pct,vol_1y_pct,momentum_score,rsi_14,
       mfi_14,rs_20d,rs_60d,traded_val_cr,vol_threshold_cr,band_used_pct,credit_test,filters_passed,
       failed_filters,verdict,is_holding,sector_slot_available,data_sufficiency,scan_date,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,date('now'),datetime('now'))
      ON CONFLICT(symbol) DO UPDATE SET ltp=excluded.ltp,mfi_14=excluded.mfi_14,rs_20d=excluded.rs_20d,
       rs_60d=excluded.rs_60d,data_sufficiency=excluded.data_sufficiency,updated_at=excluded.updated_at''',
      ("CAND","Synthetic",20,0.2,50000,102,90,-7,13,25,0.52,56,54,1.2,2.4,90,75,-15,"DEBT_EQUITY",8,
       "[]","BUY_CANDIDATE",0,1,"FULL"))

    db.execute('''INSERT OR REPLACE INTO daily_nav
      (date,equity_value,liquidbees_value,cash_kite,cash_bank,net_worth,nifty_close,portfolio_return_pct,
       positions_count,cash_ratio_pct,nifty50_close,nifty500_close,vix_close,brent_close,day_change_pct,
       day_change_abs,liquidity_pct,liquidity_target_low,liquidity_target_high,liquidity_status,regime)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)''',
      ("2026-08-08",1020,100,200,50,1370,25100,2.5,1,25,25100,22100,15,81,0.5,8,25,10,15,"ABOVE_TARGET","NORMAL"))
    db.commit()


def check(label, fn):
    try:
        fn()
        print(f"PASS {label}")
        return True
    except Exception as e:
        print(f"FAIL {label}: {e}")
        return False


def proof_old_expand():
    db=fresh_db(); db.executescript(EXPAND)
    assert {"freeze_active","gate_brent","gate_vix","gate_nifty"} <= cols(db,"macro_state")
    assert "rotation_replaces" in cols(db,"opportunities")
    old_worker_statements(db)


def proof_new_expand():
    db=fresh_db(); db.executescript(EXPAND)
    required={"vix_change","nifty_200dma","breadth_pct","midcap_rs_20d","regime_fail_safe","fii_as_of_date","fii_fresh","last_session_date"}
    assert required <= cols(db,"macro_state")
    assert {"mfi_14","rs_20d","rs_60d","higher_lows","candles_n","data_sufficiency","universe_rank","universe_rank_pct"} <= cols(db,"indicators")
    new_worker_statements(db)


def proof_contract():
    db=fresh_db(); db.executescript(EXPAND); new_worker_statements(db); db.executescript(CONTRACT)
    assert not ({"freeze_active","gate_brent","gate_vix","gate_nifty"} & cols(db,"macro_state"))
    assert "rotation_replaces" not in cols(db,"opportunities")
    new_worker_statements(db)


results=[
    check("Old Worker + EXPAND", proof_old_expand),
    check("New Worker + EXPAND", proof_new_expand),
    check("New Worker + CONTRACT", proof_contract),
]
if not all(results): sys.exit(1)
