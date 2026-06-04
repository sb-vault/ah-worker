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

    // Manual trigger — runs synchronously and returns result
    if (url.pathname === '/refresh') {
      if (!env.FLIPPER_CACHE) {
        return json({ success: false, error: 'KV binding FLIPPER_CACHE not found. Check Cloudflare dashboard → Workers → Settings → KV Namespace Bindings' });
      }
      try {
        await refreshBazaar(env);
        const bz = await env.FLIPPER_CACHE.get(BZ_KEY, { type: 'json' });
        return json({ success: true, bazaarProducts: bz ? bz.count : 0, message: 'Done' });
      } catch (e) {
        return json({ success: false, error: e.message });
      }
    }

    // Refresh BIN only
    if (url.pathname === '/refreshBIN') {
      if (!env.FLIPPER_CACHE) return json({ success: false, error: 'KV not bound' });
      try {
        await refreshBIN(env);
        return json({ success: true, message: 'BIN refreshed' });
      } catch (e) {
        return json({ success: false, error: e.message });
      }
    }

    if (url.pathname === '/debug') {
      const hasKV = !!env.FLIPPER_CACHE;
      let bzInfo = 'KV not bound', binInfo = 'KV not bound';
      if (hasKV) {
        try { const v = await env.FLIPPER_CACHE.get(BZ_KEY); bzInfo = v ? 'HAS DATA ('+v.length+' chars)' : 'EMPTY'; } catch(e) { bzInfo = 'ERROR:'+e.message; }
        try { const v = await env.FLIPPER_CACHE.get('bin_v8'); binInfo = v ? 'HAS DATA ('+v.length+' chars)' : 'EMPTY'; } catch(e) { binInfo = 'ERROR:'+e.message; }
      }
      return json({ kvBound: hasKV, bazaarCache: bzInfo, binCache: binInfo, hint: hasKV ? 'KV is bound. Visit /refresh to populate.' : 'Go to Cloudflare → Workers → ah-worker → Settings → Variables → add KV binding: FLIPPER_CACHE' });
    }

    return json({ error: 'Not found. Valid routes: /bazaar /auctions /lastUpdated /refresh /refreshBIN /debug' }, 404);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(Promise.all([refreshBazaar(env), refreshBIN(env)]));
  },
};

async function refreshBIN(env) {
  const BIN_KEY = 'bin_v8';
  try {
    const p0 = await hx('https://api.hypixel.net/v2/skyblock/auctions?page=0');
    if (!p0.success) throw new Error('Hypixel fail');
    let bins = p0.auctions.filter(a => a.bin).map(slimAuction);
    const pages = Array.from({ length: p0.totalPages - 1 }, (_, i) => i + 1);
    for (let i = 0; i < pages.length; i += 30) {
      const results = await Promise.allSettled(
        pages.slice(i, i + 30).map(pg => hx(`https://api.hypixel.net/v2/skyblock/auctions?page=${pg}`))
      );
      for (const r of results)
        if (r.status === 'fulfilled' && r.value.success)
          bins = bins.concat(r.value.auctions.filter(a => a.bin).map(slimAuction));
    }
    const data = { success:true, ts:Date.now(), lastUpdated:p0.lastUpdated, totalBIN:bins.length, auctions:bins };
    await env.FLIPPER_CACHE.put(BIN_KEY, JSON.stringify(data), { expirationTtl: 130 });
    console.log(`BIN: ${bins.length} auctions cached`);
  } catch (e) { console.error('BIN refresh:', e.message); }
}

function slimAuction(a) {
  const sbTag  = (a.item_name||'').replace(/[✪★☆✦]/g,'').replace(/\[Lvl \d+\]\s*/gi,'').trim()
    .toUpperCase().replace(/[^A-Z0-9]+/g,'_').replace(/^_+|_+$/g,'');
  const mcItem = deriveMcItem(a.item_name, a.extra);
  return { u:a.uuid, e:a.end, n:a.item_name, x:a.extra, c:a.category, t:a.tier, b:a.starting_bid, s:sbTag, m:mcItem };
}

async function refreshBazaar(env) {
  try {
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

const MC_ITEMS = [
  "Leather Helmet","Leather Chestplate","Leather Leggings","Leather Boots",
  "Iron Helmet","Iron Chestplate","Iron Leggings","Iron Boots",
  "Diamond Helmet","Diamond Chestplate","Diamond Leggings","Diamond Boots",
  "Chainmail Helmet","Chainmail Chestplate","Chainmail Leggings","Chainmail Boots",
  "Golden Helmet","Golden Chestplate","Golden Leggings","Golden Boots",
  "Netherite Helmet","Netherite Chestplate","Netherite Leggings","Netherite Boots",
  "Iron Sword","Diamond Sword","Golden Sword","Netherite Sword","Wooden Sword","Stone Sword",
  "Bow","Crossbow","Fishing Rod",
  "Iron Pickaxe","Diamond Pickaxe","Golden Pickaxe","Netherite Pickaxe",
  "Iron Axe","Diamond Axe","Golden Axe","Netherite Axe","Iron Shovel","Iron Hoe",
  "Skull Item","Player Head","Splash Potion","Lingering Potion","Potion",
  "Enchanted Book","Book","Ink Sack","Paper","Flint","Stick","Feather",
  "Cooked Fish","Raw Fish","Prismarine Shard","Beacon","End Crystal","Nether Star",
  "Shears","Clock","Compass","Chest","Hopper","Blaze Rod","Bone","Arrow",
].sort((a,b) => b.length - a.length);

function deriveMcItem(name, extra) {
  if (!extra) return null;
  const cn = (name||'').replace(/[✪★☆✦§\[\]]/g,'').replace(/Lvl \d+/gi,'').trim();
  const ce = (extra||'').replace(/[✪★☆✦§]/g,'').trim();
  let rem = ce;
  if (rem.toLowerCase().startsWith(cn.toLowerCase())) rem = rem.slice(cn.length).trim();
  for (const mc of MC_ITEMS)
    if (rem.toLowerCase().startsWith(mc.toLowerCase())) return mc;
  const words = rem.split(' ').filter(w => w && /^[A-Z]/.test(w));
  if (words.length >= 2) return words[0]+' '+words[1];
  return words[0] || null;
}

function json(d, s = 200) {
  return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json', ...cors() } });
}
function cors() {
  return { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' };
}