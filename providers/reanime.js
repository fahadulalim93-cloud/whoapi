const { getJson, memo } = require("../core/http");
const { createHash, createDecipheriv, pbkdf2Sync } = require("crypto");

const BASE = "https://reanime.to";
const FLIXCLOUD = "https://flixcloud.cc";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const HEADERS = {
  "User-Agent": UA,
  Accept: "application/json, text/plain, */*",
  "Accept-Language": "en-US,en;q=0.9",
  Referer: `${BASE}/`,
};

function sha256hex(input) {
  return createHash("sha256").update(input).digest("hex");
}

function deriveFieldNames(seed) {
  let e = seed;
  for (let o = 0; o < 3; o++) e = sha256hex(e + o.toString());
  let s = e;
  for (let o = 0; o < 3; o++) s = sha256hex(s + o.toString());
  return {
    videoField: `vf_${e.substring(0, 8)}`,
    keyField: `kf_${e.substring(8, 16)}`,
    ivField: `ivf_${e.substring(16, 24)}`,
    containerName: `cd_${e.substring(24, 32)}`,
    arrayName: `ad_${e.substring(32, 40)}`,
    objectName: `od_${e.substring(40, 48)}`,
    tokenField: `${e.substring(48, 64)}_${e.substring(56, 64)}`,
    keyFrag2Field: `${s.substring(0, 16)}_${s.substring(16, 24)}`,
  };
}

function b64ToBytes(b64) {
  return new Uint8Array(Buffer.from(b64, "base64"));
}

const WASM_PAYLOAD =
  "AGFzbQEAAAABEQNgAX8AYAV/f39/fwBgAAF/AwQDAAECBQMBAAEGBgF/AUEACwcZBAZtZW1vcnkCAAJfcwAAAl9yAAECX2MAAgrRAQMGACAAJAALiQEBA39BACEFA0ACQCAFIARPDQAgACAFai0AACABIAVqLQAAcyACIAVqLQAAcyEGIAZBqgFzIQYgBkEDdEH/AXEgBkEFdnIhBiAGQRxrQf8BcSEGIAZBjAFqQf8BcSEGIAVBNWwjAGpB/wFxIQcgBiAHcyEGIAMgBWogBjoAACAFQQFqIQUMAQsLCz0BAX9BACEAA0ACQCAAQSBPDQBBkBAgAGpB0A8gAGotAABB8A8gAGotAABzOgAAIABBAWohAAwBCwtBkBALC0cBAEHQDwtAW1YjHji3UA4OcYOKT37mEFKkYHsdvRT+dpTZyIOZYH7R8WFzSwhwLGTcgHO0Z4IlarO8COjTC8GF2eg3UIzCpg==";

async function wasmKeyDerive(wasmPayload, frag1, keyFrag2, tokenKeyData, seedInt) {
  const wasmBinary = Buffer.from(wasmPayload || WASM_PAYLOAD, "base64");
  const { instance } = await WebAssembly.instantiate(wasmBinary, {});
  const mem = instance.exports.memory;
  if (mem.buffer.byteLength === 0) mem.grow(1);
  const view = new Uint8Array(mem.buffer);

  const k = frag1.length;
  const base = 1000;
  view.set(frag1, base);
  view.set(keyFrag2, base + k);
  view.set(tokenKeyData, base + 2 * k);

  instance.exports._s(seedInt);
  instance.exports._r(base, base + k, base + 2 * k, base + 3 * k, k);

  const result = new Uint8Array(k);
  result.set(view.subarray(base + 3 * k, base + 4 * k));
  return result;
}

async function fetchText(url, referer, ms = 20000) {
  const res = await fetch(url, {
    headers: { "User-Agent": UA, Referer: referer, Accept: "text/html,application/json" },
    signal: AbortSignal.timeout(ms),
  }).catch(() => null);
  if (!res || !res.ok) return null;
  return res.text();
}

async function decryptFlixEmbed(accessId, version) {
  const html = await fetchText(`${FLIXCLOUD}/e/${accessId}?v=${version}`, `${BASE}/`);
  if (!html || html.includes("Just a moment") || html.length < 5000) return null;

  const marker = 'type:"data",data:{';
  const idx = html.indexOf(marker);
  if (idx < 0) return null;

  const objStart = idx + marker.length - 1;
  let braceCount = 0;
  let objEnd = -1;
  for (let i = objStart; i < html.length; i++) {
    if (html[i] === "{") braceCount++;
    if (html[i] === "}") {
      braceCount--;
      if (braceCount === 0) {
        objEnd = i + 1;
        break;
      }
    }
  }
  if (objEnd < 0) return null;

  let data;
  try {
    data = new Function(`return ${html.substring(objStart, objEnd)}`)();
  } catch {
    return null;
  }

  const seed = data.obfuscation_seed;
  const subtitles = data.subtitles || [];
  const intro = data.intro_chapter || null;
  const outro = data.outro_chapter || null;
  if (!seed || !data.obfuscated_crypto_data) return null;

  const fields = deriveFieldNames(seed);
  const container = data.obfuscated_crypto_data[fields.containerName];
  if (!container) return null;
  const arr = container[fields.arrayName];
  if (!arr || !Array.isArray(arr) || !arr.length) return null;
  const obj = arr[0] && arr[0][fields.objectName];
  if (!obj) return null;

  const frag1B64 = obj[fields.keyField];
  const ivB64 = obj[fields.ivField];
  const keyFrag2 = data[fields.keyFrag2Field];
  const token = data[fields.tokenField];
  if (!frag1B64 || !ivB64 || !keyFrag2 || !token) return null;

  const m3u8Raw = await fetchText(`${FLIXCLOUD}/api/m3u8/${token}`, `${FLIXCLOUD}/`);
  if (!m3u8Raw) return null;
  let m3u8Data;
  try {
    m3u8Data = JSON.parse(m3u8Raw);
  } catch {
    return null;
  }

  const vidKey = sha256hex(token + "vid").substring(0, 10);
  const keyKey = sha256hex(token + "key").substring(0, 10);
  const v = m3u8Data[vidKey];
  const T = m3u8Data[keyKey];
  if (!v || !T) return null;

  const seedInt = parseInt(seed.substring(0, 8), 16);
  const wasmResult = await wasmKeyDerive(data.w_payload, b64ToBytes(frag1B64), b64ToBytes(keyFrag2), b64ToBytes(T), seedInt);

  const derived = new Uint8Array(pbkdf2Sync(Buffer.from(wasmResult), Buffer.from(seed, "utf8"), 1000, 32, "sha256"));
  for (let i = 0; i < 32; i++) derived[i] ^= seed.charCodeAt(i % seed.length);

  const aesKey = createHash("sha256").update(derived).digest();
  try {
    const decipher = createDecipheriv("aes-256-cbc", aesKey, b64ToBytes(ivB64));
    const decrypted = Buffer.concat([decipher.update(b64ToBytes(v)), decipher.final()]);
    const m3u8Url = decrypted.toString("utf8").trim();
    if (!m3u8Url.startsWith("http")) return null;
    return { m3u8Url, subtitles, intro, outro };
  } catch {
    return null;
  }
}

async function flixServers(anilistId, episode) {
  const data = await memo(`reanime:flix:${anilistId}:${episode}`, 5 * 60 * 1000, () =>
    getJson(`${BASE}/api/flix/${anilistId}/${episode}`, HEADERS, 15000, 1).catch(() => null)
  );
  return (data && data.servers) || [];
}

async function resolve(anilistId, episode) {
  const list = await flixServers(anilistId, episode);
  const servers = [];
  const seen = new Set();
  for (const s of list) {
    if (!s.dataLink || seen.has(s.dataLink)) continue;
    seen.add(s.dataLink);
    const accessId = (s.dataLink.match(/e\/([^?]+)/) || [])[1];
    if (!accessId) continue;
    const version = (s.dataLink.match(/v=(\d+)/) || [])[1] || "1";
    const dub = /dub/i.test(s.serverName || "") || /dub/i.test(s.dataType || "");
    const type = dub ? "dub" : "sub";

    const dec = await memo(`reanime:dec:${accessId}:${version}`, 10 * 60 * 1000, () =>
      decryptFlixEmbed(accessId, version)
    );
    if (!dec || !dec.m3u8Url) continue;

    const subtitles = (dec.subtitles || [])
      .filter((t) => t && t.url)
      .map((t) => ({
        url: t.url,
        lang: (t.language || t.lang || "en").substring(0, 2).toLowerCase(),
        label: t.language || t.lang || "English",
      }));

    const intro =
      dec.intro && typeof dec.intro.start === "number" && typeof dec.intro.end === "number"
        ? { start: dec.intro.start, end: dec.intro.end }
        : null;
    const outro =
      dec.outro && typeof dec.outro.start === "number" && typeof dec.outro.end === "number"
        ? { start: dec.outro.start, end: dec.outro.end }
        : null;

    servers.push({
      name: s.serverName || (dub ? "Reanime Dub" : "Reanime Sub"),
      type,
      quality: s.serverName === "HD-2" ? "1080p" : "720p",
      url: dec.m3u8Url,
      embed: "",
      referer: `${FLIXCLOUD}/`,
      subtitles,
      intro,
      outro,
    });
  }
  if (!servers.length) return null;
  return { servers, intro: servers[0].intro, outro: servers[0].outro };
}

async function search(q) {
  return memo(`reanime:search:${q}`, 60 * 60 * 1000, async () => {
    const data = await getJson(`${BASE}/api/v1/search?q=${encodeURIComponent(q)}&limit=10`, HEADERS, 10000, 0).catch(() => null);
    const results = (data && data.results) || [];
    return results.map((r) => ({
      id: r.anime_id,
      anilistId: r.anilist_id || null,
      title: (r.title && (r.title.english || r.title.romaji || r.title.native)) || r.anime_id,
      type: r.type || "",
    }));
  });
}

module.exports = { resolve, search, episodes: null, needsTitle: false };
