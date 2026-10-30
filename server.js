const path = require("path");
const express = require("express");
const { getJson, memo } = require("./core/http");

const anikoto = require("./providers/anikoto");
const animeparadise = require("./providers/animeparadise");
const aniwaves = require("./providers/aniwaves");
const anipm = require("./providers/anipm");
const gotaku = require("./providers/gotaku");
const reanime = require("./providers/reanime");
const senshi = require("./providers/senshi");
const anizone = require("./providers/anizone");
const nexus = require("./providers/nexus");
const animeonsen = require("./providers/animeonsen");
const mmani = require("./providers/mmani");
const xanime = require("./providers/xanime");
const anihq = require("./providers/anihq");

const app = express();
const PORT = process.env.PORT || 3000;

const PROVIDERS = {
  anikoto: { mod: anikoto, label: "AniKoto", hasRecent: true, hasSearch: true, hasEpisodes: true },
  animeparadise: { mod: animeparadise, label: "AnimeParadise", hasSearch: true },
  aniwaves: { mod: aniwaves, label: "AniWaves", hasSearch: true },
  anipm: { mod: anipm, label: "Ani.pm", sidecar: true },
  gotaku: { mod: gotaku, label: "Gotaku", hasSearch: true, fs: true },
  reanime: { mod: reanime, label: "Reanime", hasSearch: true },
  senshi: { mod: senshi, label: "Senshi", hasSearch: true, hasEpisodes: true },
  anizone: { mod: anizone, label: "AniZone", hasSearch: true, fs: true },
  nexus: { mod: nexus, label: "Nexus", hasSearch: true },
  animeonsen: { mod: animeonsen, label: "AnimeOnsen", hasSearch: true, hasEpisodes: true, fsFallback: true },
  mmani: { mod: mmani, label: "MMani", hasSearch: true, hasEpisodes: true },
  xanime: { mod: xanime, label: "Xanime", hasSearch: true, fsFallback: true },
  anihq: { mod: anihq, label: "AniHQ", hasSearch: true, fs: true },
};

app.use(express.static(path.join(__dirname, "public")));

app.get("/health", (req, res) => res.json({ ok: true }));

app.get("/providers", (req, res) => {
  res.json(
    Object.entries(PROVIDERS).map(([id, p]) => ({
      id,
      name: p.label,
      search: !!p.hasSearch,
      episodes: !!p.hasEpisodes,
      recent: !!p.hasRecent,
      sidecar: !!p.sidecar,
      fs: !!p.fs || !!p.fsFallback,
    }))
  );
});

app.get("/map/:anilistId", async (req, res) => {
  const id = parseInt(req.params.anilistId, 10);
  if (!id) return res.status(400).json({ error: "bad anilist id" });
  const data = await memo(`map:${id}`, 24 * 60 * 60 * 1000, () =>
    getJson(`https://api.ani.zip/mappings?anilist_id=${id}`)
  );
  if (!data) return res.status(502).json({ error: "mapping lookup failed" });
  res.json(data);
});

async function titleFor(anilistId) {
  const data = await memo(`map:${anilistId}`, 24 * 60 * 60 * 1000, () =>
    getJson(`https://api.ani.zip/mappings?anilist_id=${anilistId}`)
  );
  if (data) {
    const titles = data.titles || {};
    return titles.en || Object.values(titles)[0] || "";
  }
  return "";
}

app.get("/:provider/recent", async (req, res) => {
  const p = PROVIDERS[req.params.provider];
  if (!p || !p.hasRecent) return res.status(404).json({ error: "unknown provider or route" });
  const page = parseInt(req.query.page, 10) || 1;
  const perPage = Math.min(parseInt(req.query.per_page, 10) || 20, 50);
  const data = await p.mod.recent(page, perPage);
  res.json({ provider: req.params.provider, page, perPage, results: data });
});

app.get("/:provider/search", async (req, res) => {
  const p = PROVIDERS[req.params.provider];
  if (!p || !p.hasSearch) return res.status(404).json({ error: "unknown provider or route" });
  const q = (req.query.q || "").trim();
  if (!q) return res.status(400).json({ error: "q required" });
  const results = await p.mod.search(q);
  res.json({ provider: req.params.provider, query: q, results });
});

app.get("/:provider/episodes/:anilistId", async (req, res) => {
  const p = PROVIDERS[req.params.provider];
  if (!p || !p.hasEpisodes) return res.status(404).json({ error: "unknown provider or route" });
  const id = parseInt(req.params.anilistId, 10);
  if (!id) return res.status(400).json({ error: "bad anilist id" });
  const results = await p.mod.episodes(id);
  res.json({ provider: req.params.provider, anilistId: id, episodes: results });
});

app.get("/watch/:provider/:anilistId/:episode", async (req, res) => {
  const p = PROVIDERS[req.params.provider];
  if (!p) return res.status(404).json({ error: "unknown provider" });
  const anilistId = parseInt(req.params.anilistId, 10);
  const episode = parseInt(req.params.episode, 10);
  if (!anilistId || !episode) return res.status(400).json({ error: "bad anilist id or episode" });

  const type = req.query.type === "dub" ? "dub" : req.query.type === "sub" ? "sub" : null;
  const title = p.mod.needsTitle === false ? "" : (req.query.title || "").trim() || (await titleFor(anilistId));

  const result = await p.mod.resolve(anilistId, episode, { title, type });
  if (!result || !result.servers.length) {
    return res.status(404).json({ error: "no streams found", provider: req.params.provider, anilistId, episode });
  }
  let servers = result.servers;
  if (type) servers = servers.filter((s) => s.type === type);
  res.json({ provider: req.params.provider, anilistId, episode, intro: result.intro, outro: result.outro, servers });
});

app.use((req, res) => res.status(404).json({ error: "not found" }));

app.listen(PORT, () => console.log(`whoapi on :${PORT}`));
