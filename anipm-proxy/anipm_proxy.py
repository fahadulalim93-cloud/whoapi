#!/usr/bin/env python3
import os, sys, json, re, time, base64, logging, subprocess, hashlib, threading, queue
from urllib.parse import quote, urljoin
import requests
from curl_cffi import requests as cffi
from flask import Blueprint, request, jsonify, Response, send_file

ANIPM_BASE = "https://ani.pm"
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
PUBLIC_BASE = os.environ.get("ANIPM_PUBLIC_BASE", "http://127.0.0.1:8095")

SESSION_POOL_MAX = 12
_session_pool = queue.LifoQueue()
_session_pool_lock = threading.Lock()
_session_count = 0

def _borrow_session():
    global _session_count
    try:
        return _session_pool.get_nowait()
    except queue.Empty:
        with _session_pool_lock:
            _session_count += 1
        try:
            return cffi.Session(impersonate="chrome124")
        except Exception:
            return None

def _return_session(s):
    if s is None: return
    if _session_pool.qsize() < SESSION_POOL_MAX:
        _session_pool.put(s)
    else:
        try: s.close()
        except Exception: pass

SEG_CACHE_DIR = os.environ.get("ANIPM_SEG_CACHE", "/tmp/anipm-seg-cache")
SEG_CACHE_MAX_BYTES = 2 * 1024 * 1024 * 1024
os.makedirs(SEG_CACHE_DIR, exist_ok=True)

def _cache_path(url: str) -> str:
    return os.path.join(SEG_CACHE_DIR, hashlib.sha1(url.encode()).hexdigest() + ".bin")

def _cache_meta_path(url: str) -> str:
    return _cache_path(url) + ".meta"

def _cache_get(url: str):
    try:
        p = _cache_path(url)
        if not os.path.exists(p): return None
        with open(p, "rb") as f:
            data = f.read()
        ct = "video/MP2T"
        mp = _cache_meta_path(url)
        if os.path.exists(mp):
            with open(mp, "r") as f:
                ct = f.read().strip() or ct
        return data, ct
    except Exception:
        return None

def _cache_put(url: str, data: bytes, content_type: str):
    try:
        with open(_cache_path(url), "wb") as f:
            f.write(data)
        with open(_cache_meta_path(url), "w") as f:
            f.write(content_type or "video/MP2T")
        _evict_if_needed()
    except Exception:
        pass

def _evict_if_needed():
    try:
        files = []
        total = 0
        for name in os.listdir(SEG_CACHE_DIR):
            if name.endswith(".meta"): continue
            p = os.path.join(SEG_CACHE_DIR, name)
            try:
                st = os.stat(p)
                files.append((st.st_mtime, p, st.st_size))
                total += st.st_size
            except OSError:
                continue
        if total <= SEG_CACHE_MAX_BYTES:
            return
        files.sort()
        for mtime, p, size in files:
            if total <= SEG_CACHE_MAX_BYTES: break
            try:
                os.remove(p)
                meta = p + ".meta"
                if os.path.exists(meta): os.remove(meta)
                total -= size
            except OSError:
                continue
    except Exception:
        pass

_resolve_cache = {}
_manifest_cache = {}
_key_cache = {}
CACHE_TTL = 120
KEY_CACHE_TTL = 86400

log = logging.getLogger("anipm-proxy")
anipm_bp = Blueprint("anipm_proxy", __name__, url_prefix="/api/anipm-proxy")


def cffi_fetch(url, referer="https://embed.settlar.io/", max_time=15):
    sess = _borrow_session()
    if sess is None:
        try:
            return cffi.get(url, impersonate="chrome124", headers={
                "Referer": referer, "Accept": "*/*",
            }, timeout=max_time)
        except Exception as e:
            log.warning(f"cffi_fetch failed for {url[:80]}: {e}")
            return None
    try:
        r = sess.get(url, headers={"Referer": referer, "Accept": "*/*"}, timeout=max_time)
        _return_session(sess)
        return r
    except Exception as e:
        try: sess.close()
        except Exception: pass
        log.warning(f"cffi_fetch(pool) failed for {url[:80]}: {e}")
        try:
            return cffi.get(url, impersonate="chrome124", headers={
                "Referer": referer, "Accept": "*/*",
            }, timeout=max_time)
        except Exception:
            return None


def search_anipm(title):
    try:
        r = requests.get(f"{ANIPM_BASE}/api/anime/search?q={quote(title)}",
                         headers={"User-Agent": UA, "Accept": "application/json"}, timeout=10)
        if not r.ok: return None
        items = r.json().get("items", [])
        if not items: return None
        title_lower = title.lower()
        for item in items:
            if item.get("title", "").lower() == title_lower: return item
        for item in items:
            t = item.get("title", "").lower()
            if title_lower in t or t in title_lower: return item
        return items[0]
    except Exception as e:
        log.error(f"search_anipm: {e}")
        return None


def resolve_anipm(anilist_id, episode, title):
    cache_key = f"{anilist_id}_{episode}"
    if cache_key in _resolve_cache:
        cached = _resolve_cache[cache_key]
        if time.time() - cached["timestamp"] < CACHE_TTL:
            return cached["servers"]

    search_result = search_anipm(title)
    if not search_result: return []
    anipm_id = search_result["id"]
    log.info(f"Found: {search_result.get('title','')[:40]} → anipm_id={anipm_id}")

    servers = []
    for lang in ["sub", "dub"]:
        try:
            r = requests.get(f"{ANIPM_BASE}/api/anime/playback-bootstrap/settlar/{anipm_id}?ep={episode}&lang={lang}",
                             headers={"User-Agent": UA, "Referer": f"{ANIPM_BASE}/"}, timeout=15)
            if not r.ok: continue
            bootstrap = r.json()
            selection = bootstrap.get("settlarSelection")
            if not selection: continue
            avail = bootstrap.get("availability", {})
            if not avail.get(lang): continue

            skip = bootstrap.get("skip", {})
            intro = {"start": skip.get("op", {}).get("start"), "end": skip.get("op", {}).get("end")} if skip.get("op") else None
            outro = {"start": skip.get("ed", {}).get("start"), "end": skip.get("ed", {}).get("end")} if skip.get("ed") else None

            r = requests.get(f"{ANIPM_BASE}/api/anime/settlar/preview-session",
                             params={"selection": selection, "provider": "anipm", "ep": str(episode), "channel": lang},
                             headers={"User-Agent": UA, "Referer": f"{ANIPM_BASE}/"}, timeout=15)
            if not r.ok: continue
            embed_url = r.json().get("embedUrl")
            if not embed_url: continue

            token_match = re.search(r"[?&]t=([^&]+)", embed_url)
            if not token_match: continue
            token = token_match.group(1)
            session_url = f"https://embed.settlar.io/api/embed/session?t={token}"
            resp = cffi_fetch(session_url, "https://embed.settlar.io/", 15)
            if not resp or resp.status_code != 200: continue
            session_data = resp.json()
            m3u8_url = session_data.get("source", "")
            if not m3u8_url: continue

            subtitle_tracks = []
            for sub in session_data.get("subtitles", []):
                sub_url = sub.get("url", "")
                if sub_url:
                    subtitle_tracks.append({"url": sub_url, "lang": sub.get("srclang", "en"), "label": sub.get("label", "English")})

            servers.append({
                "name": f"Ani.pm {'Dub' if lang == 'dub' else 'Sub'}",
                "m3u8Url": m3u8_url,
                "embedUrl": embed_url,
                "type": "dub" if lang == "dub" else "sub",
                "quality": "1080p",
                "subtitleTracks": subtitle_tracks,
                "intro": intro,
                "outro": outro,
            })
            log.info(f"  {lang}: m3u8={m3u8_url[:60]}... subs={len(subtitle_tracks)}")
        except Exception as e:
            log.warning(f"  {lang} failed: {e}")

    if servers:
        _resolve_cache[cache_key] = {"servers": servers, "timestamp": time.time()}
    return servers


def b64_url(url):
    return base64.urlsafe_b64encode(url.encode()).decode().rstrip("=")


def rewrite_m3u8(content, base_url):
    text = content.decode("utf-8", errors="replace") if isinstance(content, bytes) else content
    lines = text.split("\n")
    out = []
    for raw in lines:
        line = raw.strip()
        if not line:
            out.append("")
            continue
        if line.startswith("#"):
            if "#EXT-X-KEY" in line or "#EXT-X-MEDIA" in line:
                def repl_uri(m):
                    url = m.group(1)
                    if url.startswith("http"):
                        return f'URI="{PUBLIC_BASE}/api/anipm-proxy/key?url={b64_url(url)}"'
                    abs_url = urljoin(base_url, url)
                    return f'URI="{PUBLIC_BASE}/api/anipm-proxy/key?url={b64_url(abs_url)}"'
                line = re.sub(r'URI="([^"]+)"', repl_uri, line)
            out.append(line)
            continue
        if line.startswith("http"):
            out.append(f"{PUBLIC_BASE}/api/anipm-proxy/segment?url={b64_url(line)}")
        elif line.startswith("/"):
            abs_url = urljoin(base_url, line)
            out.append(f"{PUBLIC_BASE}/api/anipm-proxy/segment?url={b64_url(abs_url)}")
        else:
            abs_url = urljoin(base_url, line)
            out.append(f"{PUBLIC_BASE}/api/anipm-proxy/segment?url={b64_url(abs_url)}")
    return "\n".join(out)


@anipm_bp.route("/manifest")
def proxy_manifest():
    anilist_id = request.args.get("anilist_id", "")
    episode = request.args.get("episode", "1")
    title = request.args.get("title", "")
    lang = request.args.get("lang", "sub")
    if not title:
        return Response("missing title", status=400, headers={"Access-Control-Allow-Origin": "*"})

    cache_key = f"{anilist_id}_{episode}_{lang}"
    cached = _manifest_cache.get(cache_key)
    if cached and time.time() - cached["timestamp"] < CACHE_TTL:
        return Response(cached["content"], mimetype="application/vnd.apple.mpegurl",
                        headers={"Access-Control-Allow-Origin": "*", "Cache-Control": "public, max-age=60"})

    try:
        servers = resolve_anipm(anilist_id, episode, title)
        server = next((s for s in servers if s["type"] == lang), servers[0] if servers else None)
        if not server:
            return Response("no servers", status=502, headers={"Access-Control-Allow-Origin": "*"})

        m3u8_url = server["m3u8Url"]
        resp = cffi_fetch(m3u8_url, "https://embed.settlar.io/", 15)
        if not resp or resp.status_code != 200:
            return Response(f"m3u8 fetch failed: {resp.status_code if resp else 'no response'}", status=502,
                            headers={"Access-Control-Allow-Origin": "*"})

        rewritten = rewrite_m3u8(resp.text, m3u8_url)
        _manifest_cache[cache_key] = {"content": rewritten, "timestamp": time.time()}
        return Response(rewritten, mimetype="application/vnd.apple.mpegurl",
                        headers={"Access-Control-Allow-Origin": "*", "Cache-Control": "public, max-age=60"})
    except Exception as e:
        return Response(f"error: {e}", status=502, headers={"Access-Control-Allow-Origin": "*"})


def _decode_b64_url(b64):
    if not b64: return None
    padding = 4 - (len(b64) % 4)
    if padding != 4: b64 += "=" * padding
    try: return base64.urlsafe_b64decode(b64).decode("utf-8", errors="replace")
    except: return None


@anipm_bp.route("/segment")
def proxy_segment():
    url = _decode_b64_url(request.args.get("url", ""))
    if not url or not url.startswith("http"):
        return Response("invalid url", status=400, headers={"Access-Control-Allow-Origin": "*"})

    cached = _cache_get(url)
    if cached is not None:
        data, ct = cached
        if ct == "application/vnd.apple.mpegurl" or (data[:7] == b"#EXTM3U"):
            return Response(data, mimetype="application/vnd.apple.mpegurl",
                            headers={"Access-Control-Allow-Origin": "*", "Cache-Control": "public, max-age=60"})
        return Response(data, mimetype="video/MP2T",
                        headers={"Access-Control-Allow-Origin": "*", "Cache-Control": "public, max-age=86400, immutable", "Accept-Ranges": "bytes"})

    range_header = request.headers.get("Range")
    try:
        sess = _borrow_session()
        if sess is None:
            r = cffi.get(url, impersonate="chrome124", headers={
                "Referer": "https://embed.settlar.io/", "Accept": "*/*",
                **({"Range": range_header} if range_header else {}),
            }, timeout=30)
        else:
            r = sess.get(url, headers={
                "Referer": "https://embed.settlar.io/", "Accept": "*/*",
                **({"Range": range_header} if range_header else {}),
            }, timeout=30)
            _return_session(sess)

        if r.status_code not in (200, 206):
            return Response(f"upstream {r.status_code}", status=r.status_code, headers={"Access-Control-Allow-Origin": "*"})

        content_type = r.headers.get("content-type", "").lower()
        body_text = r.text[:7] if hasattr(r, "text") else ""
        if "mpegurl" in content_type or body_text == "#EXTM3U":
            rewritten = rewrite_m3u8(r.text, url)
            _cache_put(url, rewritten.encode(), "application/vnd.apple.mpegurl")
            return Response(rewritten, mimetype="application/vnd.apple.mpegurl",
                            headers={"Access-Control-Allow-Origin": "*", "Cache-Control": "public, max-age=60"})

        if r.status_code == 200 and len(r.content) < 32 * 1024 * 1024:
            _cache_put(url, r.content, "video/MP2T")
        return Response(r.content, mimetype="video/MP2T",
                        headers={"Access-Control-Allow-Origin": "*", "Cache-Control": "public, max-age=86400, immutable", "Accept-Ranges": "bytes"})
    except Exception as e:
        return Response(f"fetch failed: {e}", status=502, headers={"Access-Control-Allow-Origin": "*"})


@anipm_bp.route("/key")
def proxy_key():
    url = _decode_b64_url(request.args.get("url", ""))
    if not url or not url.startswith("http"):
        return Response("invalid url", status=400, headers={"Access-Control-Allow-Origin": "*"})

    cached = _key_cache.get(url)
    if cached and time.time() - cached["timestamp"] < KEY_CACHE_TTL:
        ct = cached.get("ct", "application/octet-stream")
        return Response(cached["content"], mimetype=ct,
                        headers={"Access-Control-Allow-Origin": "*", "Cache-Control": "public, max-age=86400"})
    try:
        r = cffi_fetch(url, "https://embed.settlar.io/", 15)
        if not r or r.status_code != 200:
            code = r.status_code if r else 502
            return Response(f"upstream {code}", status=code, headers={"Access-Control-Allow-Origin": "*"})
        ct = r.headers.get("content-type", "application/octet-stream")
        if "vtt" in url or "srt" in url or "text" in ct:
            ct = "text/vtt"
        _key_cache[url] = {"content": r.content, "ct": ct, "timestamp": time.time()}
        return Response(r.content, mimetype=ct,
                        headers={"Access-Control-Allow-Origin": "*", "Cache-Control": "public, max-age=86400"})
    except Exception as e:
        return Response(f"fetch failed: {e}", status=502, headers={"Access-Control-Allow-Origin": "*"})


@anipm_bp.route("/resolve")
def proxy_resolve():
    anilist_id = request.args.get("anilist_id", "")
    episode = request.args.get("episode", "1")
    title = request.args.get("title", "")
    if not title:
        return jsonify({"error": "missing title", "servers": []}), 400
    try:
        servers = resolve_anipm(anilist_id, episode, title)
        for s in servers:
            s["manifestUrl"] = f"{PUBLIC_BASE}/api/anipm-proxy/manifest?anilist_id={anilist_id}&episode={episode}&title={quote(title)}&lang={s['type']}"
        return jsonify({"anilist_id": anilist_id, "episode": episode, "servers": servers, "total": len(servers)})
    except Exception as e:
        return jsonify({"error": str(e), "servers": []}), 500


@anipm_bp.route("/health")
def proxy_health():
    return jsonify({
        "ok": True,
        "service": "anipm-proxy",
        "curl_cffi": "chrome124",
        "pooled_sessions": _session_pool.qsize(),
        "cache_size": len(_resolve_cache),
        "seg_cache_dir": SEG_CACHE_DIR,
        "seg_cache_files": len(os.listdir(SEG_CACHE_DIR)) if os.path.isdir(SEG_CACHE_DIR) else 0,
    })
