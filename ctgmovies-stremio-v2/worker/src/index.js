// CTGMovies Cloudflare Worker
//  - stores items in D1
//  - serves the API used by the Vercel bridge  (/all, /movies, /stream, /meta, /search, /ping)
//  - POST /admin/import  : bulk import (used by the GitHub workflow)
//  - POST /admin/run     : run the scraper right now (for testing)
//  - cron (every 6 hours): scrape newest pages and add new movies / episodes

const MAIN = "https://ctgmovies.com";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36";
const SECTIONS = [
  ["movies", "/movies"],
  ["tv", "/tv"],
  ["anime", "/anime"]
];

/* ======================= small helpers ======================= */

const fixUrl = u => {
  try {
    return new URL(u, MAIN).href;
  } catch {
    return u;
  }
};

const decodeHtml = s =>
  String(s || "")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ");

const stripTags = s =>
  decodeHtml(String(s || "").replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ")
    .trim();

const attr = (tag, name) => {
  const m = String(tag || "").match(
    new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, "i")
  );
  return m ? decodeHtml(m[2] ?? m[3]) : "";
};

function fixImage(u) {
  if (!u) return undefined;
  try {
    if (u.includes("/_next/image?url=")) {
      return decodeURIComponent(
        u.split("/_next/image?url=")[1].split("&")[0]
      );
    }
    return fixUrl(u);
  } catch {
    return u;
  }
}

const json = (data, status = 200, cache = "no-store") =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": status === 200 ? cache : "no-store"
    }
  });

function parseArr(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string" || !value) return [];
  try {
    const p = JSON.parse(value);
    return Array.isArray(p) ? p : [];
  } catch {
    return [];
  }
}

function authed(request, env) {
  const header = request.headers.get("Authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  const secret = String(env.ADMIN_TOKEN || "");

  if (!secret || token.length !== secret.length) return false;

  let diff = 0;
  for (let i = 0; i < secret.length; i++) {
    diff |= token.charCodeAt(i) ^ secret.charCodeAt(i);
  }
  return diff === 0;
}

/* ======================= database ======================= */

let schemaReady = false;

async function ensureSchema(env) {
  if (schemaReady) return;

  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS items (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      slug TEXT,
      name TEXT,
      poster TEXT,
      backdrop TEXT,
      year INTEGER,
      overview TEXT,
      rating REAL,
      genres TEXT,
      runtime INTEGER,
      imdb TEXT,
      tmdb TEXT,
      trailer TEXT,
      links TEXT,
      episodes TEXT,
      has_data INTEGER DEFAULT 0,
      rank INTEGER DEFAULT 0,
      updated_at INTEGER
    )`),
    env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_items_rank ON items(rank)`),
    env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT)`
    )
  ]);

  schemaReady = true;
}

const num = v => {
  const n = Number(v);
  return v != null && v !== "" && Number.isFinite(n) ? n : null;
};

function normalize(it) {
  const links = Array.isArray(it.links) ? it.links : [];
  const episodes = Array.isArray(it.episodes) ? it.episodes : [];
  const genres = Array.isArray(it.genres) ? it.genres : parseArr(it.genres);

  return {
    id: String(it.id),
    kind: String(it.kind || ""),
    slug: it.slug ?? null,
    name: it.name ?? null,
    poster: it.poster ?? null,
    backdrop: it.backdrop ?? null,
    year: num(it.year),
    overview: it.overview ?? null,
    rating: num(it.rating),
    genres: JSON.stringify(genres),
    runtime: num(it.runtime),
    imdb: it.imdb ?? null,
    tmdb: it.tmdb != null ? String(it.tmdb) : null,
    trailer: it.trailer ?? null,
    links: JSON.stringify(links),
    episodes: JSON.stringify(episodes),
    has_data: links.length || episodes.length ? 1 : 0
  };
}

const UPSERT_SQL = `INSERT INTO items
  (id, kind, slug, name, poster, backdrop, year, overview, rating, genres,
   runtime, imdb, tmdb, trailer, links, episodes, has_data, rank, updated_at)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  ON CONFLICT(id) DO UPDATE SET
    kind=excluded.kind, slug=excluded.slug, name=excluded.name,
    poster=excluded.poster, backdrop=excluded.backdrop, year=excluded.year,
    overview=excluded.overview, rating=excluded.rating, genres=excluded.genres,
    runtime=excluded.runtime, imdb=excluded.imdb, tmdb=excluded.tmdb,
    trailer=excluded.trailer, links=excluded.links, episodes=excluded.episodes,
    has_data=excluded.has_data,
    rank=CASE WHEN ? = 1 THEN excluded.rank ELSE items.rank END,
    updated_at=excluded.updated_at`;

function upsertStatement(env, item, rank, overwriteRank) {
  const n = normalize(item);

  return env.DB.prepare(UPSERT_SQL).bind(
    n.id, n.kind, n.slug, n.name, n.poster, n.backdrop, n.year, n.overview,
    n.rating, n.genres, n.runtime, n.imdb, n.tmdb, n.trailer, n.links,
    n.episodes, n.has_data, rank, Date.now(),
    overwriteRank ? 1 : 0
  );
}

async function setMeta(env, key, value) {
  await env.DB.prepare(
    `INSERT INTO meta (k, v) VALUES (?, ?)
     ON CONFLICT(k) DO UPDATE SET v = excluded.v`
  )
    .bind(key, JSON.stringify(value))
    .run();
}

async function getMeta(env, key) {
  const row = await env.DB.prepare(`SELECT v FROM meta WHERE k = ?`)
    .bind(key)
    .first();

  try {
    return row ? JSON.parse(row.v) : null;
  } catch {
    return null;
  }
}

/* ---- row -> API objects ---- */

const LIGHT_COLS = `id, kind, name, poster, backdrop, year, rating, genres`;

function lightRow(r, overview) {
  return {
    id: r.id,
    kind: r.kind,
    name: r.name,
    poster: r.poster,
    backdrop: r.backdrop,
    year: r.year,
    overview: overview ?? r.overview ?? undefined,
    rating: r.rating,
    genres: parseArr(r.genres)
  };
}

function fullRow(r) {
  return {
    ...lightRow(r),
    runtime: r.runtime,
    imdb: r.imdb,
    tmdb: r.tmdb,
    trailer: r.trailer,
    links: parseArr(r.links),
    episodes: parseArr(r.episodes)
  };
}

/* ======================= public API ======================= */

async function handleAll(env) {
  const { results } = await env.DB.prepare(
    `SELECT ${LIGHT_COLS}, substr(overview, 1, 200) AS overview
     FROM items ORDER BY rank ASC, id ASC`
  ).all();

  return json(
    { items: results.map(r => lightRow(r, r.overview)) },
    200,
    "public, max-age=60"
  );
}

async function handleMovies(env, url) {
  const limit = Math.min(
    100,
    Math.max(1, parseInt(url.searchParams.get("limit"), 10) || 100)
  );
  const page = Math.max(1, parseInt(url.searchParams.get("page"), 10) || 1);
  const kind = (url.searchParams.get("kind") || "").trim();

  const where = kind ? "WHERE kind = ?" : "";
  const binds = kind ? [kind, limit, (page - 1) * limit] : [limit, (page - 1) * limit];

  const { results } = await env.DB.prepare(
    `SELECT ${LIGHT_COLS}, overview FROM items ${where}
     ORDER BY rank ASC, id ASC LIMIT ? OFFSET ?`
  )
    .bind(...binds)
    .all();

  return json(
    { page, limit, items: results.map(r => lightRow(r)) },
    200,
    "public, max-age=60"
  );
}

async function handleItem(env, url) {
  const id = (url.searchParams.get("id") || "").trim();
  if (!id) return json({ error: "Missing id" }, 400);

  const row = await env.DB.prepare(`SELECT * FROM items WHERE id = ?`)
    .bind(id)
    .first();

  if (!row) return json({ error: "Not found" }, 404);

  return json(fullRow(row), 200, "public, max-age=60");
}

async function handleSearch(env, url) {
  const q = (url.searchParams.get("q") || "").trim().toLowerCase();
  if (!q) return json({ items: [] });

  const like = `%${q.replace(/[\\%_]/g, "\\$&")}%`;

  const { results } = await env.DB.prepare(
    `SELECT ${LIGHT_COLS}, overview FROM items
     WHERE lower(name) LIKE ? ESCAPE '\\'
     ORDER BY rank ASC LIMIT 50`
  )
    .bind(like)
    .all();

  return json({ items: results.map(r => lightRow(r)) });
}

/* ======================= admin ======================= */

async function handleImport(env, request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }

  const items = Array.isArray(body.items) ? body.items : [];
  const offset = Number(body.offset) || 0;

  const valid = items.filter(it => it && it.id && it.kind);

  if (valid.length) {
    await env.DB.batch(
      valid.map((it, i) => upsertStatement(env, it, offset + i, true))
    );
  }

  return json({ ok: true, imported: valid.length, skipped: items.length - valid.length });
}

async function handleStatus(env) {
  const { results } = await env.DB.prepare(
    `SELECT kind, COUNT(*) AS n, SUM(has_data) AS with_data FROM items GROUP BY kind`
  ).all();

  return json({
    ok: true,
    kinds: results,
    lastRun: await getMeta(env, "last_run")
  });
}

/* ======================= scraper (runs on cron) ======================= */

async function getText(url, tries = 2) {
  let last;

  for (let t = 1; t <= tries; t++) {
    try {
      const r = await fetch(url, {
        headers: {
          "User-Agent": UA,
          Accept: "text/html,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.9",
          Referer: MAIN + "/"
        },
        signal: AbortSignal.timeout(15000)
      });

      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.text();
    } catch (e) {
      last = e;
    }
  }

  throw last;
}

function parseCards(html) {
  const out = [];
  const seen = new Set();
  const re = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  let m;

  while ((m = re.exec(html))) {
    const mm = attr(m[1], "href")
      .replace(MAIN, "")
      .match(/^\/(movies|tv|anime)\/([^/?#]+)/);

    if (!mm || seen.has(mm[1] + mm[2])) continue;

    const inner = m[2];
    const img = (inner.match(/<img\b[^>]*>/i) || [""])[0];
    let name = attr(img, "alt").trim();

    if (!name) {
      const f = inner.match(
        /class\s*=\s*"[^"]*font-display[^"]*"[^>]*>([^<]*)</i
      );
      name = f ? decodeHtml(f[1]).trim() : stripTags(inner);
    }

    if (!name) continue;

    seen.add(mm[1] + mm[2]);

    const mono = inner.match(
      /class\s*=\s*"[^"]*font-mono[^"]*"[^>]*>([^<]*)</i
    );
    const y = (mono ? mono[1] : stripTags(inner)).match(/\b(19\d\d|20\d\d)\b/);

    out.push({
      kind: mm[1],
      slug: mm[2],
      name,
      poster: fixImage(attr(img, "src") || attr(img, "data-src")),
      year: y ? +y[1] : undefined
    });
  }

  return out;
}

function addLinks(target, list) {
  for (const l of list) {
    if (l && l.url && !target.some(x => x.url === l.url)) target.push(l);
  }
}

function extractRsc(html) {
  let details = null;
  const episodes = new Map();
  const links = [];

  const re = /self\.__next_f\.push\(\[1,"([\s\S]*?)"\]\)/g;
  let combined = "";
  let m;

  while ((m = re.exec(html))) {
    try {
      combined += JSON.parse(`"${m[1]}"`);
    } catch {
      combined += m[1];
    }
  }

  for (const line of combined.split("\n")) {
    const payload = line.trim().replace(/^[0-9a-fA-F]+:/, "");
    if (!payload.startsWith("{") && !payload.startsWith("[")) continue;

    let root;
    try {
      root = JSON.parse(payload);
    } catch {
      continue;
    }

    const queue = [root];

    while (queue.length) {
      const n = queue.shift();
      if (!n || typeof n !== "object") continue;

      if (!Array.isArray(n)) {
        const d = n.data;

        if (d && typeof d === "object" && !Array.isArray(d)) {
          if (!details) details = d.movie || d.series || null;
          if (Array.isArray(d.links)) addLinks(links, d.links);
        }

        if (!details && n.movie && typeof n.movie === "object") details = n.movie;
        if (!details && n.series && typeof n.series === "object") details = n.series;
        if (Array.isArray(n.links)) addLinks(links, n.links);

        if (Array.isArray(n.episodes)) {
          for (const ep of n.episodes) {
            if (!ep || typeof ep !== "object") continue;

            const key = `${ep.season_number ?? 1}:${ep.episode_number ?? 1}`;
            const ex = episodes.get(key);

            if (!ex || ((ep.links || []).length && !(ex.links || []).length)) {
              episodes.set(key, ep);
            }
          }
        }

        for (const v of Object.values(n)) queue.push(v);
      } else {
        for (const v of n) queue.push(v);
      }
    }
  }

  const eps = [...episodes.values()].sort(
    (a, b) =>
      (a.season_number ?? 1) - (b.season_number ?? 1) ||
      (a.episode_number ?? 1) - (b.episode_number ?? 1)
  );

  return { details, episodes: eps, links };
}

function detectQuality(s) {
  s = s.toLowerCase();
  if (s.includes("2160p") || s.includes("4k")) return "4K";
  if (s.includes("1080p")) return "1080p";
  if (s.includes("720p")) return "720p";
  if (s.includes("480p")) return "480p";
  if (s.includes("bluray")) return "BluRay";
  return "Direct";
}

function fallbackLinks(html) {
  const out = [];
  const clean = html
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, "\\")
    .replace(/\\\//g, "/");
  const re = /https?:\/\/[^\s"'\\<>]+?\.(?:mp4|mkv|m3u8)/g;
  let m;

  while ((m = re.exec(clean))) {
    const u = m[0];
    if (/\.audio\./i.test(u) || out.some(o => o.url === u)) continue;

    out.push({
      url: u,
      quality: detectQuality(u),
      source: /ftp\./i.test(u)
        ? "Server A"
        : /data\./i.test(u)
        ? "Server B"
        : "Server"
    });
  }

  return out;
}

const compactLinks = links =>
  (links || [])
    .filter(l => l.url)
    .map(l => ({
      url: fixUrl(l.url),
      quality: l.quality || detectQuality(l.url),
      source: l.source || "Server",
      subs: (l.subtitle_tracks || [])
        .filter(t => t.url)
        .map(t => ({
          url: fixUrl(t.url),
          label: t.label || t.language || "English"
        }))
    }));

const idOf = c => `ctg:${c.kind}:${c.slug.replace(/\//g, "~")}`;

async function buildItem(card) {
  const html = await getText(`${MAIN}/${card.kind}/${card.slug}`);
  const { details: d, episodes, links } = extractRsc(html);
  const det = d || {};

  const yt = det.trailer_url
    ? String(det.trailer_url).match(/(?:embed\/|v=)([\w-]{11})/)
    : null;

  const item = {
    id: idOf(card),
    kind: card.kind,
    slug: card.slug,
    name: det.title || det.name || card.name,
    poster: fixImage(det.poster_url) || card.poster,
    backdrop: fixImage(det.backdrop_url),
    year: det.year || card.year,
    overview: det.overview || undefined,
    rating: det.imdb_rating || det.rating || undefined,
    genres: det.genres
      ? String(det.genres).split(",").map(g => g.trim()).filter(Boolean)
      : undefined,
    runtime: det.runtime || undefined,
    imdb:
      det.imdb_id ||
      (html.match(/["']imdb_id["']\s*:\s*["'](tt\d+)["']/) || [])[1],
    tmdb:
      det.tmdb_id != null
        ? String(det.tmdb_id)
        : (html.match(/["']tmdb_id["']\s*:\s*(\d+)/) || [])[1],
    trailer: yt ? yt[1] : undefined
  };

  if (card.kind === "movies") {
    item.links = compactLinks(links.length ? links : fallbackLinks(html));
  } else {
    item.episodes = episodes.map(ep => ({
      s: ep.season_number ?? 1,
      e: ep.episode_number ?? 1,
      name: ep.name || undefined,
      overview: ep.overview || undefined,
      still: fixImage(ep.still_url),
      air: ep.air_date || undefined,
      links: compactLinks(ep.links)
    }));
  }

  return item;
}

async function scrapeUpdate(env) {
  await ensureSchema(env);

  const startedAt = Date.now();
  const pages = Math.max(1, parseInt(env.SCRAPE_PAGES, 10) || 2);
  const maxDetail = Math.max(1, parseInt(env.MAX_DETAIL, 10) || 25);

  // 1) newest listing pages
  const cards = [];
  const errors = [];

  for (const [kind, path] of SECTIONS) {
    const seen = new Set();

    for (let page = 1; page <= pages; page++) {
      try {
        const found = parseCards(
          await getText(`${MAIN}${path}?page=${page}`)
        ).filter(c => c.kind === kind && !seen.has(c.slug));

        if (!found.length) break;

        for (const c of found) {
          seen.add(c.slug);
          cards.push(c);
        }
      } catch (e) {
        errors.push(`${kind} page ${page}: ${e.message}`);
        break;
      }
    }
  }

  if (!cards.length) {
    const summary = {
      ok: false,
      at: new Date().toISOString(),
      message: "No listing found (site down or blocking Cloudflare)",
      errors
    };
    await setMeta(env, "last_run", summary);
    return summary;
  }

  // 2) decide what to fetch
  const { results: known } = await env.DB.prepare(
    `SELECT id, has_data FROM items`
  ).all();

  const have = new Map(known.map(r => [r.id, r.has_data === 1]));

  const isNew = c => !have.has(idOf(c));
  const noData = c => have.has(idOf(c)) && !have.get(idOf(c));
  const isSeries = c => c.kind !== "movies" && have.has(idOf(c));

  const newCards = cards.filter(isNew);
  const todo = [
    ...newCards,
    ...cards.filter(noData),
    ...cards.filter(c => isSeries(c) && have.get(idOf(c)))
  ].slice(0, maxDetail);

  // 3) fetch details (small batches)
  const built = [];
  let failed = 0;

  for (let i = 0; i < todo.length; i += 5) {
    const group = todo.slice(i, i + 5);

    const results = await Promise.allSettled(group.map(buildItem));

    results.forEach((r, j) => {
      if (r.status === "fulfilled") built.push(r.value);
      else {
        failed++;
        errors.push(`${group[j].kind}/${group[j].slug}: ${r.reason?.message}`);
      }
    });
  }

  // 4) save: new ones go on top, existing ones keep their position
  const minRow = await env.DB.prepare(`SELECT MIN(rank) AS m FROM items`).first();
  const minRank = Number(minRow?.m) || 0;
  const newIds = newCards.map(idOf);

  const statements = [];
  let added = 0;
  let updated = 0;

  for (const item of built) {
    const existed = have.has(item.id);
    const hasData =
      (item.links && item.links.length) ||
      (item.episodes && item.episodes.length);

    // never replace good data with an empty result
    if (existed && have.get(item.id) && !hasData) continue;

    if (!existed) {
      const idx = Math.max(0, newIds.indexOf(item.id));
      statements.push(
        upsertStatement(env, item, minRank - newIds.length + idx, true)
      );
      added++;
    } else {
      statements.push(upsertStatement(env, item, 0, false));
      updated++;
    }
  }

  if (statements.length) await env.DB.batch(statements);

  const summary = {
    ok: true,
    at: new Date().toISOString(),
    seconds: Math.round((Date.now() - startedAt) / 100) / 10,
    listed: cards.length,
    newOnSite: newCards.length,
    fetched: todo.length,
    added,
    updated,
    failed,
    errors: errors.slice(0, 5)
  };

  await setMeta(env, "last_run", summary);
  return summary;
}

/* ======================= entry points ======================= */

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Headers": "*",
          "Access-Control-Allow-Methods": "GET,POST,OPTIONS"
        }
      });
    }

    try {
      const url = new URL(request.url);
      const path = url.pathname;

      await ensureSchema(env);

      if (path === "/ping" || path === "/") {
        const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM items`).first();
        return json({
          ok: true,
          service: "CTGMovies Worker",
          items: row?.n ?? 0,
          lastRun: await getMeta(env, "last_run")
        });
      }

      if (path === "/all") return await handleAll(env);
      if (path === "/movies") return await handleMovies(env, url);
      if (path === "/stream" || path === "/meta") return await handleItem(env, url);
      if (path === "/search") return await handleSearch(env, url);

      if (path.startsWith("/admin/")) {
        if (!authed(request, env)) return json({ error: "Unauthorized" }, 401);

        if (path === "/admin/import" && request.method === "POST") {
          return await handleImport(env, request);
        }
        if (path === "/admin/run" && request.method === "POST") {
          return json(await scrapeUpdate(env));
        }
        if (path === "/admin/status") return await handleStatus(env);
      }

      return json({ error: "Not found", path }, 404);
    } catch (error) {
      return json({ error: error.message || String(error) }, 500);
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      scrapeUpdate(env).catch(async error => {
        try {
          await setMeta(env, "last_run", {
            ok: false,
            at: new Date().toISOString(),
            message: error.message
          });
        } catch {
          /* ignore */
        }
      })
    );
  }
};

export { scrapeUpdate, parseCards, extractRsc };
