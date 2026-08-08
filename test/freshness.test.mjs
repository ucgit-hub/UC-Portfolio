import * as S from "../src/strategy.js";
import assert from "node:assert/strict";
let p = 0, f = 0; const fails = [];
const t = (n, fn) => { try { fn(); p++; } catch (e) { f++; fails.push(`${n}: ${e.message}`); } };

// IST helper: build a UTC ms value for a given IST wall-clock time.
const ist = (d, hh, mm) => Date.parse(`${d}T00:00:00Z`) + (hh * 60 + mm - 330) * 60000;

// Real NSE session dates (Nifty candle dates). Aug 2026:
//  Mon 3, Tue 4, Wed 5, Thu 6, Fri 7 traded. Sat 8 / Sun 9 closed.
//  Mon 10 traded. Fri 14 traded; Sat 15 Independence Day (already a weekend).
//  Thu 27 Aug — modelled as an exchange holiday: absent from the series.
const SESSIONS = [
  "2026-07-30", "2026-07-31",
  "2026-08-03", "2026-08-04", "2026-08-05", "2026-08-06", "2026-08-07",
  "2026-08-10", "2026-08-11", "2026-08-12", "2026-08-13", "2026-08-14",
  "2026-08-17", "2026-08-18", "2026-08-19", "2026-08-20", "2026-08-21",
  "2026-08-24", "2026-08-25", "2026-08-26", /* 27th = holiday, absent */ "2026-08-28",
];

// ══ CASE A — normal weekday ═══════════════════════════════════════════
t("A1 mid-session: last completed session is the prior day", () =>
  assert.equal(S.lastCompletedSession(SESSIONS, ist("2026-08-11", 11, 0)), "2026-08-10"));
t("A2 after 15:30: today counts as completed", () =>
  assert.equal(S.lastCompletedSession(SESSIONS, ist("2026-08-11", 17, 0)), "2026-08-11"));
t("A3 exactly 15:30 counts as completed", () =>
  assert.equal(S.lastCompletedSession(SESSIONS, ist("2026-08-11", 15, 30)), "2026-08-11"));
t("A4 Tue 09:15 with Monday FII => FRESH", () => {
  const r = S.fiiFreshness("2026-08-10", SESSIONS, ist("2026-08-11", 9, 15));
  assert.equal(r.fresh, true);
  assert.equal(r.last_session, "2026-08-10");
});
t("A5 Tue 09:15 with Friday FII => STALE (2 sessions behind)", () => {
  const r = S.fiiFreshness("2026-08-07", SESSIONS, ist("2026-08-11", 9, 15));
  assert.equal(r.fresh, false);
  assert.equal(r.sessions_behind, 1);
});
t("A6 evening run with same-day FII => FRESH", () =>
  assert.equal(S.fiiFreshness("2026-08-11", SESSIONS, ist("2026-08-11", 17, 30)).fresh, true));

// ══ CASE B — weekend gap (the 36h rule's core failure) ════════════════
t("B1 Sat: last completed session is Friday", () =>
  assert.equal(S.lastCompletedSession(SESSIONS, ist("2026-08-08", 11, 0)), "2026-08-07"));
t("B2 Sun: still Friday", () =>
  assert.equal(S.lastCompletedSession(SESSIONS, ist("2026-08-09", 20, 0)), "2026-08-07"));
t("B3 MONDAY 09:15 with FRIDAY FII => FRESH", () => {
  const r = S.fiiFreshness("2026-08-07", SESSIONS, ist("2026-08-10", 9, 15));
  assert.equal(r.fresh, true, r.reason);
  assert.equal(r.last_session, "2026-08-07");
});
t("B4 the old 36h rule would have failed this", () => {
  const hours = (ist("2026-08-10", 9, 15) - Date.parse("2026-08-07T18:00:00Z")) / 3600000;
  assert.ok(hours > 36, `only ${hours.toFixed(1)}h`);
  assert.equal(S.fiiFreshness("2026-08-07", SESSIONS, ist("2026-08-10", 9, 15)).fresh, true);
});
t("B5 Sunday run with Friday FII => FRESH", () =>
  assert.equal(S.fiiFreshness("2026-08-07", SESSIONS, ist("2026-08-09", 10, 0)).fresh, true));
t("B6 Monday with Thursday FII => STALE", () =>
  assert.equal(S.fiiFreshness("2026-08-06", SESSIONS, ist("2026-08-10", 9, 15)).fresh, false));

// ══ CASE C — NSE exchange holiday gap ═════════════════════════════════
// Thu 2026-08-27 is closed. On Fri 28 pre-open, Wed 26 is the latest print.
t("C1 holiday absent from calendar: last session skips it", () =>
  assert.equal(S.lastCompletedSession(SESSIONS, ist("2026-08-27", 17, 0)), "2026-08-26"));
t("C2 Friday after Thursday holiday: WEDNESDAY FII => FRESH", () => {
  const r = S.fiiFreshness("2026-08-26", SESSIONS, ist("2026-08-28", 9, 15));
  assert.equal(r.fresh, true, r.reason);
  assert.equal(r.last_session, "2026-08-26");
});
t("C3 holiday itself: Wednesday FII => FRESH all day", () => {
  assert.equal(S.fiiFreshness("2026-08-26", SESSIONS, ist("2026-08-27", 9, 15)).fresh, true);
  assert.equal(S.fiiFreshness("2026-08-26", SESSIONS, ist("2026-08-27", 20, 0)).fresh, true);
});
t("C4 no holiday list is maintained anywhere", () => {
  const src = S.lastCompletedSession.toString() + S.fiiFreshness.toString();
  assert.ok(!/holiday|HOLIDAY/i.test(src));
});
t("C5 long weekend (Fri holiday + Sat/Sun): Thursday FII fresh on Monday", () => {
  const sess = ["2026-09-01", "2026-09-02", "2026-09-03"];
  const r = S.fiiFreshness("2026-09-03", sess, ist("2026-09-07", 9, 15));
  assert.equal(r.fresh, true, r.reason);
});

// ══ CASE D — genuinely stale or missing data ══════════════════════════
t("D1 week-old FII => STALE with session count", () => {
  const r = S.fiiFreshness("2026-07-31", SESSIONS, ist("2026-08-11", 9, 15));
  assert.equal(r.fresh, false);
  assert.ok(r.sessions_behind >= 5, `behind=${r.sessions_behind}`);
});
t("D2 missing as-of date => STALE", () =>
  assert.equal(S.fiiFreshness(null, SESSIONS, ist("2026-08-11", 9, 15)).fresh, false));
t("D3 empty as-of string => STALE", () =>
  assert.equal(S.fiiFreshness("", SESSIONS, ist("2026-08-11", 9, 15)).fresh, false));
t("D4 no trading calendar => STALE (fail safe)", () => {
  assert.equal(S.fiiFreshness("2026-08-10", null, ist("2026-08-11", 9, 15)).fresh, false);
  assert.equal(S.fiiFreshness("2026-08-10", [], ist("2026-08-11", 9, 15)).fresh, false);
});
t("D5 stale FII is gated to null, not passed through", () => {
  const st = S.fiiFreshness("2026-07-31", SESSIONS, ist("2026-08-11", 9, 15));
  assert.equal(S.freshOrNull(true, st), null);
  const ok = S.fiiFreshness("2026-08-10", SESSIONS, ist("2026-08-11", 9, 15));
  assert.equal(S.freshOrNull(true, ok), true);
});
t("D6 stale FII cannot manufacture BULL", () => {
  const st = S.fiiFreshness("2026-07-31", SESSIONS, ist("2026-08-11", 9, 15));
  const r = S.detectRegime({ vix: 12, niftyAbove50dma: true,
    fiiNetBuyers5d: S.freshOrNull(true, st), fiiNetSellers3d: S.freshOrNull(false, st),
    midcapsOutperforming: true, breadthPct: 70, systemicStress: S.freshOrNull(false, st) });
  assert.notEqual(r.regime, "BULL");
});
t("D7 stale FII still reaches CRISIS at VIX>25", () => {
  const st = S.fiiFreshness("2026-07-31", SESSIONS, ist("2026-08-11", 9, 15));
  const r = S.detectRegime({ vix: 31, niftyAbove50dma: false,
    fiiNetBuyers5d: S.freshOrNull(false, st), fiiNetSellers3d: S.freshOrNull(true, st),
    midcapsOutperforming: false, breadthPct: 10, systemicStress: S.freshOrNull(false, st) });
  assert.equal(r.regime, "CRISIS");
  assert.equal(r.fail_safe, true);
});
t("D8 FRESH Friday FII on Monday DOES enable BULL", () => {
  const fr = S.fiiFreshness("2026-08-07", SESSIONS, ist("2026-08-10", 9, 15));
  const r = S.detectRegime({ vix: 12, niftyAbove50dma: true,
    fiiNetBuyers5d: S.freshOrNull(true, fr), fiiNetSellers3d: S.freshOrNull(false, fr),
    midcapsOutperforming: true, breadthPct: 70, systemicStress: S.freshOrNull(false, fr) });
  assert.equal(r.regime, "BULL");
});
t("D9 wall-clock age no longer used anywhere", () => {
  assert.equal(S.macroInputAge, undefined);
  assert.equal(S.MACRO_MAX_AGE_HOURS, undefined);
});

// ══ Synthetic guard: fundamentals data incomplete ════════════════
t("E1 incomplete fundamentals blocks pyramiding", () => {
  const r = S.pyramidBrake({ fundamentalsIncomplete: true, gainPct: 15, ltp: 106,
    dma20: 100, rsi: 60, mfi: 55, regime: "BULL" });
  assert.equal(r.pyramid_eligibility, "BLOCKED");
  assert.ok(r.pyramid_blocks.some(x => /FUNDAMENTALS_DATA_INCOMPLETE/.test(x)));
});
t("E2 complete fundamentals unaffected", () =>
  assert.equal(S.pyramidBrake({ fundamentalsIncomplete: false, gainPct: 15, ltp: 106,
    dma20: 100, rsi: 60, mfi: 55, regime: "BULL" }).pyramid_eligibility, "FULL_SIZE"));
t("E3 incomplete fundamentals NEVER produces an exit", () => {
  const r = S.pyramidBrake({ fundamentalsIncomplete: true, gainPct: 15, ltp: 106,
    dma20: 100, rsi: 60, mfi: 55, regime: "BULL" });
  assert.ok(!/EXIT|SELL/.test(JSON.stringify(r)));
  const rot = S.rotationReview({ isBottom20: false, rs20: 2, closesBelow20dma: 0,
    leaderScoreVal: 4, sessionsSinceNew20dHigh: 2, fundamentalDeterioration: null });
  assert.equal(rot.rotation_status, "HOLD");
});
t("E4 protection ladder unaffected by missing fundamentals", () => {
  const r = S.computeGttStage({ entryPrice: 200, highestClose: 205,
    prevStage: "ENTRY_RISK", prevStop: null, liveGttTrigger: 195 });
  assert.ok(r.min_stop >= 195, `min_stop ${r.min_stop} below broker trigger`);
  assert.equal(r.gtt_stage, "ENTRY_RISK");
});

console.log(`\nSESSION-FRESHNESS TESTS  pass=${p}  fail=${f}`);
if (f) { console.log(fails.map(x => "  FAIL " + x).join("\n")); process.exit(1); }
