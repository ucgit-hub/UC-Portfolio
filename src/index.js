// UC-Portfolio Worker v3.0 — Fixed data flow
// Fixes: Yahoo ticker mapping, full indicator INSERT, regime logic,
// Kite sync endpoint, cash tracking, opportunities retention

import DASHBOARD_HTML from './dashboard.html';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const cors = { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" };

    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET,POST,OPTIONS", "Access-Control-Allow-Headers": "Content-Type" } });
    }

    if (path === "/" || path === "/dashboard") return new Response(DASHBOARD_HTML, { headers: { "Content-Type": "text/html;charset=utf-8" } });

    // ── API routes ──
    if (path === "/api/dashboard-data") return handleDashboardData(env);
    if (path === "/api/portfolio") return handleDashboardData(env);
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
    if (path === "/api/refresh") return handleRefresh(env);

    // ── NEW: Kite sync endpoint — Claude pushes accurate data after each session ──
    if (path === "/api/kite-sync" && request.method === "POST") return handleKiteSync(request, env);

    return new Response("Not found", { status: 404 });
  },

  async scheduled(event, env) {
    await dailyCron(env);
  }
};

// ═══════════════════════════════════════════════════
// KITE SYNC — Claude pushes accurate broker data
// ═══════════════════════════════════════════════════
async function handleKiteSync(request, env) {
  const body = await request.json();
  const { cash_kite, holdings_ltp, regime, trades, daily_nav } = body;

  const results = { updated: [] };

  if (cash_kite != null) {
    await env.DB.prepare("INSERT OR REPLACE INTO config (key,value) VALUES ('cash_kite',?)").bind(String(Math.round(cash_kite))).run();
    results.updated.push("cash_kite=" + Math.round(cash_kite));
  }

  if (regime) {
    await env.DB.prepare("UPDATE macro_state SET regime=? WHERE id=1").bind(regime).run();
    await env.DB.prepare("INSERT OR REPLACE INTO config (key,value) VALUES ('regime',?)").bind(regime).run();
    results.updated.push("regime=" + regime);
  }

  if (holdings_ltp && typeof holdings_ltp === "object") {
    for (const [symbol, ltp] of Object.entries(holdings_ltp)) {
      await env.DB.prepare(
        "INSERT OR REPLACE INTO indicators (symbol, ltp, updated_at) VALUES (?, ?, datetime('now')) ON CONFLICT(symbol) DO UPDATE SET ltp=excluded.ltp, updated_at=excluded.updated_at"
      ).bind(symbol, ltp).run();
    }
    results.updated.push("ltp_for_" + Object.keys(holdings_ltp).length + "_stocks");
  }

  if (trades && Array.isArray(trades)) {
    for (const t of trades) {
      await env.DB.prepare(
        "INSERT INTO trades (symbol,trade_date,trade_type,quantity,price,value,pnl,pnl_pct,reason,tag,gtt_triggered) VALUES (?,?,?,?,?,?,?,?,?,?,?)"
      ).bind(t.symbol, t.trade_date, t.trade_type, t.quantity, t.price, t.value || t.quantity * t.price, t.pnl || 0, t.pnl_pct || 0, t.reason || "", t.tag || "", t.gtt_triggered || 0).run();
    }
    results.updated.push("trades_inserted=" + trades.length);
  }

  if (daily_nav) {
    const d = daily_nav;
    await env.DB.prepare(
      "INSERT OR REPLACE INTO daily_nav (date,equity_value,liquidbees_value,cash_kite,cash_bank,net_worth,nifty_close,portfolio_return_pct,positions_count,cash_ratio_pct,nifty50_close,nifty500_close,vix_close,brent_close,day_change_pct,day_change_abs) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)"
    ).bind(d.date, d.equity_value, d.liquidbees_value, d.cash_kite, d.cash_bank, d.net_worth, d.nifty_close, d.portfolio_return_pct, d.positions_count, d.cash_ratio_pct, d.nifty50_close, d.nifty500_close, d.vix_close, d.brent_close, d.day_change_pct, d.day_change_abs).run();
    results.updated.push("daily_nav=" + d.date);
  }

  return json({ ok: true, ...results });
}

async function handleDashboardData(env) {
  const [holdingsR, navR, macroR, alertsR, configR, tradesR, oppsR, nearMissR] = await Promise.all([
    env.DB.prepare("SELECT h.*, i.ltp as live_ltp, i.rsi_14 as live_rsi, i.dma_20 as live_dma20, i.dma_200 as live_dma200 FROM holdings h LEFT JOIN indicators i ON h.symbol=i.symbol ORDER BY h.momentum_score DESC").all(),
    env.DB.prepare("SELECT * FROM daily_nav ORDER BY date DESC LIMIT 60").all(),
    env.DB.prepare("SELECT * FROM macro_state WHERE id=1").first(),
    env.DB.prepare('SELECT * FROM alerts WHERE resolved=0 ORDER BY CASE severity WHEN "CRITICAL" THEN 1 WHEN "WARNING" THEN 2 ELSE 3 END, created_at DESC').all(),
    env.DB.prepare("SELECT * FROM config").all(),
    env.DB.prepare("SELECT * FROM trades ORDER BY id DESC LIMIT 100").all(),
    env.DB.prepare('SELECT * FROM opportunities WHERE verdict="BUY_CANDIDATE" AND is_holding=0 AND scan_date>=date("now","-14 days") ORDER BY momentum_score DESC LIMIT 15').all(),
    env.DB.prepare('SELECT * FROM opportunities WHERE filters_passed=7 AND scan_date>=date("now","-14 days") ORDER BY momentum_score DESC LIMIT 10').all(),
  ]);

  const config = Object.fromEntries(configR.results.map(c => [c.key, c.value]));
  const baseline = parseFloat(config.baseline || "650393");
  const holdings = holdingsR.results;
  const trades = tradesR.results;
  const navHistory = navR.results.reverse();

  const cashKite = parseFloat(config.cash_kite || "0");
  const cashBank = parseFloat(config.cash_bank || "0");
  const lbQty = parseInt(config.liquidbees_qty || "0");
  const lbNav = parseFloat(config.liquidbees_nav || "1000");
  const lbValue = lbQty * lbNav;

  let equityValue = 0;
  const ltpWarnings = [];
  holdings.forEach(h => {
    if (h.live_ltp != null && h.live_ltp > 0) equityValue += h.quantity * h.live_ltp;
    else {
      equityValue += h.quantity * h.entry_price;
      ltpWarnings.push(h.symbol);
    }
  });

  const netWorth = equityValue + lbValue + cashKite + cashBank;
  const returnPct = round((netWorth / baseline - 1) * 100);
  const absGain = round(netWorth - baseline);

  const n50base = parseFloat(config.nifty50_baseline || "22497");
  const n500base = parseFloat(config.nifty500_baseline || "20300");
  const n50now = macroR?.nifty_close || n50base;
  const n500now = macroR?.nifty500_close || n500base;
  const n50return = round((n50now / n50base - 1) * 100);
  const n500return = round((n500now / n500base - 1) * 100);
  const alphaN50 = round(returnPct - n50return);
  const alphaN500 = round(returnPct - n500return);

  const closedTrades = trades.filter(t => t.trade_type !== "BUY");
  const winners = closedTrades.filter(t => t.pnl > 0);
  const losers = closedTrades.filter(t => t.pnl < 0);
  const winRateAll = closedTrades.length > 0 ? round(winners.length / closedTrades.length * 100, 0) : 0;

  const thisMonth = new Date().toISOString().slice(0, 7);
  const monthTrades = closedTrades.filter(t => t.trade_date?.startsWith(thisMonth));
  const monthWins = monthTrades.filter(t => t.pnl > 0);
  const winRateMonth = monthTrades.length > 0 ? round(monthWins.length / monthTrades.length * 100, 0) : null;

  let bestDay = { amount: 0, pct: 0, date: "-" };
  let worstDay = { amount: 0, pct: 0, date: "-" };
  for (let i = 1; i < navHistory.length; i++) {
    if (!navHistory[i].net_worth || !navHistory[i - 1].net_worth) continue;
    const change = navHistory[i].net_worth - navHistory[i - 1].net_worth;
    const changePct = change / navHistory[i - 1].net_worth * 100;
    if (change > bestDay.amount) bestDay = { amount: round(change, 0), pct: round(changePct), date: navHistory[i].date };
    if (change < worstDay.amount) worstDay = { amount: round(change, 0), pct: round(changePct), date: navHistory[i].date };
  }

  const bestTrade = closedTrades.reduce((best, t) => t.pnl > (best?.pnl || 0) ? t : best, null);
  const worstTrade = closedTrades.reduce((worst, t) => t.pnl < (worst?.pnl || 0) ? t : worst, null);
  const avgWinner = winners.length > 0 ? round(winners.reduce((s, t) => s + t.pnl, 0) / winners.length, 0) : 0;
  const avgLoser = losers.length > 0 ? round(losers.reduce((s, t) => s + t.pnl, 0) / losers.length, 0) : 0;
  const profitFactor = losers.length > 0 ? round(Math.abs(winners.reduce((s, t) => s + t.pnl, 0) / losers.reduce((s, t) => s + t.pnl, 0))) : null;

  const sectorCounts = {};
  holdings.forEach(h => { sectorCounts[h.sector] = (sectorCounts[h.sector] || 0) + 1; });

  const bottom = holdings.filter(h => h.is_bottom_20);
  const topOpp = oppsR.results.slice(0, 5);
  const rotations = bottom.map(b => {
    const r = topOpp.find(t => t.momentum_score > (b.momentum_score || 0) + 0.5);
    return r ? { exit: b.symbol, exitScore: b.momentum_score, enter: r.symbol, enterScore: r.momentum_score, gap: round(r.momentum_score - (b.momentum_score || 0)) } : null;
  }).filter(Boolean);

  const freshPicks = oppsR.results.length > 0 ? oppsR.results : (await env.DB.prepare("SELECT * FROM watchlist ORDER BY momentum_score DESC LIMIT 10").all()).results;

  return json({
    macro: {
      regime: macroR?.regime || config.regime || "NORMAL",
      brent: macroR?.brent_price,
      vix: macroR?.vix,
      nifty: macroR?.nifty_close,
      freeze: macroR?.freeze_active === 1,
      gate: { brent: macroR?.gate_brent === 1, vix: macroR?.gate_vix === 1, nifty: macroR?.gate_nifty === 1 },
      updatedAt: macroR?.updated_at,
    },
    netWorth: round(netWorth, 0), baseline, returnPct, absGain: round(absGain, 0), alphaN50, alphaN500, n50return, n500return,
    bestDay, worstDay,
    winRate: { all: winRateAll, month: winRateMonth, wins: winners.length, losses: losers.length, monthTotal: monthTrades.length, monthWins: monthWins.length },
    deployed: { pct: round(equityValue / netWorth * 100, 0), count: holdings.length, equity: round(equityValue, 0), cash: round(lbValue + cashKite, 0) },
    holdings: holdings.map(h => {
      const ltp = (h.live_ltp != null && h.live_ltp > 0) ? h.live_ltp : h.entry_price;
      const pnl = (ltp / h.entry_price - 1) * 100;
      const val = h.quantity * ltp;
      const gttGap = h.gtt_trigger ? (ltp / h.gtt_trigger - 1) * 100 : 0;
      return {
        symbol: h.symbol, sector: h.sector, exchange: h.exchange,
        entry_price: h.entry_price, entry_date: h.entry_date,
        quantity: h.quantity, ltp: round(ltp), pnl_pct: round(pnl), value: round(val, 0),
        gtt_stage: h.gtt_stage, gtt_trigger: h.gtt_trigger, gtt_gap_pct: round(gttGap),
        momentum_score: h.momentum_score, momentum_rank: h.momentum_rank, is_bottom_20: h.is_bottom_20,
        leader_state: h.leader_state, highest_close: h.highest_close, notes: h.notes,
        ltp_stale: !h.live_ltp || h.live_ltp <= 0,
        rsi_14: h.live_rsi, dma_20: h.live_dma20, dma_200: h.live_dma200,
      };
    }),
    sectors: sectorCounts, alerts: alertsR.results, trades,
    tradeStats: {
      total: closedTrades.length, wins: winners.length, losses: losers.length, winRate: winRateAll,
      netPnl: round(closedTrades.reduce((s, t) => s + t.pnl, 0), 0),
      bestTrade: bestTrade ? { sym: bestTrade.symbol, pnl: bestTrade.pnl, pct: bestTrade.pnl_pct } : null,
      worstTrade: worstTrade ? { sym: worstTrade.symbol, pnl: worstTrade.pnl, pct: worstTrade.pnl_pct } : null,
      avgWinner, avgLoser, profitFactor,
    },
    navHistory: navHistory.map(n => ({ date: n.date, nw: n.net_worth, n50: n.nifty50_close, n500: n.nifty500_close })),
    monthlyReturns: computeMonthlyReturns(navHistory), freshPicks, nearMisses: nearMissR.results, rotations, ltpWarnings,
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

const YAHOO_TICKER_OVERRIDES = {
  "MARICO": "MARICO.NS",
  "CHOICEIN": "CHOICEIN.BO",
};

function yahooTicker(symbol, exchange) {
  if (YAHOO_TICKER_OVERRIDES[symbol]) return YAHOO_TICKER_OVERRIDES[symbol];
  return symbol + ".NS";
}

async function fetchYahooCandles(sym, days) {
  const now = Math.floor(Date.now() / 1000), from = now - days * 86400;
  try {
    const r = await fetch(`https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?period1=${from}&period2=${now}&interval=1d`, { headers: { "User-Agent": "Mozilla/5.0" } });
    const d = await r.json(), res = d?.chart?.result?.[0];
    if (!res?.timestamp) return null;
    const ts = res.timestamp, q = res.indicators.quote[0];
    return ts.map((t, i) => ({
      date: new Date(t * 1000).toISOString().split("T")[0], open: q.open[i], high: q.high[i], low: q.low[i], close: q.close[i], volume: q.volume[i]
    })).filter(c => c.close != null);
  } catch (e) { return null; }
}

async function fetchYahooCandlesForHolding(symbol, exchange, days) {
  const primary = yahooTicker(symbol, exchange);
  let candles = await fetchYahooCandles(primary, days);
  if (candles && candles.length >= 30) return candles;
  const fallback = primary.endsWith(".NS") ? symbol + ".BO" : symbol + ".NS";
  return fetchYahooCandles(fallback, days);
}

async function fetchYahooFundamentals(sym) {
  try {
    const r = await fetch(`https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(sym)}?modules=financialData,defaultKeyStatistics,summaryDetail`, { headers: { "User-Agent": "Mozilla/5.0" } });
    const d = await r.json(), res = d?.quoteSummary?.result?.[0];
    if (!res) return null;
    const fd = res.financialData || {}, sd = res.summaryDetail || {};
    return {
      roe: round((fd.returnOnEquity?.raw || 0) * 100),
      de: round(fd.debtToEquity?.raw ? fd.debtToEquity.raw / 100 : 0, 3),
      mcap: round((sd.marketCap?.raw || 0) / 1e7, 0),
      currentPrice: fd.currentPrice?.raw || 0,
    };
  } catch (e) { return null; }
}

function computeIndicators(candles, symbol, roe, de, mcap, regime, nifty500, nifty100) {
  const n = candles.length;
  const closes = candles.map(c => c.close), highs = candles.map(c => c.high), lows = candles.map(c => c.low), volumes = candles.map(c => c.volume);
  const current = closes[n - 1];
  const dma200 = n >= 200 ? mean(closes.slice(-200)) : null;
  const above200 = dma200 ? current > dma200 : null;
  const dma20 = n >= 20 ? mean(closes.slice(-20)) : null;
  const above20 = dma20 ? current > dma20 : null;
  const lookback = Math.min(252, n), high52w = Math.max(...highs.slice(-lookback)), low52w = Math.min(...lows.slice(-lookback));
  const dist52w = (current / high52w - 1) * 100;
  const band = regime === "NORMAL" ? -15 : regime === "BULL" ? -10 : null;
  const within52w = band !== null ? dist52w >= band : false;
  const ret6m = n > 126 ? (current / closes[n - 127] - 1) * 100 : null;
  let vol1y = null;
  const vl = Math.min(252, n - 1);
  if (vl >= 20) {
    const lr = [];
    for (let i = n - vl; i < n; i++) lr.push(Math.log(closes[i] / closes[i - 1]));
    vol1y = std(lr) * Math.sqrt(252) * 100;
  }
  const momScore = ret6m && vol1y > 0 ? ret6m / 100 / (vol1y / 100) : null;
  const rsi = computeRSI(closes);
  let atr = null;
  if (n >= 15) {
    const t = [];
    for (let i = n - 14; i < n; i++) t.push(Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i - 1]), Math.abs(lows[i] - closes[i - 1])));
    atr = mean(t);
  }
  let higherHighs = null;
  if (n >= 30) {
    const w1 = Math.max(...highs.slice(-30, -20)), w2 = Math.max(...highs.slice(-20, -10)), w3 = Math.max(...highs.slice(-10));
    higherHighs = w3 > w2 && w2 > w1;
  }
  let tradedValCr = null;
  if (n >= 20) {
    const tv = [];
    for (let i = n - 20; i < n; i++) tv.push(closes[i] * volumes[i]);
    tradedValCr = mean(tv) / 1e7;
  }
  const volThreshold = nifty100 ? 50 : 75;
  const filters = {
    "Mcap 5K-200K": mcap >= 5000 && mcap <= 200000,
    "ROE >15%": roe > 15,
    "D/E <1": de < 1,
    "Above 200 DMA": above200 === true,
    "52W High band": within52w,
    "Positive 6M Return": ret6m !== null && ret6m > 0,
    "Traded Value": tradedValCr !== null && tradedValCr >= volThreshold,
    "Nifty 500": nifty500 === true,
  };
  const passed = Object.values(filters).filter(Boolean).length;
  const failed = Object.entries(filters).filter(([, v]) => !v).map(([k]) => k);
  return {
    symbol, ltp: round(current), dma_200: round(dma200), dma_20: round(dma20), high_52w: round(high52w), low_52w: round(low52w),
    dist_52w_pct: round(dist52w), return_6m_pct: round(ret6m), vol_1y_pct: round(vol1y), momentum_score: round(momScore, 4),
    rsi_14: round(rsi), atr_14: round(atr), atr_pct: round(atr ? atr / current * 100 : null), traded_val_cr: round(tradedValCr),
    above_200_dma: above200, above_20_dma: above20, higher_highs: higherHighs,
    filters_passed: passed, failed_filters: failed, verdict: passed === 8 ? "BUY_CANDIDATE" : "REJECT", roe, de, mcap, candles: n,
  };
}

const FINANCIAL_SECTORS = ["Financial Services"];

async function dailyCron(env) {
  const log = { started: new Date().toISOString(), parts: {} };
  const [nifty50, nifty500, vixVal, brentVal] = await Promise.all([
    fetchYahooCandles("^NSEI", 60), fetchLastClose("^CRSLDX"), fetchLastClose("^INDIAVIX"), fetchLastClose("BZ=F"),
  ]);
  const niftyClose = nifty50 ? nifty50[nifty50.length - 1].close : null;
  const nifty50dma = nifty50 && nifty50.length >= 50 ? mean(nifty50.slice(-50).map(c => c.close)) : null;
  const freezeActive = brentVal && brentVal > 90 ? 1 : 0;
  const gateBrent = brentVal && brentVal < 90 ? 1 : 0;
  const gateVix = vixVal && vixVal < 17 ? 1 : 0;
  const gateNifty = niftyClose && niftyClose > 24300 ? 1 : 0;
  let regime = "NORMAL";
  if (vixVal && vixVal > 25) regime = "CRISIS";
  else if (vixVal && vixVal > 18) regime = "CHOPPY";

  await env.DB.prepare('INSERT OR REPLACE INTO macro_state (id,brent_price,vix,nifty_close,nifty_50dma,regime,freeze_active,gate_brent,gate_vix,gate_nifty,updated_at,nifty500_close) VALUES(1,?,?,?,?,?,?,?,?,?,datetime("now"),?)')
    .bind(brentVal, vixVal, niftyClose, nifty50dma, regime, freezeActive, gateBrent, gateVix, gateNifty, nifty500).run();

  log.parts.macro = { nifty: niftyClose, nifty50dma, nifty500, vix: vixVal, brent: brentVal, regime };
  const holdings = (await env.DB.prepare("SELECT * FROM holdings").all()).results;
  const holdingSymbols = new Set(holdings.map(h => h.symbol));
  const holdingScores = [];

  for (const h of holdings) {
    const candles = await fetchYahooCandlesForHolding(h.symbol, h.exchange, 365);
    if (!candles || candles.length < 30) {
      holdingScores.push({ symbol: h.symbol, score: 0, ltp: 0, error: "no_data" });
      continue;
    }
    const n = candles.length, closes = candles.map(c => c.close), highs = candles.map(c => c.high), lows = candles.map(c => c.low), volumes = candles.map(c => c.volume), current = closes[n - 1];
    const ret6m = n > 126 ? (current / closes[n - 127] - 1) * 100 : 0;
    const vl = Math.min(252, n - 1);
    let vol1y = 30;
    if (vl >= 20) {
      const lr = [];
      for (let i = n - vl; i < n; i++) lr.push(Math.log(closes[i] / closes[i - 1]));
      vol1y = std(lr) * Math.sqrt(252) * 100;
    }
    const momScore = round(vol1y > 0 ? ret6m / 100 / (vol1y / 100) : 0, 4);
    holdingScores.push({ symbol: h.symbol, score: momScore, ltp: current });
    const dma200 = n >= 200 ? mean(closes.slice(-200)) : null, dma20 = n >= 20 ? mean(closes.slice(-20)) : null;
    const lookback = Math.min(252, n), high52w = Math.max(...highs.slice(-lookback)), low52w = Math.min(...lows.slice(-lookback));
    const dist52w = round((current / high52w - 1) * 100), rsi14 = computeRSI(closes);
    let atr14 = null;
    if (n >= 15) {
      const t = [];
      for (let i = n - 14; i < n; i++) t.push(Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i - 1]), Math.abs(lows[i] - closes[i - 1])));
      atr14 = mean(t);
    }
    let tradedValCr = null;
    if (n >= 20) {
      const tv = [];
      for (let i = n - 20; i < n; i++) tv.push(closes[i] * volumes[i]);
      tradedValCr = round(mean(tv) / 1e7);
    }
    await env.DB.prepare('INSERT OR REPLACE INTO indicators (symbol, ltp, dma_200, dma_20, high_52w, low_52w, dist_52w_pct, return_6m_pct, vol_1y_pct, momentum_score, rsi_14, atr_14, atr_pct, traded_val_cr, above_200_dma, above_20_dma, higher_highs, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,datetime("now"))')
      .bind(h.symbol, current, round(dma200), round(dma20), round(high52w), round(low52w), dist52w, round(ret6m), round(vol1y), momScore, round(rsi14), round(atr14), round(atr14 ? atr14 / current * 100 : null), tradedValCr, dma200 ? (current > dma200 ? 1 : 0) : null, dma20 ? (current > dma20 ? 1 : 0) : null, null).run();
  }

  holdingScores.sort((a, b) => b.score - a.score);
  const bottom20pct = Math.ceil(holdingScores.length * 0.2);
  for (let i = 0; i < holdingScores.length; i++) {
    await env.DB.prepare("UPDATE holdings SET momentum_score=?, momentum_rank=?, is_bottom_20=? WHERE symbol=?")
      .bind(holdingScores[i].score, i + 1, i >= holdingScores.length - bottom20pct ? 1 : 0, holdingScores[i].symbol).run();
  }
  log.parts.holdingsRanked = holdingScores.length;

  // === WATCHLIST INDICATOR PROCESSING (v3.1) ===
  const watchlistStocks = (await env.DB.prepare(
    "SELECT w.symbol, w.sector FROM watchlist w WHERE w.symbol NOT IN (SELECT symbol FROM holdings)"
  ).all()).results;
  let wlProcessed = 0;
  for (const w of watchlistStocks) {
    try {
      const candles = await fetchYahooCandlesForHolding(w.symbol, "NSE", 365);
      if (!candles || candles.length < 30) continue;
      const n2 = candles.length, cl2 = candles.map(c => c.close), hi2 = candles.map(c => c.high), lo2 = candles.map(c => c.low), vo2 = candles.map(c => c.volume), cur2 = cl2[n2 - 1];
      const r6m2 = n2 > 126 ? (cur2 / cl2[n2 - 127] - 1) * 100 : 0;
      const vl2 = Math.min(252, n2 - 1);
      let vy2 = 30;
      if (vl2 >= 20) { const lr2 = []; for (let i2 = n2 - vl2; i2 < n2; i2++) lr2.push(Math.log(cl2[i2] / cl2[i2 - 1])); vy2 = std(lr2) * Math.sqrt(252) * 100; }
      const ms2 = round(vy2 > 0 ? (r6m2 / 100) / (vy2 / 100) : 0, 4);
      const d200_2 = n2 >= 200 ? mean(cl2.slice(-200)) : null, d20_2 = n2 >= 20 ? mean(cl2.slice(-20)) : null;
      const lb2 = Math.min(252, n2), h52_2 = Math.max(...hi2.slice(-lb2)), l52_2 = Math.min(...lo2.slice(-lb2));
      const ds2 = round((cur2 / h52_2 - 1) * 100), rsi2 = computeRSI(cl2);
      let atr2 = null;
      if (n2 >= 15) { const t2 = []; for (let i2 = n2 - 14; i2 < n2; i2++) t2.push(Math.max(hi2[i2] - lo2[i2], Math.abs(hi2[i2] - cl2[i2 - 1]), Math.abs(lo2[i2] - cl2[i2 - 1]))); atr2 = mean(t2); }
      let tv2 = null;
      if (n2 >= 20) { const tvs = []; for (let i2 = n2 - 20; i2 < n2; i2++) tvs.push(cl2[i2] * vo2[i2]); tv2 = round(mean(tvs) / 1e7); }
      await env.DB.prepare('INSERT OR REPLACE INTO indicators (symbol, ltp, dma_200, dma_20, high_52w, low_52w, dist_52w_pct, return_6m_pct, vol_1y_pct, momentum_score, rsi_14, atr_14, atr_pct, traded_val_cr, above_200_dma, above_20_dma, higher_highs, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,datetime("now"))').bind(w.symbol, cur2, round(d200_2), round(d20_2), round(h52_2), round(l52_2), ds2, round(r6m2), round(vy2), ms2, round(rsi2), round(atr2), round(atr2 ? atr2 / cur2 * 100 : null), tv2, d200_2 ? (cur2 > d200_2 ? 1 : 0) : null, d20_2 ? (cur2 > d20_2 ? 1 : 0) : null, null).run();
      await env.DB.prepare("UPDATE watchlist SET momentum_score=? WHERE symbol=?").bind(ms2, w.symbol).run();
      wlProcessed++;
    } catch (e3) { /* skip failed watchlist stock */ }
  }
  log.parts.watchlistProcessed = wlProcessed;
  // === END WATCHLIST PROCESSING ===

  const config = Object.fromEntries((await env.DB.prepare("SELECT * FROM config").all()).results.map(c => [c.key, c.value]));
  const cashKite = parseFloat(config.cash_kite || "0"), cashBank = parseFloat(config.cash_bank || "0"), lbQty = parseInt(config.liquidbees_qty || "0"), lbNav = parseFloat(config.liquidbees_nav || "1000");
  let equityValue = 0;
  holdingScores.forEach(h => { equityValue += (holdings.find(x => x.symbol === h.symbol)?.quantity || 0) * h.ltp; });
  const netWorth = equityValue + lbQty * lbNav + cashKite + cashBank;
  const today = new Date().toISOString().split("T")[0];
  const prevNav = await env.DB.prepare("SELECT net_worth FROM daily_nav WHERE date < ? ORDER BY date DESC LIMIT 1").bind(today).first();
  const dayChange = prevNav?.net_worth ? netWorth - prevNav.net_worth : 0;
  const dayChangePct = prevNav?.net_worth ? dayChange / prevNav.net_worth * 100 : 0;
  const baseline = parseFloat(config.baseline || "650393");
  const portfolioReturnPct = (netWorth / baseline - 1) * 100;

  await env.DB.prepare("INSERT OR REPLACE INTO daily_nav (date,equity_value,liquidbees_value,cash_kite,cash_bank,net_worth,nifty_close,portfolio_return_pct,positions_count,cash_ratio_pct,nifty50_close,nifty500_close,vix_close,brent_close,day_change_pct,day_change_abs) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .bind(today, round(equityValue, 0), round(lbQty * lbNav, 0), cashKite, cashBank, round(netWorth, 0), niftyClose, round(portfolioReturnPct), holdings.length, round((lbQty * lbNav + cashKite) / netWorth * 100), niftyClose, nifty500, vixVal, brentVal, round(dayChangePct), round(dayChange, 0)).run();

  log.parts.nav = { netWorth: round(netWorth, 0), dayChange: round(dayChange, 0), returnPct: round(portfolioReturnPct) };
  const cursorRow = await env.DB.prepare("SELECT value FROM config WHERE key='scan_cursor'").first();
  const cursor = cursorRow ? parseInt(cursorRow.value) : 0;
  const batchSize = 101;
  const batchSymbols = (await env.DB.prepare('SELECT symbol,industry FROM nifty500 WHERE series="EQ" ORDER BY symbol LIMIT ? OFFSET ?').bind(batchSize, cursor * batchSize).all()).results;
  let scanned = 0, fundPass = 0, fullPass = 0;
  for (const s of batchSymbols) {
    scanned++;
    const isFinancial = FINANCIAL_SECTORS.includes(s.industry);
    const fund = await fetchYahooFundamentals(s.symbol + ".NS");
    if (!fund) continue;
    if (fund.mcap < 5000 || fund.mcap > 200000 || fund.roe <= 15) continue;
    if (!isFinancial && fund.de >= 1) continue;
    fundPass++;
    const candles = await fetchYahooCandles(s.symbol + ".NS", 365);
    if (!candles || candles.length < 100) continue;
    const result = computeIndicators(candles, s.symbol, fund.roe, fund.de, fund.mcap, regime, true, false);
    let adjPassed = result.filters_passed, adjFailed = [...result.failed_filters], adjVerdict = result.verdict;
    if (isFinancial && adjFailed.includes("D/E <1")) {
      adjFailed = adjFailed.filter(f => f !== "D/E <1");
      adjPassed++;
      adjVerdict = adjPassed === 8 ? "BUY_CANDIDATE" : "REJECT";
    }
    if (adjPassed >= 7) fullPass++;
    const isHolding = holdingSymbols.has(s.symbol) ? 1 : 0;
    const sectorCount = holdings.filter(h => h.sector === s.industry).length;
    const worstH = holdingScores.length > 0 ? holdingScores[holdingScores.length - 1] : null;
    const replaces = worstH && result.momentum_score > (worstH.score || 0) + 0.5 ? worstH.symbol : null;
    await env.DB.prepare('INSERT OR REPLACE INTO opportunities (symbol,sector,roe,de,mcap,ltp,dma_200,dist_52w_pct,return_6m_pct,vol_1y_pct,momentum_score,rsi_14,traded_val_cr,filters_passed,failed_filters,verdict,is_holding,sector_slot_available,rotation_replaces,scan_date,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,date("now"),datetime("now"))')
      .bind(s.symbol, s.industry, fund.roe, fund.de, fund.mcap, result.ltp, result.dma_200, result.dist_52w_pct, result.return_6m_pct, result.vol_1y_pct, result.momentum_score, result.rsi_14, result.traded_val_cr, adjPassed, JSON.stringify(adjFailed), adjVerdict, isHolding, sectorCount < 3 ? 1 : 0, replaces).run();
  }
  await env.DB.prepare("INSERT OR REPLACE INTO config (key,value) VALUES ('scan_cursor',?)").bind(String((cursor + 1) % 5)).run();
  await env.DB.prepare("INSERT OR REPLACE INTO config (key,value) VALUES ('last_scan_date',?)").bind(new Date().toISOString()).run();
  await env.DB.prepare('DELETE FROM opportunities WHERE scan_date<date("now","-14 days")').run();
  log.parts.scan = { batch: cursor, scanned, fundPass, fullPass };
  try { await sendEveningEmail(env, log, holdingScores, holdings, netWorth, portfolioReturnPct, vixVal, brentVal, niftyClose, regime); }
  catch (e) { log.parts.email = { error: e.message }; }
  log.finished = new Date().toISOString();
  return log;
}

async function fetchLastClose(sym) {
  const candles = await fetchYahooCandles(sym, 5);
  return candles && candles.length > 0 ? candles[candles.length - 1].close : null;
}

function computeRSI(closes) {
  const n = closes.length;
  if (n < 15) return null;
  const d = [];
  for (let i = n - 14; i < n; i++) d.push(closes[i] - closes[i - 1]);
  const g = d.filter(x => x > 0), l = d.filter(x => x < 0).map(x => -x);
  const ag = g.length ? mean(g) : 0, al = l.length ? mean(l) : 0;
  return al === 0 ? 100 : round(100 - 100 / (1 + ag / al));
}

async function handleRanking(env) {
  const holdings = (await env.DB.prepare("SELECT symbol,sector,momentum_score,momentum_rank,is_bottom_20,entry_price,gtt_stage FROM holdings ORDER BY momentum_score DESC").all()).results;
  const topNew = (await env.DB.prepare('SELECT symbol,sector,momentum_score,filters_passed,verdict FROM opportunities WHERE verdict="BUY_CANDIDATE" AND is_holding=0 AND sector_slot_available=1 AND scan_date>=date("now","-14 days") ORDER BY momentum_score DESC LIMIT 10').all()).results;
  return json({ holdings, topNew });
}

async function handleScanStatus(env) {
  const cursor = await env.DB.prepare("SELECT value FROM config WHERE key='scan_cursor'").first();
  const lastRun = await env.DB.prepare("SELECT value FROM config WHERE key='last_scan_date'").first();
  const total = await env.DB.prepare('SELECT COUNT(*) as c FROM opportunities WHERE scan_date>=date("now","-14 days")').first();
  const candidates = await env.DB.prepare('SELECT COUNT(*) as c FROM opportunities WHERE verdict="BUY_CANDIDATE" AND scan_date>=date("now","-14 days")').first();
  return json({ currentBatch: cursor?.value || "0", totalBatches: 5, lastScanDate: lastRun?.value || "never", stocksScanned: total?.c || 0, universeSize: 504, candidatesFound: candidates?.c || 0, coveragePct: Math.round((total?.c || 0) / 504 * 100) });
}

async function handleScan(request, env) {
  const body = await request.json();
  const { symbol, roe, de, mcap, regime = "NORMAL", nifty500 = true, nifty100 = false } = body;
  const candles = await fetchYahooCandlesForHolding(symbol, "NSE", 365);
  if (!candles || candles.length < 100) return json({ error: "Insufficient data", symbol });
  return json(computeIndicators(candles, symbol, roe, de, mcap, regime, nifty500, nifty100));
}

async function handleRefresh(env) { return json(await dailyCron(env)); }

async function sendEveningEmail(env, log, holdingScores, holdings, netWorth, returnPct, vix, brent, nifty, regime) {
  const resendKey = (await env.DB.prepare("SELECT value FROM config WHERE key='resend_key'").first())?.value;
  if (!resendKey) { log.parts.email = { skipped: "no resend_key" }; return; }
  const emailTo = (await env.DB.prepare("SELECT value FROM config WHERE key='resend_email'").first())?.value || "choudhary.umang05@gmail.com";
  const today = new Date().toISOString().split("T")[0];
  const baseline = 650393;
  const gain = netWorth - baseline;
  const ranked = holdingScores.map((h, i) => {
    const holding = holdings.find(x => x.symbol === h.symbol);
    const entry = holding?.entry_price || 0;
    const pnl = entry > 0 ? ((h.ltp / entry - 1) * 100).toFixed(1) : "0.0";
    const flag = i >= holdingScores.length - Math.ceil(holdingScores.length * 0.2) ? "🔴" : "🟢";
    return `${flag} ${i + 1}. ${h.symbol.padEnd(12)} ${pnl > 0 ? "+" : ""}${pnl}%  Mom ${h.score}`;
  }).join("\n");
  const alerts = (await env.DB.prepare("SELECT * FROM alerts WHERE resolved=0 ORDER BY severity DESC LIMIT 5").all()).results;
  const alertText = alerts.map(a => `⚠️ ${a.symbol}: ${a.message}`).join("\n") || "No active alerts.";
  const picks = (await env.DB.prepare('SELECT symbol,momentum_score FROM opportunities WHERE verdict="BUY_CANDIDATE" AND is_holding=0 AND scan_date>=date("now","-2 days") ORDER BY momentum_score DESC LIMIT 5').all()).results;
  const picksText = picks.map(p => `${p.symbol} (${p.momentum_score})`).join(" | ") || "None today.";
  const body = `UC-Portfolio Daily — ${today}\n\nPortfolio: ₹${(netWorth / 1e5).toFixed(2)}L (${returnPct >= 0 ? "+" : ""}${returnPct.toFixed(1)}%) | Gain: ₹${gain >= 0 ? "+" : ""}${(gain / 1e3).toFixed(1)}K\nMacro: VIX ${vix || "-"} | Brent $${brent || "-"} | Nifty ${nifty || "-"} | Regime: ${regime}\n\n${ranked}\n\nAlerts:\n${alertText}\n\nFresh Picks: ${picksText}\nScan: Batch ${log.parts?.scan?.batch || "-"}/5 | ${log.parts?.scan?.fundPass || 0} fund pass | ${log.parts?.scan?.fullPass || 0} full pass`;
  await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${resendKey}` },
    body: JSON.stringify({ from: "UC-Portfolio <onboarding@resend.dev>", to: [emailTo], subject: `[UC-Portfolio] ${today} | ${returnPct >= 0 ? "+" : ""}${returnPct.toFixed(1)}% | ${holdings.length} pos`, text: body }),
  });
  log.parts.email = { sent: true };
}

function mean(a) { return a.reduce((s, v) => s + v, 0) / a.length; }
function std(a) { const m = mean(a); return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / (a.length - 1)); }
function round(v, d = 2) { return v != null ? +v.toFixed(d) : null; }
function json(data) { return new Response(JSON.stringify(data), { headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } }); }
