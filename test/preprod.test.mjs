import * as S from "../src/strategy.js";
import assert from "node:assert/strict";
let p = 0, f = 0; const fails = [];
const t = (n, fn) => { try { fn(); p++; } catch (e) { f++; fails.push(`${n}: ${e.message}`); } };

// ══ ITEM 1 — RUNNER migration safety ══════════════════════════════════
t("1.1 RUNNER is its own stage, NOT aliased to PARTIAL_BOOK_DUE", () => {
  assert.equal(S.normaliseStage("RUNNER"), "RUNNER");
  assert.ok(S.STAGE_ORDER.includes("RUNNER"));
});
t("1.2 RUNNER ranks above PARTIAL_BOOK_DUE", () =>
  assert.ok(S.STAGE_ORDER.indexOf("RUNNER") > S.STAGE_ORDER.indexOf("PARTIAL_BOOK_DUE")));
t("1.3 synthetic RUNNER row: no duplicate booking signal", () => {
  const r = S.computeGttStage({ entryPrice: 100, highestClose: 130, prevStage: "RUNNER",
    prevStop: null, liveGttTrigger: 95 });
  assert.equal(r.gtt_stage, "RUNNER");
  assert.equal(r.partial_book_due, false);
  assert.equal(r.already_booked, true);
  assert.equal(r.stage_advanced, false);
});
t("1.4 synthetic RUNNER stop is preserved, never lowered", () => {
  const r = S.computeGttStage({ entryPrice: 100, highestClose: 130, prevStage: "RUNNER",
    prevStop: null, liveGttTrigger: 95 });
  assert.ok(r.min_stop >= 95, `min_stop ${r.min_stop} < broker trigger 95`);
});
t("1.5 broker trigger above ladder floor is never loosened", () => {
  const r = S.computeGttStage({ entryPrice: 100, highestClose: 103, prevStage: "ENTRY_RISK",
    prevStop: null, liveGttTrigger: 97.5 });
  assert.equal(r.min_stop, 97.5);
  assert.equal(r.stop_raised_above_live, false);
});
t("1.6 unbooked position at +20% DOES get a booking signal", () => {
  const r = S.computeGttStage({ entryPrice: 100, highestClose: 122, prevStage: "PROFIT_LOCKED", prevStop: 104 });
  assert.equal(r.gtt_stage, "PARTIAL_BOOK_DUE");
  assert.equal(r.partial_book_due, true);
});
t("1.7 PROTECTED_WINNER also suppresses re-booking", () => {
  const r = S.computeGttStage({ entryPrice: 100, highestClose: 140, prevStage: "PROTECTED_WINNER", prevStop: 120 });
  assert.equal(r.partial_book_due, false);
  assert.ok(r.min_stop >= 120);
});
t("1.8 synthetic portfolio matrix: stop never below broker trigger, no re-book", () => {
  const cases = [
    ["SYN01", 100, 112, "CAPITAL_PROTECTED", 101],
    ["SYN02", 200, 205, "ENTRY_RISK", 195],
    ["SYN03", 100, 130, "RUNNER", 95],
    ["SYN04", 100, 116, "PROFIT_LOCKED", 105],
    ["SYN05", 300, 295, "ENTRY_RISK", 276],
    ["SYN06", 400, 390, "ENTRY_RISK", 368],
    ["SYN07", 500, 510, "ENTRY_RISK", 460],
    ["SYN08", 600, 630, "RISK_REDUCED", 582],
    ["SYN09", 700, 770, "CAPITAL_PROTECTED", 704],
    ["SYN10", 800, 850, "RISK_REDUCED", 776],
    ["SYN11", 900, 1050, "PROFIT_LOCKED", 974],
  ];
  for (const [sym, entry, hc, stage, trig] of cases) {
    const r = S.computeGttStage({ entryPrice: entry, highestClose: hc, prevStage: stage, prevStop: null, liveGttTrigger: trig });
    assert.ok(r.min_stop >= trig, `${sym}: min_stop ${r.min_stop} below broker trigger ${trig}`);
    assert.ok(S.STAGE_ORDER.indexOf(r.gtt_stage) >= S.STAGE_ORDER.indexOf(S.normaliseStage(stage)),
      `${sym}: stage regressed ${stage} -> ${r.gtt_stage}`);
    if (stage === "RUNNER") assert.equal(r.partial_book_due, false, `${sym}: duplicate booking`);
  }
});

// ══ ITEM 2 — trade limits and rotation gate ═══════════════════════════
const A = k => ({ kind: k });
t("2.1 three discretionary actions allowed", () =>
  assert.equal(S.checkDailyActionLimit([A("BUY"), A("SELL")], "PYRAMID").allowed, true));
t("2.2 fourth discretionary action blocked", () =>
  assert.equal(S.checkDailyActionLimit([A("BUY"), A("SELL"), A("PYRAMID")], "BUY").allowed, false));
t("2.3 mandatory exits exempt even at the cap", () => {
  const r = S.checkDailyActionLimit([A("BUY"), A("SELL"), A("PYRAMID")], "CORPORATE_EXIT");
  assert.equal(r.allowed, true); assert.equal(r.exempt, true);
});
t("2.4 mandatory exits do not consume slots", () => {
  const r = S.checkDailyActionLimit([A("GAP_DOWN_EXIT"), A("STOP_EXIT"), A("GTT_TRIGGERED"), A("BUY")], "SELL");
  assert.equal(r.used, 1); assert.equal(r.allowed, true);
});
t("2.5 one discretionary rotation per week", () => {
  assert.equal(S.checkWeeklyRotationLimit([], false).allowed, true);
  assert.equal(S.checkWeeklyRotationLimit([{ mandatory: false }], false).allowed, false);
});
t("2.6 mandatory rotations exempt and uncounted", () => {
  assert.equal(S.checkWeeklyRotationLimit([{ mandatory: true }, { mandatory: true }], false).allowed, true);
  assert.equal(S.checkWeeklyRotationLimit([{ mandatory: false }], true).allowed, true);
});

const GOOD_REPL = { verdict: "BUY_CANDIDATE", data_sufficiency: "FULL", momentum_score: 1.4,
  universe_rank_pct: 8, binary_event_within_2d: false, sector_slot_available: true };
t("2.7 rotation permitted only with deterioration AND superior replacement", () => {
  const r = S.evaluateRotation({ deteriorationSignals: 2, replacement: GOOD_REPL,
    rotationsThisWeek: [], existingMomentumScore: 0.4 });
  assert.equal(r.rotation_permitted, true);
  assert.equal(r.requires_approval, true);
});
t("2.8 blocked with only 1 deterioration signal", () =>
  assert.equal(S.evaluateRotation({ deteriorationSignals: 1, replacement: GOOD_REPL,
    rotationsThisWeek: [], existingMomentumScore: 0.4 }).rotation_permitted, false));
t("2.9 blocked when replacement fails a filter", () =>
  assert.equal(S.evaluateRotation({ deteriorationSignals: 3,
    replacement: { ...GOOD_REPL, verdict: "REJECT" }, rotationsThisWeek: [], existingMomentumScore: 0.4 }).rotation_permitted, false));
t("2.10 blocked when replacement only marginally stronger in rank", () =>
  assert.equal(S.evaluateRotation({ deteriorationSignals: 3,
    replacement: { ...GOOD_REPL, universe_rank_pct: 45 }, rotationsThisWeek: [], existingMomentumScore: 0.4 }).rotation_permitted, false));
t("2.11 blocked when replacement not stronger than holding", () =>
  assert.equal(S.evaluateRotation({ deteriorationSignals: 3, replacement: GOOD_REPL,
    rotationsThisWeek: [], existingMomentumScore: 1.9 }).rotation_permitted, false));
t("2.12 blocked when replacement data not FULL", () =>
  assert.equal(S.evaluateRotation({ deteriorationSignals: 3,
    replacement: { ...GOOD_REPL, data_sufficiency: "PARTIAL_NO_200DMA" }, rotationsThisWeek: [], existingMomentumScore: 0.4 }).rotation_permitted, false));
t("2.13 blocked by weekly cap even when both gates pass", () =>
  assert.equal(S.evaluateRotation({ deteriorationSignals: 3, replacement: GOOD_REPL,
    rotationsThisWeek: [{ mandatory: false }], existingMomentumScore: 0.4 }).rotation_permitted, false));
t("2.14 no rotation path ever auto-executes", () => {
  const r = S.evaluateRotation({ deteriorationSignals: 3, replacement: GOOD_REPL,
    rotationsThisWeek: [], existingMomentumScore: 0.4 });
  assert.ok(/explicit approval/.test(r.note));
});

// ══ ITEM 5 — midcap RS + macro fail-safes ═════════════════════════════
t("5.1 midcap RS computed from index prices", () => {
  const mid = Array.from({ length: 40 }, (_, i) => 100 * 1.004 ** i);
  const nif = Array.from({ length: 40 }, (_, i) => 100 * 1.001 ** i);
  const r = S.midcapOutperformance(mid, nif);
  assert.equal(r.midcaps_outperforming, true);
  assert.ok(r.midcap_rs_20d > 0);
});
t("5.2 midcap underperformance detected", () => {
  const mid = Array.from({ length: 40 }, (_, i) => 100 * 1.0005 ** i);
  const nif = Array.from({ length: 40 }, (_, i) => 100 * 1.004 ** i);
  assert.equal(S.midcapOutperformance(mid, nif).midcaps_outperforming, false);
});
t("5.3 unresolved midcap index yields null, never true", () =>
  assert.equal(S.midcapOutperformance(null, [1, 2, 3]).midcaps_outperforming, null));
t("5.4 FAIL-SAFE: VIX>25 with unknown systemic stress => CRISIS", () => {
  const r = S.detectRegime({ vix: 31, niftyAbove50dma: false, systemicStress: null,
    fiiNetBuyers5d: null, fiiNetSellers3d: null, midcapsOutperforming: null, breadthPct: null });
  assert.equal(r.regime, "CRISIS");
  assert.equal(r.fail_safe, true);
});
t("5.5 only an explicit false downgrades CRISIS", () =>
  assert.equal(S.detectRegime({ vix: 31, niftyAbove50dma: false, systemicStress: false,
    fiiNetSellers3d: true, fiiNetBuyers5d: false, midcapsOutperforming: false, breadthPct: 10 }).regime, "CHOPPY"));
t("5.6 FAIL-SAFE: unknown FII counts toward CHOPPY, not calm", () =>
  assert.equal(S.detectRegime({ vix: 19, niftyAbove50dma: true, systemicStress: false,
    fiiNetBuyers5d: null, fiiNetSellers3d: null, midcapsOutperforming: true, breadthPct: 50 }).regime, "CHOPPY"));
t("5.7 total macro blackout never yields BULL or NORMAL-calm", () => {
  const r = S.detectRegime({ vix: 19, niftyAbove50dma: null, systemicStress: null,
    fiiNetBuyers5d: null, fiiNetSellers3d: null, midcapsOutperforming: null, breadthPct: null });
  assert.notEqual(r.regime, "BULL");
  assert.ok(r.missing_inputs.length > 0);
});
t("5.8 stale macro inputs treated as absent (session-aware)", () => {
  const sess = ["2026-08-03","2026-08-04","2026-08-05","2026-08-06","2026-08-07"];
  const now = Date.parse("2026-08-10T03:45:00Z");
  assert.equal(S.freshOrNull(true, S.fiiFreshness("2026-07-31", sess, now)), null);
  assert.equal(S.freshOrNull(true, S.fiiFreshness("2026-08-07", sess, now)), true);
});
t("5.9 stale FII cannot manufacture BULL (session-aware)", () => {
  const sess = ["2026-08-03","2026-08-04","2026-08-05","2026-08-06","2026-08-07"];
  const fr = S.fiiFreshness("2026-07-20", sess, Date.parse("2026-08-10T03:45:00Z"));
  const r = S.detectRegime({ vix: 12, niftyAbove50dma: true,
    fiiNetBuyers5d: S.freshOrNull(true, fr), fiiNetSellers3d: S.freshOrNull(false, fr),
    midcapsOutperforming: true, breadthPct: 70, systemicStress: S.freshOrNull(false, fr) });
  assert.notEqual(r.regime, "BULL");
});

console.log(`\nPRE-PROD TESTS  pass=${p}  fail=${f}`);
if (f) { console.log(fails.map(x => "  FAIL " + x).join("\n")); process.exit(1); }
