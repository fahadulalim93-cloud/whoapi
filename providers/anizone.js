const { getText, memo } = require("../core/http");
const fs = require("../core/flaresolverr");
const { variants } = require("../core/meta");

const BASE = "https://anizone.to";

const HEADERS = {
  "Accept-Language": "en-US,en;q=0.9",
};

async function fetchPage(url) {
  const direct = await getText(url, HEADERS, 15000).catch(() => null);
  if (direct) return direct;
  return fs.get(url, 45000);
}

function decodeBlob(raw) {
  const unescaped = JSON.parse(`"${raw}"`);
  return JSON.parse(unescaped);
}

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

function extractAnimes(html) {
  const m = /JSON\.parse\('(\[.*?\])'\)/.exec(html);
  if (!m) return [];
  try {
    return decodeBlob(m[1]);
  } catch {
    return [];
  }
}

async function searchAnizone(title) {
  const url = `${BASE}/anime?search=${encodeURIComponent(title).replace(/%20/g, "+")}`;
  const html = await fetchPage(url);
  if (!html) return [];
  return extractAnimes(html);
}

async function findSlug(title) {
  const items = await searchAnizone(title);
  if (!items.length) return null;
  let best = null;
  let bestScore = 0;
  for (const item of items) {
    const score = scoreTitleMatch(item.main_title || "", title);
    if (score > bestScore) {
      bestScore = score;
      best = item;
    }
  }
  if (!best || bestScore < 50) return null;
  return best.slug;
}

async function getEpisodeStream(slug, episodeNum) {
  const key = `${slug}:${episodeNum}`;
  return memo(`anizone:ep:${key}`, 5 * 60 * 1000, async () => {
    const html = await fetchPage(`${BASE}/anime/${slug}/${episodeNum}`);
    if (!html) return null;
    const m = /vidstackPlayer\(JSON\.parse\('(.*?)'\)\)/.exec(html);
    if (!m) return null;
    let obj;
    try {
      obj = decodeBlob(m[1]);
    } catch {
      return null;
    }
    const m3u8Url = (obj.src || "").replace(/\\+\//g, "/");
    if (!m3u8Url.startsWith("http")) return null;
    const chapters = Object.values(obj).find((v) => typeof v === "string" && v.includes("chapters.vtt"));
    return { m3u8Url, chaptersUrl: chapters ? chapters.replace(/\\+\//g, "/") : null };
  });
}

async function resolve(anilistId, episode, opts = {}) {
  const list = [];
  if (opts.title) list.push(opts.title);
  list.push(...(await variants(anilistId)));

  let slug = null;
  for (const t of list) {
    slug = await memo(`anizone:slug:${t.toLowerCase().trim()}`, 60 * 60 * 1000, () => findSlug(t));
    if (slug) break;
  }
  if (!slug) return null;

  const stream = await getEpisodeStream(slug, episode);
  if (!stream) return null;

  return {
    servers: [
      {
        name: "AniZone Sub",
        type: "sub",
        quality: "1080p",
        url: stream.m3u8Url,
        embed: "",
        referer: "",
        subtitles: [],
      },
    ],
    intro: null,
    outro: null,
  };
}

async function search(q) {
  return memo(`anizone:search:${q}`, 60 * 60 * 1000, async () => {
    const items = await searchAnizone(q);
    return items.map((a) => ({
      slug: a.slug,
      title: a.main_title,
      episodes: a.episode_count || "",
      year: a.start_year || "",
      type: a.type || "",
    }));
  });
}

module.exports = { resolve, search, episodes: null, needsTitle: true };
