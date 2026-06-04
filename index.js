// sb-flipper Bazaar Worker
// - Polls https://api.hypixel.net/v2/skyblock/bazaar every 60s
// - Calculates flip opportunities using order book analysis
// - Serves cached data to mod instantly

const BZ_KEY = 'bazaar_v1';
const KV_TTL = 75; // slightly over 60s

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors() });

    if (url.pathname === '/bazaar') return serveBazaar(env, ctx);
    if (url.pathname === '/lastUpdated') {
      if (env.FLIPPER_CACHE) {
        const c = await env.FLIPPER_CACHE.get(BZ_KEY, { type: 'json' });
        if (c) return json({ lastUpdated: c.lastUpdated, ts: c.ts });
      }
      return json({ lastUpdated: 0 });
    }
    return new Response('Not found', { status: 404, headers: cors() });
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(refreshBazaar(env));
  },
};

async function serveBazaar(env, ctx) {
  if (env.FLIPPER_CACHE) {
    const cached = await env.FLIPPER_CACHE.get(BZ_KEY, { type: 'json' });
    if (cached) return json({ ...cached, cached: true });
  }
  const data = await fetchBazaar();
  if (env.FLIPPER_CACHE)
    ctx.waitUntil(env.FLIPPER_CACHE.put(BZ_KEY, JSON.stringify(data), { expirationTtl: KV_TTL }));
  return json(data);
}

async function refreshBazaar(env) {
  try {
    const data = await fetchBazaar();
    await env.FLIPPER_CACHE.put(BZ_KEY, JSON.stringify(data), { expirationTtl: KV_TTL });
    console.log(`Bazaar refreshed: ${data.products.length} products`);
  } catch (e) { console.error('Bazaar refresh:', e.message); }
}

async function fetchBazaar() {
  const r = await fetch('https://api.hypixel.net/v2/skyblock/bazaar', {
    headers: { 'User-Agent': 'sb-flipper/1.0' }
  });
  if (!r.ok) throw new Error(`Hypixel ${r.status}`);
  const raw = await r.json();

  const products = [];
  for (const [id, p] of Object.entries(raw.products || {})) {
    const qs = p.quick_status;
    if (!qs) continue;

    const instantBuy  = qs.buyPrice;   // price to instantly buy (pay this)
    const instantSell = qs.sellPrice;  // price to instantly sell (receive this)
    const sellVol     = qs.sellMovingWeek;
    const buyVol      = qs.buyMovingWeek;

    // Order book: top 5 buy orders (people buying = you can sell to them)
    const topBuyOrders  = (p.buy_summary  || []).slice(0, 5);
    // Top 5 sell orders (people selling = you can buy from them)
    const topSellOrders = (p.sell_summary || []).slice(0, 5);

    // Best buy order price (highest price someone is willing to pay)
    const topBuyPrice  = topBuyOrders.length  > 0 ? topBuyOrders[0].pricePerUnit  : 0;
    // Best sell order price (lowest price someone is selling at)
    const topSellPrice = topSellOrders.length > 0 ? topSellOrders[0].pricePerUnit : 0;

    // Spread = the gap between best sell offer and best buy bid
    const spread = topSellPrice > 0 && topBuyPrice > 0 ? topSellPrice - topBuyPrice : 0;
    const spreadPct = topBuyPrice > 0 ? (spread / topBuyPrice) * 100 : 0;

    // Order book depth (how much can be filled before price moves significantly)
    const buyDepth  = topBuyOrders.reduce((s, o) => s + o.amount, 0);
    const sellDepth = topSellOrders.reduce((s, o) => s + o.amount, 0);

    // Flip margin: buy order slightly above top bid, sell slightly below top ask
    // Realistic: place buy at topBuyPrice + 0.1, sell at topSellPrice - 0.1
    const flipBuyAt  = topBuyPrice  > 0 ? topBuyPrice  + 0.1 : instantBuy;
    const flipSellAt = topSellPrice > 0 ? topSellPrice - 0.1 : instantSell;
    const flipMargin = flipSellAt - flipBuyAt;
    const flipMarginPct = flipBuyAt > 0 ? (flipMargin / flipBuyAt) * 100 : 0;

    // Weekly volume in coins (liquidity signal)
    const weeklyCoins = Math.min(buyVol, sellVol) * ((instantBuy + instantSell) / 2);

    products.push({
      id,
      // Prices
      instantBuy:   Math.round(instantBuy  * 10) / 10,
      instantSell:  Math.round(instantSell * 10) / 10,
      topBuyPrice:  Math.round(topBuyPrice * 10) / 10,
      topSellPrice: Math.round(topSellPrice * 10) / 10,
      spread:       Math.round(spread * 10) / 10,
      spreadPct:    Math.round(spreadPct * 100) / 100,
      // Flip
      flipBuyAt:    Math.round(flipBuyAt  * 10) / 10,
      flipSellAt:   Math.round(flipSellAt * 10) / 10,
      flipMargin:   Math.round(flipMargin * 10) / 10,
      flipMarginPct:Math.round(flipMarginPct * 100) / 100,
      // Volume / liquidity
      sellVol:      qs.sellVolume,
      buyVol:       qs.buyVolume,
      sellWeek:     sellVol,
      buyWeek:      buyVol,
      sellOrders:   qs.sellOrders,
      buyOrders:    qs.buyOrders,
      weeklyCoins:  Math.round(weeklyCoins),
      buyDepth,
      sellDepth,
      // Raw order books (top 10 each) for display
      buySummary:  (p.buy_summary  || []).slice(0, 10),
      sellSummary: (p.sell_summary || []).slice(0, 10),
    });
  }

  return {
    success: true,
    ts: Date.now(),
    lastUpdated: raw.lastUpdated,
    count: products.length,
    products,
  };
}

function json(d, s = 200) {
  return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json', ...cors() } });
}
function cors() {
  return { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' };
}