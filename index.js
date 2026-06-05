// sb-flipper Investment Worker v1
// Bazaar swing trading — NOT market making
// Uses CoflNet history API + Hypixel election API for event-driven signals

const BZ_KEY      = 'bz_invest_v1';  // current bazaar snapshot
const MAYOR_KEY   = 'mayor_v1';      // mayor/election data
const KV_TTL      = 130;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors() });

    // ── Current bazaar snapshot (all products) ────────────────────────────────
    if (url.pathname === '/bazaar') {
      if (env.FLIPPER_CACHE) {
        const c = await env.FLIPPER_CACHE.get(BZ_KEY, { type: 'json' });
        if (c) return json({ ...c, cached: true });
      }
      ctx.waitUntil(refreshBazaar(env));
      return json({ success: true, loading: true, products: [], lastUpdated: 0, ts: Date.now() });
    }

    // ── Price history for a specific item ─────────────────────────────────────
    // /history/{tag}?period=week|day|hour
    if (url.pathname.startsWith('/history/')) {
      const tag    = decodeURIComponent(url.pathname.slice(9));
      const period = url.searchParams.get('period') || 'week';
      return handleHistory(tag, period, env, ctx);
    }

    // ── Mayor / election data ─────────────────────────────────────────────────
    if (url.pathname === '/mayor') {
      if (env.FLIPPER_CACHE) {
        const c = await env.FLIPPER_CACHE.get(MAYOR_KEY, { type: 'json' });
        if (c && Date.now() - (c.ts || 0) < 300_000) return json({ ...c, cached: true });
      }
      return handleMayor(env, ctx);
    }

    // ── lastUpdated (cheap poll) ──────────────────────────────────────────────
    if (url.pathname === '/lastUpdated') {
      if (env.FLIPPER_CACHE) {
        const c = await env.FLIPPER_CACHE.get(BZ_KEY, { type: 'json' });
        if (c) return json({ lastUpdated: c.lastUpdated, ts: c.ts });
      }
      return json({ lastUpdated: 0 });
    }

    // ── Manual refresh ────────────────────────────────────────────────────────
    if (url.pathname === '/refresh') {
      if (!env.FLIPPER_CACHE)
        return json({ success: false, error: 'KV binding FLIPPER_CACHE missing' });
      try {
        await Promise.all([refreshBazaar(env), refreshMayor(env)]);
        const bz = await env.FLIPPER_CACHE.get(BZ_KEY, { type: 'json' });
        return json({ success: true, products: bz ? bz.count : 0, message: 'Refreshed' });
      } catch (e) { return json({ success: false, error: e.message }); }
    }

    if (url.pathname === '/debug') {
      const hasKV = !!env.FLIPPER_CACHE;
      let bzInfo = 'not bound', mayInfo = 'not bound';
      if (hasKV) {
        try { const v = await env.FLIPPER_CACHE.get(BZ_KEY); bzInfo = v ? `${v.length} chars` : 'EMPTY'; } catch(e) { bzInfo = e.message; }
        try { const v = await env.FLIPPER_CACHE.get(MAYOR_KEY); mayInfo = v ? `${v.length} chars` : 'EMPTY'; } catch(e) { mayInfo = e.message; }
      }
      return json({ kvBound: hasKV, bazaarCache: bzInfo, mayorCache: mayInfo });
    }

    return json({ error: 'Not found', routes: ['/bazaar', '/history/{tag}', '/mayor', '/lastUpdated', '/refresh', '/debug'] }, 404);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(Promise.all([refreshBazaar(env), refreshMayor(env)]));
  },
};

// ── Bazaar snapshot ───────────────────────────────────────────────────────────

async function refreshBazaar(env) {
  try {
    const r = await fetch('https://api.hypixel.net/v2/skyblock/bazaar', {
      headers: { 'User-Agent': 'sb-flipper/1.0' }
    });
    if (!r.ok) throw new Error(`Hypixel ${r.status}`);
    const raw = await r.json();

    const products = [];
    for (const [id, p] of Object.entries(raw.products || {})) {
      const qs = p.quick_status;
      if (!qs || qs.buyPrice <= 0) continue;

      const buyP    = qs.buyPrice,  sellP   = qs.sellPrice;
      const buyW    = qs.buyMovingWeek  || 0;
      const sellW   = qs.sellMovingWeek || 0;
      const spread  = sellP > 0 && buyP > 0 ? sellP - buyP : 0;
      const spreadPct = buyP > 0 ? (spread / buyP) * 100 : 0;

      // Top order book (slim)
      const buySummary  = (p.buy_summary  || []).slice(0, 8).map(o => ({ a: Math.round(o.amount), p: r1(o.pricePerUnit), n: o.orders }));
      const sellSummary = (p.sell_summary || []).slice(0, 8).map(o => ({ a: Math.round(o.amount), p: r1(o.pricePerUnit), n: o.orders }));
      const topBuy  = buySummary[0]?.p  || 0;
      const topSell = sellSummary[0]?.p || 0;
      const buyDepth  = buySummary.reduce( (s, o) => s + o.a, 0);
      const sellDepth = sellSummary.reduce((s, o) => s + o.a, 0);

      // Momentum = log2(buyWeek/sellWeek)
      const momentum = Math.log((Math.max(buyW,1)) / (Math.max(sellW,1))) / Math.log(2);
      // Weekly coin volume (liquidity proxy)
      const weeklyCoins = Math.min(buyW, sellW) * ((buyP + sellP) / 2);

      products.push({
        id,
        buyP: r1(buyP), sellP: r1(sellP),
        topBuy: r1(topBuy), topSell: r1(topSell),
        spread: r1(spread), spreadPct: r2(spreadPct),
        buyW, sellW,
        sellVol: qs.sellVolume || 0,
        buyVol:  qs.buyVolume  || 0,
        sellOrders: qs.sellOrders || 0,
        buyOrders:  qs.buyOrders  || 0,
        weeklyCoins: Math.round(weeklyCoins),
        buyDepth, sellDepth,
        momentum: r2(momentum),
        buySummary, sellSummary,
      });
    }

    const data = { success: true, ts: Date.now(), lastUpdated: raw.lastUpdated, count: products.length, products };
    await env.FLIPPER_CACHE.put(BZ_KEY, JSON.stringify(data), { expirationTtl: KV_TTL });
    console.log(`Bazaar: ${products.length} products`);
  } catch (e) { console.error('Bazaar:', e.message); }
}

// ── Price history ─────────────────────────────────────────────────────────────

async function handleHistory(tag, period, env, ctx) {
  const ck = `hist_${tag}_${period}`;
  const ttl = period === 'hour' ? 120 : period === 'day' ? 300 : 3600;

  if (env.FLIPPER_CACHE) {
    const c = await env.FLIPPER_CACHE.get(ck, { type: 'json' });
    if (c && Date.now() - (c.ts||0) < ttl*1000) return json({ ...c, cached: true });
  }

  try {
    let endpoint;
    const base = `https://sky.coflnet.com/api/bazaar/${encodeURIComponent(tag)}`;
    if (period === 'hour') {
      // Last 24 hours at ~5min resolution
      endpoint = `${base}/history/hour`;
    } else if (period === 'day') {
      // Last 48 hours at hourly resolution
      const end = new Date(), start = new Date(end - 2 * 86400_000);
      endpoint = `${base}/history?start=${start.toISOString()}&end=${end.toISOString()}`;
    } else {
      // week=7d, month=30d, month3=90d, month6=180d — all at hourly resolution
      const days = period === 'week' ? 7 : period === 'month3' ? 90 : period === 'month6' ? 180 : 30;
      const end  = new Date(), start = new Date(end - days * 86400_000);
      endpoint = `${base}/history?start=${start.toISOString()}&end=${end.toISOString()}`;
    }

    const r = await fetch(endpoint, { headers: { 'User-Agent': 'sb-flipper/1.0', Accept: 'application/json' } });
    if (!r.ok) throw new Error(`CoflNet ${r.status}`);
    const raw = await r.json();

    // Slim down and compute analytics
    const points = raw.map(p => ({
      t:  new Date(p.timestamp).getTime(),
      b:  r1(p.buy  || p.buyPrice  || 0),
      s:  r1(p.sell || p.sellPrice || 0),
      bv: p.buyVolume  || 0,
      sv: p.sellVolume || 0,
    })).filter(p => p.b > 0 || p.s > 0).sort((a,b) => a.t - b.t);

    const analytics = computeAnalytics(points);
    const data = { success: true, ts: Date.now(), tag, period, points, analytics };

    if (env.FLIPPER_CACHE)
      ctx.waitUntil(env.FLIPPER_CACHE.put(ck, JSON.stringify(data), { expirationTtl: ttl }));

    return json(data);
  } catch (e) {
    return json({ success: false, error: e.message, tag, period, points: [] });
  }
}

function computeAnalytics(points) {
  if (points.length < 2) return null;

  const prices = points.map(p => p.b || p.s).filter(v => v > 0);
  if (prices.length < 2) return null;
  const n  = prices.length;
  const mean = prices.reduce((a,b) => a+b, 0) / n;
  const sorted = [...prices].sort((a,b) => a-b);
  const median = sorted[Math.floor(n/2)];
  const min    = sorted[0];
  const max    = sorted[n-1];
  const stdDev = Math.sqrt(prices.reduce((s,p) => s+(p-mean)**2, 0) / n);

  const current = prices[n-1];
  const zScore  = stdDev > 0 ? (current - mean) / stdDev : 0;

  // RSI with 14-period on hourly points
  const rsi = computeRSI(prices, Math.min(14, Math.floor(n/3)));

  // Slope over last 48 points (2 days hourly) — price change per data point
  const recent = prices.slice(-Math.min(48, n));
  const slope  = linearSlope(recent);

  // Hourly interval estimate (time between points in ms)
  let intervalMs = 3_600_000; // default 1h
  if (points.length > 1) {
    const deltas = [];
    for (let i = 1; i < Math.min(10, points.length); i++) deltas.push(points[i].t - points[i-1].t);
    intervalMs = deltas.reduce((a,b)=>a+b,0) / deltas.length;
  }
  const pointsPerHour = 3_600_000 / Math.max(intervalMs, 60_000);
  const pointsPerDay  = pointsPerHour * 24;

  // Price change per real hour
  const slopePerHour = slope * pointsPerHour;

  const volatility = mean > 0 ? (stdDev / mean) * 100 : 0;

  // Signal — requires RSI + z-score agreement
  // Also consider momentum: price accelerating up/down
  const recent10 = prices.slice(-10);
  const momentum = recent10.length > 1 ? (recent10[recent10.length-1] - recent10[0]) / recent10[0] * 100 : 0;

  let signal = 'HOLD', signalStrength = 0;

  // BUY: oversold (RSI<35) AND cheap vs history (z<-0.3) AND not in freefall (momentum > -5%)
  if (rsi < 35 && zScore < -0.3 && momentum > -5) {
    signal = 'BUY';
    signalStrength = Math.min(100, Math.round((35-rsi)*2.5 + (-zScore)*25 + Math.max(0,momentum)*2));
  }
  // SELL: overbought (RSI>65) AND expensive vs history (z>0.3) AND not still rising fast (momentum < 5%)
  if (rsi > 65 && zScore > 0.3 && momentum < 5) {
    signal = 'SELL';
    signalStrength = Math.min(100, Math.round((rsi-65)*2.5 + zScore*25));
  }
  // Strong BUY: very oversold
  if (rsi < 20 && zScore < -1) {
    signal = 'BUY'; signalStrength = Math.min(100, signalStrength + 20);
  }
  // Strong SELL: very overbought
  if (rsi > 80 && zScore > 1) {
    signal = 'SELL'; signalStrength = Math.min(100, signalStrength + 20);
  }

  // Hold time: hours until price returns to mean based on slope
  const distToMean = mean - current;
  let holdHours = 24 * 7; // default 1 week
  if (Math.abs(slopePerHour) > 0.001 && Math.sign(distToMean) === Math.sign(slopePerHour)) {
    holdHours = Math.max(1, Math.round(Math.abs(distToMean) / Math.abs(slopePerHour)));
  }
  const holdDays = Math.max(1, Math.round(holdHours / 24));

  // Expected return %: buying now and selling at mean
  const expectedReturn = current > 0 ? r2((mean - current) / current * 100) : 0;

  const extrapolation = extrapolate(points, 14, intervalMs); // 14 days ahead

  return {
    mean: r1(mean), median: r1(median), min: r1(min), max: r1(max),
    stdDev: r1(stdDev), volatility: r2(volatility),
    current: r1(current), zScore: r2(zScore),
    rsi: r1(rsi), slope: r4(slopePerHour), signal,
    signalStrength: Math.round(signalStrength),
    holdDays, expectedReturn, extrapolation,
    priceRange: r2(((max-min)/mean)*100),
    momentum: r2(momentum),
  };
}

function computeRSI(prices, period = 14) {
  if (prices.length < period + 1) return 50;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const diff = prices[i] - prices[i-1];
    if (diff > 0) gains  += diff;
    else          losses -= diff;
  }
  let avgGain = gains / period, avgLoss = losses / period;
  for (let i = period + 1; i < prices.length; i++) {
    const diff = prices[i] - prices[i-1];
    avgGain = (avgGain * (period-1) + Math.max(0, diff))  / period;
    avgLoss = (avgLoss * (period-1) + Math.max(0,-diff)) / period;
  }
  if (avgLoss === 0) return 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

function linearSlope(values) {
  const n = values.length;
  if (n < 2) return 0;
  const xm = (n-1)/2;
  const ym = values.reduce((a,b)=>a+b,0)/n;
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) { num += (i-xm)*(values[i]-ym); den += (i-xm)**2; }
  return den === 0 ? 0 : num/den;
}


function extrapolate(points, futureDays, intervalMs = 3_600_000) {
  if (points.length < 5) return [];
  const last   = points[points.length-1];
  const prices = points.map(p => p.b || p.s).filter(v => v > 0);
  const slope  = linearSlope(prices.slice(-48)); // slope per data point
  const steps  = Math.round((futureDays * 86_400_000) / intervalMs);
  const result = [];
  for (let i = 1; i <= steps; i++) {
    const projPrice = last.b + slope * i;
    if (projPrice > 0) result.push({ t: last.t + i * intervalMs, b: r1(projPrice) });
  }
  return result;
}

// ── Mayor / election ──────────────────────────────────────────────────────────

async function handleMayor(env, ctx) {
  try {
    const data = await refreshMayor(env);
    return json(data);
  } catch (e) { return json({ success: false, error: e.message }); }
}

async function refreshMayor(env) {
  const r = await fetch('https://api.hypixel.net/resources/skyblock/election', {
    headers: { 'User-Agent': 'sb-flipper/1.0' }
  });
  if (!r.ok) throw new Error(`Hypixel election ${r.status}`);
  const raw = await r.json();

  const data = {
    success: true, ts: Date.now(),
    currentMayor:   raw.mayor?.name || null,
    currentPerks:   raw.mayor?.perks?.map(p => p.name) || [],
    // Use the API's own election closing time — it knows exactly when it ends
    // raw.current.closing is the election end timestamp in ms
    // If not present, fall back to computed value
    nextElectionTs: raw.current?.closing
      || raw.mayor?.electionEntry?.closing
      || computeNextElection(),
    candidates:     (raw.current?.candidates || []).map(c => ({
      name: c.name,
      perks: c.perks?.map(p => p.name) || [],
      votes: c.votes || 0,
    })),
    mayorImpact: getMayorImpact(raw.mayor?.name),
    // Include raw for debugging
    rawCurrentKeys: raw.current ? Object.keys(raw.current) : [],
  };

  if (env.FLIPPER_CACHE)
    await env.FLIPPER_CACHE.put(MAYOR_KEY, JSON.stringify(data), { expirationTtl: 300 });
  return data;
}

// Known mayor market impacts — which items spike/drop
function getMayorImpact(mayor) {
  const impacts = {
    'Diana': ['GRIFFIN_FEATHER','MINOS_RELIC','CHIMERA','FLAWED_DIAMOND_GEM'],
    'Scorpius': ['CORRUPTED_FRAGMENT','BRIBE'],
    'Jerry':  ['JERRY_BOX','BLUE_JERRY','GREEN_JERRY','PURPLE_JERRY','GOLDEN_JERRY'],
    'Cole':   ['HOT_STUFF','COAL','LAVA_BUCKET'],
    'Paul':   ['OVERLOAD_1','REJUVENATE_1'],
    'Finnegan': ['WHEAT','POTATO_ITEM','CARROT_ITEM','MUSHROOM_COLLECTION','CACTUS'],
    'Derpy':  ['ENCHANTED_EGG','SUPER_EGG','RABBIT_HAT'],
    'Aatrox': ['MADDOX_BATPHONE','KUUDRA_TEETH'],
    'Foxy':   ['FESTIVAL_MASK_BEAR','FESTIVAL_MASK_FOX','FESTIVAL_MASK_WOLF'],
  };
  return impacts[mayor] || [];
}

// SkyBlock year = 124 real hours = 446,400,000 ms
// SkyBlock started approximately June 11 2019
// Election happens at the end of each SkyBlock year (Late Winter → Early Spring)
function computeNextElection() {
  const SB_EPOCH   = 1560272700000; // June 11 2019 ~17:05 UTC (approximate)
  const SB_YEAR_MS = 124 * 60 * 60 * 1000; // 124 real hours
  const now = Date.now();
  const elapsed = now - SB_EPOCH;
  const currentYear = Math.floor(elapsed / SB_YEAR_MS);
  // Next election = start of next SB year
  return SB_EPOCH + (currentYear + 1) * SB_YEAR_MS;
}

// ── Util ──────────────────────────────────────────────────────────────────────

const r1 = v => Math.round(v * 10) / 10;
const r2 = v => Math.round(v * 100) / 100;
const r4 = v => Math.round(v * 10000) / 10000;

function json(d, s = 200) {
  return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json', ...cors() } });
}
function cors() {
  return { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' };
}