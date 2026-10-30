# whoapi

one api in front of the providers we scrape. anilist id in, streams out.
plain node, no database, no auth, no queue. node 18+.

## providers

| id | site | needs | notes |
|---|---|---|---|
| `anikoto` | anikototv.to | nothing | megaplay + raw servers, sub + dub, search / episodes / recent |
| `animeparadise` | animeparadise.moe | nothing | json api + next server action |
| `aniwaves` | aniwaves.ru | nothing | echovideo extraction, hardsub/softsub/dub |
| `anipm` | ani.pm | python sidecar | settlar cdn sits behind cloudflare, curl_cffi handles it |
| `gotaku` | gotaku.to | flaresolverr | SPA site, everything runs through a real browser. first call builds a slug map (slow), then cached 24h |
| `reanime` | reanime.to | nothing | public api keyed by anilist id. returns flixcloud embeds, the browser decrypts them |
| `senshi` | senshi.to | go proxy | senshi.to api is open, the cdn (bcdn2.se) 403s non-browser ips, the proxy handles it |
| `anizone` | anizone.to | flaresolverr | livewire spa behind cloudflare, random slugs, search + episode page both rendered |
| `nexus` | anime.nexus | go proxy | api.anime.nexus blocks datacenter ips. residential ip or the proxy usually works |
| `animeonsen` | animeonsen.xyz | flaresolverr (fallback) | direct cookie flow first, flaresolverr only if cloudflare blocks you. returns DASH (.mpd), needs dash.js |
| `mmani` | mmani.com | nothing | bd/uncensored source. their json api moved recently, this one returns empty until reworked against the new template |
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
  - mmani: title search → postid → episode api → player config
  - nexus: catalog crawl → series uuid → episode uuid → stream
  - gotaku: browse crawl → slug ↔ anilist map (24h cache)
  - anizone: rendered search → random slug → episode page
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

setting `Referer` from a browser is not possible on a normal page — that's
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
| mmani | optional, helps when anien.top is picky about referer |
| senshi | yes, the cdn 403s everyone else |
| nexus | yes, same reason |
| reanime / anikoto embeds | no, those play in the browser |
| anipm | no, the sidecar rewrites its own manifests |

## flaresolverr

gotaku, anizone and anihq only work behind a real browser (cloudflare +
js-rendered pages). xanime and animeonsen use it as a fallback. run it
anywhere and set the url:

```bash
docker run -d --name flaresolverr -p 8191:8191 ghcr.io/flaresolverr/flaresolverr:latest
echo "FLARESOLVERR_URL=http://127.0.0.1:8191" >> .env
```

without it those providers return empty results, the api itself keeps
running. expect the first gotaku resolve to take a minute (it crawls and
builds the slug map), everything after that is cached.

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
  mmani is the current example: they rebuilt the site on a js template and the
  old json api this provider used is gone.
- nexus and senshi are ip-sensitive. same code, different result per network.
- reanime's api is behind cloudflare and rejects some datacenter ips. if your
  server gets 403 from it, the same request from a browser or residential ip works.
- this is for personal/self-educational use, you are responsible for what you do with it.
