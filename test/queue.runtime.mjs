import assert from 'node:assert/strict';
import { startQueuedRefresh, SCAN_BATCH_SIZE } from '../src/queue-worker.build.js';

class Stmt {
  constructor(db, sql) { this.db=db; this.sql=sql; this.args=[]; }
  bind(...args) { this.args=args; return this; }
  async first() { return this.db.first(this.sql, this.args); }
  async all() { return { results: this.db.all(this.sql, this.args) }; }
  async run() { return this.db.run(this.sql, this.args); }
}

class FakeDB {
  constructor() { this.stage=[]; this.runs=[]; }
  prepare(sql) { return new Stmt(this, sql); }
  async batch(stmts) { for (const s of stmts) await s.run(); return []; }
  first(sql) {
    if (sql.includes('FROM scan_runs') && sql.includes('status IN')) return null;
    return null;
  }
  all(sql) {
    if (sql.includes('FROM fundamentals_cache')) {
      return Array.from({length:23}, (_,i) => ({
        symbol:`C${i}`, roe:20, de:0.2, mcap:50000,
        crar:null, gross_npa:null, net_npa:null,
        industry:'Technology', in_nifty100:0,
      }));
    }
    if (sql.includes('FROM watchlist')) {
      return [
        {symbol:'C2',sector:'Technology'},
        {symbol:'W1',sector:'Other'},
        {symbol:'W2',sector:'Other'},
      ];
    }
    if (sql.includes('SELECT symbol FROM holdings')) return [{symbol:'C0'},{symbol:'C1'}];
    throw new Error(`Unhandled all(): ${sql}`);
  }
  run(sql, args) {
    if (sql.includes('stale active run superseded')) return {meta:{changes:0}};
    if (sql.includes('INSERT INTO scan_runs')) { this.runs.push(args); return {meta:{changes:1}}; }
    if (sql.includes('INSERT INTO scan_staging')) { this.stage.push(args); return {meta:{changes:1}}; }
    if (sql.includes("UPDATE scan_runs SET status='SCANNING'")) return {meta:{changes:1}};
    if (sql.includes("UPDATE scan_runs SET status='FAILED'")) return {meta:{changes:1}};
    throw new Error(`Unhandled run(): ${sql}`);
  }
}

const sent=[];
const db=new FakeDB();
const env={ DB:db, SCAN_QUEUE:{ async sendBatch(messages){ sent.push(...messages); return {}; } } };
const out=await startQueuedRefresh(env,{dryRun:true,source:'test'});

assert.equal(SCAN_BATCH_SIZE,10);
assert.equal(out.eligibleUniverse,23);
assert.equal(out.totalItems,23); // 23 eligible - 2 held + 2 unique watch-only
assert.equal(out.batchCount,3);
assert.equal(sent.length,3);
assert.ok(sent.every(m => m.body.symbols.length <= 10));
assert.equal(db.stage.length,23);
assert.ok(!db.stage.some(args => args[1] === 'C0' || args[1] === 'C1'));
assert.ok(db.stage.some(args => args[1] === 'W1'));
assert.match(out.note,/operational state/);

console.log('QUEUE RUNTIME START PASS');
