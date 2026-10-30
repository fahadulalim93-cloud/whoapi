const raw = (process.env.FLARESOLVERR_URL || "").replace(/\/+$/, "");
const BASE = raw.endsWith("/v1") ? raw : `${raw}/v1`;

function enabled() {
  return !!BASE;
}

async function get(url, maxTimeout = 45000) {
  if (!BASE) return null;
  try {
    const res = await fetch(`${BASE}/v1`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cmd: "request.get", url, maxTimeout }),
      signal: AbortSignal.timeout(maxTimeout + 15000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (data.status !== "ok" || !data.solution) return null;
    return data.solution.response || null;
  } catch {
    return null;
  }
}

async function cookies(url, maxTimeout = 30000) {
  if (!BASE) return null;
  try {
    const res = await fetch(`${BASE}/v1`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cmd: "request.get", url, maxTimeout }),
      signal: AbortSignal.timeout(maxTimeout + 15000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (data.status !== "ok" || !data.solution || !data.solution.cookies) return null;
    return data.solution.cookies.map((c) => ({ name: c.name, value: c.value }));
  } catch {
    return null;
  }
}

module.exports = { get, cookies, enabled };
