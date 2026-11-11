# axol

A short-video feed (Shorts / TikTok / Reels style) where **every clip is chosen by AI for one person**.
You tell axol what you love in plain language. It builds an interest profile, pulls short-form video
from YouTube Shorts, TikTok and Instagram Reels, and then rewrites that profile continuously from
how long you actually watch each clip.

```
web/     React + Vite — vertical snap feed, players, onboarding, taste profile
server/  Node 22 + Express + SQLite (built-in) — auth, sources, learner, ranker, Claude integration
docs/    ALGORITHM.md (how the engine works) · INVESTOR_BRIEF.md (the pitch)
```

## Run it

Requires Node 22.13+ (uses the built-in `node:sqlite`).

```bash
cp .env.example .env        # add keys (see below); the app runs without any
npm run install:all
npm run dev                 # server :3000 + web :5173 (proxied)
```

Open http://localhost:5173. Production: `npm run build && npm start` serves everything on :3000.

### Keys

| Key | What it unlocks | Without it |
|---|---|---|
| `ANTHROPIC_API_KEY` | Claude reads your intro, tags clips, and re-synthesizes your taste every ~12 clips | Keyword heuristics do the same job, less subtly |
| `YOUTUBE_API_KEY` | Automated Shorts discovery via the official Data API (free quota) | Clips arrive only from pasted links or a provider |
| `APIFY_TOKEN` | Automated TikTok search and Instagram Reels discovery through Apify's scrapers (`server/src/sources/apify.js`) | Paste TikTok / Reels links in the app; they're tagged and ranked like everything else |
| `AXOL_DISCOVERY_PROVIDER_URL` | Any other licensed provider via a simple JSON endpoint | Same fallback |

One YouTube key serves every user: queries are cached across users for 24 hours, the catalog is
pre-filled on boot (cheap trending calls plus a bounded set of topic searches), and a daily quota
budget pauses discovery gracefully instead of failing. For more than a handful of new users per day,
request a quota increase from Google (YouTube API Services quota extension form).

TikTok and Instagram expose embed players publicly but no third-party search API, so discovery on those
platforms goes through a data provider. The built-in one is Apify (TikTok: `clockworks/tiktok-scraper`
video search; Instagram: `apify/instagram-hashtag-scraper` keyword reels). Runs are asynchronous (start,
poll, read dataset), cost fractions of a cent per query, and carry a hard per-run spend cap
(`APIFY_MAX_USD_PER_RUN`, default $0.50, the minimum Apify accepts). A generic JSON provider hook
(`server/src/sources/provider.js`) is also available.
YouTube's official Data API covers Shorts search directly.

## What happens when you use it

1. **Sign up, write your intro.** Free text plus optional tags. Claude (structured output, zod schema)
   returns weighted interests, adjacent interests to explore, explicit dislikes, and 6–10 discovery
   queries per platform.
2. **Discovery runs.** Each query hits its source adapter; new clips are upserted and tagged by Claude
   (topic + format + vibe tags with relevance scores).
3. **The feed ranks.** Each unseen clip is scored: interest match + exploration bonus (UCB) + freshness
   + platform affinity + noise, then assembled with a diversity penalty and one deliberate "wild card".
4. **You watch.** The client reports real playback time (YouTube IFrame API) or dwell time (embeds)
   every 2s, plus likes, loops, shares, hides, and quick skips.
5. **It learns.** When a card leaves the screen the server computes an engagement score and nudges every
   tag on that clip, with a soft ceiling and global decay. The UI shows what it just learned.
6. **It re-thinks.** Every 12 clips, Claude re-reads the recent history and the weights, rewrites your
   taste summary, adjusts weights, adds exploratory interests, and issues new discovery queries.

Full details in [`docs/ALGORITHM.md`](docs/ALGORITHM.md).

## API (all JSON)

```
POST /api/auth/signup | login | logout     GET /api/auth/me
GET  /api/health
POST /api/onboarding            { text, chips[] }
GET  /api/feed?n=8              -> { items[{ impressionId, reason, embedKind, externalId, ... }] }
POST /api/events                { impressionId, type: progress|like|unlike|share|hide|skip|finish, watchedMs, durationMs, replays }
GET  /api/profile               POST /api/profile/refresh     POST /api/profile/interest { tag, action: boost|mute|remove }
POST /api/import                { text | urls[] }   # paste Shorts / TikTok / Reels links
```

## Tests

```bash
npm test     # engagement scoring, ranker ordering, avoid-list filtering, heuristic profiling
```

## Deploy (Netlify + Railway)

Netlify serves the web app; the Express/SQLite server runs on Railway with a persistent volume.

1. **Railway**: New Project → Deploy from GitHub → this repo. Settings → Root Directory `server`.
   Variables: `ANTHROPIC_API_KEY`, `YOUTUBE_API_KEY`, `AXOL_DB_PATH=/data/axol.sqlite`.
   Add a Volume mounted at `/data`. Generate a public domain; note the URL.
2. **Netlify**: Add new site → Import from GitHub → this repo. `netlify.toml` sets the build.
   Environment variable: `API_ORIGIN=https://<your-railway-domain>`. Deploy.

The build writes `_redirects` so `/api/*` on your Netlify domain proxies to Railway and the SPA
falls back to `index.html`. One-host alternative: skip Netlify, run `npm run build` and let the
server serve `web/dist` (it does so automatically when the folder exists).

## Notes

- Playback uses each platform's official embed player (YouTube IFrame API, TikTok embed v2,
  Instagram `/embed`). No video files are downloaded or rehosted.
- The interest model is per user and fully inspectable on the profile screen; any interest can be
  boosted, muted, or removed, and dislikes from onboarding are hard filters.
