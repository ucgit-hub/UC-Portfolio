#!/usr/bin/env python3
"""Release hotfix compatibility proof using the known pre-v1.1 production shape.
Synthetic data only. No network or production D1 access.
"""
from pathlib import Path
import sqlite3, re, sys

ROOT = Path(__file__).resolve().parents[1]
PRE = (ROOT / 'test/pre_v11_schema.sql').read_text()
EXPAND = (ROOT / 'migrations/001_v11_expand.sql').read_text()


def cols(db, table):
    return {r[1] for r in db.execute(f'PRAGMA table_info({table})')}


def make_db():
    db = sqlite3.connect(':memory:')
    db.executescript(PRE)
    # Synthetic analogues only: preserve a RUNNER, seed a strategy stop, and
    # model the known fundamentals-incomplete holding APARINDS.
    db.execute("INSERT INTO holdings(symbol,exchange,sector,entry_date,entry_price,quantity,gtt_stage,gtt_trigger,gtt_qty,gtt_id,leader_state) VALUES('CHOICEIN','BSE','Financial Services','2026-01-01',100,10,'RUNNER',95,10,1001,'UNPROVEN')")
    db.execute("INSERT INTO holdings(symbol,exchange,sector,entry_date,entry_price,quantity,gtt_stage,gtt_trigger,gtt_qty,gtt_id,leader_state) VALUES('APARINDS','NSE','Metals & Mining','2026-01-01',200,5,'ENTRY_RISK',180,5,1002,'UNPROVEN')")
    db.execute("INSERT INTO fundamentals_cache(symbol,roe,de,mcap,in_nifty500) VALUES('CHOICEIN',20,6.0,100000,1)")
    db.execute("INSERT INTO nifty500(symbol,industry) VALUES('CHOICEIN','Financial Services')")
    db.execute("INSERT INTO nifty500(symbol,industry) VALUES('APARINDS','Metals & Mining')")
    db.execute("INSERT INTO opportunities(symbol,sector,roe,de,mcap,rotation_replaces,scan_date,updated_at) VALUES('CAND','Synthetic',20,0.2,50000,'CHOICEIN',date('now'),datetime('now'))")
    db.execute("INSERT INTO macro_state(id,brent_price,vix,nifty_close,nifty_50dma,regime,freeze_active,gate_brent,gate_vix,gate_nifty,nifty500_close) VALUES(1,80,14,25000,24500,'NORMAL',0,1,1,1,22000)")
    db.execute("INSERT INTO config(key,value) VALUES('version','v3.2')")
    db.execute("INSERT INTO daily_nav(date,net_worth,liquidity_pct,liquidity_target_low,liquidity_target_high,liquidity_status,regime) VALUES('2026-08-10',1000000,22,15,20,'ABOVE_TARGET','NORMAL')") if 'liquidity_pct' in cols(db,'daily_nav') else None
    db.commit()
    return db


def proof_expand_shape():
    db=make_db(); db.executescript(EXPAND)
    adds=re.findall(r'ALTER TABLE\s+(\w+)\s+ADD COLUMN\s+(\w+)',EXPAND,re.I)
    expected={'macro_state':14,'holdings':10,'indicators':8,'opportunities':7,'daily_nav':5,'fundamentals_cache':3,'nifty500':1}
    got={}
    for t,_ in adds: got[t]=got.get(t,0)+1
    assert len(adds)==48 and got==expected, (len(adds),got)
    assert 'universe_rank' not in cols(db,'opportunities')
    assert {'freeze_active','gate_brent','gate_vix','gate_nifty'} <= cols(db,'macro_state')
    assert 'rotation_replaces' in cols(db,'opportunities')
    assert db.execute("SELECT gtt_stage FROM holdings WHERE symbol='CHOICEIN'").fetchone()[0]=='RUNNER'
    assert db.execute("SELECT gtt_min_stop FROM holdings WHERE symbol='CHOICEIN'").fetchone()[0]==95
    assert db.execute("SELECT fundamentals_status FROM holdings WHERE symbol='APARINDS'").fetchone()[0]=='FUNDAMENTALS_DATA_INCOMPLETE'


def proof_alert_not_null():
    db=make_db(); db.executescript(EXPAND)
    db.execute("INSERT INTO alerts(alert_type,symbol,severity,message,resolved,created_at) VALUES(?,?,?,?,0,datetime('now'))",('GTT_COVERAGE','CHOICEIN','WARNING','synthetic'))
    try:
        db.execute("INSERT INTO alerts(symbol,severity,message,resolved,created_at) VALUES(?,?,?,0,datetime('now'))",('CHOICEIN','WARNING','should fail'))
    except sqlite3.IntegrityError:
        return
    raise AssertionError('alert_type NOT NULL was not enforced')


def proof_old_worker_after_expand():
    db=make_db(); db.executescript(EXPAND)
    # Representative legacy writes must remain valid after EXPAND.
    db.execute('''INSERT OR REPLACE INTO macro_state
      (id,brent_price,vix,nifty_close,nifty_50dma,regime,freeze_active,gate_brent,gate_vix,gate_nifty,updated_at,nifty500_close)
      VALUES(1,?,?,?,?,?,?,?,?,?,datetime('now'),?)''',(81,15,25100,24600,'NORMAL',0,1,1,1,22100))
    db.execute('''INSERT OR REPLACE INTO opportunities
      (symbol,sector,roe,de,mcap,ltp,dma_200,dist_52w_pct,return_6m_pct,vol_1y_pct,momentum_score,rsi_14,traded_val_cr,filters_passed,failed_filters,verdict,is_holding,sector_slot_available,rotation_replaces,scan_date,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,date('now'),datetime('now'))''',
      ('CAND','Synthetic',20,0.2,50000,101,90,-5,20,25,0.8,55,100,8,'[]','BUY_CANDIDATE',0,1,'CHOICEIN'))
    db.commit()


def proof_new_worker_after_expand():
    db=make_db(); db.executescript(EXPAND)
    # Representative v1.1 writes against the expanded live-shape fixture.
    db.execute('''INSERT INTO macro_state
      (id,brent_price,vix,vix_change,nifty_close,nifty_50dma,nifty_200dma,nifty500_close,breadth_pct,
       midcap_rs_20d,midcaps_outperforming,regime,regime_rationale,regime_missing_inputs,
       regime_fail_safe,fii_fresh,last_session_date,updated_at)
      VALUES (1,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,datetime("now"))
      ON CONFLICT(id) DO UPDATE SET vix=excluded.vix,vix_change=excluded.vix_change,
       nifty_close=excluded.nifty_close,nifty_50dma=excluded.nifty_50dma,nifty_200dma=excluded.nifty_200dma,
       nifty500_close=excluded.nifty500_close,breadth_pct=excluded.breadth_pct,
       midcap_rs_20d=excluded.midcap_rs_20d,midcaps_outperforming=excluded.midcaps_outperforming,
       regime=excluded.regime,regime_rationale=excluded.regime_rationale,
       regime_missing_inputs=excluded.regime_missing_inputs,regime_fail_safe=excluded.regime_fail_safe,
       fii_fresh=excluded.fii_fresh,last_session_date=excluded.last_session_date,updated_at=excluded.updated_at''',
      (81,15,1,25100,24600,24000,22100,62,2.1,1,'NORMAL','synthetic','[]',0,1,'2026-08-10'))
    db.execute('''INSERT INTO indicators
      (symbol,ltp,dma_200,dma_20,high_52w,low_52w,dist_52w_pct,return_6m_pct,vol_1y_pct,momentum_score,
       rsi_14,mfi_14,atr_14,atr_pct,traded_val_cr,rs_20d,rs_60d,above_200_dma,above_20_dma,higher_highs,
       higher_lows,candles_n,data_sufficiency,universe_rank,universe_rank_pct,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'))
      ON CONFLICT(symbol) DO UPDATE SET ltp=excluded.ltp,mfi_14=excluded.mfi_14,rs_20d=excluded.rs_20d,
       rs_60d=excluded.rs_60d,higher_lows=excluded.higher_lows,candles_n=excluded.candles_n,
       data_sufficiency=excluded.data_sufficiency,updated_at=excluded.updated_at''',
      ('CHOICEIN',102,90,99,110,70,-7,13,25,0.52,56,54,2,2,90,1.2,2.4,1,1,1,1,270,'FULL',1,10))
    db.execute('''UPDATE holdings SET momentum_score=?,momentum_rank=?,is_bottom_20=?,highest_close=?,
      highest_close_date=COALESCE(?,highest_close_date),leader_score=?,leader_state=?,leader_streak=?,
      deterioration_streak=?,gtt_stage=?,gtt_min_stop=?,atr_pct=?,rs_20d=?,rs_60d=?,giveback_alert=?,
      pyramid_eligibility=?,rotation_status=?,time_check=?,coverage_alerts=?,fundamentals_status=?,
      last_audit=datetime('now') WHERE symbol=?''',
      (0.52,1,0,112,'2026-08-10',4,'LEADER_CANDIDATE',1,0,'RUNNER',97,2,1.2,2.4,None,
       'FULL_SIZE','HOLD',None,'[]','OK','CHOICEIN'))
    db.execute('''INSERT INTO opportunities
      (symbol,sector,roe,de,mcap,ltp,dma_200,dist_52w_pct,return_6m_pct,vol_1y_pct,momentum_score,rsi_14,
       mfi_14,rs_20d,rs_60d,traded_val_cr,vol_threshold_cr,band_used_pct,credit_test,filters_passed,
       failed_filters,verdict,is_holding,sector_slot_available,data_sufficiency,scan_date,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,date('now'),datetime('now'))
      ON CONFLICT(symbol) DO UPDATE SET ltp=excluded.ltp,mfi_14=excluded.mfi_14,rs_20d=excluded.rs_20d,
       rs_60d=excluded.rs_60d,data_sufficiency=excluded.data_sufficiency,updated_at=excluded.updated_at''',
      ('CAND','Synthetic',20,0.2,50000,102,90,-7,13,25,0.52,56,54,1.2,2.4,90,75,-15,'DEBT_EQUITY',8,
       '[]','BUY_CANDIDATE',0,1,'FULL'))
    db.execute('''INSERT OR REPLACE INTO daily_nav
      (date,equity_value,liquidbees_value,cash_kite,cash_bank,net_worth,nifty_close,portfolio_return_pct,
       positions_count,cash_ratio_pct,nifty50_close,nifty500_close,vix_close,brent_close,day_change_pct,
       day_change_abs,liquidity_pct,liquidity_target_low,liquidity_target_high,liquidity_status,regime)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)''',
      ('2026-08-11',1020,100,200,50,1370,25100,2.5,2,25,25100,22100,15,81,0.5,8,25,10,15,'ABOVE_TARGET','NORMAL'))
    db.execute("INSERT INTO alerts(alert_type,symbol,severity,message,resolved,created_at) VALUES(?,?,?,?,0,datetime('now'))",
      ('GTT_STAGE','CHOICEIN','INFO','synthetic'))
    db.commit()


def proof_kite_nav_upsert_preserves_v11():
    db=make_db(); db.executescript(EXPAND)
    db.execute("INSERT INTO daily_nav(date,net_worth,liquidity_pct,liquidity_target_low,liquidity_target_high,liquidity_status,regime) VALUES('2026-08-10',1000000,22,15,20,'ABOVE_TARGET','NORMAL')")
    sql='''INSERT INTO daily_nav (date,equity_value,liquidbees_value,cash_kite,cash_bank,net_worth,nifty_close,portfolio_return_pct,positions_count,cash_ratio_pct,nifty50_close,nifty500_close,vix_close,brent_close,day_change_pct,day_change_abs)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(date) DO UPDATE SET
         equity_value=excluded.equity_value,liquidbees_value=excluded.liquidbees_value,
         cash_kite=excluded.cash_kite,cash_bank=excluded.cash_bank,net_worth=excluded.net_worth,
         nifty_close=excluded.nifty_close,portfolio_return_pct=excluded.portfolio_return_pct,
         positions_count=excluded.positions_count,cash_ratio_pct=excluded.cash_ratio_pct,
         nifty50_close=excluded.nifty50_close,nifty500_close=excluded.nifty500_close,
         vix_close=excluded.vix_close,brent_close=excluded.brent_close,
         day_change_pct=excluded.day_change_pct,day_change_abs=excluded.day_change_abs'''
    db.execute(sql,('2026-08-10',600000,50000,100000,50000,800000,25000,20,10,25,25000,22000,14,80,1,8000))
    row=db.execute("SELECT net_worth,liquidity_pct,liquidity_target_low,liquidity_target_high,liquidity_status,regime FROM daily_nav WHERE date='2026-08-10'").fetchone()
    assert row==(800000,22,15,20,'ABOVE_TARGET','NORMAL'), row


def run(name, fn):
    try: fn(); print('PASS',name); return True
    except Exception as e: print('FAIL',name,e); return False

results=[
    run('EXPAND exact live delta / backfills',proof_expand_shape),
    run('alerts.alert_type NOT NULL',proof_alert_not_null),
    run('Old Worker + EXPAND coexistence',proof_old_worker_after_expand),
    run('New Worker + EXPAND compatibility',proof_new_worker_after_expand),
    run('Kite NAV UPSERT preserves v1.1 fields',proof_kite_nav_upsert_preserves_v11),
]
if not all(results): sys.exit(1)
