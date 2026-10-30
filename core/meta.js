const { getJson, memo } = require("./http");

const ANILIST_GRAPHQL = "https://graphql.anilist.co";

async function lookup(anilistId) {
  return memo(`meta:${anilistId}`, 24 * 60 * 60 * 1000, async () => {
    const q = `query ($id: Int) { Media(id: $id, type: ANIME) { title { english romaji native } idMal } }`;
    const res = await fetch(ANILIST_GRAPHQL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ query: q, variables: { id: anilistId } }),
    }).catch(() => null);
    if (res && res.ok) {
      const data = await res.json().catch(() => null);
      const media = data && data.data && data.data.Media;
      if (media) {
        return {
          english: (media.title && media.title.english) || "",
          romaji: (media.title && media.title.romaji) || "",
          native: (media.title && media.title.native) || "",
          mal: media.idMal || null,
        };
      }
    }
    const anizip = await getJson(`https://api.ani.zip/mappings?anilist_id=${anilistId}`).catch(() => null);
    if (anizip) {
      const titles = anizip.titles || {};
      const vals = Object.values(titles);
      return {
        english: titles.en || vals[0] || "",
        romaji: titles.ja || titles["x-jt"] || vals[0] || "",
        native: titles.ja || "",
        mal: (anizip.mappings || {}).mal_id || null,
      };
    }
    return { english: "", romaji: "", native: "", mal: null };
  });
}

async function variants(anilistId) {
  const info = await lookup(anilistId);
  const seen = new Set();
  return [info.english, info.romaji, info.native]
    .map((t) => (t || "").trim())
    .filter((t) => {
      if (!t) return false;
      const k = t.toLowerCase();
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
}

module.exports = { lookup, variants };
