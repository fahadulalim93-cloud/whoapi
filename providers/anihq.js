const fs = require("../core/flaresolverr");
const { getText, getJson, memo } = require("../core/http");
const { variants } = require("../core/meta");

const BASE = "https://anihq.cc";
const UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const voeCache = new Map();

function rot13(s) {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    let o = c;
    if (c >= 65 && c <= 90) o = ((c - 65 + 13) % 26) + 65;
    else if (c >= 97 && c <= 122) o = ((c - 97 + 13) % 26) + 97;
    out += String.fromCharCode(o);
  }
  return out;
}

function unpackVoe(encoded) {
  try {
    let s = rot13(encoded);
    for (const sep of ["@$", "^^", "~@", "%?", "*~", "!!", "#&"]) s = s.split(sep).join("");
    s = s.split("_").join("");
    s = Buffer.from(s + "=".repeat((4 - (s.length % 4)) % 4), "base64").toString("binary");
    s = s
      .split("")
      .map((c) => String.fromCharCode(c.charCodeAt(0) - 3))
      .join("");
    s = s.split("").reverse().join("");
    s = Buffer.from(s + "=".repeat((4 - (s.length % 4)) % 4), "base64").toString("utf-8");
    return JSON.parse(s);
  } catch {
    return null;
  }
}

async function voePage(url) {
  const cached = voeCache.get(url);
  if (cached && Date.now() - cached.ts < 3 * 60 * 60 * 1000) return cached.html;
  const html = await fs.get(url, 45000);
  if (!html) return null;
  voeCache.set(url, { html, ts: Date.now() });
  if (voeCache.size > 300) voeCache.delete(voeCache.keys().next().value);
  return html;
}

async function searchAnihq(title) {
  const query = title.replace(/[:!?,.'"\-_]/g, " ").replace(/\s+/g, " ").trim();
  if (!query) return [];
  const data = await getJson(
    `${BASE}/wp-json/kiranime/v1/anime/search?query=${encodeURIComponent(query)}`,
    { "User-Agent": UA, Accept: "application/json,text/html,*/*", "Accept-Language": "en-US,en;q=0.9" },
    15000,
    0
  ).catch(() => null);
  let html = "";
  if (data && typeof data.result === "string") html = data.result;
  else if (typeof data === "string") html = data;
  if (!html) return [];

  const out = [];
  const seen = new Set();
  const slugRe = /href="https:\/\/anihq\.cc\/anime-show\/([^"/]+)\/"/g;
  let m;
  while ((m = slugRe.exec(html)) !== null) {
    const slug = m[1];
    if (seen.has(slug)) continue;
    seen.add(slug);
    let decoded = slug;
    try {
      decoded = decodeURIComponent(slug);
    } catch {}
    const subbed = decoded.toLowerCase().endsWith("-english-subbed");
    const dubbed = decoded.toLowerCase().endsWith("-english-dubbed");
    if (!subbed && !dubbed) continue;
    const niceTitle = decoded
      .replace(/-english-(subbed|dubbed)$/i, "")
      .replace(/-/g, " ")
      .replace(/\b\w/g, (c) => c.toUpperCase());
    out.push({ slug, title: niceTitle, isDub: dubbed });
  }
  return out;
}

function scoreMatch(result, anilistTitle) {
  const strip = (s) => s.toLowerCase().replace(/[:!?,.'"\-_]/g, " ").replace(/\s+/g, " ").trim();
  const a = strip(anilistTitle);
  const b = strip(result.title);
  const aTokens = new Set(a.split(" ").filter((t) => t.length > 1));
  const bTokens = new Set(b.split(" ").filter((t) => t.length > 1));
  if (!aTokens.size || !bTokens.size) return 0;
  let common = 0;
  for (const t of aTokens) if (bTokens.has(t)) common++;
  return common / (aTokens.size + bTokens.size - common);
}

async function getAnimeIdBySlug(slug) {
  const data = await getJson(`${BASE}/wp-json/wp/v2/anime?slug=${encodeURIComponent(slug)}`, {
    "User-Agent": UA,
    Accept: "application/json",
  }, 15000, 0).catch(() => null);
  if (!Array.isArray(data) || !data.length) return null;
  return data[0].id || null;
}

async function findEpisode(animeId, episodeNum) {
  for (let page = 1; page <= 50; page++) {
    const data = await getJson(
      `${BASE}/wp-admin/admin-ajax.php?action=get_episodes&anime_id=${animeId}&page=${page}&order=asc`,
      { "User-Agent": UA, Accept: "application/json" },
      15000,
      0
    ).catch(() => null);
    if (!data || !data.success) break;
    const eps = (data.data && data.data.episodes) || [];
    if (!eps.length) break;
    for (const ep of eps) {
      const num = parseFloat(ep.meta_number);
      if (!isNaN(num) && num === episodeNum) return ep;
    }
    const maxPages = (data.data && data.data.max_episodes_page) || 1;
    if (page >= maxPages) break;
  }
  return null;
}

async function extractEmbeds(watchUrl) {
  const html = await getText(watchUrl, { "User-Agent": UA, Accept: "text/html" }, 15000).catch(() => null);
  if (!html) return [];
  const out = [];
  const seen = new Set();
  let m;
  const re = /data-embed-id="([^"]+)"[^>]*>([^<]*)</g;
  while ((m = re.exec(html)) !== null) {
    const parts = m[1].split(":");
    if (parts.length < 2) continue;
    try {
      const decoded = Buffer.from(parts[parts.length - 1], "base64").toString("utf-8");
      if (decoded.startsWith("http") && !seen.has(decoded)) {
        seen.add(decoded);
        out.push({ label: (m[2] || "").trim(), url: decoded });
      }
    } catch {}
  }
  if (!out.length) {
    const simple = /data-embed-id="([^"]+)"/g;
    while ((m = simple.exec(html)) !== null) {
      const parts = m[1].split(":");
      if (parts.length < 2) continue;
      try {
        const decoded = Buffer.from(parts[parts.length - 1], "base64").toString("utf-8");
        if (decoded.startsWith("http") && !seen.has(decoded)) {
          seen.add(decoded);
          out.push({ label: "", url: decoded });
        }
      } catch {}
    }
  }
  return out;
}

async function resolveVariant(variant, episodeNum) {
  const animeId = await getAnimeIdBySlug(variant.slug);
  if (!animeId) return null;
  const episode = await findEpisode(animeId, episodeNum);
  if (!episode) return null;
  const embeds = await extractEmbeds(episode.url);
  if (!embeds.length) return null;

  const voeHtml = await voePage(embeds[0].url);
  if (!voeHtml) return null;
  const m = voeHtml.match(/<script type="application\/json">\["([^"]+)"\]<\/script>/);
  if (!m) return null;
  const cfg = unpackVoe(m[1]);
  if (!cfg || !cfg.source || !cfg.source.includes(".m3u8")) return null;

  const subtitles = (cfg.captions || []).map((c) => ({
    url: c.file,
    lang: (c.language || "en").substring(0, 2).toLowerCase(),
    label: c.label || c.language || "English",
  }));

  return {
    type: variant.isDub ? "dub" : "sub",
    name: `AniHQ ${variant.isDub ? "Dub" : "Sub"}`,
    quality: "1080p",
    url: cfg.source,
    embed: embeds[0].url,
    referer: "",
    subtitles,
  };
}

async function resolve(anilistId, episode, opts = {}) {
  if (!fs.enabled()) return null;
  const list = [];
  if (opts.title) list.push(opts.title);
  list.push(...(await variants(anilistId)));

  let results = [];
  let usedTitle = list[0] || "";
  for (const t of list) {
    const found = await memo(`anihq:search:${t}`, 60 * 60 * 1000, () => searchAnihq(t));
    if (found.length) {
      results = found;
      usedTitle = t;
      break;
    }
  }
  if (!results.length) return null;

  const merged = results
    .map((r) => ({ r, score: scoreMatch(r, usedTitle) }))
    .filter((x) => x.score > 0.3)
    .sort((a, b) => b.score - a.score);
  if (!merged.length) return null;

  const subbed = merged.find((x) => !x.r.isDub);
  const dubbed = merged.find((x) => x.r.isDub);
  const tries = [];
  if (subbed) tries.push(subbed.r);
  if (dubbed && (!subbed || dubbed.r.slug !== subbed.r.slug)) tries.push(dubbed.r);

  const servers = [];
  for (const variant of tries) {
    try {
      const server = await resolveVariant(variant, episode);
      if (server) servers.push(server);
    } catch {}
  }
  if (!servers.length) return null;
  return { servers, intro: null, outro: null };
}

async function search(q) {
  const results = await searchAnihq(q);
  return results.map((r) => ({
    slug: r.slug,
    title: r.title,
    type: r.isDub ? "dub" : "sub",
    url: `${BASE}/anime-show/${r.slug}/`,
  }));
}

module.exports = { resolve, search, episodes: null, needsTitle: true };
