const fs = require("../core/flaresolverr");
const { memo } = require("../core/http");
const { variants } = require("../core/meta");

const HOME = "https://www.animeonsen.xyz/";
const API = "https://api.animeonsen.xyz";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

let session = null;

function decodeToken(cookieVal) {
  const bin = Buffer.from(decodeURIComponent(cookieVal), "base64").toString("binary");
  return bin
    .split("")
    .map((c) => String.fromCharCode(c.charCodeAt(0) + 1))
    .join("");
}

async function getSession() {
  if (session && Date.now() < session.expires) return session;

  let cookieVal = null;
  try {
    const homeRes = await Promise.race([
      fetch(HOME, {
        headers: { "User-Agent": UA, Accept: "text/html,application/xhtml+xml", "Accept-Language": "en-US,en;q=0.9" },
      }),
      new Promise((r) => setTimeout(() => r(null), 5000)),
    ]);
    if (homeRes && homeRes.ok) {
      for (const c of homeRes.headers.getSetCookie ? homeRes.headers.getSetCookie() : []) {
        const m = c.match(/ao\.session=([^;]+)/);
        if (m) {
          cookieVal = m[1];
          break;
        }
      }
    }
  } catch {}

  if (!cookieVal && fs.enabled()) {
    const cookies = await fs.cookies(HOME);
    if (cookies) {
      for (const c of cookies) {
        if (c.name === "ao.session") {
          cookieVal = c.value;
          break;
        }
      }
    }
  }
  if (!cookieVal) throw new Error("no ao.session cookie");

  session = { cookie: cookieVal, token: decodeToken(cookieVal), expires: Date.now() + 25 * 60 * 1000 };
  return session;
}

async function onsenFetch(path, timeoutMs = 8000) {
  try {
    const s = await getSession();
    const res = await Promise.race([
      fetch(`${API}${path}`, {
        headers: {
          "User-Agent": UA,
          Accept: "application/json",
          Authorization: `Bearer ${s.token}`,
          Cookie: `ao.session=${s.cookie}`,
          Origin: "https://www.animeonsen.xyz",
          Referer: HOME,
        },
      }),
      new Promise((r) => setTimeout(() => r(null), timeoutMs)),
    ]);
    if (!res || !res.ok) {
      if (res && res.status === 401) session = null;
      return null;
    }
    const text = await res.text();
    if (text.startsWith("<")) return null;
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function normalizeTitle(t) {
  return (t || "")
    .toLowerCase()
    .replace(/\s*(season|cour|part)\s*\d+/gi, "")
    .replace(/:\s*.+$/g, "")
    .replace(/[^a-z0-9]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function contentList(start = 0, limit = 30) {
  return memo(`onsen:list:${start}:${limit}`, 60 * 60 * 1000, async () => {
    const data = await onsenFetch(`/v4/content/index?start=${start}&limit=${limit}`);
    return (data && data.content) || [];
  });
}

async function resolveContentId(anilistId, titles) {
  return memo(`onsen:cid:${anilistId}`, 60 * 60 * 1000, async () => {
    const list = await contentList(0, 30);
    if (!list.length) return null;
    for (const t of titles) {
      const norm = normalizeTitle(t);
      for (const item of list) {
        const itemNorm = normalizeTitle(item.content_title_en || item.content_title);
        if (itemNorm === norm || itemNorm.includes(norm) || norm.includes(itemNorm)) {
          return { contentId: item.content_id, title: item.content_title_en || item.content_title };
        }
      }
    }
    return null;
  });
}

async function resolve(anilistId, episode, opts = {}) {
  const list = [];
  if (opts.title) list.push(opts.title);
  list.push(...(await variants(anilistId)));

  const resolved = await resolveContentId(anilistId, list);
  if (!resolved) return null;

  const data = await onsenFetch(`/v4/content/${resolved.contentId}/video/${episode}`);
  if (!data || !data.uri || !data.uri.stream) return null;

  const subs = Object.entries(data.uri.subtitles || {})
    .map(([lang, url]) => ({ url, lang, label: lang }))
    .filter((s) => s.url);

  const epData = (data.metadata || {}).episode;
  const intro =
    Array.isArray(epData) && epData[1] && epData[1].skipIntro_s && epData[1].skipIntro_e
      ? { start: parseFloat(epData[1].skipIntro_s) || 0, end: parseFloat(epData[1].skipIntro_e) || 0 }
      : null;

  return {
    servers: [
      {
        name: "AnimeOnsen",
        type: "sub",
        quality: "720p",
        url: data.uri.stream,
        embed: "",
        referer: HOME,
        subtitles: subs,
        dash: /\.mpd($|\?)/.test(data.uri.stream),
      },
    ],
    intro,
    outro: null,
  };
}

async function search(q) {
  const list = await contentList(0, 30);
  const lower = q.toLowerCase();
  return list
    .filter((c) => (c.content_title_en || c.content_title || "").toLowerCase().includes(lower))
    .map((c) => ({
      id: c.content_id,
      title: c.content_title_en || c.content_title,
      episodes: c.total_episodes,
      malId: c.mal_id || null,
    }));
}

async function episodes(anilistId) {
  const list = [];
  list.push(...(await variants(anilistId)));
  const resolved = await resolveContentId(anilistId, list);
  if (!resolved) return [];
  return memo(`onsen:eps:${resolved.contentId}`, 60 * 60 * 1000, async () => {
    const data = await onsenFetch(`/v4/content/${resolved.contentId}/episodes`);
    if (!data) return [];
    return Object.keys(data)
      .map((n) => parseInt(n, 10))
      .filter((n) => !isNaN(n))
      .sort((a, b) => a - b)
      .map((n) => ({ number: n, hasSub: true, hasDub: false }));
  });
}

module.exports = { resolve, search, episodes, needsTitle: true };
