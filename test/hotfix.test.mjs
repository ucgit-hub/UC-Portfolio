import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as S from '../src/strategy.js';

const src = fs.readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
const mig = fs.readFileSync(new URL('../migrations/001_v11_expand.sql', import.meta.url), 'utf8');
let pass=0, fail=0; const failures=[];
function t(name, fn){try{fn();pass++;}catch(e){fail++;failures.push(`${name}: ${e.message}`)}}

t('alerts include NOT NULL alert_type', () => {
  assert.match(src, /INSERT INTO alerts \(alert_type,symbol,severity,message,resolved,created_at\) VALUES \(\?,\?,\?,\?,0,datetime\('now'\)\)/);
  assert.doesNotMatch(src, /INSERT INTO alerts \(symbol,severity,message,resolved,created_at\)/);
});

t('all v1.1 alert paths pass explicit types', () => {
  for (const ty of ['DATA_STALE','GTT_COVERAGE','GIVEBACK','GTT_STAGE','ROTATION_REVIEW','TIME_REVIEW','FUNDAMENTALS_INCOMPLETE']) {
    assert.ok(src.includes(`raiseAlert(DB, "${ty}"`), `${ty} missing`);
  }
});

t('financial candidates are not prefiltered on D/E', () => {
  const block = src.match(/const fundCandidates =[\s\S]*?\.all\(\)\)\.results;/)?.[0] || '';
  assert.ok(block.includes('f.roe>15'));
  assert.ok(!block.includes('f.de<1'));
});

t('scan status does not undercount high-D/E financials', () => {
  const line = src.match(/SELECT COUNT\(\*\) c FROM fundamentals_cache[^\n]+/)?.[0] || '';
  assert.ok(line);
  assert.ok(!line.includes('de<1'));
});

t('financial substitute passes with strong CRAR/NPA despite D/E > 1', () => {
  const r=S.evaluateFilters({mcap:100000,roe:18,de:6.2,above200:true,dist52w:-5,ret6m:20,tradedVal:100,inNifty500:true,inNifty100:true,regime:'NORMAL',isFinancial:true,crar:16.4,gnpa:2.1,nnpa:0.5});
  assert.equal(r.credit_test,'FINANCIAL_SUBSTITUTE');
  assert.equal(r.verdict,'BUY_CANDIDATE');
});

t('financial substitute fails closed when CRAR/NPA missing', () => {
  const r=S.evaluateFilters({mcap:100000,roe:18,de:0.2,above200:true,dist52w:-5,ret6m:20,tradedVal:100,inNifty500:true,inNifty100:true,regime:'NORMAL',isFinancial:true,crar:null,gnpa:null,nnpa:null});
  assert.equal(r.credit_test,'FINANCIAL_SUBSTITUTE');
  assert.equal(r.verdict,'REJECT');
  assert.ok(r.failed_filters.some(x=>x.startsWith('Financial quality')));
});

t('Kite daily_nav uses UPSERT, not REPLACE', () => {
  const block = src.match(/if \(daily_nav\) \{[\s\S]*?updated\.push\("daily_nav"\);\n  \}/)?.[0] || '';
  assert.ok(block.includes('ON CONFLICT(date) DO UPDATE SET'));
  assert.ok(!block.includes('INSERT OR REPLACE INTO daily_nav'));
  for(const protectedCol of ['liquidity_pct','liquidity_target_low','liquidity_target_high','liquidity_status','regime']){
    assert.ok(!new RegExp(`${protectedCol}=excluded\\.${protectedCol}`).test(block), `${protectedCol} must be preserved`);
  }
});

t('EXPAND has exactly 48 live-schema additions', () => {
  const adds=[...mig.matchAll(/ALTER TABLE\s+(\w+)\s+ADD COLUMN\s+(\w+)/g)].map(m=>[m[1],m[2]]);
  assert.equal(adds.length,48);
  const count={}; for(const [tbl] of adds) count[tbl]=(count[tbl]||0)+1;
  assert.deepEqual(count,{indicators:8,holdings:10,nifty500:1,fundamentals_cache:3,daily_nav:5,macro_state:14,opportunities:7});
  assert.ok(!adds.some(([t,c])=>t==='opportunities'&&c==='universe_rank'));
});

t('EXPAND retains legacy coexistence columns and no foreign_keys OFF', () => {
  assert.doesNotMatch(mig,/PRAGMA\s+foreign_keys\s*=\s*OFF/i);
  assert.match(mig,/freeze_active, gate_brent/);
  assert.match(mig,/rotation_replaces remains/);
});

t('EXPAND preserves RUNNER and seeds stop forward-only', () => {
  assert.match(mig,/'PARTIAL_BOOK_DUE','RUNNER','PROTECTED_WINNER'/);
  assert.match(mig,/SET gtt_min_stop=gtt_trigger\s+WHERE gtt_min_stop IS NULL AND gtt_trigger IS NOT NULL/);
});

t('EXPAND flags missing fundamentals', () => {
  assert.match(mig,/SET fundamentals_status='FUNDAMENTALS_DATA_INCOMPLETE'\s+WHERE symbol NOT IN \(SELECT symbol FROM fundamentals_cache\)/);
});

console.log(`HOTFIX REGRESSION pass=${pass} fail=${fail}`);
if(fail){for(const x of failures) console.error('FAIL',x); process.exit(1)}
