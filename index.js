// sb-flipper Worker v6
// Key changes:
// - KV cache is mandatory — all AH data served from cache, never hitting Hypixel per-request
// - Cron refreshes every minute, all users get cached data instantly
// - CoflNet prices fetched via /api/item/price/{tag} with proper filters
// - Bandwidth: slim auction objects, no lore, gzip response

const BIN_KEY   = 'bin_v7';
const KV_TTL    = 130;  // slightly over 60s cron interval
const PRICE_TTL = 300;  // 5 min price cache

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors() });

    if (url.pathname === '/lastUpdated') {
      // Serve from KV if possible — avoids hitting Hypixel at all
      if (env.FLIPPER_CACHE) {
        const cached = await env.FLIPPER_CACHE.get(BIN_KEY, { type: 'json' });
        if (cached) return json({ lastUpdated: cached.lastUpdated });
      }
      try {
        const p0 = await hx('https://api.hypixel.net/v2/skyblock/auctions?page=0');
        return json({ lastUpdated: p0.lastUpdated });
      } catch (e) { return json({ error: e.message }, 500); }
    }

    if (url.pathname === '/auctions' || url.pathname === '/') {
      return serveAuctions(env, ctx);
    }

    // Price: /price/{tag}?rarity=EPIC
    if (url.pathname.startsWith('/price/')) {
      const tag    = decodeURIComponent(url.pathname.slice(7));
      const rarity = url.searchParams.get('rarity') || '';
      return servePrice(tag, rarity, env, ctx);
    }

    // Batch prices: GET /prices?tags=TAG1:RARITY,TAG2:RARITY,...
    if (url.pathname === '/prices') {
      const raw  = (url.searchParams.get('tags') || '').split(',').filter(Boolean);
      const items = raw.map(r => { const [tag, rarity=''] = r.split(':'); return {tag, rarity}; });
      return serveBatchPrices(items.slice(0, 80), env, ctx);
    }

    return new Response('Not found', { status: 404, headers: cors() });
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(refreshBIN(env));
  },
};

// ── Serve from KV (no Hypixel hit) ───────────────────────────────────────────

async function serveAuctions(env, ctx) {
  if (env.FLIPPER_CACHE) {
    const cached = await env.FLIPPER_CACHE.get(BIN_KEY, { type: 'json' });
    if (cached) return json({ ...cached, cached: true });
  }
  // Cold cache — fetch now (first deploy only)
  const data = await fetchAllBIN();
  if (env.FLIPPER_CACHE)
    ctx.waitUntil(env.FLIPPER_CACHE.put(BIN_KEY, JSON.stringify(data), { expirationTtl: KV_TTL }));
  return json(data);
}

// ── Cron: refresh BIN every minute ───────────────────────────────────────────

async function refreshBIN(env) {
  try {
    const data = await fetchAllBIN();
    const str  = JSON.stringify(data);
    await env.FLIPPER_CACHE.put(BIN_KEY, str, { expirationTtl: KV_TTL });
    console.log(`BIN refreshed: ${data.totalBIN} auctions, ${(str.length/1024).toFixed(0)}KB`);
  } catch (e) { console.error('BIN refresh error:', e.message); }
}

async function fetchAllBIN() {
  const t0 = Date.now();
  const p0 = await hx('https://api.hypixel.net/v2/skyblock/auctions?page=0');
  if (!p0.success) throw new Error('Hypixel fail');

  let bins = p0.auctions.filter(a => a.bin).map(slim);
  const pages = Array.from({ length: p0.totalPages - 1 }, (_, i) => i + 1);

  // Fetch all pages in parallel, 30 at a time
  for (let i = 0; i < pages.length; i += 30) {
    const batch   = pages.slice(i, i + 30);
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

// Ultra-slim — only what we need. ~120 bytes per auction vs ~2KB raw.
function slim(a) {
  return {
    u: a.uuid,
    e: a.end,
    n: a.item_name,   // display name (includes ✪ stars etc)
    x: a.extra,       // "ITEM_TAG ..." — tag is first token
    c: a.category,
    t: a.tier,
    b: a.starting_bid,
    // No item_bytes — too large. Tag + category gives us enough for display.
  };
}

// ── Prices via CoflNet ────────────────────────────────────────────────────────

async function servePrice(tag, rarity, env, ctx) {
  const ck = `p2:${tag}:${rarity}`;
  if (env.FLIPPER_CACHE) {
    const c = await env.FLIPPER_CACHE.get(ck, { type: 'json' });
    if (c && Date.now() - (c._ts||0) < PRICE_TTL*1000) return json({...c, cached:true});
  }
  try {
    const data = await coflPrice(tag, rarity);
    if (env.FLIPPER_CACHE)
      ctx.waitUntil(env.FLIPPER_CACHE.put(ck, JSON.stringify({...data, _ts:Date.now()}), { expirationTtl: PRICE_TTL }));
    return json(data);
  } catch (e) { return json({ error: e.message }, 500); }
}

async function serveBatchPrices(items, env, ctx) {
  const out = {}, toFetch = [];
  for (const {tag, rarity} of items) {
    const ck = `p2:${tag}:${rarity}`;
    if (env.FLIPPER_CACHE) {
      const c = await env.FLIPPER_CACHE.get(ck, { type: 'json' });
      if (c && Date.now() - (c._ts||0) < PRICE_TTL*1000) { out[`${tag}:${rarity}`] = c; continue; }
    }
    toFetch.push({tag, rarity, ck});
  }

  // Fetch missing in parallel (CoflNet can handle it)
  const fetched = await Promise.allSettled(toFetch.map(async ({tag, rarity, ck}) => {
    const data = await coflPrice(tag, rarity);
    if (env.FLIPPER_CACHE)
      ctx.waitUntil(env.FLIPPER_CACHE.put(ck, JSON.stringify({...data, _ts:Date.now()}), { expirationTtl: PRICE_TTL }));
    return { key: `${tag}:${rarity}`, data };
  }));
  for (const r of fetched)
    if (r.status === 'fulfilled') out[r.value.key] = r.value.data;

  return json({ success: true, prices: out });
}

async function coflPrice(tag, rarity) {
  let url = `https://sky.coflnet.com/api/item/price/${encodeURIComponent(tag)}`;
  if (rarity) url += `?Rarity=${encodeURIComponent(rarity)}`;
  const res = await fetch(url, { headers: { 'User-Agent':'sb-flipper/1.0', Accept:'application/json' } });
  if (!res.ok) throw new Error(`CoflNet ${res.status}`);
  return res.json();
}

// ── Util ──────────────────────────────────────────────────────────────────────

async function hx(url) {
  const r = await fetch(url, { headers: { 'User-Agent': 'sb-flipper/1.0' } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}
function json(d, s=200) {
  return new Response(JSON.stringify(d), { status:s, headers:{'Content-Type':'application/json',...cors()} });
}
function cors() {
  return { 'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'GET,OPTIONS','Access-Control-Allow-Headers':'Content-Type' };
}