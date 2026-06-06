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
  const votingCloses = raw.current?.closing || 0;

  const data = {
    success: true, ts: Date.now(),
    currentMayor: mayorName,
    currentPerks: mayorPerks,
    ministerName, ministerPerk,
    votingCloses,
    nextMayorTs: votingCloses > 0 ? votingCloses + SB_YEAR_MS : 0,
    affectedItems,     // { ITEM_ID: priceMultiplier }
    candidates: (raw.current?.candidates || []).map(c => ({
      name: c.name, votes: c.votes||0,
      perks: (c.perks||[]).map(p=>p.name)
    })),
  };
  if (env.FLIPPER_CACHE) await env.FLIPPER_CACHE.put(MAYOR_KEY, JSON.stringify(data), { expirationTtl:300 });
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

// ── Event-aware prediction ────────────────────────────────────────────────────

function buildEventAwarePrediction({ points, prices, tag, slope, intervalMs, mean, stdDev, mayorData, jacobContests, now, slopePerDay }) {
  const last = points[points.length-1];
  if (!last) return [];

  // Project 30 days into the future at hourly intervals
  const futureDays = 30;
  const steps = Math.round(futureDays * 86400000 / Math.max(intervalMs, 3600000));
  const stepMs = Math.max(intervalMs, 3600000);

  // Build event multiplier timeline
  // Returns a multiplier for each future timestep
  const getEventMultiplier = (ts) => {
    let mult = 1.0;

    // 1. SkyBlock calendar events (Spooky, Fishing Festival, etc.)
    const sbYear = Math.floor((ts - SB_EPOCH) / SB_YEAR_MS);
    const sbYearStart = SB_EPOCH + sbYear * SB_YEAR_MS;
    const sbDayOfYear = Math.floor((ts - sbYearStart) / SB_DAY_MS) + 1;

    for (const evt of ANNUAL_EVENTS) {
      if (sbDayOfYear >= evt.sbDayStart && sbDayOfYear <= evt.sbDayEnd) {
        if (evt.items.some(i => tag.includes(i) || i.includes(tag))) {
          mult *= evt.effect;
        }
      }
    }

    // 2. Jacob's contests — crop items spike during contests
    if (jacobContests && jacobContests.length > 0) {
      const CROP_IDS = {
        'Wheat':'WHEAT', 'Carrot':'CARROT_ITEM', 'Potato':'POTATO_ITEM',
        'Sugar Cane':'SUGAR_CANE', 'Pumpkin':'PUMPKIN', 'Melon':'MELON',
        'Cactus':'CACTUS', 'Cocoa Beans':'COCOA_BEANS', 'Mushroom':'MUSHROOM_COLLECTION',
        'Nether Wart':'NETHER_STALK', 'Sunflower':'SUNFLOWER', 'Moonflower':'MOONFLOWER',
        'Wild Rose':'WILD_ROSE',
      };
      for (const contest of jacobContests) {
        const cStart = contest.timestamp, cEnd = cStart + 20*60000; // 20 min contest
        if (ts >= cStart - 3600000 && ts <= cEnd + 3600000) { // 1h before+after
          for (const cropName of (contest.cropNames || [])) {
            const cropId = CROP_IDS[cropName];
            if (cropId && (tag === cropId || tag.includes(cropId))) {
              mult *= 1.25; // crops spike ~25% around contests
            }
          }
        }
      }
    }

    // 3. Mayor/minister effects
    if (mayorData && mayorData.affectedItems) {
      const m = mayorData.affectedItems[tag];
      if (m) mult *= m;
      // Taper effect as we get further from current mayor
      // Mayor changes at nextMayorTs
      if (mayorData.nextMayorTs > 0 && ts > mayorData.nextMayorTs) {
        // After mayor change, revert gradually
        const daysAfter = (ts - mayorData.nextMayorTs) / 86400000;
        const revertFactor = Math.max(0, 1 - daysAfter/14); // 2 week revert
        mult = 1.0 + (mult-1.0)*revertFactor;
      }
    }

    return mult;
  };

  // Mean-reversion model with event multipliers
  // Price tends toward (mean * eventMult) with reversion speed based on volatility
  const reversionSpeed = 0.05; // 5% of distance per step
  const result = [];
  let projPrice = last.b || last.s || mean;
  let projSell  = last.s || last.b || mean * 0.97;

  for (let i = 1; i <= steps; i++) {
    const ts   = last.t + i * stepMs;
    const mult = getEventMultiplier(ts);
    const target = mean * mult;

    // Mean reversion + trend component
    const reversion  = (target - projPrice) * reversionSpeed;
    const trendComp  = slopePerDay * (stepMs / 86400000);
    // Add some noise based on volatility (dampened)
    const noise = (Math.random() - 0.5) * stdDev * 0.02;

    projPrice = projPrice + reversion + trendComp * 0.3 + noise;
    projSell  = projPrice * 0.97; // sell price ~3% below buy

    if (projPrice > 0) {
      result.push({
        t: ts,
        b: r1(projPrice),
        s: r1(projSell),
        eventMult: r2(mult),
      });
    }
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