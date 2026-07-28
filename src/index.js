// UC-Portfolio Cloudflare Worker v2
// Serves dashboard + APIs + daily Nifty 500 scan

import DASHBOARD_HTML from './dashboard.html';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === '/' || path === '/dashboard') {
      return new Response(DASHBOARD_HTML, { headers: { 'Content-Type': 'text/html;charset=utf-8' } });
    }

    if (path === '/api/portfolio') return handlePortfolio(env);
    if (path === '/api/holdings') return handleHoldings(env);
    if (path === '/api/trades') return handleTrades(env);
    if (path === '/api/alerts') return handleAlerts(env);
    if (path === '/api/watchlist') return handleWatchlist(env);
    if (path === '/api/opportunities') return handleOpportunities(env);
    if (path === '/api/nav') return handleNav(env);
    if (path === '/api/macro') return handleMacro(env);
    if (path === '/api/rotation') return handleRotation(env);
    if (path === '/api/scan' && request.method === 'POST') return handleScan(request, env);
    if (path === '/api/refresh') return handleRefresh(env);

    return new Response('Not found', { status: 404 });
  },

  async scheduled(event, env) {
    await refreshAllData(env);
  }
};

async function handlePortfolio(env) {
  const [holdings, nav, macro, alerts, config] = await Promise.all([
    env.DB.prepare('SELECT * FROM holdings ORDER BY momentum_score DESC').all(),
    env.DB.prepare('SELECT * FROM daily_nav ORDER BY date DESC LIMIT 1').first(),
    env.DB.prepare('SELECT * FROM macro_state WHERE id=1').first(),
    env.DB.prepare('SELECT * FROM alerts WHERE resolved=0 ORDER BY severity DESC').all(),
    env.DB.prepare('SELECT * FROM config').all()
  ]);
  return json({ holdings: holdings.results, nav, macro, alerts: alerts.results, config: Object.fromEntries(config.results.map(c => [c.key, c.value])) });
}

async function handleHoldings(env) { return json((await env.DB.prepare('SELECT * FROM holdings ORDER BY momentum_score DESC').all()).results); }
async function handleTrades(env) { return json((await env.DB.prepare('SELECT * FROM trades ORDER BY id DESC LIMIT 50').all()).results); }
async function handleAlerts(env) { return json((await env.DB.prepare('SELECT * FROM alerts WHERE resolved=0 ORDER BY severity DESC').all()).results); }
async function handleWatchlist(env) { return json((await env.DB.prepare('SELECT * FROM watchlist ORDER BY momentum_score DESC').all()).results); }
async function handleOpportunities(env) { return json((await env.DB.prepare('SELECT * FROM opportunities ORDER BY momentum_score DESC LIMIT 25').all()).results); }
async function handleNav(env) { return json((await env.DB.prepare('SELECT * FROM daily_nav ORDER BY date ASC').all()).results); }
async function handleMacro(env) { return json(await env.DB.prepare('SELECT * FROM macro_state WHERE id=1').first()); }

async function handleRotation(env) {
  const holdings = (await env.DB.prepare('SELECT symbol, momentum_score, momentum_rank, is_bottom_20 FROM holdings ORDER BY momentum_score DESC').all()).results;
  const topNew = (await env.DB.prepare('SELECT symbol, sector, momentum_score, filters_passed, verdict FROM opportunities WHERE verdict="BUY_CANDIDATE" AND is_holding=0 ORDER BY momentum_score DESC LIMIT 10').all()).results;
  return json({ holdings, top_opportunities: topNew });
}

async function handleScan(request, env) {
  const body = await request.json();
  const {symbol, roe, de, mcap, regime='NORMAL', nifty500=true, nifty100=false} = body;
  const candles = await fetchYahooCandles(symbol + '.NS', 365);
  if (!candles || candles.length < 100) return json({error:'Insufficient data', symbol});
  return json(computeIndicators(candles, symbol, roe, de, mcap, regime, nifty500, nifty100));
}

async function handleRefresh(env) { return json(await refreshAllData(env)); }

async function fetchYahooCandles(yahooSymbol, days) {
  const now=Math.floor(Date.now()/1000), from=now-days*86400;
  const url=`https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol)}?period1=${from}&period2=${now}&interval=1d`;
  try {
    const resp=await fetch(url,{headers:{'User-Agent':'Mozilla/5.0'}});
    if (!resp.ok) return null;
    const data=await resp.json(), result=data?.chart?.result?.[0];
    if (!result) return null;
    const ts=result.timestamp, q=result.indicators.quote[0];
    return ts.map((t,i)=>({date:new Date(t*1000).toISOString().split('T')[0],open:q.open[i],high:q.high[i],low:q.low[i],close:q.close[i],volume:q.volume[i]})).filter(c=>c.close!=null);
  } catch(e) { console.error('Yahoo candle fetch error', yahooSymbol, e); return null; }
}

async function fetchYahooFundamentals(yahooSymbol) {
  const url=`https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(yahooSymbol)}?modules=financialData,defaultKeyStatistics,price`;
  try {
    const resp=await fetch(url,{headers:{'User-Agent':'Mozilla/5.0'}});
    if (!resp.ok) return null;
    const data=await resp.json(), r=data?.quoteSummary?.result?.[0];
    if (!r) return null;
    return {
      roe:(r.financialData?.returnOnEquity?.raw??null)*100,
      de:(r.financialData?.debtToEquity?.raw??null)/100,
      mcap:(r.price?.marketCap?.raw??null)/1e7
    };
  } catch(e) { console.error('Yahoo fundamentals fetch error', yahooSymbol, e); return null; }
}

function computeIndicators(candles, symbol, roe, de, mcap, regime, nifty500, nifty100) {
  const n=candles.length, closes=candles.map(c=>c.close), highs=candles.map(c=>c.high), lows=candles.map(c=>c.low), volumes=candles.map(c=>c.volume), current=closes[n-1];
  const dma200=n>=200?mean(closes.slice(-200)):null, above200=dma200?current>dma200:null, dma20=n>=20?mean(closes.slice(-20)):null;
  const lookback=Math.min(252,n), high52w=Math.max(...highs.slice(-lookback)), dist52w=(current/high52w-1)*100;
  const band=regime==='NORMAL'?-15:regime==='BULL'?-10:null, within52w=band!==null?dist52w>=band:false;
  const ret6m=n>126?(current/closes[n-127]-1)*100:null;
  let vol1y=null; const volLookback=Math.min(252,n-1);
  if(volLookback>=20){const lr=[];for(let i=n-volLookback;i<n;i++)lr.push(Math.log(closes[i]/closes[i-1]));vol1y=std(lr)*Math.sqrt(252)*100;}
  const momScore=ret6m!==null&&vol1y>0?(ret6m/100)/(vol1y/100):null;
  let rsi=null; if(n>=15){let gains=0,losses=0;for(let i=n-14;i<n;i++){const d=closes[i]-closes[i-1];if(d>0)gains+=d;else losses-=d;}const ag=gains/14,al=losses/14;rsi=al===0?100:100-100/(1+ag/al);}
  let atr=null; if(n>=15){const trs=[];for(let i=n-14;i<n;i++)trs.push(Math.max(highs[i]-lows[i],Math.abs(highs[i]-closes[i-1]),Math.abs(lows[i]-closes[i-1])));atr=mean(trs);}
  let tradedValCr=null; if(n>=20){const tv=[];for(let i=n-20;i<n;i++)tv.push(closes[i]*volumes[i]);tradedValCr=mean(tv)/1e7;}
  const volThreshold=nifty100?50:75;
  const volPass=tradedValCr!==null&&tradedValCr>=volThreshold;
  const filters={'Mcap 5K-200K':mcap>=5000&&mcap<=200000,'ROE >15%':roe>15,'D/E <1':de<1,'Above 200 DMA':above200===true,'52W High band':within52w,'Positive 6M Return':ret6m!==null&&ret6m>0,'Traded Value':volPass,'Nifty 500':nifty500===true};
  const passed=Object.values(filters).filter(Boolean).length, failed=Object.entries(filters).filter(([,v])=>!v).map(([k])=>k);
  return {symbol,ltp:round(current),dma_200:round(dma200),dma_20:round(dma20),high_52w:round(high52w),dist_52w_pct:round(dist52w),return_6m_pct:round(ret6m),vol_1y_pct:round(vol1y),momentum_score:round(momScore,4),rsi_14:round(rsi),atr_14:round(atr),atr_pct:round(atr?atr/current*100:null),traded_val_cr:round(tradedValCr),above_200_dma:above200,filters_passed:passed,failed_filters:failed,verdict:passed===8?'BUY_CANDIDATE':'REJECT',roe,de,mcap,candles:n};
}

async function refreshAllData(env) {
  const log={started:new Date().toISOString(),parts:{}};
  const holdings=(await env.DB.prepare('SELECT * FROM holdings').all()).results;
  const holdingScores=[];
  for(const h of holdings){
    const sym=h.symbol+(h.exchange==='BSE'?'.BO':'.NS');
    const candles=await fetchYahooCandles(sym,365);
    if(!candles||candles.length<30){holdingScores.push({symbol:h.symbol,score:0});continue;}
    const n=candles.length,closes=candles.map(c=>c.close);
    const ret6m=n>126?(closes[n-1]/closes[n-127]-1)*100:0;
    let vol=0;if(n>126){const lr=[];for(let i=n-126;i<n;i++)lr.push(Math.log(closes[i]/closes[i-1]));vol=std(lr)*Math.sqrt(252)*100;}
    const score=vol>0?(ret6m/100)/(vol/100):0;
    holdingScores.push({symbol:h.symbol,score});
    const dma200=n>=200?mean(closes.slice(-200)):null,dma20=mean(closes.slice(-20));
    const high52w=Math.max(...candles.slice(-252).map(c=>c.high));
    await env.DB.prepare('INSERT OR REPLACE INTO indicators (symbol,ltp,dma_200,dma_20,high_52w,above_200_dma,above_20_dma,updated_at) VALUES(?,?,?,?,?,?,?,datetime("now"))').bind(h.symbol,closes[n-1],dma200,dma20,high52w,dma200?closes[n-1]>dma200?1:0:null,dma20?closes[n-1]>dma20?1:0:null).run();
  }
  holdingScores.sort((a,b)=>b.score-a.score);
  const bottomCut=Math.ceil(holdingScores.length*.2);
  for(let i=0;i<holdingScores.length;i++){
    await env.DB.prepare('UPDATE holdings SET momentum_score=?, momentum_rank=?, is_bottom_20=? WHERE symbol=?').bind(holdingScores[i].score,i+1,i>=holdingScores.length-bottomCut?1:0,holdingScores[i].symbol).run();
  }
  log.parts.holdingsRanked=holdingScores.length;

  const allSymbols=(await env.DB.prepare('SELECT symbol, industry FROM nifty500 WHERE series="EQ" ORDER BY RANDOM() LIMIT 50').all()).results;
  let scanned=0,qualified=0;
  await env.DB.prepare('DELETE FROM opportunities WHERE scan_date < date("now","-2 days")').run();
  for(const s of allSymbols){
    scanned++;
    const yahoosym=s.symbol+'.NS';
    const fundamentals=await fetchYahooFundamentals(yahoosym);
    if(!fundamentals||fundamentals.roe<=15||fundamentals.de>=1||fundamentals.mcap<5000||fundamentals.mcap>200000)continue;
    const candles=await fetchYahooCandles(yahoosym,365);
    if(!candles||candles.length<100)continue;
    const result=computeIndicators(candles,s.symbol,fundamentals.roe,fundamentals.de,fundamentals.mcap,'NORMAL',true,false);
    if(result.filters_passed<6)continue;
    const isHolding=holdings.some(h=>h.symbol===s.symbol)?1:0;
    const sectorCount=holdings.filter(h=>h.sector===s.industry).length;
    const sectorAvailable=sectorCount<3?1:0;
    const bottom=holdingScores.filter((_,i)=>i>=holdingScores.length-bottomCut);
    const replaces=bottom.length?bottom[0].symbol:null;
    await env.DB.prepare('INSERT OR REPLACE INTO opportunities (symbol,sector,roe,de,mcap,ltp,dma_200,dist_52w_pct,return_6m_pct,vol_1y_pct,momentum_score,rsi_14,traded_val_cr,filters_passed,failed_filters,verdict,is_holding,sector_slot_available,rotation_replaces,scan_date,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,date("now"),datetime("now"))').bind(s.symbol,s.industry,fundamentals.roe,fundamentals.de,fundamentals.mcap,result.ltp,result.dma_200,result.dist_52w_pct,result.return_6m_pct,result.vol_1y_pct,result.momentum_score,result.rsi_14,result.traded_val_cr,result.filters_passed,JSON.stringify(result.failed_filters),result.verdict,isHolding,sectorAvailable,replaces).run();
    if(result.verdict==='BUY_CANDIDATE')qualified++;
  }
  log.parts.nifty500Scanned=scanned;log.parts.qualified=qualified;log.completed=new Date().toISOString();
  return log;
}

function mean(a){return a.reduce((s,v)=>s+v,0)/a.length;}
function std(a){const m=mean(a);return Math.sqrt(a.reduce((s,v)=>s+(v-m)**2,0)/(a.length-1));}
function round(v,d=2){return v!=null?+v.toFixed(d):null;}
function json(data){return new Response(JSON.stringify(data),{headers:{'Content-Type':'application/json','Access-Control-Allow-Origin':'*'}});}
