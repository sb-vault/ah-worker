// sb-flipper Worker v5
// - Ultra-slim BIN auctions (single-char keys, no lore)
// - Item-specific prices via CoflNet API with tier+enchant filters
// - Prices cached per unique item signature (tag+tier+key enchants)

const BIN_KEY   = 'bin_v6';
const KV_TTL    = 120;
const PRICE_TTL = 300;

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

    // Item-specific price: /price/{tag}?rarity=EPIC&enchants=sharpness:5,critical:6
    if (url.pathname.startsWith('/price/')) {
      const tag = decodeURIComponent(url.pathname.slice(7));
      const rarity  = url.searchParams.get('rarity')  || '';
      const enchants = url.searchParams.get('enchants') || '';
      return handleItemPrice(tag, rarity, enchants, env, ctx);
    }

    // Batch: POST /prices/batch  body: [{tag,rarity,enchants}]
    if (url.pathname === '/prices/batch' && request.method === 'POST') {
      const items = await request.json();
      return handleBatchPrices(items, env, ctx);
    }

    // GET batch via query string for simplicity
    if (url.pathname === '/prices/batch') {
      // tags=TAG1,TAG2,... (no filters, clean price only)
      const tags = (url.searchParams.get('tags') || '').split(',').filter(Boolean);
      const items = tags.map(t => ({ tag: t, rarity: '', enchants: '' }));
      return handleBatchPrices(items, env, ctx);
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
    console.log(`BIN: ${data.totalBIN} auctions, ${(JSON.stringify(data).length/1024).toFixed(0)}KB`);
  } catch (e) { console.error('BIN:', e.message); }
}

async function fetchAllBIN() {
  const t0 = Date.now();
  const p0 = await hx('https://api.hypixel.net/v2/skyblock/auctions?page=0');
  if (!p0.success) throw new Error('Hypixel fail');

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

  return { success: true, ts: Date.now(), lastUpdated: p0.lastUpdated, totalBIN: bins.length, fetchMs: Date.now() - t0, auctions: bins };
}

// Minimal fields — strip everything not needed for display
function slim(a) {
  // Parse tier and top enchants from lore for price key
  const enchants = extractEnchants(a.item_lore || '');
  return {
    u: a.uuid,
    e: a.end,
    n: a.item_name,
    x: a.extra,        // contains SB item tag as first token
    c: a.category,
    t: a.tier,
    b: a.starting_bid,
    k: enchants,       // key enchants for price lookup (max 3, top value ones)
  };
}

// Extract top enchants from lore string for price fingerprinting
function extractEnchants(lore) {
  if (!lore) return '';
  // Lore lines contain enchant names like "§9Sharpness V"
  const clean = lore.replace(/§[0-9a-fklmnor]/gi, '');
  const highValue = ['sharpness','critical','ultimate_wise','ultimate_jerry','execute',
    'first_strike','giant_killer','prosecute','supreme_sharpshooting','overload',
    'soul_eater','one_for_all','ultimate_legion','vampirism','life_steal',
    'thunderlord','thunderbolt','power','protection','true_protection'];
  const found = [];
  for (const ench of highValue) {
    const re = new RegExp(ench.replace('_',' ') + '\\s+(\\d+|[IVX]+)', 'i');
    const m = clean.match(re);
    if (m) {
      const lvl = parseLevel(m[1]);
      if (lvl > 0) found.push(`${ench}:${lvl}`);
    }
  }
  return found.slice(0, 3).join(',');
}

function parseLevel(s) {
  if (!s) return 0;
  if (/^\d+$/.test(s)) return parseInt(s);
  const roman = { I:1, V:5, X:10, L:50, C:100 };
  let n = 0, prev = 0;
  for (const c of s.toUpperCase().split('').reverse()) {
    const v = roman[c] || 0;
    n += v < prev ? -v : v;
    prev = v;
  }
  return n;
}

// ── Item-specific pricing via CoflNet ─────────────────────────────────────────

async function handleItemPrice(tag, rarity, enchants, env, ctx) {
  const cacheKey = priceKey(tag, rarity, enchants);
  if (env.FLIPPER_CACHE) {
    const c = await env.FLIPPER_CACHE.get(cacheKey, { type: 'json' });
    if (c && Date.now() - (c._ts || 0) < PRICE_TTL * 1000) return json({ ...c, cached: true });
  }
  try {
    const data = await fetchCoflPrice(tag, rarity, enchants);
    const stamped = { ...data, _ts: Date.now() };
    if (env.FLIPPER_CACHE)
      ctx.waitUntil(env.FLIPPER_CACHE.put(cacheKey, JSON.stringify(stamped), { expirationTtl: PRICE_TTL }));
    return json(data);
  } catch (e) { return json({ error: e.message }, 500); }
}

async function handleBatchPrices(items, env, ctx) {
  const out = {};
  const toFetch = [];

  for (const item of items.slice(0, 60)) {
    const { tag, rarity = '', enchants = '' } = item;
    const ck = priceKey(tag, rarity, enchants);
    if (env.FLIPPER_CACHE) {
      const c = await env.FLIPPER_CACHE.get(ck, { type: 'json' });
      if (c && Date.now() - (c._ts || 0) < PRICE_TTL * 1000) { out[ck] = c; continue; }
    }
    toFetch.push({ tag, rarity, enchants, ck });
  }

  const fetched = await Promise.allSettled(toFetch.map(async ({ tag, rarity, enchants, ck }) => {
    const data = await fetchCoflPrice(tag, rarity, enchants);
    const stamped = { ...data, _ts: Date.now() };
    if (env.FLIPPER_CACHE)
      ctx.waitUntil(env.FLIPPER_CACHE.put(ck, JSON.stringify(stamped), { expirationTtl: PRICE_TTL }));
    return { ck, data };
  }));

  for (const r of fetched)
    if (r.status === 'fulfilled') out[r.value.ck] = r.value.data;

  return json({ success: true, prices: out });
}

async function fetchCoflPrice(tag, rarity, enchants) {
  // Build CoflNet URL with filters for item-specific price
  let url = `https://sky.coflnet.com/api/item/price/${encodeURIComponent(tag)}`;
  const params = new URLSearchParams();
  if (rarity)  params.set('Rarity', rarity);
  // CoflNet accepts Reforge, Enchantment=type;level query params
  if (enchants) {
    const parts = enchants.split(',');
    for (const p of parts) {
      const [name, lvl] = p.split(':');
      if (name && lvl) params.append('Enchantment', `${name};${lvl}`);
    }
  }
  const qs = params.toString();
  if (qs) url += '?' + qs;

  const res = await fetch(url, {
    headers: { 'User-Agent': 'sb-flipper/1.0', Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`CoflNet ${res.status}`);
  return res.json();
}

function priceKey(tag, rarity, enchants) {
  return `p:${tag}:${rarity}:${enchants}`.slice(0, 256);
}

// ── Util ──────────────────────────────────────────────────────────────────────

async function hx(url) {
  const r = await fetch(url, { headers: { 'User-Agent': 'sb-flipper/1.0' } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}
function json(d, s = 200) {
  return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json', ...cors() } });
}
function cors() {
  return { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' };
}