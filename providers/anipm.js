const { getJson } = require("../core/http");

const PROXY = process.env.ANIPM_PROXY_URL || "http://127.0.0.1:8095";

async function resolve(anilistId, episode, opts = {}) {
  const title = opts.title;
  if (!title) return null;
  const url = `${PROXY}/api/anipm-proxy/resolve?anilist_id=${anilistId}&episode=${episode}&title=${encodeURIComponent(title)}`;
  const data = await getJson(url, { Accept: "application/json" }, 20000, 0).catch(() => null);
  if (!data || !Array.isArray(data.servers) || !data.servers.length) return null;
  return {
    servers: data.servers.map((s) => ({
      name: s.name,
      type: s.type,
      quality: s.quality || "1080p",
      url: s.manifestUrl,
      embed: "",
      referer: "https://embed.settlar.io/",
      subtitles: s.subtitleTracks || [],
      intro: s.intro || null,
      outro: s.outro || null,
    })),
    intro: null,
    outro: null,
  };
}

module.exports = { resolve, search: null, episodes: null, needsTitle: true, needsSidecar: true };
