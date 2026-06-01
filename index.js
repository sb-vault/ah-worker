// sb-flipper Worker v4
// Ultra-slim auction data + real-time CoflNet price enrichment

const BIN_KEY   = 'bin_v5';
const KV_TTL    = 120;
const PRICE_TTL = 300;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors() });

    // Cheapest possible poll — just returns lastUpdated timestamp
    if (url.pathname === '/lastUpdated') {
      try {
        const p0 = await hx('https://api.hypixel.net/v2/skyblock/auctions?page=0');
        return json({ lastUpdated: p0.lastUpdated });
      } catch (e) { return json({ error: e.message }, 500); }
    }

    // Full slim BIN list
    if (url.pathname === '/auctions' || url.pathname === '/') {
      return handleAuctions(env, ctx);
    }

    // Single item price via CoflNet — cached in KV
    if (url.pathname.startsWith('/price/')) {
      const tag = decodeURIComponent(url.pathname.slice(7));
      return handlePrice(tag, env, ctx);
    }

    // Batch prices — up to 50 tags, comma-separated query param
    if (url.pathname === '/prices/batch') {
      const tags = (url.searchParams.get('tags') || '').split(',').filter(t => t.trim());
      return handleBatchPrices(tags.slice(0, 50), env, ctx);
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
      // Check if Hypixel has updated
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
    console.log(`BIN refreshed: ${data.totalBIN} auctions, ${JSON.stringify(data).length >> 10}KB`);
  } catch (e) { console.error('BIN refresh error:', e.message); }
}

async function fetchAllBIN() {
  const t0 = Date.now();
  const p0 = await hx('https://api.hypixel.net/v2/skyblock/auctions?page=0');
  if (!p0.success) throw new Error('Hypixel API failure');

  // Collect BIN auctions from all pages concurrently (batches of 30)
  let bins = p0.auctions.filter(a => a.bin).map(slim);
  const pages = Array.from({ length: p0.totalPages - 1 }, (_, i) => i + 1);

  for (let i = 0; i < pages.length; i += 30) {
    const batch = pages.slice(i, i + 30);
    const results = await Promise.allSettled(
      batch.map(p => hx(`https://api.hypixel.net/v2/skyblock/auctions?page=${p}`))
    );
    for (const r of results)
      if (r.status === 'fulfilled' && r.value.success)
        bins = bins.concat(r.value.auctions.filter(a => a.bin).map(slim));
  }

  return {
    success:     true,
    ts:          Date.now(),
    lastUpdated: p0.lastUpdated,
    totalBIN:    bins.length,
    fetchMs:     Date.now() - t0,
    auctions:    bins,
  };
}

// SLIM — only what the mod needs. item_bytes kept for NBT parsing.
// Single-char keys save ~30% bandwidth.
function slim(a) {
  return {
    u: a.uuid,
    e: a.end,
    n: a.item_name,
    x: a.extra,
    c: a.category,
    t: a.tier,
    b: a.starting_bid,
    // item_bytes gives us the real MC item data for texture + tooltip
    // It's base64 NBT — include it so the mod can decode it
    // Only include if present (not all auctions have it)
    ...(a.item_bytes ? { ib: a.item_bytes } : {}),
  };
}

// ── Price data via CoflNet API ────────────────────────────────────────────────

async function handlePrice(tag, env, ctx) {
  if (!tag) return json({ error: 'no tag' }, 400);
  const ck = `p:${tag}`;
  if (env.FLIPPER_CACHE) {
    const c = await env.FLIPPER_CACHE.get(ck, { type: 'json' });
    if (c && Date.now() - (c._ts || 0) < PRICE_TTL * 1000) return json({ ...c, cached: true });
  }
  try {
    const data = await coflPrice(tag);
    const stamped = { ...data, _ts: Date.now() };
    if (env.FLIPPER_CACHE)
      ctx.waitUntil(env.FLIPPER_CACHE.put(ck, JSON.stringify(stamped), { expirationTtl: PRICE_TTL }));
    return json(data);
  } catch (e) { return json({ error: e.message }, 500); }
}

async function handleBatchPrices(tags, env, ctx) {
  const out = {};
  const toFetch = [];

  // Check KV cache first
  for (const tag of tags) {
    const ck = `p:${tag}`;
    if (env.FLIPPER_CACHE) {
      const c = await env.FLIPPER_CACHE.get(ck, { type: 'json' });
      if (c && Date.now() - (c._ts || 0) < PRICE_TTL * 1000) { out[tag] = c; continue; }
    }
    toFetch.push(tag);
  }

  // Fetch missing in parallel
  const fetched = await Promise.allSettled(toFetch.map(async tag => {
    const data = await coflPrice(tag);
    const stamped = { ...data, _ts: Date.now() };
    if (env.FLIPPER_CACHE)
      ctx.waitUntil(env.FLIPPER_CACHE.put(`p:${tag}`, JSON.stringify(stamped), { expirationTtl: PRICE_TTL }));
    return { tag, data };
  }));
  for (const r of fetched)
    if (r.status === 'fulfilled') out[r.value.tag] = r.value.data;

  return json({ success: true, prices: out });
}

async function coflPrice(tag) {
  const res = await fetch(`https://sky.coflnet.com/api/item/price/${encodeURIComponent(tag)}`, {
    headers: { 'User-Agent': 'sb-flipper/1.0', Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`CoflNet HTTP ${res.status}`);
  return res.json();
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function hx(url) {
  const r = await fetch(url, { headers: { 'User-Agent': 'sb-flipper/1.0' } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}
function json(d, s = 200) {
  return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json', ...cors() } });
}
function cors() {
  return { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' };
}