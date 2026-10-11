// Run on YOUR PC (Bangladesh internet). No npm install needed.
// Collects movies/series from ctgmovies.com and writes data.json in this folder.
// Usage: node scraper.js [maxPagesPerSection]   |   node scraper.js update
const fs = require("fs");
const zlib = require("zlib");
const path = require("path");

const MAIN = "https://ctgmovies.com";
const OUT = path.join(__dirname, "data.json");
const OUT_GZ = OUT + ".gz";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36";
const SECTIONS = [["movies", "/movies"], ["tv", "/tv"], ["anime", "/anime"]];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fixUrl = (u) => { try { return new URL(u, MAIN).href; } catch { return u; } };
const decodeHtml = (s) => String(s || "").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ");
const stripTags = (s) => decodeHtml(String(s || "").replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
const attr = (tag, name) => { const m = String(tag || "").match(new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, "i")); return m ? decodeHtml(m[2] ?? m[3]) : ""; };
function fixImage(u) {
  if (!u) return undefined;
  try {
    if (u.includes("/_next/image?url=")) return decodeURIComponent(u.split("/_next/image?url=")[1].split("&")[0]);
    return fixUrl(u);
  } catch { return u; }
}

async function getText(url, tries = 3) {
  let last;
  for (let t = 1; t <= tries; t++) {
    try {
      const r = await fetch(url, {
        headers: { "User-Agent": UA, Accept: "text/html,*/*;q=0.8", "Accept-Language": "en-US,en;q=0.9", Referer: MAIN + "/" },
        signal: AbortSignal.timeout(20000)
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.text();
    } catch (e) { last = e; await sleep(1000 * t); }
  }
  throw last;
}

function parseCards(html) {
  const out = [], seen = new Set();
  const re = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html))) {
    const mm = attr(m[1], "href").replace(MAIN, "").match(/^\/(movies|tv|anime)\/([^/?#]+)/);
    if (!mm || seen.has(mm[1] + mm[2])) continue;
    const inner = m[2];
    const img = (inner.match(/<img\b[^>]*>/i) || [""])[0];
    let name = attr(img, "alt").trim();
    if (!name) { const f = inner.match(/class\s*=\s*"[^"]*font-display[^"]*"[^>]*>([^<]*)</i); name = f ? decodeHtml(f[1]).trim() : stripTags(inner); }
    if (!name) continue;
    seen.add(mm[1] + mm[2]);
    const mono = inner.match(/class\s*=\s*"[^"]*font-mono[^"]*"[^>]*>([^<]*)</i);
    const y = (mono ? mono[1] : stripTags(inner)).match(/\b(19\d\d|20\d\d)\b/);
    out.push({ kind: mm[1], slug: mm[2], name, poster: fixImage(attr(img, "src") || attr(img, "data-src")), year: y ? +y[1] : undefined });
  }
  return out;
}

function addLinks(t, list) { for (const l of list) if (l && l.url && !t.some((x) => x.url === l.url)) t.push(l); }
function extractRsc(html) {
  let details = null;
  const episodes = new Map(), links = [];
  const re = /self\.__next_f\.push\(\[1,"([\s\S]*?)"\]\)/g;
  let combined = "", m;
  while ((m = re.exec(html))) { try { combined += JSON.parse(`"${m[1]}"`); } catch { combined += m[1]; } }
  for (const line of combined.split("\n")) {
    const payload = line.trim().replace(/^[0-9a-fA-F]+:/, "");
    if (!payload.startsWith("{") && !payload.startsWith("[")) continue;
    let root; try { root = JSON.parse(payload); } catch { continue; }
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
        if (Array.isArray(n.episodes)) for (const ep of n.episodes) {
          if (!ep || typeof ep !== "object") continue;
          const key = `${ep.season_number ?? 1}:${ep.episode_number ?? 1}`;
          const ex = episodes.get(key);
          if (!ex || ((ep.links || []).length && !(ex.links || []).length)) episodes.set(key, ep);
        }
        for (const v of Object.values(n)) queue.push(v);
      } else for (const v of n) queue.push(v);
    }
  }
  const eps = [...episodes.values()].sort((a, b) => (a.season_number ?? 1) - (b.season_number ?? 1) || (a.episode_number ?? 1) - (b.episode_number ?? 1));
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
  const clean = html.replace(/\\"/g, '"').replace(/\\\\/g, "\\").replace(/\\\//g, "/");
  const re = /https?:\/\/[^\s"'\\<>]+?\.(?:mp4|mkv|m3u8)/g;
  let m;
  while ((m = re.exec(clean))) {
    const u = m[0];
    if (/\.audio\./i.test(u) || out.some((o) => o.url === u)) continue;
    out.push({ url: u, quality: detectQuality(u), source: /ftp\./i.test(u) ? "Server A" : /data\./i.test(u) ? "Server B" : "Server" });
  }
  return out;
}
const compactLinks = (links) => (links || []).filter((l) => l.url).map((l) => ({
  url: fixUrl(l.url),
  quality: l.quality || detectQuality(l.url),
  source: l.source || "Server",
  subs: (l.subtitle_tracks || []).filter((t) => t.url).map((t) => ({ url: fixUrl(t.url), label: t.label || t.language || "English" }))
}));

const idOf = (c) => `ctg:${c.kind}:${c.slug.replace(/\//g, "~")}`;

async function buildItem(card) {
  const html = await getText(`${MAIN}/${card.kind}/${card.slug}`);
  const { details: d, episodes, links } = extractRsc(html);
  const det = d || {};
  const yt = det.trailer_url ? String(det.trailer_url).match(/(?:embed\/|v=)([\w-]{11})/) : null;
  const item = {
    id: idOf(card), kind: card.kind, slug: card.slug,
    name: det.title || det.name || card.name,
    poster: fixImage(det.poster_url) || card.poster,
    backdrop: fixImage(det.backdrop_url),
    year: det.year || card.year,
    overview: det.overview || undefined,
    rating: det.imdb_rating || det.rating || undefined,
    genres: det.genres ? String(det.genres).split(",").map((g) => g.trim()).filter(Boolean) : undefined,
    runtime: det.runtime || undefined,
    imdb: det.imdb_id || (html.match(/["']imdb_id["']\s*:\s*["'](tt\d+)["']/) || [])[1],
    tmdb: det.tmdb_id != null ? String(det.tmdb_id) : (html.match(/["']tmdb_id["']\s*:\s*(\d+)/) || [])[1],
    trailer: yt ? yt[1] : undefined
  };
  if (card.kind === "movies") item.links = compactLinks(links.length ? links : fallbackLinks(html));
  else item.episodes = episodes.map((ep) => ({
    s: ep.season_number ?? 1, e: ep.episode_number ?? 1, name: ep.name || undefined, overview: ep.overview || undefined,
    still: fixImage(ep.still_url), air: ep.air_date || undefined, links: compactLinks(ep.links)
  }));
  return item;
}

function readData() {
  try { return JSON.parse(fs.readFileSync(OUT, "utf8")).items || []; } catch {}
  try { return JSON.parse(zlib.gunzipSync(fs.readFileSync(OUT_GZ)).toString()).items || []; } catch {}
  return [];
}
const save = (items, final) => {
  if (final) {
    // kichu na bodlale file chhui na (jate GitHub/Vercel-e faltu deploy na hoy)
    try { if (JSON.stringify(readData()) === JSON.stringify(items)) { console.log("Kichu bodlayni, save lagbe na."); return; } } catch {}
  }
  const json = JSON.stringify({ updated: new Date().toISOString(), items });
  fs.writeFileSync(OUT, json);
  if (final) fs.writeFileSync(OUT_GZ, zlib.gzipSync(json, { level: 6 }));
};

const LOCK = path.join(__dirname, "scrape.lock");
function acquireLock() {
  try {
    if (fs.existsSync(LOCK) && Date.now() - fs.statSync(LOCK).mtimeMs > 12 * 3600 * 1000) fs.unlinkSync(LOCK);
    fs.writeFileSync(LOCK, String(process.pid), { flag: "wx" });
    return true;
  } catch { return false; }
}
function releaseLock() { try { fs.unlinkSync(LOCK); } catch {} }
process.on("exit", releaseLock);

async function run(mode, maxPages) {
  const items = readData();
  const have = new Map(items.map((i) => [i.id, i]));
  console.log(`[${mode}] data.json-e age theke ache: ${items.length} ta\n`);

  const cards = [];
  for (const [kind, p] of SECTIONS) {
    const seenSlugs = new Set();
    for (let page = 1; page <= maxPages; page++) {
      let found;
      try { found = parseCards(await getText(`${MAIN}${p}?page=${page}`)).filter((c) => c.kind === kind); }
      catch (e) { console.log(`[${kind}] page ${page} khule nai: ${e.message}`); break; }
      const fresh = found.filter((c) => !seenSlugs.has(c.slug));
      if (!fresh.length) break;
      fresh.forEach((c) => { seenSlugs.add(c.slug); cards.push(c); });
      console.log(`[${kind}] page ${page}: +${fresh.length} (mot ${seenSlugs.size})`);
      await sleep(300);
    }
  }
  if (!cards.length) {
    console.log("\nPROBLEM: kono movie paoa jayni (site bondho ba block). Kichu bodlano hoyni.");
    return false;
  }

  const newCount = cards.filter((c) => !have.has(idOf(c))).length;
  const todo = cards.filter((c) => {
    const o = have.get(idOf(c));
    if (!o) return true;
    if (!(o.links?.length || o.episodes?.length)) return true;
    if (mode === "update" && c.kind !== "movies") return true; // naya episode ache kina
    return false;
  });
  console.log(`\nNotun item: ${newCount} ta. Detail page anbo: ${todo.length} ta`);

  let done = 0, failed = 0, idx = 0;
  const worker = async () => {
    while (idx < todo.length) {
      const c = todo[idx++];
      try {
        const it = await buildItem(c);
        const old = have.get(it.id);
        const hasData = it.links?.length || it.episodes?.length;
        if (hasData || !old) have.set(it.id, it);
      } catch (e) { failed++; console.log(`  fail ${c.kind}/${c.slug}: ${e.message}`); }
      done++;
      if (done % 10 === 0) { console.log(`  ${done}/${todo.length}`); save([...have.values()]); }
      await sleep(250);
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);

  // newest (site-er listing order) upore, baki purano item gulo niche (kichu hariye jay na)
  const order = cards.map(idOf);
  const inCards = new Set(order);
  const result = [
    ...order.map((id) => have.get(id)).filter(Boolean),
    ...[...have.values()].filter((i) => !inCards.has(i.id))
  ];
  save(result, true);
  const withLinks = result.filter((i) => i.links?.length || i.episodes?.some((e) => e.links.length)).length;
  console.log(`\nDONE. ${result.length} ta item save hoyeche (${withLinks} ta-te stream link ache, ${failed} ta fail, ${newCount} ta notun).`);
  console.log(`File: ${OUT}`);
  if (!withLinks) console.log("WARNING: kono stream link paoa jayni. Ei lekha ta Claude-ke pathao.");
  return true;
}

async function main(opts = {}) {
  const arg = process.argv[2];
  const mode = opts.mode || (arg === "update" ? "update" : "scrape");
  const maxPages = mode === "update" ? (opts.pages || 3) : (opts.maxPages || parseInt(arg, 10) || 9999);
  if (!acquireLock()) { console.log("Ekta scrape ageri cholche (scrape.lock). Shesh hole abar chalao."); return false; }
  try { return await run(mode, maxPages); } finally { releaseLock(); }
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
module.exports = { main, parseCards, extractRsc, readData };
