const fs = require("../core/flaresolverr");
const { memo } = require("../core/http");
const { variants } = require("../core/meta");

const BASE = "https://gotaku.to";

let slugMap = null;
const titleCache = new Map();
const epCache = new Map();

async function renderPage(url, timeout = 30000) {
  return fs.get(url, timeout);
}

async function crawlTitles(stopCheck) {
  const browseHtml = await renderPage(`${BASE}/browse`);
  if (!browseHtml) return null;

  const slugs = [...new Set([...browseHtml.matchAll(/href="\/title\/([a-z0-9]+)"/g)].map((m) => m[1]))];
  if (!slugs.length) return null;

  const byAnilistId = new Map();
  const byName = new Map();

  for (let i = 0; i < slugs.length; i += 5) {
    const batch = slugs.slice(i, i + 5);
    const results = await Promise.all(
      batch.map(async (slug) => {
        const cached = titleCache.get(slug);
        if (cached && Date.now() - cached.ts < 60 * 60 * 1000) return { slug, ...cached };
        const html = await renderPage(`${BASE}/title/${slug}`);
        if (!html) return { slug, anilistId: null, name: null, ts: Date.now() };
        const simple = /"anilist_id":(\d+)/.exec(html);
        const name = /"name":"([^"]+)"/.exec(html);
        const info = {
          anilistId: simple ? parseInt(simple[1], 10) : null,
          name: name ? name[1] : null,
          ts: Date.now(),
        };
        titleCache.set(slug, info);
        return { slug, ...info };
      })
    );
    for (const r of results) {
      if (r.anilistId && r.name) {
        byAnilistId.set(r.anilistId, r.slug);
        byName.set(r.name.toLowerCase(), r.slug);
      }
    }
    if (stopCheck && stopCheck(byAnilistId, byName)) break;
  }

  if (!byAnilistId.size) return null;
  return { byAnilistId, byName, ts: Date.now() };
}

async function buildSlugMap() {
  if (slugMap && Date.now() - slugMap.ts < 24 * 60 * 60 * 1000) return slugMap;
  const built = await crawlTitles(null);
  if (built) slugMap = built;
  return slugMap;
}

async function findSlug(anilistId, titles) {
  const wanted = new Set([anilistId]);
  const wantedNames = new Set();
  for (const t of titles) wantedNames.add(t.toLowerCase().trim());

  let map = slugMap && Date.now() - slugMap.ts < 24 * 60 * 60 * 1000 ? slugMap : null;
  if (!map) {
    map = await crawlTitles((byId, byName) => {
      for (const id of wanted) if (byId.has(id)) return true;
      for (const name of wantedNames) {
        for (const [n, s] of byName) {
          if (n === name || n.includes(name) || name.includes(n)) return true;
        }
      }
      return false;
    });
    if (map) slugMap = map;
  }
  if (!map) return null;

  if (map.byAnilistId.has(anilistId)) return map.byAnilistId.get(anilistId);

  for (const t of titles) {
    const lower = t.toLowerCase().trim();
    if (map.byName.has(lower)) return map.byName.get(lower);
    for (const [name, s] of map.byName) {
      if (name.includes(lower) || lower.includes(name)) return s;
    }
  }
  return null;
}

async function getEpisodeStream(slug, episodeNum) {
  const key = `${slug}:${episodeNum}`;
  const cached = epCache.get(key);
  if (cached && Date.now() - cached.ts < 5 * 60 * 1000) return cached.m3u8Url;

  const titleHtml = await renderPage(`${BASE}/title/${slug}?ep=${episodeNum}`);
  if (!titleHtml) return null;
  const embedMatch = /src="\/embed\/([A-Za-z0-9_-]+)/.exec(titleHtml);
  if (!embedMatch) return null;

  const embedHtml = await renderPage(`${BASE}/embed/${embedMatch[1]}`);
  if (!embedHtml) return null;
  const source =
    /<source[^>]*src="(https?:\/\/[^"]+)"[^>]*type="application\/x-mpegurl"/.exec(embedHtml) ||
    /<source[^>]*src="(https?:\/\/[^"]+)"/.exec(embedHtml);
  const m3u8Url = source ? source[1] : null;

  epCache.set(key, { m3u8Url, ts: Date.now() });
  if (epCache.size > 200) epCache.delete(epCache.keys().next().value);
  return m3u8Url;
}

async function resolve(anilistId, episode, opts = {}) {
  if (!fs.enabled()) return null;
  const list = [];
  if (opts.title) list.push(opts.title);
  list.push(...(await variants(anilistId)));

  const slug = await findSlug(anilistId, list);
  if (!slug) return null;

  const m3u8Url = await getEpisodeStream(slug, episode);
  if (!m3u8Url) return null;
  return {
    servers: [
      {
        name: "Gotaku Sub",
        type: "sub",
        quality: "1080p",
        url: m3u8Url,
        embed: "",
        referer: `${BASE}/`,
        subtitles: [],
      },
    ],
    intro: null,
    outro: null,
  };
}

async function search(q) {
  if (!fs.enabled()) return [];
  return memo(`gotaku:search:${q}`, 60 * 60 * 1000, async () => {
    const map = await buildSlugMap();
    if (!map) return [];
    const lower = q.toLowerCase().trim();
    const out = [];
    for (const [name, slug] of map.byName) {
      if (name.includes(lower) || lower.includes(name)) {
        out.push({ slug, title: name.replace(/\b\w/g, (c) => c.toUpperCase()) });
      }
    }
    return out;
  });
}

module.exports = { resolve, search, episodes: null, needsTitle: true };
