package main

import (
        "bytes"
        "crypto/aes"
        "crypto/cipher"
        "crypto/tls"
        "encoding/base64"
        "encoding/json"
        "fmt"
        "io"
        "net/http"
        "net/url"
        "os"
        "os/exec"
        "regexp"
        "strings"
        "sync"
        "time"
)

const (
        XORKey          = "10b06cdc1ca48c9fb0b94af97cc040cf"
        CacheMaxEntries = 500
        CacheTTL        = 30 * time.Minute
)

var port = getEnv("PORT", "8096")

var senshiAESKey []byte

func init() {
        cr := []byte{140, 250, 231, 59, 141, 129, 254, 6, 30, 203, 96, 249, 13, 237, 122, 106,
                60, 57, 126, 48, 152, 101, 128, 186, 122, 88, 171, 249, 187, 202, 40, 220}
        lr := []byte{108, 184, 157, 168, 18, 90, 64, 186, 69, 66, 110, 109, 169, 203, 138, 29,
                188, 78, 25, 203, 185, 211, 252, 76, 126, 134, 42}
        senshiAESKey = make([]byte, 32)
        for i := 0; i < 32; i++ {
                senshiAESKey[i] = cr[i]
                if i < len(lr) {
                        senshiAESKey[i] ^= lr[i]
                }
        }
}

func xorEncode(str string) string {
        key := []byte(XORKey)
        data := []byte(str)
        xored := make([]byte, len(data))
        for i := 0; i < len(data); i++ {
                xored[i] = data[i] ^ key[i%len(key)]
        }
        return base64.RawURLEncoding.EncodeToString(xored)
}

func xorDecode(token string) (string, string, bool) {
        raw, err := base64.RawURLEncoding.DecodeString(token)
        if err != nil {
                padded := token
                if mod := len(token) % 4; mod != 0 {
                        padded += strings.Repeat("=", 4-mod)
                }
                padded = strings.ReplaceAll(padded, "-", "+")
                padded = strings.ReplaceAll(padded, "_", "/")
                raw, err = base64.StdEncoding.DecodeString(padded)
                if err != nil {
                        return "", "", false
                }
        }
        key := []byte(XORKey)
        decoded := make([]byte, len(raw))
        for i := 0; i < len(raw); i++ {
                decoded[i] = raw[i] ^ key[i%len(key)]
        }
        text := string(decoded)
        idx := strings.IndexByte(text, 0)
        if idx == -1 {
                return text, "", true
        }
        return text[:idx], text[idx+1:], true
}

var bufPool = sync.Pool{
        New: func() interface{} {
                return bytes.NewBuffer(make([]byte, 0, 256*1024))
        },
}

type CdnRule struct {
        pattern *regexp.Regexp
        referer string
        origin  string
}

var cdnRules []CdnRule

func init() {
        rules := []struct {
                regex   string
                referer string
                origin  string
        }{
                {`^settlar\.io$`, "https://embed.settlar.io/", "https://embed.settlar.io"},
                {`^media\.settlar\.io$`, "https://embed.settlar.io/", "https://embed.settlar.io"},
                {`^embed\.settlar\.io$`, "https://embed.settlar.io/", "https://embed.settlar.io"},
                {`^play2\.echovideo\.ru$`, "https://play2.echovideo.ru/", "https://play2.echovideo.ru"},
                {`^echovideo\.ru$`, "https://play2.echovideo.ru/", "https://play2.echovideo.ru"},
                {`^echovideo\.to$`, "https://play2.echovideo.ru/", "https://play2.echovideo.ru"},
                {`\.dpopdrop89\.store$`, "https://play2.echovideo.ru/", "https://play2.echovideo.ru"},
                {`^imgcdn\d+\.dpopdrop\d+\.store$`, "https://play2.echovideo.ru/", "https://play2.echovideo.ru"},
                {`\.flixcloud\.cc$`, "https://flixcloud.cc/", "https://flixcloud.cc"},
                {`\.24stream\.xyz$`, "https://animex.one/", "https://animex.one"},
                {`\.anidb\.app$`, "https://www.miruro.tv/", "https://www.miruro.tv"},
                {`\.nekostream\.site$`, "https://www.miruro.tv/", "https://www.miruro.tv"},
                {`^vault\d+\.(owocdn|uwucdn)\.top$`, "https://kwik.cx/", "https://kwik.cx"},
                {`^[a-z]{2}-\d+\.(owocdn|uwucdn)\.top$`, "https://kwik.cx/", "https://kwik.cx"},
                {`^(kwik\.cx|kwik\.si)$`, "https://kwik.cx/", "https://kwik.cx"},
                {`\.megaplay\.buzz$`, "https://megaplay.buzz/", "https://megaplay.buzz"},
                {`\.(streamzone1\.site|mewstream\.buzz|cinewave2\.site)$`, "https://megaplay.buzz/", "https://megaplay.buzz"},
                {`\.megap\.norami\.top$`, "https://megaplay.buzz/", "https://megaplay.buzz"},
                {`\.krussdomi\.com$`, "https://krussdomi.com/", "https://krussdomi.com"},
                {`^(vibeplayer|vivibebe)\.site$`, "https://vibeplayer.site/", "https://vibeplayer.site"},
                {`\.animeapps\.top$`, "https://playeng.animeapps.top/", "https://playeng.animeapps.top"},
                {`\.anien\.top$`, "https://mmani.com/up/", "https://mmani.com"},
                {`\.bigdreamsmalldih\.site$`, "https://kwik.cx/", "https://kwik.cx"},
                {`\.anikage\.cc$`, "https://anikage.cc/", "https://anikage.cc"},
                {`^(allanime\.uns\.bio|.*\.allanime\.uns\.bio)$`, "https://allanime.uns.bio/", "https://allanime.uns.bio"},
                {`\.harmonixwellnessgroup\.store$`, "https://allanime.uns.bio/", "https://allanime.uns.bio"},
                {`\.animeverse\.to$`, "https://animeverse.to/", "https://animeverse.to"},
                {`\.animeonsen\.xyz$`, "https://www.animeonsen.xyz/", "https://www.animeonsen.xyz"},
                {`\.clvd\.xyz$`, "https://kem.clvd.xyz/", "https://kem.clvd.xyz"},
                {`^(ani\.pm|.*\.ani\.pm)$`, "https://ani.pm/", "https://ani.pm"},
                {`^(kyren\.moe|.*\.kyren\.moe)$`, "https://kyren.moe/", "https://kyren.moe"},
                {`\.anilight\.live$`, "https://anilight.live/", "https://anilight.live"},
                {`\.anistream\.one$`, "https://anistream.one/", "https://anistream.one"},
                {`\.anikuro\.ru$`, "https://anikuro.ru/", "https://anikuro.ru"},
                {`^(swiftstream\.top|.*\.swiftstream\.top)$`, "https://animetsu.live/", "https://animetsu.live"},
                {`\.animeheaven\.me$`, "https://animeheaven.me/", "https://animeheaven.me"},
                {`^(anixtv\.in|.*\.anixtv\.in)$`, "https://anixtv.in/", "https://anixtv.in"},
                                {`^s-\d+\.bdcdn\d*\.se$`, "https://senshi.to/", "https://senshi.to"},
                {`^s-\d+\.bcdn\d*\.se$`, "https://senshi.to/", "https://senshi.to"},
                {`\.(bdcdn1|bdcdn2|bcdn1|bcdn2)\.se$`, "https://senshi.to/", "https://senshi.to"},
                {`\.(anicdn)\.se$`, "https://senshi.to/", "https://senshi.to"},
                {`\.(hiasian)\.to$`, "https://kototv.to/", "https://kototv.to"},
                {`\.ninstream\.com$`, "https://senshi.live/", "https://senshi.live"},
                {`\.premilkyway\.com$`, "https://megaplay.buzz/", "https://megaplay.buzz"},
                {`\.dramiyos-cdn\.com$`, "https://megaplay.buzz/", "https://megaplay.buzz"},
                {`\.acek-cdn\.com$`, "https://megaplay.buzz/", "https://megaplay.buzz"},
                {`\.xanivsrc\d*\.org$`, "https://xanime.me/", "https://xanime.me"},
                {`^192\.151\.150\.146$`, "", ""},
                {`^localhost$`, "", ""},
                {`.*`, "https://megaplay.buzz/", "https://megaplay.buzz"},
        }
        for _, r := range rules {
                cdnRules = append(cdnRules, CdnRule{
                        pattern: regexp.MustCompile(r.regex),
                        referer: r.referer,
                        origin:  r.origin,
                })
        }
}

func findRule(hostname string) CdnRule {
        for _, rule := range cdnRules {
                if rule.pattern.MatchString(strings.ToLower(hostname)) {
                        return rule
                }
        }
        return cdnRules[len(cdnRules)-1]
}

func isSenshiCdn(host string) bool {
        return strings.HasSuffix(host, ".bdcdn1.se") ||
                strings.HasSuffix(host, ".bdcdn2.se") ||
                strings.HasSuffix(host, ".bcdn1.se") ||
                strings.HasSuffix(host, ".bcdn2.se") ||
                strings.HasSuffix(host, ".anicdn.se") ||
                regexp.MustCompile(`^s-\d+\.bdcdn\d*\.se$`).MatchString(host) ||
                regexp.MustCompile(`^s-\d+\.bcdn\d*\.se$`).MatchString(host)
}


type CacheEntry struct {
        body        []byte
        contentType string
        ts          time.Time
}

type InFlightEntry struct {
        done   chan struct{}
        result *CacheEntry
        err    error
}

var (
        cacheMu       sync.RWMutex
        cacheMap      = make(map[string]*CacheEntry, CacheMaxEntries)
        cacheOrder    []string
        inflightMu    sync.Mutex
        inflightMap   = make(map[string]*InFlightEntry)
)

func getCached(key string) (*CacheEntry, bool) {
        cacheMu.RLock()
        entry, ok := cacheMap[key]
        cacheMu.RUnlock()
        if !ok {
                return nil, false
        }
        if time.Since(entry.ts) > CacheTTL {
                cacheMu.Lock()
                delete(cacheMap, key)
                cacheMu.Unlock()
                return nil, false
        }
        cacheMu.Lock()
        for i, k := range cacheOrder {
                if k == key {
                        cacheOrder = append(cacheOrder[:i], cacheOrder[i+1:]...)
                        cacheOrder = append(cacheOrder, key)
                        break
                }
        }
        cacheMu.Unlock()
        return entry, true
}

func setCached(key string, body []byte, contentType string) {
        cacheMu.Lock()
        defer cacheMu.Unlock()
        for len(cacheMap) >= CacheMaxEntries && len(cacheOrder) > 0 {
                oldest := cacheOrder[0]
                delete(cacheMap, oldest)
                cacheOrder = cacheOrder[1:]
        }
        cacheMap[key] = &CacheEntry{body: body, contentType: contentType, ts: time.Now()}
        cacheOrder = append(cacheOrder, key)
}

func fetchWithSingleFlight(key string, fetchFn func() ([]byte, string, error)) (*CacheEntry, error) {
        if cached, ok := getCached(key); ok {
                return cached, nil
        }

        inflightMu.Lock()
        if existing, ok := inflightMap[key]; ok {
                inflightMu.Unlock()
                <-existing.done
                if existing.err != nil {
                        return nil, existing.err
                }
                return existing.result, nil
        }

        entry := &InFlightEntry{done: make(chan struct{})}
        inflightMap[key] = entry
        inflightMu.Unlock()

        body, contentType, err := fetchFn()
        if err != nil {
                entry.err = err
        } else {
                entry.result = &CacheEntry{body: body, contentType: contentType, ts: time.Now()}
                setCached(key, body, contentType)
        }

        close(entry.done)
        inflightMu.Lock()
        delete(inflightMap, key)
        inflightMu.Unlock()

        return entry.result, entry.err
}

var (
        aesBlock  cipher.Block
        aesGcm    cipher.AEAD
        cryptoErr error
)

func init() {
        aesBlock, cryptoErr = aes.NewCipher(senshiAESKey)
        if cryptoErr == nil {
                aesGcm, cryptoErr = cipher.NewGCM(aesBlock)
        }
}

func decryptEM3U8(text string) ([]byte, error) {
        if !strings.HasPrefix(text, "EM3U8v1:") {
                return nil, fmt.Errorf("not EM3U8v1")
        }
        b64 := strings.TrimSpace(text[8:])
        b64 = strings.ReplaceAll(b64, "-", "+")
        b64 = strings.ReplaceAll(b64, "_", "/")
        if mod := len(b64) % 4; mod != 0 {
                b64 += strings.Repeat("=", 4-mod)
        }
        raw, err := base64.StdEncoding.DecodeString(b64)
        if err != nil {
                return nil, err
        }
        if len(raw) < 29 {
                return nil, fmt.Errorf("payload too short")
        }
        return aesGcm.Open(nil, raw[:12], raw[12:], nil)
}

func resolveUrl(rel, base string) string {
        if strings.HasPrefix(rel, "http://") || strings.HasPrefix(rel, "https://") {
                return rel
        }
        baseUrl, err := url.Parse(base)
        if err != nil {
                return rel
        }
        ref, err := url.Parse(rel)
        if err != nil {
                return rel
        }
        return baseUrl.ResolveReference(ref).String()
}

var uriRe = regexp.MustCompile(`URI="([^"]+)"`)

func rewriteM3u8(text, baseUrl, referer string) string {
        lines := strings.Split(text, "\n")
        for i, raw := range lines {
                line := strings.TrimSpace(raw)
                if strings.HasPrefix(line, "#") && strings.Contains(line, `URI="`) {
                        lines[i] = uriRe.ReplaceAllStringFunc(raw, func(match string) string {
                                sub := uriRe.FindStringSubmatch(match)
                                if len(sub) < 2 {
                                        return match
                                }
                                abs := resolveUrl(sub[1], baseUrl)
                                token := xorEncode(abs + "\x00" + referer)
                                return `URI="/p/` + token + `"`
                        })
                        continue
                }
                if line != "" && !strings.HasPrefix(line, "#") {
                        abs := resolveUrl(line, baseUrl)
                        token := xorEncode(abs + "\x00" + referer)
                        lines[i] = "/p/" + token
                }
        }
        return strings.Join(lines, "\n")
}

func isVodManifest(text string) bool {
        return strings.Contains(text, "#EXT-X-ENDLIST")
}

var httpClient = &http.Client{
        Timeout: 15 * time.Second,
        Transport: &http.Transport{
                MaxIdleConns:        500,
                MaxIdleConnsPerHost: 50,
                IdleConnTimeout:     300 * time.Second,
                TLSClientConfig: &tls.Config{
                        InsecureSkipVerify: false,
                },
                ForceAttemptHTTP2:     true,
                MaxConnsPerHost:       0,
                ResponseHeaderTimeout: 10 * time.Second,
                ExpectContinueTimeout: 1 * time.Second,
        },
}

func curlFetch(targetUrl string, headers map[string]string) (int, []byte, string, error) {
        args := []string{"-s", "--max-time", "15", "--compressed", "-L",
                "-D", "-", "-o", "-",
                "-w", "\n__HTTP_STATUS__:%{http_code}"}
        for k, v := range headers {
                args = append(args, "-H", k+": "+v)
        }
        args = append(args, targetUrl)

        cmd := exec.Command("curl", args...)
        var stdout bytes.Buffer
        cmd.Stdout = &stdout
        cmd.Stderr = io.Discard
        err := cmd.Run()
        if err != nil {
                return 0, nil, "", err
        }

        allText := stdout.String()
        statusRe := regexp.MustCompile(`__HTTP_STATUS__:(\d+)\s*$`)
        statusMatch := statusRe.FindStringSubmatch(allText)
        status := 200
        if len(statusMatch) > 1 {
                fmt.Sscanf(statusMatch[1], "%d", &status)
        }
        allText = regexp.MustCompile(`\n__HTTP_STATUS__:\d+\s*$`).ReplaceAllString(allText, "")
        blankIdx := strings.Index(allText, "\r\n\r\n")
        headersSection := ""
        body := allText
        if blankIdx != -1 {
                headersSection = allText[:blankIdx]
                body = allText[blankIdx+4:]
        }
        contentType := "application/octet-stream"
        ctRe := regexp.MustCompile(`(?i)Content-Type:\s*([^\r\n]+)`)
        ctMatch := ctRe.FindStringSubmatch(headersSection)
        if len(ctMatch) > 1 {
                contentType = strings.TrimSpace(ctMatch[1])
        }
        return status, []byte(body), contentType, nil
}

func corsHeaders() map[string]string {
        return map[string]string{
                "Access-Control-Allow-Origin":   "*",
                "Access-Control-Allow-Methods":  "GET, HEAD, OPTIONS",
                "Access-Control-Allow-Headers":  "Range, Content-Type",
                "Access-Control-Expose-Headers": "Content-Length, Content-Range, Content-Type, Accept-Ranges",
                "Accept-Ranges":                 "bytes",
        }
}


func prefetchNextSegments(currentUrl, baseUrl, referer string) {

        parsed, err := url.Parse(currentUrl)
        if err != nil {
                return
        }
        path := parsed.Path

        re := regexp.MustCompile(`(\d+)(\.[^.]+)?$`)
        loc := re.FindStringSubmatchIndex(path)
        if loc == nil {
                return
        }

        numStr := path[loc[2]:loc[3]]
        var num int
        fmt.Sscanf(numStr, "%d", &num)
        width := len(numStr)

        for i := 1; i <= 3; i++ {
                nextNum := num + i
                nextNumStr := fmt.Sprintf("%0*d", width, nextNum)
                nextPath := path[:loc[2]] + nextNumStr + path[loc[3]:]
                nextUrl := parsed.Scheme + "://" + parsed.Host + nextPath
                if parsed.RawQuery != "" {
                        nextUrl += "?" + parsed.RawQuery
                }

                if _, ok := getCached(nextUrl); ok {
                        continue
                }

                go func(u, ref string) {
                        rule := findRule(parsed.Hostname())
                        hdrs := map[string]string{
                                "User-Agent":      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
                                "Accept":          "*/*",
                                "Accept-Language":  "en-US,en;q=0.9",
                                "Connection":       "keep-alive",
                                "Referer":          ref,
                                "Origin":           rule.origin,
                        }
                        if !isSenshiCdn(parsed.Hostname()) {
                                hdrs["Sec-Fetch-Dest"] = "empty"
                                hdrs["Sec-Fetch-Mode"] = "cors"
                                hdrs["Sec-Fetch-Site"] = "cross-site"
                        }

                        fetchWithSingleFlight(u, func() ([]byte, string, error) {
                                if isSenshiCdn(parsed.Hostname()) {
                                        _, body, ct, err := smartFetch(u, hdrs, true)
                                        if err != nil {
                                                return nil, "", err
                                        }
                                        if len(body) >= 8 && string(body[:8]) == "EM3U8v1:" {
                                                decrypted, err := decryptEM3U8(string(body))
                                                if err != nil {
                                                        return nil, "", err
                                                }
                                                body = decrypted
                                        }
                                        return body, ct, nil
                                }
                                req, err := http.NewRequest("GET", u, nil)
                                if err != nil {
                                        return nil, "", err
                                }
                                for k, v := range hdrs {
                                        req.Header.Set(k, v)
                                }
                                resp, err := httpClient.Do(req)
                                if err != nil {
                                        return nil, "", err
                                }
                                defer resp.Body.Close()
                                buf := bufPool.Get().(*bytes.Buffer)
                                buf.Reset()
                                defer bufPool.Put(buf)
                                io.Copy(buf, resp.Body)
                                return buf.Bytes(), resp.Header.Get("Content-Type"), nil
                        })
                }(nextUrl, referer)
        }
}


func prefetchFromManifest(m3u8Text, baseUrl, referer, targetHost string) {
        segRe := regexp.MustCompile(`/p/([A-Za-z0-9_-]+)`)
        matches := segRe.FindAllStringSubmatch(m3u8Text, -1)
        if len(matches) == 0 {
                return
        }

        seen := make(map[string]bool)
        var tokens []string
        for _, m := range matches {
                token := m[1]
                if !seen[token] {
                        seen[token] = true
                        tokens = append(tokens, token)
                }
                if len(tokens) >= 5 {
                        break
                }
        }

        var wg sync.WaitGroup
        isSenshi := isSenshiCdn(targetHost)
        for _, token := range tokens {
                wg.Add(1)
                go func(tok string) {
                        defer wg.Done()

                        upstreamUrl, ref, ok := xorDecode(tok)
                        if !ok || upstreamUrl == "" {
                                return
                        }
                        if ref == "" {
                                ref = referer
                        }

                        if _, ok := getCached(upstreamUrl); ok {
                                return
                        }

                        rule := findRule(targetHost)
                        hdrs := map[string]string{
                                "User-Agent":      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
                                "Accept":          "*/*",
                                "Accept-Language":  "en-US,en;q=0.9",
                                "Connection":       "keep-alive",
                                "Referer":          ref,
                                "Origin":           rule.origin,
                        }
                        if !isSenshi {
                                hdrs["Sec-Fetch-Dest"] = "empty"
                                hdrs["Sec-Fetch-Mode"] = "cors"
                                hdrs["Sec-Fetch-Site"] = "cross-site"
                        }

                        fetchWithSingleFlight(upstreamUrl, func() ([]byte, string, error) {
                                {
                                        _, body, ct, err := smartFetch(upstreamUrl, hdrs, isSenshi)
                                        if err != nil {
                                                return nil, "", err
                                        }
                                        if len(body) >= 8 && string(body[:8]) == "EM3U8v1:" {
                                                decrypted, err := decryptEM3U8(string(body))
                                                if err != nil {
                                                        return nil, "", err
                                                }
                                                body = decrypted
                                        }
                                        return body, ct, nil
                                }
                                req, err := http.NewRequest("GET", upstreamUrl, nil)
                                if err != nil {
                                        return nil, "", err
                                }
                                for k, v := range hdrs {
                                        req.Header.Set(k, v)
                                }
                                resp, err := httpClient.Do(req)
                                if err != nil {
                                        return nil, "", err
                                }
                                defer resp.Body.Close()
                                buf := bufPool.Get().(*bytes.Buffer)
                                buf.Reset()
                                defer bufPool.Put(buf)
                                io.Copy(buf, resp.Body)
                                return buf.Bytes(), resp.Header.Get("Content-Type"), nil
                        })
                }(token)
        }
        wg.Wait()
}


func smartFetch(targetUrl string, hdrs map[string]string, isSenshi bool) (int, []byte, string, error) {
        req, err := http.NewRequest("GET", targetUrl, nil)
        if err != nil {
                return 0, nil, "", err
        }
        for k, v := range hdrs {
                req.Header.Set(k, v)
        }
        resp, err := httpClient.Do(req)
        if err == nil && resp.StatusCode == 200 || (err == nil && resp.StatusCode == 206) {
                defer resp.Body.Close()
                buf := bufPool.Get().(*bytes.Buffer)
                buf.Reset()
                defer bufPool.Put(buf)
                io.Copy(buf, resp.Body)
                return resp.StatusCode, buf.Bytes(), resp.Header.Get("Content-Type"), nil
        }
        if resp != nil {
                resp.Body.Close()
        }

        {
                return curlFetch(targetUrl, hdrs)
        }

        if err != nil {
                return 0, nil, "", err
        }
        return resp.StatusCode, nil, "", fmt.Errorf("upstream %d", resp.StatusCode)
}

func handleProxy(w http.ResponseWriter, r *http.Request) {
        if r.Method == "OPTIONS" {
                w.WriteHeader(204)
                for k, v := range corsHeaders() {
                        w.Header().Set(k, v)
                }
                return
        }

        if r.URL.Path == "/health" || r.URL.Path == "/" {
                w.Header().Set("Content-Type", "application/json")
                cacheMu.RLock()
                cacheSize := len(cacheMap)
                inflightMu.Lock()
                inflightSize := len(inflightMap)
                inflightMu.Unlock()
                cacheMu.RUnlock()
                json.NewEncoder(w).Encode(map[string]interface{}{
                        "ok":       true,
                        "worker":   "whoapi-proxy-go",
                        "ts":       time.Now().UnixMilli(),
                        "cache":    cacheSize,
                        "inflight": inflightSize,
                        "version":  "2.0",
                })
                return
        }

        if !strings.HasPrefix(r.URL.Path, "/p/") {
                http.NotFound(w, r)
                return
        }
        token := strings.TrimPrefix(r.URL.Path, "/p/")
        targetUrl, referer, ok := xorDecode(token)
        if !ok {
                w.Header().Set("Content-Type", "application/json")
                w.WriteHeader(400)
                json.NewEncoder(w).Encode(map[string]string{"error": "Invalid token"})
                return
        }

        parsed, err := url.Parse(targetUrl)
        if err != nil {
                w.Header().Set("Content-Type", "application/json")
                w.WriteHeader(400)
                json.NewEncoder(w).Encode(map[string]string{"error": "Invalid URL"})
                return
        }
        targetHost := parsed.Hostname()

        rule := findRule(targetHost)
        effectiveReferer := referer
        if effectiveReferer == "" {
                effectiveReferer = rule.referer
        }
        effectiveOrigin := rule.origin
        if effectiveOrigin == "" {
                effectiveOrigin = "https://" + targetHost
        }

        urlPath := parsed.Path
        isM3u8 := strings.HasSuffix(urlPath, ".m3u8") || strings.HasSuffix(urlPath, "/master") ||
                strings.HasSuffix(urlPath, "/index.m3u8") || strings.HasSuffix(urlPath, "/playlist") ||
                strings.HasSuffix(urlPath, ".txt")
        isSenshi := isSenshiCdn(targetHost)

        minimal := isSenshi
        hdrs := map[string]string{
                "User-Agent":      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
                "Accept":          "*/*",
                "Accept-Language":  "en-US,en;q=0.9",
                "Accept-Encoding":  "gzip",
                "Connection":       "keep-alive",
                "Referer":          effectiveReferer,
                "Origin":           effectiveOrigin,
        }
        if !minimal {
                hdrs["Sec-Fetch-Dest"] = "empty"
                hdrs["Sec-Fetch-Mode"] = "cors"
                hdrs["Sec-Fetch-Site"] = "cross-site"
                hdrs["Sec-CH-UA"] = `"Google Chrome";v="125", "Chromium";v="125", "Not.A/Brand";v="24"`
                hdrs["Sec-CH-UA-Mobile"] = "?0"
                hdrs["Sec-CH-UA-Platform"] = `"Windows"`
        }
        if rangeHdr := r.Header.Get("Range"); rangeHdr != "" {
                hdrs["Range"] = rangeHdr
        }

        entry, err := fetchWithSingleFlight(targetUrl, func() ([]byte, string, error) {
                {
                        status, body, ct, err := smartFetch(targetUrl, hdrs, isSenshi)
                        if err != nil {
                                return nil, "", err
                        }
                        if status != 200 && status != 206 {
                                return nil, "", fmt.Errorf("upstream %d", status)
                        }
                        if len(body) >= 8 && string(body[:8]) == "EM3U8v1:" {
                                decrypted, err := decryptEM3U8(string(body))
                                if err != nil {
                                        return nil, "", err
                                }
                                body = decrypted
                        }
                        return body, ct, nil
                }

                req, err := http.NewRequest("GET", targetUrl, nil)
                if err != nil {
                        return nil, "", err
                }
                for k, v := range hdrs {
                        req.Header.Set(k, v)
                }
                resp, err := httpClient.Do(req)
                if err != nil {
                        return nil, "", err
                }
                defer resp.Body.Close()
                if resp.StatusCode != 200 && resp.StatusCode != 206 {
                        return nil, "", fmt.Errorf("upstream %d", resp.StatusCode)
                }
                buf := bufPool.Get().(*bytes.Buffer)
                buf.Reset()
                defer bufPool.Put(buf)
                io.Copy(buf, resp.Body)
                return buf.Bytes(), resp.Header.Get("Content-Type"), nil
        })

        if err != nil {
                w.Header().Set("Content-Type", "application/json")
                w.WriteHeader(502)
                json.NewEncoder(w).Encode(map[string]string{"error": err.Error(), "host": targetHost})
                return
        }

        body := entry.body
        contentType := entry.contentType

        respCT := strings.ToLower(contentType)
        reallyM3u8 := isM3u8 || strings.Contains(respCT, "mpegurl") || strings.Contains(respCT, "x-mpegurl") ||
                strings.HasPrefix(string(body), "#EXTM3U")

        if reallyM3u8 {
                text := string(body)
                if strings.HasPrefix(text, "EM3U8v1:") {
                        decrypted, err := decryptEM3U8(text)
                        if err != nil {
                                w.Header().Set("Content-Type", "application/json")
                                w.WriteHeader(502)
                                json.NewEncoder(w).Encode(map[string]string{"error": "EM3U8v1 decryption failed"})
                                return
                        }
                        text = string(decrypted)
                }
                rewritten := rewriteM3u8(text, targetUrl, effectiveReferer)
                vod := isVodManifest(text)
                cacheControl := "no-cache, must-revalidate"
                if vod {
                        cacheControl = "public, max-age=60, s-maxage=60"
                }
                for k, v := range corsHeaders() {
                        w.Header().Set(k, v)
                }
                w.Header().Set("Content-Type", "application/vnd.apple.mpegurl")
                w.Header().Set("Cache-Control", cacheControl)
                w.WriteHeader(200)
                w.Write([]byte(rewritten))

                go prefetchFromManifest(rewritten, targetUrl, effectiveReferer, targetHost)
                return
        }

        for k, v := range corsHeaders() {
                w.Header().Set(k, v)
        }
        w.Header().Set("Content-Type", contentType)
        w.Header().Set("Content-Length", fmt.Sprintf("%d", len(body)))
        w.Header().Set("Cache-Control", "public, max-age=86400, s-maxage=86400, stale-while-revalidate=86400, immutable")
        if entry.ts.IsZero() {
                w.Header().Set("X-Cache", "MISS")
                w.Header().Set("Vary", "Accept-Encoding")
        } else {
                w.Header().Set("X-Cache", "HIT")
                w.Header().Set("Vary", "Accept-Encoding")
        }

        if !isM3u8 {
                go prefetchNextSegments(targetUrl, targetUrl, effectiveReferer)
        }

        w.WriteHeader(200)
        w.Write(body)
}

func getEnv(key, fallback string) string {
        if v := os.Getenv(key); v != "" {
                return v
        }
        return fallback
}

func main() {
        fmt.Printf("[whoapi-proxy-go] starting on :%s (cache=%d, ttl=%v)\n", port, CacheMaxEntries, CacheTTL)
        http.HandleFunc("/", handleProxy)
        server := &http.Server{
                Addr:         ":" + port,
                ReadTimeout:  30 * time.Second,
                WriteTimeout: 30 * time.Second,
                IdleTimeout:  300 * time.Second,
        }
        if err := server.ListenAndServe(); err != nil {
                fmt.Printf("[whoapi-proxy-go] FATAL: %v\n", err)
                os.Exit(1)
        }
}
