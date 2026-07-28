// UC-Portfolio Cloudflare Worker v2.1
// Fixes: Full Nifty 500 coverage, deterministic batching, financial sector handling, scan tracking

import DASHBOARD_HTML from './dashboard.html';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    if (path === '/' || path === '/dashboard') return new Response(DASHBOARD_HTML, {headers: {'Content-Type':'text/html;charset=utf-8'}});
    if (path === '/api/portfolio') return handlePortfolio(env);
    if (path === '/api/holdings') return handleHoldings(env);
    if (path === '/api/trades') return handleTrades(env);
    if (path === '/api/alerts') return handleAlerts(env);
    if (path === '/api/watchlist') return handleWatchlist(env);
    if (path === '/api/opportunities') return handleOpportunities(env);
    if (path === '/api/nav') return handleNav(env);
    if (path === '/api/macro') return handleMacro(env);
    if (path === '/api/scan' && request.method === 'POST') return handleScan(request, env);
    if (path === '/api/refresh') return handleRefresh(env);
    if (path === '/api/ranking') return handleRanking(env);
    if (path === '/api/scan-status') return handleScanStatus(env);
    return new Response('Not found', {status:404});
  },
  async scheduled(event, env) { await dailyCron(env); }
};

// ── API HANDLERS ──
async function handlePortfolio(env) {
  const [holdings, nav, macro, alerts, config] = await Promise.all([
    env.DB.prepare('SELECT * FROM holdings ORDER BY momentum_score DESC').all(),
    env.DB.prepare('SELECT * FROM daily_nav ORDER BY date DESC LIMIT 1').first(),
    env.DB.prepare('SELECT * FROM macro_state WHERE id=1').first(),
    env.DB.prepare('SELECT * FROM alerts WHERE resolved=0 ORDER BY severity DESC').all(),
    env.DB.prepare('SELECT * FROM config').all()
  ]);
  return json({holdings:holdings.results, nav, macro, alerts:alerts.results, config:Object.fromEntries(config.results.map(c=>[c.key,c.value]))});
}
async function handleHoldings(env) { return json((await env.DB.prepare('SELECT * FROM holdings ORDER BY momentum_score DESC').all()).results); }
async function handleTrades(env) { return json((await env.DB.prepare('SELECT * FROM trades ORDER BY id DESC LIMIT 50').all()).results); }
async function handleAlerts(env) { return json((await env.DB.prepare('SELECT * FROM alerts WHERE resolved=0 ORDER BY severity DESC').all()).results); }
async function handleWatchlist(env) { return json((await env.DB.prepare('SELECT * FROM watchlist ORDER BY momentum_score DESC').all()).results); }
async function handleOpportunities(env) { return json((await env.DB.prepare('SELECT * FROM opportunities ORDER BY momentum_score DESC LIMIT 30').all()).results); }
async function handleNav(env) { return json((await env.DB.prepare('SELECT * FROM daily_nav ORDER BY date ASC').all()).results); }
async function handleMacro(env) { return json(await env.DB.prepare('SELECT * FROM macro_state WHERE id=1').first()); }

async function handleScanStatus(env) {
  const cursor = await env.DB.prepare("SELECT value FROM config WHERE key='scan_cursor'").first();
  const lastRun = await env.DB.prepare("SELECT value FROM config WHERE key='last_scan_date'").first();
  const total = await env.DB.prepare('SELECT COUNT(*) as c FROM opportunities WHERE scan_date >= date("now","-6 days")').first();
  const candidates = await env.DB.prepare('SELECT COUNT(*) as c FROM opportunities WHERE verdict="BUY_CANDIDATE" AND scan_date >= date("now","-6 days")').first();
  return json({
    currentBatch: cursor?.value || '0', totalBatches: 5,
    lastScanDate: lastRun?.value || 'never',
    stocksScannedThisWeek: total?.c || 0, universeSize: 504,
    candidatesFound: candidates?.c || 0,
    coveragePct: Math.round(((total?.c || 0) / 504) * 100)
  });
}

async function handleRanking(env) {
  const holdings = (await env.DB.prepare('SELECT symbol, sector, momentum_score, momentum_rank, is_bottom_20, entry_price, gtt_stage FROM holdings ORDER BY momentum_score DESC').all()).results;
  const topNew = (await env.DB.prepare('SELECT symbol, sector, momentum_score, filters_passed, verdict FROM opportunities WHERE verdict="BUY_CANDIDATE" AND is_holding=0 AND sector_slot_available=1 AND scan_date >= date("now","-6 days") ORDER BY momentum_score DESC LIMIT 10').all()).results;
  const bottom = holdings.filter(h => h.is_bottom_20);
  const rotations = bottom.map(b => {
    const r = topNew.find(t => t.momentum_score > (b.momentum_score||0) + 0.5);
    return r ? {exit:b.symbol, exitScore:b.momentum_score, enter:r.symbol, enterScore:r.momentum_score, gap:round(r.momentum_score-(b.momentum_score||0))} : null;
  }).filter(Boolean);
  return json({holdings, topNew, rotations});
}

async function handleScan(request, env) {
  const body = await request.json();
  const {symbol, roe, de, mcap, regime='NORMAL', nifty500=true, nifty100=false} = body;
  const candles = await fetchYahooCandles(symbol + '.NS', 365);
  if (!candles || candles.length < 100) return json({error:'Insufficient data', symbol});
  return json(computeIndicators(candles, symbol, roe, de, mcap, regime, nifty500, nifty100));
}

async function handleRefresh(env) { return json(await dailyCron(env)); }

// ── YAHOO FINANCE ──
async function fetchYahooCandles(sym, days) {
  const now = Math.floor(Date.now()/1000), from = now - days*86400;
  try {
    const r = await fetch(`https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?period1=${from}&period2=${now}&interval=1d`, {headers:{'User-Agent':'Mozilla/5.0'}});
    const d = await r.json(), res = d?.chart?.result?.[0];
    if (!res) return null;
    const ts=res.timestamp, q=res.indicators.quote[0];
    return ts.map((t,i)=>({date:new Date(t*1000).toISOString().split('T')[0],open:q.open[i],high:q.high[i],low:q.low[i],close:q.close[i],volume:q.volume[i]})).filter(c=>c.close!=null);
  } catch(e) { return null; }
}

async function fetchYahooFundamentals(sym) {
  try {
    const r = await fetch(`https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(sym)}?modules=financialData,defaultKeyStatistics,summaryDetail`, {headers:{'User-Agent':'Mozilla/5.0'}});
    const d = await r.json(), res = d?.quoteSummary?.result?.[0];
    if (!res) return null;
    const fd = res.financialData || {}, sd = res.summaryDetail || {};
    return {
      roe: round((fd.returnOnEquity?.raw || 0) * 100),
      de: round(fd.debtToEquity?.raw ? fd.debtToEquity.raw / 100 : 0, 3),
      mcap: round((sd.marketCap?.raw || 0) / 1e7, 0),
      currentPrice: fd.currentPrice?.raw || 0
    };
  } catch(e) { return null; }
}

// ── INDICATOR ENGINE ──
function computeIndicators(candles, symbol, roe, de, mcap, regime, nifty500, nifty100) {
  const n=candles.length, closes=candles.map(c=>c.close), highs=candles.map(c=>c.high), lows=candles.map(c=>c.low), volumes=candles.map(c=>c.volume), current=closes[n-1];
  const dma200=n>=200?mean(closes.slice(-200)):null, above200=dma200?current>dma200:null;
  const dma20=n>=20?mean(closes.slice(-20)):null;
  const lookback=Math.min(252,n), high52w=Math.max(...highs.slice(-lookback)), low52w=Math.min(...lows.slice(-lookback));
  const dist52w=(current/high52w-1)*100;
  const band=regime==='NORMAL'?-15:regime==='BULL'?-10:null, within52w=band!==null?dist52w>=band:false;
  const ret6m=n>126?(current/closes[n-127]-1)*100:null;
  let vol1y=null; const vl=Math.min(252,n-1);
  if(vl>=20){const lr=[];for(let i=n-vl;i<n;i++)lr.push(Math.log(closes[i]/closes[i-1]));vol1y=std(lr)*Math.sqrt(252)*100;}
  const momScore=ret6m&&vol1y>0?(ret6m/100)/(vol1y/100):null;
  let rsi=null;
  if(n>=15){const d=[];for(let i=n-14;i<n;i++)d.push(closes[i]-closes[i-1]);const g=d.filter(x=>x>0),l=d.filter(x=>x<0).map(x=>-x);const ag=g.length?mean(g):0,al=l.length?mean(l):0;rsi=al===0?100:100-100/(1+ag/al);}
  let atr=null;
  if(n>=15){const t=[];for(let i=n-14;i<n;i++)t.push(Math.max(highs[i]-lows[i],Math.abs(highs[i]-closes[i-1]),Math.abs(lows[i]-closes[i-1])));atr=mean(t);}
  let tradedValCr=null;
  if(n>=20){const tv=[];for(let i=n-20;i<n;i++)tv.push(closes[i]*volumes[i]);tradedValCr=mean(tv)/1e7;}
  const volThreshold=nifty100?50:75, volPass=tradedValCr!==null&&tradedValCr>=volThreshold;
  const filters={'Mcap 5K-200K':mcap>=5000&&mcap<=200000,'ROE >15%':roe>15,'D/E <1':de<1,'Above 200 DMA':above200===true,'52W High band':within52w,'Positive 6M Return':ret6m!==null&&ret6m>0,'Traded Value':volPass,'Nifty 500':nifty500===true};
  const passed=Object.values(filters).filter(Boolean).length;
  const failed=Object.entries(filters).filter(([,v])=>!v).map(([k])=>k);
  return {symbol,ltp:round(current),dma_200:round(dma200),dma_20:round(dma20),high_52w:round(high52w),low_52w:round(low52w),dist_52w_pct:round(dist52w),return_6m_pct:round(ret6m),vol_1y_pct:round(vol1y),momentum_score:round(momScore,4),rsi_14:round(rsi),atr_14:round(atr),atr_pct:round(atr?atr/current*100:null),traded_val_cr:round(tradedValCr),above_200_dma:above200,filters_passed:passed,failed_filters:failed,verdict:passed===8?'BUY_CANDIDATE':'REJECT',roe,de,mcap,candles:n};
}

// ══════════════════════════════════════════════
// DAILY CRON — DETERMINISTIC FULL-UNIVERSE SCAN
// ══════════════════════════════════════════════
//
// Nifty 500 split into 5 batches of ~101 (ordered by symbol)
// Batch 0 = Mon, 1 = Tue, ... 4 = Fri (cursor cycles 0-4)
// Full universe covered every 5 trading days — deterministic, not random
//
// Budget: ~11 holdings + ~100 batch symbols × (1 fund call + ~10% candle call)
//       = ~11 + 100 + 10 candle calls ≈ 121 fetches, ~25 sec — fits Worker limits
//

const FINANCIAL_SECTORS = ['Financial Services'];

async function dailyCron(env) {
  const log = {started: new Date().toISOString(), parts: {}};

  // PART A: Rank holdings
  const holdings = (await env.DB.prepare('SELECT * FROM holdings').all()).results;
  const holdingSymbols = new Set(holdings.map(h => h.symbol));
  const holdingScores = [];

  for (const h of holdings) {
    const sym = h.symbol + (h.exchange === 'BSE' ? '.BO' : '.NS');
    const candles = await fetchYahooCandles(sym, 365);
    if (!candles || candles.length < 30) { holdingScores.push({symbol:h.symbol,score:0}); continue; }
    const n=candles.length, closes=candles.map(c=>c.close);
    const ret6m=n>126?(closes[n-1]/closes[n-127]-1)*100:0;
    const vl=Math.min(252,n-1); let vol1y=30;
    if(vl>=20){const lr=[];for(let i=n-vl;i<n;i++)lr.push(Math.log(closes[i]/closes[i-1]));vol1y=std(lr)*Math.sqrt(252)*100;}
    holdingScores.push({symbol:h.symbol, score:round(vol1y>0?(ret6m/100)/(vol1y/100):0,4)});
    const dma200=n>=200?mean(closes.slice(-200)):null, dma20=n>=20?mean(closes.slice(-20)):null;
    const high52w=Math.max(...candles.slice(-252).map(c=>c.high));
    await env.DB.prepare('INSERT OR REPLACE INTO indicators (symbol,ltp,dma_200,dma_20,high_52w,above_200_dma,above_20_dma,updated_at) VALUES(?,?,?,?,?,?,?,datetime("now"))').bind(h.symbol,closes[n-1],dma200,dma20,high52w,dma200?closes[n-1]>dma200?1:0:null,dma20?closes[n-1]>dma20?1:0:null).run();
  }

  holdingScores.sort((a,b) => b.score - a.score);
  const bottom20pct = Math.ceil(holdingScores.length * 0.2);
  for (let i = 0; i < holdingScores.length; i++) {
    await env.DB.prepare('UPDATE holdings SET momentum_score=?, momentum_rank=?, is_bottom_20=? WHERE symbol=?')
      .bind(holdingScores[i].score, i+1, i >= holdingScores.length - bottom20pct ? 1 : 0, holdingScores[i].symbol).run();
  }
  log.parts.holdingsRanked = holdingScores.length;

  // PART B: Deterministic batch scan
  const cursorRow = await env.DB.prepare("SELECT value FROM config WHERE key='scan_cursor'").first();
  const cursor = cursorRow ? parseInt(cursorRow.value) : 0;
  const batchSize = 101;
  const batchSymbols = (await env.DB.prepare(
    'SELECT symbol, industry FROM nifty500 WHERE series="EQ" ORDER BY symbol LIMIT ? OFFSET ?'
  ).bind(batchSize, cursor * batchSize).all()).results;

  let scanned=0, fundPass=0, fullPass=0;

  for (const s of batchSymbols) {
    scanned++;
    const isFinancial = FINANCIAL_SECTORS.includes(s.industry);
    const fund = await fetchYahooFundamentals(s.symbol + '.NS');
    if (!fund) continue;
    if (fund.mcap < 5000 || fund.mcap > 200000) continue;
    if (fund.roe <= 15) continue;
    if (!isFinancial && fund.de >= 1) continue;
    fundPass++;

    const candles = await fetchYahooCandles(s.symbol + '.NS', 365);
    if (!candles || candles.length < 100) continue;
    const result = computeIndicators(candles, s.symbol, fund.roe, fund.de, fund.mcap, 'NORMAL', true, false);

    // Financial sector: override D/E filter
    let adjPassed = result.filters_passed, adjFailed = [...result.failed_filters], adjVerdict = result.verdict;
    if (isFinancial && adjFailed.includes('D/E <1')) {
      adjFailed = adjFailed.filter(f => f !== 'D/E <1');
      adjPassed++;
      adjVerdict = adjPassed === 8 ? 'BUY_CANDIDATE' : 'REJECT';
    }
    if (adjPassed >= 7) fullPass++;

    const isHolding = holdingSymbols.has(s.symbol) ? 1 : 0;
    const sectorCount = holdings.filter(h => h.sector === s.industry).length;
    const worstH = holdingScores.length > 0 ? holdingScores[holdingScores.length-1] : null;
    const replaces = worstH && result.momentum_score > (worstH.score||0) + 0.5 ? worstH.symbol : null;

    await env.DB.prepare(
      'INSERT OR REPLACE INTO opportunities (symbol,sector,roe,de,mcap,ltp,dma_200,dist_52w_pct,return_6m_pct,vol_1y_pct,momentum_score,rsi_14,traded_val_cr,filters_passed,failed_filters,verdict,is_holding,sector_slot_available,rotation_replaces,scan_date,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,date("now"),datetime("now"))'
    ).bind(s.symbol,s.industry,fund.roe,fund.de,fund.mcap,result.ltp,result.dma_200,result.dist_52w_pct,result.return_6m_pct,result.vol_1y_pct,result.momentum_score,result.rsi_14,result.traded_val_cr,adjPassed,JSON.stringify(adjFailed),adjVerdict,isHolding,sectorCount<3?1:0,replaces).run();
  }

  await env.DB.prepare("INSERT OR REPLACE INTO config (key,value) VALUES ('scan_cursor',?)").bind(String((cursor+1)%5)).run();
  await env.DB.prepare("INSERT OR REPLACE INTO config (key,value) VALUES ('last_scan_date',?)").bind(new Date().toISOString()).run();
  await env.DB.prepare('DELETE FROM opportunities WHERE scan_date < date("now","-7 days")').run();
  log.parts.batch = {cursor, scanned, fundPass, fullPass};

  // PART C: Rotation alerts
  const bottomH = holdingScores.filter((_,i) => i >= holdingScores.length - bottom20pct);
  const topOpp = (await env.DB.prepare('SELECT symbol,momentum_score,sector FROM opportunities WHERE verdict="BUY_CANDIDATE" AND is_holding=0 AND sector_slot_available=1 AND scan_date>=date("now","-6 days") ORDER BY momentum_score DESC LIMIT 5').all()).results;
  for (const b of bottomH) {
    const r = topOpp.find(t => t.momentum_score > (b.score||0) + 0.5);
    if (r) {
      const exists = await env.DB.prepare('SELECT id FROM alerts WHERE symbol=? AND alert_type="ROTATION" AND resolved=0').bind(b.symbol).first();
      if (!exists) await env.DB.prepare('INSERT INTO alerts (created_at,alert_type,symbol,severity,message) VALUES(datetime("now"),"ROTATION",?,"WARNING",?)').bind(b.symbol, `Rotate ${b.symbol} (${b.score}) → ${r.symbol} (${r.momentum_score}). Gap: +${round(r.momentum_score-(b.score||0))}`).run();
    }
  }

  log.parts.rotationSignals = topOpp.length;
  log.finished = new Date().toISOString();
  return log;
}

// ── UTILS ──
function mean(a){return a.reduce((s,v)=>s+v,0)/a.length}
function std(a){const m=mean(a);return Math.sqrt(a.reduce((s,v)=>s+(v-m)**2,0)/(a.length-1))}
function round(v,d=2){return v!=null?+v.toFixed(d):null}
function json(data){return new Response(JSON.stringify(data),{headers:{'Content-Type':'application/json','Access-Control-Allow-Origin':'*'}})}
