// sb-flipper Investment Worker v3
// Full event-aware prediction engine

const BZ_KEY    = 'bz_invest_v3';
const MAYOR_KEY = 'mayor_v3';
const KV_TTL    = 130;

// SkyBlock constants
const SB_EPOCH   = 1560272700000;
const SB_YEAR_MS = 124 * 3600000;  // 124 real hours per SB year
const SB_DAY_MS  = SB_YEAR_MS / 372; // 372 SB days per year

// ── Event schedule (SB days within a year) ───────────────────────────────────
// SkyBlock year has Early Spring (1) through Late Winter (31) × 12 months
// Events occur at fixed SB calendar positions each year
const ANNUAL_EVENTS = [
  { name:'Spooky Festival',  sbDayStart: 298, sbDayEnd: 301, items:['CANDY','GREEN_CANDY','PURPLE_CANDY','JACK_O_LANTERN','SPOOKY_FRAGMENT'], effect: 1.4 },
  { name:'Fishing Festival', sbDayStart: 91,  sbDayEnd: 94,  items:['FISH','RAW_FISH','TROPHY_FISH','DOLPHIN_PET'], effect: 1.2 },
  { name:'Season of Jerry',  sbDayStart: 329, sbDayEnd: 341, items:['JERRY_BOX','BLUE_JERRY','GREEN_JERRY','PURPLE_JERRY','GOLDEN_JERRY'], effect: 1.5 },
  { name:'New Year',         sbDayStart: 359, sbDayEnd: 361, items:['NEW_YEAR_CAKE','CAKE_BAG'], effect: 1.3 },
  { name:'Mining Fiesta',    sbDayStart: 147, sbDayEnd: 150, items:['MITHRIL','COAL','IRON_INGOT','GOLD_INGOT','DIAMOND','EMERALD'], effect: 0.85 },
];

// ── Mayor/minister perks → market effects ────────────────────────────────────
const PERK_EFFECTS = {
  // Farming perks → crop supply UP → prices DOWN
  'GOATed':           { items:['WHEAT','POTATO_ITEM','CARROT_ITEM','PUMPKIN','SUGAR_CANE','MELON','MUSHROOM_COLLECTION','CACTUS','COCOA_BEANS','NETHER_STALK'], effect: 0.88 },
  'Blooming Business':{ items:['WHEAT','POTATO_ITEM','CARROT_ITEM','SUGAR_CANE','PUMPKIN','MELON'], effect: 0.90 },
  'Pelt-pocalypse':   { items:['FUR','PELT'], effect: 0.85 },
  'Pest Eradicator':  { items:['ENCHANTED_COOKIE','COMPOSTER_UPGRADE','PESTICIDE'], effect: 0.90 },
  // Mining perks → ore supply UP → prices DOWN
  'Prospection':      { items:['MITHRIL','COAL','IRON_INGOT','GOLD_INGOT','DIAMOND','EMERALD','GEMSTONE_POWDER'], effect: 0.85 },
  'Mining Fiesta':    { items:['MITHRIL','COBBLESTONE','COAL','IRON_INGOT','GOLD_INGOT','DIAMOND'], effect: 0.80 },
  'Molten Forge':     { items:['ENCHANTED_IRON','ENCHANTED_GOLD','ENCHANTED_DIAMOND','HARD_STONE'], effect: 0.87 },
  // Fishing perks → fish/sea supply UP → prices DOWN
  'Fishing Festival': { items:['RAW_FISH','PRISMARINE_SHARD','SHARK_FIN','SQUUID_HAT','SPONGE','FISHING_EXPERIENCE_BOTTLE'], effect: 0.85 },
  'Luck of the Sea 2.0':{ items:['RAW_FISH','TROPHY_FISH','DOLPHIN_PET'], effect: 0.88 },
  // Slayer perks → slayer mats UP → prices DOWN
  'SLASHED Pricing':  { items:['CORRUPTED_FRAGMENT','WITHER_ESSENCE','SPIDER_CATALYST','REVENANT_FLESH','SADAN_BROOCH'], effect: 0.88 },
  'Pathfinder':       { items:['REVENANT_FLESH','TARANTULA_SILK','VOIDLING_NUCLEUS','WOLF_TOOTH'], effect: 0.90 },
  // Special mayor effects
  'Mythological Ritual':{ items:['GRIFFIN_FEATHER','MINOS_RELIC','CHIMERA','FLAWED_DIAMOND_GEM','MAGICAL_MUSHROOM_SOUP'], effect: 1.35 },
  'Darker Auctions':  { items:['SCYTHE_BLADE','WITHER_BLOOD','SHADOW_ASSASSIN_CLOAK','SHADOW_FURY'], effect: 1.25 },
  'Shopping Spree':   { items:['BOOSTER_COOKIE','DUNGEON_ORBS','BEACON'], effect: 1.15 },
  'Volume Trading':   { items:['BOOSTER_COOKIE','DARK_CACAO_TRUFFLE'], effect: 1.20 },
  'Extra Event':      { items:['CANDY','GREEN_CANDY','PURPLE_CANDY','FISHING_EXPERIENCE_BOTTLE','MITHRIL'], effect: 1.15 },
  // Derpy (special) — doubles XP → doubles demand for XP items
  'Turbo-Minions I':  { items:['ENCHANTED_EGG','SUPER_EGG','OAK_LOG'], effect: 1.3 },
};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors() });

    if (url.pathname === '/bazaar')      return serveBazaar(env, ctx);
    if (url.pathname === '/mayor')       return serveMayor(env, ctx);
    if (url.pathname === '/lastUpdated') return serveLastUpdated(env);
    if (url.pathname.startsWith('/history/')) {
      const tag    = decodeURIComponent(url.pathname.slice(9));
      const period = url.searchParams.get('period') || 'month';
      return handleHistory(tag, period, env, ctx);
    }
    if (url.pathname === '/refresh') {
      if (!env.FLIPPER_CACHE) return json({ success:false, error:'KV not bound' });
      try {
        await Promise.all([refreshBazaar(env), refreshMayor(env)]);
        return json({ success:true, message:'Refreshed' });
      } catch(e) { return json({ success:false, error:e.message }); }
    }
    if (url.pathname === '/debug') {
      const hasKV = !!env.FLIPPER_CACHE;
      let bz='N/A', m='N/A';
      if (hasKV) {
        try { const v=await env.FLIPPER_CACHE.get(BZ_KEY); bz=v?`${v.length} chars`:'EMPTY'; } catch(e){bz=e.message;}
        try { const v=await env.FLIPPER_CACHE.get(MAYOR_KEY); m=v?`${v.length} chars`:'EMPTY'; } catch(e){m=e.message;}
      }
      return json({ kvBound:hasKV, bazaarCache:bz, mayorCache:m });
    }
    return json({ error:'Not found', routes:['/bazaar','/history/{tag}?period=hour|day|week|month|month3|month6','/mayor','/lastUpdated','/refresh','/debug'] }, 404);
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(Promise.all([refreshBazaar(env), refreshMayor(env)]));
  },
};

// ── Bazaar snapshot ───────────────────────────────────────────────────────────

async function serveBazaar(env, ctx) {
  if (env.FLIPPER_CACHE) {
    const c = await env.FLIPPER_CACHE.get(BZ_KEY, { type:'json' });
    if (c) return json({ ...c, cached:true });
  }
  ctx.waitUntil(refreshBazaar(env));
  return json({ success:true, loading:true, products:[], lastUpdated:0, ts:Date.now() });
}

async function refreshBazaar(env) {
  try {
    const r = await fetch('https://api.hypixel.net/v2/skyblock/bazaar', { headers:{ 'User-Agent':'sb-flipper/1.0' } });
    if (!r.ok) throw new Error('Hypixel '+r.status);
    const raw = await r.json();

    const products = [];
    for (const [id, p] of Object.entries(raw.products || {})) {
      const qs = p.quick_status;
      if (!qs || qs.buyPrice <= 0) continue;
      const buyP = qs.buyPrice, sellP = qs.sellPrice;
      const buyW = qs.buyMovingWeek || 0, sellW = qs.sellMovingWeek || 0;
      const buySummary  = (p.buy_summary  || []).slice(0,8).map(o=>({ a:Math.round(o.amount), p:r1(o.pricePerUnit), n:o.orders }));
      const sellSummary = (p.sell_summary || []).slice(0,8).map(o=>({ a:Math.round(o.amount), p:r1(o.pricePerUnit), n:o.orders }));
      const topBuy = buySummary[0]?.p || 0, topSell = sellSummary[0]?.p || 0;
      const spread = topSell > 0 && topBuy > 0 ? topSell - topBuy : 0;
      const spreadPct = topBuy > 0 ? (spread/topBuy)*100 : 0;
      const weeklyCoins = Math.min(buyW,sellW)*((buyP+sellP)/2);
      products.push({
        id,
        buyP:r1(buyP), sellP:r1(sellP), topBuy:r1(topBuy), topSell:r1(topSell),
        spread:r1(spread), spreadPct:r2(spreadPct),
        buyW, sellW,
        sellVol:qs.sellVolume||0, buyVol:qs.buyVolume||0,
        sellOrders:qs.sellOrders||0, buyOrders:qs.buyOrders||0,
        weeklyCoins:Math.round(weeklyCoins),
        buyDepth:  buySummary.reduce((s,o)=>s+o.a,0),
        sellDepth: sellSummary.reduce((s,o)=>s+o.a,0),
        momentum: r2(Math.log(Math.max(buyW,1)/Math.max(sellW,1))/Math.log(2)),
        buySummary, sellSummary,
      });
    }
    const data = { success:true, ts:Date.now(), lastUpdated:raw.lastUpdated, count:products.length, products };
    await env.FLIPPER_CACHE.put(BZ_KEY, JSON.stringify(data), { expirationTtl:KV_TTL });
    console.log('Bazaar: '+products.length);
  } catch(e) { console.error('Bazaar:',e.message); }
}

// ── Mayor ─────────────────────────────────────────────────────────────────────

async function serveMayor(env, ctx) {
  if (env.FLIPPER_CACHE) {
    const c = await env.FLIPPER_CACHE.get(MAYOR_KEY, { type:'json' });
    if (c && Date.now()-(c.ts||0) < 300000) return json({ ...c, cached:true });
  }
  try {
    const data = await refreshMayor(env);
    return json(data);
  } catch(e) { return json({ success:false, error:e.message }); }
}

async function refreshMayor(env) {
  const r = await fetch('https://api.hypixel.net/resources/skyblock/election', { headers:{'User-Agent':'sb-flipper/1.0'} });
  if (!r.ok) throw new Error('election '+r.status);
  const raw = await r.json();

  const mayorName    = raw.mayor?.name || 'Unknown';
  const mayorPerks   = (raw.mayor?.perks || []).map(p => p.name);
  const ministerName = raw.mayor?.minister?.candidate?.name || null;
  const ministerPerk = raw.mayor?.minister?.perk?.name || null;

  // Build affected items from mayor + minister perks
  const allPerks = [...mayorPerks];
  if (ministerPerk) allPerks.push(ministerPerk);

  const affectedItems = {};
  for (const perk of allPerks) {
    const effect = PERK_EFFECTS[perk];
    if (effect) {
      for (const item of effect.items) {
        affectedItems[item] = (affectedItems[item] || 1) * effect.effect;
      }
    }
  }

  // Voting closes = raw.current?.closing, mayor takes effect 1 SB year later
  // raw.current.closing is EXACTLY what Hypixel shows in-game as election end
  // Do NOT add or subtract anything — use it directly
  const rawClosing = raw.current?.closing || 0;
  // Fallback: compute from SB epoch if API doesn't give it
  const sbYearsElapsed = Math.floor((Date.now() - SB_EPOCH) / SB_YEAR_MS);
  // Election ends at Late Spring 27 = 93/124 through the SkyBlock year
  // That's 0.75 through the year (93 hours into 124 hour year)
  const sbYearStart = SB_EPOCH + sbYearsElapsed * SB_YEAR_MS;
  const computedClose = sbYearStart + Math.round(0.75 * SB_YEAR_MS); // Late Spring 27
  const votingCloses = rawClosing > Date.now() ? rawClosing : computedClose;
  const mayorEffectTs = votingCloses; // election end = mayor takes effect immediately

  const data = {
    success: true, ts: Date.now(),
    currentMayor: mayorName,
    currentPerks: mayorPerks,
    ministerName, ministerPerk,
    votingCloses,
    mayorEffectTs,   // when new mayor ACTUALLY takes effect (shown in-game)
    nextMayorTs: mayorEffectTs,  // alias used by prediction engine
    affectedItems,     // { ITEM_ID: priceMultiplier }
    candidates: (raw.current?.candidates || []).map(c => ({
      name: c.name, votes: c.votes||0,
      perks: (c.perks||[]).map(p=>p.name)
    })),
  };
  if (env.FLIPPER_CACHE) await env.FLIPPER_CACHE.put(MAYOR_KEY, JSON.stringify(data), { expirationTtl:120 });
  return data;
}

// ── lastUpdated ────────────────────────────────────────────────────────────────
async function serveLastUpdated(env) {
  if (env.FLIPPER_CACHE) {
    const c = await env.FLIPPER_CACHE.get(BZ_KEY, { type:'json' });
    if (c) return json({ lastUpdated:c.lastUpdated, ts:c.ts });
  }
  return json({ lastUpdated:0 });
}

// ── History + analytics ───────────────────────────────────────────────────────

async function handleHistory(tag, period, env, ctx) {
  const ck  = 'hist4_'+tag+'_'+period;
  const ttl = period==='hour' ? 120 : period==='day' ? 300 : 3600;

  if (env.FLIPPER_CACHE) {
    const c = await env.FLIPPER_CACHE.get(ck, { type:'json' });
    if (c && Date.now()-(c.ts||0) < ttl*1000) return json({ ...c, cached:true });
  }

  try {
    const base = 'https://sky.coflnet.com/api/bazaar/'+encodeURIComponent(tag);
    let endpoint;
    if (period === 'hour') {
      endpoint = base+'/history/hour';
    } else {
      const days = period==='day'?2 : period==='week'?7 : period==='month'?30 : period==='month3'?90 : period==='month6'?180 : 30;
      const end   = new Date();
      const start = new Date(end.getTime() - days*86400000);
      endpoint = base+'/history?start='+start.toISOString()+'&end='+end.toISOString();
    }

    const r = await fetch(endpoint, { headers:{ 'User-Agent':'sb-flipper/1.0', Accept:'application/json' } });
    if (!r.ok) throw new Error('CoflNet '+r.status);
    const raw = await r.json();

    // Parse points — handle both array formats CoflNet returns
    const points = (Array.isArray(raw) ? raw : (raw.points || raw.data || []))
      .map(p => ({
        t:  new Date(p.timestamp || p.time || p.t).getTime(),
        b:  r1(p.buy  || p.buyPrice  || p.b || 0),
        s:  r1(p.sell || p.sellPrice || p.s || 0),
        bv: p.buyVolume  || p.bv || 0,
        sv: p.sellVolume || p.sv || 0,
      }))
      .filter(p => (p.b > 0 || p.s > 0) && !isNaN(p.t))
      .sort((a,b) => a.t - b.t);

    // Get mayor data for event-aware prediction
    let mayorData = null;
    if (env.FLIPPER_CACHE) {
      try { const m = await env.FLIPPER_CACHE.get(MAYOR_KEY, {type:'json'}); if(m) mayorData=m; } catch(e){}
    }

    // Get upcoming Jacob contests
    let jacobContests = [];
    try {
      const jr = await fetch('https://jacobs.strassburger.dev/api/jacobcontests');
      if (jr.ok) jacobContests = await jr.json();
    } catch(e){}

    const analytics = computeAnalytics(points, tag, mayorData, jacobContests);
    const data = { success:true, ts:Date.now(), tag, period, points, analytics };

    if (env.FLIPPER_CACHE)
      ctx.waitUntil(env.FLIPPER_CACHE.put(ck, JSON.stringify(data), { expirationTtl:ttl }));

    return json(data);
  } catch(e) {
    return json({ success:false, error:e.message, tag, period, points:[], analytics:null });
  }
}

// ── Analytics engine ──────────────────────────────────────────────────────────

function computeAnalytics(points, tag, mayorData, jacobContests) {
  if (!points || points.length < 5) return null;

  const prices = points.map(p => p.b || p.s).filter(v => v > 0);
  const n = prices.length;
  if (n < 5) return null;

  // Basic stats
  const mean   = prices.reduce((a,b)=>a+b,0)/n;
  const sorted = [...prices].sort((a,b)=>a-b);
  const min    = sorted[0], max = sorted[n-1];
  const stdDev = Math.sqrt(prices.reduce((s,p)=>s+(p-mean)**2,0)/n);
  const current = prices[n-1];
  const zScore  = stdDev > 0 ? (current-mean)/stdDev : 0;

  // RSI (14-period)
  const rsi = computeRSI(prices, Math.min(14, Math.floor(n/4)));

  // Detect real interval between points
  const deltas = [];
  for (let i=1; i<Math.min(20,points.length); i++) deltas.push(points[i].t - points[i-1].t);
  const intervalMs = deltas.length > 0 ? deltas.reduce((a,b)=>a+b,0)/deltas.length : 3600000;
  const pointsPerDay = 86400000 / Math.max(intervalMs, 60000);

  // Slope using last 48 hourly points (or available)
  const recentN = Math.min(Math.round(48*pointsPerDay/24), n);
  const recentPrices = prices.slice(-recentN);
  const slope = linearSlope(recentPrices); // per data point
  const slopePerDay = slope * pointsPerDay;
  const volatility = mean > 0 ? (stdDev/mean)*100 : 0;

  // 10-point momentum
  const recent10 = prices.slice(-Math.min(10,n));
  const momentum10 = recent10.length>1 ? (recent10[recent10.length-1]-recent10[0])/recent10[0]*100 : 0;

  // ── Signal ────────────────────────────────────────────────────────────────
  let signal = 'HOLD', signalStrength = 0;
  if (rsi < 35 && zScore < -0.3 && momentum10 > -5) {
    signal = 'BUY';
    signalStrength = Math.min(100, Math.round((35-rsi)*2.5 + (-zScore)*25 + Math.max(0,momentum10)*2));
  }
  if (rsi > 65 && zScore > 0.3 && momentum10 < 5) {
    signal = 'SELL';
    signalStrength = Math.min(100, Math.round((rsi-65)*2.5 + zScore*25));
  }
  if (rsi < 20 && zScore < -1) { signal='BUY'; signalStrength=Math.min(100,signalStrength+20); }
  if (rsi > 80 && zScore > 1)  { signal='SELL'; signalStrength=Math.min(100,signalStrength+20); }

  // ── Hold time ─────────────────────────────────────────────────────────────
  const distToMean = mean - current;
  let holdDays = 14;
  if (Math.abs(slopePerDay) > 0.001 && Math.sign(distToMean) === Math.sign(slopePerDay))
    holdDays = Math.max(1, Math.round(Math.abs(distToMean)/Math.abs(slopePerDay)));

  // ── Event-aware prediction ────────────────────────────────────────────────
  const now = Date.now();
  const extrapolation = buildEventAwarePrediction({
    points, prices, tag, slope, intervalMs, mean, stdDev,
    mayorData, jacobContests, now, slopePerDay
  });

  return {
    mean:r1(mean), min:r1(min), max:r1(max), stdDev:r1(stdDev),
    volatility:r2(volatility), current:r1(current), zScore:r2(zScore),
    rsi:r1(rsi), slopePerDay:r4(slopePerDay), signal, signalStrength,
    holdDays, expectedReturn:r2((mean-current)/current*100),
    priceRange:r2(((max-min)/mean)*100), momentum:r2(momentum10),
    extrapolation,
    intervalMs: Math.round(intervalMs),
  };
}

// ── Event-aware prediction ──────────────────────────────────────────────────
// Uses SkyBlock seasonal pattern extraction from 6M history + event overlays
// NOT a straight line — extracts actual price cycles from the data itself

function buildEventAwarePrediction({ points, prices, tag, slope, intervalMs, mean, stdDev, mayorData, jacobContests, now, slopePerDay }) {
  const last = points[points.length - 1];
  if (!last || prices.length < 10) return [];

  const SB_YEAR_MS2 = 124 * 3600000;
  const futureDays = 30;
  const stepMs = Math.max(intervalMs, 3600000);
  const steps = Math.round(futureDays * 86400000 / stepMs);

  // ── Extract seasonal pattern binned by SkyBlock year phase ──────────────
  const NUM_BINS = 24;
  const bins = Array.from({length: NUM_BINS}, () => ({ sum: 0, count: 0 }));
  for (let i = 0; i < points.length; i++) {
    const pt = points[i];
    const price = pt.b || pt.s;
    if (price <= 0) continue;
    const sbPhase = ((pt.t - SB_EPOCH) % SB_YEAR_MS2) / SB_YEAR_MS2;
    const bin = Math.floor(sbPhase * NUM_BINS) % NUM_BINS;
    bins[bin].sum   += price / mean;
    bins[bin].count += 1;
  }
  // Fill empty bins by interpolating neighbours
  const pattern = bins.map((b, i) => {
    if (b.count > 0) return b.sum / b.count;
    for (let d = 1; d < NUM_BINS; d++) {
      const prev = bins[(i - d + NUM_BINS) % NUM_BINS];
      const next = bins[(i + d) % NUM_BINS];
      if (prev.count > 0 && next.count > 0) return (prev.sum/prev.count + next.sum/next.count) / 2;
      if (prev.count > 0) return prev.sum / prev.count;
      if (next.count > 0) return next.sum / next.count;
    }
    return 1.0;
  });

  // ── Long-term trend from last 90 days ─────────────────────────────────────
  const recentN = Math.min(prices.length, Math.round(90 * 86400000 / intervalMs));
  const longSlope = linearSlope(prices.slice(-recentN));

  // ── Event boost function ──────────────────────────────────────────────────
  const getEventBoost = (ts) => {
    let boost = 0;
    // Jacob contests — crops spike ±2h around contest
    if (jacobContests) {
      const CROP_IDS2 = {
        'Wheat':'WHEAT','Carrot':'CARROT_ITEM','Potato':'POTATO_ITEM',
        'Sugar Cane':'SUGAR_CANE','Pumpkin':'PUMPKIN','Melon':'MELON',
        'Cactus':'CACTUS','Cocoa Beans':'COCOA_BEANS','Mushroom':'MUSHROOM_COLLECTION',
        'Nether Wart':'NETHER_STALK','Sunflower':'SUNFLOWER','Moonflower':'MOONFLOWER',
      };
      for (const ct of jacobContests) {
        if (ts >= ct.timestamp - 7200000 && ts <= ct.timestamp + 20*60000 + 7200000) {
          for (const cropName of (ct.cropNames||[])) {
            const id = CROP_IDS2[cropName];
            if (id && tag.includes(id.split('_')[0])) boost += 0.25;
          }
        }
      }
    }
    // Mayor effects — fade out after mayor changes
    if (mayorData?.affectedItems?.[tag]) {
      const m = mayorData.affectedItems[tag];
      const daysUntil = mayorData.nextMayorTs > 0 ? (mayorData.nextMayorTs - ts) / 86400000 : 99;
      const w = daysUntil > 0 ? 1.0 : Math.max(0, 1 + daysUntil / 14);
      boost += (m - 1.0) * w;
    }
    // Annual SkyBlock events
    const sbYear2 = Math.floor((ts - SB_EPOCH) / SB_YEAR_MS2);
    const sbYearStart2 = SB_EPOCH + sbYear2 * SB_YEAR_MS2;
    const sbDay2 = Math.floor((ts - sbYearStart2) / SB_DAY_MS) + 1;
    for (const evt of ANNUAL_EVENTS) {
      if (sbDay2 >= evt.sbDayStart && sbDay2 <= evt.sbDayEnd) {
        if (evt.items.some(id => tag.includes(id.split('_')[0]) || id.includes(tag.split('_')[0]))) {
          boost += evt.effect - 1.0;
        }
      }
    }
    return boost;
  };

  // ── Project forward: trend + seasonal + events + momentum ────────────────
  const lastPrices = prices.slice(-5);
  const momentum0 = lastPrices.length > 1
    ? (lastPrices[lastPrices.length-1] - lastPrices[0]) / lastPrices.length : 0;

  const result = [];
  let trendOffset = 0;
  let momentum = momentum0;
  let lastPrice = last.b || last.s || mean;

  for (let i = 1; i <= steps; i++) {
    const ts = last.t + i * stepMs;
    trendOffset += longSlope;
    const sbPhase = ((ts - SB_EPOCH) % SB_YEAR_MS2) / SB_YEAR_MS2;
    const bin = Math.floor(sbPhase * NUM_BINS) % NUM_BINS;
    const seasonal = pattern[bin];
    const boost = getEventBoost(ts);
    const baseMean = mean + trendOffset;
    const target = baseMean * seasonal * (1 + boost);
    momentum *= 0.85;
    const pull = (target - lastPrice) * 0.08;
    const noise = (Math.random() - 0.5) * stdDev * 0.015;
    lastPrice = lastPrice + momentum + pull + noise;
    if (lastPrice > 0) result.push({ t: ts, b: r1(lastPrice), s: r1(lastPrice*0.97), eventMult: r2(seasonal*(1+boost)) });
  }
  return result;
}

// ── Math helpers ──────────────────────────────────────────────────────────────

function computeRSI(prices, period) {
  if (prices.length < period+1) return 50;
  let gains=0, losses=0;
  for (let i=1; i<=period; i++) {
    const d = prices[i]-prices[i-1];
    if (d>0) gains+=d; else losses-=d;
  }
  let ag = gains/period, al = losses/period;
  for (let i=period+1; i<prices.length; i++) {
    const d = prices[i]-prices[i-1];
    ag = (ag*(period-1)+Math.max(0,d))/period;
    al = (al*(period-1)+Math.max(0,-d))/period;
  }
  return al===0 ? 100 : 100 - 100/(1+ag/al);
}

function linearSlope(values) {
  const n = values.length;
  if (n<2) return 0;
  const xm=(n-1)/2, ym=values.reduce((a,b)=>a+b,0)/n;
  let num=0, den=0;
  for (let i=0;i<n;i++) { num+=(i-xm)*(values[i]-ym); den+=(i-xm)**2; }
  return den===0 ? 0 : num/den;
}

const r1=v=>Math.round(v*10)/10;
const r2=v=>Math.round(v*100)/100;
const r4=v=>Math.round(v*10000)/10000;

function json(d,s=200){
  return new Response(JSON.stringify(d),{status:s,headers:{'Content-Type':'application/json',...cors()}});
}
function cors(){
  return {'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'GET,OPTIONS','Access-Control-Allow-Headers':'Content-Type'};
}