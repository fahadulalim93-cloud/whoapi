const { getText, getJson, memo } = require("../core/http");

const BASE = "https://aniwaves.ru";

const HEADERS = {
  "X-Requested-With": "XMLHttpRequest",
  Referer: `${BASE}/`,
};

const SERVER_NAMES = {
  1: "BYFMS",
  2: "DGHG",
  4: "Vidplay",
  12: "MyCloud",
  14: "DatSaV",
};

async function searchAniWaves(keyword) {
  const data = await getJson(`${BASE}/ajax/anime/search?keyword=${encodeURIComponent(keyword)}`, HEADERS).catch(() => null);
  let html = "";
  if (data) {
    if (typeof data.result === "string") html = data.result;
    else if (data.result && typeof data.result.html === "string") html = data.result.html;
    else if (typeof data === "string") html = data;
  }
  const out = [];
  const re = /href="\/watch\/([a-z0-9-]+)-(\d+)"/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const slug = m[1];
    const id = parseInt(m[2], 10);
    const tm = new RegExp(`href="/watch/${slug}-${id}"[^>]*>([^<]+)`).exec(html);
    out.push({
      id,
      slug,
      title: tm ? tm[1].trim() : slug.replace(/-/g, " "),
      url: `${BASE}/watch/${slug}-${id}`,
    });
  }
  return out;
}

async function getServerList(id, episode) {
  const data = await getJson(
    `${BASE}/ajax/server/list?servers=${id}&eps=${episode}`,
    { ...HEADERS, Referer: `${BASE}/watch/${id}/ep-${episode}` }
  ).catch(() => null);
  let html = "";
  if (data) {
    if (typeof data.result === "string") html = data.result;
    else if (data.result && typeof data.result.html === "string") html = data.result.html;
  }
  const servers = [];
  const sections = html.split(/data-type="(sub|dub|softsub)"/);
  let currentType = "sub";
  for (const section of sections) {
    if (section === "sub" || section === "softsub") currentType = "sub";
    else if (section === "dub") currentType = "dub";
    else if (section.trim().length > 0) {
      const re = /data-sv-id="(\d+)"[^>]*data-link-id="([^"]+)"/g;
      let m;
      while ((m = re.exec(section)) !== null) {
        const svId = parseInt(m[1], 10);
        servers.push({
          serverId: svId,
          serverName: SERVER_NAMES[svId] || `Server ${svId}`,
          type: currentType,
          linkId: m[2],
        });
      }
    }
  }
  return servers;
}

async function getSourceUrl(linkId, id, episode) {
  const data = await getJson(
    `${BASE}/ajax/sources?id=${linkId}&asi=&autoPlay=0`,
    { ...HEADERS, Referer: `${BASE}/watch/${id}/ep-${episode}` }
  ).catch(() => null);
  const result = data && data.result;
  if (result && typeof result === "object" && result.url) return result.url;
  if (typeof result === "string") {
    const m = result.match(/(https?:\/\/[^\s"]+)/);
    if (m) return m[1];
  }
  return null;
}

async function extractEchovideo(embedUrl) {
  const m = embedUrl.match(/^https:\/\/play\.echovideo\.ru\/(embed-\d+)\/([^?]+)/);
  if (!m) return null;
  const data = await getJson(
    `https://play.echovideo.ru/${m[1]}/getSources?id=${m[2]}`,
    { Referer: embedUrl }
  ).catch(() => null);
  if (!data) return null;
  let m3u8 = "";
  if (typeof data.sources === "string") m3u8 = data.sources;
  else if (Array.isArray(data.sources)) {
    const first = data.sources.find((s) => s && s.file);
    if (first) m3u8 = first.file;
  }
  if (!m3u8) return null;
  const tracks = Array.isArray(data.tracks)
    ? data.tracks
        .filter((t) => t && t.file && (t.kind === "captions" || t.kind === "subtitles"))
        .map((t) => ({ file: t.file, label: t.label || "Unknown" }))
    : [];
  return { m3u8, tracks, hardsub: tracks.length === 0 };
}

async function resolve(anilistId, episode, opts = {}) {
  const title = opts.title;
  if (!title) return null;

  const found = await memo(`aniwaves:find:${title}`, 10 * 60 * 1000, async () => {
    const results = await searchAniWaves(title);
    return results[0] || null;
  });
  if (!found) return null;

  const servers = await getServerList(found.id, episode);
  if (!servers.length) return null;

  const sources = await Promise.all(
    servers.map(async (server) => {
      const embedUrl = await getSourceUrl(server.linkId, found.id, episode);
      if (!embedUrl || !embedUrl.includes("play.echovideo.ru/embed-")) return null;
      const ex = await extractEchovideo(embedUrl);
      if (!ex || !ex.m3u8) return null;
      const name =
        server.type === "dub" ? "AniWaves Dub" : ex.hardsub ? "AniWaves Sub Hardsub" : "AniWaves Sub Softsub";
      return {
        name,
        type: server.type,
        quality: ex.hardsub ? "720p" : "1080p",
        url: ex.m3u8,
        embed: embedUrl,
        referer: embedUrl,
        subtitles: ex.tracks.map((t) => ({
          url: t.file,
          lang: (t.label || "en").toLowerCase().substring(0, 2),
          label: t.label || "English",
        })),
      };
    })
  );

  const seen = new Set();
  const deduped = sources.filter((s) => (s && !seen.has(s.name) ? (seen.add(s.name), true) : false));
  if (!deduped.length) return null;
  return { servers: deduped, intro: null, outro: null };
}

async function search(q) {
  return memo(`aniwaves:search:${q}`, 10 * 60 * 1000, () => searchAniWaves(q));
}

module.exports = { resolve, search, episodes: null, needsTitle: true };
