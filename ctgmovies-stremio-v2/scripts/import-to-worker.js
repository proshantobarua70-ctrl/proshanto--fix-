// Reads data.json.gz and uploads it to the Cloudflare Worker (D1).
// Used by .github/workflows/import-to-cloudflare.yml
// Env: WORKER_URL, ADMIN_TOKEN
const fs = require("fs");
const zlib = require("zlib");
const path = require("path");

const WORKER_URL = (process.env.WORKER_URL || "").replace(/\/+$/, "");
const TOKEN = process.env.ADMIN_TOKEN || "";
const FILE = path.join(__dirname, "..", "data.json.gz");
const MAX_ITEMS = 20;
const MAX_BYTES = 3_000_000;

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function post(body) {
  let last;

  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const res = await fetch(`${WORKER_URL}/admin/import`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TOKEN}`
        },
        body,
        signal: AbortSignal.timeout(60000)
      });

      const text = await res.text();
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
      return JSON.parse(text);
    } catch (e) {
      last = e;
      console.log(`  retry ${attempt}: ${e.message}`);
      await sleep(1500 * attempt);
    }
  }

  throw last;
}

async function main() {
  if (!WORKER_URL || !TOKEN) {
    throw new Error("WORKER_URL and ADMIN_TOKEN secrets are required");
  }
  if (!fs.existsSync(FILE)) throw new Error("data.json.gz not found");

  const data = JSON.parse(zlib.gunzipSync(fs.readFileSync(FILE)).toString());
  const items = Array.isArray(data.items) ? data.items : [];

  if (!items.length) throw new Error("data.json.gz has no items");

  console.log(`Importing ${items.length} items to ${WORKER_URL}`);

  let offset = 0;
  let imported = 0;

  while (offset < items.length) {
    const chunk = [];
    let bytes = 0;

    while (
      offset + chunk.length < items.length &&
      chunk.length < MAX_ITEMS &&
      bytes < MAX_BYTES
    ) {
      const item = items[offset + chunk.length];
      bytes += JSON.stringify(item).length;
      chunk.push(item);
    }

    const result = await post(JSON.stringify({ offset, items: chunk }));
    imported += result.imported || 0;
    offset += chunk.length;

    console.log(`  ${offset}/${items.length}`);
  }

  console.log(`Done. ${imported} items imported.`);
}

main().catch(e => {
  console.error("IMPORT FAILED:", e.message);
  process.exit(1);
});
