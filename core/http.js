const UA_CHROME =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const UA_FIREFOX =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:130.0) Gecko/20100101 Firefox/130.0";

function withTimeout(ms) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  return { signal: c.signal, done: () => clearTimeout(t) };
}

async function getText(url, headers = {}, ms = 15000) {
  const { signal, done } = withTimeout(ms);
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": UA_CHROME, "Accept-Language": "en-US,en;q=0.9", ...headers },
      signal,
    });
    if (!res.ok) throw new Error(`http ${res.status} ${url}`);
    return await res.text();
  } finally {
    done();
  }
}

async function getJson(url, headers = {}, ms = 15000, retries = 2) {
  const h = {
    "User-Agent": UA_CHROME,
    Accept: "application/json, */*",
    "X-Requested-With": "XMLHttpRequest",
    ...headers,
  };
  for (let i = 0; i <= retries; i++) {
    const { signal, done } = withTimeout(ms);
    try {
      const res = await fetch(url, { headers: h, signal });
      if (res.status === 429 && i < retries) {
        const wait = (parseInt(res.headers.get("retry-after"), 10) || 1) + i * 0.5;
        await new Promise((r) => setTimeout(r, wait * 1000));
        continue;
      }
      if (!res.ok) throw new Error(`http ${res.status} ${url}`);
      return await res.json();
    } finally {
      done();
    }
  }
  throw new Error(`429 exhausted ${url}`);
}

async function postText(url, body, headers = {}, ms = 15000) {
  const { signal, done } = withTimeout(ms);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "User-Agent": UA_CHROME, ...headers },
      body,
      signal,
    });
    if (!res.ok) throw new Error(`http ${res.status} ${url}`);
    return await res.text();
  } finally {
    done();
  }
}

const cache = new Map();

function memo(key, ttlMs, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.ts < ttlMs) return Promise.resolve(hit.value);
  const p = fn()
    .then((v) => {
      if (v != null) {
        cache.set(key, { value: v, ts: Date.now() });
        if (cache.size > 600) {
          const oldest = cache.keys().next().value;
          cache.delete(oldest);
        }
      }
      return v;
    })
    .catch((e) => {
      console.error(`[whoapi] ${key}:`, e.message);
      return hit ? hit.value : null;
    });
  return p;
}

module.exports = { UA_CHROME, UA_FIREFOX, getText, getJson, postText, memo };
