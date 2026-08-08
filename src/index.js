// UC_MOMENTUM v1.1 — uc-portfolio Worker
// Worker + D1 is the production source of truth for candle-derived calculations.
// Kite/broker remains authoritative for holdings, quantities, orders, trades and
// GTT execution status. This Worker never asserts broker state.

import DASHBOARD_HTML from "./dashboard.html";
import * as S from "./strategy.js";

const { round, mean } = S;
const BENCH_TICKER = "^CRSLDX";   // Nifty 500
const NIFTY_TICKER = "^NSEI";
const VIX_TICKER = "^INDIAVIX";
// Midcap index candidates, tried in order. If none resolve, midcap RS stays
// null and BULL becomes unreachable — the safe direction.
const MIDCAP_TICKERS = ["^NSEMDCP50", "NIFTY_MIDCAP_100.NS", "^CNXMID"];

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type" } });
    }
    if (path === "/" || path === "/dashboard") return new Response(DASHBOARD_HTML, { headers: { "Content-Type": "text/html;charset=utf-8" } });
    if (path === "/api/dashboard-data" || path === "/api/portfolio") return handleDashboardData(env);
    if (path === "/api/holdings") return json((await env.DB.prepare("SELECT * FROM holdings ORDER BY momentum_score DESC").all()).results);
    if (path === "/api/trades") return json((await env.DB.prepare("SELECT * FROM trades ORDER BY id DESC LIMIT 100").all()).results);
    if (path === "/api/alerts") return json((await env.DB.prepare("SELECT * FROM alerts WHERE resolved=0 ORDER BY severity DESC").all()).results);
    if (path === "/api/opportunities") return json((await env.DB.prepare("SELECT * FROM opportunities ORDER BY momentum_score DESC LIMIT 30").all()).results);
    if (path === "/api/watchlist") return json((await env.DB.prepare("SELECT * FROM watchlist ORDER BY momentum_score DESC").all()).results);
    if (path === "/api/nav") return json((await env.DB.prepare("SELECT * FROM daily_nav ORDER BY date ASC").all()).results);
    if (path === "/api/macro") return json(await env.DB.prepare("SELECT * FROM macro_state WHERE id=1").first());
    if (path === "/api/ranking") return handleRanking(env);
    if (path === "/api/scan-status") return handleScanStatus(env);
    if (path === "/api/scan" && request.method === "POST") return handleScan(request, env);
    if (path === "/api/refresh") return json(await dailyCron(env, { dryRun: url.searchParams.get("dry") === "1" }));
    if (path === "/api/kite-sync" && request.method === "POST") return handleKiteSync(request, env);
    return new Response("Not found", { status: 404 });
  },
  async scheduled(event, env) { await dailyCron(env, { dryRun: false }); },
};

// ── Yahoo data access ─────────────────────────────────────────────────
// v1.1 #13: no silent NSE→BSE fallback. Exchange is explicit; failures surface.
function yahooTicker(symbol, exchange) {
  if (symbol.startsWith("^")) return symbol;          // index symbols carry no suffix
  return symbol + ((exchange || "NSE").toUpperCase() === "BSE" ? ".BO" : ".NS");
}

async function fetchYahooCandles(sym, days) {
  const now = Math.floor(Date.now() / 1e3), from = now - days * 86400;
  const r = await fetch(
    `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?period1=${from}&period2=${now}&interval=1d&events=div%2Csplits`,
    { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!r.ok) throw new Error(`yahoo_http_${r.status}`);
  const d = await r.json();
  const res = d?.chart?.result?.[0];
  if (!res?.timestamp) throw new Error("yahoo_no_timestamps");
  const ts = res.timestamp, q = res.indicators.quote[0];
  const adj = res.indicators.adjclose?.[0]?.adjclose;
  return ts.map((t, i) => ({
    date: new Date(t * 1e3).toISOString().split("T")[0],
    open: q.open[i], high: q.high[i], low: q.low[i],
    close: q.close[i],
    adjclose: adj?.[i] != null ? adj[i] : q.close[i],
    volume: q.volume[i],
  })).filter(c => c.close != null);
}

// Calendar-day windows under-deliver trading candles. 400 calendar days
// yields ~270 sessions so a FULL 252-session verdict is attainable.
const CANDLE_WINDOW_DAYS = 400;

async function loadCandles(symbol, exchange, env, errors) {
  try {
    const c = await fetchYahooCandles(yahooTicker(symbol, exchange), CANDLE_WINDOW_DAYS);
    if (!c || c.length === 0) throw new Error("empty_series");
    return c;
  } catch (e) {
    errors.push({ symbol, exchange: exchange || "NSE", error: String(e.message || e) });
    return null;
  }
}

function series(candles) {
  return {
    closes: candles.map(c => c.adjclose),
    rawCloses: candles.map(c => c.close),
    highs: candles.map(c => c.high),
    lows: candles.map(c => c.low),
    volumes: candles.map(c => c.volume),
    dates: candles.map(c => c.date),
  };
}

// ── Indicator bundle for one instrument ───────────────────────────────
function computeIndicators(candles, benchCloses) {
  const { closes, highs, lows, volumes } = series(candles);
  const n = closes.length;
  const current = closes[n - 1];
  const dma200 = S.sma(closes, 200);
  const dma20 = S.sma(closes, 20);
  const dma20Prev5 = n >= 25 ? mean(closes.slice(-25, -5)) : null;
  const lookback = Math.min(252, n);
  const high52w = Math.max(...highs.slice(-lookback));
  const low52w = Math.min(...lows.slice(-lookback));
  const ret6m = S.pctReturn(closes, 126);
  const vol1y = S.annualVol(closes);
  const atr = S.atr14(highs, lows, closes);
  const hh = S.higherHighsLows(highs, lows);

  return {
    ltp: round(current),
    candles_n: n,
    data_sufficiency: S.dataSufficiency(n),
    dma_200: round(dma200), dma_20: round(dma20), dma_20_prev5: round(dma20Prev5),
    high_52w: round(high52w), low_52w: round(low52w),
    dist_52w_pct: round((current / high52w - 1) * 100),
    return_6m_pct: round(ret6m),
    vol_1y_pct: round(vol1y),
    momentum_score: S.momentumScore(ret6m, vol1y),
    rsi_14: S.rsi14(closes),
    mfi_14: S.mfi14(highs, lows, closes, volumes),
    atr_14: round(atr),
    atr_pct: round(atr ? (atr / current) * 100 : null),
    traded_val_cr: S.tradedValueCr(closes, volumes),
    rs_20d: benchCloses ? S.relativeStrength(closes, benchCloses, 20) : null,
    rs_60d: benchCloses ? S.relativeStrength(closes, benchCloses, 60) : null,
    above_200_dma: dma200 ? current > dma200 : null,
    above_20_dma: dma20 ? current > dma20 : null,
    higher_highs: hh.higherHighs,
    higher_lows: hh.higherLows,
    closes_below_20dma: S.closesBelow20dmaCount(closes),
    sessions_since_20d_high: S.sessionsSinceNew20dHigh(closes),
  };
}

const INDICATOR_UPSERT = `INSERT INTO indicators
 (symbol,ltp,dma_200,dma_20,high_52w,low_52w,dist_52w_pct,return_6m_pct,vol_1y_pct,
  momentum_score,rsi_14,mfi_14,atr_14,atr_pct,traded_val_cr,rs_20d,rs_60d,
  above_200_dma,above_20_dma,higher_highs,higher_lows,candles_n,data_sufficiency,
  universe_rank,universe_rank_pct,updated_at)
 VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'))
 ON CONFLICT(symbol) DO UPDATE SET
  ltp=excluded.ltp,dma_200=excluded.dma_200,dma_20=excluded.dma_20,
  high_52w=excluded.high_52w,low_52w=excluded.low_52w,dist_52w_pct=excluded.dist_52w_pct,
  return_6m_pct=excluded.return_6m_pct,vol_1y_pct=excluded.vol_1y_pct,
  momentum_score=excluded.momentum_score,rsi_14=excluded.rsi_14,mfi_14=excluded.mfi_14,
  atr_14=excluded.atr_14,atr_pct=excluded.atr_pct,traded_val_cr=excluded.traded_val_cr,
  rs_20d=excluded.rs_20d,rs_60d=excluded.rs_60d,above_200_dma=excluded.above_200_dma,
  above_20_dma=excluded.above_20_dma,higher_highs=excluded.higher_highs,
  higher_lows=excluded.higher_lows,candles_n=excluded.candles_n,
  data_sufficiency=excluded.data_sufficiency,updated_at=excluded.updated_at`;

function indicatorBind(symbol, r) {
  return [symbol, r.ltp, r.dma_200, r.dma_20, r.high_52w, r.low_52w, r.dist_52w_pct,
    r.return_6m_pct, r.vol_1y_pct, r.momentum_score, r.rsi_14, r.mfi_14, r.atr_14,
    r.atr_pct, r.traded_val_cr, r.rs_20d, r.rs_60d,
    b(r.above_200_dma), b(r.above_20_dma), b(r.higher_highs), b(r.higher_lows),
    r.candles_n, r.data_sufficiency, null, null];
}
function b(v) { return v == null ? null : (v ? 1 : 0); }

// ══════════════════════════════════════════════════════════════════════
// DAILY CRON
// ══════════════════════════════════════════════════════════════════════
async function dailyCron(env, opts = {}) {
  const dryRun = opts.dryRun === true;
  const log = { version: "v1.1", dryRun, started: new Date().toISOString(), parts: {}, dataErrors: [] };
  const errors = log.dataErrors;
  const DB = dryRun ? wrapReadOnly(env.DB, log) : env.DB;

  // ── 1. Market context ───────────────────────────────────────────────
  const [niftyC, benchC, vixC] = await Promise.all([
    loadCandles(NIFTY_TICKER, "IDX", env, errors),
    loadCandles(BENCH_TICKER, "IDX", env, errors),
    loadCandles(VIX_TICKER, "IDX", env, errors),
  ]);
  let midcapC = null, midcapTicker = null;
  for (const mt of MIDCAP_TICKERS) {
    midcapC = await loadCandles(mt, "IDX", env, []);
    if (midcapC && midcapC.length >= 25) { midcapTicker = mt; break; }
    midcapC = null;
  }
  if (!midcapTicker) errors.push({ symbol: "MIDCAP_INDEX", error: "no_midcap_index_resolved" });
  const niftyCloses = niftyC ? series(niftyC).closes : null;
  const benchCloses = benchC ? series(benchC).closes : null;
  const niftyClose = niftyCloses ? niftyCloses[niftyCloses.length - 1] : null;
  const nifty50dma = niftyCloses ? S.sma(niftyCloses, 50) : null;
  const nifty200dma = niftyCloses ? S.sma(niftyCloses, 200) : null;
  const vixVal = vixC ? series(vixC).closes.slice(-1)[0] : null;
  const vixPrev = vixC && vixC.length > 1 ? series(vixC).closes.slice(-2)[0] : null;
  const vixChange = vixVal != null && vixPrev != null ? vixVal - vixPrev : null;
  const bench500Close = benchCloses ? benchCloses[benchCloses.length - 1] : null;

  // ── 2. Regime (v1.1 §5) — externally-supplied inputs read from macro_state
  const prevMacro = await DB.prepare("SELECT * FROM macro_state WHERE id=1").first();
  const breadthRow = await DB.prepare(
    "SELECT AVG(above_200_dma)*100 AS pct, COUNT(*) AS n FROM indicators WHERE above_200_dma IS NOT NULL AND updated_at >= datetime('now','-3 days')"
  ).first();
  const breadthPct = breadthRow && breadthRow.n >= 20 ? round(breadthRow.pct, 1) : null;

  const mid = S.midcapOutperformance(midcapC ? series(midcapC).closes : null, niftyCloses);
  // Trading-session-aware freshness. The NSE calendar is the Nifty candle series,
  // so weekends and exchange holidays never mark valid latest-session data stale.
  const sessionDates = niftyC ? series(niftyC).dates : null;
  const fiiFresh = S.fiiFreshness(prevMacro?.fii_as_of_date, sessionDates, Date.now());
  const fresh = v => S.freshOrNull(intBool(v), fiiFresh);

  const reg = S.detectRegime({
    vix: vixVal,
    niftyAbove50dma: nifty50dma != null && niftyClose != null ? niftyClose > nifty50dma : null,
    niftyAbove200dma: nifty200dma != null && niftyClose != null ? niftyClose > nifty200dma : null,
    fiiNetBuyers5d: fresh(prevMacro?.fii_net_buyers_5d),
    fiiNetSellers3d: fresh(prevMacro?.fii_net_sellers_3d),
    midcapsOutperforming: mid.midcaps_outperforming,   // computed, not posted
    breadthPct,
    systemicStress: fresh(prevMacro?.systemic_stress),
  });
  const regime = reg.regime;

  await DB.prepare(
    `INSERT INTO macro_state (id,brent_price,vix,vix_change,nifty_close,nifty_50dma,nifty_200dma,
       nifty500_close,breadth_pct,midcap_rs_20d,midcaps_outperforming,
       regime,regime_rationale,regime_missing_inputs,regime_fail_safe,
       fii_fresh,last_session_date,updated_at)
     VALUES (1,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'))
     ON CONFLICT(id) DO UPDATE SET vix=excluded.vix,vix_change=excluded.vix_change,
       nifty_close=excluded.nifty_close,nifty_50dma=excluded.nifty_50dma,
       nifty_200dma=excluded.nifty_200dma,nifty500_close=excluded.nifty500_close,
       breadth_pct=excluded.breadth_pct,midcap_rs_20d=excluded.midcap_rs_20d,
       midcaps_outperforming=excluded.midcaps_outperforming,regime=excluded.regime,
       regime_rationale=excluded.regime_rationale,
       regime_missing_inputs=excluded.regime_missing_inputs,
       regime_fail_safe=excluded.regime_fail_safe,fii_fresh=excluded.fii_fresh,
       last_session_date=excluded.last_session_date,updated_at=excluded.updated_at`
  ).bind(prevMacro?.brent_price ?? null, vixVal, round(vixChange), niftyClose, round(nifty50dma),
    round(nifty200dma), bench500Close, breadthPct, mid.midcap_rs_20d,
    mid.midcaps_outperforming == null ? null : (mid.midcaps_outperforming ? 1 : 0),
    regime, reg.rationale, JSON.stringify(reg.missing_inputs),
    reg.fail_safe ? 1 : 0, fiiFresh.fresh ? 1 : 0, fiiFresh.last_session).run();

  log.parts.macro = { vix: vixVal, vixChange: round(vixChange), niftyClose,
    nifty50dma: round(nifty50dma), breadthPct, midcapTicker, midcapRs20: mid.midcap_rs_20d,
    midcapsOutperforming: mid.midcaps_outperforming, fiiFreshness: fiiFresh,
    regime, rationale: reg.rationale, failSafe: !!reg.fail_safe, missing: reg.missing_inputs };

  // ── 3. Holdings pass ────────────────────────────────────────────────
  const holdings = (await DB.prepare("SELECT * FROM holdings").all()).results;
  // Holdings with no sanctioned fundamentals row cannot be filter-revalidated.
  // They keep full protection and are NEVER exited for this reason alone, but
  // they are barred from pyramiding until a fresh Screener export revalidates them.
  const fundSymbols = new Set(((await DB.prepare(
    "SELECT symbol FROM fundamentals_cache").all()).results || []).map(r => r.symbol));
  const holdingSymbols = new Set(holdings.map(h => h.symbol));
  const perHolding = [];

  for (const h of holdings) {
    const candles = await loadCandles(h.symbol, h.exchange, env, errors);
    if (!candles || candles.length < 30) {
      perHolding.push({ symbol: h.symbol, error: "no_data" });
      await raiseAlert(DB, h.symbol, "CRITICAL", "Price data unavailable — indicators stale, manual check required");
      continue;
    }
    const s = series(candles);
    const ind = computeIndicators(candles, benchCloses);
    const hc = S.updateHighestClose({
      storedHighestClose: h.highest_close, adjCloses: s.closes, dates: s.dates, entryDate: h.entry_date });
    perHolding.push({ symbol: h.symbol, ind, hc, row: h });
    await DB.prepare(INDICATOR_UPSERT).bind(...indicatorBind(h.symbol, ind)).run();
  }

  // portfolio momentum rank
  const ranked = perHolding.filter(p => p.ind?.momentum_score != null)
    .sort((a, b2) => b2.ind.momentum_score - a.ind.momentum_score);
  const bottomCount = Math.ceil(ranked.length * 0.2);

  // ── 4. Universe indicators (watchlist + eligible scan) ──────────────
  const watch = (await DB.prepare(
    "SELECT symbol,sector FROM watchlist WHERE symbol NOT IN (SELECT symbol FROM holdings)").all()).results;
  const universeRows = [];
  for (const w of watch) {
    const candles = await loadCandles(w.symbol, "NSE", env, errors);
    if (!candles || candles.length < 30) continue;
    const ind = computeIndicators(candles, benchCloses);
    await DB.prepare(INDICATOR_UPSERT).bind(...indicatorBind(w.symbol, ind)).run();
    await DB.prepare("UPDATE watchlist SET momentum_score=?, updated_at=datetime('now') WHERE symbol=?")
      .bind(ind.momentum_score, w.symbol).run();
    universeRows.push({ symbol: w.symbol, momentum_score: ind.momentum_score });
  }

  // Eligible universe — fundamentals_cache is the complete Screener-eligible set.
  const fundCandidates = (await DB.prepare(
    `SELECT f.symbol,f.roe,f.de,f.mcap,f.crar,f.gross_npa,f.net_npa,n.industry,
            COALESCE(n.in_nifty100,0) AS in_nifty100
     FROM fundamentals_cache f JOIN nifty500 n ON f.symbol=n.symbol
     WHERE f.roe>15 AND f.de<1 AND f.mcap>5000 AND f.mcap<200000 AND f.in_nifty500=1`).all()).results;

  let scanned = 0, buyCandidates = 0;
  for (const s0 of fundCandidates) {
    scanned++;
    const candles = await loadCandles(s0.symbol, "NSE", env, errors);
    if (!candles || candles.length < 126) continue;
    const ind = computeIndicators(candles, benchCloses);
    const isFinancial = FINANCIAL_INDUSTRIES.has(s0.industry);
    const f = S.evaluateFilters({
      mcap: s0.mcap, roe: s0.roe, de: s0.de,
      above200: ind.above_200_dma, dist52w: ind.dist_52w_pct,
      ret6m: ind.return_6m_pct, tradedVal: ind.traded_val_cr,
      inNifty500: true, inNifty100: s0.in_nifty100 === 1,
      regime, isFinancial, crar: s0.crar, gnpa: s0.gross_npa, nnpa: s0.net_npa,
    });
    // A verdict may only be acted on with a FULL history.
    const actionable = S.isActionable(ind.data_sufficiency);
    const verdict = f.verdict === "BUY_CANDIDATE" && !actionable ? "REJECT_INSUFFICIENT_DATA" : f.verdict;
    if (verdict === "BUY_CANDIDATE") buyCandidates++;

    await DB.prepare(INDICATOR_UPSERT).bind(...indicatorBind(s0.symbol, ind)).run();
    await DB.prepare(
      `INSERT INTO opportunities (symbol,sector,roe,de,mcap,ltp,dma_200,dist_52w_pct,return_6m_pct,
         vol_1y_pct,momentum_score,rsi_14,mfi_14,rs_20d,rs_60d,traded_val_cr,vol_threshold_cr,
         band_used_pct,credit_test,filters_passed,failed_filters,verdict,is_holding,
         sector_slot_available,data_sufficiency,scan_date,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,date('now'),datetime('now'))
       ON CONFLICT(symbol) DO UPDATE SET
         ltp=excluded.ltp,dist_52w_pct=excluded.dist_52w_pct,return_6m_pct=excluded.return_6m_pct,
         momentum_score=excluded.momentum_score,rsi_14=excluded.rsi_14,mfi_14=excluded.mfi_14,
         rs_20d=excluded.rs_20d,rs_60d=excluded.rs_60d,traded_val_cr=excluded.traded_val_cr,
         vol_threshold_cr=excluded.vol_threshold_cr,band_used_pct=excluded.band_used_pct,
         credit_test=excluded.credit_test,filters_passed=excluded.filters_passed,
         failed_filters=excluded.failed_filters,verdict=excluded.verdict,
         data_sufficiency=excluded.data_sufficiency,scan_date=excluded.scan_date,
         updated_at=excluded.updated_at`
    ).bind(s0.symbol, s0.industry, s0.roe, s0.de, s0.mcap, ind.ltp, ind.dma_200, ind.dist_52w_pct,
      ind.return_6m_pct, ind.vol_1y_pct, ind.momentum_score, ind.rsi_14, ind.mfi_14,
      ind.rs_20d, ind.rs_60d, ind.traded_val_cr, f.vol_threshold_cr, f.band_used_pct,
      f.credit_test, f.filters_passed, JSON.stringify(f.failed_filters), verdict,
      holdingSymbols.has(s0.symbol) ? 1 : 0,
      holdings.filter(h => h.sector === s0.industry).length < 3 ? 1 : 0,
      ind.data_sufficiency).run();
    universeRows.push({ symbol: s0.symbol, momentum_score: ind.momentum_score });
  }

  // ── 5. Universe-wide ranking ────────────────────────────────────────
  const allRows = universeRows.concat(ranked.map(p => ({ symbol: p.symbol, momentum_score: p.ind.momentum_score })));
  const universeRanked = S.rankUniverse(allRows);
  const uniRank = new Map(universeRanked.map(r => [r.symbol, r]));
  for (const r of universeRanked) {
    await DB.prepare("UPDATE indicators SET universe_rank=?, universe_rank_pct=? WHERE symbol=?")
      .bind(r.universe_rank, r.universe_rank_pct, r.symbol).run();
  }

  // ── 6. Per-holding strategy state ───────────────────────────────────
  const holdingState = [];
  for (let i = 0; i < ranked.length; i++) {
    const p = ranked[i];
    const h = p.row, ind = p.ind;
    const portfolioRank = i + 1;
    const portfolioRankPct = round((portfolioRank / ranked.length) * 100, 1);
    const isBottom20 = i >= ranked.length - bottomCount;
    const u = uniRank.get(p.symbol);

    const ls = S.leaderScore({
      close: ind.ltp, dma20: ind.dma_20, dma20Prev5: ind.dma_20_prev5,
      higherHighs: ind.higher_highs, higherLows: ind.higher_lows,
      rs20: ind.rs_20d, rs60: ind.rs_60d,
      portfolioRankPct, universeRankPct: u?.universe_rank_pct,
      sectorAbove20dmaRising: null, sectorOutperform20d: null,  // sector index data unavailable
    });

    const highestClose = p.hc.highest_close;
    const peakGainPct = h.entry_price ? (highestClose / h.entry_price - 1) * 100 : 0;

    const det = S.leaderDeterioration({
      closesBelow20dma: ind.closes_below_20dma ?? 0, score: ls.leader_score,
      rsPercentile: u?.universe_rank_pct != null ? 100 - u.universe_rank_pct : null,
      lowerHighLowerLow: ind.higher_highs === false && ind.higher_lows === false,
      sectorNegative: null,
    });

    const state = S.classifyLeaderState({
      score: ls.leader_score, peakGainPct, prevState: h.leader_state,
      prevStreak: h.leader_streak, portfolioRank,
      deteriorationCount: det.deterioration_count,
      deteriorationStreak: det.deterioration_count >= 2 ? (h.deterioration_streak || 0) + 1 : 0,
    });

    const stage = S.computeGttStage({
      entryPrice: h.entry_price, highestClose, prevStage: h.gtt_stage,
      prevStop: h.gtt_min_stop, leaderState: state.leader_state,
      liveGttTrigger: h.gtt_trigger,
    });

    const gb = S.givebackAlert({
      entryPrice: h.entry_price, highestClose, ltp: ind.ltp,
      below20dma: ind.above_20_dma === false,
    });

    const fundamentalsIncomplete = !fundSymbols.has(p.symbol);
    const py = S.pyramidBrake({
      fundamentalsIncomplete,
      gainPct: h.entry_price ? (ind.ltp / h.entry_price - 1) * 100 : null,
      ltp: ind.ltp, dma20: ind.dma_20, rsi: ind.rsi_14, mfi: ind.mfi_14,
      vixChange, regime, hasBinaryEvent: null,
    });

    const rot = S.rotationReview({
      isBottom20, rs20: ind.rs_20d, closesBelow20dma: ind.closes_below_20dma ?? 0,
      leaderScoreVal: ls.leader_score,
      sessionsSinceNew20dHigh: ind.sessions_since_20d_high,
      fundamentalDeterioration: null,
    });

    const daysHeld = h.entry_date ? Math.floor((Date.now() - Date.parse(h.entry_date)) / 86400000) : null;
    const tp = S.timeProgress({
      daysHeld, gainPct: h.entry_price ? (ind.ltp / h.entry_price - 1) * 100 : 0,
      leaderScoreVal: ls.leader_score, portfolioRankPct,
      newHigh20d: ind.sessions_since_20d_high === 0,
    });

    const cov = S.gttCoverage({
      quantity: h.quantity, gttQty: h.gtt_qty, gttId: h.gtt_id,
      gttTrigger: h.gtt_trigger, minStop: stage?.min_stop,
    });

    await DB.prepare(
      `UPDATE holdings SET momentum_score=?,momentum_rank=?,is_bottom_20=?,
        highest_close=?,highest_close_date=COALESCE(?,highest_close_date),
        leader_score=?,leader_state=?,leader_streak=?,deterioration_streak=?,
        gtt_stage=?,gtt_min_stop=?,atr_pct=?,rs_20d=?,rs_60d=?,
        giveback_alert=?,pyramid_eligibility=?,rotation_status=?,time_check=?,
        coverage_alerts=?,fundamentals_status=?,last_audit=datetime('now') WHERE symbol=?`
    ).bind(ind.momentum_score, portfolioRank, isBottom20 ? 1 : 0,
      p.hc.highest_close, p.hc.highest_close_date,
      ls.leader_score, state.leader_state, state.leader_streak,
      det.deterioration_count >= 2 ? (h.deterioration_streak || 0) + 1 : 0,
      stage?.gtt_stage ?? h.gtt_stage, stage?.min_stop ?? null, ind.atr_pct,
      ind.rs_20d, ind.rs_60d, gb.giveback_alert,
      py.pyramid_eligibility, rot.rotation_status, tp.time_check,
      JSON.stringify(cov.coverage_alerts),
      fundamentalsIncomplete ? "FUNDAMENTALS_DATA_INCOMPLETE" : "OK", p.symbol).run();

    for (const a of cov.coverage_alerts) {
      await raiseAlert(DB, p.symbol, a === "NO_GTT" ? "CRITICAL" : "WARNING", `GTT coverage: ${a}`);
    }
    if (gb.giveback_alert) await raiseAlert(DB, p.symbol, "WARNING", `Giveback review: ${(gb.giveback_reasons || []).join("; ")}`);
    if (stage?.stage_advanced) await raiseAlert(DB, p.symbol, "INFO", `GTT stage advanced to ${stage.gtt_stage} — raise stop to ${stage.min_stop} (limit ${stage.limit_price})`);
    if (rot.rotation_status === "ROTATION_REVIEW_ELIGIBLE") await raiseAlert(DB, p.symbol, "WARNING", `Rotation REVIEW: ${rot.deterioration_signals} deterioration signals — requires superior replacement + approval`);
    if (tp.time_check) await raiseAlert(DB, p.symbol, "INFO", `Day ${tp.day} ${tp.time_check}`);
    if (fundamentalsIncomplete) await raiseAlert(DB, p.symbol, "INFO",
      "FUNDAMENTALS_DATA_INCOMPLETE — existing holding: protection retained, no forced exit, pyramiding barred until a fresh Screener export revalidates it");

    holdingState.push({ symbol: p.symbol, rank: portfolioRank, leader: state.leader_state,
      score: ls.leader_score, stage: stage?.gtt_stage, minStop: stage?.min_stop,
      giveback: gb.giveback_alert, pyramid: py.pyramid_eligibility, rotation: rot.rotation_status, timeCheck: tp.time_check });
  }
  log.parts.holdings = { count: holdings.length, ranked: ranked.length, state: holdingState };

  // ── 7. NAV + liquidity (§7) ─────────────────────────────────────────
  const cfg = Object.fromEntries((await DB.prepare("SELECT * FROM config").all()).results.map(c => [c.key, c.value]));
  let equityValue = 0;
  for (const p of perHolding) {
    if (!p.ind) { equityValue += (p.row?.quantity || 0) * (p.row?.entry_price || 0); continue; }
    equityValue += (p.row.quantity || 0) * p.ind.ltp;
  }
  const cap = S.capitalAccounting({
    equityValue,
    liquidbeesValue: parseInt(cfg.liquidbees_qty || "0") * parseFloat(cfg.liquidbees_nav || "1000"),
    cashKite: parseFloat(cfg.cash_kite || "0"),
    cashBank: parseFloat(cfg.cash_bank || "0"),
  });
  const liq = S.liquidityStatus(regime, cap.liquidity_pct);
  const baseline = parseFloat(cfg.baseline || "0") || cap.net_worth || 1;
  const today = new Date().toISOString().split("T")[0];
  const prevNav = await DB.prepare("SELECT net_worth FROM daily_nav WHERE date < ? ORDER BY date DESC LIMIT 1").bind(today).first();
  const dayChange = prevNav?.net_worth ? cap.net_worth - prevNav.net_worth : 0;

  await DB.prepare(
    `INSERT OR REPLACE INTO daily_nav (date,equity_value,liquidbees_value,cash_kite,cash_bank,
      net_worth,nifty_close,portfolio_return_pct,positions_count,cash_ratio_pct,
      nifty50_close,nifty500_close,vix_close,brent_close,day_change_pct,day_change_abs,
      liquidity_pct,liquidity_target_low,liquidity_target_high,liquidity_status,regime)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).bind(today, cap.equity_value, cap.liquidbees_value, cap.cash_kite, cap.cash_bank,
    cap.net_worth, niftyClose, round((cap.net_worth / baseline - 1) * 100), holdings.length,
    cap.liquidity_pct, niftyClose, bench500Close, vixVal, prevMacro?.brent_price ?? null,
    prevNav?.net_worth ? round((dayChange / prevNav.net_worth) * 100) : 0, round(dayChange, 0),
    cap.liquidity_pct, liq.target_low, liq.target_high, liq.status, regime).run();

  log.parts.nav = { ...cap, liquidity: liq, regime };
  log.parts.scan = { eligibleUniverse: fundCandidates.length, scanned, buyCandidates,
    entrySizing: S.entrySizingPct(regime) };

  if (!dryRun) {
    await DB.prepare("INSERT OR REPLACE INTO config (key,value) VALUES ('last_scan_date',?)").bind(new Date().toISOString()).run();
    await DB.prepare("DELETE FROM opportunities WHERE scan_date<date('now','-14 days')").run();
  }
  if (errors.length) log.parts.dataErrorCount = errors.length;
  log.finished = new Date().toISOString();
  return log;
}

const FINANCIAL_INDUSTRIES = new Set(["Financial Services"]);

function intBool(v) { return v == null ? null : v === 1 || v === true; }

async function raiseAlert(DB, symbol, severity, message) {
  await DB.prepare(
    "INSERT INTO alerts (symbol,severity,message,resolved,created_at) VALUES (?,?,?,0,datetime('now'))"
  ).bind(symbol, severity, message).run();
}

// Dry-run guard: swallows every mutating statement, records it, leaves D1 untouched.
function wrapReadOnly(DB, log) {
  log.suppressedWrites = [];
  return {
    prepare(sql) {
      const mutating = /^\s*(INSERT|UPDATE|DELETE|REPLACE|DROP|ALTER|CREATE)/i.test(sql);
      if (!mutating) return DB.prepare(sql);
      const stmt = { bind: (...a) => ({ run: async () => { log.suppressedWrites.push({ sql: sql.slice(0, 60).replace(/\s+/g, " "), args: a.length }); return { success: true }; },
        all: async () => ({ results: [] }), first: async () => null }),
        run: async () => { log.suppressedWrites.push({ sql: sql.slice(0, 60).replace(/\s+/g, " "), args: 0 }); return { success: true }; },
        all: async () => ({ results: [] }), first: async () => null };
      return stmt;
    },
  };
}

// ══════════════════════════════════════════════════════════════════════
// API HANDLERS
// ══════════════════════════════════════════════════════════════════════
async function handleScan(request, env) {
  const body = await request.json();
  const { symbol, exchange = "NSE", roe, de, mcap, regime = "NORMAL",
    isFinancial = false, crar = null, gnpa = null, nnpa = null } = body;
  const errors = [];
  const row = await env.DB.prepare(
    "SELECT COALESCE(in_nifty100,0) AS n100, 1 AS n500, industry FROM nifty500 WHERE symbol=?").bind(symbol).first();
  const inNifty500 = !!row;             // membership validated against D1, never trusted from the request
  const candles = await loadCandles(symbol, exchange, env, errors);
  if (!candles) return json({ error: "data_unavailable", symbol, detail: errors[0] }, 502);
  const benchC = await loadCandles(BENCH_TICKER, "IDX", env, errors);
  const ind = computeIndicators(candles, benchC ? series(benchC).closes : null);
  const f = S.evaluateFilters({
    mcap, roe, de, above200: ind.above_200_dma, dist52w: ind.dist_52w_pct,
    ret6m: ind.return_6m_pct, tradedVal: ind.traded_val_cr,
    inNifty500, inNifty100: row?.n100 === 1, regime,
    isFinancial: isFinancial || FINANCIAL_INDUSTRIES.has(row?.industry), crar, gnpa, nnpa,
  });
  const actionable = S.isActionable(ind.data_sufficiency);
  return json({ symbol, regime, ...ind, ...f,
    verdict: f.verdict === "BUY_CANDIDATE" && !actionable ? "REJECT_INSUFFICIENT_DATA" : f.verdict,
    actionable });
}

async function handleRanking(env) {
  const holdings = (await env.DB.prepare(
    `SELECT h.symbol,h.sector,h.momentum_score,h.momentum_rank,h.is_bottom_20,h.entry_price,
            h.gtt_stage,h.gtt_min_stop,h.leader_state,h.leader_score,h.rotation_status,
            h.time_check,h.giveback_alert,h.pyramid_eligibility,i.universe_rank,i.rs_20d,i.rs_60d
     FROM holdings h LEFT JOIN indicators i ON h.symbol=i.symbol ORDER BY h.momentum_rank ASC`).all()).results;
  const topNew = (await env.DB.prepare(
    `SELECT symbol,sector,momentum_score,filters_passed,verdict,data_sufficiency
     FROM opportunities WHERE verdict='BUY_CANDIDATE' AND is_holding=0 AND sector_slot_available=1
       AND scan_date>=date('now','-14 days') ORDER BY momentum_score DESC LIMIT 20`).all()).results;
  return json({ holdings, topNew });
}

async function handleScanStatus(env) {
  const [lastRun, total, candidates, eligible] = await Promise.all([
    env.DB.prepare("SELECT value FROM config WHERE key='last_scan_date'").first(),
    env.DB.prepare("SELECT COUNT(*) c FROM opportunities WHERE scan_date>=date('now','-14 days')").first(),
    env.DB.prepare("SELECT COUNT(*) c FROM opportunities WHERE verdict='BUY_CANDIDATE' AND scan_date>=date('now','-14 days')").first(),
    env.DB.prepare("SELECT COUNT(*) c FROM fundamentals_cache WHERE in_nifty500=1 AND roe>15 AND de<1 AND mcap>5000 AND mcap<200000").first(),
  ]);
  return json({ lastScanDate: lastRun?.value || "never", eligibleUniverse: eligible?.c || 0,
    stocksScanned: total?.c || 0, candidatesFound: candidates?.c || 0 });
}

async function handleKiteSync(request, env) {
  const body = await request.json();
  const { cash_kite, cash_bank, holdings_ltp, trades, daily_nav,
    fii_net_buyers_5d, fii_net_sellers_3d, midcaps_outperforming, systemic_stress, brent } = body;
  const updated = [];
  for (const [k, v] of Object.entries({ cash_kite, cash_bank })) {
    if (v != null) {
      await env.DB.prepare("INSERT OR REPLACE INTO config (key,value) VALUES (?,?)").bind(k, String(Math.round(v))).run();
      updated.push(k);
    }
  }
  // Regime inputs the Worker cannot derive from price data are posted in;
  // the Worker still performs the classification itself on the next cron.
  const macroFields = { fii_net_buyers_5d, fii_net_sellers_3d, midcaps_outperforming, systemic_stress };
  for (const [k, v] of Object.entries(macroFields)) {
    if (v != null) {
      await env.DB.prepare(`UPDATE macro_state SET ${k}=? WHERE id=1`).bind(v ? 1 : 0).run();
      updated.push(k);
    }
  }
  if (body.fii_as_of_date != null) {
    await env.DB.prepare("UPDATE macro_state SET fii_as_of_date=? WHERE id=1").bind(String(body.fii_as_of_date).slice(0, 10)).run();
    updated.push("fii_as_of_date");
  }
  if (brent != null) { await env.DB.prepare("UPDATE macro_state SET brent_price=? WHERE id=1").bind(brent).run(); updated.push("brent"); }
  if (holdings_ltp && typeof holdings_ltp === "object") {
    for (const [symbol, ltp] of Object.entries(holdings_ltp)) {
      await env.DB.prepare("UPDATE indicators SET ltp=?, updated_at=datetime('now') WHERE symbol=?").bind(ltp, symbol).run();
    }
    updated.push(`ltp_x${Object.keys(holdings_ltp).length}`);
  }
  if (Array.isArray(trades)) {
    for (const t of trades) {
      await env.DB.prepare(
        "INSERT INTO trades (symbol,trade_date,trade_type,quantity,price,value,pnl,pnl_pct,reason,tag,gtt_triggered) VALUES (?,?,?,?,?,?,?,?,?,?,?)"
      ).bind(t.symbol, t.trade_date, t.trade_type, t.quantity, t.price, t.value || t.quantity * t.price,
        t.pnl || 0, t.pnl_pct || 0, t.reason || "", t.tag || "", t.gtt_triggered || 0).run();
    }
    updated.push(`trades_x${trades.length}`);
  }
  if (daily_nav) {
    const d = daily_nav;
    await env.DB.prepare(
      "INSERT OR REPLACE INTO daily_nav (date,equity_value,liquidbees_value,cash_kite,cash_bank,net_worth,nifty_close,portfolio_return_pct,positions_count,cash_ratio_pct,nifty50_close,nifty500_close,vix_close,brent_close,day_change_pct,day_change_abs) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)"
    ).bind(d.date, d.equity_value, d.liquidbees_value, d.cash_kite, d.cash_bank, d.net_worth,
      d.nifty_close, d.portfolio_return_pct, d.positions_count, d.cash_ratio_pct,
      d.nifty50_close, d.nifty500_close, d.vix_close, d.brent_close, d.day_change_pct, d.day_change_abs).run();
    updated.push("daily_nav");
  }
  return json({ ok: true, updated });
}

async function handleDashboardData(env) {
  const [holdingsR, navR, macroR, alertsR, configR, tradesR, oppsR, nearMissR] = await Promise.all([
    env.DB.prepare(`SELECT h.*, i.ltp live_ltp, i.rsi_14 live_rsi, i.mfi_14 live_mfi,
        i.dma_20 live_dma20, i.dma_200 live_dma200, i.universe_rank, i.rs_20d live_rs20,
        i.data_sufficiency FROM holdings h LEFT JOIN indicators i ON h.symbol=i.symbol
        ORDER BY h.momentum_rank ASC`).all(),
    env.DB.prepare("SELECT * FROM daily_nav ORDER BY date DESC LIMIT 60").all(),
    env.DB.prepare("SELECT * FROM macro_state WHERE id=1").first(),
    env.DB.prepare("SELECT * FROM alerts WHERE resolved=0 ORDER BY CASE severity WHEN 'CRITICAL' THEN 1 WHEN 'WARNING' THEN 2 ELSE 3 END, created_at DESC").all(),
    env.DB.prepare("SELECT * FROM config").all(),
    env.DB.prepare("SELECT * FROM trades ORDER BY id DESC LIMIT 100").all(),
    env.DB.prepare("SELECT * FROM opportunities WHERE verdict='BUY_CANDIDATE' AND is_holding=0 AND scan_date>=date('now','-14 days') ORDER BY momentum_score DESC LIMIT 15").all(),
    env.DB.prepare("SELECT * FROM opportunities WHERE filters_passed=7 AND scan_date>=date('now','-14 days') ORDER BY momentum_score DESC LIMIT 10").all(),
  ]);

  const config = Object.fromEntries(configR.results.map(c => [c.key, c.value]));
  const holdings = holdingsR.results;
  const navHistory = navR.results.reverse();
  const regime = macroR?.regime || "NORMAL";

  let equityValue = 0; const ltpWarnings = [];
  holdings.forEach(h => {
    if (h.live_ltp > 0) equityValue += h.quantity * h.live_ltp;
    else { equityValue += h.quantity * h.entry_price; ltpWarnings.push(h.symbol); }
  });

  const cap = S.capitalAccounting({
    equityValue,
    liquidbeesValue: parseInt(config.liquidbees_qty || "0") * parseFloat(config.liquidbees_nav || "1000"),
    cashKite: parseFloat(config.cash_kite || "0"),
    cashBank: parseFloat(config.cash_bank || "0"),
  });
  const baseline = parseFloat(config.baseline || "0") || cap.net_worth || 1;
  const liq = S.liquidityStatus(regime, cap.liquidity_pct);

  const returnPct = round((cap.net_worth / baseline - 1) * 100);
  const n50base = parseFloat(config.nifty50_baseline || "22497");
  const n500base = parseFloat(config.nifty500_baseline || "20300");
  const n50return = round(((macroR?.nifty_close || n50base) / n50base - 1) * 100);
  const n500return = round(((macroR?.nifty500_close || n500base) / n500base - 1) * 100);

  const trades = tradesR.results;
  const closed = trades.filter(t => t.trade_type !== "BUY");
  const winners = closed.filter(t => t.pnl > 0), losers = closed.filter(t => t.pnl < 0);
  const winRateAll = closed.length ? round(winners.length / closed.length * 100, 0) : 0;

  let bestDay = { amount: 0, pct: 0, date: "-" }, worstDay = { amount: 0, pct: 0, date: "-" };
  for (let i = 1; i < navHistory.length; i++) {
    const a = navHistory[i].net_worth, b2 = navHistory[i - 1].net_worth;
    if (!a || !b2) continue;
    const ch = a - b2, chPct = ch / b2 * 100;
    if (ch > bestDay.amount) bestDay = { amount: round(ch, 0), pct: round(chPct), date: navHistory[i].date };
    if (ch < worstDay.amount) worstDay = { amount: round(ch, 0), pct: round(chPct), date: navHistory[i].date };
  }

  const sectorCounts = {};
  holdings.forEach(h => { sectorCounts[h.sector] = (sectorCounts[h.sector] || 0) + 1; });

  // v1.1: review candidates only. No automatic exit→enter pairing.
  const rotationReviews = holdings
    .filter(h => h.rotation_status === "ROTATION_REVIEW_ELIGIBLE" || h.time_check)
    .map(h => ({ symbol: h.symbol, rotation_status: h.rotation_status, time_check: h.time_check,
      momentum_rank: h.momentum_rank, leader_state: h.leader_state, rs_20d: h.live_rs20 }));

  return json({
    macro: { regime, vix: macroR?.vix, vixChange: macroR?.vix_change, brent: macroR?.brent_price,
      nifty: macroR?.nifty_close, breadth: macroR?.breadth_pct,
      rationale: macroR?.regime_rationale, missingInputs: macroR?.regime_missing_inputs,
      updatedAt: macroR?.updated_at },
    liquidity: { pct: cap.liquidity_pct, total: cap.total_liquidity, ...liq },
    sizing: S.entrySizingPct(regime),
    netWorth: cap.net_worth, baseline, startDate: config.start_date || null, returnPct, absGain: round(cap.net_worth - baseline, 0),
    alphaN50: round(returnPct - n50return), alphaN500: round(returnPct - n500return),
    n50return, n500return, bestDay, worstDay,
    winRate: { all: winRateAll, wins: winners.length, losses: losers.length },
    deployed: { pct: cap.deployed_pct, count: holdings.length, equity: cap.equity_value,
      cash: cap.total_liquidity },
    holdings: holdings.map(h => {
      const ltp = h.live_ltp > 0 ? h.live_ltp : h.entry_price;
      return { symbol: h.symbol, sector: h.sector, entry_price: h.entry_price, entry_date: h.entry_date,
        quantity: h.quantity, ltp: round(ltp), pnl_pct: round((ltp / h.entry_price - 1) * 100),
        value: round(h.quantity * ltp, 0), gtt_stage: h.gtt_stage, gtt_trigger: h.gtt_trigger,
        gtt_min_stop: h.gtt_min_stop,
        gtt_gap_pct: h.gtt_trigger ? round((ltp / h.gtt_trigger - 1) * 100) : null,
        momentum_score: h.momentum_score, momentum_rank: h.momentum_rank, universe_rank: h.universe_rank,
        is_bottom_20: h.is_bottom_20, leader_state: h.leader_state, leader_score: h.leader_score,
        highest_close: h.highest_close, giveback_alert: h.giveback_alert,
        pyramid_eligibility: h.pyramid_eligibility, rotation_status: h.rotation_status,
        time_check: h.time_check, coverage_alerts: h.coverage_alerts,
        rsi_14: h.live_rsi, mfi_14: h.live_mfi, rs_20d: h.live_rs20,
        dma_20: h.live_dma20, dma_200: h.live_dma200,
        data_sufficiency: h.data_sufficiency, ltp_stale: !(h.live_ltp > 0) };
    }),
    sectors: sectorCounts, alerts: alertsR.results, trades,
    tradeStats: {
      total: closed.length, wins: winners.length, losses: losers.length, winRate: winRateAll,
      netPnl: round(closed.reduce((s, t) => s + t.pnl, 0), 0),
      avgWinner: winners.length ? round(winners.reduce((s, t) => s + t.pnl, 0) / winners.length, 0) : 0,
      avgLoser: losers.length ? round(losers.reduce((s, t) => s + t.pnl, 0) / losers.length, 0) : 0,
      profitFactor: losers.length ? round(Math.abs(winners.reduce((s, t) => s + t.pnl, 0) / losers.reduce((s, t) => s + t.pnl, 0))) : null,
    },
    navHistory: navHistory.map(n => ({ date: n.date, nw: n.net_worth, n50: n.nifty50_close, n500: n.nifty500_close })),
    monthlyReturns: computeMonthlyReturns(navHistory),
    freshPicks: oppsR.results, nearMisses: nearMissR.results,
    rotationReviews, ltpWarnings,
  });
}

function computeMonthlyReturns(navHistory) {
  if (navHistory.length < 2) return [];
  const months = {};
  navHistory.forEach(n => {
    if (!n.net_worth || !n.date) return;
    const m = n.date.slice(0, 7);
    if (!months[m]) months[m] = { first: n.net_worth, last: n.net_worth };
    months[m].last = n.net_worth;
  });
  return Object.entries(months).map(([m, v]) => ({ month: m, pct: round((v.last / v.first - 1) * 100) }));
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } });
}

export { dailyCron, computeIndicators, loadCandles, handleDashboardData };
