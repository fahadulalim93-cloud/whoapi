const fs = require("../core/flaresolverr");
const { memo } = require("../core/http");
const { variants } = require("../core/meta");

const BASE = "https://mmani.com";

function stripTags(s) {
  return s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function normalize(s) {
  return (s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

async function searchPosts(title) {
  return memo(`mmani:search:${normalize(title)}`, 60 * 60 * 1000, async () => {
    const html = await fs.get(`${BASE}/search/?wd=${encodeURIComponent(title)}`, 45000);
    if (!html) return [];
    const out = [];
    const seen = new Set();
    const re = /<a href="https:\/\/mmani\.com\/up\/(\d+)" title="([^"]*)"/g;
    let m;
    while ((m = re.exec(html)) !== null) {
      const postid = m[1];
      if (seen.has(postid)) continue;
      seen.add(postid);
      out.push({ postid, title: m[2] });
    }
    return out;
  });
}

async function findPostId(titles) {
  for (const t of titles) {
    const posts = await searchPosts(t);
    if (!posts.length) continue;
    const wanted = normalize(t);
    for (const p of posts) {
      const n = normalize(p.title);
      if (n === wanted) return p.postid;
    }
    for (const p of posts) {
      const n = normalize(p.title);
      if (n.includes(wanted) || wanted.includes(n)) return p.postid;
    }
  }
  return null;
}

async function seriesServers(postid) {
  return memo(`mmani:series:${postid}`, 60 * 60 * 1000, async () => {
    const html = await fs.get(`${BASE}/up/${postid}`, 45000);
    if (!html) return [];
    const out = [];
    const seen = new Set();
    const re = /watch\/\?server=(\d+)&amp;slug=([0-9]+)/g;
    let m;
    while ((m = re.exec(html)) !== null) {
      const key = `${m[1]}:${m[2]}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ server: m[1], slug: m[2] });
    }
    return out;
  });
}

async function watchIframe(postid, server, slug) {
  return memo(`mmani:watch:${postid}:${server}:${slug}`, 30 * 60 * 1000, async () => {
    const html = await fs.get(`${BASE}/up/${postid}/watch/?server=${server}&slug=${slug}`, 45000);
    if (!html) return [];
    const out = [];
    const re = /src="(https:\/\/[^"]+playsub\.php[^"]*)"/g;
    let m;
    while ((m = re.exec(html)) !== null) {
      out.push(m[1].replace(/&amp;/g, "&"));
    }
    return out;
  });
}

function buildHlsUrl(playerUrl) {
  try {
    const parsed = new URL(playerUrl);
    const id = parsed.searchParams.get("id");
    const video = parsed.searchParams.get("url");
    if (!id || !video) return null;
    const b64 = Buffer.from(video, "utf8").toString("base64");
    return `${parsed.origin}/hls/${id}/${b64}/index.m3u8`;
  } catch {
    return null;
  }
}

async function resolve(anilistId, episode, opts = {}) {
  const list = [];
  if (opts.title) list.push(opts.title);
  list.push(...(await variants(anilistId)));

  const postid = await findPostId(list);
  if (!postid) return null;

  const pairs = await seriesServers(postid);
  const target = String(episode).padStart(2, "0");
  const picks = pairs.filter((p) => parseInt(p.slug, 10) === episode);
  if (!picks.length) return null;

  const servers = [];
  const seen = new Set();
  for (const pick of picks) {
    const links = await watchIframe(postid, pick.server, target);
    for (const link of links) {
      const m3u8 = buildHlsUrl(link);
      if (!m3u8 || seen.has(m3u8)) continue;
      seen.add(m3u8);
      const origin = new URL(link).origin;
      const sub = /sub=sub/.test(link);
      servers.push({
        name: `MMani ${pick.server}${sub ? "" : " (Dub)"}`,
        type: sub ? "sub" : "dub",
        quality: "720p",
        url: m3u8,
        embed: "",
        referer: `${origin}/`,
        subtitles: [],
        intro: null,
        outro: null,
      });
    }
  }
  if (!servers.length) return null;
  return { servers, intro: null, outro: null };
}

async function search(q) {
  const posts = await searchPosts(q);
  return posts.map((p) => ({ id: p.postid, title: p.title }));
}

async function episodes(anilistId, opts = {}) {
  const list = [];
  if (opts.title) list.push(opts.title);
  list.push(...(await variants(anilistId)));
  const postid = await findPostId(list);
  if (!postid) return [];
  const pairs = await seriesServers(postid);
  const numbers = new Set();
  for (const p of pairs) {
    const n = parseInt(p.slug, 10);
    if (!isNaN(n)) numbers.add(n);
  }
  return [...numbers]
    .sort((a, b) => a - b)
    .map((n) => ({ number: n, hasSub: true, hasDub: true }));
}

module.exports = { resolve, search, episodes, needsTitle: true };
