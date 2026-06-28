# AnlıkHaber Backend

Turkish news RSS bot + JSON API. Fetches RSS feeds, rewrites/enriches items via
the Claude API, and auto-publishes to X (Twitter), Telegram, and an email
newsletter. Single Node/Express process, deployed on Railway.

## Commands
- Run: `npm start` (= `node server.js`) — there is no dev/watch script
- Install: `npm install` (needs build toolchain for `better-sqlite3` native module)
- Test / lint / typecheck / build: **none configured** — plain JS, no test suite

## Layout
- `server.js` — the monolith: Express app, all `/api/*` routes, ~10 `cron.schedule`
  jobs (RSS fetch, sentiment, deep analysis, polls, market data, newsletter)
- `server_patch.js` — `anlikHaberModulleriniBaslat(app, twitterClient)`, wires the
  `modules/` into the running app; required at the top of `server.js`
- `modules/` — feature units: `multiformat`, `rssHealth`, `scheduler`,
  `engagement`, `newsletter`, `adminBot` (Telegram admin commands)
- `db/init.js` — better-sqlite3 schema + helpers (engagement, publish queue,
  newsletter log). DB at `data/anlikhaber.db` (dir auto-created, WAL mode)
- `config/rss_sources.json`, `config/amplifier.json` — feed list & tuning
- `anlikhaber_com.html` — static frontend reference (served by `GET /`)

## Gotchas
- **News articles live in memory** (`let haberler = []`, capped ~500), NOT in
  sqlite. A restart drops all current news; sqlite only holds engagement/queue/
  newsletter data. Don't assume `/api/haberler` is backed by the DB.
- All publishing/AI work runs on crons that fire on a schedule — running locally
  will hit X/Telegram/Brevo/Claude live if the env vars are set.
- Env vars (set in Railway dashboard, never committed): `CLAUDE_API_KEY`,
  `X_API_KEY/_SECRET`, `X_ACCESS_TOKEN/_SECRET`, `TELEGRAM_TOKEN/_KANAL/_GRUP`,
  `ADMIN_TELEGRAM_USER_IDS`, `BREVO_API_KEY`, `IMAGE_PROMPT_ACTIVE`, `PORT`.
- Claude models are pinned as constants near the top of `server.js`
  (`MODEL_HAIKU`, `MODEL_SONNET`) — change them there, not inline.
- Deploy: push to GitHub → Railway auto-deploys. See @README.md for setup.
