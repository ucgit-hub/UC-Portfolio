// UC-Portfolio Cloudflare Worker
// Serves dashboard + API endpoints + daily cron refresh

import DASHBOARD_HTML from './dashboard.html';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    // Dashboard
    if (path === '/' || path === '/dashboard') {
      return new Response(DASHBOARD_HTML, {
        headers: { 'Content-Type': 'text/html;charset=utf-8' }
      });
    }

    // API routes
    if (path === '/api/portfolio') return handlePortfolio(env);
    if (path === '/api/holdings') return handleHoldings(env);
    if (path === '/api/trades') return handleTrades(env);
    if (path === '/api/alerts') return handleAlerts(env);
    if (path === '/api/watchlist') return handleWatchlist(env);
    if (path === '/api/nav') return handleNav(env);
    if (path === '/api/macro') return handleMacro(env);
    if (path === '/api/scan' && request.method === 'POST') return handleScan(request, env);
    if (path === '/api/refresh') return handleRefresh(env);

    return new Response('Not found', { status: 404 });
  },

  // Daily cron: refresh candle data + compute indicators
  async scheduled(event, env) {
    await refreshAllData(env);
  }
};

// ── API HANDLERS ──

async function handlePortfolio(env) {
  const holdings = await env.DB.prepare('SELECT * FROM holdings').all();
  const nav = await env.DB.prepare('SELECT * FROM daily_nav ORDER BY date DESC LIMIT 1').first();
  const macro = await env.DB.prepare('SELECT * FROM macro_state WHERE id=1').first();
  const alerts = await env.DB.prepare('SELECT * FROM alerts WHERE resolved=0 ORDER BY severity DESC').all();
  const config = await env.DB.prepare('SELECT * FROM config').all();

  return json({
    holdings: holdings.results,
    nav,
    macro,
    alerts: alerts.results,
    config: Object.fromEntries(config.results.map(c => [c.key, c.value]))
  });
}

async function handleHoldings(env) {
  const r = await env.DB.prepare('SELECT * FROM holdings ORDER BY (ltp/entry_price-1) DESC').all();
  return json(r.results);
}

async function handleTrades(env) {
  const r = await env.DB.prepare('SELECT * FROM trades ORDER BY id DESC LIMIT 50').all();
  return json(r.results);
}

async function handleAlerts(env) {
  const r = await env.DB.prepare('SELECT * FROM alerts WHERE resolved=0 ORDER BY severity DESC, created_at DESC').all();
  return json(r.results);
}

async function handleWatchlist(env) {
  const r = await env.DB.prepare('SELECT * FROM watchlist ORDER BY momentum_score DESC').all();
  return json(r.results);
}

async function handleNav(env) {
  const r = await env.DB.prepare('SELECT * FROM daily_nav ORDER BY date ASC').all();
  return json(r.results);
}

async function handleMacro(env) {
  const r = await env.DB.prepare('SELECT * FROM macro_state WHERE id=1').first();
  return json(r);
}

async function handleScan(request, env) {
  const body = await request.json();
  const { symbol, roe, de, mcap, regime = 'NORMAL', nifty500 = true } = body;

  // Fetch candles from Yahoo Finance
  const candles = await fetchYahooCandles(symbol + '.NS', 365);
  if (!candles || candles.length < 100) {
    return json({ error: 'Insufficient candle data', symbol });
  }

  // Compute indicators
  const result = computeIndicators(candles, symbol, roe, de, mcap, regime, nifty500);
  return json(result);
}

async function handleRefresh(env) {
  const result = await refreshAllData(env);
  return json(result);
}

// ── YAHOO FINANCE FETCHER ──

async function fetchYahooCandles(yahooSymbol, days) {
  const now = Math.floor(Date.now() / 1000);
  const from = now - days * 86400;
  const url = `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol)}?period1=${from}&period2=${now}&interval=1d`;

  try {
    const resp = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });
    const data = await resp.json();
    const result = data?.chart?.result?.[0];
    if (!result) return null;

    const ts = result.timestamp;
    const q = result.indicators.quote[0];
    return ts.map((t, i) => ({
      date: new Date(t * 1000).toISOString().split('T')[0],
      open: q.open[i], high: q.high[i], low: q.low[i],
      close: q.close[i], volume: q.volume[i]
    })).filter(c => c.close != null);
  } catch (e) {
    console.error('Yahoo fetch error:', e);
    return null;
  }
}

// ── INDICATOR ENGINE (JavaScript port of Python scanner) ──

function computeIndicators(candles, symbol, roe, de, mcap, regime, nifty500) {
  const n = candles.length;
  const closes = candles.map(c => c.close);
  const highs = candles.map(c => c.high);
  const lows = candles.map(c => c.low);
  const volumes = candles.map(c => c.volume);
  const current = closes[n - 1];

  // 200 DMA
  const dma200 = n >= 200 ? mean(closes.slice(-200)) : null;
  const above200 = dma200 ? current > dma200 : null;

  // 20 DMA
  const dma20 = n >= 20 ? mean(closes.slice(-20)) : null;

  // 52W High/Low
  const lookback = Math.min(252, n);
  const high52w = Math.max(...highs.slice(-lookback));
  const low52w = Math.min(...lows.slice(-lookback));
  const dist52w = (current / high52w - 1) * 100;

  // 52W band check
  const band = regime === 'NORMAL' ? -15 : regime === 'BULL' ? -10 : null;
  const within52w = band !== null ? dist52w >= band : false;

  // 6M return
  const ret6m = n > 126 ? (current / closes[n - 127] - 1) * 100 : null;

  // 1Y vol
  let vol1y = null;
  const volLookback = Math.min(252, n - 1);
  if (volLookback >= 20) {
    const logRets = [];
    for (let i = n - volLookback; i < n; i++) {
      logRets.push(Math.log(closes[i] / closes[i - 1]));
    }
    vol1y = std(logRets) * Math.sqrt(252) * 100;
  }

  // Momentum score
  const momScore = ret6m && vol1y > 0 ? (ret6m / 100) / (vol1y / 100) : null;

  // RSI 14
  let rsi = null;
  if (n >= 15) {
    const deltas = [];
    for (let i = n - 14; i < n; i++) deltas.push(closes[i] - closes[i - 1]);
    const gains = deltas.filter(d => d > 0);
    const losses = deltas.filter(d => d < 0).map(d => -d);
    const avgGain = gains.length ? mean(gains) : 0;
    const avgLoss = losses.length ? mean(losses) : 0;
    rsi = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }

  // ATR 14
  let atr = null;
  if (n >= 15) {
    const trs = [];
    for (let i = n - 14; i < n; i++) {
      trs.push(Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i - 1]), Math.abs(lows[i] - closes[i - 1])));
    }
    atr = mean(trs);
  }

  // Traded value (20-day avg in Cr)
  let tradedValCr = null;
  if (n >= 20) {
    const tvs = [];
    for (let i = n - 20; i < n; i++) tvs.push(closes[i] * volumes[i]);
    tradedValCr = mean(tvs) / 1e7;
  }

  // Volume threshold
  const volThreshold = 75; // default non-Nifty100
  const volPass = tradedValCr !== null && tradedValCr >= volThreshold;

  // 8-filter check
  const filters = {
    'Mcap 5K-200K': mcap >= 5000 && mcap <= 200000,
    'ROE >15%': roe > 15,
    'D/E <1': de < 1,
    'Above 200 DMA': above200 === true,
    '52W High band': within52w,
    'Positive 6M Return': ret6m !== null && ret6m > 0,
    'Traded Value': volPass,
    'Nifty 500': nifty500 === true,
  };

  const passed = Object.values(filters).filter(Boolean).length;
  const failed = Object.entries(filters).filter(([, v]) => !v).map(([k]) => k);

  return {
    symbol, ltp: round(current), dma_200: round(dma200), dma_20: round(dma20),
    high_52w: round(high52w), low_52w: round(low52w), dist_52w_pct: round(dist52w),
    return_6m_pct: round(ret6m), vol_1y_pct: round(vol1y), momentum_score: round(momScore, 4),
    rsi_14: round(rsi), atr_14: round(atr), atr_pct: round(atr ? atr / current * 100 : null),
    traded_val_cr: round(tradedValCr), above_200_dma: above200,
    filters_passed: passed, failed_filters: failed,
    verdict: passed === 8 ? 'BUY_CANDIDATE' : 'REJECT',
    roe, de, mcap, candles: n
  };
}

// ── DAILY REFRESH (cron trigger) ──

async function refreshAllData(env) {
  const holdings = await env.DB.prepare('SELECT symbol, exchange FROM holdings').all();
  const results = [];

  for (const h of holdings.results) {
    const yahooSym = h.symbol + (h.exchange === 'BSE' ? '.BO' : '.NS');
    const candles = await fetchYahooCandles(yahooSym, 365);
    if (!candles || candles.length < 20) {
      results.push({ symbol: h.symbol, error: 'No data' });
      continue;
    }

    const n = candles.length;
    const closes = candles.map(c => c.close);
    const current = closes[n - 1];
    const dma200 = n >= 200 ? mean(closes.slice(-200)) : null;
    const dma20 = n >= 20 ? mean(closes.slice(-20)) : null;
    const high52w = Math.max(...candles.slice(-252).map(c => c.high));

    // Update indicators table
    await env.DB.prepare(`
      INSERT OR REPLACE INTO indicators (symbol, ltp, dma_200, dma_20, high_52w, above_200_dma, above_20_dma, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `).bind(h.symbol, current, dma200, dma20, high52w, dma200 ? (current > dma200 ? 1 : 0) : null, dma20 ? (current > dma20 ? 1 : 0) : null).run();

    // Cache latest candles
    for (const c of candles.slice(-5)) {
      await env.DB.prepare(`
        INSERT OR REPLACE INTO candle_cache (symbol, date, open, high, low, close, volume)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).bind(h.symbol, c.date, c.open, c.high, c.low, c.close, c.volume).run();
    }

    results.push({ symbol: h.symbol, ltp: current, dma200, status: 'ok' });
  }

  return { refreshed: results.length, results };
}

// ── UTILS ──
function mean(arr) { return arr.reduce((s, v) => s + v, 0) / arr.length; }
function std(arr) {
  const m = mean(arr);
  return Math.sqrt(arr.reduce((s, v) => s + (v - m) ** 2, 0) / (arr.length - 1));
}
function round(v, d = 2) { return v != null ? +v.toFixed(d) : null; }
function json(data) {
  return new Response(JSON.stringify(data), {
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
  });
}
