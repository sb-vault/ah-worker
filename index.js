// sb-flipper Worker
// /lastUpdated  — cheap poll, just checks Hypixel page 0 timestamp
// /auctions     — full BIN list from KV cache
// /ended        — recently sold auctions (for median price calculation)

const CACHE_KEY    = 'bin_auctions_v2';
const ENDED_KEY    = 'ended_auctions_v1';
const KV_TTL       = 120;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors() });

    if (url.pathname === '/lastUpdated') {
      try {
        const p0 = await fetchPage(0);
        return json({ lastUpdated: p0.lastUpdated });
      } catch (e) { return json({ error: e.message }, 500); }
    }

    if (url.pathname === '/auctions' || url.pathname === '/') {
      return handleAuctions(env, ctx);
    }

    if (url.pathname === '/ended') {
      return handleEnded(env, ctx);
    }

    return new Response('Not found', { status: 404, headers: cors() });
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(Promise.all([refreshKV(env), refreshEnded(env)]));
  },
};

// ── BIN auctions ─────────────────────────────────────────────────────────────

async function handleAuctions(env, ctx) {
  if (env.FLIPPER_CACHE) {
    const cached = await env.FLIPPER_CACHE.get(CACHE_KEY, { type: 'json' });
    if (cached) {
      const p0 = await fetchPage(0);
      if (p0.lastUpdated <= cached.lastUpdated) return json({ ...cached, cached: true });
      ctx.waitUntil(refreshKV(env));
      const fresh = await fetchAllBIN();
      return json(fresh);
    }
  }
  const data = await fetchAllBIN();
  if (env.FLIPPER_CACHE)
    ctx.waitUntil(env.FLIPPER_CACHE.put(CACHE_KEY, JSON.stringify(data), { expirationTtl: KV_TTL }));
  return json(data);
}

async function refreshKV(env) {
  try {
    const data = await fetchAllBIN();
    await env.FLIPPER_CACHE.put(CACHE_KEY, JSON.stringify(data), { expirationTtl: KV_TTL });
    console.log(`BIN refreshed — ${data.totalBIN} auctions in ${data.fetchMs}ms`);
  } catch (e) { console.error('BIN refresh error:', e); }
}

async function fetchAllBIN() {
  const t0 = Date.now();
  const p0 = await fetchPage(0);
  if (!p0.success) throw new Error('Hypixel API failure');

  let bins = p0.auctions.filter(a => a.bin);
  const pages = Array.from({ length: p0.totalPages - 1 }, (_, i) => i + 1);
  for (let i = 0; i < pages.length; i += 20) {
    const batch = pages.slice(i, i + 20);
    const results = await Promise.allSettled(batch.map(fetchPage));
    for (const r of results)
      if (r.status === 'fulfilled' && r.value.success)
        bins = bins.concat(r.value.auctions.filter(a => a.bin));
  }

  const slim = bins.map(a => ({
    uuid:        a.uuid,
    end:         a.end,
    item_name:   a.item_name,
    item_lore:   a.item_lore,
    extra:       a.extra,
    category:    a.category,
    tier:        a.tier,
    starting_bid:a.starting_bid,
  }));

  return { success: true, ts: Date.now(), lastUpdated: p0.lastUpdated, totalBIN: slim.length, fetchMs: Date.now() - t0, auctions: slim };
}

async function fetchPage(page) {
  const res = await fetch(`https://api.hypixel.net/v2/skyblock/auctions?page=${page}`, { headers: { 'User-Agent': 'sb-flipper/1.0' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// ── Ended auctions (for median price) ────────────────────────────────────────

async function handleEnded(env, ctx) {
  if (env.FLIPPER_CACHE) {
    const cached = await env.FLIPPER_CACHE.get(ENDED_KEY, { type: 'json' });
    if (cached && (Date.now() - cached.ts) < 65_000) return json({ ...cached, cached: true });
  }
  const data = await fetchEnded();
  if (env.FLIPPER_CACHE)
    ctx.waitUntil(env.FLIPPER_CACHE.put(ENDED_KEY, JSON.stringify(data), { expirationTtl: KV_TTL }));
  return json(data);
}

async function refreshEnded(env) {
  try {
    const data = await fetchEnded();
    await env.FLIPPER_CACHE.put(ENDED_KEY, JSON.stringify(data), { expirationTtl: KV_TTL });
  } catch (e) { console.error('Ended refresh error:', e); }
}

async function fetchEnded() {
  const res = await fetch('https://api.hypixel.net/v2/skyblock/auctions/ended', { headers: { 'User-Agent': 'sb-flipper/1.0' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();

  // Build item_name -> sorted price list for median calculation
  // Group by item_name (normalised)
  const groups = {};
  for (const a of (data.auctions || [])) {
    const name = normaliseName(a.item_name);
    if (!groups[name]) groups[name] = [];
    groups[name].push(a.price);
  }

  // For each group: sort and store [median, lbin, count, volume]
  const medians = {};
  for (const [name, prices] of Object.entries(groups)) {
    prices.sort((a, b) => a - b);
    const mid = Math.floor(prices.length / 2);
    const median = prices.length % 2 === 0
      ? Math.round((prices[mid - 1] + prices[mid]) / 2)
      : prices[mid];
    medians[name] = { median, lbin: prices[0], count: prices.length };
  }

  return { success: true, ts: Date.now(), lastUpdated: data.lastUpdated || Date.now(), medians };
}

function normaliseName(name) {
  // Strip Minecraft colour codes and normalise
  return (name || '').replace(/§[0-9a-fklmnor]/gi, '').trim().toLowerCase();
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...cors() } });
}

function cors() {
  return { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' };
}