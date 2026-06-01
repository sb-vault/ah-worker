// sb-flipper Worker v3
// BANDWIDTH FIX: slim auction data to minimum needed fields
// Price data: fetch from CoflNet public API (sky.coflnet.com/api/item/price/{tag})
// and cache results in KV

const BIN_KEY    = 'bin_slim_v4';
const PRICE_KEY  = 'item_prices_v2';
const KV_TTL     = 120;
const PRICE_TTL  = 300; // 5 min cache on price data

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors() });

    if (url.pathname === '/lastUpdated') {
      try {
        const p0 = await hx('https://api.hypixel.net/v2/skyblock/auctions?page=0');
        return json({ lastUpdated: p0.lastUpdated });
      } catch (e) { return json({ error: e.message }, 500); }
    }

    if (url.pathname === '/auctions' || url.pathname === '/') {
      return handleAuctions(env, ctx);
    }

    // Proxy price lookup to CoflNet — avoids CORS in mod, adds KV caching
    if (url.pathname.startsWith('/price/')) {
      const tag = url.pathname.split('/')[2];
      return handlePrice(tag, env, ctx);
    }

    // Batch price lookup — mod sends comma-separated tags
    if (url.pathname === '/prices/batch') {
      const tags = (url.searchParams.get('tags') || '').split(',').filter(Boolean);
      return handleBatchPrices(tags, env, ctx);
    }

    return new Response('Not found', { status: 404, headers: cors() });
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(refreshBIN(env));
  },
};

// ── BIN auctions ──────────────────────────────────────────────────────────────

async function handleAuctions(env, ctx) {
  if (env.FLIPPER_CACHE) {
    const cached = await env.FLIPPER_CACHE.get(BIN_KEY, { type: 'json' });
    if (cached) {
      try {
        const p0 = await hx('https://api.hypixel.net/v2/skyblock/auctions?page=0');
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
    console.log(`BIN: ${data.totalBIN} auctions, ${JSON.stringify(data).length} bytes`);
  } catch (e) { console.error('BIN:', e.message); }
}

async function fetchAllBIN() {
  const t0 = Date.now();
  const p0 = await hx('https://api.hypixel.net/v2/skyblock/auctions?page=0');
  if (!p0.success) throw new Error('Hypixel fail');

  let bins = p0.auctions.filter(a => a.bin).map(slim);
  const pages = Array.from({ length: p0.totalPages - 1 }, (_, i) => i + 1);

  // Batch 30 at a time
  for (let i = 0; i < pages.length; i += 30) {
    const batch = pages.slice(i, i + 30);
    const results = await Promise.allSettled(batch.map(p => hx(`https://api.hypixel.net/v2/skyblock/auctions?page=${p}`)));
    for (const r of results)
      if (r.status === 'fulfilled' && r.value.success)
        bins = bins.concat(r.value.auctions.filter(a => a.bin).map(slim));
  }

  return { success: true, ts: Date.now(), lastUpdated: p0.lastUpdated, totalBIN: bins.length, fetchMs: Date.now() - t0, auctions: bins };
}

// SLIM: only keep what the mod needs — drastically reduces payload size
function slim(a) {
  return {
    u: a.uuid,
    e: a.end,
    n: a.item_name,
    x: a.extra,        // contains SB item tag for texture lookup
    c: a.category,
    t: a.tier,
    b: a.starting_bid,
    // Skip item_lore (large) — fetch on demand when detail opened
  };
}

// ── Price data via CoflNet API ────────────────────────────────────────────────

async function handlePrice(tag, env, ctx) {
  if (!tag) return json({ error: 'no tag' }, 400);
  const cacheKey = `price_${tag}`;
  if (env.FLIPPER_CACHE) {
    const cached = await env.FLIPPER_CACHE.get(cacheKey, { type: 'json' });
    if (cached && (Date.now() - (cached.ts || 0)) < PRICE_TTL * 1000)
      return json({ ...cached, cached: true });
  }
  try {
    const data = await fetchCoflPrice(tag);
    if (env.FLIPPER_CACHE)
      ctx.waitUntil(env.FLIPPER_CACHE.put(cacheKey, JSON.stringify({ ...data, ts: Date.now() }), { expirationTtl: PRICE_TTL }));
    return json(data);
  } catch (e) {
    return json({ error: e.message }, 500);
  }
}

async function handleBatchPrices(tags, env, ctx) {
  const results = {};
  const toFetch = [];

  // Check cache first
  for (const tag of tags.slice(0, 50)) { // cap at 50
    if (env.FLIPPER_CACHE) {
      const cached = await env.FLIPPER_CACHE.get(`price_${tag}`, { type: 'json' });
      if (cached && (Date.now() - (cached.ts || 0)) < PRICE_TTL * 1000) {
        results[tag] = cached;
        continue;
      }
    }
    toFetch.push(tag);
  }

  // Fetch missing in parallel
  const fetched = await Promise.allSettled(toFetch.map(async tag => {
    const data = await fetchCoflPrice(tag);
    if (env.FLIPPER_CACHE)
      ctx.waitUntil(env.FLIPPER_CACHE.put(`price_${tag}`, JSON.stringify({ ...data, ts: Date.now() }), { expirationTtl: PRICE_TTL }));
    return { tag, data };
  }));

  for (const r of fetched)
    if (r.status === 'fulfilled')
      results[r.value.tag] = r.value.data;

  return json({ success: true, prices: results });
}

async function fetchCoflPrice(tag) {
  // CoflNet public API — returns median, lbin, volume, fastSell
  const res = await fetch(`https://sky.coflnet.com/api/item/price/${encodeURIComponent(tag)}`, {
    headers: { 'User-Agent': 'sb-flipper/1.0', 'Accept': 'application/json' }
  });
  if (!res.ok) throw new Error(`CoflNet ${res.status} for ${tag}`);
  return res.json();
}

// ── Util ──────────────────────────────────────────────────────────────────────

async function hx(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'sb-flipper/1.0' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
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