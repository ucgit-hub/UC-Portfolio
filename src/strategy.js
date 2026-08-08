// UC_MOMENTUM v1.1 — deterministic strategy calculations.
// Pure functions only: no fetch, no D1, no Date.now(). Unit-testable.
// Worker + D1 is the production owner of every calculation in this file.

export function mean(a) { return a.reduce((s, v) => s + v, 0) / a.length; }
export function std(a) { const m = mean(a); return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / (a.length - 1)); }
export function round(v, d = 2) { return v != null && isFinite(v) ? +v.toFixed(d) : null; }

// ── §9 Data sufficiency ───────────────────────────────────────────────
// 252 trading candles required for a trustworthy 52W high + 200 DMA verdict.
export function dataSufficiency(n) {
  if (n >= 252) return "FULL";
  if (n >= 200) return "OK_200DMA_52W_PARTIAL";
  if (n >= 126) return "PARTIAL_NO_200DMA";
  return "INSUFFICIENT";
}
export function isActionable(flag) { return flag === "FULL"; }

// ── §3.1 Regime-based 52W proximity band ──────────────────────────────
export function band52w(regime) {
  switch ((regime || "").toUpperCase()) {
    case "BULL": return -10;
    case "NORMAL": return -15;
    case "CHOPPY": return -10;   // v1.1: selective entries permitted, tight band
    case "CRISIS": return null;  // no new entries
    default: return null;        // unknown regime → fail closed
  }
}

// ── §3.2 Tiered traded value. Unknown membership → stricter tier ──────
export function tradedValueThreshold(inNifty100) {
  return inNifty100 === true ? 50 : 75;
}

// ── Indicators ────────────────────────────────────────────────────────
export function sma(series, len) {
  return series.length >= len ? mean(series.slice(-len)) : null;
}

export function rsi14(closes) {
  const n = closes.length;
  if (n < 15) return null;
  const d = [];
  for (let i = n - 14; i < n; i++) d.push(closes[i] - closes[i - 1]);
  const g = d.filter(x => x > 0), l = d.filter(x => x < 0).map(x => -x);
  const ag = g.length ? mean(g) : 0, al = l.length ? mean(l) : 0;
  return al === 0 ? 100 : round(100 - 100 / (1 + ag / al));
}

// §8.2 extension brake input. Money Flow Index, 14 period.
export function mfi14(highs, lows, closes, volumes) {
  const n = closes.length;
  if (n < 15) return null;
  let pos = 0, neg = 0;
  for (let i = n - 14; i < n; i++) {
    const tp = (highs[i] + lows[i] + closes[i]) / 3;
    const tpPrev = (highs[i - 1] + lows[i - 1] + closes[i - 1]) / 3;
    const raw = tp * (volumes[i] || 0);
    if (tp > tpPrev) pos += raw; else if (tp < tpPrev) neg += raw;
  }
  if (neg === 0) return pos === 0 ? null : 100;
  return round(100 - 100 / (1 + pos / neg));
}

export function atr14(highs, lows, closes) {
  const n = closes.length;
  if (n < 15) return null;
  const t = [];
  for (let i = n - 14; i < n; i++) {
    t.push(Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i - 1]), Math.abs(lows[i] - closes[i - 1])));
  }
  return mean(t);
}

export function pctReturn(series, lookback) {
  const n = series.length;
  if (n <= lookback) return null;
  return (series[n - 1] / series[n - 1 - lookback] - 1) * 100;
}

// §16.1 signal 3 — relative strength vs Nifty 500 over N sessions.
export function relativeStrength(closes, benchCloses, lookback) {
  const s = pctReturn(closes, lookback);
  const b = pctReturn(benchCloses, lookback);
  if (s == null || b == null) return null;
  return round(s - b);
}

export function annualVol(closes) {
  const n = closes.length;
  const vl = Math.min(252, n - 1);
  if (vl < 20) return null;
  const lr = [];
  for (let i = n - vl; i < n; i++) lr.push(Math.log(closes[i] / closes[i - 1]));
  return std(lr) * Math.sqrt(252) * 100;
}

export function momentumScore(ret6m, vol1y) {
  if (ret6m == null || !vol1y || vol1y <= 0) return null;
  return round(ret6m / vol1y, 4);
}

export function higherHighsLows(highs, lows) {
  const n = highs.length;
  if (n < 30) return { higherHighs: null, higherLows: null };
  const h1 = Math.max(...highs.slice(-30, -20)), h2 = Math.max(...highs.slice(-20, -10)), h3 = Math.max(...highs.slice(-10));
  const l1 = Math.min(...lows.slice(-30, -20)), l2 = Math.min(...lows.slice(-20, -10)), l3 = Math.min(...lows.slice(-10));
  return { higherHighs: h3 > h2 && h2 > h1, higherLows: l3 > l2 && l2 > l1 };
}

export function tradedValueCr(closes, volumes) {
  const n = closes.length;
  if (n < 20) return null;
  const tv = [];
  for (let i = n - 20; i < n; i++) tv.push(closes[i] * (volumes[i] || 0));
  return round(mean(tv) / 1e7);
}

// ── §3 + §4.1 The 8 mandatory filters. Zero waivers. ──────────────────
// Financials NEVER get D/E waived: the CRAR/GNPA/NNPA substitute must be
// present and passing. Missing data fails closed.
export function evaluateFilters(inp) {
  const {
    mcap, roe, de, above200, dist52w, ret6m, tradedVal,
    inNifty500, inNifty100, regime, isFinancial,
    crar, gnpa, nnpa,
  } = inp;

  const band = band52w(regime);
  const bandLabel = band === null
    ? "52W band (BLOCKED — no entries this regime)"
    : `52W band (within ${Math.abs(band)}%)`;
  const volT = tradedValueThreshold(inNifty100);

  let creditLabel = "D/E <1";
  let creditPass = de != null && de < 1;
  if (isFinancial) {
    creditLabel = "Financial quality (CRAR>12, GNPA<3, NNPA<1.5)";
    creditPass = crar != null && gnpa != null && nnpa != null
      && crar > 12 && gnpa < 3 && nnpa < 1.5;
  }

  const checks = [
    ["Mcap 5K-2L Cr", mcap != null && mcap >= 5000 && mcap <= 200000],
    ["ROE >15%", roe != null && roe > 15],
    [creditLabel, creditPass],
    ["Above 200 DMA", above200 === true],
    [bandLabel, band !== null && dist52w != null && dist52w >= band],
    ["Positive 6M Return", ret6m != null && ret6m > 0],
    [`Traded Value >=Rs${volT}Cr`, tradedVal != null && tradedVal >= volT],
    ["Nifty 500", inNifty500 === true],
  ];

  const failed = checks.filter(([, v]) => !v).map(([k]) => k);
  const passed = checks.length - failed.length;
  return {
    filters_passed: passed,
    failed_filters: failed,
    verdict: failed.length === 0 ? "BUY_CANDIDATE" : "REJECT",
    vol_threshold_cr: volT,
    band_used_pct: band,
    credit_test: isFinancial ? "FINANCIAL_SUBSTITUTE" : "DE",
  };
}

// ── §5 Regime framework v1.1 ──────────────────────────────────────────
// Replaces VIX-only classification. Unknown inputs never upgrade the regime.
export function detectRegime(inp) {
  const {
    vix, niftyAbove50dma, niftyAbove200dma,
    fiiNetBuyers5d, fiiNetSellers3d,
    midcapsOutperforming, breadthPct, systemicStress,
  } = inp;

  const missing = [];
  if (vix == null) missing.push("vix");
  if (niftyAbove50dma == null) missing.push("nifty_50dma");
  if (fiiNetBuyers5d == null && fiiNetSellers3d == null) missing.push("fii_flow");
  if (midcapsOutperforming == null) missing.push("midcap_rs");
  if (breadthPct == null) missing.push("breadth");

  if (vix == null) {
    return { regime: "CHOPPY", rationale: "VIX unavailable — fail safe to CHOPPY", missing_inputs: missing };
  }

  // FAIL-SAFE: at VIX > 25 an ABSENT systemic-stress reading is treated as
  // stress PRESENT. Only an explicit `false` can downgrade CRISIS. Missing
  // macro data must never understate crisis risk.
  if (vix > 25 && systemicStress !== false) {
    return {
      regime: "CRISIS",
      rationale: systemicStress === true
        ? `VIX ${vix} >25 with confirmed systemic stress`
        : `VIX ${vix} >25 and systemic-stress input unavailable — fail-safe to CRISIS`,
      fail_safe: systemicStress !== true,
      missing_inputs: missing,
    };
  }

  if (niftyAbove50dma === true && fiiNetBuyers5d === true && vix < 15 && midcapsOutperforming === true) {
    return { regime: "BULL", rationale: `VIX ${vix} <15, Nifty>50DMA, FII net buyers 5d, midcaps outperforming`, missing_inputs: missing };
  }

  // FAIL-SAFE: an unknown FII reading counts toward CHOPPY, never toward calm.
  const fiiSellSignal = fiiNetSellers3d === true || (fiiNetSellers3d == null && fiiNetBuyers5d == null);
  const choppySignals = [vix > 18, fiiSellSignal, niftyAbove50dma === false].filter(Boolean).length;
  if (choppySignals >= 2) {
    return { regime: "CHOPPY", rationale: `${choppySignals}/3 choppy signals (VIX ${vix}, FII sellers ${fiiNetSellers3d}, Nifty<50DMA ${niftyAbove50dma === false})`, missing_inputs: missing };
  }

  if (vix >= 15 && vix <= 20 && niftyAbove50dma === true) {
    return { regime: "NORMAL", rationale: `VIX ${vix} in 15-20, Nifty>50DMA`, missing_inputs: missing };
  }

  return {
    regime: "NORMAL",
    rationale: `No decisive signal (VIX ${vix}, breadth ${breadthPct}) — default NORMAL${missing.length ? "; missing: " + missing.join(",") : ""}`,
    missing_inputs: missing,
  };
}

// ── §5.2 Regime liquidity guides. Ranges, never quotas. ───────────────
export const LIQUIDITY_TARGETS = {
  BULL: [10, 15], NORMAL: [15, 20], CHOPPY: [20, 30], CRISIS: [50, 70],
};
export function liquidityStatus(regime, actualPct) {
  const t = LIQUIDITY_TARGETS[(regime || "").toUpperCase()];
  if (!t || actualPct == null) return { target_low: null, target_high: null, status: "UNKNOWN" };
  const [lo, hi] = t;
  const status = actualPct < lo ? "BELOW_TARGET" : actualPct > hi ? "ABOVE_TARGET" : "IN_RANGE";
  return { target_low: lo, target_high: hi, status, note: "Guide only — never buy merely to reduce cash" };
}
export function entrySizingPct(regime) {
  const r = (regime || "").toUpperCase();
  if (r === "CRISIS") return { min: 0, max: 0, maxNewEntriesPerDay: 0 };
  if (r === "CHOPPY") return { min: 2.5, max: 3.5, maxNewEntriesPerDay: 1 };
  return { min: 5, max: 7, maxNewEntriesPerDay: null };
}

// ── §16.1 Leader score — 5 signals, 1 point each ──────────────────────
// Signal 5 (sector support) requires sector-index data. When unavailable it
// scores 0 and is reported as unavailable — it is never assumed true.
export function leaderScore(inp) {
  const { close, dma20, dma20Prev5, higherHighs, higherLows, rs20, rs60,
    portfolioRankPct, universeRankPct, sectorAbove20dmaRising, sectorOutperform20d } = inp;

  const trend = close != null && dma20 != null && dma20Prev5 != null && close > dma20 && dma20 > dma20Prev5;
  const structure = higherHighs === true && higherLows === true;
  const rs = rs20 != null && rs60 != null && rs20 > 0 && rs60 > 0;
  const ranking = (portfolioRankPct != null && portfolioRankPct <= 30) || (universeRankPct != null && universeRankPct <= 20);
  const sectorAvailable = sectorAbove20dmaRising != null && sectorOutperform20d != null;
  const sector = sectorAvailable && sectorAbove20dmaRising === true && sectorOutperform20d === true;

  const signals = { trend, structure, rs, ranking, sector };
  const score = Object.values(signals).filter(Boolean).length;
  return { leader_score: score, signals, sector_data_available: sectorAvailable };
}

// ── §16.2 Leader state ────────────────────────────────────────────────
export function classifyLeaderState(inp) {
  const { score, peakGainPct, prevState, prevStreak, portfolioRank,
    deteriorationCount, deteriorationStreak } = inp;

  const streak = score >= 4 ? (prevStreak || 0) + 1 : 0;

  if (deteriorationCount >= 2 && deteriorationStreak >= 2) {
    return { leader_state: "DETERIORATING", leader_streak: streak };
  }
  if (peakGainPct >= 20 && score >= 4 && portfolioRank != null && portfolioRank <= 3) {
    return { leader_state: "PROTECTED_ALPHA", leader_streak: streak };
  }
  if (peakGainPct >= 8 && score >= 4 && streak >= 3) {
    return { leader_state: "CONFIRMED_LEADER", leader_streak: streak };
  }
  if (peakGainPct >= 5 && score >= 4 && streak >= 2) {
    return { leader_state: "LEADER_CANDIDATE", leader_streak: streak };
  }
  return { leader_state: "UNPROVEN", leader_streak: streak };
}

// §16.2 deterioration conditions
export function leaderDeterioration(inp) {
  const { closesBelow20dma, score, rsPercentile, lowerHighLowerLow, sectorNegative } = inp;
  const conds = {
    two_closes_below_20dma: closesBelow20dma >= 2,
    score_le_2: score != null && score <= 2,
    rs_percentile_below_40: rsPercentile != null && rsPercentile < 40,
    lower_high_lower_low: lowerHighLowerLow === true,
    sector_negative: sectorNegative === true,
  };
  const count = Object.values(conds).filter(Boolean).length;
  return { deterioration_count: count, conditions: conds };
}

// ── §15.3 GTT stage ladder. Forward-only; stop never lowers. ──────────
// RUNNER is retained as a first-class stage: it denotes a position whose
// partial booking has ALREADY happened. Mapping it onto PARTIAL_BOOK_DUE would
// re-raise a booking instruction against an already-booked position.
export const STAGE_ORDER = ["ENTRY_RISK", "RISK_REDUCED", "CAPITAL_PROTECTED", "PROFIT_LOCKED", "PARTIAL_BOOK_DUE", "RUNNER", "PROTECTED_WINNER"];

// Stages at or beyond which booking is complete — never re-issue a book signal.
export const BOOKED_STAGES = new Set(["RUNNER", "PROTECTED_WINNER"]);

const LEGACY_STAGE_ALIAS = { PROTECTED_ALPHA: "PROTECTED_WINNER" };
export function normaliseStage(stage) {
  if (!stage) return "ENTRY_RISK";
  if (STAGE_ORDER.includes(stage)) return stage;
  return LEGACY_STAGE_ALIAS[stage] || "ENTRY_RISK";
}

export function computeGttStage(inp) {
  const { entryPrice, highestClose, prevStage, prevStop, leaderState, liveGttTrigger } = inp;
  if (!entryPrice || !highestClose) return null;
  const peakPct = (highestClose / entryPrice - 1) * 100;

  let stage, floor;
  if (peakPct >= 20) { stage = "PARTIAL_BOOK_DUE"; floor = Math.max(prevStop || 0, highestClose * 0.90); }
  else if (peakPct >= 12) { stage = "PROFIT_LOCKED"; floor = Math.max(entryPrice * 1.04, highestClose * 0.92); }
  else if (peakPct >= 8) { stage = "CAPITAL_PROTECTED"; floor = entryPrice * 1.005; }
  else if (peakPct >= 5) { stage = "RISK_REDUCED"; floor = entryPrice * 0.97; }
  else { stage = "ENTRY_RISK"; floor = entryPrice * 0.92; }

  if (leaderState === "PROTECTED_ALPHA" && peakPct >= 20) stage = "PROTECTED_WINNER";

  // Forward-only: never regress stage, never lower the stop.
  const prevNorm = normaliseStage(prevStage);
  const prevIdx = STAGE_ORDER.indexOf(prevNorm);
  const newIdx = STAGE_ORDER.indexOf(stage);
  let finalStage = newIdx >= prevIdx ? stage : prevNorm;

  // A position already booked stays booked. PARTIAL_BOOK_DUE can never be
  // re-entered from RUNNER/PROTECTED_WINNER, so no duplicate booking signal.
  const alreadyBooked = BOOKED_STAGES.has(prevNorm);
  if (alreadyBooked) finalStage = prevNorm;

  // The stop is a high-water mark across three sources and never falls below
  // any of them: the ladder floor, the last strategy stop, and the LIVE broker
  // trigger. Migration therefore cannot lower or loosen existing protection.
  const minStop = Math.max(floor, prevStop || 0, liveGttTrigger || 0, entryPrice * 0.92);

  return {
    gtt_stage: finalStage,
    peak_gain_pct: round(peakPct),
    min_stop: round(minStop),
    stage_advanced: newIdx > prevIdx && !alreadyBooked,
    partial_book_due: finalStage === "PARTIAL_BOOK_DUE" && !alreadyBooked,
    already_booked: alreadyBooked,
    stop_raised_above_live: liveGttTrigger != null && minStop > liveGttTrigger,
    limit_price: round(minStop * 0.995),
  };
}

// §15.6 quantity coverage — Kite remains authoritative for actual GTT state.
export function gttCoverage(inp) {
  const { quantity, gttQty, gttId, gttTrigger, minStop } = inp;
  const covered = gttQty != null && quantity != null && gttQty >= quantity;
  const alerts = [];
  if (!gttId) alerts.push("NO_GTT");
  else if (!covered) alerts.push(`QTY_UNCOVERED (${gttQty || 0}/${quantity})`);
  if (gttId && gttTrigger != null && minStop != null && gttTrigger < minStop - 0.005 * minStop) {
    alerts.push(`STOP_BELOW_LADDER (${round(gttTrigger)} < ${round(minStop)})`);
  }
  return { gtt_covered: covered && !!gttId, coverage_alerts: alerts };
}

// ── §15.5 Profit-giveback review ──────────────────────────────────────
export function givebackAlert(inp) {
  const { entryPrice, highestClose, ltp, below20dma } = inp;
  if (!entryPrice || !highestClose || !ltp) return { giveback_alert: null };
  const peakPct = (highestClose / entryPrice - 1) * 100;
  const nowPct = (ltp / entryPrice - 1) * 100;
  if (peakPct < 8) return { giveback_alert: null, peak_gain_pct: round(peakPct), current_gain_pct: round(nowPct) };

  const reasons = [];
  if (peakPct >= 20 && nowPct < 10) reasons.push("peak>=20% now<10%");
  else if (peakPct >= 12 && nowPct < 4) reasons.push("peak>=12% now<4%");
  else if (peakPct >= 8 && nowPct < peakPct * 0.5) reasons.push("peak>=8% and >50% of gain surrendered");
  if (below20dma === true) reasons.push("close below 20 DMA");

  return {
    giveback_alert: reasons.length ? "REVIEW" : null,
    giveback_reasons: reasons,
    peak_gain_pct: round(peakPct),
    current_gain_pct: round(nowPct),
  };
}

// ── §8.2 Pyramid extension brake ──────────────────────────────────────
export function pyramidBrake(inp) {
  const { gainPct, ltp, dma20, rsi, mfi, vixChange, regime, hasBinaryEvent,
    fundamentalsIncomplete } = inp;
  const blocks = [];
  // A holding that cannot be filter-revalidated may be held and protected,
  // but never scaled into. This never triggers an exit.
  if (fundamentalsIncomplete === true) blocks.push("FUNDAMENTALS_DATA_INCOMPLETE — revalidate before scaling");
  if (gainPct == null || gainPct < 10) blocks.push("gain <+10%");
  const above20 = dma20 ? (ltp / dma20 - 1) * 100 : null;
  if (above20 != null && above20 > 15) blocks.push(`>15% above 20DMA (${round(above20)}%)`);
  if (rsi != null && mfi != null && rsi > 70 && mfi > 70) blocks.push(`RSI ${rsi} & MFI ${mfi} both >70`);
  if (vixChange != null && vixChange > 2) blocks.push(`VIX +${round(vixChange)} in a day`);
  const r = (regime || "").toUpperCase();
  if (r === "CHOPPY" || r === "CRISIS") blocks.push(`regime ${r}`);
  if (hasBinaryEvent === true) blocks.push("binary event within 2 days");

  let eligibility = "BLOCKED";
  if (blocks.length === 0) eligibility = above20 != null && above20 >= 10 ? "HALF_SIZE_ONLY" : "FULL_SIZE";
  return { pyramid_eligibility: eligibility, pyramid_blocks: blocks, pct_above_20dma: round(above20) };
}

// ── §13.1 Rotation. Ranking alone NEVER triggers a trade. ─────────────
export function rotationReview(inp) {
  const { isBottom20, rs20, closesBelow20dma, leaderScoreVal, sessionsSinceNew20dHigh, fundamentalDeterioration } = inp;
  const conds = {
    bottom_20pct_rank: isBottom20 === true,
    negative_relative_strength: rs20 != null && rs20 < 0,
    two_closes_below_20dma: closesBelow20dma >= 2,
    leader_score_le_2: leaderScoreVal != null && leaderScoreVal <= 2,
    no_new_20d_high_20plus: sessionsSinceNew20dHigh != null && sessionsSinceNew20dHigh >= 20,
    fundamental_deterioration: fundamentalDeterioration === true,
  };
  const count = Object.values(conds).filter(Boolean).length;
  return {
    deterioration_signals: count,
    deterioration_conditions: conds,
    // Gate A only. Gate B (materially superior replacement) plus the 1/week
    // stabilisation cap are session decisions requiring explicit approval.
    rotation_status: count >= 2 ? "ROTATION_REVIEW_ELIGIBLE" : "HOLD",
    note: "Review only. Requires a materially superior replacement and explicit approval.",
  };
}

// ── §13.2 Time progress. Diagnostic only — never forces an exit. ──────
export function timeProgress(inp) {
  const { daysHeld, gainPct, leaderScoreVal, portfolioRankPct, newHigh20d } = inp;
  if (daysHeld == null) return { time_check: null };
  if (daysHeld >= 30 && gainPct < 5 && leaderScoreVal != null && leaderScoreVal <= 2 && newHigh20d === false)
    return { time_check: "ROTATION_REVIEW", day: 30 };
  if (daysHeld >= 20 && gainPct < 3 && newHigh20d === false && portfolioRankPct != null && portfolioRankPct > 60)
    return { time_check: "DETERIORATION_REVIEW", day: 20 };
  if (daysHeld >= 10 && gainPct <= 0 && leaderScoreVal != null && leaderScoreVal < 3 && portfolioRankPct != null && portfolioRankPct > 50)
    return { time_check: "REVIEW", day: 10 };
  return { time_check: null };
}

// ── Universe-wide momentum ranking ────────────────────────────────────
export function rankUniverse(rows) {
  const scored = rows.filter(r => r.momentum_score != null)
    .sort((a, b) => b.momentum_score - a.momentum_score);
  const n = scored.length;
  return scored.map((r, i) => ({
    ...r,
    universe_rank: i + 1,
    universe_rank_pct: n > 0 ? round(((i + 1) / n) * 100, 1) : null,
  }));
}

// ── §7 Capital accounting. Bank settlement cash is strategy capital. ──
export function capitalAccounting(inp) {
  const { equityValue, liquidbeesValue, cashKite, cashBank } = inp;
  const eq = equityValue || 0, lb = liquidbeesValue || 0, ck = cashKite || 0, cb = cashBank || 0;
  const netWorth = eq + lb + ck + cb;
  const totalLiquidity = ck + cb + lb;
  return {
    equity_value: round(eq, 0),
    liquidbees_value: round(lb, 0),
    cash_kite: round(ck, 0),
    cash_bank: round(cb, 0),
    net_worth: round(netWorth, 0),
    total_liquidity: round(totalLiquidity, 0),
    liquidity_pct: netWorth > 0 ? round((totalLiquidity / netWorth) * 100, 1) : null,
    deployed_pct: netWorth > 0 ? round((eq / netWorth) * 100, 1) : null,
  };
}

// ── §15.12 Highest adjusted daily CLOSING price. Monotonic. ───────────
export function updateHighestClose(inp) {
  const { storedHighestClose, adjCloses, dates, entryDate } = inp;
  let maxClose = storedHighestClose || 0;
  let maxDate = null;
  for (let i = 0; i < adjCloses.length; i++) {
    if (entryDate && dates[i] < entryDate) continue;
    if (adjCloses[i] != null && adjCloses[i] > maxClose) { maxClose = adjCloses[i]; maxDate = dates[i]; }
  }
  return {
    highest_close: round(maxClose),
    highest_close_date: maxDate,
    advanced: maxDate != null,
  };
}

export function closesBelow20dmaCount(closes, lookback = 5) {
  const n = closes.length;
  if (n < 25) return null;
  let consecutive = 0;
  for (let i = n - 1; i >= n - lookback; i--) {
    const d20 = mean(closes.slice(i - 19, i + 1));
    if (closes[i] < d20) consecutive++; else break;
  }
  return consecutive;
}

export function sessionsSinceNew20dHigh(closes) {
  const n = closes.length;
  if (n < 21) return null;
  for (let back = 0; back < n - 20; back++) {
    const idx = n - 1 - back;
    const window = closes.slice(idx - 19, idx + 1);
    if (closes[idx] >= Math.max(...window)) return back;
  }
  return n - 20;
}


// ── Sec 14.1 Daily discretionary action limit ─────────────────────────
// Mandatory risk exits (corporate triggers, gap-downs, stop exits) do NOT count.
export const MANDATORY_ACTIONS = new Set([
  "CORPORATE_EXIT", "GAP_DOWN_EXIT", "STOP_EXIT", "GTT_TRIGGERED", "MANDATORY_EXIT",
]);
export const DISCRETIONARY_ACTIONS = new Set(["BUY", "SELL", "PYRAMID", "ROTATION"]);

export function isDiscretionary(kind) {
  return DISCRETIONARY_ACTIONS.has(kind) && !MANDATORY_ACTIONS.has(kind);
}

export function checkDailyActionLimit(todaysActions, proposedKind) {
  const used = (todaysActions || []).filter(a => isDiscretionary(a.kind)).length;
  if (!isDiscretionary(proposedKind)) {
    return { allowed: true, exempt: true, used, limit: 3, reason: "Mandatory risk action — exempt from the daily limit" };
  }
  return {
    allowed: used < 3, exempt: false, used, limit: 3,
    reason: used < 3 ? `Discretionary slot ${used + 1}/3` : "Daily discretionary limit of 3 reached — defer to next session",
  };
}

// ── Sec 13.1 Weekly discretionary rotation cap (v1.1 stabilisation) ───
export function checkWeeklyRotationLimit(rotationsThisWeek, isMandatory) {
  const used = (rotationsThisWeek || []).filter(r => !r.mandatory).length;
  if (isMandatory) return { allowed: true, exempt: true, used, limit: 1, reason: "Mandatory risk exit — exempt from the weekly rotation cap" };
  return {
    allowed: used < 1, exempt: false, used, limit: 1,
    reason: used < 1 ? "Weekly discretionary rotation available" : "1 discretionary rotation already taken this calendar week",
  };
}

// ── Sec 13.1 Full rotation gate: Gate A + Gate B + weekly cap ─────────
export function evaluateRotation(inp) {
  const { deteriorationSignals, replacement, rotationsThisWeek, existingMomentumScore } = inp;
  const gateA = (deteriorationSignals || 0) >= 2;

  const r = replacement || {};
  const gateBChecks = {
    passes_all_filters: r.verdict === "BUY_CANDIDATE",
    data_full: r.data_sufficiency === "FULL",
    materially_stronger: r.momentum_score != null && existingMomentumScore != null
      && r.momentum_score > existingMomentumScore,
    high_rs_rank: r.universe_rank_pct != null && r.universe_rank_pct <= 20,
    no_binary_event: r.binary_event_within_2d === false,
    sector_slot_available: r.sector_slot_available === true,
  };
  const gateB = Object.values(gateBChecks).every(Boolean);
  const cap = checkWeeklyRotationLimit(rotationsThisWeek, false);

  const blockers = [];
  if (!gateA) blockers.push(`Gate A: only ${deteriorationSignals || 0}/2 deterioration signals`);
  if (!gateB) blockers.push("Gate B: " + Object.entries(gateBChecks).filter(([, v]) => !v).map(([k]) => k).join(", "));
  if (!cap.allowed) blockers.push("Weekly cap: " + cap.reason);

  return {
    gate_a_deterioration: gateA,
    gate_b_replacement: gateB,
    gate_b_detail: gateBChecks,
    weekly_cap: cap,
    rotation_permitted: gateA && gateB && cap.allowed,
    blockers,
    requires_approval: true,
    note: "Rotation is never automatic. Requires Umang's explicit approval.",
  };
}


// ── Macro input freshness — TRADING-SESSION AWARE ─────────────────────
// Wall-clock age is the wrong test for exchange data: Friday's FII print is
// still the latest available number at Monday 09:15, and a Thursday holiday
// makes Wednesday's print current on Friday.
//
// The NSE trading calendar is derived from the Nifty index candle series
// itself, which only contains dates on which the exchange actually traded.
// No holiday list to maintain and no risk of it going stale.

export const IST_OFFSET_MIN = 330;
export const NSE_CLOSE_MIN = 15 * 60 + 30;   // 15:30 IST

export function istParts(nowMs) {
  const d = new Date(nowMs + IST_OFFSET_MIN * 60000);
  return { date: d.toISOString().slice(0, 10), minutes: d.getUTCHours() * 60 + d.getUTCMinutes() };
}

// Most recent COMPLETED NSE session, taken from actual index candle dates.
// Today's candle is excluded until the close, since it is still forming.
export function lastCompletedSession(sessionDates, nowMs) {
  if (!sessionDates || sessionDates.length === 0) return null;
  const { date: today, minutes } = istParts(nowMs);
  const sorted = [...sessionDates].sort();
  for (let i = sorted.length - 1; i >= 0; i--) {
    const d = sorted[i];
    if (d > today) continue;                       // future candle, ignore
    if (d === today && minutes < NSE_CLOSE_MIN) continue;  // still trading
    return d;
  }
  return null;
}

// FII (and macro flags posted alongside it) are fresh when their as-of date is
// the latest completed session or newer. Anything older is genuinely stale.
export function fiiFreshness(asOfDate, sessionDates, nowMs) {
  const lastSession = lastCompletedSession(sessionDates, nowMs);
  if (!lastSession) {
    return { fresh: false, reason: "trading calendar unavailable — fail safe", last_session: null, as_of: asOfDate || null };
  }
  if (!asOfDate) {
    return { fresh: false, reason: `no FII as-of date; latest session ${lastSession}`, last_session: lastSession, as_of: null };
  }
  const as_of = String(asOfDate).slice(0, 10);
  if (as_of >= lastSession) {
    return { fresh: true, reason: `FII as-of ${as_of} covers latest completed session ${lastSession}`, last_session: lastSession, as_of };
  }
  const missed = sessionDates.filter(d => d > as_of && d <= lastSession).length;
  return {
    fresh: false,
    reason: `FII as-of ${as_of} is ${missed} completed session(s) behind ${lastSession}`,
    last_session: lastSession, as_of, sessions_behind: missed,
  };
}

// Gate a posted macro value on session freshness. Stale => null (unknown),
// which the regime detector already treats conservatively.
export function freshOrNull(value, freshness) {
  if (freshness && freshness.fresh === true) return value;
  return null;
}

// ── Midcap relative strength, computed from index price data ──────────
// Positive 20-day return of the midcap index relative to Nifty 50.
export function midcapOutperformance(midcapCloses, niftyCloses, lookback = 20) {
  if (!midcapCloses || !niftyCloses) return { midcaps_outperforming: null, midcap_rs_20d: null };
  const rs = relativeStrength(midcapCloses, niftyCloses, lookback);
  if (rs == null) return { midcaps_outperforming: null, midcap_rs_20d: null };
  return { midcaps_outperforming: rs > 0, midcap_rs_20d: rs };
}
