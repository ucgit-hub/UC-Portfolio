#!/usr/bin/env python3
"""Execute the JSON-bulk SQL used by the queue finalizer against SQLite.
This catches SQL syntax/bind regressions without network or production D1 access.
"""
from pathlib import Path
import re, sqlite3, json

ROOT = Path(__file__).resolve().parents[1]
SRC = (ROOT / 'src/queue-worker.js').read_text()


def sql_from_func(name):
    m = re.search(rf"function {name}\([^)]*\) \{{\n  return DB\.prepare\(\n    `([\s\S]*?)`\n  \)\.bind", SRC)
    assert m, f'missing SQL helper {name}'
    return m.group(1)

m = re.search(r"const stagingPayload[\s\S]*?await env\.DB\.prepare\(\n    `([\s\S]*?)`\n  \)\.bind\(JSON\.stringify\(stagingPayload\)\)", SRC)
assert m, 'missing bulk staging SQL'
STAGING = m.group(1)

con = sqlite3.connect(':memory:')
con.executescript('''
CREATE TABLE scan_staging(run_id TEXT,symbol TEXT,sector TEXT,roe REAL,de REAL,mcap REAL,crar REAL,gross_npa REAL,net_npa REAL,in_nifty100 INTEGER,is_candidate INTEGER,is_watch INTEGER,indicator_json TEXT,error TEXT,completed_at TEXT,PRIMARY KEY(run_id,symbol));
CREATE TABLE indicators(symbol TEXT PRIMARY KEY,ltp REAL,dma_200 REAL,dma_20 REAL,high_52w REAL,low_52w REAL,dist_52w_pct REAL,return_6m_pct REAL,vol_1y_pct REAL,momentum_score REAL,rsi_14 REAL,mfi_14 REAL,atr_14 REAL,atr_pct REAL,traded_val_cr REAL,rs_20d REAL,rs_60d REAL,above_200_dma INTEGER,above_20_dma INTEGER,higher_highs INTEGER,higher_lows INTEGER,candles_n INTEGER,data_sufficiency TEXT,universe_rank INTEGER,universe_rank_pct REAL,updated_at TEXT);
CREATE TABLE opportunities(symbol TEXT PRIMARY KEY,sector TEXT,roe REAL,de REAL,mcap REAL,ltp REAL,dma_200 REAL,dist_52w_pct REAL,return_6m_pct REAL,vol_1y_pct REAL,momentum_score REAL,rsi_14 REAL,mfi_14 REAL,rs_20d REAL,rs_60d REAL,traded_val_cr REAL,vol_threshold_cr REAL,band_used_pct REAL,credit_test TEXT,filters_passed INTEGER,failed_filters TEXT,verdict TEXT,is_holding INTEGER,sector_slot_available INTEGER,data_sufficiency TEXT,scan_date TEXT,updated_at TEXT);
CREATE TABLE holdings(symbol TEXT PRIMARY KEY,momentum_score REAL,momentum_rank INTEGER,is_bottom_20 INTEGER,highest_close REAL,highest_close_date TEXT,leader_score INTEGER,leader_state TEXT,leader_streak INTEGER,deterioration_streak INTEGER,gtt_stage TEXT,gtt_min_stop REAL,atr_pct REAL,rs_20d REAL,rs_60d REAL,giveback_alert TEXT,pyramid_eligibility TEXT,rotation_status TEXT,time_check TEXT,coverage_alerts TEXT,fundamentals_status TEXT,last_audit TEXT,quantity INTEGER,entry_price REAL,gtt_trigger REAL);
CREATE TABLE alerts(id INTEGER PRIMARY KEY AUTOINCREMENT,alert_type TEXT NOT NULL,symbol TEXT,severity TEXT,message TEXT NOT NULL,resolved INTEGER,created_at TEXT);
CREATE TABLE watchlist(symbol TEXT PRIMARY KEY,momentum_score REAL,updated_at TEXT);
INSERT INTO holdings(symbol,quantity,entry_price,gtt_trigger) VALUES('H1',10,100,90);
INSERT INTO watchlist(symbol) VALUES('W1');
''')

stage = [dict(run_id='r',symbol='S1',sector='Tech',roe=20,de=.2,mcap=50000,crar=None,gross_npa=None,net_npa=None,in_nifty100=0,is_candidate=1,is_watch=0)]
con.execute(STAGING, (json.dumps(stage),))
assert con.execute('SELECT COUNT(*) FROM scan_staging').fetchone()[0] == 1

ind = [dict(symbol='S1',ltp=101,dma_200=90,dma_20=99,high_52w=110,low_52w=70,dist_52w_pct=-8,return_6m_pct=12,vol_1y_pct=25,momentum_score=.48,rsi_14=55,mfi_14=50,atr_14=2,atr_pct=2,traded_val_cr=90,rs_20d=1,rs_60d=2,above_200_dma=1,above_20_dma=1,higher_highs=1,higher_lows=1,candles_n=270,data_sufficiency='FULL',universe_rank=1,universe_rank_pct=1.0)]
con.execute(sql_from_func('bulkIndicatorStatement'), (json.dumps(ind),))
assert con.execute('SELECT ltp FROM indicators WHERE symbol="S1"').fetchone()[0] == 101

opp = [dict(symbol='S1',sector='Tech',roe=20,de=.2,mcap=50000,ltp=101,dma_200=90,dist_52w_pct=-8,return_6m_pct=12,vol_1y_pct=25,momentum_score=.48,rsi_14=55,mfi_14=50,rs_20d=1,rs_60d=2,traded_val_cr=90,vol_threshold_cr=75,band_used_pct=-15,credit_test='DE',filters_passed=8,failed_filters='[]',verdict='BUY_CANDIDATE',is_holding=0,sector_slot_available=1,data_sufficiency='FULL')]
con.execute(sql_from_func('bulkOpportunityStatement'), (json.dumps(opp),))
assert con.execute('SELECT verdict FROM opportunities').fetchone()[0] == 'BUY_CANDIDATE'

hold = [dict(symbol='H1',momentum_score=.5,momentum_rank=1,is_bottom_20=0,highest_close=120,highest_close_date='2026-08-10',leader_score=4,leader_state='LEADER_CANDIDATE',leader_streak=2,deterioration_streak=0,gtt_stage='RISK_REDUCED',gtt_min_stop=97,atr_pct=2,rs_20d=1,rs_60d=2,giveback_alert=None,pyramid_eligibility='FULL_SIZE',rotation_status='HOLD',time_check=None,coverage_alerts='[]',fundamentals_status='OK')]
con.execute(sql_from_func('bulkHoldingStatement'), (json.dumps(hold),))
r = con.execute('SELECT momentum_rank,gtt_min_stop,quantity,gtt_trigger FROM holdings WHERE symbol="H1"').fetchone()
assert r == (1,97,10,90), r

alerts = [dict(alert_type='GTT_STAGE',symbol='H1',severity='INFO',message='x')]
con.execute(sql_from_func('bulkAlertStatement'), (json.dumps(alerts),))
assert con.execute('SELECT alert_type FROM alerts').fetchone()[0] == 'GTT_STAGE'

watch = [dict(symbol='W1',momentum_score=.7)]
con.execute(sql_from_func('bulkWatchlistStatement'), (json.dumps(watch),))
assert con.execute('SELECT momentum_score FROM watchlist').fetchone()[0] == .7

print('QUEUE BULK SQL PASS')
