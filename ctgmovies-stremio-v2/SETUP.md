# Setup (one time)

## 1. Cloudflare D1 database
Cloudflare dashboard -> Storage & Databases -> D1 -> Create database, name: `ctgmovies`.
Copy the Database ID and paste it into `worker/wrangler.toml` (`database_id`).
The tables are created automatically on first request.

## 2. Deploy the Worker from GitHub
Cloudflare dashboard -> Workers & Pages -> your `ctgmovies-api` worker -> Settings -> Builds -> Connect to Git
(or Create -> Import a repository). Choose this repo.
- Root directory: `worker`
- Build command: leave empty
- Deploy command: `npx wrangler deploy`

## 3. Admin token (secret)
Worker -> Settings -> Variables and Secrets -> Add -> type **Secret**
- Name: `ADMIN_TOKEN`  Value: a long random string (keep a copy)

## 4. GitHub secrets
GitHub repo -> Settings -> Secrets and variables -> Actions -> New repository secret
- `WORKER_URL`  = https://ctgmovies-api.proshantobarua70-4a5.workers.dev   (no trailing slash)
- `ADMIN_TOKEN` = same value as in step 3

## 5. First import
Run `node scraper.js` on your PC, then commit and push `data.json.gz`.
The workflow "Import data to Cloudflare" runs by itself (or run it from the Actions tab).

## 6. Check
- `<worker-url>/ping` shows the item count and last cron result
- Test the scraper without waiting 6 hours:
  curl -X POST -H "Authorization: Bearer YOUR_TOKEN" <worker-url>/admin/run
- Deploy the Vercel project (api/). Optional env var `WORKER_URL` if the Worker URL changes.

New movies show up in Stremio about 5-15 minutes after the Worker adds them (Vercel cache).
