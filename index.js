// sb-flipper Worker v7
// - Parses MC item directly from x field (strip SB name → first MC item tokens)
// - Correct SB tag derivation for CoflNet price lookup
// - All auction data served from KV cache — zero per-request Hypixel hits
// - Cron refreshes KV every minute

const BIN_KEY   = 'bin_v8';
const KV_TTL    = 130;
const PRICE_TTL = 300;

// All known vanilla MC item names that appear in the x field after the SB item name
// Ordered longest-first so we match "Leather Chestplate" before "Leather"
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
  "Iron Axe","Diamond Axe","Golden Axe","Netherite Axe",
  "Iron Shovel","Iron Hoe",
  "Skull Item","Player Head",
  "Splash Potion","Lingering Potion","Potion",
  "Enchanted Book","Book",
  "Ink Sack","Paper","Flint","Stick","Feather","Leather","Iron Ingot",
  "Cooked Fish","Raw Fish",
  "Prismarine Shard","Prismarine Crystals",
  "Beacon","End Crystal","Nether Star",
  "Record","Music Disc",
  "Shears","Clock","Compass",
  "Chest","Hopper","Dispenser","Dropper",
  "Blaze Rod","Bone","Arrow",
  "String","Slimeball",
].sort((a,b) => b.length - a.length); // longest first

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors() });

    if (url.pathname === '/lastUpdated') {
      if (env.FLIPPER_CACHE) {
        const c = await env.FLIPPER_CACHE.get(BIN_KEY, { type: 'json' });
        if (c) return json({ lastUpdated: c.lastUpdated, cached: true });
      }
      try {
        const p0 = await hx('https://api.hypixel.net/v2/skyblock/auctions?page=0');
        return json({ lastUpdated: p0.lastUpdated });
      } catch (e) { return json({ error: e.message }, 500); }
    }

    if (url.pathname === '/auctions' || url.pathname === '/') {
      return serveAuctions(env, ctx);
    }

    // Batch prices: GET /prices?tags=SB_TAG:TIER,SB_TAG2:TIER2,...
    if (url.pathname === '/prices') {
      const raw   = (url.searchParams.get('tags') || '').split(',').filter(Boolean);
      const items = raw.map(r => { const i = r.lastIndexOf(':'); return i > 0 ? { tag: r.slice(0,i), rarity: r.slice(i+1) } : { tag: r, rarity: '' }; });
      return serveBatchPrices(items.slice(0, 80), env, ctx);
    }

    return new Response('Not found', { status: 404, headers: cors() });
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(refreshBIN(env));
  },
};

// ── Serve auctions from KV ────────────────────────────────────────────────────

async function serveAuctions(env, ctx) {
  if (env.FLIPPER_CACHE) {
    const cached = await env.FLIPPER_CACHE.get(BIN_KEY, { type: 'json' });
    if (cached) return json({ ...cached, cached: true });
  }
  // Cold start (first deploy / KV miss)
  const data = await fetchAllBIN();
  if (env.FLIPPER_CACHE)
    ctx.waitUntil(env.FLIPPER_CACHE.put(BIN_KEY, JSON.stringify(data), { expirationTtl: KV_TTL }));
  return json(data);
}

async function refreshBIN(env) {
  try {
    const data = await fetchAllBIN();
    const str  = JSON.stringify(data);
    await env.FLIPPER_CACHE.put(BIN_KEY, str, { expirationTtl: KV_TTL });
    console.log(`BIN refreshed: ${data.totalBIN} auctions, ${(str.length/1024).toFixed(0)}KB`);
  } catch (e) { console.error('BIN refresh:', e.message); }
}

async function fetchAllBIN() {
  const t0 = Date.now();
  const p0 = await hx('https://api.hypixel.net/v2/skyblock/auctions?page=0');
  if (!p0.success) throw new Error('Hypixel fail');

  let bins = p0.auctions.filter(a => a.bin).map(slim);
  const pages = Array.from({ length: p0.totalPages - 1 }, (_, i) => i + 1);

  for (let i = 0; i < pages.length; i += 30) {
    const batch   = pages.slice(i, i + 30);
    const results = await Promise.allSettled(
      batch.map(p => hx(`https://api.hypixel.net/v2/skyblock/auctions?page=${p}`))
    );
    for (const r of results)
      if (r.status === 'fulfilled' && r.value.success)
        bins = bins.concat(r.value.auctions.filter(a => a.bin).map(slim));
  }

  return { success:true, ts:Date.now(), lastUpdated:p0.lastUpdated, totalBIN:bins.length, fetchMs:Date.now()-t0, auctions:bins };
}

function slim(a) {
  const sbTag = deriveSbTag(a.item_name);
  const mcItem = deriveMcItem(a.item_name, a.extra);
  return {
    u: a.uuid,
    e: a.end,
    n: a.item_name,
    x: a.extra,
    c: a.category,
    t: a.tier,
    b: a.starting_bid,
    s: sbTag,   // SkyBlock item tag e.g. "AURORA_CHESTPLATE"
    m: mcItem,  // Minecraft item name e.g. "Leather Chestplate"
  };
}

// SB tag = item name, strip special chars, uppercase, spaces→underscores
// "[Lvl 1] Guardian" → "GUARDIAN" (strip level prefix)
function deriveSbTag(name) {
  if (!name) return 'UNKNOWN';
  let clean = name
    .replace(/\[Lvl \d+\]\s*/gi, '')   // strip [Lvl N] prefix from pets
    .replace(/[✪★☆✦]/g, '')            // strip stars
    .replace(/§[0-9a-fklmnor]/gi, '')   // strip colour codes
    .trim();
  return clean.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

// Extract the vanilla MC item name from the extra field
// extra = "<SB item name> <MC item name> [enchants...]"
// e.g. "Aurora Chestplate ✪✪✪✪✪ Leather Chestplate Thorns..." → "Leather Chestplate"
function deriveMcItem(name, extra) {
  if (!extra) return null;
  // Strip special chars from both for comparison
  const cleanName  = (name  || '').replace(/[✪★☆✦§\[\]]/g, '').replace(/Lvl \d+/gi,'').trim();
  const cleanExtra = (extra || '').replace(/[✪★☆✦§]/g, '').trim();

  // Remove the item name from the start of extra
  let remainder = cleanExtra;
  if (remainder.toLowerCase().startsWith(cleanName.toLowerCase())) {
    remainder = remainder.slice(cleanName.length).trim();
  }

  // Find first known MC item in remainder
  for (const mc of MC_ITEMS) {
    if (remainder.toLowerCase().startsWith(mc.toLowerCase())) {
      return mc;
    }
  }

  // Fallback: first 1-2 words of remainder if they look like an item name (Title Case)
  const words = remainder.split(' ').filter(w => w && /^[A-Z]/.test(w));
  if (words.length >= 2) return words[0] + ' ' + words[1];
  if (words.length === 1) return words[0];
  return null;
}

// ── Prices via CoflNet ────────────────────────────────────────────────────────

async function serveBatchPrices(items, env, ctx) {
  const out = {}, toFetch = [];

  for (const { tag, rarity } of items) {
    if (!tag || tag === 'UNKNOWN') continue;
    const ck = `p3:${tag}:${rarity}`;
    if (env.FLIPPER_CACHE) {
      const c = await env.FLIPPER_CACHE.get(ck, { type: 'json' });
      if (c && Date.now() - (c._ts||0) < PRICE_TTL*1000) { out[`${tag}:${rarity}`] = c; continue; }
    }
    toFetch.push({ tag, rarity, ck });
  }

  const fetched = await Promise.allSettled(toFetch.map(async ({ tag, rarity, ck }) => {
    const data = await coflPrice(tag, rarity);
    if (env.FLIPPER_CACHE)
      ctx.waitUntil(env.FLIPPER_CACHE.put(ck, JSON.stringify({...data,_ts:Date.now()}), { expirationTtl: PRICE_TTL }));
    return { key: `${tag}:${rarity}`, data };
  }));

  for (const r of fetched)
    if (r.status === 'fulfilled') out[r.value.key] = r.value.data;

  return json({ success: true, prices: out });
}

async function coflPrice(tag, rarity) {
  let url = `https://sky.coflnet.com/api/item/price/${encodeURIComponent(tag)}`;
  if (rarity) url += `?Rarity=${encodeURIComponent(rarity)}`;
  const r = await fetch(url, { headers: { 'User-Agent':'sb-flipper/1.0', Accept:'application/json' } });
  if (!r.ok) throw new Error(`CoflNet ${r.status} for ${tag}`);
  return r.json();
}

// ── Util ──────────────────────────────────────────────────────────────────────

async function hx(url) {
  const r = await fetch(url, { headers: { 'User-Agent':'sb-flipper/1.0' } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}
function json(d, s=200) {
  return new Response(JSON.stringify(d), { status:s, headers:{'Content-Type':'application/json',...cors()} });
}
function cors() {
  return { 'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'GET,OPTIONS','Access-Control-Allow-Headers':'Content-Type' };
}