const { getJson, postText, memo } = require("../core/http");
const { variants } = require("../core/meta");

const SENSHI = "https://senshi.to";
const VIDCLOUD = "https://s.vidcloud.se";

const HEADERS = {
  Accept: "application/json, */*",
  "Accept-Language": "en-US,en;q=0.9",
  Origin: `${SENSHI}/`,
  Referer: `${SENSHI}/`,
};

function normalize(s) {
  return (s || "").toLowerCase().replace(/[^a-z0-9\s]/g, "").replace(/\s+/g, " ").trim();
}

async function filterPage(term) {
  const text = await postText(`${SENSHI}/anime/filter`, JSON.stringify({ searchTerm: term, page: 1 }), {
    ...HEADERS,
    "Content-Type": "application/json",
  }, 10000).catch(() => null);
  if (!text) return [];
  try {
    const data = JSON.parse(text);
    return (data && data.data) || [];
  } catch {
    return [];
  }
}

async function searchSenshi(title) {
  const seen = new Set();
  const variants = [
    title,
    title.replace(/[-:]\s*[^-:]+$/, "").trim(),
    title.replace(/season\s*\d+/gi, "").trim(),
    title.split(/[-:]/)[0].trim(),
  ].filter((v, i, arr) => v && arr.indexOf(v) === i);

  let all = [];
  const titleNorm = normalize(title);
  for (const v of variants) {
    const results = await filterPage(v);
    if (!results.length) continue;
    all = all.concat(results);
    const exact = results.find((a) => normalize(a.title_english || a.title || "") === titleNorm);
    if (exact) return exact;
  }

  const unique = all.filter((a) => (seen.has(a.id) ? false : (seen.add(a.id), true)));
  if (!unique.length) return null;

  let best = null;
  let bestScore = 0;
  const titleWords = titleNorm.split(" ").filter((w) => w.length > 2);
  for (const a of unique) {
    const aTitle = normalize(a.title_english || a.title || "");
    if (aTitle === titleNorm) return a;
    const aWords = aTitle.split(" ").filter((w) => w.length > 2);
    let score = 0;
    for (const tw of titleWords) {
      if (aWords.some((aw) => aw === tw || aw.includes(tw) || tw.includes(aw))) score++;
    }
    const min = Math.max(1, Math.ceil(titleWords.length * 0.4));
    if (score >= min && score > bestScore) {
      bestScore = score;
      best = a;
    }
  }
  return best;
}

async function getEpisodes(animeId) {
  const data = await getJson(`${SENSHI}/episodes/${animeId}`, HEADERS, 10000, 0).catch(() => null);
  return Array.isArray(data) ? data : [];
}

async function getEmbeds(animeId, epNum) {
  const data = await getJson(`${SENSHI}/episode-embeds/${animeId}/${epNum}`, HEADERS, 10000, 0).catch(() => null);
  return Array.isArray(data) ? data : [];
}

function mapLang(label) {
  const l = (label || "").toLowerCase();
  if (l.includes("fre")) return "fr";
  if (l.includes("ger")) return "de";
  if (l.includes("spa")) return "es";
  if (l.includes("por")) return "pt";
  return "en";
}

async function resolve(anilistId, episode, opts = {}) {
  const list = [];
  if (opts.title) list.push(opts.title);
  list.push(...(await variants(anilistId)));

  let anime = null;
  for (const t of list) {
    anime = await memo(`senshi:find:${t}`, 24 * 60 * 60 * 1000, () => searchSenshi(t));
    if (anime) break;
  }
  if (!anime) return null;

  const eps = await getEpisodes(anime.id);
  if (!eps.length) return null;
  const target = eps.find((e) => e.ep_id === episode) || eps[0];
  if (!target) return null;

  const embeds = await getEmbeds(anime.id, target.ep_id);
  if (!embeds.length) return null;

  const servers = [];
  for (const embed of embeds) {
    const sources = await getJson(`${VIDCLOUD}/_v1/sources?id=${embed.remote_source_id}`, {
      ...HEADERS,
      Referer: `${SENSHI}/`,
    }, 10000, 0).catch(() => null);
    if (!Array.isArray(sources)) continue;
    for (const src of sources) {
      const m3u8 = src.source && src.source.src;
      if (!m3u8 || servers.some((s) => s.url === m3u8)) continue;
      const type = src.source.audio === "dub" ? "dub" : "sub";
      const subtitles = [];
      for (const track of src.tracks || []) {
        const label = (track.label || "").toLowerCase();
        if (label === "chapter" || label === "storyboard" || label.includes("thumbnail")) continue;
        if (track.vtt_url) {
          subtitles.push({ url: track.vtt_url, lang: mapLang(track.label), label: track.label || "English" });
        }
      }
      const intro =
        embed.intro_start_ms != null && embed.intro_end_ms != null
          ? { start: embed.intro_start_ms / 1000, end: embed.intro_end_ms / 1000 }
          : null;
      const outro =
        embed.outro_start_ms != null && embed.outro_end_ms != null
          ? { start: embed.outro_start_ms / 1000, end: embed.outro_end_ms / 1000 }
          : null;
      servers.push({
        name: `Deo ${embed.status === "HardSub" ? "Hardsub" : "1"}${type === "dub" ? " (Dub)" : ""}`,
        type,
        quality: (src.source && src.source.quality) || "1080p",
        url: m3u8,
        embed: "",
        referer: `${SENSHI}/`,
        subtitles,
        intro,
        outro,
      });
    }
  }
  if (!servers.length) return null;
  return { servers, intro: servers[0].intro, outro: servers[0].outro };
}

async function search(q) {
  return memo(`senshi:search:${q}`, 60 * 60 * 1000, async () => {
    const results = await filterPage(q);
    return results.map((a) => ({
      id: a.id,
      title: a.title_english || a.title,
      episodes: a.ani_episodes || "",
      year: a.ani_year || "",
      type: a.type || "",
    }));
  });
}

async function episodes(anilistId) {
  return memo(`senshi:eps:${anilistId}`, 60 * 60 * 1000, async () => {
    let anime = null;
    for (const t of await variants(anilistId)) {
      anime = await searchSenshi(t);
      if (anime) break;
    }
    if (!anime) return [];
    const eps = await getEpisodes(anime.id);
    return eps.map((e) => ({ number: e.ep_id, hasSub: true, hasDub: true }));
  });
}

module.exports = { resolve, search, episodes };
