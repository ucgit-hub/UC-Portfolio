#!/usr/bin/env python3
from pathlib import Path
import sqlite3

ROOT = Path(__file__).resolve().parents[1]
SQL = (ROOT / 'migrations/004_queue_scan.sql').read_text()

db = sqlite3.connect(':memory:')
# Broker-owned table sentinels: this migration must not alter them.
db.executescript('''
CREATE TABLE holdings(symbol TEXT PRIMARY KEY, quantity INTEGER, gtt_trigger REAL);
CREATE TABLE trades(id INTEGER PRIMARY KEY, symbol TEXT);
CREATE TABLE daily_nav(date TEXT PRIMARY KEY, net_worth REAL);
''')
before = {t: [r[1] for r in db.execute(f'PRAGMA table_info({t})')]
          for t in ('holdings', 'trades', 'daily_nav')}

db.executescript(SQL)
after = {t: [r[1] for r in db.execute(f'PRAGMA table_info({t})')]
         for t in before}
assert before == after, 'queue migration changed broker/legacy tables'

runs = {r[1] for r in db.execute('PRAGMA table_info(scan_runs)')}
stage = {r[1] for r in db.execute('PRAGMA table_info(scan_staging)')}
for c in ['run_id','version','dry_run','status','total_items','completed_items',
          'successful_items','failed_items','summary_json','errors_json','created_at']:
    assert c in runs, c
for c in ['run_id','symbol','indicator_json','error','is_candidate','is_watch','completed_at']:
    assert c in stage, c

idx = {r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='index'")}
for name in ['idx_scan_runs_status_created','idx_scan_staging_run_completed','idx_scan_staging_run_candidate']:
    assert name in idx, name

print('QUEUE SCHEMA PASS')
