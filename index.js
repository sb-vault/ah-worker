// sb-flipper Cloudflare Worker
// Deploy to Cloudflare Workers — handles CORS + caches auction data
// Endpoint: GET /auctions  → returns all BIN auctions (from cache or fresh fetch)
// Cache is refreshed every ~60s on request (Hypixel updates AH every ~60s)

const CACHE_KEY = 'bin_auctions_v1';
const CACHE_TTL = 55; // seconds — slightly under Hypixel's ~60s cycle

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: corsHeaders(),
      });
    }

    // Health check
    if (url.pathname === '/ping') {
      return json({ ok: true, ts: Date.now() });
    }

    // Main auctions endpoint
    if (url.pathname === '/auctions' || url.pathname === '/') {
      return handleAuctions(request, env, ctx);
    }

    return new Response('Not found', { status: 404, headers: corsHeaders() });
  },
};

async function handleAuctions(request, env, ctx) {
  const url = new URL(request.url);
  const forceRefresh = url.searchParams.get('refresh') === '1';

  // Try KV cache first (if KV binding available)
  if (env.FLIPPER_CACHE && !forceRefresh) {
    try {
      const cached = await env.FLIPPER_CACHE.get(CACHE_KEY, { type: 'json' });
      if (cached && cached.ts && (Date.now() - cached.ts) < CACHE_TTL * 1000) {
        return json({ ...cached, cached: true });
      }
    } catch (_) {}
  }

  // Fetch fresh data
  const data = await fetchAllBINAuctions();

  // Store in KV cache (background, don't block response)
  if (env.FLIPPER_CACHE) {
    ctx.waitUntil(
      env.FLIPPER_CACHE.put(CACHE_KEY, JSON.stringify(data), { expirationTtl: CACHE_TTL + 10 })
    );
  }

  return json(data);
}

async function fetchAllBINAuctions() {
  const startTime = Date.now();

  // Fetch page 0 first to get totalPages
  const page0 = await fetchPage(0);
  if (!page0.success) {
    throw new Error('Hypixel API returned failure');
  }

  const totalPages = page0.totalPages;
  const lastUpdated = page0.lastUpdated;

  // Collect BIN auctions from page 0
  let binAuctions = page0.auctions.filter(a => a.bin === true);

  // Fetch remaining pages in parallel (cap at 40 concurrent)
  if (totalPages > 1) {
    const pageNums = Array.from({ length: totalPages - 1 }, (_, i) => i + 1);
    
    // Batch into groups of 20 to avoid overwhelming the API
    const batchSize = 20;
    for (let i = 0; i < pageNums.length; i += batchSize) {
      const batch = pageNums.slice(i, i + batchSize);
      const results = await Promise.allSettled(batch.map(p => fetchPage(p)));
      for (const result of results) {
        if (result.status === 'fulfilled' && result.value.success) {
          binAuctions = binAuctions.concat(
            result.value.auctions.filter(a => a.bin === true)
          );
        }
      }
    }
  }

  // Slim down the auction objects — only keep what the frontend needs
  const slim = binAuctions.map(a => ({
    uuid: a.uuid,
    auctioneer: a.auctioneer,
    end: a.end,
    item_name: a.item_name,
    item_lore: a.item_lore,
    extra: a.extra,
    category: a.category,
    tier: a.tier,
    starting_bid: a.starting_bid,
    claimed: a.claimed,
    // item_bytes omitted — heavy and not needed for display
  }));

  return {
    success: true,
    ts: Date.now(),
    lastUpdated,
    totalPages,
    totalBIN: slim.length,
    fetchMs: Date.now() - startTime,
    auctions: slim,
  };
}

async function fetchPage(page) {
  const res = await fetch(`https://api.hypixel.net/v2/skyblock/auctions?page=${page}`, {
    headers: { 'User-Agent': 'sb-flipper/1.0' },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for page ${page}`);
  return res.json();
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...corsHeaders(),
    },
  });
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}