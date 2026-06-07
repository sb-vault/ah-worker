// sb-flipper Investment Worker v4 — comprehensive event-aware prediction

const BZ_KEY    = 'bz_v4';
const MAYOR_KEY = 'mayor_v4';
const KV_TTL    = 130;

// ── SkyBlock calendar constants ───────────────────────────────────────────────
const SB_EPOCH   = 1560272700000; // June 11 2019 ~17:05 UTC
const SB_YEAR_MS = 446400000;     // 124 real hours × 3600000
const SB_DAY_MS  = 1200000;       // 20 real minutes per SkyBlock day
// SkyBlock months: 12 months × 31 days = 372 days
// Months: Early Spring(1-31), Spring(32-62), Late Spring(63-93),
//         Early Summer(94-124), Summer(125-155), Late Summer(156-186),
//         Early Autumn(187-217), Autumn(218-248), Late Autumn(249-279),
//         Early Winter(280-310), Winter(311-341), Late Winter(342-372)
const SB_MONTH_NAMES = ['Early Spring','Spring','Late Spring','Early Summer','Summer','Late Summer','Early Autumn','Autumn','Late Autumn','Early Winter','Winter','Late Winter'];

function sbDayOfYear(ts) {
  const elapsed = ((ts - SB_EPOCH) % SB_YEAR_MS + SB_YEAR_MS) % SB_YEAR_MS;
  return Math.floor(elapsed / SB_DAY_MS) + 1; // 1-372
}
function sbYearNum(ts) { return Math.floor((ts - SB_EPOCH) / SB_YEAR_MS); }
function sbYearStart(ts) { return SB_EPOCH + sbYearNum(ts) * SB_YEAR_MS; }

// ── Fixed annual events (day range within SkyBlock year, 1-indexed) ───────────
// Spooky: Autumn 29-31 = days 218+28..218+30 = 246-248
// Pre-spooky hype: Fear Mongerer from Autumn 26 = day 243
// Fishing Festival: Early Spring 1-3 = days 1-3 (Marina mayor required, but also base)
// Season of Jerry: Late Winter 1-22 = days 342-363 (approx)
// New Year: Late Winter 29-31 = days 370-372
// Mining Fiesta: only when Cole/Foxy (handled via perks)
// Bank Interest: 1st of every month (every 31 days starting day 1)
// Dark Auction: every 3 real days = every 216 SB days (but 124 per year = every ~3 SB days)
// Traveling Zoo: every 124/6 ≈ 20.7 SB days

const FIXED_EVENTS = [
  // { name, startDay, endDay, itemPatterns, demandMultiplier }
  { name:'Spooky Festival',     start:243, end:251,
    items:['CANDY','GREEN_CANDY','PURPLE_CANDY','JACK_O_LANTERN','SPOOKY_FRAGMENT','BAT_ARTIFACT','BAT_RING','INTIMIDATION_ARTIFACT','ECTOPLASM','PUMPKIN'],
    mult:1.5, spikeAt:246, spikeMult:1.8 },
  { name:'Pre-Spooky Prep',     start:235, end:243,
    items:['CANDY','GREEN_CANDY','PURPLE_CANDY'],
    mult:1.2 },
  { name:'Season of Jerry',     start:342, end:363,
    items:['JERRY_BOX','BLUE_JERRY','GREEN_JERRY','PURPLE_JERRY','GOLDEN_JERRY','SNOWBALL'],
    mult:1.6 },
  { name:'New Year',            start:365, end:372,
    items:['NEW_YEAR_CAKE','CAKE_BAG'],
    mult:1.4 },
  { name:'New Year Prep',       start:358, end:365,
    items:['NEW_YEAR_CAKE','CAKE_BAG'],
    mult:1.2 },
  { name:'Traveling Zoo',       start:1, end:3,   // approximation, repeats ~6x/year
    items:['ORINGO','ZOO_TICKET'],
    mult:1.15 },
  { name:'Late Winter Fishing', start:342, end:372,
    items:['JERRY_FISHING','ICE_BAIT','FROZEN_STEVE'],
    mult:1.3 },
];

// ── Perk → market effects ─────────────────────────────────────────────────────
// Maps perk NAME → { items: [...], supplyChange: +1.0 = +100% supply, priceEffect: multiply }
// Supply UP → price DOWN. Demand UP → price UP.
const PERK_MARKET = {
  // ── FARMING PERKS (supply↑ → price↓) ─────────────────────────────────────
  'GOATed':             { items:['WHEAT','POTATO_ITEM','CARROT_ITEM','SUGAR_CANE','PUMPKIN','MELON','CACTUS','COCOA_BEANS','NETHER_STALK','MUSHROOM_COLLECTION','SUNFLOWER','MOONFLOWER'], price:0.82 },
  'Blooming Business':  { items:['WHEAT','POTATO_ITEM','CARROT_ITEM','SUGAR_CANE','PUMPKIN','MELON','ENCHANTED_CARROT','ENCHANTED_POTATO','ENCHANTED_WHEAT'], price:0.85 },
  'Pest Eradicator':    { items:['ENCHANTED_COOKIE','COMPOSTER_UPGRADE','PESTICIDE','WHEAT','CARROT_ITEM'], price:0.88 },
  'Pelt-pocalypse':     { items:['FUR','PELT','RABBIT_FOOT'], price:0.80 },
  'Grand Feast':        { items:['WHEAT','POTATO_ITEM','CARROT_ITEM','MUSHROOM_COLLECTION'], price:0.90 }, // Finnegan special

  // ── MINING PERKS (supply↑ → price↓) ──────────────────────────────────────
  'Prospection':        { items:['MITHRIL_ORE','COAL','IRON_INGOT','GOLD_INGOT','DIAMOND','EMERALD','LAPIS_LAZULI','REDSTONE','QUARTZ','GEMSTONE'], price:0.82 },
  'Mining Fiesta':      { items:['MITHRIL_ORE','COBBLESTONE','COAL','IRON_INGOT','GOLD_INGOT','DIAMOND','HARD_STONE'], price:0.75, tempDuration:0.02 }, // ~2% of year
  'Molten Forge':       { items:['ENCHANTED_IRON_BLOCK','ENCHANTED_GOLD_BLOCK','ENCHANTED_DIAMOND','HARD_STONE','HOT_STUFF'], price:0.84 },

  // ── FISHING PERKS (supply↑ → price↓ for fish, demand↑ for equipment) ─────
  'Fishing Festival':   { items:['RAW_FISH','SPONGE','SHARK_FIN','DOLPHIN','SEA_CREATURE_BAIT','FISHING_BAIT'], price:0.80, tempDuration:0.024 },
  'Luck of the Sea 2.0':{ items:['RAW_FISH','TROPHY_FISH','SEA_CREATURE_BAIT'], price:0.88 },

  // ── SLAYER PERKS (supply↑ → price↓ for slayer drops) ─────────────────────
  'SLASHED Pricing':    { items:['CORRUPTED_FRAGMENT','WITHER_ESSENCE','SPIDER_CATALYST','REVENANT_FLESH'], price:0.85 },
  'Pathfinder':         { items:['REVENANT_FLESH','TARANTULA_SILK','WOLF_TOOTH','VOIDLING_NUCLEUS'], price:0.88 },
  'Slayer XP Buff':     { items:['REVENANT_FLESH','TARANTULA_SILK','WOLF_TOOTH','SADAN_BROOCH'], price:0.90 },

  // ── DEMAND PERKS (demand↑ → price↑) ──────────────────────────────────────
  'Mythological Ritual':{ items:['GRIFFIN_FEATHER','MINOS_RELIC','CHIMERA','MAGICAL_MUSHROOM_SOUP','ANCIENT_CLAW','MINOTAUR_PET','GRIFFIN_PET'], price:1.45 },
  'Darker Auctions':    { items:['SCYTHE_BLADE','WITHER_BLOOD','SHADOW_ASSASSIN_CLOAK','SHADOW_FURY','DARK_CACAO_TRUFFLE'], price:1.30 },
  'Shopping Spree':     { items:['BOOSTER_COOKIE','DUNGEON_ORBS','BEACON','BITS'], price:1.20 },
  'Volume Trading':     { items:['BOOSTER_COOKIE','DARK_CACAO_TRUFFLE','STOCK_OF_STONKS'], price:1.25 },
  'Extra Event':        { items:['CANDY','GREEN_CANDY','PURPLE_CANDY','RAW_FISH','MITHRIL_ORE'], price:1.20 },
  'Pet XP Buff':        { items:['PET_ITEM_TIER_BOOST','EXP_BOTTLE','GRAND_EXP_BOTTLE','TITANIC_EXP_BOTTLE'], price:1.15 },
  'Sharing is Caring':  { items:['PET_ITEM_TIER_BOOST','EXP_BOTTLE','GRAND_EXP_BOTTLE'], price:1.12 },

  // ── SPECIAL MAYOR EFFECTS ─────────────────────────────────────────────────
  // Derpy: doubles XP → huge demand for XP-boosting items
  'Turbo-Minions I':    { items:['ENCHANTED_EGG','SUPER_EGG','OAK_LOG','BIRCH_LOG'], price:1.35 },
  'Mayor XP Buff':      { items:['GRAND_EXP_BOTTLE','TITANIC_EXP_BOTTLE','CORRUPTED_FRAGMENT'], price:1.40 },
  // Scorpius: dark auction items spike
  'Bribe':              { items:['SCYTHE_BLADE','WITHER_BLOOD','SHADOW_FURY'], price:1.20 },
  // Foxy
  'Sweet Benevolence':  { items:['CARNIVAL_TICKET','CARNIVAL_MASK','PARTY_HAT_CINNAMON'], price:1.30 },
  'Chivalrous Carnival':{ items:['CARNIVAL_TICKET','CARNIVAL_MASK'], price:1.25 },
  // Diaz: trading doubles
  'Stock Exchange':     { items:['STOCK_OF_STONKS','BOOSTER_COOKIE'], price:1.15 },
};

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
  const ck = 'hist5_'+tag+'_'+period;
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

    const analytics = computeAnalytics(points, tag, mayorData, jacobContests);
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
function computeAnalytics(points, tag, mayorData, jacobContests) {
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

  const extrapolation = buildPrediction(points, prices, tag, mean, stdDev, slopePerPoint, intervalMs, mayorData, jacobContests);

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

function buildPrediction(points, prices, tag, mean, stdDev, slopePerPoint, intervalMs, mayorData, jacobContests) {
  const last = points[points.length - 1];
  if (!last || prices.length < 10) return [];

  const stepMs     = SB_DAY_MS;  // 20min = 1 SkyBlock day for event precision
  const outputEvery = 1;          // output every step = 20 min resolution
  const futureDays = 30;
  const steps      = Math.round(futureDays * 86400000 / stepMs);

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

  // ── Event boost function ───────────────────────────────────────────────────
  const getEventInfo = (ts) => {
    let boost = 0;
    const reasons = [];
    const sbDay = sbDayOfYear(ts);

    // Fixed annual events
    for (const evt of FIXED_EVENTS) {
      if (sbDay >= evt.start && sbDay <= evt.end) {
        const match = evt.items.some(id => {
          const t = tag.toUpperCase(), idU = id.toUpperCase();
          return t===idU || t.includes(idU.split('_')[0]) || idU.split('_')[0]===t.split('_')[0];
        });
        if (match) {
          const m = evt.spikeAt && sbDay >= evt.spikeAt ? (evt.spikeMult||evt.mult) : evt.mult;
          boost += m - 1.0;
          reasons.push(evt.name);
        }
      }
    }

    // Mayor effects
    if (mayorData?.itemEffects?.[tag]) {
      const eff = mayorData.itemEffects[tag];
      if (mayorData.electionClosing > 0 && ts > mayorData.electionClosing) {
        const daysAfter = (ts - mayorData.electionClosing) / 86400000;
        const w = Math.max(0, 1 - daysAfter / 7);
        boost += (eff - 1.0) * w;
        if (Math.abs(eff-1) > 0.05 && w > 0.1) reasons.push('Mayor (fading)');
      } else {
        boost += eff - 1.0;
        const r = mayorData.perkReasons?.[tag];
        if (r?.length) reasons.push(r[0].perk);
      }
    }
    // Future mayor
    if (mayorData?.futureItemEffects?.[tag] && mayorData.electionClosing > 0 && ts > mayorData.electionClosing) {
      const fe = mayorData.futureItemEffects[tag];
      const daysAfter = (ts - mayorData.electionClosing) / 86400000;
      const w = Math.min(1, daysAfter / 3);
      boost += (fe - 1.0) * w;
      if (Math.abs(fe-1) > 0.05 && w > 0.1) reasons.push('New mayor: '+mayorData.leadingCandidate);
    }

    // Jacob contests
    if (jacobContests?.length) {
      const CROP_MAP = {
        'Wheat':'WHEAT','Carrot':'CARROT_ITEM','Potato':'POTATO_ITEM','Sugar Cane':'SUGAR_CANE',
        'Pumpkin':'PUMPKIN','Melon':'MELON','Cactus':'CACTUS','Cocoa Beans':'COCOA_BEANS',
        'Mushroom':'MUSHROOM_COLLECTION','Nether Wart':'NETHER_STALK',
      };
      for (const ct of jacobContests) {
        if (ts >= ct.timestamp - 10800000 && ts <= ct.timestamp + 1200000 + 10800000) {
          for (const cropName of (ct.cropNames||[])) {
            const id = CROP_MAP[cropName];
            if (id && tag.toUpperCase().includes(id.split('_')[0])) {
              boost += 0.30; reasons.push('Jacob: '+cropName);
            }
          }
        }
      }
    }

    return { boost: Math.max(-0.5, Math.min(1.5, boost)), reasons };
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

  // ── Project forward — BUY and SELL tracked as separate series ─────────────
  // Anchor prediction to NOW (not the last, possibly-stale data point)
  const nowTs = Date.now();
  const predStartTs = Math.max(last.t, nowTs);
  let buyPrice   = last.b || mean;
  let sellPrice  = last.s || (last.b ? last.b * spreadMean : sellMean);
  let buyMom     = slopePerStep  > 0 ? Math.min(slopePerStep*3,  stdDev*0.02) : Math.max(slopePerStep*3,  -stdDev*0.02);
  let sellMom    = 0; // sell momentum starts neutral, builds from sellSlope in loop
  let buyNoise = 0, sellNoise = 0, spreadNoise = 0;
  let trendOffset = 0, sellTrendOffset = 0;
  const result = [];
  const rho = 0.7;

  for (let i = 1; i <= steps; i++) {
    const ts = predStartTs + i * stepMs;
    // Trend decays exponentially — strong early, fades over the forecast horizon
    const trendDecay = Math.exp(-i / (steps * 0.4));
    trendOffset     += slopePerStep * trendDecay;
    sellTrendOffset += sellSlope * (intervalMs/stepMs) * trendDecay;

    // Shared seasonal + event multipliers (events affect both buy and sell)
    let seasonalMult = 1.0;
    if (usePattern) {
      const phase = ((ts - SB_EPOCH) % SB_YEAR_MS + SB_YEAR_MS) % SB_YEAR_MS / SB_YEAR_MS;
      const bin   = Math.min(NUM_BINS-1, Math.floor(phase * NUM_BINS));
      seasonalMult = pattern[bin];
    }
    const cyclic = cycleAmp * Math.sin(2*Math.PI*i/Math.max(1,bestCycleSteps) + cyclePhaseOffset);
    const { boost, reasons } = getEventInfo(ts);
    const eventMult = 1.0 + boost;

    // ── BUY price ───────────────────────────────────────────────────────────
    const buyTarget = (buyMean + trendOffset) * seasonalMult * eventMult + cyclic;
    const buyDist   = buyTarget - buyPrice;
    const buyPull   = buyDist * Math.min(0.12, 0.04 + Math.abs(buyDist/Math.max(buyMean,1))*0.15);
    buyNoise = rho*buyNoise + (1-rho)*(Math.random()-0.5)*2*stepVol;
    buyMom *= 0.92;
    buyPrice = buyPrice + buyPull + buyMom + buyNoise;
    if (buyPrice <= 0) buyPrice = buyMean * 0.5;

    // ── SELL price — own trend & cycle, but spread mean-reverts to historical ─
    // Sell follows its own dynamics but stays in a realistic band vs buy
    const sellTarget = (sellMean + sellTrendOffset) * seasonalMult * eventMult + cyclic * buySellRatio;
    const sellDist   = sellTarget - sellPrice;
    const sellPull   = sellDist * Math.min(0.12, 0.04 + Math.abs(sellDist/Math.max(sellMean,1))*0.15);
    sellNoise = rho*sellNoise + (1-rho)*(Math.random()-0.5)*2*stepVol*buySellRatio;
    sellMom *= 0.92;
    sellPrice = sellPrice + sellPull + sellMom + sellNoise;

    // Spread sanity: sell should stay below buy by roughly the historical spread
    // Soft-constrain: pull spread back toward spreadMean if it drifts too far
    const curSpread = buyPrice > 0 ? sellPrice / buyPrice : spreadMean;
    spreadNoise = rho*spreadNoise + (1-rho)*(Math.random()-0.5)*2*spreadStd;
    const targetSpread = spreadMean + spreadNoise;
    if (Math.abs(curSpread - targetSpread) > spreadStd * 3) {
      // Spread drifted too far — nudge sell back toward realistic spread
      sellPrice = buyPrice * (curSpread + (targetSpread - curSpread) * 0.3);
    }
    if (sellPrice <= 0) sellPrice = buyPrice * spreadMean;
    if (sellPrice >= buyPrice) sellPrice = buyPrice * Math.min(0.999, spreadMean); // sell never above buy

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
