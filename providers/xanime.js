const fs = require("../core/flaresolverr");
const { getText, memo } = require("../core/http");
const { variants } = require("../core/meta");

const BASE = "https://xanime.me";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const searchCache = new Map();
const epListCache = new Map();

const BAD_WORDS = [
  "film", "episode-of", "special", "ova", "movie", "recap", "fan-letter",
  "in-love", "spin-off", "jump-festa", "boruto", "road-to", "the-last",
  " glorious", "chronicle", "junior-high", "lost-girls", "final-season", "final-chapters",
];

async function searchXanime(title) {
  const key = title.toLowerCase().trim();
  const cached = searchCache.get(key);
  if (cached && Date.now() - cached.ts < 60 * 60 * 1000) return cached;

  const html = await getText(`${BASE}/search?word=${encodeURIComponent(title)}`, {
    "User-Agent": UA,
    Accept: "text/html",
  }, 15000).catch(() => null);
  if (!html) return null;

  const seen = new Set();
  const results = [];
  for (const m of html.matchAll(/href="\/title\/(\d+)-([^"\/]+)"/g)) {
    const k = `${m[1]}-${m[2]}`;
    if (!seen.has(k)) {
      seen.add(k);
      results.push({ id: m[1], slug: m[2] });
    }
  }
  if (!results.length) return null;

  const titleSlug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/--+/g, "-");

  let best = null;
  let bestScore = -1;
  for (const r of results) {
    const slug = r.slug.toLowerCase();
    let score = 0;
    if (slug === titleSlug) score = 100;
    else if (slug.startsWith(titleSlug + "-")) score = 30;
    else if (titleSlug.startsWith(slug + "-")) score = 20;
    else if (slug.includes(titleSlug)) score = 10;
    else if (titleSlug && slug.startsWith(titleSlug.split("-")[0] + "-")) score = 5;
    if (BAD_WORDS.some((w) => slug.includes(w))) score -= 50;
    if (score > bestScore) {
      bestScore = score;
      best = r;
    }
  }

  const entry = best && bestScore >= 30 ? { ...best, ts: Date.now() } : null;
  if (entry) {
    searchCache.set(key, entry);
    if (searchCache.size > 200) searchCache.delete(searchCache.keys().next().value);
  }
  return entry;
}

async function getEpisodeList(animeId, slug) {
  const cached = epListCache.get(animeId);
  if (cached && Date.now() - cached.ts < 60 * 60 * 1000) return cached;

  let latestEpId = null;
  let latestEpIndex = 0;
  const episodes = new Map();

  const html = await getText(`${BASE}/title/${animeId}-${slug}`, {
    "User-Agent": UA,
    Accept: "text/html",
  }, 15000).catch(() => null);

  if (html) {
    const escaped = slug.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const linkMatch = new RegExp(`href="/title/${animeId}-${escaped}/(\\d+)"`).exec(html);
    if (linkMatch) latestEpId = linkMatch[1];

    const stateMatch = /(\d{1,5}),\"(\d{6,9})\"/.exec(html);
    if (stateMatch) {
      latestEpIndex = parseInt(stateMatch[1], 10);
      if (!latestEpId) latestEpId = stateMatch[2];
    }
    if (!latestEpIndex) {
      const epNumMatch = /episode-(\d+)/i.exec(html);
      if (epNumMatch) latestEpIndex = parseInt(epNumMatch[1], 10);
    }

    for (const m of html.matchAll(/"Episode\s+(\d+)","\/title\/[^"]*?\/(\d+)-episode-\1"/g)) {
      episodes.set(parseInt(m[1], 10), m[2]);
    }
    for (const m of html.matchAll(new RegExp(`"\\/title\\/${animeId}\\/(\\d+)-episode-(\\d+)"`, "g"))) {
      episodes.set(parseInt(m[2], 10), m[1]);
    }
    if (latestEpId && latestEpIndex > 0) episodes.set(latestEpIndex, latestEpId);
    else if (latestEpId) {
      const countMatch = /episodeCount[":\s]+(\d+)/.exec(html);
      if (countMatch) {
        latestEpIndex = parseInt(countMatch[1], 10);
        episodes.set(latestEpIndex, latestEpId);
      }
    }
  }

  if (episodes.size < 2 && fs.enabled()) {
    const fsHtml = await fs.get(`${BASE}/title/${animeId}-${slug}`, 45000);
    if (fsHtml) {
      for (const m of fsHtml.matchAll(new RegExp(`/title/${animeId}/(\\d+)-episode-(\\d+)`, "g"))) {
        const num = parseInt(m[2], 10);
        if (num && !episodes.has(num)) episodes.set(num, m[1]);
      }
      for (const m of fsHtml.matchAll(new RegExp(`"(\\d+)-episode-(\\d+)"`, "g"))) {
        const num = parseInt(m[2], 10);
        if (num && !episodes.has(num)) episodes.set(num, m[1]);
      }
    }
  }

  if (!episodes.size && !latestEpId) return null;

  const result = { episodes, latestEpId, latestEpIndex, ts: Date.now() };
  epListCache.set(animeId, result);
  if (epListCache.size > 100) epListCache.delete(epListCache.keys().next().value);
  return result;
}

async function getM3u8(animeId, slug, episodeId) {
  const urls = [`${BASE}/title/${animeId}-${slug}/${episodeId}`, `${BASE}/title/${animeId}/${episodeId}`];
  for (const url of urls) {
    const html = await getText(url, { "User-Agent": UA, Accept: "text/html" }, 15000).catch(() => null);
    if (!html) continue;
    const m = html.match(/https?:\/\/xanivsrc\d+\.org\/[^"'\s]+\.m3u8[^"'\s]*/);
    if (m) return m[0];
  }
  return null;
}

async function resolve(anilistId, episode, opts = {}) {
  const list = [];
  if (opts.title) list.push(opts.title);
  list.push(...(await variants(anilistId)));

  let found = null;
  for (const t of list) {
    found = await memo(`xanime:find:${t}`, 60 * 60 * 1000, () => searchXanime(t));
    if (found) break;
  }
  if (!found) return null;

  const epList = await getEpisodeList(found.id, found.slug);
  if (!epList) return null;

  let targetEpId = null;
  if (epList.episodes.has(episode)) targetEpId = epList.episodes.get(episode);
  else if (epList.latestEpId && episode === epList.latestEpIndex) targetEpId = epList.latestEpId;
  else if (epList.latestEpId && !epList.episodes.size) return null;
  else if (epList.latestEpId) targetEpId = epList.latestEpId;
  if (!targetEpId) return null;

  const m3u8Url = await getM3u8(found.id, found.slug, targetEpId);
  if (!m3u8Url) return null;

  return {
    servers: [
      {
        name: "Xanime Sub",
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
  const found = await searchXanime(q);
  if (!found) return [];
  return [
    {
      id: found.id,
      slug: found.slug,
      title: found.slug.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
      url: `${BASE}/title/${found.id}-${found.slug}`,
    },
  ];
}

module.exports = { resolve, search, episodes: null, needsTitle: true };
