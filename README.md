# whoapi

one api in front of the providers we scrape. anilist id in, streams out.
plain node, no database, no auth, no queue. node 18+.

## providers

| id | site | needs | notes |
|---|---|---|---|
| `anikoto` | anikototv.to | nothing | megaplay + raw servers, sub + dub, search / episodes / recent |
| `animeparadise` | animeparadise.moe | nothing | json api + next server action, direct m3u8 |
| `aniwaves` | aniwaves.ru | nothing | echovideo extraction, hardsub/softsub/dub |
| `anipm` | ani.pm | python sidecar | settlar cdn sits behind cloudflare, curl_cffi handles it |
| `gotaku` | gotaku.to | flaresolverr | SPA site, everything runs through a real browser. resolve crawls the browse page and stops as soon as the requested show is mapped, then cached 24h |
| `reanime` | reanime.to | nothing | their flixcloud embed is decrypted server side (wasm + aes), you get a real m3u8 with intro/outro chapters. note: flixcloud recently started encrypting the playlist body itself, when that hits you get servers but playback fails until they revert |
| `senshi` | senshi.to | nothing | search + episodes from senshi.to, streams from the anidap source layer (nero / yuki / zuna / loli) with per-server referers, sub + dub, intro/outro chapters |
| `anizone` | anizone.to | flaresolverr (fallback) | livewire site, search + episode pages are scraped direct and only fall back to a browser when cloudflare challenges you. open cdn, no referer needed |
| `nexus` | anime.nexus | go proxy | api.anime.nexus blocks datacenter ips, falls back to flaresolverr for the api calls. the stream itself is ip-bound |
| `animeonsen` | animeonsen.xyz | flaresolverr (fallback) | direct cookie flow first (ao.session → jwt), flaresolverr only if cloudflare blocks you. returns DASH (.mpd), needs dash.js |
| `mmani` | mmani.com | flaresolverr | their ajax api fingerprints tls and 403s server-side clients, so the three json calls (search / episodes / eplink) go through a real browser. the final hls url is built from the player id + base64 of the video id |
| `xanime` | xanime.me | flaresolverr (partial) | ssr gives the latest episode free, older episodes need a rendered page |
| `anihq` | anihq.cc | flaresolverr | wordpress + kiranime, voe embeds unpacked client-side style |

## quick start

```bash
npm install
npm start          # :3000
```

that's it for anikoto, animeparadise, aniwaves and reanime. the rest
need one or both of the helpers below. copy `.env.example` to `.env` and fill
in what you use.

## how the routing works

every provider is keyed by **anilist id**. that's the whole slug system:

```
/watch/anikoto/21/1        anilist 21 (one piece), episode 1
/watch/anikoto/21/1?type=dub
/watch/anikoto/21/1?title=one+piece
```

- the api maps anilist id → title → the provider's own internal id
  (site slug, ani.pm id, uuid, whatever that site uses). you never see that
  step, it's cached internally per provider:
  - anikoto: title search → site slug → show id → episode servers
  - mmani: ajax episodes keyed by anilist id directly → episode link token → eplink → player url → base64 hls url
  - nexus: catalog crawl → series uuid → episode uuid → stream
  - gotaku: browse crawl with early exit once the requested show is mapped (24h cache)
  - anizone: rendered search page → random slug → episode page → vidstack player config
  - reanime: nothing to map, their api takes anilist ids directly
- `?title=` skips the anilist lookup entirely (useful if you already know
  the title, saves a round trip)
- `?type=sub` or `?type=dub` filters the server list
- episode numbers are plain integers, 1-based

### all routes

```
GET /health
GET /providers                            capability list, used by the landing page
GET /map/:anilistId                       ani.zip mappings (mal, tmdb, tvdb, titles, episodes)
GET /:provider/search?q=
GET /:provider/episodes/:anilistId        anikoto, senshi, mmani, animeonsen
GET /anikoto/recent?page=&per_page=
GET /watch/:provider/:anilistId/:episode   ?type=sub|dub  ?title=
```

### /watch response

```json
{
  "provider": "mmani",
  "anilistId": 21,
  "episode": 1,
  "intro": null,
  "outro": null,
  "servers": [
    {
      "name": "MMani Sub",
      "type": "sub",
      "quality": "BD",
      "url": "https://play.anien.top/hls/mmani2/....m3u8",
      "embed": "",
      "referer": "https://mmani.com/up/",
      "subtitles": [{ "url": "https://...", "lang": "en", "label": "English" }]
    }
  ]
}
```

server fields:

| field | what |
|---|---|
| `url` | direct m3u8 (or mpd for animeonsen). null when only `embed` is set |
| `embed` | iframe page that decrypts itself in a browser (flixcloud, megaplay) |
| `referer` | send this as `Referer` when fetching the manifest/segments |
| `subtitles` | vtt/srt tracks, usually need the same referer as the video |
| `fileId` | anikoto megaplay only, see below |

## playing the streams

### hls (most providers)

[hls.js](https://github.com/video-dev/hls.js) plays every `url` that ends
in `.m3u8`:

```html
<video id="v" controls></video>
<script src="https://cdn.jsdelivr.net/npm/hls.js@1"></script>
<script>
  const src = "/watch/mmani/21/1";          // your whoapi
  fetch(src).then(r => r.json()).then(({ servers }) => {
    const s = servers[0];
    const hls = Hls.isSupported() ? new Hls({ xhrSetup: (x) => {
      if (s.referer) x.setRequestHeader("Referer", s.referer);
    }}) : null;
    if (hls) {
      hls.loadSource(s.url);
      hls.attachMedia(document.getElementById("v"));
    } else {
      document.getElementById("v").src = s.url;   // safari
    }
  });
</script>
```

setting `Referer` from a browser is not possible on a normal page, that's
what the go proxy is for (next section). native apps / server-side players
can just send the header.

### dash (animeonsen)

animeonsen returns a `.mpd`, not an m3u8. use
[dash.js](https://github.com/Dash-Industry-Forum/dash.js) the same way:
`dashjs.MediaPlayer().create().initialize(videoEl, s.url, true)`.

### megaplay fileId (anikoto)

some megaplay servers come back with `url: null` and a `fileId`. the cdn
blocks datacenter ips, so the final url has to be fetched from the viewer's
browser:

```
GET https://megaplay.buzz/stream/getSources?id=<fileId>
```

the response has `sources.file` (plain m3u8) or `sources.enc`
(aes-256-cbc, key + iv are in megaplay's own js bundle). decrypt client
side, play the result. when our server *can* reach the cdn you just get a
ready `url` and can ignore all this.

### wrapping through the go proxy

any stream that 403s (wrong tls fingerprint, missing referer, cf challenge)
goes through the bundled proxy. it takes the upstream url as base64url:

```bash
cd go-proxy
go run main.go                     # :8096

# wrap a manifest
URL=$(printf 'https://example.com/master.m3u8' | basenc --base64url | tr -d '=')
curl "http://localhost:8096/proxy?url=$URL"
```

the proxy picks the right referer per host from its internal table
(30+ cdns), rewrites child manifests + segment urls, follows variants,
handles the senshi aes format and prefetches the next segments. point your
player at `http://localhost:8096/proxy?url=...` instead of the raw url and
it just works. on 403 it retries through the system curl build.

which providers benefit:

| provider | proxy needed? |
|---|---|
| anikoto / animeparadise / aniwaves | no, direct urls work |
| anizone | no, the vid-cdn hosts are open |
| senshi | optional, nero + loli play direct, the go proxy adds the right referer per host automatically |
| reanime | yes, flixcloud is ip-bound (the token carries your ip) and the playlist body may be encrypted upstream |
| nexus | yes, same reason |
| mmani | optional, helps when anien.top is picky about referer |
| anipm | no, the sidecar rewrites its own manifests |

## flaresolverr

gotaku and anihq only work behind a real browser (cloudflare + js-rendered
pages). anizone, nexus, mmani and animeonsen use it as a fallback when the
direct request gets challenged. run it anywhere and set the url:

```bash
docker run -d --name flaresolverr -p 8191:8191 ghcr.io/flaresolverr/flaresolverr:latest
echo "FLARESOLVERR_URL=http://127.0.0.1:8191" >> .env
```

without it those providers return empty results, the api itself keeps
running. expect the first gotaku resolve to take a minute (it crawls and
builds the slug map), everything after that is cached. go easy on it:
flaresolverr processes one page at a time and hammering it is how you get
your server ip temp-banned by cloudflare in the first place.

## anipm sidecar

ani.pm streams go through settlar, which sits behind cloudflare and blocks
non-browser tls. that part is python because of curl_cffi:

```bash
cd anipm-proxy
python3 -m venv venv
venv/bin/pip install -r requirements.txt
ANIPM_PUBLIC_BASE=http://your-public-host:8095 venv/bin/python app.py   # :8095
```

`ANIPM_PUBLIC_BASE` is the base url written into the rewritten manifests, so
it must be reachable from the *player*, not just from the api. then set
`ANIPM_PROXY_URL=http://127.0.0.1:8095` for the api and `/watch/anipm/...`
comes alive.

## env

| var | default | what |
|---|---|---|
| `PORT` | `3000` | api port |
| `FLARESOLVERR_URL` | empty | flaresolverr base, enables gotaku / anizone / anihq |
| `NEXUS_API` | `https://api.anime.nexus` | override if the host blocks your ip |
| `ANIPM_PROXY_URL` | `http://127.0.0.1:8095` | where the anipm sidecar runs |
| `ANIPM_PUBLIC_BASE` | `http://127.0.0.1:8095` | base url used inside rewritten anipm manifests |
| `GO_PROXY_URL` | empty | reserved for wrapping stream urls server side |

## notes

- anikotoapi.site rate limits at 60 req / 120s per ip, the provider paces itself.
- provider sites change. when something 404s check the site first, not the api.
- senshi's stream layer comes from the anidap api (`anidap.lol/api/anime/{anilistId}`
  for the slug, `chad.anidap.lol/rest/api/sources` for the m3u8). their provider
  roster rotates, the code reads whatever /servers returns, so new names work
  without a code change.
- reanime decrypt is self-healing: the wasm blob comes out of the embed page
  itself (`w_payload`), so when flixcloud rotates their crypto the provider
  picks up the new payload on the next resolve.
- nexus and animeonsen are ip-sensitive. same code, different result per network.
- this is for personal/self-educational use, you are responsible for what you do with it.
