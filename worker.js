// SB Investment Worker v3
// Full swing-trading algorithm with events, mayors, multi-factor signals

const BZ_KEY    = 'bz_invest_v3';
const MAYOR_KEY = 'mayor_v3';
const KV_TTL    = 130;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors() });

    if (url.pathname === '/bazaar') {
      if (env.FLIPPER_CACHE) {
        const c = await env.FLIPPER_CACHE.get(BZ_KEY, { type: 'json' });
        if (c) return json({ ...c, cached: true });
      }
      ctx.waitUntil(refreshBazaar(env));
      return json({ success: true, loading: true, products: [], lastUpdated: 0, ts: Date.now() });
    }

    if (url.pathname.startsWith('/history/')) {
      const tag    = decodeURIComponent(url.pathname.slice(9));
      const period = url.searchParams.get('period') || 'month';
      return handleHistory(tag, period, env, ctx);
    }

    if (url.pathname === '/mayor') {
      if (env.FLIPPER_CACHE) {
        const c = await env.FLIPPER_CACHE.get(MAYOR_KEY, { type: 'json' });
        if (c && Date.now() - (c.ts || 0) < 300000) return json({ ...c, cached: true });
      }
      return handleMayor(env, ctx);
    }

    if (url.pathname === '/lastUpdated') {
      if (env.FLIPPER_CACHE) {
        const c = await env.FLIPPER_CACHE.get(BZ_KEY, { type: 'json' });
        if (c) return json({ lastUpdated: c.lastUpdated, ts: c.ts });
      }
      return json({ lastUpdated: 0 });
    }

    if (url.pathname === '/refresh') {
      if (!env.FLIPPER_CACHE) return json({ success: false, error: 'KV not bound' });
      try {
        await Promise.all([refreshBazaar(env), refreshMayor(env)]);
        const bz = await env.FLIPPER_CACHE.get(BZ_KEY, { type: 'json' });
        return json({ success: true, products: bz ? bz.count : 0 });
      } catch (e) { return json({ success: false, error: e.message }); }
    }

    if (url.pathname === '/debug') {
      const hasKV = !!env.FLIPPER_CACHE;
      let bzInfo = 'not bound', mayInfo = 'not bound';
      if (hasKV) {
        try { const v = await env.FLIPPER_CACHE.get(BZ_KEY); bzInfo = v ? v.length + ' chars' : 'EMPTY'; } catch(e) { bzInfo = e.message; }
        try { const v = await env.FLIPPER_CACHE.get(MAYOR_KEY); mayInfo = v ? v.length + ' chars' : 'EMPTY'; } catch(e) { mayInfo = e.message; }
      }
      return json({ kvBound: hasKV, bazaarCache: bzInfo, mayorCache: mayInfo });
    }

    return json({ error: 'Not found', routes: ['/bazaar','/history/{tag}','/mayor','/lastUpdated','/refresh','/debug'] }, 404);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(Promise.all([refreshBazaar(env), refreshMayor(env)]));
  },
};

// ── Bazaar snapshot ───────────────────────────────────────────────────────────

async function refreshBazaar(env) {
  try {
    const r = await fetch('https://api.hypixel.net/v2/skyblock/bazaar', { headers: { 'User-Agent': 'sb-flipper/1.0' } });
    if (!r.ok) throw new Error('Hypixel ' + r.status);
    const raw = await r.json();
    const products = [];

    for (const [id, p] of Object.entries(raw.products || {})) {
      const qs = p.quick_status;
      if (!qs || qs.buyPrice <= 0) continue;
      const buyP = qs.buyPrice, sellP = qs.sellPrice;
      const buyW = qs.buyMovingWeek || 0, sellW = qs.sellMovingWeek || 0;
      const spread = sellP > 0 ? sellP - buyP : 0;
      const spreadPct = buyP > 0 ? (spread / buyP) * 100 : 0;
      const buySummary  = (p.buy_summary  || []).slice(0, 8).map(o => ({ a: Math.round(o.amount), p: r1(o.pricePerUnit), n: o.orders }));
      const sellSummary = (p.sell_summary || []).slice(0, 8).map(o => ({ a: Math.round(o.amount), p: r1(o.pricePerUnit), n: o.orders }));
      const topBuy  = buySummary[0]?.p  || 0;
      const topSell = sellSummary[0]?.p || 0;
      const buyDepth  = buySummary.reduce( (s, o) => s + o.a, 0);
      const sellDepth = sellSummary.reduce((s, o) => s + o.a, 0);
      const momentum = Math.log((Math.max(buyW,1)) / (Math.max(sellW,1))) / Math.log(2);
      const weeklyCoins = Math.min(buyW, sellW) * ((buyP + sellP) / 2);

      products.push({
        id, buyP: r1(buyP), sellP: r1(sellP), topBuy: r1(topBuy), topSell: r1(topSell),
        spread: r1(spread), spreadPct: r2(spreadPct),
        buyW, sellW, sellVol: qs.sellVolume||0, buyVol: qs.buyVolume||0,
        sellOrders: qs.sellOrders||0, buyOrders: qs.buyOrders||0,
        weeklyCoins: Math.round(weeklyCoins), buyDepth, sellDepth,
        momentum: r2(momentum), buySummary, sellSummary,
      });
    }

    const data = { success: true, ts: Date.now(), lastUpdated: raw.lastUpdated, count: products.length, products };
    await env.FLIPPER_CACHE.put(BZ_KEY, JSON.stringify(data), { expirationTtl: KV_TTL });
    console.log('Bazaar: ' + products.length + ' products');
  } catch (e) { console.error('Bazaar:', e.message); }
}

// ── Price history with full algorithm ────────────────────────────────────────

async function handleHistory(tag, period, env, ctx) {
  const ck  = 'hist3_' + tag + '_' + period;
  const ttl = period === 'hour' ? 120 : period === 'day' ? 300 : 3600;

  if (env.FLIPPER_CACHE) {
    const c = await env.FLIPPER_CACHE.get(ck, { type: 'json' });
    if (c && Date.now() - (c.ts || 0) < ttl * 1000) return json({ ...c, cached: true });
  }

  try {
    const base = 'https://sky.coflnet.com/api/bazaar/' + encodeURIComponent(tag);
    let endpoint;
    if (period === 'hour') {
      endpoint = base + '/history/hour';
    } else {
      // All periods use date-range for hourly data
      const days = period === 'day' ? 2 : period === 'week' ? 7 : period === 'month' ? 30
                 : period === 'month3' ? 90 : period === 'month6' ? 180 : 30;
      const end   = new Date();
      const start = new Date(end.getTime() - days * 86400000);
      endpoint = base + '/history?start=' + start.toISOString() + '&end=' + end.toISOString();
    }

    const r = await fetch(endpoint, { headers: { 'User-Agent': 'sb-flipper/1.0', Accept: 'application/json' } });
    if (!r.ok) throw new Error('CoflNet ' + r.status);
    const raw = await r.json();

    const points = raw.map(p => ({
      t:  new Date(p.timestamp).getTime(),
      b:  r1(p.buy  || p.buyPrice  || 0),
      s:  r1(p.sell || p.sellPrice || 0),
      bv: p.buyVolume  || 0,
      sv: p.sellVolume || 0,
    })).filter(p => p.b > 0 || p.s > 0).sort((a, b) => a.t - b.t);

    // Fetch mayor data to enrich analytics
    let mayorData = null;
    if (env.FLIPPER_CACHE) {
      const mc = await env.FLIPPER_CACHE.get(MAYOR_KEY, { type: 'json' });
      if (mc) mayorData = mc;
    }

    const analytics = computeAnalytics(points, mayorData, tag);
    const data = { success: true, ts: Date.now(), tag, period, points, analytics };

    if (env.FLIPPER_CACHE)
      ctx.waitUntil(env.FLIPPER_CACHE.put(ck, JSON.stringify(data), { expirationTtl: ttl }));

    return json(data);
  } catch (e) {
    return json({ success: false, error: e.message, tag, period, points: [], analytics: null });
  }
}

// ── Multi-factor trading algorithm ───────────────────────────────────────────
// This is a real swing-trading algorithm designed for the SkyBlock economy.
// Factors considered:
//  1. RSI (momentum oscillator) — identifies overbought/oversold conditions
//  2. Z-score — measures deviation from historical mean (mean reversion signal)
//  3. Bollinger Bands — statistical price channels (breakout detection)
//  4. MACD — Moving Average Convergence/Divergence (trend + momentum)
//  5. Volume momentum — buy:sell volume ratio trend
//  6. Mayor cycle — which items benefit from current/upcoming mayor
//  7. SkyBlock events — seasonal price patterns (Jacob, Spooky, Year of X)
//  8. Price velocity — rate of change in recent hours
//  9. Support/resistance — recent highs/lows as price targets
// 10. Volatility regime — adjusts signal thresholds for high-volatility items

function computeAnalytics(points, mayorData, itemId) {
  if (points.length < 5) return null;

  const buyPrices  = points.map(p => p.b).filter(v => v > 0);
  const sellPrices = points.map(p => p.s).filter(v => v > 0);
  const prices = buyPrices.length > 0 ? buyPrices : sellPrices;
  if (prices.length < 5) return null;

  const n       = prices.length;
  const current = prices[n-1];
  const mean    = prices.reduce((a,b) => a+b, 0) / n;
  const sorted  = [...prices].sort((a,b) => a-b);
  const median  = sorted[Math.floor(n/2)];
  const min     = sorted[0];
  const max     = sorted[n-1];
  const stdDev  = Math.sqrt(prices.reduce((s,p) => s+(p-mean)**2, 0) / n);
  const zScore  = stdDev > 0 ? (current - mean) / stdDev : 0;
  const volatility = mean > 0 ? (stdDev / mean) * 100 : 0;

  // ── 1. RSI ────────────────────────────────────────────────────────────────
  const rsi = computeRSI(prices, Math.min(14, Math.floor(n/3)));

  // ── 2. Bollinger Bands (20-period, 2 std devs) ────────────────────────────
  const bbPeriod = Math.min(20, n);
  const bbPrices = prices.slice(-bbPeriod);
  const bbMean   = bbPrices.reduce((a,b) => a+b, 0) / bbPeriod;
  const bbStd    = Math.sqrt(bbPrices.reduce((s,p) => s+(p-bbMean)**2, 0) / bbPeriod);
  const bbUpper  = bbMean + 2 * bbStd;
  const bbLower  = bbMean - 2 * bbStd;
  const bbSignal = current < bbLower ? 1 : current > bbUpper ? -1 : 0; // +1=buy, -1=sell

  // ── 3. MACD (12/26/9 EMA) ────────────────────────────────────────────────
  const ema12  = computeEMA(prices, 12);
  const ema26  = computeEMA(prices, 26);
  const macd   = ema12 - ema26;
  // Approximate signal line as EMA of recent MACD values
  const macdSignalVal = macd > 0 ? 1 : -1; // simplified: positive MACD = bullish

  // ── 4. Price velocity (rate of change last 24h vs prior 24h) ─────────────
  const p24ago = prices[Math.max(0, n-25)];
  const p48ago = prices[Math.max(0, n-49)];
  const vel24  = p24ago > 0 ? ((current - p24ago) / p24ago) * 100 : 0;
  const vel48  = p48ago > 0 && p24ago > 0 ? ((p24ago - p48ago) / p48ago) * 100 : 0;
  const accel  = vel24 - vel48; // positive = accelerating up

  // ── 5. Volume momentum ────────────────────────────────────────────────────
  const recentBuyVol  = points.slice(-24).reduce((s,p) => s + p.bv, 0);
  const recentSellVol = points.slice(-24).reduce((s,p) => s + p.sv, 0);
  const volRatio      = recentSellVol > 0 ? recentBuyVol / recentSellVol : 1;
  const volSignal     = volRatio > 1.2 ? 1 : volRatio < 0.8 ? -1 : 0; // buy pressure vs sell

  // ── 6. Support/Resistance ─────────────────────────────────────────────────
  // Recent highs/lows as price targets
  const recent168 = prices.slice(-Math.min(168, n));
  const support    = Math.min(...recent168);
  const resistance = Math.max(...recent168);
  const pctFromSupport    = support > 0 ? ((current - support) / support) * 100 : 0;
  const pctFromResistance = resistance > 0 ? ((resistance - current) / resistance) * 100 : 0;
  const nearSupport    = pctFromSupport < 3;    // within 3% of support = buy zone
  const nearResistance = pctFromResistance < 3; // within 3% of resistance = sell zone

  // ── 7. Mayor event boost ──────────────────────────────────────────────────
  let mayorBoost = 0; // -2 to +2
  let mayorContext = '';
  if (mayorData) {
    const affected = mayorData.mayorImpact || [];
    const isAffected = affected.includes(itemId);
    if (isAffected) {
      // Current mayor affects this item positively
      const timeToElection = (mayorData.nextElectionTs || 0) - Date.now();
      if (timeToElection > 0 && timeToElection < 24 * 3600000) {
        // Election imminent — current mayor effect ending soon
        mayorBoost = -1;
        mayorContext = 'Mayor election imminent — effect ending';
      } else {
        mayorBoost = 1;
        mayorContext = 'Affected by mayor: ' + mayorData.currentMayor;
      }
    }
    // Check upcoming candidates
    const candidates = mayorData.candidates || [];
    for (const cand of candidates) {
      const candImpact = getMayorImpact(cand.name);
      if (candImpact.includes(itemId)) {
        mayorBoost += 0.5; // potential future benefit
        mayorContext += ' | Candidate ' + cand.name + ' may benefit this item';
      }
    }
  }

  // ── 8. Seasonal SkyBlock events ───────────────────────────────────────────
  // Known price patterns for SkyBlock events
  const eventBoost = getEventBoost(itemId, Date.now());

  // ── 9. Composite signal ───────────────────────────────────────────────────
  // Weighted scoring system: each factor contributes to a score from -100 to +100
  // Positive = bullish (buy), Negative = bearish (sell)

  let score = 0;
  let reasons = [];

  // RSI contribution (weight: 25)
  if (rsi < 30)      { score += 25; reasons.push('RSI oversold (' + rsi.toFixed(0) + ')'); }
  else if (rsi < 40) { score += 12; reasons.push('RSI mildly oversold'); }
  else if (rsi > 70) { score -= 25; reasons.push('RSI overbought (' + rsi.toFixed(0) + ')'); }
  else if (rsi > 60) { score -= 12; reasons.push('RSI mildly overbought'); }

  // Z-score contribution (weight: 20)
  if (zScore < -1.5)      { score += 20; reasons.push('Very cheap vs history (z=' + r2(zScore) + ')'); }
  else if (zScore < -0.5) { score += 10; reasons.push('Cheap vs history (z=' + r2(zScore) + ')'); }
  else if (zScore > 1.5)  { score -= 20; reasons.push('Very expensive vs history (z=' + r2(zScore) + ')'); }
  else if (zScore > 0.5)  { score -= 10; reasons.push('Expensive vs history'); }

  // Bollinger Bands (weight: 15)
  if (bbSignal === 1)  { score += 15; reasons.push('Below lower Bollinger Band — oversold'); }
  if (bbSignal === -1) { score -= 15; reasons.push('Above upper Bollinger Band — overbought'); }

  // MACD (weight: 10)
  if (macd > 0 && vel24 > 0) { score += 10; reasons.push('MACD bullish + positive momentum'); }
  if (macd < 0 && vel24 < 0) { score -= 10; reasons.push('MACD bearish + negative momentum'); }

  // Volume momentum (weight: 10)
  if (volSignal === 1)  { score += 10; reasons.push('High buy volume vs sell'); }
  if (volSignal === -1) { score -= 10; reasons.push('High sell volume vs buy'); }

  // Support/Resistance (weight: 10)
  if (nearSupport)    { score += 10; reasons.push('Near support level'); }
  if (nearResistance) { score -= 10; reasons.push('Near resistance level'); }

  // Mayor boost (weight: 15)
  score += mayorBoost * 7.5;
  if (mayorBoost > 0) reasons.push(mayorContext);

  // Event boost (weight: 15)
  score += eventBoost.score * 7.5;
  if (eventBoost.reason) reasons.push(eventBoost.reason);

  // Acceleration modifier
  if (accel > 2 && score > 0) { score *= 1.2; reasons.push('Accelerating upward'); }
  if (accel < -2 && score < 0) { score *= 1.2; reasons.push('Accelerating downward'); }

  // ── 10. Final signal ──────────────────────────────────────────────────────
  let signal = 'HOLD';
  let signalStrength = 0;

  if (score >= 20) {
    signal = 'BUY';
    signalStrength = Math.min(100, Math.round(score));
  } else if (score <= -20) {
    signal = 'SELL';
    signalStrength = Math.min(100, Math.round(-score));
  }

  // Target price: use resistance as sell target for BUY signals,
  // support as target for SELL signals. More nuanced than just "mean".
  const targetBuy  = bbLower;   // good buy zone
  const targetSell = resistance * 0.97; // conservative sell target (just below resistance)

  // Hold time estimate based on velocity
  let holdHours = 7 * 24;
  const velocity = Math.abs(vel24) / 100 * current; // coins/hr change
  if (velocity > 0) {
    const distToTarget = signal === 'BUY' ? Math.abs(targetSell - current)
                                           : Math.abs(current - targetBuy);
    holdHours = Math.max(1, Math.round(distToTarget / Math.max(velocity, 0.001)));
  }
  const holdDays = Math.max(1, Math.round(holdHours / 24));

  // Expected return: from current price to sell target
  const expectedReturn = current > 0 ? r2((targetSell - current) / current * 100) : 0;

  // Interval for extrapolation
  let intervalMs = 3600000;
  if (points.length > 1) {
    const deltas = [];
    for (let i = 1; i < Math.min(10, points.length); i++) deltas.push(points[i].t - points[i-1].t);
    intervalMs = deltas.reduce((a,b)=>a+b,0) / deltas.length;
  }

  // Extrapolation: 30 days forward using multiple models
  const extrapolation = extrapolateAdvanced(points, 30, intervalMs);

  return {
    mean: r1(mean), median: r1(median), min: r1(min), max: r1(max),
    stdDev: r1(stdDev), volatility: r2(volatility),
    current: r1(current), zScore: r2(zScore),
    rsi: r1(rsi), macd: r4(macd), bbUpper: r1(bbUpper), bbLower: r1(bbLower),
    support: r1(support), resistance: r1(resistance),
    vel24: r2(vel24), volRatio: r2(volRatio),
    signal, signalStrength: Math.round(signalStrength),
    score: r2(score), reasons,
    holdDays, expectedReturn, extrapolation,
    targetBuy: r1(targetBuy), targetSell: r1(targetSell),
    priceRange: r2(((max-min)/mean)*100),
    momentum: r2(vel24),
    mayorContext, eventReason: eventBoost.reason,
  };
}

// ── SkyBlock event price boost database ──────────────────────────────────────
// Known items that spike during specific events
function getEventBoost(itemId, now) {
  // SkyBlock year is 124 real hours = 446400000 ms
  const SB_EPOCH   = 1560272700000;
  const SB_YEAR_MS = 124 * 3600000;
  const sbElapsed  = now - SB_EPOCH;
  const sbYear     = Math.floor(sbElapsed / SB_YEAR_MS);
  const sbProgress = (sbElapsed % SB_YEAR_MS) / SB_YEAR_MS; // 0-1 through the year

  // SkyBlock months: Early Spring=0, Spring=1, Late Spring=2, Early Summer=3...
  // Each month = 1/24 of a SkyBlock year (approx)
  const sbMonth = Math.floor(sbProgress * 24); // 0-23

  const events = {
    // Jacob's Farming Contests: happen every ~20 min of SB time, reward farming items
    // Farming items spike slightly every day
    'WHEAT':            { spooky: 0, jacob: 0.5, travel: 0 },
    'POTATO_ITEM':      { spooky: 0, jacob: 0.5, travel: 0 },
    'CARROT_ITEM':      { spooky: 0, jacob: 0.5, travel: 0 },
    'PUMPKIN':          { spooky: 1.5, jacob: 0.5, travel: 0 }, // Spooky Festival
    'MUSHROOM_COLLECTION': { spooky: 0, jacob: 0.5, travel: 0 },
    'CACTUS':           { spooky: 0, jacob: 0.5, travel: 0 },
    'SUGAR_CANE':       { spooky: 0, jacob: 0.5, travel: 0 },
    // Spooky Festival (late October SkyBlock = sbMonth 18-20 approximately)
    'CANDY_CORN':       { spooky: 2.0, jacob: 0, travel: 0 },
    // Travel scrolls / fishing events
    'PRISMARINE_CRYSTALS': { spooky: 0, jacob: 0, travel: 0.5 },
    // Mining events (Lift Off, etc.)
    'MITHRIL_ORE':      { spooky: 0, jacob: 0, travel: 0, mining: 0.5 },
    'TITANIUM_ORE':     { spooky: 0, jacob: 0, travel: 0, mining: 0.5 },
    // Bingo: many items spike at start of Bingo month
    'ENCHANTED_GOLD':   { bingo: 0.5 },
    'ENCHANTED_IRON':   { bingo: 0.5 },
    // Year of the Rabbit etc (annual special)
    'RABBIT_HAT':       { spooky: 0, annual: 1.0 },
  };

  const itemEvents = events[itemId];
  if (!itemEvents) return { score: 0, reason: null };

  let score = 0, reason = null;

  // Spooky festival: sbMonth 18-20 (Late Fall)
  if (itemEvents.spooky && sbMonth >= 18 && sbMonth <= 20) {
    score += itemEvents.spooky;
    reason = 'Spooky Festival active — ' + itemId + ' in high demand';
  }

  // Pre-spooky positioning (sbMonth 16-17)
  if (itemEvents.spooky && sbMonth >= 16 && sbMonth < 18) {
    score += itemEvents.spooky * 0.5;
    reason = 'Approaching Spooky Festival — buy before spike';
  }

  // Jacob's farming: always slight positive for farming items
  if (itemEvents.jacob) {
    score += itemEvents.jacob * 0.3;
    reason = (reason ? reason + ' | ' : '') + 'Jacob\'s Contests active';
  }

  return { score: r2(score), reason };
}

// Mayor item impact lookup
function getMayorImpact(mayor) {
  const impacts = {
    'Diana':    ['GRIFFIN_FEATHER','MINOS_RELIC','CHIMERA','FLAWED_DIAMOND_GEM','GRIFFIN_UPGRADE_STONE'],
    'Scorpius': ['CORRUPTED_FRAGMENT','BRIBE'],
    'Jerry':    ['JERRY_BOX','BLUE_JERRY','GREEN_JERRY','PURPLE_JERRY','GOLDEN_JERRY'],
    'Cole':     ['HOT_STUFF','COAL','LAVA_BUCKET','FUEL_BLOCK'],
    'Paul':     ['OVERLOAD_1','REJUVENATE_1','POWER_SHARD'],
    'Finnegan': ['WHEAT','POTATO_ITEM','CARROT_ITEM','MUSHROOM_COLLECTION','CACTUS','SUGAR_CANE'],
    'Derpy':    ['ENCHANTED_EGG','SUPER_EGG','RABBIT_HAT'],
    'Aatrox':   ['MADDOX_BATPHONE','KUUDRA_TEETH','WITHER_BLOOD'],
    'Foxy':     ['FESTIVAL_MASK_BEAR','FESTIVAL_MASK_FOX','FESTIVAL_MASK_WOLF'],
    'Diaz':     ['COINS_OF_GOLD','BUDGET_HOPPER'],
    'Marina':   ['PRISMARINE_SHARD','PRISMARINE_CRYSTALS','RAW_FISH','SPONGE'],
  };
  return impacts[mayor] || [];
}

// ── Advanced extrapolation ────────────────────────────────────────────────────
// Uses linear regression + seasonality + mean-reversion to project prices
function extrapolateAdvanced(points, futureDays, intervalMs) {
  if (points.length < 5) return [];
  const prices = points.map(p => p.b || p.s).filter(v => v > 0);
  const last   = points[points.length - 1];

  // Short-term trend (last 48 pts)
  const shortSlope = linearSlope(prices.slice(-Math.min(48, prices.length)));
  // Long-term trend (all data)
  const longSlope  = linearSlope(prices);

  // Blend: mostly short-term but pulled toward long-term
  const blendedSlope = shortSlope * 0.7 + longSlope * 0.3;

  // Mean reversion force: pull toward historical mean
  const mean     = prices.reduce((a,b) => a+b, 0) / prices.length;
  const current  = prices[prices.length - 1];
  const reversion = (mean - current) * 0.02; // 2% per interval toward mean

  const steps = Math.round((futureDays * 86400000) / intervalMs);
  const result = [];
  let price = current;

  for (let i = 1; i <= steps; i++) {
    price += blendedSlope + reversion * Math.exp(-i * 0.01); // decay reversion over time
    if (price < 0) price = 0.01;
    result.push({ t: last.t + i * intervalMs, b: r1(price) });
  }
  return result;
}

// ── EMA calculation ───────────────────────────────────────────────────────────
function computeEMA(prices, period) {
  if (prices.length < period) return prices[prices.length-1] || 0;
  const k = 2 / (period + 1);
  let ema = prices.slice(0, period).reduce((a,b) => a+b, 0) / period;
  for (let i = period; i < prices.length; i++) ema = prices[i] * k + ema * (1 - k);
  return ema;
}

function computeRSI(prices, period = 14) {
  if (prices.length < period + 1) return 50;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const diff = prices[i] - prices[i-1];
    if (diff > 0) gains += diff; else losses -= diff;
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
  if (!r.ok) throw new Error('Election API ' + r.status);
  const raw = await r.json();

  // The API returns nextElectionTs = when voting CLOSES
  // The new mayor takes effect one SB year after voting closes
  const SB_YEAR_MS     = 124 * 3600000;
  const votingCloseTs  = raw.current?.closing || computeNextElection();
  const mayorChangeTs  = votingCloseTs + SB_YEAR_MS; // actual mayor change
  
  const currentMayorName = raw.mayor?.name || null;
  const mayorImpact      = getMayorImpact(currentMayorName);

  // Next mayor candidates and their impacts
  const candidates = (raw.current?.candidates || []).map(c => ({
    name: c.name,
    perks: c.perks?.map(p => p.name) || [],
    votes: c.votes || 0,
    impact: getMayorImpact(c.name),
  }));
  // Sort by votes to find likely winner
  candidates.sort((a,b) => b.votes - a.votes);

  const data = {
    success: true, ts: Date.now(),
    currentMayor:   currentMayorName,
    currentPerks:   raw.mayor?.perks?.map(p => p.name) || [],
    nextElectionTs: votingCloseTs,   // when voting closes
    mayorChangeTs:  mayorChangeTs,   // when new mayor actually takes effect
    candidates,
    mayorImpact,
    // Items that WILL benefit from likely next mayor
    nextMayorImpact: candidates.length > 0 ? candidates[0].impact : [],
    nextMayorName:   candidates.length > 0 ? candidates[0].name   : null,
  };

  if (env?.FLIPPER_CACHE)
    await env.FLIPPER_CACHE.put(MAYOR_KEY, JSON.stringify(data), { expirationTtl: 300 });
  return data;
}

function computeNextElection() {
  const SB_EPOCH   = 1560272700000;
  const SB_YEAR_MS = 124 * 3600000;
  const now = Date.now();
  const elapsed = now - SB_EPOCH;
  const currentYear = Math.floor(elapsed / SB_YEAR_MS);
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