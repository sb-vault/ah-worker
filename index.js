// sb-flipper Worker v2
// Accumulates ended auctions over time in KV for proper median/volume calculation
// Ended auctions are fetched every ~60s by cron and APPENDED to rolling window

const BIN_KEY      = 'bin_auctions_v3';
const ENDED_KEY    = 'ended_accumulated_v2';
const KV_TTL       = 180;
const ENDED_TTL    = 86400; // keep 24h of ended data
const MAX_DAYS     = 3;     // rolling window for median calculation

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors() });

    if (url.pathname === '/lastUpdated') {
      try {
        const p0 = await fetchHypixel('https://api.hypixel.net/v2/skyblock/auctions?page=0');
        return json({ lastUpdated: p0.lastUpdated });
      } catch (e) { return json({ error: e.message }, 500); }
    }

    if (url.pathname === '/auctions' || url.pathname === '/') {
      return handleAuctions(env, ctx);
    }

    if (url.pathname === '/prices') {
      return handlePrices(env, ctx);
    }

    return new Response('Not found', { status: 404, headers: cors() });
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(Promise.all([
      refreshBIN(env),
      accumulateEnded(env),
    ]));
  },
};

// ── BIN auctions ──────────────────────────────────────────────────────────────

async function handleAuctions(env, ctx) {
  if (env.FLIPPER_CACHE) {
    const cached = await env.FLIPPER_CACHE.get(BIN_KEY, { type: 'json' });
    if (cached) {
      try {
        const p0 = await fetchHypixel('https://api.hypixel.net/v2/skyblock/auctions?page=0');
        if (p0.lastUpdated <= cached.lastUpdated) return json({ ...cached, cached: true });
      } catch (_) { return json({ ...cached, cached: true }); }
      ctx.waitUntil(refreshBIN(env));
      return json(await fetchAllBIN());
    }
  }
  const data = await fetchAllBIN();
  if (env.FLIPPER_CACHE)
    ctx.waitUntil(env.FLIPPER_CACHE.put(BIN_KEY, JSON.stringify(data), { expirationTtl: KV_TTL }));
  return json(data);
}

async function refreshBIN(env) {
  try {
    const data = await fetchAllBIN();
    await env.FLIPPER_CACHE.put(BIN_KEY, JSON.stringify(data), { expirationTtl: KV_TTL });
  } catch (e) { console.error('BIN refresh:', e.message); }
}

async function fetchAllBIN() {
  const t0 = Date.now();
  const p0 = await fetchHypixel('https://api.hypixel.net/v2/skyblock/auctions?page=0');
  if (!p0.success) throw new Error('Hypixel failure');

  let bins = p0.auctions.filter(a => a.bin);
  const pages = Array.from({ length: p0.totalPages - 1 }, (_, i) => i + 1);
  for (let i = 0; i < pages.length; i += 25) {
    const batch = pages.slice(i, i + 25);
    const results = await Promise.allSettled(
      batch.map(p => fetchHypixel(`https://api.hypixel.net/v2/skyblock/auctions?page=${p}`))
    );
    for (const r of results)
      if (r.status === 'fulfilled' && r.value.success)
        bins = bins.concat(r.value.auctions.filter(a => a.bin));
  }

  return {
    success:     true,
    ts:          Date.now(),
    lastUpdated: p0.lastUpdated,
    totalBIN:    bins.length,
    fetchMs:     Date.now() - t0,
    auctions:    bins.map(a => ({
      uuid: a.uuid, end: a.end,
      item_name: a.item_name, item_lore: a.item_lore,
      extra: a.extra, category: a.category,
      tier: a.tier, starting_bid: a.starting_bid,
    })),
  };
}

// ── Ended auctions — accumulate rolling window ────────────────────────────────

async function handlePrices(env, ctx) {
  if (env.FLIPPER_CACHE) {
    const cached = await env.FLIPPER_CACHE.get(ENDED_KEY, { type: 'json' });
    if (cached) return json({ ...cached, cached: true });
  }
  // Cold start — fetch and accumulate now
  await accumulateEnded(env);
  const fresh = await env.FLIPPER_CACHE?.get(ENDED_KEY, { type: 'json' });
  return json(fresh || { success: false, prices: {} });
}

async function accumulateEnded(env) {
  try {
    const res = await fetchHypixel('https://api.hypixel.net/v2/skyblock/auctions/ended');
    const nowDay = dayNumber();

    // Load existing accumulated data
    let acc = { prices: {}, ts: Date.now() };
    if (env.FLIPPER_CACHE) {
      const existing = await env.FLIPPER_CACHE.get(ENDED_KEY, { type: 'json' });
      if (existing) acc = existing;
    }

    // Process new sales — group by normalised item name
    for (const sale of (res.auctions || [])) {
      const name = normName(sale.item_name);
      if (!name) continue;
      if (!acc.prices[name]) acc.prices[name] = { sales: [], lbin: 0, count: 0 };
      acc.prices[name].sales.push({ price: sale.price, day: nowDay });
    }

    // Prune sales older than MAX_DAYS and recalculate stats
    const cutoff = nowDay - MAX_DAYS;
    for (const [name, data] of Object.entries(acc.prices)) {
      data.sales = data.sales.filter(s => s.day >= cutoff);
      if (data.sales.length === 0) { delete acc.prices[name]; continue; }

      const prices = data.sales.map(s => s.price).sort((a, b) => a - b);
      const mid = Math.floor(prices.length / 2);
      data.median = prices.length % 2 === 0
        ? Math.round((prices[mid - 1] + prices[mid]) / 2) : prices[mid];
      data.lbin = prices[0];
      data.count = prices.length;

      // Volume = sales per day
      const daySpan = Math.max(1, nowDay - Math.min(...data.sales.map(s => s.day)) + 1);
      data.volume = data.count / daySpan;

      // Estimated hours to sell — if volume < 1/day, scale accordingly
      // Formula: avgSellTime (hours) = 24 / volume
      data.avgSellHours = data.volume > 0 ? Math.round(24 / data.volume) : 999;

      // Volatility: std dev / median as a percentage (0-100)
      if (prices.length > 1) {
        const mean = prices.reduce((a, b) => a + b, 0) / prices.length;
        const variance = prices.reduce((s, p) => s + (p - mean) ** 2, 0) / prices.length;
        data.volatility = Math.min(100, Math.round((Math.sqrt(variance) / mean) * 100));
      } else {
        data.volatility = 0;
      }
    }

    acc.ts = Date.now();
    acc.success = true;
    if (env.FLIPPER_CACHE)
      await env.FLIPPER_CACHE.put(ENDED_KEY, JSON.stringify(acc), { expirationTtl: ENDED_TTL });
  } catch (e) {
    console.error('accumulateEnded:', e.message);
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function fetchHypixel(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'sb-flipper/1.0' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  return res.json();
}

function normName(name) {
  return (name || '').replace(/§[0-9a-fklmnorA-FKLMNOR]/gi, '').trim().toLowerCase();
}

function dayNumber() {
  return Math.floor(Date.now() / 86_400_000);
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status, headers: { 'Content-Type': 'application/json', ...cors() }
  });
}

function cors() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}