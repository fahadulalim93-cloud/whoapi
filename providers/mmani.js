const { getText, getJson, memo } = require("../core/http");

const API = "https://eng.animeapps.top/api";
const EPENG = "https://epeng.animeapps.top";
const PLAYER_HOST = "https://play.anien.top";
const HOME = "https://mmani.com";

const HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
  Referer: `${HOME}/`,
  Accept: "application/json, text/plain, */*",
  "Accept-Language": "en-US,en;q=0.9",
};

const UP_REFERER = `${HOME}/up/`;

async function findPostId(anilistId, title) {
  if (!title) return null;
  const data = await getJson(`${API}/search3.php?keyword=${encodeURIComponent(title)}`, HEADERS, 10000, 0).catch(() => null);
  if (!data || data.status !== "success" || !Array.isArray(data.data)) return null;
  for (const item of data.data) {
    if (item.anilist && parseInt(item.anilist, 10) === anilistId) {
      return { postid: item.postid, postname: item.postname, anilist: parseInt(item.anilist, 10) };
    }
  }
  const lower = title.toLowerCase();
  for (const item of data.data) {
    if (item.postname && item.postname.toLowerCase().includes(lower)) {
      return {
        postid: item.postid,
        postname: item.postname,
        anilist: item.anilist ? parseInt(item.anilist, 10) : anilistId,
      };
    }
  }
  return null;
}

async function getEpisodeServers(anilistId) {
  const data = await getJson(`${EPENG}/api2.php?epid=${anilistId}`, { ...HEADERS, Referer: UP_REFERER }, 10000, 0).catch(() => null);
  return Array.isArray(data) ? data : [];
}

function findEpisodeLink(servers, episodeNum) {
  for (const srv of servers) {
    for (const ep of srv.server_data || []) {
      const num = parseInt(String(ep.name || "").trim(), 10);
      if (!isNaN(num) && num === episodeNum) {
        return { link: ep.link, serverName: srv.server_name };
      }
    }
  }
  if (episodeNum === 1) {
    for (const srv of servers) {
      const first = (srv.server_data || [])[0];
      if (first) return { link: first.link, serverName: srv.server_name };
    }
  }
  return null;
}

async function resolveStream(link) {
  const data = await getJson(`${EPENG}/apilink.php?data=${encodeURIComponent(link)}`, { ...HEADERS, Referer: UP_REFERER }, 10000, 0).catch(() => null);
  if (!Array.isArray(data) || !data.length) return null;
  const playerUrl = data[0].link;
  const html = await getText(playerUrl, { ...HEADERS, Referer: UP_REFERER }, 10000).catch(() => null);
  if (!html) return null;
  const m = html.match(/window\.PLAYER_CONFIG\s*=\s*(\{[^<]+?\});/);
  if (!m) return null;
  let config;
  try {
    config = JSON.parse(m[1]);
  } catch {
    return null;
  }
  const videoUrl = config.videoUrl
    ? config.videoUrl.startsWith("/")
      ? `${PLAYER_HOST}${config.videoUrl}`
      : config.videoUrl
    : null;
  if (!videoUrl) return null;
  return {
    streamUrl: videoUrl,
    subtitleUrl: config.tracks && config.tracks[0] && config.tracks[0].file,
    server: data[0].server || "R-HD",
  };
}

async function resolve(anilistId, episode, opts = {}) {
  const { variants } = require("../core/meta");
  const list = [];
  if (opts.title) list.push(opts.title);
  list.push(...(await variants(anilistId)));

  let match = null;
  for (const t of list) {
    match = await memo(`mmani:post:${t}`, 24 * 60 * 60 * 1000, () => findPostId(anilistId, t));
    if (match) break;
  }
  if (!match) return null;

  const servers = await getEpisodeServers(match.anilist);
  if (!servers.length) return null;
  const ep = findEpisodeLink(servers, episode);
  if (!ep) return null;
  const stream = await resolveStream(ep.link);
  if (!stream) return null;

  return {
    servers: [
      {
        name: `MMani Sub`,
        type: "sub",
        quality: "BD",
        url: stream.streamUrl,
        embed: "",
        referer: UP_REFERER,
        subtitles: stream.subtitleUrl
          ? [{ url: stream.subtitleUrl, lang: "en", label: "English" }]
          : [],
      },
    ],
    intro: null,
    outro: null,
  };
}

async function search(q) {
  return memo(`mmani:search:${q}`, 60 * 60 * 1000, async () => {
    const data = await getJson(`${API}/search3.php?keyword=${encodeURIComponent(q)}`, HEADERS, 10000, 0).catch(() => null);
    if (!data || data.status !== "success" || !Array.isArray(data.data)) return [];
    return data.data.map((a) => ({
      id: a.postid,
      anilistId: a.anilist ? parseInt(a.anilist, 10) : null,
      title: a.postname,
      year: a.postyear || "",
      cover: a.ani_cover_large || "",
    }));
  });
}

async function episodes(anilistId) {
  return memo(`mmani:eps:${anilistId}`, 60 * 60 * 1000, async () => {
    const { variants } = require("../core/meta");
    let match = null;
    for (const t of await variants(anilistId)) {
      match = await findPostId(anilistId, t);
      if (match) break;
    }
    if (!match) return [];
    const servers = await getEpisodeServers(match.anilist);
    const nums = new Set();
    for (const srv of servers) {
      for (const ep of srv.server_data || []) {
        const num = parseInt(String(ep.name || "").trim(), 10);
        if (!isNaN(num)) nums.add(num);
      }
    }
    return [...nums].sort((a, b) => a - b).map((n) => ({ number: n, hasSub: true, hasDub: false }));
  });
}

module.exports = { resolve, search, episodes };
