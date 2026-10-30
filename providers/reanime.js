const { getJson, memo } = require("../core/http");

const BASE = "https://reanime.to";
const HEADERS = {
  Accept: "application/json, text/plain, */*",
  Referer: `${BASE}/`,
};

async function resolve(anilistId, episode) {
  const data = await memo(`reanime:flix:${anilistId}:${episode}`, 5 * 60 * 1000, () =>
    getJson(`${BASE}/api/flix/${anilistId}/${episode}`, HEADERS, 15000, 1).catch(() => null)
  );
  const list = (data && data.servers) || [];
  const servers = [];
  const seen = new Set();
  for (const s of list) {
    if (!s.dataLink || seen.has(s.dataLink)) continue;
    seen.add(s.dataLink);
    const dub = /dub/i.test(s.serverName || "") || /dub/i.test(s.dataType || "");
    servers.push({
      name: s.serverName || (dub ? "Reanime Dub" : "Reanime Sub"),
      type: dub ? "dub" : "sub",
      quality: "1080p",
      url: null,
      embed: s.dataLink,
      referer: "https://flixcloud.cc/",
      subtitles: [],
      intro: null,
      outro: null,
    });
  }
  if (!servers.length) return null;
  return { servers, intro: null, outro: null };
}

async function search(q) {
  return memo(`reanime:search:${q}`, 60 * 60 * 1000, async () => {
    const data = await getJson(`${BASE}/api/v1/search?q=${encodeURIComponent(q)}&limit=10`, HEADERS, 10000, 0).catch(() => null);
    const results = (data && data.results) || [];
    return results.map((r) => ({
      id: r.anime_id,
      anilistId: r.anilist_id || null,
      title: (r.title && (r.title.english || r.title.romaji || r.title.native)) || r.anime_id,
      type: r.type || "",
    }));
  });
}

module.exports = { resolve, search, episodes: null, needsTitle: false };
