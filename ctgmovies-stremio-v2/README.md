# CTGMovies Stremio addon

Flow: `scraper.js` (your PC) -> `data.json.gz` -> GitHub -> workflow -> Cloudflare Worker (D1)
      Cloudflare cron (every 6h) adds new movies -> Vercel addon reads from the Worker -> Stremio

- `api/`            Vercel addon (manifest, catalog, meta, stream)
- `worker/`         Cloudflare Worker (D1 database, API, 6-hour cron scraper)
- `scripts/`        import script used by the GitHub workflow
- `.github/workflows/import-to-cloudflare.yml`  imports data.json.gz to Cloudflare when it changes
- `scraper.js`      run on your PC: `node scraper.js` (full) or `node scraper.js update`
- `live.js`         optional helper (not used)

See SETUP.md for the step by step.
