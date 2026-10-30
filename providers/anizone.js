const fs = require("../core/flaresolverr");
const { memo } = require("../core/http");
const { variants } = require("../core/meta");

const BASE = "https://anizone.to";

const searchCache = new Map();
const epCache = new Map();

function scoreTitleMatch(animeTitle, searchTitle) {
  const a = animeTitle.toLowerCase().trim();
  const s = searchTitle.toLowerCase().trim();
  if (!a || !s) return 0;
  if (a === s) return 100;
  const aClean = a.replace(/[^\w\s]/g, " ").replace(/\s+/g, " ").trim();
  const sClean = s.replace(/[^\w\s]/g, " ").replace(/\s+/g, " ").trim();
  if (aClean === sClean) return 95;
  if (aClean.includes(sClean)) return 70;
  if (sClean.includes(aClean)) return 60;
  const aWords = aClean.split(" ").filter((w) => w.length > 2);
  const sWords = sClean.split(" ").filter((w) => w.length > 2);
  let overlap = 0;
  for (const sw of sWords) {
    if (aWords.some((aw) => sw === aw || sw.includes(aw) || aw.includes(sw))) overlap++;
  }
  return overlap * 15;
}

function decodeEntities(s) {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&#039;/g, "'")
    .replace(/&apos;/g, "'")
    .trim();
}

async function searchAnizone(title) {
  const key = title.toLowerCase().trim();
  const cached = searchCache.get(key);
  if (cached) {
    const ttl = cached.slug === null ? 30 * 60 * 1000 : 60 * 60 * 1000;
    if (Date.now() - cached.ts < ttl) return cached;
  }

  const html = await fs.get(`${BASE}/anime?search=${encodeURIComponent(title).replace(/%20/g, "+")}`);
  if (!html) return null;

  const found = [];
  const seen = new Set();
  const aTagRe = /<a[^>]*href="https?:\/\/(?:www\.)?anizone\.to\/anime\/([a-z0-9]+)"[^>]*\stitle="([^"]+)"/g;
  let m;
  while ((m = aTagRe.exec(html)) !== null) {
    if (seen.has(m[1])) continue;
    seen.add(m[1]);
    const t = decodeEntities(m[2]);
    if (t.length > 2 && !t.includes("getTitle") && !t.includes("build")) found.push({ slug: m[1], title: t });
  }
  if (!found.length) {
    const fallbackRe = /<a[^>]*href="https?:\/\/(?:www\.)?anizone\.to\/anime\/([a-z0-9]+)"[^>]*>([\s\S]*?)<\/a>/g;
    while ((m = fallbackRe.exec(html)) !== null) {
      if (seen.has(m[1])) continue;
      seen.add(m[1]);
      const textMatch = m[2].match(/>\s*([^<]{2,80})\s*</);
      if (textMatch) {
        const t = textMatch[1].trim();
        if (t.length > 2 && !t.includes("getTitle") && !t.includes("build")) found.push({ slug: m[1], title: t });
      }
    }
  }

  let best = null;
  let bestScore = 0;
  for (const f of found) {
    const score = scoreTitleMatch(f.title, title);
    if (score > bestScore) {
      bestScore = score;
      best = f;
    }
  }

  const entry =
    best && bestScore >= 50 ? { slug: best.slug, title: best.title, ts: Date.now() } : { slug: null, title: "", ts: Date.now() };
  searchCache.set(key, entry);
  if (searchCache.size > 200) searchCache.delete(searchCache.keys().next().value);
  return entry;
}

async function getEpisodeStream(slug, episodeNum) {
  const key = `${slug}:${episodeNum}`;
  const cached = epCache.get(key);
  if (cached && Date.now() - cached.ts < 5 * 60 * 1000) return cached;

  const html = await fs.get(`${BASE}/anime/${slug}/${episodeNum}`);
  if (!html) return null;

  const m3u8Match = html.match(/https?:[\\\/]+[a-z0-9.-]+\.[a-z]+[\\\/]+[a-f0-9-]+[\\\/]+master\.m3u8/);
  if (!m3u8Match) return null;
  const m3u8Url = m3u8Match[0].replace(/\\+\//g, "/");

  const chaptersMatch = html.match(/https?:[\\\/]+[a-z0-9.-]+\.[a-z]+[\\\/]+[a-f0-9-]+[\\\/]+chapters\.vtt/);
  const result = { m3u8Url, chaptersUrl: chaptersMatch ? chaptersMatch[0].replace(/\\+\//g, "/") : null, ts: Date.now() };
  epCache.set(key, result);
  if (epCache.size > 100) epCache.delete(epCache.keys().next().value);
  return result;
}

async function resolve(anilistId, episode, opts = {}) {
  if (!fs.enabled()) return null;
  const list = [];
  if (opts.title) list.push(opts.title);
  list.push(...(await variants(anilistId)));

  for (const t of list) {
    const entry = await searchAnizone(t);
    if (!entry || !entry.slug) continue;
    const stream = await getEpisodeStream(entry.slug, episode);
    if (stream) {
      return {
        servers: [
          {
            name: "AniZone Sub",
            type: "sub",
            quality: "1080p",
            url: stream.m3u8Url,
            embed: "",
            referer: `${BASE}/`,
            subtitles: [],
          },
        ],
        intro: null,
        outro: null,
      };
    }
  }
  return null;
}

async function search(q) {
  if (!fs.enabled()) return [];
  return memo(`anizone:search:${q}`, 60 * 60 * 1000, async () => {
    const html = await fs.get(`${BASE}/anime?search=${encodeURIComponent(q).replace(/%20/g, "+")}`);
    if (!html) return [];
    const out = [];
    const seen = new Set();
    const aTagRe = /<a[^>]*href="https?:\/\/(?:www\.)?anizone\.to\/anime\/([a-z0-9]+)"[^>]*\stitle="([^"]+)"/g;
    let m;
    while ((m = aTagRe.exec(html)) !== null) {
      if (seen.has(m[1])) continue;
      seen.add(m[1]);
      const t = decodeEntities(m[2]);
      if (t.length > 2 && !t.includes("getTitle") && !t.includes("build")) {
        out.push({ slug: m[1], title: t, url: `${BASE}/anime/${m[1]}` });
      }
    }
    return out;
  });
}

module.exports = { resolve, search, episodes: null, needsTitle: true };
