# domainsearcher

**Local-first domain name finder and scorer — Bun server, JSON storage, bring your own AI key.**

A self-hosted, locally-run tool that generates startup/product domain names with AI, checks their availability against live registry data, and scores the best candidates across six dimensions. The frontend is a single-page app served by a small Bun server; all of your data lives in plain JSON files on disk. Run it yourself with your own AI key — no account, and the only backend is the local Bun server that persists your JSON state.

## What it does

- **AI domain search** — describe an idea, pick one or more TLD zones, and the app generates a batch of brandable names (default 60, range 10–200) and checks each one for availability across your selected zones. Results stream in live with a running cost estimate; an interrupted search can be resumed.
- **Quick check** — look up a specific name across chosen check-zones, with an optional "+ synonyms" toggle that asks the AI for related words and checks those too.
- **Favorites & super-favorites** — star any result to move it into the scored/ranked Favorites list; double-star to pin "super favorites" to the top. Copy, clear, or save the set.
- **Six-dimension scoring** — every favorite is scored on length, pronounceability, memorability, brandability, zone availability, and fit-to-idea, then ranked by a weighted total with editable per-dimension weights.
- **Saved sets, available list, and history** — store named snapshots of favorites, browse all available non-favorite domains, and review the full search history. Each view has rich filters (text, length, no-numbers, date ranges, from-last-search) and pagination.
- **Loop mode** — an unattended "overnight search" that repeatedly generates, checks, and (optionally) scores names on a timer, accumulating results and an audit log.

## How scoring works

Each favorite is scored 0–10 on six dimensions. The weighted **TOTAL** = Σ(score × weight), with a maximum of Σ(weights) × 10. Weights are editable integers in the UI; changing one re-ranks live and persists.

| Dimension | What it measures | Source | Default weight |
|---|---|---|---|
| **LEN** | Length — peaks at 5 characters, tapering for shorter/longer names | Local heuristic | 1 |
| **PRO** | Pronounceability — syllables, consonant clusters, digits, doubled letters | AI when available, else local heuristic | 2 |
| **MEM** | Memorability — rewards short, punchy names; penalizes generic words and digits | AI when available, else local heuristic | 2 |
| **BRD** | Brandability — rewards invented/unique forms and good vowel ratio; penalizes generic compounds and digits | AI when available, else local heuristic | 2 |
| **ZON** | Zones — fraction of selected "compare zones" that are available, ×10 | Local (live availability cache) | 1 |
| **FIT** | Fit to the idea — how well the name suits your described idea/product | AI only (from the FIT context); 0 until AI-scored | 5 |

LEN and ZON are always computed locally. PRO/MEM/BRD use AI scores when present and fall back to local heuristics otherwise. FIT is the only strictly-AI dimension and carries the highest default weight.

## Availability checking

Availability is checked **client-side from the browser** using a two-stage approach (`js/check.js`), with no proxy or server involvement:

1. **RDAP first.** Per-TLD requests are routed to the authoritative RDAP server. A static map seeds the top TLDs (com/net → Verisign, org → PIR, io/ai/sh → Identity Digital, co → nic.co, app/dev → registry.google, xyz → CentralNic), and the IANA bootstrap (`data.iana.org/rdap/dns.json`) fills in the rest; unknown TLDs fall back to `rdap.org`. A `200` means **taken**; a `404` is confirmed via DNS.
2. **DNS-over-HTTPS confirmation.** Cloudflare (`cloudflare-dns.com`) and Google (`dns.google`) are queried in parallel. NXDOMAIN → available; A/AAAA/CNAME/NS answers or NS/SOA authority records → taken. On disagreement the conservative "taken" answer wins.

Any TLD works — there is no fixed allow-list for checking. RDAP requests retry on 429/5xx with backoff. Because these are direct browser `fetch` calls, the RDAP and DoH endpoints must support CORS.

## Architecture

- **Frontend** — a static single-page app: `index.html` plus ES-module JavaScript in `js/` (`app.js`, `generate.js`, `check.js`, `storage.js`).
- **Server** — `server.js`, a small **Bun** server (default port `3000`). It serves the static files from the working directory and exposes a handful of JSON state endpoints. AI calls and availability checks still go directly from the browser to external APIs — the server only handles persistence and the loop audit log.
- **Storage** — server-side JSON files on disk:
  - `config.json` — settings, AI model/preset selection, search zones, and the saved-idea / saved-prompt libraries (the "cold" rarely-written state).
  - `db.json` — domains, saved sets, seen-stems, and scoring weights (the "hot" frequently-written state).
  - `loop-log.jsonl` — append-only NDJSON audit log of loop iterations, rotated past 10 MB.

  All three are git-ignored as local runtime data. The browser keeps state in memory and flushes it to the server with debounced `PUT`s. A legacy `/api/state` endpoint and `state.json` exist only as a one-time migration shim; localStorage is now just a migration source/fallback, not the system of record.

### Server endpoints

| Method + path | Behavior |
|---|---|
| `GET /api/config` | Returns `config.json` (or `{}`). |
| `PUT /api/config` | Atomically overwrites `config.json`. |
| `GET /api/db` | Returns `db.json` (or `{}`). |
| `PUT /api/db` | Atomically overwrites `db.json`. |
| `POST /api/loop-log` | Appends one validated JSON line to `loop-log.jsonl` (rotates first if > 10 MB). |
| `GET /api/loop-log` | Streams the NDJSON log; optional `?after=<ISO>` filters by `timestamp`. |
| `GET /api/state` | Legacy shim: merges config + db into the old single-blob shape. |
| `PUT /api/state` | Deprecated, ignored. |
| `DELETE /api/state` | Removes legacy `state.json` (finishes migration). |
| any other path | Static file lookup under the working directory (404 if missing). |

Environment overrides: `PORT`, `CONFIG_PATH`, `DB_PATH`, `LOG_PATH`, `STATE_PATH`.

## Running it locally

There is **no `package.json`** and there are **no dependencies to install** — the only non-Bun import is the built-in `node:fs/promises`. You do need [Bun](https://bun.sh) installed (the code relies on `Bun.serve`, `Bun.file`, `Bun.write`, and `Bun.$`; plain Node will not run it).

```sh
bun server.js
```

Then open <http://localhost:3000>. To use a different port:

```sh
PORT=8080 bun server.js
```

API keys and model choices are configured at runtime through the app's Settings panel (persisted to `config.json`) — not via environment variables.

## How to use

1. Run `bun server.js` and open the app.
2. In **Settings → AI models & batch size**, add at least one provider API key (Groq, OpenAI, or Anthropic) and pick your Creative and Scoring models and presets.
3. On the main screen, describe your idea, select TLD zones, and click **Search Domains**. Watch names stream in with availability and a live cost estimate.
4. Star the names you like. They move into **Favorites**, where they're scored and ranked. Fill in the **FIT context** and click **Score AI** to get FIT/PRO/MEM/BRD scores; tune the per-dimension weights to re-rank.
5. Save favorites into a named **set**, browse **Available Domains**, or review **Search History** — each with filters and export.

## Loop mode

Loop mode is an unattended search that runs **in the browser tab** (there is no server-side scheduler or worker — it only runs while the tab is open). Click **Start Loop** to begin; each iteration (`runOneLoopIteration`):

1. Generates a batch of name stems from the active idea and generation prompt, injecting up to `loopMaxSeenStems` recent stems as a "do not repeat" list (via a `{{seen}}` placeholder).
2. Filters out already-seen stems and appends new ones to the capped (most-recent-4000) `seenStems` list.
3. Checks availability across the selected zones at concurrency 6 and upserts every record into `db.json` with run/idea/prompt provenance.
4. Optionally AI-scores newly available domains (off by default).
5. Accumulates a running cost estimate and `POST`s a summary line to `/api/loop-log`.

Pacing waits `loopInterval` seconds between iterations (minimum 10), with exponential backoff on 429/5xx errors and a stop on a 400 (prompt too long). It honors `loopMaxIterations` and `loopMaxHours` stop conditions, and the status panel updates each second with iteration/found/seen counts, elapsed time, and cost. A confirmation warns that the Max preset can cost $100+ overnight.

## AI providers & API keys

AI generation, synonyms, associations, and FIT/PRO/MEM/BRD scoring are called **directly from the browser** (`js/generate.js`). The provider is chosen by **model-name prefix**:

- **Anthropic** — models starting with `claude-` (e.g. Opus 4.7/4.6, Sonnet 4.6, Haiku 4.5). Sent to `api.anthropic.com/v1/messages` with the `anthropic-dangerous-direct-browser-access` header. Requires your own key.
- **OpenAI** — models starting with `gpt-` or matching `o<n>` (e.g. GPT-5.5/5.4 and variants, o4-mini, GPT-4o). Sent to `api.openai.com/v1/chat/completions`. Requires your own key.
- **Groq** — the fallback for anything else (default `llama-3.3-70b-versatile`), via the OpenAI-compatible `api.groq.com/openai/v1` endpoint.

Keys are entered in the Settings panel, stored client-side in `config.json`, and resolved per-model. There is **no bundled production key in the source** — the source contains a `__GROQ_API_KEY__` placeholder that is only substituted at deploy time, so you supply your own key. Anthropic and OpenAI calls throw a 401 if no key is set.

### Presets and model selection

Every model selector (Creative, Scoring, and the separate Loop generation/scoring selectors) has an **Off / Balanced / Max** thinking preset with a cost badge (Off = cheapest/no thinking, Balanced ≈ 5–10×, Max ≈ 10–20×). Off is the default everywhere; non-thinking models have Balanced/Max disabled and auto-reset to Off. `max_tokens` values are caps, not targets, and scale with the preset. The app tracks per-call token usage to surface a running cost estimate, and detects responses truncated by the token cap.

## Project layout

Tracked files:

```
.gitignore
README.md
index.html
js/app.js        # UI, search/favorites/scoring/loop orchestration
js/check.js      # availability checking (RDAP + DoH)
js/generate.js   # AI generation/scoring (Anthropic/OpenAI/Groq)
js/storage.js    # in-memory state + debounced flush to the server
server.js        # Bun server: static files + JSON state endpoints
```

Local runtime data (git-ignored, created on first run):

```
config.json      # settings + idea/prompt libraries
db.json          # domains, sets, seen-stems, weights
loop-log.jsonl   # append-only loop audit log
```

## Tech stack

- **Runtime:** Bun (server), modern browser (frontend ES modules)
- **Frontend:** vanilla HTML/CSS/JavaScript, no framework, no build step
- **Storage:** plain JSON files on disk (atomic writes for config/db, append-only NDJSON for the loop log)
- **External services (browser-side):** Anthropic / OpenAI / Groq for AI; RDAP registries + Cloudflare/Google DNS-over-HTTPS for availability
