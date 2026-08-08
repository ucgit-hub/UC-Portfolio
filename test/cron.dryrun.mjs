// Non-destructive cron dry-run. Mock D1 seeded only from synthetic fixtures, mock Yahoo.
// Production D1 is never contacted.
import assert from "node:assert/strict";

const HOLDINGS = [
  { symbol: "ALPHA", exchange: "NSE", sector: "Pharma", entry_date: "2026-06-20", entry_price: 100, quantity: 10, highest_close: 112, gtt_stage: "CAPITAL_PROTECTED", gtt_id: 1001, gtt_qty: 10, gtt_trigger: 101, leader_state: "UNPROVEN", leader_streak: 0 },
  { symbol: "BETA", exchange: "NSE", sector: "Capital Goods", entry_date: "2026-07-28", entry_price: 200, quantity: 5, highest_close: 205, gtt_stage: "ENTRY_RISK", gtt_id: 1002, gtt_qty: 5, gtt_trigger: 195, leader_state: "UNPROVEN", leader_streak: 0 },
  { symbol: "BSETEST", exchange: "BSE", sector: "Financial Services", entry_date: "2026-04-15", entry_price: 100, quantity: 8, highest_close: 130, gtt_stage: "RUNNER", gtt_id: 1003, gtt_qty: 8, gtt_trigger: 95, leader_state: "UNPROVEN", leader_streak: 0 },
  { symbol: "GAMMA", exchange: "NSE", sector: "Metals & Mining", entry_date: "2026-05-10", entry_price: 300, quantity: 6, highest_close: 350, gtt_stage: "PROFIT_LOCKED", gtt_id: 1004, gtt_qty: 6, gtt_trigger: 320, leader_state: "UNPROVEN", leader_streak: 2 },
  { symbol: "DELTA", exchange: "NSE", sector: "Pharma", entry_date: "2026-07-14", entry_price: 250, quantity: 12, highest_close: 245, gtt_stage: "ENTRY_RISK", gtt_id: 1005, gtt_qty: 7, gtt_trigger: 230, leader_state: "UNPROVEN", leader_streak: 0 },
];
const CONFIG = [["baseline", "1000000"], ["cash_kite", "150000"], ["cash_bank", "50000"],
  ["liquidbees_qty", "20"], ["liquidbees_nav", "1000"], ["nifty50_baseline", "22000"], ["nifty500_baseline", "20000"]];
const FUND = [
  { symbol: "CANDIDATE1", roe: 22, de: 0.15, mcap: 55000, crar: null, gross_npa: null, net_npa: null, industry: "Chemicals", in_nifty100: 0 },
  { symbol: "BANKPASS", roe: 18, de: 6.2, mcap: 150000, crar: 16.4, gross_npa: 2.1, net_npa: 0.5, industry: "Financial Services", in_nifty100: 1 },
  { symbol: "BANKFAIL", roe: 19, de: 5.9, mcap: 60000, crar: null, gross_npa: null, net_npa: null, industry: "Financial Services", in_nifty100: 0 },
];

// ── Mock D1 ───────────────────────────────────────────────────────────
const writes = [];
function countSqlPlaceholders(sql) {
  let count = 0, quote = null;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (quote) {
      if (ch === quote) {
        if (sql[i + 1] === quote) i++; else quote = null;
      }
      continue;
    }
    if (ch === "'" || ch === '"') { quote = ch; continue; }
    if (ch === "?") count++;
  }
  return count;
}
function assertBindArity(sql, args) {
  const expected = countSqlPlaceholders(sql);
  assert.equal(args.length, expected, `SQL bind arity mismatch: expected ${expected}, got ${args.length}: ${sql.replace(/\s+/g, " ").trim().slice(0, 160)}`);
}
function mockDB(readSpy) {
  const handle = (sql, args = []) => {
    const s = sql.replace(/\s+/g, " ").trim();
    if (/^\s*(INSERT|UPDATE|DELETE|REPLACE)/i.test(s)) { writes.push({ sql: s, args }); return { kind: "write" }; }
    readSpy.push(s.slice(0, 60));
    if (/FROM macro_state/i.test(s)) return { kind: "first", row: { id: 1, brent_price: 80.16, vix: 12.15, regime: "NORMAL", fii_net_buyers_5d: 1, fii_net_sellers_3d: 0, midcaps_outperforming: 1, systemic_stress: 0, fii_as_of_date: new Date((Date.UTC(2025,6,1)/1000 + 269*86400)*1000).toISOString().slice(0,10), updated_at: new Date(Date.now()-6*3600e3).toISOString().replace('T',' ').slice(0,19) } };
    if (/AVG\(above_200_dma\)/i.test(s)) return { kind: "first", row: { pct: 68.0, n: 40 } };
    if (/FROM watchlist/i.test(s)) return { kind: "all", rows: [{ symbol: "WATCH1", sector: "Capital Goods" }] };
    if (/FROM holdings/i.test(s)) return { kind: "all", rows: HOLDINGS };
    if (/FROM fundamentals_cache f JOIN/i.test(s)) return { kind: "all", rows: FUND };
    if (/FROM config/i.test(s)) return { kind: "all", rows: CONFIG.map(([key, value]) => ({ key, value })) };
    if (/FROM daily_nav/i.test(s)) return { kind: "first", row: { net_worth: 700000 } };
    return { kind: "all", rows: [] };
  };
  return {
    prepare(sql) {
      const exec = (args) => handle(sql, args);
      return {
        bind: (...a) => { assertBindArity(sql, a); const r = exec(a); return {
          run: async () => ({ success: true }),
          all: async () => ({ results: r.kind === "all" ? r.rows : [] }),
          first: async () => (r.kind === "first" ? r.row : null) }; },
        run: async () => { exec([]); return { success: true }; },
        all: async () => { const r = exec([]); return { results: r.kind === "all" ? r.rows : [] }; },
        first: async () => { const r = exec([]); return r.kind === "first" ? r.row : null; },
      };
    },
  };
}

// ── Mock Yahoo ────────────────────────────────────────────────────────
function synth(n, start, drift, seed) {
  let v = start, r = seed; const out = [];
  const day0 = Date.UTC(2025, 6, 1) / 1000;
  for (let i = 0; i < n; i++) {
    r = (r * 1103515245 + 12345) % 2147483648;
    const noise = ((r / 2147483648) - 0.5) * 0.02;
    v = v * (1 + drift + noise);
    out.push({ t: day0 + i * 86400, o: v * 0.995, h: v * 1.01, l: v * 0.99, c: v, v: 900000 + (r % 200000) });
  }
  return out;
}
const SERIES = {
  "^NSEI": synth(270, 22000, 0.0006, 7), "^CRSLDX": synth(270, 20000, 0.0006, 11), "^NSEMDCP50": synth(270, 12000, 0.0060, 13),
  "^INDIAVIX": Array.from({length:270},(_,i)=>({t:Date.UTC(2025,6,1)/1000+i*86400,o:12.1,h:12.3,l:12.0,c:12.15,v:0})),
  "ALPHA.NS": synth(270, 90, 0.0010, 21), "BETA.NS": synth(270, 190, 0.0006, 22),
  "BSETEST.BO": synth(270, 110, -0.0004, 23), "GAMMA.NS": synth(270, 280, 0.0014, 24),
  "DELTA.NS": synth(270, 255, -0.0002, 25), "WATCH1.NS": synth(270, 300, 0.0009, 26),
  "CANDIDATE1.NS": synth(270, 320, 0.0011, 27), "BANKPASS.NS": synth(270, 150, 0.0008, 28),
  "BANKFAIL.NS": synth(270, 400, 0.0007, 29),
};
const fetched = [];
globalThis.fetch = async (url) => {
  const sym = decodeURIComponent(String(url).match(/chart\/([^?]+)/)[1]);
  fetched.push(sym);
  const s = SERIES[sym];
  if (!s) return { ok: false, status: 404, json: async () => ({}) };
  return { ok: true, status: 200, json: async () => ({ chart: { result: [{
    timestamp: s.map(x => x.t),
    indicators: { quote: [{ open: s.map(x => x.o), high: s.map(x => x.h), low: s.map(x => x.l), close: s.map(x => x.c), volume: s.map(x => x.v) }],
      adjclose: [{ adjclose: s.map(x => x.c) }] } }] } }) };
};

// ── Run ───────────────────────────────────────────────────────────────
const { dailyCron } = await import("../src/index.build.js");
const reads = [];
const log = await dailyCron({ DB: mockDB(reads) }, { dryRun: false });

let p = 0, f = 0; const fails = [];
const t = (n, fn) => { try { fn(); p++; } catch (e) { f++; fails.push(`${n}: ${e.message}`); } };

t("SQL bind-arity guard rejects mismatches", () => {
  const db = mockDB([]);
  assert.throws(() => db.prepare("UPDATE config SET value=? WHERE key=?").bind("only-one"), /bind arity mismatch/);
});

t("cron completes", () => assert.ok(log.finished));
t("no silent BSE fallback: synthetic BSE symbol fetched as .BO only", () => {
  assert.ok(fetched.includes("BSETEST.BO"));
  assert.ok(!fetched.includes("BSETEST.NS"));
});
t("regime classified via v1.1 framework", () => {
  assert.equal(log.parts.macro.regime, "BULL");
  assert.ok(/FII net buyers/.test(log.parts.macro.rationale));
});
t("breadth computed and used", () => assert.equal(log.parts.macro.breadthPct, 68));
t("no legacy gate fields in output", () =>
  assert.ok(!/freeze_active|gate_brent|gate_vix|gate_nifty/.test(JSON.stringify(log))));
t("no rotation_replaces written", () =>
  assert.ok(!writes.some(w => /rotation_replaces/.test(w.sql))));
t("liquidity includes cash_bank", () => {
  assert.equal(log.parts.nav.cash_bank, 50000);
  assert.equal(log.parts.nav.total_liquidity,
    log.parts.nav.cash_kite + log.parts.nav.cash_bank + log.parts.nav.liquidbees_value);
});
t("liquidity target attached to regime", () =>
  assert.deepEqual([log.parts.nav.liquidity.target_low, log.parts.nav.liquidity.target_high], [10, 15]));
t("BULL sizing 5-7%", () => assert.equal(log.parts.scan.entrySizing.max, 7));
t("every holding gets stage + leader + reviews", () => {
  for (const h of log.parts.holdings.state) {
    assert.ok(h.stage, `${h.symbol} missing stage`);
    assert.ok(h.leader, `${h.symbol} missing leader state`);
    assert.ok(typeof h.minStop === "number", `${h.symbol} missing min stop`);
    assert.ok(h.pyramid, `${h.symbol} missing pyramid verdict`);
  }
});
t("synthetic legacy RUNNER not regressed", () => {
  const c = log.parts.holdings.state.find(x => x.symbol === "BSETEST");
  assert.equal(c.stage, "RUNNER");
});
t("synthetic partial GTT coverage flagged", () =>
  assert.ok(writes.some(w => /INSERT INTO alerts/.test(w.sql) &&
    JSON.stringify(w.args).includes("QTY_UNCOVERED"))));
t("financial without CRAR/NPA rejected", () =>
  assert.ok(writes.some(w => /opportunities/.test(w.sql) && JSON.stringify(w.args).includes("BANKFAIL") &&
    JSON.stringify(w.args).includes("Financial quality"))));
t("financial with passing CRAR/NPA not auto-rejected on D/E", () => {
  const w = writes.find(x => /opportunities/.test(x.sql) && JSON.stringify(x.args).includes("BANKPASS"));
  assert.ok(!JSON.stringify(w.args).includes("Financial quality"));
});
t("Nifty100 tier from membership column, not mcap", () => {
  const big = writes.find(x => /opportunities/.test(x.sql) && JSON.stringify(x.args).includes("BANKPASS"));
  const pi = writes.find(x => /opportunities/.test(x.sql) && JSON.stringify(x.args).includes("CANDIDATE1"));
  assert.ok(big.args.includes(50), "BANKPASS (in_nifty100=1) should use 50Cr");
  assert.ok(pi.args.includes(75), "CANDIDATE1 (in_nifty100=0, mcap 55k) should use 75Cr");
});
t("universe ranking written", () =>
  assert.ok(writes.some(w => /UPDATE indicators SET universe_rank/.test(w.sql))));
t("MFI + RS persisted", () => {
  const w = writes.find(x => /INSERT INTO indicators/.test(x.sql));
  assert.equal(w.args.length, 25);
});
t("data_sufficiency recorded", () =>
  assert.ok(writes.some(w => /INSERT INTO indicators/.test(w.sql) && w.args.includes("FULL"))));
t("no trades table writes during cron", () =>
  assert.ok(!writes.some(w => /INSERT INTO trades|UPDATE trades|DELETE FROM trades/i.test(w.sql))));
t("holdings quantity/entry never written", () => {
  const hw = writes.filter(w => /UPDATE holdings/.test(w.sql));
  assert.ok(hw.length > 0);
  assert.ok(!hw.some(w => /quantity=|entry_price=|entry_date=/.test(w.sql)));
});
t("daily_nav written once for today", () =>
  assert.equal(writes.filter(w => /daily_nav/.test(w.sql)).length, 1));

// ══ ITEM 6 — broker-originated fields are NEVER written by cron ══════
const BROKER_COLUMNS = ["gtt_id", "gtt_trigger", "gtt_limit", "gtt_qty",
  "quantity", "entry_price", "entry_date", "exchange"];
t("6.1 cron never writes any broker-originated holdings column", () => {
  const bad = [];
  for (const w of writes.filter(x => /UPDATE holdings|INSERT INTO holdings|REPLACE INTO holdings/i.test(x.sql))) {
    for (const col of BROKER_COLUMNS) {
      if (new RegExp(`\\b${col}\\s*=`).test(w.sql)) bad.push(`${col} in "${w.sql}"`);
    }
  }
  assert.deepEqual(bad, [], "broker columns written: " + bad.join(" | "));
});
t("6.2 cron never writes the trades table", () =>
  assert.equal(writes.filter(w => /\btrades\b/i.test(w.sql)).length, 0));
t("6.3 cron never writes any orders table", () =>
  assert.equal(writes.filter(w => /\borders\b/i.test(w.sql)).length, 0));
t("6.4 strategy-owned columns DO update", () => {
  const hw = writes.filter(w => /UPDATE holdings/i.test(w.sql));
  assert.ok(hw.length > 0, "no holdings updates at all");
  for (const col of ["gtt_stage", "gtt_min_stop", "leader_state", "leader_score",
                     "giveback_alert", "pyramid_eligibility", "rotation_status",
                     "highest_close", "momentum_rank", "coverage_alerts"]) {
    assert.ok(hw.some(w => new RegExp(`\\b${col}=`).test(w.sql)), `${col} not updated`);
  }
});
t("6.5 gtt_min_stop is strategy-owned and distinct from broker gtt_trigger", () => {
  const hw = writes.filter(w => /UPDATE holdings/i.test(w.sql));
  assert.ok(hw.some(w => /gtt_min_stop=/.test(w.sql)));
  assert.ok(!hw.some(w => /gtt_trigger=/.test(w.sql)));
});
t("6.6 coverage breaches raise alerts rather than mutating GTTs", () => {
  const alertWrites = writes.filter(w => /INSERT INTO alerts/i.test(w.sql));
  assert.ok(alertWrites.length > 0);
  assert.ok(!writes.some(w => /UPDATE holdings/i.test(w.sql) && /gtt_qty=|gtt_id=/.test(w.sql)));
});
t("6.7 midcap RS computed and logged", () => {
  assert.ok("midcapRs20" in log.parts.macro);
  assert.ok("fiiFreshness" in log.parts.macro);
  assert.ok("last_session" in log.parts.macro.fiiFreshness);
});

// ── Regime matrix ─────────────────────────────────────────────────────
const { detectRegime, band52w, entrySizingPct, LIQUIDITY_TARGETS } = await import("../src/strategy.js");
const CASES = [
  ["BULL", { vix: 12, niftyAbove50dma: true, fiiNetBuyers5d: true, fiiNetSellers3d: false, midcapsOutperforming: true, breadthPct: 70, systemicStress: false }],
  ["NORMAL", { vix: 17, niftyAbove50dma: true, fiiNetBuyers5d: false, fiiNetSellers3d: false, midcapsOutperforming: false, breadthPct: 55, systemicStress: false }],
  ["CHOPPY", { vix: 21, niftyAbove50dma: false, fiiNetBuyers5d: false, fiiNetSellers3d: true, midcapsOutperforming: false, breadthPct: 35, systemicStress: false }],
  ["CRISIS", { vix: 31, niftyAbove50dma: false, fiiNetBuyers5d: false, fiiNetSellers3d: true, midcapsOutperforming: false, breadthPct: 12, systemicStress: true }],
];
console.log("\nREGIME MATRIX");
console.log("Regime  | Detected | 52W band | Entry size    | Liquidity | Max entries/day");
for (const [expect, inp] of CASES) {
  const r = detectRegime(inp), sz = entrySizingPct(r.regime), lt = LIQUIDITY_TARGETS[r.regime];
  t(`regime ${expect}`, () => assert.equal(r.regime, expect));
  console.log(`${expect.padEnd(7)} | ${r.regime.padEnd(8)} | ${String(band52w(r.regime) ?? "none").padEnd(8)} | ${(sz.max ? sz.min + "-" + sz.max + "%" : "no entries").padEnd(13)} | ${(lt[0] + "-" + lt[1] + "%").padEnd(9)} | ${sz.maxNewEntriesPerDay ?? "-"}`);
}

console.log(`\nCRON DRY-RUN  pass=${p}  fail=${f}`);
console.log(`writes attempted (mock only): ${writes.length} | yahoo calls: ${fetched.length}`);
if (f) { console.log(fails.map(x => "  FAIL " + x).join("\n")); process.exit(1); }
