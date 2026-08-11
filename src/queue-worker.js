// UC_MOMENTUM v1.1.1 — Free-plan queue scanner.
// Candidate/watchlist Yahoo fetches are split across Queue consumer invocations
// so no invocation approaches the Workers Free 50-external-subrequest ceiling.
// Broker/Kite remains authoritative for holdings, quantities, trades and GTTs.

import baseWorker, { computeIndicators, loadCandles } from "./index.js";
import * as S from "./strategy.js";

const VERSION = "v1.1.1-queue";
const BENCH_TICKER = "^CRSLDX";
const NIFTY_TICKER = "^NSEI";
const VIX_TICKER = "^INDIAVIX";
const MIDCAP_TICKERS = ["^NSEMDCP50", "NIFTY_MIDCAP_100.NS", "^CNXMID"];
const SCAN_BATCH_SIZE = 10; // 1 benchmark + 10 symbols = 11 external fetches/invocation.
const ACTIVE_SCAN_MAX_AGE_MIN = 90;
const FINANCIAL_INDUSTRIES = new Set(["Financial Services"]);
const TERMINAL = new Set(["COMPLETE", "INCOMPLETE", "DRY_COMPLETE", "DRY_INCOMPLETE", "FAILED"]);
const { round } = S;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/api/refresh") {
      const dryRun = url.searchParams.get("dry") === "1";
      try {
        const out = await startQueuedRefresh(env, { dryRun, source: "http" });
        return json(out, out.accepted === false ? 409 : 202);
      } catch (e) {
        return json({ version: VERSION, error: String(e?.message || e) }, 500);
      }
    }
    if (url.pathname === "/api/scan-status") return handleQueuedScanStatus(url, env);
    return baseWorker.fetch(request, env, ctx);
  },

  async scheduled(event, env, ctx) {
    await startQueuedRefresh(env, { dryRun: false, source: "cron" });
  },

  async queue(batch, env, ctx) {
    if (batch.queue.endsWith("-dlq")) {
      for (const msg of batch.messages) {
        await markDlqFailure(env, msg.body, msg.attempts);
        msg.ack();
      }
      return;
    }

    for (const msg of batch.messages) {
      try {
        const body = msg.body || {};
        if (body.type === "scan_batch") await processScanBatch(env, body);
        else if (body.type === "finalize") await finalizeRun(env, body);
        else throw new Error(`unknown_queue_message:${body.type || "missing"}`);
        msg.ack();
      } catch (e) {
        await recordQueueError(env, msg.body, e, msg.attempts);
        msg.retry({ delaySeconds: Math.min(300, 15 * Math.max(1, msg.attempts)) });
      }
    }
  },
};

async function startQueuedRefresh(env, { dryRun, source }) {
  if (!env.SCAN_QUEUE) throw new Error("SCAN_QUEUE binding unavailable");

  // Do not overlap active runs. Stale ones are failed closed and may be replaced.
  const active = await env.DB.prepare(
    `SELECT run_id,status,created_at,dry_run FROM scan_runs
     WHERE status IN ('QUEUED','SCANNING','FINALIZING','RETRYING')
       AND created_at >= datetime('now', ?)
     ORDER BY created_at DESC LIMIT 1`
  ).bind(`-${ACTIVE_SCAN_MAX_AGE_MIN} minutes`).first();
  if (active) {
    return { version: VERSION, accepted: false, reason: "scan_already_active", ...active };
  }
  await env.DB.prepare(
    `UPDATE scan_runs SET status='FAILED', last_error='stale active run superseded', finished_at=datetime('now')
     WHERE status IN ('QUEUED','SCANNING','FINALIZING','RETRYING')
       AND created_at < datetime('now', ?)`
  ).bind(`-${ACTIVE_SCAN_MAX_AGE_MIN} minutes`).run();

  // Keep one week of operational scan audit while bounding staging growth.
  await env.DB.prepare(
    `DELETE FROM scan_staging WHERE run_id IN (
       SELECT run_id FROM scan_runs WHERE created_at < datetime('now','-7 days')
         AND status IN ('COMPLETE','INCOMPLETE','DRY_COMPLETE','DRY_INCOMPLETE','FAILED'))`
  ).run();
  await env.DB.prepare(
    `DELETE FROM scan_runs WHERE created_at < datetime('now','-7 days')
       AND status IN ('COMPLETE','INCOMPLETE','DRY_COMPLETE','DRY_INCOMPLETE','FAILED')`
  ).run();

  const [fundR, watchR, holdingsR] = await Promise.all([
    env.DB.prepare(
      `SELECT f.symbol,f.roe,f.de,f.mcap,f.crar,f.gross_npa,f.net_npa,n.industry,
              COALESCE(n.in_nifty100,0) AS in_nifty100
       FROM fundamentals_cache f JOIN nifty500 n ON f.symbol=n.symbol
       WHERE f.roe>15 AND f.mcap>5000 AND f.mcap<200000 AND f.in_nifty500=1`
    ).all(),
    env.DB.prepare("SELECT symbol,sector FROM watchlist").all(),
    env.DB.prepare("SELECT symbol FROM holdings").all(),
  ]);

  const holdingSymbols = new Set((holdingsR.results || []).map(r => r.symbol));
  const work = new Map();
  let eligibleUniverse = 0;

  for (const f of fundR.results || []) {
    eligibleUniverse++;
    // Holdings are fetched fresh in the finalizer, so do not spend a second Yahoo request here.
    if (holdingSymbols.has(f.symbol)) continue;
    work.set(f.symbol, {
      symbol: f.symbol,
      sector: f.industry,
      roe: f.roe, de: f.de, mcap: f.mcap,
      crar: f.crar, gross_npa: f.gross_npa, net_npa: f.net_npa,
      in_nifty100: f.in_nifty100 === 1 ? 1 : 0,
      is_candidate: 1, is_watch: 0,
    });
  }
  for (const w of watchR.results || []) {
    if (holdingSymbols.has(w.symbol)) continue;
    const prior = work.get(w.symbol);
    if (prior) { prior.is_watch = 1; if (!prior.sector) prior.sector = w.sector; }
    else work.set(w.symbol, {
      symbol: w.symbol, sector: w.sector,
      roe: null, de: null, mcap: null, crar: null, gross_npa: null, net_npa: null,
      in_nifty100: 0, is_candidate: 0, is_watch: 1,
    });
  }

  const items = [...work.values()];
  if (!items.length) throw new Error("empty_scan_universe");
  const batches = chunk(items.map(x => x.symbol), SCAN_BATCH_SIZE);
  const runId = crypto.randomUUID();

  await env.DB.prepare(
    `INSERT INTO scan_runs
       (run_id,version,dry_run,source,status,total_items,eligible_universe,batch_count,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,datetime('now'),datetime('now'))`
  ).bind(runId, VERSION, dryRun ? 1 : 0, source, "QUEUED", items.length, eligibleUniverse, batches.length).run();

  const statements = items.map(x => env.DB.prepare(
    `INSERT INTO scan_staging
       (run_id,symbol,sector,roe,de,mcap,crar,gross_npa,net_npa,in_nifty100,is_candidate,is_watch)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
  ).bind(runId, x.symbol, x.sector, x.roe, x.de, x.mcap, x.crar, x.gross_npa, x.net_npa,
    x.in_nifty100, x.is_candidate, x.is_watch));
  await env.DB.batch(statements);

  try {
    await env.SCAN_QUEUE.sendBatch(batches.map((symbols, i) => ({ body: {
      type: "scan_batch", runId, batchNo: i + 1, batchCount: batches.length, symbols,
    }})));
    await env.DB.prepare(
      "UPDATE scan_runs SET status='SCANNING',started_at=datetime('now'),updated_at=datetime('now') WHERE run_id=?"
    ).bind(runId).run();
  } catch (e) {
    await env.DB.prepare(
      "UPDATE scan_runs SET status='FAILED',last_error=?,finished_at=datetime('now'),updated_at=datetime('now') WHERE run_id=?"
    ).bind(`queue_publish:${String(e?.message || e)}`, runId).run();
    throw e;
  }

  return {
    version: VERSION, accepted: true, runId, dryRun, status: "SCANNING",
    totalItems: items.length, eligibleUniverse, batchCount: batches.length, batchSize: SCAN_BATCH_SIZE,
    statusUrl: `/api/scan-status?runId=${encodeURIComponent(runId)}`,
    note: dryRun
      ? "Distributed dry run writes only scan_runs/scan_staging operational state; portfolio strategy tables remain untouched."
      : "Queued refresh accepted. Portfolio writes occur only in the finalizer after all batches finish.",
  };
}

async function processScanBatch(env, body) {
  const { runId, symbols } = body;
  if (!runId || !Array.isArray(symbols) || !symbols.length) throw new Error("invalid_scan_batch");
  const run = await env.DB.prepare("SELECT * FROM scan_runs WHERE run_id=?").bind(runId).first();
  if (!run || TERMINAL.has(run.status)) return;

  const errors = [];
  const bench = await loadCandles(BENCH_TICKER, "IDX", env, errors);
  if (!bench || bench.length < 126) throw new Error(`benchmark_unavailable:${errors[0]?.error || "unknown"}`);
  const benchCloses = closesOf(bench);

  const placeholders = symbols.map(() => "?").join(",");
  const rows = (await env.DB.prepare(
    `SELECT * FROM scan_staging WHERE run_id=? AND symbol IN (${placeholders})`
  ).bind(runId, ...symbols).all()).results || [];

  for (const row of rows) {
    if (row.completed_at) continue; // idempotent retry: already committed.
    const localErrors = [];
    const candles = await loadCandles(row.symbol, "NSE", env, localErrors);
    if (!candles || candles.length < 30) {
      const err = localErrors[0]?.error || "insufficient_price_data";
      // Retry transient upstream/network failures. Already-completed symbols in this
      // message are idempotently skipped on redelivery.
      if (isRetryableFetchError(err)) throw new Error(`retryable_fetch:${row.symbol}:${err}`);
      await env.DB.prepare(
        `UPDATE scan_staging SET error=?,completed_at=datetime('now') WHERE run_id=? AND symbol=? AND completed_at IS NULL`
      ).bind(err, runId, row.symbol).run();
      continue;
    }
    const ind = computeIndicators(candles, benchCloses);
    await env.DB.prepare(
      `UPDATE scan_staging SET indicator_json=?,error=NULL,completed_at=datetime('now')
       WHERE run_id=? AND symbol=? AND completed_at IS NULL`
    ).bind(JSON.stringify(ind), runId, row.symbol).run();
  }

  const c = await env.DB.prepare(
    `SELECT COUNT(*) AS completed,
            SUM(CASE WHEN indicator_json IS NOT NULL THEN 1 ELSE 0 END) AS successful,
            SUM(CASE WHEN error IS NOT NULL THEN 1 ELSE 0 END) AS failed
     FROM scan_staging WHERE run_id=? AND completed_at IS NOT NULL`
  ).bind(runId).first();
  const completed = Number(c?.completed || 0), successful = Number(c?.successful || 0), failed = Number(c?.failed || 0);
  await env.DB.prepare(
    `UPDATE scan_runs SET completed_items=?,successful_items=?,failed_items=?,status='SCANNING',updated_at=datetime('now')
     WHERE run_id=? AND status NOT IN ('COMPLETE','INCOMPLETE','DRY_COMPLETE','DRY_INCOMPLETE','FAILED')`
  ).bind(completed, successful, failed, runId).run();

  if (completed >= Number(run.total_items || 0)) {
    const latest = await env.DB.prepare("SELECT status FROM scan_runs WHERE run_id=?").bind(runId).first();
    if (latest && latest.status === "SCANNING") {
      // Publish first. If publishing fails, this batch retries and can publish again.
      // Duplicate finalizers are harmless because finalization is terminal/idempotent.
      await env.SCAN_QUEUE.send({ type: "finalize", runId });
      await env.DB.prepare(
        "UPDATE scan_runs SET status='FINALIZING',updated_at=datetime('now') WHERE run_id=? AND status='SCANNING'"
      ).bind(runId).run();
    }
  }
}

async function finalizeRun(env, body) {
  const runId = body?.runId;
  if (!runId) throw new Error("invalid_finalize_message");
  const run = await env.DB.prepare("SELECT * FROM scan_runs WHERE run_id=?").bind(runId).first();
  if (!run || TERMINAL.has(run.status)) return;
  if (Number(run.completed_items || 0) < Number(run.total_items || 0)) throw new Error("finalize_before_all_batches");

  const dryRun = run.dry_run === 1;
  const dataErrors = [];
  const holdings = (await env.DB.prepare("SELECT * FROM holdings").all()).results || [];
  const fundSymbols = new Set(((await env.DB.prepare("SELECT symbol FROM fundamentals_cache").all()).results || []).map(r => r.symbol));
  const holdingSymbols = new Set(holdings.map(h => h.symbol));

  // Finalizer external budget: 3 core indices + first resolvable midcap + 11 holdings ~= 15.
  const [niftyC, benchC, vixC] = await Promise.all([
    loadCandles(NIFTY_TICKER, "IDX", env, dataErrors),
    loadCandles(BENCH_TICKER, "IDX", env, dataErrors),
    loadCandles(VIX_TICKER, "IDX", env, dataErrors),
  ]);
  if (!niftyC || !benchC || !vixC) throw new Error("core_market_context_unavailable");

  let midcapC = null, midcapTicker = null;
  for (const mt of MIDCAP_TICKERS) {
    midcapC = await loadCandles(mt, "IDX", env, []);
    if (midcapC && midcapC.length >= 25) { midcapTicker = mt; break; }
    midcapC = null;
  }
  if (!midcapTicker) dataErrors.push({ symbol: "MIDCAP_INDEX", error: "no_midcap_index_resolved" });

  const niftyCloses = closesOf(niftyC), benchCloses = closesOf(benchC), vixCloses = closesOf(vixC);
  const niftyClose = last(niftyCloses), nifty50dma = S.sma(niftyCloses, 50), nifty200dma = S.sma(niftyCloses, 200);
  const vixVal = last(vixCloses), vixPrev = vixCloses.length > 1 ? vixCloses[vixCloses.length - 2] : null;
  const vixChange = vixVal != null && vixPrev != null ? vixVal - vixPrev : null;
  const bench500Close = last(benchCloses);
  const prevMacro = await env.DB.prepare("SELECT * FROM macro_state WHERE id=1").first();

  const staged = (await env.DB.prepare("SELECT * FROM scan_staging WHERE run_id=? ORDER BY symbol").bind(runId).all()).results || [];
  const stagedGood = staged.filter(r => r.indicator_json).map(r => ({ ...r, ind: safeJson(r.indicator_json, null) })).filter(r => r.ind);
  const stagedErrors = staged.filter(r => r.error).map(r => ({ symbol: r.symbol, exchange: "NSE", error: r.error }));
  dataErrors.push(...stagedErrors);

  // Holdings are always fetched fresh in the finalizer so protection is independent of opportunity scan health.
  const perHolding = [];
  for (const h of holdings) {
    const localErrors = [];
    const candles = await loadCandles(h.symbol, h.exchange, env, localErrors);
    if (!candles || candles.length < 30) {
      const err = localErrors[0]?.error || "no_data";
      // Holdings protection is safety-critical: never finalize a run with a
      // missing holding price history. Let Queue retry the whole finalizer.
      throw new Error(`holding_price_unavailable:${h.symbol}:${err}`);
    }
    const ind = computeIndicators(candles, benchCloses);
    const s = candleSeries(candles);
    const hc = S.updateHighestClose({
      storedHighestClose: h.highest_close, adjCloses: s.closes, dates: s.dates, entryDate: h.entry_date,
    });
    perHolding.push({ symbol: h.symbol, ind, hc, row: h });
  }
  const ranked = perHolding.filter(p => p.ind?.momentum_score != null)
    .sort((a, b) => b.ind.momentum_score - a.ind.momentum_score);
  const bottomCount = Math.ceil(ranked.length * 0.2);

  // Breadth uses this run's full successful staged universe + fresh holdings, never yesterday's partial D1 set.
  const breadthFlags = stagedGood.map(r => r.ind.above_200_dma)
    .concat(ranked.map(p => p.ind.above_200_dma)).filter(v => v != null);
  const breadthPct = breadthFlags.length >= 20
    ? round(breadthFlags.filter(Boolean).length / breadthFlags.length * 100, 1) : null;

  const mid = S.midcapOutperformance(midcapC ? closesOf(midcapC) : null, niftyCloses);
  const sessionDates = datesOf(niftyC);
  const fiiFresh = S.fiiFreshness(prevMacro?.fii_as_of_date, sessionDates, Date.now());
  const fresh = v => S.freshOrNull(intBool(v), fiiFresh);
  const reg = S.detectRegime({
    vix: vixVal,
    niftyAbove50dma: nifty50dma != null && niftyClose != null ? niftyClose > nifty50dma : null,
    niftyAbove200dma: nifty200dma != null && niftyClose != null ? niftyClose > nifty200dma : null,
    fiiNetBuyers5d: fresh(prevMacro?.fii_net_buyers_5d),
    fiiNetSellers3d: fresh(prevMacro?.fii_net_sellers_3d),
    midcapsOutperforming: mid.midcaps_outperforming,
    breadthPct,
    systemicStress: fresh(prevMacro?.systemic_stress),
  });
  const regime = reg.regime;

  const universeComplete = stagedErrors.length === 0;
  const evaluatedCandidates = [];
  let buyCandidates = 0;
  for (const r of stagedGood.filter(x => x.is_candidate === 1)) {
    const ind = r.ind;
    const f = S.evaluateFilters({
      mcap: r.mcap, roe: r.roe, de: r.de,
      above200: ind.above_200_dma, dist52w: ind.dist_52w_pct,
      ret6m: ind.return_6m_pct, tradedVal: ind.traded_val_cr,
      inNifty500: true, inNifty100: r.in_nifty100 === 1,
      regime, isFinancial: FINANCIAL_INDUSTRIES.has(r.sector),
      crar: r.crar, gnpa: r.gross_npa, nnpa: r.net_npa,
    });
    const actionableData = S.isActionable(ind.data_sufficiency);
    let verdict = f.verdict === "BUY_CANDIDATE" && !actionableData ? "REJECT_INSUFFICIENT_DATA" : f.verdict;
    if (!universeComplete && verdict === "BUY_CANDIDATE") verdict = "REJECT_SCAN_INCOMPLETE";
    if (verdict === "BUY_CANDIDATE") buyCandidates++;
    evaluatedCandidates.push({ row: r, ind, f, verdict });
  }

  // Full universe rank is published only when every staged symbol succeeded.
  let universeRanked = [], uniRank = new Map();
  if (universeComplete) {
    const allRows = stagedGood.map(r => ({ symbol: r.symbol, momentum_score: r.ind.momentum_score }))
      .concat(ranked.map(p => ({ symbol: p.symbol, momentum_score: p.ind.momentum_score })));
    universeRanked = S.rankUniverse(allRows);
    uniRank = new Map(universeRanked.map(r => [r.symbol, r]));
  } else {
    const old = (await env.DB.prepare(
      "SELECT symbol,universe_rank,universe_rank_pct FROM indicators WHERE symbol IN (SELECT symbol FROM holdings)"
    ).all()).results || [];
    uniRank = new Map(old.map(r => [r.symbol, r]));
  }

  const holdingState = [];
  const holdingPlans = [];
  for (let i = 0; i < ranked.length; i++) {
    const p = ranked[i], h = p.row, ind = p.ind;
    const portfolioRank = i + 1;
    const portfolioRankPct = round((portfolioRank / ranked.length) * 100, 1);
    const isBottom20 = i >= ranked.length - bottomCount;
    const u = uniRank.get(p.symbol);

    const ls = S.leaderScore({
      close: ind.ltp, dma20: ind.dma_20, dma20Prev5: ind.dma_20_prev5,
      higherHighs: ind.higher_highs, higherLows: ind.higher_lows,
      rs20: ind.rs_20d, rs60: ind.rs_60d,
      portfolioRankPct, universeRankPct: u?.universe_rank_pct,
      sectorAbove20dmaRising: null, sectorOutperform20d: null,
    });
    const highestClose = p.hc.highest_close;
    const peakGainPct = h.entry_price ? (highestClose / h.entry_price - 1) * 100 : 0;
    const det = S.leaderDeterioration({
      closesBelow20dma: ind.closes_below_20dma ?? 0, score: ls.leader_score,
      rsPercentile: u?.universe_rank_pct != null ? 100 - u.universe_rank_pct : null,
      lowerHighLowerLow: ind.higher_highs === false && ind.higher_lows === false,
      sectorNegative: null,
    });
    const deteriorationStreak = det.deterioration_count >= 2 ? (h.deterioration_streak || 0) + 1 : 0;
    const state = S.classifyLeaderState({
      score: ls.leader_score, peakGainPct, prevState: h.leader_state,
      prevStreak: h.leader_streak, portfolioRank,
      deteriorationCount: det.deterioration_count, deteriorationStreak,
    });
    const stage = S.computeGttStage({
      entryPrice: h.entry_price, highestClose, prevStage: h.gtt_stage,
      prevStop: h.gtt_min_stop, leaderState: state.leader_state, liveGttTrigger: h.gtt_trigger,
    });
    const gb = S.givebackAlert({
      entryPrice: h.entry_price, highestClose, ltp: ind.ltp, below20dma: ind.above_20_dma === false,
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
    const rotationStatus = universeComplete ? rot.rotation_status : "HOLD_SCAN_INCOMPLETE";
    const pyramidStatus = universeComplete ? py.pyramid_eligibility : "BLOCKED_SCAN_INCOMPLETE";
    const timeCheck = universeComplete ? tp.time_check : null;
    const plan = { p, h, ind, portfolioRank, isBottom20, ls, state, deteriorationStreak,
      stage, gb, py, pyramidStatus, rot, tp, rotationStatus, timeCheck, cov, fundamentalsIncomplete };
    holdingPlans.push(plan);
    holdingState.push({
      symbol: p.symbol, rank: portfolioRank, leader: state.leader_state,
      score: ls.leader_score, stage: stage?.gtt_stage, minStop: stage?.min_stop,
      giveback: gb.giveback_alert, pyramid: pyramidStatus,
      rotation: rotationStatus, timeCheck,
    });
  }

  const cfg = Object.fromEntries(((await env.DB.prepare("SELECT * FROM config").all()).results || []).map(c => [c.key, c.value]));
  let equityValue = 0;
  for (const p of perHolding) {
    if (!p.ind) equityValue += (p.row?.quantity || 0) * (p.row?.entry_price || 0);
    else equityValue += (p.row.quantity || 0) * p.ind.ltp;
  }
  const cap = S.capitalAccounting({
    equityValue,
    liquidbeesValue: parseInt(cfg.liquidbees_qty || "0") * parseFloat(cfg.liquidbees_nav || "1000"),
    cashKite: parseFloat(cfg.cash_kite || "0"), cashBank: parseFloat(cfg.cash_bank || "0"),
  });
  const liq = S.liquidityStatus(regime, cap.liquidity_pct);
  const baseline = parseFloat(cfg.baseline || "0") || cap.net_worth || 1;
  const today = new Date().toISOString().slice(0, 10);
  const prevNav = await env.DB.prepare("SELECT net_worth FROM daily_nav WHERE date < ? ORDER BY date DESC LIMIT 1").bind(today).first();
  const dayChange = prevNav?.net_worth ? cap.net_worth - prevNav.net_worth : 0;

  const summary = {
    version: VERSION, dryRun, runId, universeComplete,
    macro: {
      vix: vixVal, vixChange: round(vixChange), niftyClose, nifty50dma: round(nifty50dma),
      breadthPct, midcapTicker, midcapRs20: mid.midcap_rs_20d,
      midcapsOutperforming: mid.midcaps_outperforming, fiiFreshness: fiiFresh,
      regime, rationale: reg.rationale, failSafe: !!reg.fail_safe, missing: reg.missing_inputs,
    },
    holdings: { count: holdings.length, ranked: ranked.length, state: holdingState },
    nav: { ...cap, liquidity: liq, regime },
    scan: {
      eligibleUniverse: Number(run.eligible_universe || 0),
      queuedItems: Number(run.total_items || 0),
      successfulItems: stagedGood.length,
      failedItems: stagedErrors.length,
      candidatesEvaluated: evaluatedCandidates.length,
      buyCandidates,
      entrySizing: S.entrySizingPct(regime),
      actionable: universeComplete,
    },
    dataErrors,
  };

  if (dryRun) {
    const status = universeComplete ? "DRY_COMPLETE" : "DRY_INCOMPLETE";
    await env.DB.prepare(
      `UPDATE scan_runs SET status=?,regime=?,successful_items=?,failed_items=?,buy_candidates=?,
       summary_json=?,errors_json=?,finished_at=datetime('now'),updated_at=datetime('now'),last_error=NULL
       WHERE run_id=?`
    ).bind(status, regime, stagedGood.length, stagedErrors.length, buyCandidates,
      JSON.stringify(summary), JSON.stringify(dataErrors), runId).run();
    return;
  }

  // Production writes start only here, after all network batches and final calculations completed.
  // D1 batch() is transactional: any statement failure rolls back the entire
  // publication, so Queue retry cannot leave half-published portfolio state.
  const tx = [];
  tx.push(env.DB.prepare(
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
       regime_rationale=excluded.regime_rationale,regime_missing_inputs=excluded.regime_missing_inputs,
       regime_fail_safe=excluded.regime_fail_safe,fii_fresh=excluded.fii_fresh,
       last_session_date=excluded.last_session_date,updated_at=excluded.updated_at`
  ).bind(prevMacro?.brent_price ?? null, vixVal, round(vixChange), niftyClose, round(nifty50dma),
    round(nifty200dma), bench500Close, breadthPct, mid.midcap_rs_20d,
    mid.midcaps_outperforming == null ? null : (mid.midcaps_outperforming ? 1 : 0),
    regime, reg.rationale, JSON.stringify(reg.missing_inputs),
    reg.fail_safe ? 1 : 0, fiiFresh.fresh ? 1 : 0, fiiFresh.last_session));

  // Fresh holding indicators are price-derived state, never broker/execution state.
  for (const p of ranked) {
    const u = uniRank.get(p.symbol);
    tx.push(indicatorStatement(env.DB, p.symbol, p.ind, u?.universe_rank ?? null, u?.universe_rank_pct ?? null));
  }

  if (universeComplete) {
    for (const r of stagedGood) {
      const u = uniRank.get(r.symbol);
      tx.push(indicatorStatement(env.DB, r.symbol, r.ind, u?.universe_rank ?? null, u?.universe_rank_pct ?? null));
      if (r.is_watch === 1) {
        tx.push(env.DB.prepare("UPDATE watchlist SET momentum_score=?,updated_at=datetime('now') WHERE symbol=?")
          .bind(r.ind.momentum_score, r.symbol));
      }
    }
    for (const x of evaluatedCandidates) tx.push(opportunityStatement(env.DB, x, holdingSymbols, holdings));
  }

  for (const x of holdingPlans) {
    tx.push(holdingPlanStatement(env.DB, x));
    tx.push(...holdingAlertStatements(env.DB, x, universeComplete));
  }

  // UPSERT preserves legacy columns (including nifty_return_pct) while updating v1.1-owned fields.
  tx.push(env.DB.prepare(
    `INSERT INTO daily_nav (date,equity_value,liquidbees_value,cash_kite,cash_bank,
      net_worth,nifty_close,portfolio_return_pct,positions_count,cash_ratio_pct,
      nifty50_close,nifty500_close,vix_close,brent_close,day_change_pct,day_change_abs,
      liquidity_pct,liquidity_target_low,liquidity_target_high,liquidity_status,regime)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(date) DO UPDATE SET
      equity_value=excluded.equity_value,liquidbees_value=excluded.liquidbees_value,
      cash_kite=excluded.cash_kite,cash_bank=excluded.cash_bank,net_worth=excluded.net_worth,
      nifty_close=excluded.nifty_close,portfolio_return_pct=excluded.portfolio_return_pct,
      positions_count=excluded.positions_count,cash_ratio_pct=excluded.cash_ratio_pct,
      nifty50_close=excluded.nifty50_close,nifty500_close=excluded.nifty500_close,
      vix_close=excluded.vix_close,brent_close=excluded.brent_close,
      day_change_pct=excluded.day_change_pct,day_change_abs=excluded.day_change_abs,
      liquidity_pct=excluded.liquidity_pct,liquidity_target_low=excluded.liquidity_target_low,
      liquidity_target_high=excluded.liquidity_target_high,liquidity_status=excluded.liquidity_status,
      regime=excluded.regime`
  ).bind(today, cap.equity_value, cap.liquidbees_value, cap.cash_kite, cap.cash_bank,
    cap.net_worth, niftyClose, round((cap.net_worth / baseline - 1) * 100), holdings.length,
    cap.liquidity_pct, niftyClose, bench500Close, vixVal, prevMacro?.brent_price ?? null,
    prevNav?.net_worth ? round((dayChange / prevNav.net_worth) * 100) : 0, round(dayChange, 0),
    cap.liquidity_pct, liq.target_low, liq.target_high, liq.status, regime));

  if (universeComplete) {
    tx.push(env.DB.prepare("INSERT OR REPLACE INTO config (key,value) VALUES ('last_scan_date',?)")
      .bind(new Date().toISOString()));
    tx.push(env.DB.prepare("DELETE FROM opportunities WHERE scan_date<date('now','-14 days')"));
  }
  tx.push(env.DB.prepare("INSERT OR REPLACE INTO config (key,value) VALUES ('version',?)").bind(VERSION));

  const status = universeComplete ? "COMPLETE" : "INCOMPLETE";
  tx.push(env.DB.prepare(
    `UPDATE scan_runs SET status=?,regime=?,successful_items=?,failed_items=?,buy_candidates=?,
     summary_json=?,errors_json=?,finished_at=datetime('now'),updated_at=datetime('now'),last_error=NULL
     WHERE run_id=?`
  ).bind(status, regime, stagedGood.length, stagedErrors.length, buyCandidates,
    JSON.stringify(summary), JSON.stringify(dataErrors), runId));

  await env.DB.batch(tx);
}

async function handleQueuedScanStatus(url, env) {
  const runId = url.searchParams.get("runId");
  const run = runId
    ? await env.DB.prepare("SELECT * FROM scan_runs WHERE run_id=?").bind(runId).first()
    : await env.DB.prepare("SELECT * FROM scan_runs ORDER BY created_at DESC LIMIT 1").first();
  if (!run) return json({ version: VERSION, status: "never" });
  const progress = Number(run.total_items || 0) > 0
    ? round(Number(run.completed_items || 0) / Number(run.total_items) * 100, 1) : 0;
  return json({
    version: VERSION,
    runId: run.run_id,
    dryRun: run.dry_run === 1,
    source: run.source,
    status: run.status,
    createdAt: run.created_at,
    startedAt: run.started_at,
    finishedAt: run.finished_at,
    totalItems: run.total_items,
    completedItems: run.completed_items,
    successfulItems: run.successful_items,
    failedItems: run.failed_items,
    eligibleUniverse: run.eligible_universe,
    batchCount: run.batch_count,
    buyCandidates: run.buy_candidates,
    regime: run.regime,
    progressPct: progress,
    lastError: run.last_error,
    summary: safeJson(run.summary_json, null),
    dataErrors: safeJson(run.errors_json, []),
  });
}

function holdingPlanStatement(DB, x) {
  const { p,h,ind,portfolioRank,isBottom20,ls,state,deteriorationStreak,stage,gb,pyramidStatus,rotationStatus,timeCheck,cov,fundamentalsIncomplete } = x;
  return DB.prepare(
    `UPDATE holdings SET momentum_score=?,momentum_rank=?,is_bottom_20=?,
      highest_close=?,highest_close_date=COALESCE(?,highest_close_date),
      leader_score=?,leader_state=?,leader_streak=?,deterioration_streak=?,
      gtt_stage=?,gtt_min_stop=?,atr_pct=?,rs_20d=?,rs_60d=?,
      giveback_alert=?,pyramid_eligibility=?,rotation_status=?,time_check=?,
      coverage_alerts=?,fundamentals_status=?,last_audit=datetime('now') WHERE symbol=?`
  ).bind(ind.momentum_score, portfolioRank, isBottom20 ? 1 : 0,
    p.hc.highest_close, p.hc.highest_close_date,
    ls.leader_score, state.leader_state, state.leader_streak, deteriorationStreak,
    stage?.gtt_stage ?? h.gtt_stage, stage?.min_stop ?? null, ind.atr_pct,
    ind.rs_20d, ind.rs_60d, gb.giveback_alert,
    pyramidStatus, rotationStatus, timeCheck,
    JSON.stringify(cov.coverage_alerts),
    fundamentalsIncomplete ? "FUNDAMENTALS_DATA_INCOMPLETE" : "OK", p.symbol);
}

function holdingAlertStatements(DB, x, universeComplete) {
  const { p,stage,gb,rot,tp,timeCheck,cov,fundamentalsIncomplete } = x;
  const out = [];
  for (const a of cov.coverage_alerts) {
    out.push(alertStatement(DB, "GTT_COVERAGE", p.symbol, a === "NO_GTT" ? "CRITICAL" : "WARNING", `GTT coverage: ${a}`));
  }
  if (gb.giveback_alert) out.push(alertStatement(DB, "GIVEBACK", p.symbol, "WARNING", `Giveback review: ${(gb.giveback_reasons || []).join("; ")}`));
  if (stage?.stage_advanced) out.push(alertStatement(DB, "GTT_STAGE", p.symbol, "INFO", `GTT stage advanced to ${stage.gtt_stage} — raise stop to ${stage.min_stop} (limit ${stage.limit_price})`));
  if (universeComplete && rot.rotation_status === "ROTATION_REVIEW_ELIGIBLE") {
    out.push(alertStatement(DB, "ROTATION_REVIEW", p.symbol, "WARNING", `Rotation REVIEW: ${rot.deterioration_signals} deterioration signals — requires superior replacement + approval`));
  }
  if (timeCheck) out.push(alertStatement(DB, "TIME_REVIEW", p.symbol, "INFO", `Day ${tp?.day ?? "?"} ${timeCheck}`));
  if (fundamentalsIncomplete) out.push(alertStatement(DB, "FUNDAMENTALS_INCOMPLETE", p.symbol, "INFO",
    "FUNDAMENTALS_DATA_INCOMPLETE — existing holding: protection retained, no forced exit, pyramiding barred until a fresh Screener export revalidates it"));
  return out;
}

function opportunityStatement(DB, x, holdingSymbols, holdings) {
  const r = x.row, ind = x.ind, f = x.f;
  return DB.prepare(
    `INSERT INTO opportunities (symbol,sector,roe,de,mcap,ltp,dma_200,dist_52w_pct,return_6m_pct,
       vol_1y_pct,momentum_score,rsi_14,mfi_14,rs_20d,rs_60d,traded_val_cr,vol_threshold_cr,
       band_used_pct,credit_test,filters_passed,failed_filters,verdict,is_holding,
       sector_slot_available,data_sufficiency,scan_date,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,date('now'),datetime('now'))
     ON CONFLICT(symbol) DO UPDATE SET
       sector=excluded.sector,roe=excluded.roe,de=excluded.de,mcap=excluded.mcap,
       ltp=excluded.ltp,dma_200=excluded.dma_200,dist_52w_pct=excluded.dist_52w_pct,
       return_6m_pct=excluded.return_6m_pct,vol_1y_pct=excluded.vol_1y_pct,
       momentum_score=excluded.momentum_score,rsi_14=excluded.rsi_14,mfi_14=excluded.mfi_14,
       rs_20d=excluded.rs_20d,rs_60d=excluded.rs_60d,traded_val_cr=excluded.traded_val_cr,
       vol_threshold_cr=excluded.vol_threshold_cr,band_used_pct=excluded.band_used_pct,
       credit_test=excluded.credit_test,filters_passed=excluded.filters_passed,
       failed_filters=excluded.failed_filters,verdict=excluded.verdict,is_holding=excluded.is_holding,
       sector_slot_available=excluded.sector_slot_available,data_sufficiency=excluded.data_sufficiency,
       scan_date=excluded.scan_date,updated_at=excluded.updated_at`
  ).bind(r.symbol, r.sector, r.roe, r.de, r.mcap, ind.ltp, ind.dma_200, ind.dist_52w_pct,
    ind.return_6m_pct, ind.vol_1y_pct, ind.momentum_score, ind.rsi_14, ind.mfi_14,
    ind.rs_20d, ind.rs_60d, ind.traded_val_cr, f.vol_threshold_cr, f.band_used_pct,
    f.credit_test, f.filters_passed, JSON.stringify(f.failed_filters), x.verdict,
    holdingSymbols.has(r.symbol) ? 1 : 0,
    holdings.filter(h => h.sector === r.sector).length < 3 ? 1 : 0,
    ind.data_sufficiency);
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
  data_sufficiency=excluded.data_sufficiency,universe_rank=excluded.universe_rank,
  universe_rank_pct=excluded.universe_rank_pct,updated_at=excluded.updated_at`;

function indicatorStatement(DB, symbol, r, universeRank, universeRankPct) {
  return DB.prepare(INDICATOR_UPSERT).bind(
    symbol, r.ltp, r.dma_200, r.dma_20, r.high_52w, r.low_52w, r.dist_52w_pct,
    r.return_6m_pct, r.vol_1y_pct, r.momentum_score, r.rsi_14, r.mfi_14, r.atr_14,
    r.atr_pct, r.traded_val_cr, r.rs_20d, r.rs_60d,
    bit(r.above_200_dma), bit(r.above_20_dma), bit(r.higher_highs), bit(r.higher_lows),
    r.candles_n, r.data_sufficiency, universeRank, universeRankPct
  );
}

function alertStatement(DB, alertType, symbol, severity, message) {
  return DB.prepare(
    "INSERT INTO alerts (alert_type,symbol,severity,message,resolved,created_at) VALUES (?,?,?,?,0,datetime('now'))"
  ).bind(alertType, symbol, severity, message);
}

async function recordQueueError(env, body, error, attempts) {
  const runId = body?.runId;
  if (!runId) return;
  await env.DB.prepare(
    `UPDATE scan_runs SET status='RETRYING',last_error=?,queue_attempts=?,updated_at=datetime('now')
     WHERE run_id=? AND status NOT IN ('COMPLETE','INCOMPLETE','DRY_COMPLETE','DRY_INCOMPLETE','FAILED')`
  ).bind(String(error?.message || error), attempts || 1, runId).run();
}

async function markDlqFailure(env, body, attempts) {
  const runId = body?.runId;
  if (!runId) return;
  await env.DB.prepare(
    `UPDATE scan_runs SET status='FAILED',last_error=?,queue_attempts=?,finished_at=datetime('now'),updated_at=datetime('now')
     WHERE run_id=? AND status NOT IN ('COMPLETE','INCOMPLETE','DRY_COMPLETE','DRY_INCOMPLETE')`
  ).bind(`dead_letter:${body?.type || "unknown"}`, attempts || 0, runId).run();
}

function candleSeries(candles) {
  return { closes: closesOf(candles), dates: datesOf(candles) };
}
function closesOf(candles) { return candles.map(c => c.adjclose != null ? c.adjclose : c.close); }
function datesOf(candles) { return candles.map(c => c.date); }
function last(a) { return a?.length ? a[a.length - 1] : null; }
function bit(v) { return v == null ? null : (v ? 1 : 0); }
function intBool(v) { return v == null ? null : v === 1 || v === true; }
function safeJson(s, fallback) { try { return s == null ? fallback : JSON.parse(s); } catch { return fallback; } }
function isRetryableFetchError(error) {
  const e = String(error || "").toLowerCase();
  return e.includes("too many subrequests") || e.includes("yahoo_http_429") ||
    e.includes("yahoo_http_5") || e.includes("network") || e.includes("fetch failed") ||
    e.includes("connection") || e.includes("timeout");
}
function chunk(a, n) { const out=[]; for (let i=0;i<a.length;i+=n) out.push(a.slice(i,i+n)); return out; }
function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } });
}

export { startQueuedRefresh, processScanBatch, finalizeRun, handleQueuedScanStatus, SCAN_BATCH_SIZE };
