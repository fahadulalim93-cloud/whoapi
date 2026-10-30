const { getJson, memo } = require("../core/http");
const { variants } = require("../core/meta");

const API = process.env.NEXUS_API || "https://api.anime.nexus";

function slugToTitle(slug) {
  return (slug || "")
    .replace(/-[a-f0-9]{20}$/i, "")
    .replace(/-/g, " ")
    .trim();
}

function normalize(s) {
  return (s || "").toLowerCase().replace(/[^a-z0-9\s]/g, "").replace(/\s+/g, " ").trim();
}

const catalog = new Map();
let catalogAt = 0;
let building = null;

function ingest(s) {
  if (!s || !s.id || !s.slug) return;
  const keys = [s.name, s.name_alt, slugToTitle(s.slug)];
  for (const k of keys) {
    const key = normalize(k);
    if (key && !catalog.has(key)) catalog.set(key, s);
  }
}

async function buildCatalog() {
  if (building) return building;
  if (catalog.size && Date.now() - catalogAt < 6 * 60 * 60 * 1000) return;
  building = (async () => {
    for (const ep of ["featured", "popular", "latest", "recent", "seasonal"]) {
      const data = await getJson(`${API}/anime/${ep}`, { Accept: "application/json" }, 15000, 0).catch(() => null);
      const items = (data && data.data) || [];
      for (const s of items) ingest(s);
    }
    catalogAt = Date.now();
    building = null;
  })();
  return building;
}

async function findSeries(title) {
  await buildCatalog();
  const norm = normalize(title);
  if (catalog.has(norm)) return catalog.get(norm);
  const stripped = norm.replace(/\s*(season|cour|part)\s*\d+/g, "").trim();
  if (catalog.has(stripped)) return catalog.get(stripped);

  const words = norm.split(" ").filter((w) => w.length > 2);
  let best = null;
  let bestScore = 0;
  for (const [key, series] of catalog) {
    const keyWords = key.split(" ").filter((w) => w.length > 2);
    let score = 0;
    for (const tw of words) {
      if (keyWords.some((kw) => kw === tw || kw.includes(tw) || tw.includes(kw))) score++;
    }
    const min = Math.max(1, Math.ceil(words.length * 0.4));
    if (score >= min && score > bestScore) {
      bestScore = score;
      best = series;
    }
  }
  return best;
}

async function resolve(anilistId, episode, opts = {}) {
  const list = [];
  if (opts.title) list.push(opts.title);
  list.push(...(await variants(anilistId)));

  let series = null;
  for (const t of list) {
    series = await findSeries(t);
    if (series) break;
  }
  if (!series) return null;

  const eps = await memo(`nexus:eps:${series.id}`, 60 * 60 * 1000, async () => {
    const data = await getJson(`${API}/series/${series.id}`, { Accept: "application/json" }, 20000, 0).catch(() => null);
    return (data && data.data) || [];
  });
  if (!eps.length) return null;
  const ep = eps.find((e) => e.number === episode) || eps[0];
  if (!ep) return null;

  const stream = await memo(`nexus:stream:${ep.id}`, 30 * 60 * 1000, async () => {
    const data = await getJson(`${API}/stream/${ep.id}`, { Accept: "application/json" }, 20000, 0).catch(() => null);
    return (data && data.data) || null;
  });
  if (!stream || !stream.hls) return null;

  const audioLangs = (stream.video_meta && stream.video_meta.audio_languages) || [];
  const isDub = audioLangs.some((l) => l === "english" || l === "eng");
  const subtitles = (stream.subtitles || [])
    .filter((s) => s.srcLang !== "chapter")
    .map((s) => ({
      url: s.src,
      lang: (s.srcLang || "en").substring(0, 2).toLowerCase(),
      label: s.label || s.srcLang || "English",
    }));

  return {
    servers: [
      {
        name: "Nexus",
        type: isDub ? "dub" : "sub",
        quality: "1080p",
        url: stream.hls,
        embed: "",
        referer: "https://anime.nexus/",
        subtitles,
      },
    ],
    intro: null,
    outro: null,
  };
}

async function search(q) {
  await buildCatalog();
  const norm = normalize(q);
  const out = [];
  const seen = new Set();
  for (const [key, series] of catalog) {
    if ((key.includes(norm) || norm.includes(key)) && !seen.has(series.id)) {
      seen.add(series.id);
      out.push({
        id: series.id,
        slug: series.slug,
        title: series.name || slugToTitle(series.slug),
        alt: series.name_alt || "",
        type: series.type || "",
        status: series.status || "",
      });
    }
  }
  return out;
}

module.exports = { resolve, search, episodes: null, needsTitle: true };
