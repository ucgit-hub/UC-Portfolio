import * as S from "../src/strategy.js";
import assert from "node:assert/strict";

let pass = 0, fail = 0; const failures = [];
function t(name, fn) {
  try { fn(); pass++; }
  catch (e) { fail++; failures.push(`${name}: ${e.message}`); }
}

// ── Fix 1: CHOPPY 52W band = 10%, CRISIS no-entry ─────────────────────
t("1a band BULL=-10", () => assert.equal(S.band52w("BULL"), -10));
t("1b band NORMAL=-15", () => assert.equal(S.band52w("NORMAL"), -15));
t("1c band CHOPPY=-10 (was null)", () => assert.equal(S.band52w("CHOPPY"), -10));
t("1d band CRISIS=null (no entry)", () => assert.equal(S.band52w("CRISIS"), null));
t("1e unknown regime fails closed", () => assert.equal(S.band52w("WAT"), null));
t("1f CHOPPY candidate at -8% now passes", () => {
  const r = S.evaluateFilters({ mcap: 50000, roe: 20, de: 0.3, above200: true, dist52w: -8,
    ret6m: 15, tradedVal: 120, inNifty500: true, inNifty100: false, regime: "CHOPPY", isFinancial: false });
  assert.equal(r.verdict, "BUY_CANDIDATE");
});
t("1g CHOPPY candidate at -12% rejected (tighter than NORMAL)", () => {
  const r = S.evaluateFilters({ mcap: 50000, roe: 20, de: 0.3, above200: true, dist52w: -12,
    ret6m: 15, tradedVal: 120, inNifty500: true, inNifty100: false, regime: "CHOPPY", isFinancial: false });
  assert.equal(r.verdict, "REJECT");
});
t("1h CRISIS blocks every candidate", () => {
  const r = S.evaluateFilters({ mcap: 50000, roe: 20, de: 0.3, above200: true, dist52w: -1,
    ret6m: 30, tradedVal: 500, inNifty500: true, inNifty100: false, regime: "CRISIS", isFinancial: false });
  assert.equal(r.verdict, "REJECT");
});

// ── Fix 2: regime framework replaces VIX-only ─────────────────────────
const BULL_IN = { vix: 12, niftyAbove50dma: true, fiiNetBuyers5d: true, fiiNetSellers3d: false,
  midcapsOutperforming: true, breadthPct: 70, systemicStress: false };
t("2a BULL reachable (was impossible)", () => assert.equal(S.detectRegime(BULL_IN).regime, "BULL"));
t("2b BULL denied when FII unknown", () =>
  assert.notEqual(S.detectRegime({ ...BULL_IN, fiiNetBuyers5d: null }).regime, "BULL"));
t("2c BULL denied when midcap RS unknown", () =>
  assert.notEqual(S.detectRegime({ ...BULL_IN, midcapsOutperforming: null }).regime, "BULL"));
t("2d BULL denied when Nifty below 50DMA", () =>
  assert.notEqual(S.detectRegime({ ...BULL_IN, niftyAbove50dma: false }).regime, "BULL"));
t("2e NORMAL at VIX 17 above 50DMA", () =>
  assert.equal(S.detectRegime({ ...BULL_IN, vix: 17, fiiNetBuyers5d: false }).regime, "NORMAL"));
t("2f CHOPPY on 2 of 3 signals", () =>
  assert.equal(S.detectRegime({ vix: 19, niftyAbove50dma: false, fiiNetBuyers5d: false,
    fiiNetSellers3d: false, midcapsOutperforming: false, breadthPct: 40 }).regime, "CHOPPY"));
t("2g VIX 19 alone (1 signal) is not CHOPPY", () =>
  assert.notEqual(S.detectRegime({ vix: 19, niftyAbove50dma: true, fiiNetSellers3d: false,
    fiiNetBuyers5d: false, midcapsOutperforming: false, breadthPct: 55 }).regime, "CHOPPY"));
t("2h CRISIS needs systemic stress, not crude/war hardcode", () => {
  assert.equal(S.detectRegime({ vix: 30, niftyAbove50dma: false, systemicStress: true,
    fiiNetSellers3d: true, fiiNetBuyers5d: false, midcapsOutperforming: false, breadthPct: 10 }).regime, "CRISIS");
  assert.equal(S.detectRegime({ vix: 30, niftyAbove50dma: false, systemicStress: false,
    fiiNetSellers3d: true, fiiNetBuyers5d: false, midcapsOutperforming: false, breadthPct: 10 }).regime, "CHOPPY");
});
t("2i missing VIX fails safe to CHOPPY", () =>
  assert.equal(S.detectRegime({ vix: null }).regime, "CHOPPY"));

// ── Fix 3: legacy gates gone (no gate fields produced anywhere) ───────
t("3a no freeze/gate keys emitted by regime detection", () => {
  const k = Object.keys(S.detectRegime(BULL_IN)).join(",");
  assert.ok(!/freeze|gate_brent|gate_vix|gate_nifty/.test(k));
});
t("3b regime never references Brent/Nifty absolute levels", () => {
  const a = S.detectRegime({ ...BULL_IN }).regime;
  const b = S.detectRegime({ ...BULL_IN, brent: 130, niftyLevel: 19000 }).regime;
  assert.equal(a, b);
});

// ── Fix 4 + 5: rotation is review-only, never a standalone exit ───────
t("4a bottom-20 rank alone does NOT trigger rotation", () => {
  const r = S.rotationReview({ isBottom20: true, rs20: 2, closesBelow20dma: 0,
    leaderScoreVal: 4, sessionsSinceNew20dHigh: 3, fundamentalDeterioration: false });
  assert.equal(r.rotation_status, "HOLD");
});
t("4b two deterioration signals => REVIEW, not SELL", () => {
  const r = S.rotationReview({ isBottom20: true, rs20: -4, closesBelow20dma: 0,
    leaderScoreVal: 4, sessionsSinceNew20dHigh: 3, fundamentalDeterioration: false });
  assert.equal(r.rotation_status, "ROTATION_REVIEW_ELIGIBLE");
  assert.ok(/Review only/.test(r.note));
});
t("5a rank never appears as an exit action", () => {
  const r = S.rotationReview({ isBottom20: true, rs20: -1, closesBelow20dma: 3,
    leaderScoreVal: 1, sessionsSinceNew20dHigh: 40, fundamentalDeterioration: true });
  assert.ok(!/EXIT|SELL/.test(JSON.stringify(r)));
});

// ── Fix 6: no CHOPPY automatic 100% exits ─────────────────────────────
t("6a no fast-rotation auto-exit function exists", () =>
  assert.equal(S.checkFastRotation, undefined));
t("6b +10% in CHOPPY produces no forced sell", () => {
  const g = S.givebackAlert({ entryPrice: 100, highestClose: 110, ltp: 110, below20dma: false });
  assert.equal(g.giveback_alert, null);
});

// ── Fix 7: no +15% graduation ─────────────────────────────────────────
t("7a checkGraduation removed", () => assert.equal(S.checkGraduation, undefined));
t("7b CONFIRMED_LEADER at +8% peak, score 4, 3 closes (no 15% gate)", () => {
  const r = S.classifyLeaderState({ score: 4, peakGainPct: 9, prevStreak: 2,
    portfolioRank: 5, deteriorationCount: 0, deteriorationStreak: 0 });
  assert.equal(r.leader_state, "CONFIRMED_LEADER");
});
t("7c not confirmed on streak 2", () => {
  const r = S.classifyLeaderState({ score: 4, peakGainPct: 9, prevStreak: 1,
    portfolioRank: 5, deteriorationCount: 0, deteriorationStreak: 0 });
  assert.equal(r.leader_state, "LEADER_CANDIDATE");
});
t("7d PROTECTED_ALPHA at +20% top-3", () => {
  const r = S.classifyLeaderState({ score: 5, peakGainPct: 25, prevStreak: 9,
    portfolioRank: 2, deteriorationCount: 0, deteriorationStreak: 0 });
  assert.equal(r.leader_state, "PROTECTED_ALPHA");
});

// ── Fix 8: financial D/E never waived without substitute ──────────────
const FIN = { mcap: 50000, roe: 20, de: 4.5, above200: true, dist52w: -5, ret6m: 20,
  tradedVal: 200, inNifty500: true, inNifty100: false, regime: "NORMAL", isFinancial: true };
t("8a financial with missing CRAR/NPA fails closed", () => {
  const r = S.evaluateFilters({ ...FIN });
  assert.equal(r.verdict, "REJECT");
  assert.ok(r.failed_filters.some(f => /Financial quality/.test(f)));
});
t("8b financial passing substitute tests passes", () => {
  const r = S.evaluateFilters({ ...FIN, crar: 16, gnpa: 2.1, nnpa: 0.6 });
  assert.equal(r.verdict, "BUY_CANDIDATE");
  assert.equal(r.credit_test, "FINANCIAL_SUBSTITUTE");
});
t("8c financial failing GNPA rejected despite high D/E waiver", () => {
  const r = S.evaluateFilters({ ...FIN, crar: 16, gnpa: 4.2, nnpa: 0.6 });
  assert.equal(r.verdict, "REJECT");
});
t("8d non-financial still uses D/E<1", () => {
  const r = S.evaluateFilters({ ...FIN, isFinancial: false });
  assert.ok(r.failed_filters.includes("D/E <1"));
});

// ── Fix 9: cash_bank included in liquidity ────────────────────────────
t("9a liquidity includes bank settlement cash", () => {
  const c = S.capitalAccounting({ equityValue: 400000, liquidbeesValue: 50000,
    cashKite: 200000, cashBank: 50000 });
  assert.equal(c.net_worth, 700000);
  assert.equal(c.total_liquidity, 300000);
  assert.equal(c.liquidity_pct, 42.9);
});
t("9b old formula (excluding bank) would understate by 50000", () => {
  const c = S.capitalAccounting({ equityValue: 400000, liquidbeesValue: 50000,
    cashKite: 200000, cashBank: 50000 });
  assert.equal(c.total_liquidity - (50000 + 200000), 50000);
});
t("9c liquidity target by regime", () => {
  assert.deepEqual(S.LIQUIDITY_TARGETS.CHOPPY, [20, 30]);
  assert.equal(S.liquidityStatus("BULL", 42.9).status, "ABOVE_TARGET");
  assert.equal(S.liquidityStatus("CHOPPY", 25).status, "IN_RANGE");
  assert.equal(S.liquidityStatus("NORMAL", 9).status, "BELOW_TARGET");
});

// ── Fix 10: highest_close auto-update, monotonic, adjusted closes ─────
t("10a advances to max adjusted close after entry", () => {
  const r = S.updateHighestClose({ storedHighestClose: 100,
    adjCloses: [95, 105, 112, 108], dates: ["2026-07-01", "2026-07-02", "2026-07-03", "2026-07-04"],
    entryDate: "2026-07-01" });
  assert.equal(r.highest_close, 112);
});
t("10b never regresses", () => {
  const r = S.updateHighestClose({ storedHighestClose: 150,
    adjCloses: [95, 105], dates: ["2026-07-01", "2026-07-02"], entryDate: "2026-07-01" });
  assert.equal(r.highest_close, 150);
  assert.equal(r.advanced, false);
});
t("10c ignores pre-entry closes", () => {
  const r = S.updateHighestClose({ storedHighestClose: 0,
    adjCloses: [500, 105], dates: ["2026-06-01", "2026-07-02"], entryDate: "2026-07-01" });
  assert.equal(r.highest_close, 105);
});

// ── Fix 11: Nifty100 membership, not mcap proxy ───────────────────────
t("11a member gets 50Cr tier", () => assert.equal(S.tradedValueThreshold(true), 50));
t("11b non-member gets 75Cr", () => assert.equal(S.tradedValueThreshold(false), 75));
t("11c unknown membership fails closed to 75Cr", () => {
  assert.equal(S.tradedValueThreshold(null), 75);
  assert.equal(S.tradedValueThreshold(undefined), 75);
});
t("11d 1.5L Cr mcap non-member no longer gets the loose tier", () => {
  const r = S.evaluateFilters({ mcap: 150000, roe: 20, de: 0.3, above200: true, dist52w: -5,
    ret6m: 10, tradedVal: 60, inNifty500: true, inNifty100: false, regime: "NORMAL", isFinancial: false });
  assert.equal(r.verdict, "REJECT");
  assert.equal(r.vol_threshold_cr, 75);
});

// ── Fix 12: data sufficiency ──────────────────────────────────────────
t("12a thresholds", () => {
  assert.equal(S.dataSufficiency(260), "FULL");
  assert.equal(S.dataSufficiency(252), "FULL");
  assert.equal(S.dataSufficiency(210), "OK_200DMA_52W_PARTIAL");
  assert.equal(S.dataSufficiency(130), "PARTIAL_NO_200DMA");
  assert.equal(S.dataSufficiency(80), "INSUFFICIENT");
});
t("12b only FULL is actionable", () => {
  assert.equal(S.isActionable("FULL"), true);
  assert.equal(S.isActionable("OK_200DMA_52W_PARTIAL"), false);
});

// ── New: MFI14 ────────────────────────────────────────────────────────
t("MFI rising series => 100", () => {
  const c = Array.from({ length: 30 }, (_, i) => 100 + i);
  assert.equal(S.mfi14(c.map(x => x + 1), c.map(x => x - 1), c, c.map(() => 1000)), 100);
});
t("MFI falling series => 0", () => {
  const c = Array.from({ length: 30 }, (_, i) => 200 - i);
  assert.equal(S.mfi14(c.map(x => x + 1), c.map(x => x - 1), c, c.map(() => 1000)), 0);
});
t("MFI insufficient data => null", () => assert.equal(S.mfi14([1], [1], [1], [1]), null));

// ── New: RS20 / RS60 vs Nifty 500 ─────────────────────────────────────
t("RS positive when stock outruns benchmark", () => {
  const stock = Array.from({ length: 70 }, (_, i) => 100 * 1.01 ** i);
  const bench = Array.from({ length: 70 }, (_, i) => 100 * 1.002 ** i);
  assert.ok(S.relativeStrength(stock, bench, 20) > 0);
  assert.ok(S.relativeStrength(stock, bench, 60) > 0);
});
t("RS negative when stock lags", () => {
  const stock = Array.from({ length: 70 }, (_, i) => 100 * 1.001 ** i);
  const bench = Array.from({ length: 70 }, (_, i) => 100 * 1.01 ** i);
  assert.ok(S.relativeStrength(stock, bench, 20) < 0);
});

// ── New: universe ranking ─────────────────────────────────────────────
t("universe rank ordering and percentile", () => {
  const r = S.rankUniverse([{ symbol: "A", momentum_score: 0.5 },
    { symbol: "B", momentum_score: 1.5 }, { symbol: "C", momentum_score: 1.0 },
    { symbol: "D", momentum_score: null }]);
  assert.deepEqual(r.map(x => x.symbol), ["B", "C", "A"]);
  assert.equal(r[0].universe_rank, 1);
  assert.equal(r[2].universe_rank_pct, 100);
});

// ── New: leader score ─────────────────────────────────────────────────
t("leader score 4/5 with sector data unavailable", () => {
  const r = S.leaderScore({ close: 110, dma20: 105, dma20Prev5: 100, higherHighs: true,
    higherLows: true, rs20: 3, rs60: 5, portfolioRankPct: 20, universeRankPct: 15,
    sectorAbove20dmaRising: null, sectorOutperform20d: null });
  assert.equal(r.leader_score, 4);
  assert.equal(r.sector_data_available, false);
});
t("leader sector signal never assumed true", () => {
  const r = S.leaderScore({ close: 110, dma20: 105, dma20Prev5: 100, higherHighs: true,
    higherLows: true, rs20: 3, rs60: 5, portfolioRankPct: 20, universeRankPct: 15 });
  assert.equal(r.signals.sector, false);
});
t("leader score 0 when trend broken and RS negative", () => {
  const r = S.leaderScore({ close: 90, dma20: 105, dma20Prev5: 110, higherHighs: false,
    higherLows: false, rs20: -3, rs60: -5, portfolioRankPct: 90, universeRankPct: 95 });
  assert.equal(r.leader_score, 0);
});

// ── New: GTT stage ladder ─────────────────────────────────────────────
t("stage ENTRY_RISK floor entry*0.92", () => {
  const r = S.computeGttStage({ entryPrice: 100, highestClose: 103, prevStage: null, prevStop: null });
  assert.equal(r.gtt_stage, "ENTRY_RISK"); assert.equal(r.min_stop, 92);
});
t("stage RISK_REDUCED at +5%", () => {
  const r = S.computeGttStage({ entryPrice: 100, highestClose: 106, prevStage: "ENTRY_RISK", prevStop: 92 });
  assert.equal(r.gtt_stage, "RISK_REDUCED"); assert.equal(r.min_stop, 97);
});
t("stage CAPITAL_PROTECTED at +8%", () => {
  const r = S.computeGttStage({ entryPrice: 100, highestClose: 109, prevStage: "RISK_REDUCED", prevStop: 97 });
  assert.equal(r.gtt_stage, "CAPITAL_PROTECTED"); assert.equal(r.min_stop, 100.5);
});
t("stage PROFIT_LOCKED uses max(entry*1.04, peak*0.92)", () => {
  const r = S.computeGttStage({ entryPrice: 100, highestClose: 118, prevStage: "CAPITAL_PROTECTED", prevStop: 100.5 });
  assert.equal(r.gtt_stage, "PROFIT_LOCKED"); assert.equal(r.min_stop, 108.56);
});
t("stage forward-only: price falls, stage and stop hold", () => {
  const r = S.computeGttStage({ entryPrice: 100, highestClose: 118, prevStage: "PROFIT_LOCKED", prevStop: 108.56 });
  const after = S.computeGttStage({ entryPrice: 100, highestClose: 118, prevStage: "PROFIT_LOCKED", prevStop: 108.56 });
  assert.equal(after.gtt_stage, "PROFIT_LOCKED");
  assert.ok(after.min_stop >= r.min_stop);
});
t("stop never falls below entry*0.92", () => {
  const r = S.computeGttStage({ entryPrice: 100, highestClose: 100, prevStage: "ENTRY_RISK", prevStop: 50 });
  assert.equal(r.min_stop, 92);
});
t("limit price = trigger * 0.995", () => {
  const r = S.computeGttStage({ entryPrice: 100, highestClose: 103, prevStage: null, prevStop: null });
  assert.equal(r.limit_price, 91.54);
});

// ── New: giveback alerts ──────────────────────────────────────────────
t("giveback silent below +8% peak", () =>
  assert.equal(S.givebackAlert({ entryPrice: 100, highestClose: 106, ltp: 101 }).giveback_alert, null));
t("giveback fires: peak +20% now below +10%", () =>
  assert.equal(S.givebackAlert({ entryPrice: 100, highestClose: 121, ltp: 108 }).giveback_alert, "REVIEW"));
t("giveback fires: peak +12% now below +4%", () =>
  assert.equal(S.givebackAlert({ entryPrice: 100, highestClose: 113, ltp: 103 }).giveback_alert, "REVIEW"));
t("giveback fires: >50% of an +8% gain surrendered", () =>
  assert.equal(S.givebackAlert({ entryPrice: 100, highestClose: 109, ltp: 104 }).giveback_alert, "REVIEW"));
t("giveback quiet when holding its gain", () =>
  assert.equal(S.givebackAlert({ entryPrice: 100, highestClose: 115, ltp: 114, below20dma: false }).giveback_alert, null));

// ── New: pyramid extension brake ──────────────────────────────────────
t("pyramid blocked below +10%", () =>
  assert.equal(S.pyramidBrake({ gainPct: 8, ltp: 108, dma20: 104, rsi: 60, mfi: 55, regime: "BULL" }).pyramid_eligibility, "BLOCKED"));
t("pyramid blocked >15% above 20DMA (was 20%)", () => {
  const r = S.pyramidBrake({ gainPct: 20, ltp: 120, dma20: 100, rsi: 60, mfi: 55, regime: "BULL" });
  assert.equal(r.pyramid_eligibility, "BLOCKED");
  assert.ok(r.pyramid_blocks.some(x => /15% above 20DMA/.test(x)));
});
t("overextension case: 12% above 20DMA with RSI+MFI>70 is blocked", () => {
  const r = S.pyramidBrake({ gainPct: 15, ltp: 112, dma20: 100, rsi: 74, mfi: 78, regime: "BULL" });
  assert.equal(r.pyramid_eligibility, "BLOCKED");
});
t("10-15% above 20DMA => HALF_SIZE_ONLY", () =>
  assert.equal(S.pyramidBrake({ gainPct: 15, ltp: 112, dma20: 100, rsi: 60, mfi: 55, regime: "BULL" }).pyramid_eligibility, "HALF_SIZE_ONLY"));
t("clean setup => FULL_SIZE", () =>
  assert.equal(S.pyramidBrake({ gainPct: 15, ltp: 106, dma20: 100, rsi: 60, mfi: 55, regime: "BULL" }).pyramid_eligibility, "FULL_SIZE"));
t("VIX spike >2 blocks", () =>
  assert.equal(S.pyramidBrake({ gainPct: 15, ltp: 106, dma20: 100, rsi: 60, mfi: 55, vixChange: 2.5, regime: "BULL" }).pyramid_eligibility, "BLOCKED"));
t("CHOPPY blocks routine pyramiding", () =>
  assert.equal(S.pyramidBrake({ gainPct: 15, ltp: 106, dma20: 100, rsi: 60, mfi: 55, regime: "CHOPPY" }).pyramid_eligibility, "BLOCKED"));

// ── New: time progress is review-only ─────────────────────────────────
t("day 30 => ROTATION_REVIEW not exit", () => {
  const r = S.timeProgress({ daysHeld: 31, gainPct: 2, leaderScoreVal: 1, portfolioRankPct: 80, newHigh20d: false });
  assert.equal(r.time_check, "ROTATION_REVIEW");
  assert.ok(!/EXIT|SELL/.test(JSON.stringify(r)));
});
t("day 40 healthy leader => no flag", () =>
  assert.equal(S.timeProgress({ daysHeld: 40, gainPct: 18, leaderScoreVal: 5, portfolioRankPct: 10, newHigh20d: true }).time_check, null));

// ── New: entry sizing by regime ───────────────────────────────────────
t("CHOPPY half-size, 1 entry/day", () => {
  const e = S.entrySizingPct("CHOPPY");
  assert.deepEqual([e.min, e.max, e.maxNewEntriesPerDay], [2.5, 3.5, 1]);
});
t("CRISIS zero new entries", () => assert.equal(S.entrySizingPct("CRISIS").max, 0));

// ── GTT coverage (quantity) ───────────────────────────────────────────
t("coverage flags partial quantity", () => {
  const r = S.gttCoverage({ quantity: 100, gttQty: 30, gttId: 55, gttTrigger: 90, minStop: 90 });
  assert.equal(r.gtt_covered, false);
  assert.ok(r.coverage_alerts.some(a => /QTY_UNCOVERED/.test(a)));
});
t("coverage flags missing GTT", () =>
  assert.ok(S.gttCoverage({ quantity: 100, gttQty: null, gttId: null }).coverage_alerts.includes("NO_GTT")));
t("coverage flags stop below ladder", () =>
  assert.ok(S.gttCoverage({ quantity: 100, gttQty: 100, gttId: 5, gttTrigger: 90, minStop: 100.5 })
    .coverage_alerts.some(a => /STOP_BELOW_LADDER/.test(a))));
t("fully covered position is clean", () =>
  assert.deepEqual(S.gttCoverage({ quantity: 100, gttQty: 100, gttId: 5, gttTrigger: 101, minStop: 100.5 }).coverage_alerts, []));

console.log(`\nUNIT TESTS  pass=${pass}  fail=${fail}`);
if (fail) { console.log(failures.map(f => "  FAIL " + f).join("\n")); process.exit(1); }

// ── Legacy stage handling: synthetic RUNNER case ──
{
let p2=0,f2=0;const fl=[];
const t2=(n,fn)=>{try{fn();p2++}catch(e){f2++;fl.push(n+": "+e.message)}};
t2("RUNNER preserved as a valid post-booking stage", () => assert.equal(S.normaliseStage("RUNNER"), "RUNNER"));
t2("unknown stage falls back to ENTRY_RISK", () => assert.equal(S.normaliseStage("WAT"), "ENTRY_RISK"));
t2("synthetic RUNNER row does not regress", () => {
  const r = S.computeGttStage({ entryPrice: 100, highestClose: 130, prevStage: "RUNNER", prevStop: 95 });
  assert.equal(r.gtt_stage, "RUNNER");
  assert.equal(r.stage_advanced, false);
  assert.equal(r.partial_book_due, false);
  assert.ok(r.min_stop >= 95);
});
t2("RUNNER with small peak still cannot regress to ENTRY_RISK", () => {
  const r = S.computeGttStage({ entryPrice: 100, highestClose: 101, prevStage: "RUNNER", prevStop: 95 });
  assert.equal(r.gtt_stage, "RUNNER");
  assert.equal(r.min_stop, 95);
});
console.log(`LEGACY STAGE TESTS  pass=${p2}  fail=${f2}`);
if(f2){console.log(fl.map(x=>"  FAIL "+x).join("\n"));process.exit(1)}
}
