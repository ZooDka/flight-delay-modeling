/**
 * Flightcast lookup proxy (Cloudflare Worker).
 *
 * Keeps your AeroDataBox API key off the public site. The page calls
 *   GET https://<your-worker>.workers.dev/?flight=AZ610
 * and gets back a small JSON summary derived from AeroDataBox's
 * per-flight delay statistics endpoint.
 *
 * Setup:
 *   1. dash.cloudflare.com -> Workers & Pages -> Create -> Worker -> deploy the
 *      hello-world, then Edit code and replace it with this file.
 *   2. Worker Settings -> Variables and Secrets -> Add secret with your key:
 *        name RAPIDAPI_KEY   if the key is from rapidapi.com/aedbx-aedbx/api/aerodatabox
 *        name API_MARKET_KEY if the key is from api.market (AeroDataBox listing)
 *      (Basic plans are free on both channels; set one secret, not both.)
 *   3. Deploy. Copy the worker URL into PROXY_URL in app/index.html.
 *
 * The worker caches each flight for 6 hours and only answers browser requests
 * from ALLOWED_ORIGINS, which keeps free-tier usage low.
 */

const ALLOWED_ORIGINS = ["https://zoodka.github.io"];

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get("Origin");
    const allowed =
      !origin ||
      ALLOWED_ORIGINS.includes(origin) ||
      origin.startsWith("http://localhost") ||
      origin.startsWith("http://127.0.0.1");
    const cors = {
      "Access-Control-Allow-Origin": allowed && origin ? origin : ALLOWED_ORIGINS[0],
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };
    if (request.method === "OPTIONS") return new Response(null, { headers: cors });
    if (!allowed) return json({ error: "Origin not allowed." }, 403, cors);

    const url = new URL(request.url);
    const flight = (url.searchParams.get("flight") || "")
      .trim().toUpperCase().replace(/\s+/g, "");
    if (!/^[A-Z0-9]{2,3}\d{1,4}[A-Z]?$/.test(flight)) {
      return json({ error: "Enter a valid flight number like AZ610." }, 400, cors);
    }

    // 6-hour cache so repeat lookups cost zero API units
    const cacheKey = new Request("https://cache.flightcast/delays/" + flight);
    const cache = caches.default;
    const hit = await cache.match(cacheKey);
    if (hit) {
      return new Response(await hit.text(), {
        headers: { ...cors, "Content-Type": "application/json", "X-Cache": "HIT" },
      });
    }

    // Works with a key from either sales channel. Set ONE of these secrets:
    //   RAPIDAPI_KEY   (key from rapidapi.com AeroDataBox listing)
    //   API_MARKET_KEY (key from api.market AeroDataBox listing)
    let base, hdrs;
    if (env.RAPIDAPI_KEY) {
      base = "https://aerodatabox.p.rapidapi.com";
      hdrs = {
        "x-rapidapi-key": env.RAPIDAPI_KEY,
        "x-rapidapi-host": "aerodatabox.p.rapidapi.com",
      };
    } else if (env.API_MARKET_KEY) {
      base = "https://prod.api.market/api/v1/aedbx/aerodatabox";
      hdrs = { "x-api-market-key": env.API_MARKET_KEY };
    } else {
      return json({ error: "No API key configured on the worker." }, 500, cors);
    }

    // The delays endpoint path has appeared in a couple of variants; try in order.
    const paths = [
      `/flights/${flight}/delays`,
      `/flights/Number/${flight}/delays`,
      `/flights/number/${flight}/delays`,
    ];
    let data = null, lastStatus = 0;
    for (const p of paths) {
      const r = await fetch(base + p, { headers: hdrs });
      lastStatus = r.status;
      if (r.ok) { data = await r.json(); break; }
      if (r.status !== 404) break;
    }
    if (!data) {
      const msg =
        lastStatus === 429 ? "Monthly API quota reached, try again next month." :
        lastStatus === 401 || lastStatus === 403 ? "API key problem on the server." :
        "No delay statistics found for " + flight + ".";
      return json({ error: msg }, lastStatus === 429 ? 429 : 404, cors);
    }

    const out = summarize(flight, data);
    if (!out) return json({ error: "No usable statistics for " + flight + "." }, 404, cors);

    const resp = json(out, 200, { ...cors, "Cache-Control": "public, max-age=21600" });
    ctx.waitUntil(cache.put(cacheKey, resp.clone()));
    return resp;
  },
};

/** "[-]hh:mm:ss" -> minutes (negative = early). */
export function toMin(s) {
  if (!s || typeof s !== "string") return null;
  const neg = s.trim().startsWith("-");
  const parts = s.replace("-", "").split(":").map(Number);
  if (parts.some(isNaN)) return null;
  const [h, m, sec] = [parts[0] || 0, parts[1] || 0, parts[2] || 0];
  return (neg ? -1 : 1) * (h * 60 + m + sec / 60);
}

/**
 * Map AeroDataBox FlightLegDelayContract -> the three Flightcast inputs.
 * Uses the P5..P95 departure-delay percentile curve of the busiest origin:
 *   on-time %  : interpolated percentile where delay crosses 15 min
 *   mean delay : trapezoid integral of the percentile curve + mild tail terms
 *   worst case : linear tail extrapolation beyond P95
 */
export function summarize(flight, data) {
  const origins = (data.origins || []).filter(
    (o) => o && Array.isArray(o.delayPercentiles) && o.delayPercentiles.length >= 3
  );
  if (!origins.length) return null;
  origins.sort((a, b) => (b.numConsideredFlights || 0) - (a.numConsideredFlights || 0));
  const o = origins[0];

  const pts = o.delayPercentiles
    .map((x) => ({ p: x.percentile, d: toMin(x.delay) }))
    .filter((x) => Number.isFinite(x.p) && x.d !== null)
    .sort((a, b) => a.p - b.p);
  if (pts.length < 3) return null;

  // on-time share (delay <= 15 min)
  let onTime;
  const last = pts[pts.length - 1], first = pts[0];
  if (last.d <= 15) onTime = 97;
  else if (first.d > 15) onTime = 3;
  else {
    for (let i = 0; i < pts.length - 1; i++) {
      if (pts[i].d <= 15 && pts[i + 1].d > 15) {
        const f = (15 - pts[i].d) / (pts[i + 1].d - pts[i].d);
        onTime = pts[i].p + f * (pts[i + 1].p - pts[i].p);
        break;
      }
    }
  }

  // mean: trapezoid over known percentiles, flat below P-first, heavier tail above P-last
  let mean = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    mean += ((pts[i].d + pts[i + 1].d) / 2) * ((pts[i + 1].p - pts[i].p) / 100);
  }
  mean += first.d * (first.p / 100);
  mean += last.d * 1.15 * ((100 - last.p) / 100);

  const p95 = (pts.find((x) => x.p === 95) || last).d;
  const p90 = (pts.find((x) => x.p === 90) || { d: p95 }).d;
  const worst = Math.max(Math.round(p95 + 2 * (p95 - p90)), Math.round(p95) + 15);

  return {
    flight,
    onTime: Math.round(Math.min(97, Math.max(3, onTime))),
    mean: Math.round(mean),
    worst,
    medianMin: Math.round(toMin(o.medianDelay) ?? pts[Math.floor(pts.length / 2)].d),
    n: o.numConsideredFlights || null,
    originIcao: o.airportIcao || null,
    source: "AeroDataBox",
  };
}

function json(obj, status, headers) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...headers, "Content-Type": "application/json" },
  });
}
