// sb-flipper Bazaar Worker v2
// 1102 fix: heavy processing only in cron, fetch always serves from KV
// On cold start (no KV), return minimal loading response — cron will populate

const BZ_KEY  = 'bz_v2';
const KV_TTL  = 130;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors() });

    if (url.pathname === '/lastUpdated') {
      if (env.FLIPPER_CACHE) {
        // Check both bazaar and BIN caches
        const bz = await env.FLIPPER_CACHE.get(BZ_KEY, { type: 'json' });
        if (bz) return json({ lastUpdated: bz.lastUpdated, ts: bz.ts });
      }
      return json({ lastUpdated: 0 });
    }

    if (url.pathname === '/bazaar') {
      if (env.FLIPPER_CACHE) {
        const c = await env.FLIPPER_CACHE.get(BZ_KEY, { type: 'json' });
        if (c) return json({ ...c, cached: true });
      }
      ctx.waitUntil(refreshBazaar(env));
      return json({ success: true, loading: true, products: [], lastUpdated: 0, ts: Date.now() });
    }

    // Keep /auctions alive for AH flipper mod
    if (url.pathname === '/auctions' || url.pathname === '/') {
      const BIN_KEY = 'bin_v8';
      if (env.FLIPPER_CACHE) {
        const c = await env.FLIPPER_CACHE.get(BIN_KEY, { type: 'json' });
        if (c) return json({ ...c, cached: true });
      }
      return json({ success: false, error: 'Cache cold — wait for cron refresh', auctions: [] });
    }

    return new Response('Not found', { status: 404, headers: cors() });
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(refreshBazaar(env));
  },
};

async function refreshBazaar(env) {
  try {
    // Fetch raw bazaar data
    const r = await fetch('https://api.hypixel.net/v2/skyblock/bazaar', {
      headers: { 'User-Agent': 'sb-flipper/1.0' }
    });
    if (!r.ok) throw new Error(`Hypixel ${r.status}`);
    const raw = await r.json();

    // Process in cron context (no CPU limit issue)
    const products = [];
    for (const [id, p] of Object.entries(raw.products || {})) {
      const qs = p.quick_status;
      if (!qs || qs.buyPrice <= 0 || qs.sellPrice <= 0) continue;

      const instantBuy   = qs.buyPrice;
      const instantSell  = qs.sellPrice;
      const sellWeek     = qs.sellMovingWeek || 0;
      const buyWeek      = qs.buyMovingWeek  || 0;

      const buySummary  = (p.buy_summary  || []).slice(0, 10);
      const sellSummary = (p.sell_summary || []).slice(0, 10);

      const topBuyPrice  = buySummary.length  > 0 ? buySummary[0].pricePerUnit  : 0;
      const topSellPrice = sellSummary.length > 0 ? sellSummary[0].pricePerUnit : 0;

      const spread       = topSellPrice > 0 && topBuyPrice > 0 ? topSellPrice - topBuyPrice : 0;
      const spreadPct    = topBuyPrice  > 0 ? (spread / topBuyPrice) * 100 : 0;

      const flipBuyAt    = topBuyPrice  > 0 ? topBuyPrice  + 0.1 : instantBuy;
      const flipSellAt   = topSellPrice > 0 ? topSellPrice - 0.1 : instantSell;
      const flipMargin   = flipSellAt - flipBuyAt;
      const flipMarginPct= flipBuyAt > 0 ? (flipMargin / flipBuyAt) * 100 : 0;

      const midPrice     = (instantBuy + instantSell) / 2;
      const weeklyCoins  = Math.min(buyWeek, sellWeek) * midPrice;

      const buyDepth     = buySummary.reduce( (s, o) => s + o.amount, 0);
      const sellDepth    = sellSummary.reduce((s, o) => s + o.amount, 0);

      products.push({
        id,
        instantBuy:    round1(instantBuy),
        instantSell:   round1(instantSell),
        topBuyPrice:   round1(topBuyPrice),
        topSellPrice:  round1(topSellPrice),
        spread:        round1(spread),
        spreadPct:     round2(spreadPct),
        flipBuyAt:     round1(flipBuyAt),
        flipSellAt:    round1(flipSellAt),
        flipMargin:    round1(flipMargin),
        flipMarginPct: round2(flipMarginPct),
        sellVol:       qs.sellVolume  || 0,
        buyVol:        qs.buyVolume   || 0,
        sellWeek,
        buyWeek,
        sellOrders:    qs.sellOrders  || 0,
        buyOrders:     qs.buyOrders   || 0,
        weeklyCoins:   Math.round(weeklyCoins),
        buyDepth,
        sellDepth,
        buySummary:    buySummary.map(o => ({ a: Math.round(o.amount), p: round1(o.pricePerUnit), n: o.orders })),
        sellSummary:   sellSummary.map(o => ({ a: Math.round(o.amount), p: round1(o.pricePerUnit), n: o.orders })),
      });
    }

    const data = {
      success: true,
      ts: Date.now(),
      lastUpdated: raw.lastUpdated,
      count: products.length,
      products,
    };

    await env.FLIPPER_CACHE.put(BZ_KEY, JSON.stringify(data), { expirationTtl: KV_TTL });
    console.log(`Bazaar: ${products.length} products cached`);
  } catch (e) {
    console.error('Bazaar refresh error:', e.message);
  }
}

const round1 = v => Math.round(v * 10) / 10;
const round2 = v => Math.round(v * 100) / 100;

function json(d, s = 200) {
  return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json', ...cors() } });
}
function cors() {
  return { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' };
}