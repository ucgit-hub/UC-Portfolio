import assert from 'node:assert/strict';
import fs from 'node:fs';

const src = fs.readFileSync(new URL('../src/queue-worker.js', import.meta.url), 'utf8');
const wrangler = fs.readFileSync(new URL('../wrangler.toml', import.meta.url), 'utf8');
let pass=0, fail=0;
function t(name, fn){try{fn();pass++;console.log('PASS',name)}catch(e){fail++;console.error('FAIL',name,e.message)}}

t('queue version is v1.1.1',()=>assert.match(src,/const VERSION = "v1\.1\.1-queue"/));
t('candidate network batch is conservative',()=>{
  const n=Number(src.match(/const SCAN_BATCH_SIZE = (\d+)/)?.[1]);
  assert.ok(n>0 && n<=10, `batch=${n}`);
});
t('refresh is queued not synchronous dailyCron',()=>{
  assert.match(src,/url\.pathname === "\/api\/refresh"/);
  assert.match(src,/startQueuedRefresh/);
  assert.ok(!src.includes('dailyCron(env'));
});
t('holdings excluded from queued candidate requests',()=>assert.match(src,/if \(holdingSymbols\.has\(f\.symbol\)\) continue/));
t('full-rank actions fail closed on incomplete staging',()=>{
  assert.match(src,/const universeComplete = stagedErrors\.length === 0/);
  assert.match(src,/REJECT_SCAN_INCOMPLETE/);
  assert.match(src,/HOLD_SCAN_INCOMPLETE/);
  assert.match(src,/BLOCKED_SCAN_INCOMPLETE/);
});
t('dry distributed run returns before production writes',()=>{
  const dry=src.indexOf('if (dryRun) {');
  const prod=src.indexOf('Production writes start only here');
  assert.ok(dry>=0 && prod>dry);
});
t('NAV is UPSERT and never REPLACE in queue worker',()=>{
  assert.match(src,/ON CONFLICT\(date\) DO UPDATE SET/);
  assert.doesNotMatch(src,/INSERT OR REPLACE INTO daily_nav/);
});
t('broker-owned tables are never mutated',()=>{
  assert.doesNotMatch(src,/UPDATE\s+trades/i);
  assert.doesNotMatch(src,/DELETE\s+FROM\s+trades/i);
  assert.doesNotMatch(src,/UPDATE\s+holdings\s+SET[^;]*(quantity|entry_price|entry_date|gtt_id|gtt_trigger|gtt_qty)/is);
});
t('queue retries transient fetch failures',()=>{
  assert.match(src,/isRetryableFetchError/);
  assert.match(src,/msg\.retry\(/);
});
t('production publication is atomic and bounded for D1 Free',()=>{
  assert.match(src,/const tx = \[\]/);
  assert.match(src,/await env\.DB\.batch\(tx\)/);
  assert.match(src,/publication_query_budget_exceeded/);
  assert.match(src,/json_each\(\?\)/);
  assert.match(src,/json_each\(\?1\)/);
});
t('starter bulk-loads staging in one D1 statement',()=>{
  assert.match(src,/const stagingPayload/);
  assert.match(src,/FROM json_each\(\?\)/);
  assert.ok(!src.includes('env.DB.batch(statements)'));
});
t('scan status reports progress and summary',()=>{
  assert.match(src,/progressPct/);
  assert.match(src,/summary: safeJson/);
});
t('wrangler binds producer queue',()=>{
  assert.match(wrangler,/\[\[queues\.producers\]\]/);
  assert.match(wrangler,/binding = "SCAN_QUEUE"/);
  assert.match(wrangler,/queue = "uc-momentum-scan"/);
});
t('consumer receives one batch-message per invocation',()=>{
  assert.match(wrangler,/max_batch_size = 1/);
  assert.match(wrangler,/max_concurrency = 1/);
  assert.match(wrangler,/dead_letter_queue = "uc-momentum-scan-dlq"/);
});

console.log(`QUEUE TEST pass=${pass} fail=${fail}`);
if(fail) process.exit(1);
