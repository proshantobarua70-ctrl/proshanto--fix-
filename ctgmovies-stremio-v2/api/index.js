const WORKER =
  process.env.WORKER_URL ||
  "https://ctgmovies-api.proshantobarua70-4a5.workers.dev";

const ADDON_ID = "com.proshanto.ctgmovies.bridge";
const VERSION = "6.3.0";
const PAGE_SIZE = 100;
const MAX_PAGES = 125;
const CONCURRENCY = 12;
const LOAD_BUDGET_MS = 14_000;
const CACHE_TTL = 10 * 60_000;
const REQUEST_TIMEOUT = 12000;

const CACHE_LONG = "public, s-maxage=300, stale-while-revalidate=600";
const CACHE_SHORT = "public, s-maxage=60, stale-while-revalidate=120";

let itemsCache = null;
let itemsCacheTime = 0;
let cachePromise = null;

/* ---------- helpers ---------- */

function sendJson(res, status, data, cache = "no-store") {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", status === 200 ? cache : "no-store");
  return res.status(status).send(JSON.stringify(data));
}

function sendText(res, status, type, body, cache = "public, max-age=3600") {
  res.setHeader("Content-Type", type);
  res.setHeader("Cache-Control", cache);
  return res.status(status).send(body);
}

function cleanId(value) {
  const raw = String(value || "");
  try {
    return decodeURIComponent(raw).replace(/\.json$/i, "").trim();
  } catch {
    return raw.replace(/\.json$/i, "").trim();
  }
}

// Stremio sends extras in the PATH, e.g. /catalog/movie/ctg_movies/skip=100.json
// or /catalog/movie/ctg_movies/search=batman&skip=0.json
function parseExtra(segment) {
  const out = {};
  if (!segment) return out;

  const raw = String(segment).replace(/\.json$/i, "");

  for (const pair of raw.split("&")) {
    const i = pair.indexOf("=");
    if (i < 1) continue;

    let value = pair.slice(i + 1);
    try {
      value = decodeURIComponent(value);
    } catch {
      /* keep raw value */
    }
    out[pair.slice(0, i)] = value;
  }

  return out;
}

function parseJsonArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string") return [];

  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function normalizeKind(item) {
  const kind = String(item?.kind || "").trim().toLowerCase();

  if (["movie", "movies", "film", "films"].includes(kind)) return "movie";

  if (
    ["tv", "series", "show", "shows", "tv_show", "tv-shows"].includes(kind)
  ) {
    return "tv";
  }

  if (["anime", "animes"].includes(kind)) return "anime";

  return kind;
}

function escapeHtml(value) {
  return String(value).replace(
    /[&<>"']/g,
    c =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;"
      })[c]
  );
}

function getOrigin(req) {
  const host = String(
    req.headers["x-forwarded-host"] || req.headers.host || "localhost"
  )
    .split(",")[0]
    .trim();

  const proto = String(req.headers["x-forwarded-proto"] || "https")
    .split(",")[0]
    .trim();

  return { host, origin: `${proto}://${host}` };
}

/* ---------- worker access ---------- */

async function workerFetch(path) {
  const response = await fetch(`${WORKER}${path}`, {
    headers: { "User-Agent": `CTGMovies-Stremio-Bridge/${VERSION}` },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT)
  });

  const text = await response.text();
  let data;

  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`Worker returned invalid JSON (HTTP ${response.status})`);
  }

  if (!response.ok) {
    throw new Error(data.error || `Worker HTTP ${response.status}`);
  }

  return data;
}

async function loadAllItems() {
  // Fast path: the Worker returns every item in a single request.
  try {
    const all = await workerFetch("/all");
    if (Array.isArray(all?.items) && all.items.length) {
      const seen = new Set();
      return all.items.filter(item => {
        if (!item?.id || seen.has(item.id)) return false;
        seen.add(item.id);
        return true;
      });
    }
  } catch {
    /* older worker without /all: fall back to paging below */
  }

  const started = Date.now();
  const items = [];
  const seen = new Set();
  let page = 1;

  while (page <= MAX_PAGES && Date.now() - started < LOAD_BUDGET_MS) {
    const pages = [];
    for (let p = page; p < page + CONCURRENCY && p <= MAX_PAGES; p++) {
      pages.push(p);
    }

    const results = await Promise.allSettled(
      pages.map(p => workerFetch(`/movies?page=${p}&limit=${PAGE_SIZE}`))
    );

    let fetched = 0;
    let anyOk = false;

    for (const result of results) {
      if (result.status !== "fulfilled") continue;
      anyOk = true;

      const batch = result.value?.items;
      if (!Array.isArray(batch)) continue;

      fetched += batch.length;

      for (const item of batch) {
        if (!item?.id || seen.has(item.id)) continue;
        seen.add(item.id);
        items.push(item);
      }
    }

    // every request failed, or we ran past the last page
    if (!anyOk || fetched === 0) break;

    page += CONCURRENCY;
  }

  return items;
}

async function getItems() {
  const fresh = itemsCache && Date.now() - itemsCacheTime < CACHE_TTL;
  if (fresh) return itemsCache;

  if (cachePromise) return cachePromise;

  cachePromise = (async () => {
    try {
      const items = await loadAllItems();

      if (items.length === 0) {
        if (itemsCache) return itemsCache; // serve stale instead of nothing
        throw new Error("Worker returned no items");
      }

      itemsCache = items;
      itemsCacheTime = Date.now();
      return items;
    } finally {
      cachePromise = null;
    }
  })();

  return cachePromise;
}

/* ---------- manifest ---------- */

function makeManifest(origin) {
  const extra = [
    { name: "search", isRequired: false },
    { name: "skip", isRequired: false }
  ];

  return {
    id: ADDON_ID,
    version: VERSION,
    name: "CTGMovies Bridge",
    description: "CTGMovies movies, TV shows and anime",
    logo: `${origin}/icon.svg`,

    resources: [
      "catalog",
      { name: "meta", types: ["movie", "series"], idPrefixes: ["ctg:"] },
      { name: "stream", types: ["movie", "series"], idPrefixes: ["ctg:"] }
    ],

    types: ["movie", "series"],

    catalogs: [
      { type: "movie", id: "ctg_movies", name: "CTGMovies Movies", extra },
      { type: "series", id: "ctg_tv", name: "CTGMovies TV Shows", extra },
      { type: "series", id: "ctg_anime", name: "CTGMovies Anime", extra }
    ],

    behaviorHints: {
      configurable: false,
      configurationRequired: false
    }
  };
}

/* ---------- catalog ---------- */

function catalogMatches(item, catalog) {
  const kind = normalizeKind(item);

  if (catalog === "ctg_movies") return kind === "movie";
  if (catalog === "ctg_tv") return kind === "tv";
  if (catalog === "ctg_anime") return kind === "anime";

  return false;
}

function baseMeta(data, id, type) {
  const meta = { id, type, name: data.name || "Unknown" };

  if (data.poster) meta.poster = data.poster;
  if (data.backdrop) meta.background = data.backdrop;
  if (data.overview) meta.description = data.overview;
  if (data.year) meta.releaseInfo = String(data.year);
  if (data.rating != null) meta.imdbRating = String(data.rating);

  const genres = parseJsonArray(data.genres);
  if (genres.length) meta.genres = genres;

  return meta;
}

function toCatalogMeta(item) {
  const type = normalizeKind(item) === "movie" ? "movie" : "series";
  return baseMeta(item, item.id, type);
}

async function handleCatalog(path, url, res) {
  const parts = path.split("/").filter(Boolean);
  const ci = parts.indexOf("catalog");

  const type = parts[ci + 1] || "";
  const catalog = cleanId(parts[ci + 2] || "");

  const extra = {
    ...Object.fromEntries(url.searchParams),
    ...parseExtra(parts[ci + 3])
  };

  const skip = Math.max(0, Math.min(100000, Number(extra.skip) || 0));
  const search = String(extra.search || "").trim().toLowerCase();

  if (
    !["movie", "series"].includes(type) ||
    !["ctg_movies", "ctg_tv", "ctg_anime"].includes(catalog)
  ) {
    return sendJson(res, 200, { metas: [] });
  }

  let items = (await getItems()).filter(item => {
    const isMovie = normalizeKind(item) === "movie";
    return (
      catalogMatches(item, catalog) &&
      (isMovie ? type === "movie" : type === "series")
    );
  });

  if (search) {
    items = items.filter(item =>
      String(item.name || "").toLowerCase().includes(search)
    );
  }

  const metas = items.slice(skip, skip + PAGE_SIZE).map(toCatalogMeta);

  return sendJson(res, 200, { metas }, CACHE_LONG);
}

/* ---------- meta ---------- */

function convertMeta(data, requestedId) {
  const id = data.id || requestedId;

  const isMovie =
    normalizeKind(data) === "movie" ||
    id.includes(":movie:") ||
    id.includes(":movies:");

  const type = isMovie ? "movie" : "series";
  const meta = baseMeta(data, id, type);

  if (!data.name) meta.name = "CTGMovies";

  if (type === "series") {
    meta.videos = parseJsonArray(data.episodes)
      .filter(
        ep => Number.isFinite(Number(ep.s)) && Number.isFinite(Number(ep.e))
      )
      .map(ep => ({
        id: `${id}:${Number(ep.s)}:${Number(ep.e)}`,
        title: ep.name || `Episode ${Number(ep.e)}`,
        season: Number(ep.s),
        episode: Number(ep.e),
        ...(ep.overview ? { overview: ep.overview } : {}),
        ...(ep.still ? { thumbnail: ep.still } : {}),
        ...(ep.air ? { released: `${ep.air}T00:00:00.000Z` } : {})
      }));
  }

  return { meta };
}

/* ---------- stream ---------- */

function parseStreamRequest(path, url) {
  const parts = path.split("/").filter(Boolean);
  const index = parts.indexOf("stream");

  const type = index >= 0 ? parts[index + 1] || "" : "";
  let id = cleanId(parts[index + 2] || "");

  let season = null;
  let episode = null;

  const match = id.match(/^(ctg:(?:tv|anime|movie|movies):.+):(\d+):(\d+)$/);

  if (match) {
    id = match[1];
    season = Number(match[2]);
    episode = Number(match[3]);
  }

  if (url.searchParams.has("id")) {
    id = cleanId(url.searchParams.get("id"));
  }

  if (/^\d+$/.test(url.searchParams.get("season") || "")) {
    season = Number(url.searchParams.get("season"));
  }

  if (/^\d+$/.test(url.searchParams.get("episode") || "")) {
    episode = Number(url.searchParams.get("episode"));
  }

  return { type, id, season, episode };
}

function makeStreams(links) {
  return parseJsonArray(links)
    .filter(link => link && typeof link.url === "string" && link.url)
    .map(link => {
      const stream = {
        name: "CTGMovies",
        title: `${link.quality || "Direct"}${
          link.source ? ` • ${link.source}` : ""
        }`,
        url: link.url,
        behaviorHints: { bingeGroup: "ctgmovies" }
      };

      const subs = parseJsonArray(link.subs).filter(sub => sub?.url);

      if (subs.length) {
        stream.subtitles = subs.map((sub, i) => ({
          id: String(i),
          url: sub.url,
          lang: sub.lang || sub.label || "und"
        }));
      }

      return stream;
    });
}

async function handleStream(path, url, res) {
  const request = parseStreamRequest(path, url);

  if (!request.id) return sendJson(res, 200, { streams: [] });

  const data = await workerFetch(
    `/stream?id=${encodeURIComponent(request.id)}`
  );

  const episodes = parseJsonArray(data.episodes);
  let links = [];

  if (request.type === "movie" || episodes.length === 0) {
    links = parseJsonArray(data.links);
  } else {
    const selected = episodes.find(
      ep =>
        Number(ep.s) === request.season && Number(ep.e) === request.episode
    );

    links = parseJsonArray(selected?.links);
  }

  return sendJson(res, 200, { streams: makeStreams(links) }, CACHE_SHORT);
}

/* ---------- landing page + icon ---------- */

const ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">
<rect width="128" height="128" rx="26" fill="#1b1b2f"/>
<rect x="24" y="34" width="80" height="60" rx="8" fill="none" stroke="#e94560" stroke-width="7"/>
<path d="M54 49v30l26-15z" fill="#e94560"/>
<rect x="40" y="100" width="48" height="6" rx="3" fill="#e94560"/>
</svg>`;

function landingPage(host, origin) {
  const manifestUrl = `${origin}/manifest.json`;
  const stremioUrl = `stremio://${host}/manifest.json`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>CTGMovies Bridge – Stremio addon</title>
<style>
  :root { color-scheme: dark; }
  body { margin:0; min-height:100vh; display:grid; place-items:center;
         background:#12121f; color:#eee; font-family:system-ui,sans-serif; }
  main { max-width:460px; padding:32px; text-align:center; }
  img { width:96px; height:96px; }
  h1 { margin:12px 0 4px; }
  p { color:#aaa; line-height:1.5; }
  a.btn { display:inline-block; margin:16px 0 8px; padding:12px 24px;
          background:#e94560; color:#fff; border-radius:8px;
          text-decoration:none; font-weight:600; }
  code { display:block; margin-top:12px; padding:10px; background:#1e1e33;
         border-radius:6px; word-break:break-all; font-size:13px; }
</style>
</head>
<body>
<main>
  <img src="/icon.svg" alt="">
  <h1>CTGMovies Bridge</h1>
  <p>Movies, TV shows and anime for Stremio.</p>
  <a class="btn" href="${escapeHtml(stremioUrl)}">Install in Stremio</a>
  <p>Or paste this link into Stremio's addon search box:</p>
  <code>${escapeHtml(manifestUrl)}</code>
</main>
</body>
</html>`;
}

/* ---------- main handler ---------- */

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");

  if (req.method === "OPTIONS") return res.status(204).end();

  try {
    const { host, origin } = getOrigin(req);
    const url = new URL(req.url, origin);
    const path = url.pathname;

    if (path === "/" || path === "/configure") {
      return sendText(
        res,
        200,
        "text/html; charset=utf-8",
        landingPage(host, origin)
      );
    }

    if (path === "/icon.svg") {
      return sendText(res, 200, "image/svg+xml", ICON_SVG);
    }

    if (path === "/favicon.ico") return res.status(204).end();

    if (path === "/ping") {
      return sendJson(res, 200, {
        ok: true,
        service: "CTGMovies Vercel Bridge",
        version: VERSION,
        worker: WORKER
      });
    }

    if (path === "/manifest.json") {
      return sendJson(res, 200, makeManifest(origin), CACHE_LONG);
    }

    if (path.startsWith("/catalog/")) {
      return await handleCatalog(path, url, res);
    }

    if (path.startsWith("/meta/")) {
      const id = cleanId(path.split("/").filter(Boolean).pop());
      const data = await workerFetch(`/stream?id=${encodeURIComponent(id)}`);

      return sendJson(res, 200, convertMeta(data, id), CACHE_LONG);
    }

    if (path === "/stream" || path.startsWith("/stream/")) {
      return await handleStream(path, url, res);
    }

    if (path === "/movies" || path === "/search" || path === "/meta") {
      const data = await workerFetch(`${path}${url.search}`);
      return sendJson(res, 200, data, CACHE_SHORT);
    }

    return sendJson(res, 404, { error: "Not found", path });
  } catch (error) {
    console.error("CTGMovies bridge error:", error);

    return sendJson(res, 502, {
      error: "Worker request failed",
      message: error.message,
      streams: [],
      metas: []
    });
  }
};
