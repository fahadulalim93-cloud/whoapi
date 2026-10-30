const crypto = require("crypto");
const { getText, getJson, memo } = require("../core/http");

const ANIKOTO = "https://anikototv.to";
const MEGAPLAY = "https://megaplay.buzz";
const ANIZIP = "https://api.ani.zip/mappings";
const JIKAN = "https://api.jikan.moe/v4";
const SPOOF_REF = "https://hianimes.re/";

const LANG = {
  en: "en", english: "en", eng: "en", "en-us": "en", "en-gb": "en",
  ja: "ja", japanese: "ja", jpn: "ja",
  fr: "fr", french: "fr", fra: "fr",
  de: "de", german: "de", deu: "de",
  es: "es", spanish: "es", spa: "es",
  pt: "pt", portuguese: "pt", por: "pt", "pt-br": "pt", "pt-pt": "pt",
  ru: "ru", russian: "ru", rus: "ru",
  ar: "ar", arabic: "ar", ara: "ar",
  it: "it", italian: "it", ita: "it",
  zh: "zh", chinese: "zh", zho: "zh", chi: "zh",
  ko: "ko", korean: "ko", kor: "ko",
  hi: "hi", hindi: "hi", hin: "hi",
  tr: "tr", turkish: "tr", tur: "tr",
  id: "id", indonesian: "id", ind: "id",
  vi: "vi", vietnamese: "vi", vie: "vi",
  th: "th", thai: "th", tl: "tl", tagalog: "tl", filipino: "tl",
};

const KEY32 = Buffer.alloc(32, 0);
Buffer.from("i?LMTAx0Q6,:}50U", "utf8").copy(KEY32, 0, 0, 16);
const IV = Buffer.from("W0;27ToaUpl_P%'c", "utf8");

function decryptEnc(enc) {
  if (!enc || typeof enc !== "string") return null;
  try {
    let b64 = enc.replace(/-/g, "+").replace(/_/g, "/");
    const rem = b64.length % 4;
    if (rem) b64 += "====".slice(rem);
    const data = Buffer.from(b64, "base64");
    for (const algo of ["aes-256-cbc", "aes-128-cbc"]) {
      try {
        const key = algo === "aes-256-cbc" ? KEY32 : KEY32.subarray(0, 16);
        const d = crypto.createDecipheriv(algo, key, IV);
        const out = Buffer.concat([d.update(data), d.final()]).toString("utf8");
        try {
          const j = JSON.parse(out);
          if (j && typeof j.file === "string") return j.file;
        } catch {}
        if (/^https?:\/\//.test(out.trim())) return out.trim();
      } catch {}
    }
  } catch {}
  return null;
}

function normalize(s) {
  return (s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function skipRange(v) {
  if (Array.isArray(v) && v.length >= 2) return { start: Number(v[0]) || 0, end: Number(v[1]) || 0 };
  if (v && typeof v === "object" && "start" in v && "end" in v) {
    return { start: Number(v.start) || 0, end: Number(v.end) || 0 };
  }
  return null;
}

function okSkip(v) {
  if (!v) return null;
  const s = Number(v.start) || 0;
  const e = Number(v.end) || 0;
  if (e <= s || e <= 0) return null;
  return { start: s, end: e };
}

function mapTrack(t) {
  const file = t.file || "";
  if (!file || file.includes("kryntal.top")) return null;
  const label = t.label || "";
  return { url: file, lang: LANG[label.toLowerCase()] || "und", label: label || "English" };
}

function extractEpisodes(html) {
  const out = [];
  const re = /<a\s[^>]*data-id="[^"]*"[^>]*>/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const tag = m[0];
    const attr = (n) => {
      const x = new RegExp(`data-${n}="([^"]*)"`, "").exec(tag);
      return x ? x[1] : "";
    };
    const id = attr("id");
    const num = attr("num");
    if (!id || !num) continue;
    out.push({
      number: parseInt(num, 10),
      id,
      slug: attr("slug"),
      mal: attr("mal"),
      hasSub: attr("sub") === "1",
      hasDub: attr("dub") === "1",
      ids: attr("ids"),
    });
  }
  return out;
}

function extractSearchCandidates(html) {
  const out = [];
  const re = /<a class="item" href="https:\/\/anikototv\.to\/watch\/([^"]+)"([\s\S]*?)<\/a>/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const block = m[2];
    const en = /class="name d-title"[^>]*>([^<]*)</.exec(block);
    const jp = /data-jp="([^"]*)"/.exec(block);
    const yr = /<span class="dot">(\d{4})<\/span>/.exec(block);
    const ty = /<span class="dot">(TV|Movie|OVA|ONA|Special)<\/span>/.exec(block);
    out.push({
      slug: m[1],
      titleEn: en ? en[1].trim() : "",
      titleJp: jp ? jp[1].trim() : "",
      year: yr ? yr[1] : "",
      type: ty ? ty[1] : "",
    });
  }
  return out;
}

function scoreCandidate(c, j) {
  if (!j) return 0;
  let score = 0;
  const nEn = normalize(j.title_english || j.title || "");
  const nJp = normalize(j.title_japanese || "");
  const nRom = normalize(j.title || "");
  const cEn = normalize(c.titleEn);
  const cJp = normalize(c.titleJp);
  if (nEn && cEn === nEn) score += 50;
  else if (nRom && cEn === nRom) score += 45;
  else if (nEn && cEn.startsWith(nEn)) score += 15;
  if (nJp && cJp === nJp) score += 40;
  else if (nRom && cJp === nRom) score += 35;
  if (c.type && j.type) score += c.type.toLowerCase() === j.type.toLowerCase() ? 20 : -30;
  const jy = j.year || (j.aired && j.aired.from ? parseInt(String(j.aired.from).slice(0, 4), 10) : NaN);
  if (c.year && jy) score += parseInt(c.year, 10) === jy ? 20 : -15;
  return score;
}

async function searchAnikoto(keyword) {
  const data = await getJson(
    `${ANIKOTO}/ajax/anime/search?keyword=${encodeURIComponent(keyword)}`,
    { Referer: `${ANIKOTO}/` }
  ).catch(() => null);
  let results = extractSearchCandidates((data && data.result && data.result.html) || "");
  try {
    const html = await getText(
      `${ANIKOTO}/filter?keyword=${encodeURIComponent(keyword)}`,
      { Referer: `${ANIKOTO}/` }
    );
    const re = /<a class="name d-title" href="https:\/\/anikototv\.to\/watch\/([^"\/]+)(?:\/ep-\d+)?" data-jp="([^"]*)">([\s\S]*?)<\/a>/g;
    let m;
    while ((m = re.exec(html)) !== null) {
      results.push({ slug: m[1], titleEn: m[3].replace(/<[^>]*>/g, "").trim(), titleJp: m[2].trim(), year: "", type: "" });
    }
  } catch {}
  const seen = new Set();
  return results.filter((r) => (seen.has(r.slug) ? false : (seen.add(r.slug), true)));
}

async function resolveTitle(anilistId) {
  return memo(`anikoto:title:${anilistId}`, 60 * 60 * 1000, async () => {
    const anizip = await getJson(`${ANIZIP}?anilist_id=${anilistId}`).catch(() => null);
    if (anizip) {
      const titles = anizip.titles || {};
      const title = titles.en || Object.values(titles)[0] || "";
      const mal = (anizip.mappings || {}).mal_id;
      if (title) return { title, mal };
    }
    const q = `query ($id: Int) { Media(id: $id, type: ANIME) { title { english romaji } idMal } }`;
    const res = await fetch("https://graphql.anilist.co", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ query: q, variables: { id: anilistId } }),
    }).catch(() => null);
    if (res && res.ok) {
      const data = await res.json().catch(() => null);
      const media = data && data.data && data.data.Media;
      if (media) {
        return {
          title: (media.title && (media.title.english || media.title.romaji)) || "",
          mal: media.idMal,
        };
      }
    }
    return { title: "", mal: null };
  });
}

async function findShow(title, mal) {
  let jikan = null;
  if (mal) {
    jikan = await Promise.race([
      getJson(`${JIKAN}/anime/${mal}`).catch(() => null),
      new Promise((r) => setTimeout(() => r(null), 4000)),
    ]);
  }
  const jd = jikan && jikan.data;
  const keys = [...new Set([title, (jd && jd.title) || "", (jd && jd.title_japanese) || ""].filter(Boolean))];
  const searched = await Promise.allSettled(keys.map((k) => searchAnikoto(k)));
  const seen = new Set();
  let candidates = [];
  for (const r of searched) {
    if (r.status !== "fulfilled") continue;
    for (const c of r.value) if (!seen.has(c.slug)) (seen.add(c.slug), candidates.push(c));
  }
  if (!candidates.length) return null;
  if (jd) {
    candidates = candidates
      .map((c) => ({ c, s: scoreCandidate(c, jd) }))
      .sort((a, b) => b.s - a.s)
      .map((x) => x.c);
  }
  const slug = candidates[0].slug;
  const html = await getText(`${ANIKOTO}/watch/${slug}`, { Referer: `${ANIKOTO}/` }).catch(() => "");
  const idm = /data-id="(\d+)"/.exec(html);
  if (!idm) return null;
  return { slug, showId: idm[1] };
}

async function extractEmbed(embedUrl, referer) {
  try {
    const page = await getText(embedUrl, { Referer: referer || SPOOF_REF });
    const m = /data-id="([^"]*)"/.exec(page);
    if (!m || !m[1]) return null;
    const fileId = m[1];
    const origin = new URL(embedUrl).origin;
    const data = await getJson(`${origin}/stream/getSources?id=${fileId}&id=${fileId}`, { Referer: `${origin}/` }).catch(() => null);
    return { fileId, data, origin };
  } catch {
    return null;
  }
}

async function resolveOneServer(item) {
  try {
    const resolved = await getJson(
      `${ANIKOTO}/ajax/server?get=${encodeURIComponent(item.linkId)}`,
      { Referer: `${ANIKOTO}/` },
      15000,
      1
    );
    const r = resolved && resolved.result;
    const embedUrl = r && r.url;
    if (!embedUrl) return null;
    const ex = await extractEmbed(embedUrl, SPOOF_REF);
    let m3u8 = (ex && ex.data && ex.data.sources && ex.data.sources.file) || null;
    if (!m3u8 && ex && ex.data && ex.data.enc) m3u8 = decryptEnc(ex.data.enc);
    const tracks = (ex && ex.data && ex.data.tracks) || [];
    const intro = (ex && ex.data && ex.data.intro) || skipRange(r && r.skip_data && r.skip_data.intro);
    const outro = (ex && ex.data && ex.data.outro) || skipRange(r && r.skip_data && r.skip_data.outro);
    const origin = ex ? ex.origin : new URL(embedUrl).origin;
    return {
      fileId: ex && ex.fileId,
      m3u8,
      tracks,
      intro,
      outro,
      embedUrl,
      origin,
      name: item.name,
    };
  } catch {
    return null;
  }
}

function extractServerItems(html, audio) {
  const items = [];
  const typeRe = /<div class="type" data-type="(sub|dub)">([\s\S]*?)<\/ul>\s*<\/div>/g;
  let tm;
  while ((tm = typeRe.exec(html)) !== null) {
    if (tm[1] !== audio) continue;
    const liRe = /<li\s+([^>]*data-link-id[^>]*)>([\s\S]*?)<\/li>/g;
    let lm;
    while ((lm = liRe.exec(tm[2])) !== null) {
      const idm = /data-link-id="([^"]+)"/.exec(lm[1]);
      if (idm) items.push({ linkId: idm[1], name: lm[2].replace(/<[^>]+>/g, "").trim() });
    }
  }
  return items;
}

async function resolveRawAll(anilistId, ep, title) {
  const empty = { streams: [], subtitles: [], intro: null, outro: null };
  const info = await resolveTitle(anilistId);
  if (!info.title) return { sub: empty, dub: empty };
  const show = await findShow(info.title, info.mal).catch(() => null);
  if (!show) return { sub: empty, dub: empty };
  const listData = await getJson(
    `${ANIKOTO}/ajax/episode/list/${show.showId}`,
    { Referer: `${ANIKOTO}/watch/${show.slug}` }
  ).catch(() => null);
  const eps = extractEpisodes((listData && listData.result) || "");
  const found = eps.find((e) => e.number === ep);
  if (!found || !found.ids) return { sub: empty, dub: empty };
  const serverData = await getJson(
    `${ANIKOTO}/ajax/server/list?servers=${encodeURIComponent(found.ids)}`,
    { Referer: `${ANIKOTO}/` }
  ).catch(() => null);
  const serverHtml = (serverData && serverData.result) || "";
  const all = [
    ...extractServerItems(serverHtml, "sub").map((i) => ({ ...i, audio: "sub" })),
    ...extractServerItems(serverHtml, "dub").map((i) => ({ ...i, audio: "dub" })),
  ];
  if (!all.length) return { sub: empty, dub: empty };

  const settled = await Promise.allSettled(
    all.map((item) =>
      Promise.race([
        resolveOneServer(item),
        new Promise((r) => setTimeout(() => r(null), 6000)),
      ])
    )
  );

  const sub = { streams: [], subtitles: [], intro: null, outro: null };
  const dub = { streams: [], subtitles: [], intro: null, outro: null };
  const seenUrl = { sub: new Set(), dub: new Set() };

  settled.forEach((r, idx) => {
    if (r.status !== "fulfilled" || !r.value) return;
    const item = all[idx];
    const target = item.audio === "sub" ? sub : dub;
    const seen = seenUrl[item.audio];
    const v = r.value;
    const key = v.embedUrl || v.m3u8 || "";
    if (key && seen.has(key)) return;
    if (key) seen.add(key);
    target.streams.push(v);
    for (const t of v.tracks) {
      const mapped = mapTrack(t);
      if (mapped && !target.subtitles.some((s) => s.url === mapped.url)) target.subtitles.push(mapped);
    }
    if (!target.intro && v.intro) target.intro = v.intro;
    if (!target.outro && v.outro) target.outro = v.outro;
  });

  return { sub, dub };
}

async function resolve(anilistId, episode, opts = {}) {
  const servers = [];
  let intro = null;
  let outro = null;

  const mega = await Promise.allSettled(
    ["sub", "dub"].map(async (audio) => {
      const embedUrl = `${MEGAPLAY}/stream/ani/${anilistId}/${episode}/${audio}`;
      let html = await getText(embedUrl, { Referer: SPOOF_REF });
      if (!/data-id="([^"]*)"/.test(html)) {
        const fm = /<iframe\b[^>]*src="([^"]+)"/i.exec(html);
        if (fm) {
          const next = fm[1].startsWith("http") ? fm[1] : `${MEGAPLAY}${fm[1]}`;
          html = await getText(next, { Referer: SPOOF_REF });
        }
      }
      const fileIdM = /data-id="([^"]*)"/.exec(html);
      if (!fileIdM) return null;
      const fileId = fileIdM[1];
      const src = await getJson(`${MEGAPLAY}/stream/getSources?id=${fileId}&id=${fileId}`, { Referer: `${MEGAPLAY}/` }).catch(() => null);
      const subs = [];
      for (const t of (src && src.tracks) || []) {
        const mapped = mapTrack(t);
        if (mapped && !subs.some((s) => s.url === mapped.url)) subs.push(mapped);
      }
      let m3u8 = null;
      if (src) {
        if (src.sources && src.sources.file) m3u8 = src.sources.file;
        else if (src.enc) m3u8 = decryptEnc(src.enc);
        if (m3u8 && m3u8.includes("cdn.imgnex.top") && !m3u8.includes("ncdn.imgnex.top")) {
          m3u8 = m3u8.replace("cdn.imgnex.top", "ncdn.imgnex.top");
        }
      }
      return {
        name: `Megaplay ${audio === "sub" ? "Sub" : "Dub"}`,
        type: audio,
        quality: "1080p",
        url: m3u8,
        embed: embedUrl,
        referer: `${MEGAPLAY}/`,
        fileId,
        audio,
        subtitles: subs,
        intro: okSkip(src && src.intro),
        outro: okSkip(src && src.outro),
      };
    })
  );

  for (const r of mega) {
    if (r.status === "fulfilled" && r.value) {
      servers.push(r.value);
      if (!intro && r.value.intro) intro = r.value.intro;
      if (!outro && r.value.outro) outro = r.value.outro;
    }
  }

  const info = await resolveTitle(anilistId);
  const raw = info.title
    ? await Promise.race([
        memo(`anikoto:raw:${anilistId}:${episode}`, 5 * 60 * 1000, () => resolveRawAll(anilistId, episode, info.title)),
        new Promise((r) => setTimeout(() => r(null), 12000)),
      ])
    : null;

  if (raw) {
    for (const [type, side] of [["sub", raw.sub], ["dub", raw.dub]]) {
      if (!side) continue;
      for (const s of side.streams) {
        if (s.fileId) {
          servers.push({
            name: `AniKoto ${s.name || "HD"}${type === "dub" ? " (Dub)" : ""}`,
            type,
            quality: "1080p",
            url: s.m3u8 || null,
            embed: s.embedUrl || "",
            referer: s.origin ? `${s.origin}/` : `${ANIKOTO}/`,
            fileId: s.fileId,
            audio: type,
            subtitles: side.subtitles,
            intro: okSkip(side.intro),
            outro: okSkip(side.outro),
          });
        } else if (s.m3u8) {
          servers.push({
            name: `AniKoto ${s.name || "HD"}${type === "dub" ? " (Dub)" : ""}`,
            type,
            quality: "1080p",
            url: s.m3u8,
            embed: "",
            referer: s.origin ? `${s.origin}/` : `${ANIKOTO}/`,
            subtitles: side.subtitles,
            intro: okSkip(side.intro),
            outro: okSkip(side.outro),
          });
        }
      }
      if (!intro && side.intro) intro = okSkip(side.intro);
      if (!outro && side.outro) outro = okSkip(side.outro);
    }
  }

  const seen = new Set();
  const deduped = servers.filter((s) => {
    const k = s.url || s.embed || "";
    if (!k || seen.has(k) || k.includes("kryntal.top")) return false;
    seen.add(k);
    return true;
  });

  if (!deduped.length) return null;
  return { servers: deduped, intro, outro };
}

async function search(q) {
  return memo(`anikoto:search:${q}`, 10 * 60 * 1000, () => searchAnikoto(q));
}

async function episodes(anilistId) {
  return memo(`anikoto:eps:${anilistId}`, 30 * 60 * 1000, async () => {
    const info = await resolveTitle(anilistId);
    if (!info.title) return [];
    const show = await findShow(info.title, info.mal).catch(() => null);
    if (!show) return [];
    const data = await getJson(
      `${ANIKOTO}/ajax/episode/list/${show.showId}`,
      { Referer: `${ANIKOTO}/watch/${show.slug}` }
    ).catch(() => null);
    return extractEpisodes((data && data.result) || "").map((e) => ({
      number: e.number,
      hasSub: e.hasSub,
      hasDub: e.hasDub,
    }));
  });
}

async function recent(page = 1, perPage = 20) {
  const data = await getJson(`https://anikotoapi.site/recent-anime?page=${page}&per_page=${perPage}`, {}, 15000, 1).catch(() => null);
  return (data && data.data) || [];
}

module.exports = { resolve, search, episodes, recent };
