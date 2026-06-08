// sb-flipper Investment Worker v4 — comprehensive event-aware prediction

const BZ_KEY    = 'bz_v4';
const MAYOR_KEY = 'mayor_v4';
const KV_TTL    = 130;

// ── SkyBlock calendar constants ───────────────────────────────────────────────
const SB_EPOCH   = 1560275700000; // calibrated epoch (election timing accurate)
const SB_YEAR_MS = 446400000;     // 124 real hours × 3600000
const SB_DAY_MS  = 1200000;       // 20 real minutes per SkyBlock day = 1 ingame day
// 12 months × 31 days = 372 ingame days per year.
// The SB YEAR BOUNDARY (day 1, month 1) falls 1d 5h 20m BEFORE the mayor changes.
// Mayor changes at electionClosing. So calendar-day-1 = electionClosing - YEAR_BOUNDARY_OFFSET.
const YEAR_BOUNDARY_OFFSET = (24 + 5) * 3600000 + 20 * 60000; // 1d 5h 20m = 105600000ms

// Given a timestamp and the current electionClosing, return {month(1-12), day(1-31), dayOfYear(1-372)}
function sbCalendar(ts, electionClosing) {
  // Year boundary (day 1, month 1) = electionClosing - 1d5h20m. Fall back to epoch.
  let boundary = (electionClosing || 0) - YEAR_BOUNDARY_OFFSET;
  if (!boundary) boundary = SB_EPOCH;
  let yearsOff = Math.floor((ts - boundary) / SB_YEAR_MS);
  const yearStart = boundary + yearsOff * SB_YEAR_MS;
  let dayOfYear = Math.floor((ts - yearStart) / SB_DAY_MS); // 0-371
  dayOfYear = ((dayOfYear % 372) + 372) % 372;
  const month = Math.floor(dayOfYear / 31) + 1; // 1-12
  const day   = (dayOfYear % 31) + 1;           // 1-31
  return { month, day, dayOfYear: dayOfYear + 1, yearStart, intoDayMs: ((ts - yearStart) % SB_DAY_MS + SB_DAY_MS) % SB_DAY_MS };
}
function sbDayOfYear(ts, ec) { return sbCalendar(ts, ec).dayOfYear; }

// ── Perk → continuous market effects (persistent throughout the mayor term) ───
const PERK_MARKET = {
  'GOATed':             { items:['WHEAT','POTATO_ITEM','CARROT_ITEM','SUGAR_CANE','PUMPKIN','MELON','CACTUS','COCOA_BEANS','NETHER_STALK','MUSHROOM_COLLECTION'], price:0.82 },
  'Blooming Business':  { items:['WHEAT','POTATO_ITEM','CARROT_ITEM','SUGAR_CANE','PUMPKIN','MELON'], price:0.85 },
  'Pelt-pocalypse':     { items:['FUR','PELT','RABBIT_FOOT'], price:0.80 },
  'Prospection':        { items:['MITHRIL_ORE','COAL','IRON_INGOT','GOLD_INGOT','DIAMOND','EMERALD','LAPIS_LAZULI','REDSTONE','QUARTZ','GEMSTONE'], price:0.82 },
  'Molten Forge':       { items:['ENCHANTED_IRON_BLOCK','ENCHANTED_GOLD_BLOCK','ENCHANTED_DIAMOND','HARD_STONE'], price:0.84 },
  'Luck of the Sea 2.0':{ items:['RAW_FISH','TROPHY_FISH','SEA_CREATURE_BAIT'], price:0.88 },
  'SLASHED Pricing':    { items:['CORRUPTED_FRAGMENT','WITHER_ESSENCE','SPIDER_CATALYST','REVENANT_FLESH'], price:0.85 },
  'Pathfinder':         { items:['REVENANT_FLESH','TARANTULA_SILK','WOLF_TOOTH','VOIDLING_NUCLEUS'], price:0.88 },
  'Darker Auctions':    { items:['SCYTHE_BLADE','WITHER_BLOOD','SHADOW_ASSASSIN_CLOAK','SHADOW_FURY'], price:1.30 },
  'Shopping Spree':     { items:['BOOSTER_COOKIE','DUNGEON_ORBS','BEACON'], price:1.20 },
  'Pet XP Buff':        { items:['PET_ITEM_TIER_BOOST','EXP_BOTTLE','GRAND_EXP_BOTTLE','TITANIC_EXP_BOTTLE'], price:1.15 },
};

// Items affected by each perk-conditional special event
const EVENT_ITEMS = {
  spooky:      ['CANDY','GREEN_CANDY','PURPLE_CANDY','JACK_O_LANTERN','SPOOKY_FRAGMENT','PUMPKIN'],
  jerry:       ['JERRY_BOX_GREEN','JERRY_BOX_BLUE','JERRY_BOX_PURPLE','JERRY_BOX_GOLDEN','SNOWBALL','WHITE_GIFT','GREEN_GIFT'],
  mythological:['GRIFFIN_FEATHER','MINOS_RELIC','CHIMERA','MAGICAL_MUSHROOM_SOUP','ANCIENT_CLAW','MINOTAUR','GRIFFIN'],
  fishing:     ['RAW_FISH','SPONGE','SHARK_FIN','PUFFERFISH','LILY_PAD','MAGMA_FISH','ICE_FISH'],
  mining:      ['MITHRIL_ORE','COAL','IRON_INGOT','GOLD_INGOT','DIAMOND','EMERALD','REDSTONE','LAPIS_LAZULI','HARD_STONE','GEMSTONE_POWDER'],
  stonk:       ['BOOSTER_COOKIE','STOCK_OF_STONKS','DARK_CACAO_TRUFFLE'],
  // Crops for Jacob/Starlyn contests
  crops:       ['WHEAT','CARROT_ITEM','POTATO_ITEM','SUGAR_CANE','PUMPKIN','MELON','CACTUS','COCOA_BEANS','MUSHROOM_COLLECTION','NETHER_STALK'],
};

// Returns true if a given perk name is currently active (mayor OR minister)
function hasPerk(mayorData, perkName) {
  return mayorData && Array.isArray(mayorData.activePerks) && mayorData.activePerks.includes(perkName);
}
// Returns true if a named candidate currently holds office (mayor or minister)
function holdsOffice(mayorData, name) {
  if (!mayorData) return false;
  return mayorData.currentMayor === name || mayorData.ministerName === name;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return new Response(null, {headers:cors()});
    if (url.pathname === '/bazaar')      return serveBazaar(env, ctx);
    if (url.pathname === '/mayor')       return serveMayor(env, ctx);
    if (url.pathname === '/lastUpdated') return serveLastUpdated(env);
    if (url.pathname.startsWith('/history/')) {
      const tag    = decodeURIComponent(url.pathname.slice(9));
      const period = url.searchParams.get('period') || 'month';
      return handleHistory(tag, period, env, ctx);
    }
    if (url.pathname === '/refresh') {
      if (!env.FLIPPER_CACHE) return json({success:false,error:'KV not bound'});
      try { await Promise.all([refreshBazaar(env), refreshMayor(env)]); return json({success:true}); }
      catch(e) { return json({success:false,error:e.message}); }
    }
    if (url.pathname === '/debug') {
      const hasKV = !!env.FLIPPER_CACHE;
      let bz='N/A', m='N/A';
      if (hasKV) {
        try { const v=await env.FLIPPER_CACHE.get(BZ_KEY); bz=v?v.length+'c':'EMPTY'; } catch(e){ bz=e.message; }
        try { const v=await env.FLIPPER_CACHE.get(MAYOR_KEY); m=v?v.length+'c':'EMPTY'; } catch(e){ m=e.message; }
      }
      return json({kvBound:hasKV, bazaarCache:bz, mayorCache:m});
    }
    return json({error:'Not found',routes:['/bazaar','/history/{tag}','/mayor','/lastUpdated','/refresh','/debug']},404);
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(Promise.all([refreshBazaar(env), refreshMayor(env)]));
  },
};

// ── Bazaar snapshot ───────────────────────────────────────────────────────────
async function serveBazaar(env, ctx) {
  if (env.FLIPPER_CACHE) { const c=await env.FLIPPER_CACHE.get(BZ_KEY,{type:'json'}); if(c) return json({...c,cached:true}); }
  ctx.waitUntil(refreshBazaar(env));
  return json({success:true,loading:true,products:[],lastUpdated:0,ts:Date.now()});
}
async function refreshBazaar(env) {
  try {
    const r = await fetch('https://api.hypixel.net/v2/skyblock/bazaar',{headers:{'User-Agent':'sb-flipper/1.0'}});
    if (!r.ok) throw new Error('Hypixel '+r.status);
    const raw = await r.json();
    const products = [];
    for (const [id,p] of Object.entries(raw.products||{})) {
      const qs=p.quick_status; if(!qs||qs.buyPrice<=0) continue;
      const bS=(p.buy_summary||[]).slice(0,8).map(o=>({a:Math.round(o.amount),p:r1(o.pricePerUnit),n:o.orders}));
      const sS=(p.sell_summary||[]).slice(0,8).map(o=>({a:Math.round(o.amount),p:r1(o.pricePerUnit),n:o.orders}));
      products.push({id, buyP:r1(qs.buyPrice), sellP:r1(qs.sellPrice),
        topBuy:r1(bS[0]?.p||0), topSell:r1(sS[0]?.p||0),
        spread:r1((sS[0]?.p||0)-(bS[0]?.p||0)),
        spreadPct:r2(qs.buyPrice>0?(((sS[0]?.p||0)-(bS[0]?.p||0))/qs.buyPrice*100):0),
        buyW:qs.buyMovingWeek||0, sellW:qs.sellMovingWeek||0,
        sellVol:qs.sellVolume||0, buyVol:qs.buyVolume||0,
        sellOrders:qs.sellOrders||0, buyOrders:qs.buyOrders||0,
        weeklyCoins:Math.round(Math.min(qs.buyMovingWeek,qs.sellMovingWeek)*((qs.buyPrice+qs.sellPrice)/2)),
        buyDepth:bS.reduce((s,o)=>s+o.a,0), sellDepth:sS.reduce((s,o)=>s+o.a,0),
        momentum:r2(Math.log(Math.max(qs.buyMovingWeek,1)/Math.max(qs.sellMovingWeek,1))/Math.log(2)),
        buySummary:bS, sellSummary:sS });
    }
    const data={success:true,ts:Date.now(),lastUpdated:raw.lastUpdated,count:products.length,products};
    await env.FLIPPER_CACHE.put(BZ_KEY,JSON.stringify(data),{expirationTtl:KV_TTL});
    console.log('Bazaar:'+products.length);
  } catch(e){ console.error('Bazaar:',e.message); }
}

// ── Mayor ─────────────────────────────────────────────────────────────────────
async function serveMayor(env, ctx) {
  if (env.FLIPPER_CACHE) {
    const c=await env.FLIPPER_CACHE.get(MAYOR_KEY,{type:'json'});
    if (c&&Date.now()-(c.ts||0)<60000) return json({...c,cached:true});
  }
  try { return json(await refreshMayor(env)); }
  catch(e) { return json({success:false,error:e.message}); }
}
async function refreshMayor(env) {
  const r = await fetch('https://api.hypixel.net/resources/skyblock/election',{headers:{'User-Agent':'sb-flipper/1.0'}});
  if (!r.ok) throw new Error('election '+r.status);
  const raw = await r.json();

  const mayorName    = raw.mayor?.name || 'Unknown';
  const mayorPerks   = (raw.mayor?.perks||[]).map(p=>p.name);
  const ministerName = raw.mayor?.minister?.candidate?.name || null;
  const ministerPerk = raw.mayor?.minister?.perk?.name || null;

  // All active perks (mayor + minister)
  const activePerks = [...mayorPerks];
  if (ministerPerk) activePerks.push(ministerPerk);

  // Build per-item price multipliers from all active perks
  const itemEffects = {};
  const perkReasons = {}; // item → which perk caused it
  for (const perk of activePerks) {
    const effect = PERK_MARKET[perk];
    if (!effect) continue;
    for (const item of effect.items) {
      const prev = itemEffects[item] || 1.0;
      itemEffects[item] = prev * effect.price;
      perkReasons[item] = (perkReasons[item]||[]);
      perkReasons[item].push({perk, price:effect.price});
    }
  }

  // Election timing — use raw API closing directly (no arithmetic)
  // Election ends at Late Spring 27th 00:00 (SB day 89) each SkyBlock year.
  // The Hypixel API 'closing' field is unreliable, so compute from the SB calendar.
  // Months: Early Spring(1) ... Late Spring(3) ... so Late Spring 27 = (3-1)*31 + 27 = day 89.
  // 00:00 of day 89 = offset of 88 full SB days from year start.
  const ELECTION_DAY = 89;
  const nowForElection = Date.now();
  const elecYear = Math.floor((nowForElection - SB_EPOCH) / SB_YEAR_MS);
  const elecYearStart = SB_EPOCH + elecYear * SB_YEAR_MS;
  let electionClosing = elecYearStart + (ELECTION_DAY - 1) * SB_DAY_MS;
  if (electionClosing <= nowForElection) electionClosing += SB_YEAR_MS; // next year's election
  // If the API gives a closing value that's in the future and sooner, trust it (more precise)
  const apiClosing = raw.current?.closing || 0;
  if (apiClosing > nowForElection && apiClosing < electionClosing) electionClosing = apiClosing;

  // Candidates with their perks
  const candidates = (raw.current?.candidates||[]).map(c=>({
    name:c.name, votes:c.votes||0,
    perks:(c.perks||[]).map(p=>p.name),
  }));

  // Leading candidate's predicted perks (if elected) → pre-compute market impact
  const sortedCands = [...candidates].sort((a,b)=>b.votes-a.votes);
  const leadingCandidate = sortedCands[0]?.name || null;
  const leadingPerks = sortedCands[0]?.perks || [];
  const futureItemEffects = {};
  for (const perk of leadingPerks) {
    const effect = PERK_MARKET[perk];
    if (!effect) continue;
    for (const item of effect.items) {
      futureItemEffects[item] = (futureItemEffects[item]||1.0) * effect.price;
    }
  }

  const data = {
    success:true, ts:Date.now(),
    currentMayor:mayorName, currentPerks:mayorPerks,
    ministerName, ministerPerk, activePerks,
    itemEffects,     // current effects
    perkReasons,     // why each item is affected
    electionClosing, // exact ts when election ends = new mayor takes effect
    candidates, leadingCandidate, leadingPerks,
    futureItemEffects, // predicted effects if leading candidate wins
  };
  if (env.FLIPPER_CACHE) await env.FLIPPER_CACHE.put(MAYOR_KEY,JSON.stringify(data),{expirationTtl:60});
  return data;
}

// ── lastUpdated ───────────────────────────────────────────────────────────────
async function serveLastUpdated(env) {
  if (env.FLIPPER_CACHE) { const c=await env.FLIPPER_CACHE.get(BZ_KEY,{type:'json'}); if(c) return json({lastUpdated:c.lastUpdated,ts:c.ts}); }
  return json({lastUpdated:0});
}

// ── History + analytics ───────────────────────────────────────────────────────
async function handleHistory(tag, period, env, ctx) {
  const ck = 'hist6_'+tag+'_'+period;
  const ttl = period==='hour'?120 : period==='day'?300 : 3600;
  if (env.FLIPPER_CACHE) {
    const c=await env.FLIPPER_CACHE.get(ck,{type:'json'});
    if (c&&Date.now()-(c.ts||0)<ttl*1000) return json({...c,cached:true});
  }
  try {
    const base = 'https://sky.coflnet.com/api/bazaar/'+encodeURIComponent(tag);
    let endpoint;
    // CoflNet dedicated endpoints return finer resolution than the date-range endpoint:
    //  /history/hour  → last 1h  (~20s-1min points)
    //  /history/day   → last 24h (~5min points)
    //  /history/week  → last 7d  (~hourly points)
    //  /history?start&end → custom range but DAILY aggregates for long spans
    if (period==='hour')      endpoint = base+'/history/hour';
    else if (period==='day')  endpoint = base+'/history/day';
    else if (period==='week') endpoint = base+'/history/week';
    else {
      // month/3m/6m: date-range endpoint (daily resolution is all CoflNet has for old data)
      const days = period==='month'?30:period==='month3'?90:period==='month6'?180:30;
      const end=new Date(), start=new Date(end.getTime()-days*86400000);
      endpoint = base+'/history?start='+start.toISOString()+'&end='+end.toISOString();
    }
    const r=await fetch(endpoint,{headers:{'User-Agent':'sb-flipper/1.0',Accept:'application/json'}});
    if (!r.ok) throw new Error('CoflNet '+r.status);
    const raw=await r.json();
    const rawArr = Array.isArray(raw)?raw:(raw.points||raw.data||raw.prices||[]);
    let points = rawArr
      .map(p=>({
        t:new Date(p.timestamp||p.time||p.t||0).getTime(),
        b:r1(p.buy||p.buyPrice||p.b||p.avg||0),
        s:r1(p.sell||p.sellPrice||p.s||0),
        bv:p.buyVolume||p.bv||p.volume||0, sv:p.sellVolume||p.sv||0,
      }))
      .filter(p=>(p.b>0||p.s>0)&&p.t>0).sort((a,b)=>a.t-b.t);

    // Resample only to smooth — use the source resolution, don't force coarser
    //  hour=1min, day=5min, week=20min, month+=hourly(or daily if that's all there is)
    const targetInterval = period==='hour' ? 60000
                         : period==='day'  ? 300000
                         : period==='week' ? 1200000
                         : 3600000;
    points = resample(points, targetInterval);

    // Get mayor + Jacob data for analytics
    let mayorData=null, jacobContests=[];
    if (env.FLIPPER_CACHE) {
      try { const m=await env.FLIPPER_CACHE.get(MAYOR_KEY,{type:'json'}); if(m) mayorData=m; } catch(e){}
    }
    try { const jr=await fetch('https://jacobs.strassburger.dev/api/jacobcontests'); if(jr.ok) jacobContests=await jr.json(); } catch(e){}

    const analytics = computeAnalytics(points, tag, mayorData, jacobContests, period);
    const data={success:true,ts:Date.now(),tag,period,points,analytics};
    if (env.FLIPPER_CACHE) ctx.waitUntil(env.FLIPPER_CACHE.put(ck,JSON.stringify(data),{expirationTtl:ttl}));
    return json(data);
  } catch(e) {
    return json({success:false,error:e.message,tag,period,points:[],analytics:null});
  }
}

// Resample points to a fixed interval by bucketing and averaging
function resample(points, intervalMs) {
  if (points.length === 0) return points;
  const buckets = new Map();
  for (const p of points) {
    const bucket = Math.floor(p.t / intervalMs) * intervalMs;
    if (!buckets.has(bucket)) buckets.set(bucket, { t:bucket, bSum:0, sSum:0, bvSum:0, svSum:0, count:0 });
    const b = buckets.get(bucket);
    b.bSum += p.b; b.sSum += p.s; b.bvSum += p.bv; b.svSum += p.sv; b.count++;
  }
  return [...buckets.values()].map(b => ({
    t: b.t,
    b: r1(b.bSum / b.count),
    s: r1(b.sSum / b.count),
    bv: Math.round(b.bvSum / b.count),
    sv: Math.round(b.svSum / b.count),
  })).sort((a,b)=>a.t-b.t);
}

// ── Analytics ─────────────────────────────────────────────────────────────────
function computeAnalytics(points, tag, mayorData, jacobContests, period) {
  if (!points||points.length<5) return null;
  const prices = points.map(p=>p.b||p.s).filter(v=>v>0);
  if (prices.length<5) return null;
  const n=prices.length;
  const mean=prices.reduce((a,b)=>a+b,0)/n;
  const sorted=[...prices].sort((a,b)=>a-b);
  const min=sorted[0], max=sorted[n-1];
  const stdDev=Math.sqrt(prices.reduce((s,p)=>s+(p-mean)**2,0)/n);
  const current=prices[n-1];
  const zScore=stdDev>0?(current-mean)/stdDev:0;
  const rsi=computeRSI(prices,Math.min(14,Math.floor(n/4)));
  const recent10=prices.slice(-Math.min(10,n));
  const momentum=recent10.length>1?(recent10[recent10.length-1]-recent10[0])/recent10[0]*100:0;
  const volatility=mean>0?(stdDev/mean)*100:0;

  // Detect data interval
  const deltas=[];
  for(let i=1;i<Math.min(20,points.length);i++) deltas.push(points[i].t-points[i-1].t);
  const intervalMs=deltas.length?deltas.reduce((a,b)=>a+b,0)/deltas.length:3600000;
  const pointsPerDay=86400000/Math.max(intervalMs,60000);

  // Slope from last 30% of data
  const recentN=Math.max(5,Math.round(n*0.3));
  const slopePerPoint=linearSlope(prices.slice(-recentN));
  const slopePerDay=slopePerPoint*pointsPerDay;

  // Signal
  let signal='HOLD', signalStrength=0;
  if(rsi<35&&zScore<-0.3&&momentum>-5){ signal='BUY'; signalStrength=Math.min(100,Math.round((35-rsi)*2.5+(-zScore)*25+Math.max(0,momentum)*2)); }
  if(rsi>65&&zScore>0.3&&momentum<5){ signal='SELL'; signalStrength=Math.min(100,Math.round((rsi-65)*2.5+zScore*25)); }
  if(rsi<20&&zScore<-1){ signal='BUY'; signalStrength=Math.min(100,signalStrength+20); }
  if(rsi>80&&zScore>1){ signal='SELL'; signalStrength=Math.min(100,signalStrength+20); }

  const distToMean=mean-current;
  let holdDays=14;
  if(Math.abs(slopePerDay)>0.001&&Math.sign(distToMean)===Math.sign(slopePerDay))
    holdDays=Math.max(1,Math.round(Math.abs(distToMean)/Math.abs(slopePerDay)));

  const extrapolation = buildPrediction(points, prices, tag, mean, stdDev, slopePerPoint, intervalMs, mayorData, jacobContests, period);

  return {
    mean:r1(mean),min:r1(min),max:r1(max),stdDev:r1(stdDev),
    volatility:r2(volatility),current:r1(current),zScore:r2(zScore),
    rsi:r1(rsi),slopePerDay:r4(slopePerDay),signal,signalStrength,
    holdDays,expectedReturn:r2((mean-current)/current*100),
    priceRange:r2(((max-min)/mean)*100),momentum:r2(momentum),
    extrapolation, intervalMs:Math.round(intervalMs),
  };
}

// ── Prediction engine ─────────────────────────────────────────────────────────
// Multi-model blend:
// 1. Dominant-cycle sine projection (from autocorrelation)
// 2. Seasonal pattern from SkyBlock year bins (for event-driven items)
// 3. Long-term linear trend
// 4. Event impulse responses (sharp spike then revert)
// 5. Correlated random walk (volatility-scaled, not white noise)

function buildPrediction(points, prices, tag, mean, stdDev, slopePerPoint, intervalMs, mayorData, jacobContests, period) {
  const last = points[points.length - 1];
  if (!last || prices.length < 10) return [];

  // 1h period predicts at 5-min resolution; all others at 20-min, output hourly
  // Per-period DISPLAY resolution (the visible spacing of prediction points):
  //  1h→1min, 1d→5min, 1w/1m→1hr, 3m→8hr, 6m→24hr
  // Internally we always step at 20min (5min for 1h) for event precision, but only
  // OUTPUT points at the display interval so the line looks right for the timeframe.
  const stepMs = period==='hour' ? 300000 : 1200000; // 5min for 1h, else 20min
  const displayIntervalMs = ({
    hour:60000, day:300000, week:3600000, month:3600000, month3:8*3600000, month6:24*3600000
  })[period] || 3600000;
  const outputEvery = Math.max(1, Math.round(displayIntervalMs / stepMs));
  // How far ahead to predict: enough to fill the timeframe's forward view
  const futureDays = period==='hour' ? 1 : period==='day' ? 2 : 30;
  const steps = Math.round(futureDays * 86400000 / stepMs);

  // ── Separate buy & sell price series ──────────────────────────────────────
  const buyPrices  = points.map(p => p.b).filter(v => v > 0);
  const sellPrices = points.map(p => p.s).filter(v => v > 0);
  const buyMean  = buyPrices.length  ? buyPrices.reduce((a,b)=>a+b,0)/buyPrices.length   : mean;
  const sellMean = sellPrices.length ? sellPrices.reduce((a,b)=>a+b,0)/sellPrices.length : mean*0.95;
  // Historical buy/sell ratio — used to keep prediction spread realistic
  const buySellRatio = buyMean > 0 ? sellMean / buyMean : 0.95;
  // Spread volatility — how much the spread itself varies
  const spreadSamples = [];
  for (const pt of points) if (pt.b > 0 && pt.s > 0) spreadSamples.push(pt.s / pt.b);
  const spreadMean = spreadSamples.length ? spreadSamples.reduce((a,b)=>a+b,0)/spreadSamples.length : buySellRatio;
  const spreadStd  = spreadSamples.length > 1
    ? Math.sqrt(spreadSamples.reduce((s,v)=>s+(v-spreadMean)**2,0)/spreadSamples.length) : 0.01;

  // ── Model 1: Dominant cycle from autocorrelation ──────────────────────────
  // Scan lags from 1h to 1 SkyBlock year to find the dominant price cycle
  const maxLagSteps = Math.round(SB_YEAR_MS / stepMs);  // ~372 steps = 1 SB year
  let bestCycleSteps = 0, bestCorr = -Infinity;
  const n = prices.length;
  // Subsample prices to step resolution for autocorrelation
  const subsample = Math.max(1, Math.round(intervalMs / stepMs));
  const subPrices = prices.filter((_, i) => i % subsample === 0);
  const subN = subPrices.length;
  const subMean = subPrices.reduce((a,b)=>a+b,0)/subN;
  const centred = subPrices.map(p => p - subMean);

  for (let lag = 3; lag <= Math.min(maxLagSteps, subN-1); lag += Math.max(1, Math.floor(lag/10))) {
    let corr = 0, denom = 0;
    for (let i = lag; i < subN; i++) {
      corr  += centred[i] * centred[i-lag];
      denom += centred[i] * centred[i];
    }
    if (denom > 0) { const r = corr/denom; if (r > bestCorr) { bestCorr=r; bestCycleSteps=lag; } }
  }

  // Cycle amplitude: std dev of the cyclic component
  const cycleAmp = bestCorr > 0.15 && bestCycleSteps > 0
    ? Math.min(stdDev * Math.sqrt(bestCorr) * 0.4, mean * 0.15)
    : 0;

  // Current phase of detected cycle
  const cyclePhaseOffset = bestCycleSteps > 0
    ? (subN % bestCycleSteps) / bestCycleSteps * 2 * Math.PI
    : 0;

  // ── Model 2: SkyBlock seasonal pattern (16 bins) ──────────────────────────
  const NUM_BINS = 16;
  const bins = Array.from({length: NUM_BINS}, () => ({vals:[]}));
  for (const pt of points) {
    const price = pt.b || pt.s; if (price <= 0) continue;
    const phase = ((pt.t - SB_EPOCH) % SB_YEAR_MS + SB_YEAR_MS) % SB_YEAR_MS / SB_YEAR_MS;
    const bin   = Math.min(NUM_BINS-1, Math.floor(phase * NUM_BINS));
    bins[bin].vals.push(price / mean);
  }
  const pattern = bins.map((b, i) => {
    if (b.vals.length < 2) return null;
    const s = [...b.vals].sort((a,c)=>a-c);
    return s[Math.floor(s.length/2)]; // median
  });
  // Fill gaps via interpolation
  for (let i = 0; i < NUM_BINS; i++) {
    if (pattern[i] === null) {
      for (let d = 1; d < NUM_BINS; d++) {
        const p2 = pattern[(i-d+NUM_BINS)%NUM_BINS], n2 = pattern[(i+d)%NUM_BINS];
        if (p2!==null && n2!==null) { pattern[i]=(p2+n2)/2; break; }
        if (p2!==null) { pattern[i]=p2; break; }
        if (n2!==null) { pattern[i]=n2; break; }
      }
      if (pattern[i]===null) pattern[i]=1.0;
    }
  }
  // Measure pattern strength: std dev of pattern values
  const patMean = pattern.reduce((a,b)=>a+b,0)/NUM_BINS;
  const patStd  = Math.sqrt(pattern.reduce((s,v)=>s+(v-patMean)**2,0)/NUM_BINS);
  // If pattern is flat (patStd < 0.01), don't use it — item has no seasonal cycle
  const usePattern = patStd > 0.01;

  // ── Model 3: Long-term trend (damped — real prices don't trend forever) ────
  const trendN = Math.min(prices.length, Math.round(30 * 86400000 / intervalMs));
  const longSlope = linearSlope(prices.slice(-trendN)); // per data-interval step
  // Convert to per-stepMs, then DAMP heavily — trend decays over the forecast
  const rawSlopePerStep = longSlope * (intervalMs / stepMs);
  // Cap trend so it can't move price more than ~30% over the whole forecast
  const maxTrendTotal = mean * 0.30;
  const slopePerStep = Math.sign(rawSlopePerStep) * Math.min(Math.abs(rawSlopePerStep), maxTrendTotal / steps);

  // ── Event boost function — implements exact SkyBlock event rules ───────────
  const tagU = tag.toUpperCase();
  const elecClose = mayorData?.electionClosing || 0;
  // Active perks held by current mayor+minister (perk name set)
  const activePerkSet = new Set((mayorData?.activePerks || []));
  const leadingPerkSet = new Set((mayorData?.leadingPerks || []));

  // Crop name → bazaar id (Jacob/Starlyn)
  const CROP_MAP = {
    'Wheat':'WHEAT','Carrot':'CARROT_ITEM','Potato':'POTATO_ITEM','Sugar Cane':'SUGAR_CANE',
    'Pumpkin':'PUMPKIN','Melon':'MELON','Cactus':'CACTUS','Cocoa Beans':'COCOA_BEANS',
    'Mushroom':'MUSHROOM_COLLECTION','Nether Wart':'NETHER_STALK',
  };
  const FARMING_ITEMS = new Set(Object.values(CROP_MAP));
  const isCrop = Object.values(CROP_MAP).includes(tagU);

  // Perk active now (mayor/minister) OR predicted to be active (leading candidate wins)
  const perkActiveNowOrFuture = (perk) => activePerkSet.has(perk) || leadingPerkSet.has(perk);
  // At a given timestamp, does the perk apply?
  //  - if currently active: applies before election; after election fades unless leading also has it
  //  - if only leading has it: applies only after election
  const perkAppliesAt = (perk, ts) => {
    const nowHas = activePerkSet.has(perk);
    const futHas = leadingPerkSet.has(perk);
    if (elecClose <= 0) return nowHas;
    if (ts <= elecClose) return nowHas;
    return futHas; // after election, only if the incoming mayor has it
  };

  const getEventInfo = (ts) => {
    let boost = 0;
    const reasons = [];
    const cal = sbCalendar(ts, elecClose);
    const m = cal.month, d = cal.day, doy = cal.dayOfYear;

    // ── 1. Fixed calendar events ────────────────────────────────────────────
    // Spooky Festival — month 8, days 29-31 inclusive
    if (m===8 && d>=29 && d<=31 && EVENT_ITEMS.spooky.includes(tagU)) {
      boost += 0.5; reasons.push('Spooky Festival');
    }
    // Season of Jerry — month 12, days 24-26 inclusive
    if (m===12 && d>=24 && d<=26 && EVENT_ITEMS.jerry.includes(tagU)) {
      boost += 0.5; reasons.push('Season of Jerry');
    }

    // ── 2. Jacob's Contests (API — exact crops; run xx:15 to xx:35 IRL) ──────
    if (isCrop && jacobContests?.length) {
      for (const ct of jacobContests) {
        const cStart = ct.timestamp, cEnd = ct.timestamp + 1200000; // 20 min
        if (ts >= cStart - 900000 && ts <= cEnd + 900000) {
          for (const cropName of (ct.cropNames || [])) {
            if (CROP_MAP[cropName] === tagU) {
              boost += (ts >= cStart && ts <= cEnd) ? 0.22 : 0.08;
              reasons.push('Jacob: '+cropName);
              break;
            }
          }
        }
      }
    }

    // ── 3. Starlyn (Carnival) Contest — every ingame day, back-to-back ───────
    // Continuous farming demand → mild upward pressure on ALL crops every day.
    if (isCrop) {
      boost += 0.05; reasons.push('Starlyn contest');
    }

    // ── 4. Mayor-perk-driven events (perk presence is what matters) ──────────
    // Mythological Ritual (Diana perk): event for the WHOLE mayor term
    if (perkActiveNowOrFuture('Mythological Ritual') && EVENT_ITEMS.mythological.includes(tagU)) {
      if (perkAppliesAt('Mythological Ritual', ts)) { boost += 0.25; reasons.push('Mythological Ritual'); }
    }
    // Fishing Festival (Marina perk): first 3 days of EACH month → fish supply surge
    if (perkActiveNowOrFuture('Fishing Festival') && d<=3 && EVENT_ITEMS.fishing.includes(tagU)) {
      if (perkAppliesAt('Fishing Festival', ts)) { boost -= 0.15; reasons.push('Fishing Festival'); }
    }
    // Mining Fiesta (Cole perk): first 7 days of months 5-9 → ore supply surge
    if (perkActiveNowOrFuture('Mining Fiesta') && m>=5 && m<=9 && d<=7 && EVENT_ITEMS.mining.includes(tagU)) {
      if (perkAppliesAt('Mining Fiesta', ts)) { boost -= 0.18; reasons.push('Mining Fiesta'); }
    }
    // Stock Exchange (Diaz perk): whole mayor term
    if (perkActiveNowOrFuture('Stock Exchange') && EVENT_ITEMS.stonk.includes(tagU)) {
      if (perkAppliesAt('Stock Exchange', ts)) { boost += 0.12; reasons.push('Stock Exchange'); }
    }

    // ── 5. General mayor perk price effects (from worker's perk table) ───────
    if (mayorData?.itemEffects?.[tag]) {
      const eff = mayorData.itemEffects[tag];
      if (elecClose > 0 && ts > elecClose) {
        const daysAfter = (ts - elecClose) / 86400000;
        const w = Math.max(0, 1 - daysAfter / 7);
        boost += (eff - 1.0) * w;
        if (Math.abs(eff-1) > 0.05 && w > 0.2) reasons.push('Mayor perk (fading)');
      } else {
        boost += eff - 1.0;
        const r = mayorData.perkReasons?.[tag];
        if (r?.length) reasons.push(r[0].perk);
      }
    }
    if (mayorData?.futureItemEffects?.[tag] && elecClose > 0 && ts > elecClose) {
      const fe = mayorData.futureItemEffects[tag];
      const daysAfter = (ts - elecClose) / 86400000;
      const w = Math.min(1, daysAfter / 3);
      boost += (fe - 1.0) * w;
      if (Math.abs(fe-1) > 0.05 && w > 0.2) reasons.push('New mayor: '+(mayorData.leadingCandidate||'?'));
    }

    // Dedupe reasons
    const uniq = [...new Set(reasons)];
    return { boost: Math.max(-0.6, Math.min(1.5, boost)), reasons: uniq };
  };

  // ── Correlated random walk (Ornstein–Uhlenbeck style) ─────────────────────
  // Each step: dP = -theta*(P-target)*dt + sigma*dW
  // dW is correlated (not white noise) — use autoregressive noise
  const dailyVol = stdDev / Math.sqrt(Math.max(1, 86400000 / intervalMs));
  const stepVol  = dailyVol * Math.sqrt(stepMs / 86400000) * 0.5; // scaled to stepMs

  // ── Sell-price trend & cycle (computed independently) ─────────────────────
  const rawSellSlope = sellPrices.length > 5
    ? linearSlope(sellPrices.slice(-Math.min(sellPrices.length, trendN)))
    : longSlope * buySellRatio;
  const sellSlope = Math.sign(rawSellSlope) * Math.min(Math.abs(rawSellSlope), maxTrendTotal / steps / (intervalMs/stepMs));

  // ── Project forward — BUY and SELL as separate series ─────────────────────
  // STABILITY: prediction is anchored to the long-term mean + seasonal pattern,
  // NOT recent momentum or random noise. This makes it consistent regardless of
  // exactly where you start it (no spiky/flat dependence on the last few points).
  const nowTs = Date.now();
  const predStartTs = Math.max(last.t, nowTs);
  let buyPrice   = last.b || mean;
  let sellPrice  = last.s || (last.b ? last.b * spreadMean : sellMean);
  // Small initial momentum only — heavily damped, just smooths the first few steps
  let buyMom     = Math.max(-stdDev*0.01, Math.min(stdDev*0.01, slopePerStep));
  let sellMom    = 0;
  let trendOffset = 0, sellTrendOffset = 0;
  const result = [];

  // Deterministic pseudo-cycle wobble (NOT random) — same every run.
  // Uses the detected cycle only; no Math.random so backtests are reproducible.

  for (let i = 0; i <= steps; i++) {
    const ts = predStartTs + i * stepMs;
    // Trend decays — strong early, fades over horizon
    const trendDecay = Math.exp(-i / (steps * 0.4));
    if (i > 0) {
      trendOffset     += slopePerStep * trendDecay;
      sellTrendOffset += sellSlope * (intervalMs/stepMs) * trendDecay;
    }

    // Seasonal pattern — but its INFLUENCE fades over the forecast so we don't
    // just replay the same SB-year loop endlessly. Early prediction follows the
    // recent level; later prediction leans on the seasonal/mean structure.
    let seasonalMult = 1.0;
    if (usePattern) {
      const phase = ((ts - SB_EPOCH) % SB_YEAR_MS + SB_YEAR_MS) % SB_YEAR_MS / SB_YEAR_MS;
      const bin   = Math.min(NUM_BINS-1, Math.floor(phase * NUM_BINS));
      seasonalMult = pattern[bin];
    }
    // Multi-frequency deterministic drift (NOT a single repeating cycle).
    // Combines the detected cycle with two slower incommensurate waves so the
    // path evolves and doesn't visibly repeat over the forecast window.
    const driftA = cycleAmp * Math.sin(2*Math.PI*i/Math.max(1,bestCycleSteps) + cyclePhaseOffset);
    const driftB = cycleAmp * 0.5 * Math.sin(2*Math.PI*i/Math.max(1,bestCycleSteps*2.7) + 1.3);
    const driftC = cycleAmp * 0.3 * Math.sin(2*Math.PI*i/Math.max(1,bestCycleSteps*0.41) + 2.1);
    const drift = driftA + driftB + driftC;

    const { boost, reasons } = getEventInfo(ts);
    const eventMult = 1.0 + boost;

    if (i > 0) {
      // Blend target: early = anchored near recent price (mean-reverting slowly),
      // late = seasonal-structured mean. Weight shifts with i.
      const seasonalWeight = Math.min(1, i / (steps * 0.25)); // 0→1 over first quarter (less start-dependence)
      const recentAnchor = (last.b || mean);
      const buyMeanTarget = recentAnchor * (1 - seasonalWeight) + (buyMean) * seasonalWeight;
      const buyTarget = (buyMeanTarget + trendOffset) * seasonalMult * eventMult + drift;
      const buyDist   = buyTarget - buyPrice;
      const buyPull   = buyDist * 0.08;
      buyMom = buyMom * 0.88 + buyPull * 0.12; // momentum integrates pull (smoother, evolving)
      buyPrice = buyPrice + buyPull + buyMom;
      if (buyPrice <= 0) buyPrice = buyMean * 0.5;

      const sellMeanTarget = (last.s || sellMean) * (1 - seasonalWeight) + sellMean * seasonalWeight;
      const sellTarget = (sellMeanTarget + sellTrendOffset) * seasonalMult * eventMult + drift * buySellRatio;
      const sellDist   = sellTarget - sellPrice;
      const sellPull   = sellDist * 0.08;
      sellMom = sellMom * 0.88 + sellPull * 0.12;
      sellPrice = sellPrice + sellPull + sellMom;

      const curSpread = buyPrice > 0 ? sellPrice / buyPrice : spreadMean;
      if (Math.abs(curSpread - spreadMean) > spreadStd * 2) {
        sellPrice = buyPrice * (curSpread + (spreadMean - curSpread) * 0.5);
      }
      if (sellPrice <= 0) sellPrice = buyPrice * spreadMean;
      if (sellPrice >= buyPrice) sellPrice = buyPrice * Math.min(0.999, spreadMean);
    }

    if (i % outputEvery === 0) {
      result.push({
        t: ts,
        b: r1(buyPrice),
        s: r1(sellPrice),
        eventMult: r2(seasonalMult * eventMult),
        reasons: reasons.length > 0 ? reasons.slice(0, 2) : undefined,
      });
    }
  }
  return result;
}

// ── Math helpers ──────────────────────────────────────────────────────────────
function computeRSI(prices, period){
  if(prices.length<period+1) return 50;
  let g=0,l=0;
  for(let i=1;i<=period;i++){ const d=prices[i]-prices[i-1]; if(d>0)g+=d; else l-=d; }
  let ag=g/period, al=l/period;
  for(let i=period+1;i<prices.length;i++){
    const d=prices[i]-prices[i-1];
    ag=(ag*(period-1)+Math.max(0,d))/period;
    al=(al*(period-1)+Math.max(0,-d))/period;
  }
  return al===0?100:100-100/(1+ag/al);
}
function linearSlope(values){
  const n=values.length; if(n<2) return 0;
  const xm=(n-1)/2, ym=values.reduce((a,b)=>a+b,0)/n;
  let num=0,den=0;
  for(let i=0;i<n;i++){num+=(i-xm)*(values[i]-ym);den+=(i-xm)**2;}
  return den===0?0:num/den;
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