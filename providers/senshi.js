const { getJson, postText, memo } = require("../core/http");
const { variants } = require("../core/meta");

const SENSHI = "https://senshi.to";
const ANIDAP_MAP = "https://anidap.lol/api/anime";
const ANIDAP_API = "https://chad.anidap.lol/rest/api";
const ANIDAP_HEADERS = {
  Accept: "application/json, text/plain, */*",
  "Accept-Language": "en-US,en;q=0.9",
  Origin: "https://anidap.lol",
  Referer: "https://anidap.lol/",
};

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

  const seen = new Set();
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

async function anidapSlug(anilistId) {
  return memo(`anidap:slug:${anilistId}`, 24 * 60 * 60 * 1000, async () => {
    const data = await getJson(`${ANIDAP_MAP}/${anilistId}`, ANIDAP_HEADERS, 10000, 0).catch(() => null);
    if (!data || !data.success || !data.data || !data.data.id) return null;
    return data.data.id;
  });
}

async function anidapServers(slug, epNum) {
  return memo(`anidap:srv:${slug}:${epNum}`, 60 * 60 * 1000, async () => {
    const data = await getJson(`${ANIDAP_API}/servers?id=${encodeURIComponent(slug)}&epNum=${epNum}`, ANIDAP_HEADERS, 12000, 0).catch(() => null);
    if (!data) return { sub: [], dub: [] };
    return {
      sub: (data.subProviders || []).map((p) => p.id),
      dub: (data.dubProviders || []).map((p) => p.id),
    };
  });
}

async function anidapSources(slug, epNum, type, providerId) {
  const key = `anidap:src:${slug}:${epNum}:${type}:${providerId}`;
  return memo(key, 30 * 60 * 1000, async () => {
    const url = `${ANIDAP_API}/sources?id=${encodeURIComponent(slug)}&epNum=${epNum}&type=${type}&providerId=${providerId}`;
    const data = await getJson(url, ANIDAP_HEADERS, 15000, 0).catch(() => null);
    if (!data || !Array.isArray(data.sources) || !data.sources.length) return null;
    const first = data.sources[0];
    if (!first || !first.url) return null;
    const subtitles = [];
    for (const t of data.tracks || []) {
      if (!t || !t.url) continue;
      const fixed = String(t.url).replace(":///", "://");
      subtitles.push({ url: fixed, lang: (t.lang || "en").substring(0, 2).toLowerCase(), label: t.label || t.lang || "English" });
    }
    let intro = null;
    let outro = null;
    for (const c of data.chapters || []) {
      if (!c || typeof c.start !== "number" || typeof c.end !== "number") continue;
      const title = (c.title || "").toLowerCase();
      if (!intro && title.includes("intro")) intro = { start: c.start, end: c.end };
      if (!outro && (title.includes("outro") || title.includes("ending"))) outro = { start: c.start, end: c.end };
    }
    return {
      url: first.url,
      quality: first.quality || "auto",
      type: first.type || "",
      referer: (data.headers && data.headers.Referer) || "",
      subtitles,
      intro,
      outro,
    };
  });
}

function serverName(providerId, type, quality) {
  const labels = { nero: "Nero", yuki: "Yuki", zuna: "Zuna", loli: "Loli", mimi: "Mimi", beep: "Beep", sora: "Sora", kiwi: "Kiwi", uwu: "Uwu" };
  const base = labels[providerId] || providerId.toUpperCase();
  return `${base} ${type === "dub" ? "(Dub)" : ""}`.trim();
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

  const slug = await anidapSlug(anilistId);
  if (!slug) return null;

  const catalog = await anidapServers(slug, target.ep_id);
  const picks = [];
  for (const id of catalog.sub) picks.push({ providerId: id, type: "sub" });
  for (const id of catalog.dub) picks.push({ providerId: id, type: "dub" });
  if (!picks.length) return null;

  const servers = [];
  const seenUrl = new Set();
  for (const pick of picks) {
    const src = await anidapSources(slug, target.ep_id, pick.type, pick.providerId);
    if (!src || seenUrl.has(src.url)) continue;
    seenUrl.add(src.url);
    servers.push({
      name: serverName(pick.providerId, pick.type, src.quality),
      type: pick.type,
      quality: src.quality === "auto" ? "1080p" : src.quality,
      url: src.url,
      embed: "",
      referer: src.referer,
      subtitles: src.subtitles,
      intro: src.intro,
      outro: src.outro,
    });
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
