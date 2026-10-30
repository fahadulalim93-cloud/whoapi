const { getText, getJson, postText, memo } = require("../core/http");

const API = "https://api.animeparadise.moe";
const SITE = "https://www.animeparadise.moe";
const ACTION_ID = "60edb8d72ddf7f3fdfbfc1303642e4829b0825ddef";

const HEADERS = {
  Accept: "application/json",
  Referer: `${SITE}/`,
  Origin: SITE,
};

function scoreMatch(animeTitle, searchTitle) {
  const a = (animeTitle || "").toLowerCase().trim();
  const s = (searchTitle || "").toLowerCase().trim();
  if (!a || !s) return 0;
  if (a === s) return 100;
  const ac = a.replace(/[^\w\s]/g, " ").replace(/\s+/g, " ").trim();
  const sc = s.replace(/[^\w\s]/g, " ").replace(/\s+/g, " ").trim();
  if (ac === sc) return 95;
  if (ac.includes(sc)) return 70;
  if (sc.includes(ac)) return 60;
  const aw = ac.split(" ").filter((w) => w.length > 2);
  const sw = sc.split(" ").filter((w) => w.length > 2);
  let overlap = 0;
  for (const w of sw) {
    if (aw.some((x) => x === w || x.includes(w) || w.includes(x))) overlap++;
  }
  return overlap * 15;
}

async function findAnime(title) {
  return memo(`paradise:find:${title}`, 24 * 60 * 60 * 1000, async () => {
    const data = await getJson(`${API}/search?q=${encodeURIComponent(title)}&v=1`, HEADERS, 5000).catch(() => null);
    if (!data || !data.success || !Array.isArray(data.data)) return null;
    let best = null;
    let bestScore = 0;
    for (const item of data.data) {
      const s = scoreMatch(String(item.title || ""), title);
      if (s > bestScore) {
        bestScore = s;
        best = item;
      }
    }
    if (!best || bestScore < 50) return null;
    return { id: best._id, slug: best.link, title: String(best.title || "") };
  });
}

async function episodeList(animeId) {
  return memo(`paradise:eps:${animeId}`, 24 * 60 * 60 * 1000, async () => {
    const data = await getJson(`${API}/anime/${animeId}/episode?v=1`, HEADERS, 5000).catch(() => null);
    if (!data || !data.success || !Array.isArray(data.data)) return [];
    return data.data.map((e) => ({
      uid: String(e.uid || ""),
      number: String(e.number || ""),
      title: String(e.title || ""),
      origin: String(e.origin || animeId),
    }));
  });
}

async function streamLink(uid, origin) {
  return memo(`paradise:link:${uid}:${origin}`, 5 * 60 * 1000, async () => {
    const text = await postText(
      `${SITE}/watch/${uid}?origin=${origin}`,
      JSON.stringify([uid, origin]),
      {
        ...HEADERS,
        "Content-Type": "text/plain;charset=UTF-8",
        Accept: "text/x-component",
        "Next-Action": ACTION_ID,
      },
      10000
    );
    const m = text.match(/"streamLink":"([^"]+)"/);
    return m ? m[1] : null;
  });
}

async function resolve(anilistId, episode, opts = {}) {
  const title = opts.title;
  if (!title) return null;
  const anime = await findAnime(title);
  if (!anime) return null;
  const eps = await episodeList(anime.id);
  if (!eps.length) return null;
  const ep = eps.find((e) => parseInt(e.number, 10) === episode);
  if (!ep) return null;
  const link = await streamLink(ep.uid, ep.origin || anime.id);
  if (!link) return null;
  return {
    servers: [
      {
        name: "AnimeParadise Sub",
        type: "sub",
        quality: "1080p",
        url: `https://stream.animeparadise.moe/m3u8?url=${link}`,
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
  const data = await getJson(`${API}/search?q=${encodeURIComponent(q)}&v=1`, HEADERS, 5000).catch(() => null);
  if (!data || !data.success || !Array.isArray(data.data)) return [];
  return data.data.map((a) => ({ id: a._id, title: a.title, slug: a.link, episodes: a.episodes }));
}

module.exports = { resolve, search, episodes: null, needsTitle: true };
