# Saved Prompts, Loop Mode, Storage Split, Thinking Presets, UI Cleanup — Design

**Status:** Approved 2026-05-21

## Goals

1. Save & reload named Idea Descriptions and named Generation Prompts.
2. Add Loop Mode that can run unattended overnight, accumulating found domains and feeding back seen-stems to avoid regeneration.
3. Make `thinking` and `effort` per-slot configurable (Off / Balanced / Max) so the user controls cost vs quality.
4. Split storage so heavy writes don't rewrite the whole state blob.
5. Add `claude-haiku-4-5` to the model dropdown.
6. Strip GitHub/marketing UI cruft now that this is personal use.

## Non-goals

- Server-side loop. Loop is client-side. User keeps Mac awake themselves.
- Multi-device sync.
- A real database. Files are good enough.
- Auth on the local server.

---

## §1 — Storage split

Single `state.json` becomes three files. Each tracked by mutation frequency so heavy writes don't rewrite cold data.

| File | Contents | Write frequency | Approx size |
|---|---|---|---|
| `config.json` | settings (API key, prompts, presets, loop config), saved idea library, saved prompt library | rarely | ~5–20 KB |
| `db.json` | domains, sets, seenStems, domainWeights | every search/loop tick | 10 KB – 1 MB |
| `loop-log.jsonl` | append-only log: one JSON line per loop iteration (timestamp, iteration #, names returned, available count, errors) | once per loop tick | grows linearly |

### Server endpoints (`server.js`)

- `GET /api/config`, `PUT /api/config`
- `GET /api/db`, `PUT /api/db`
- `POST /api/loop-log` (appends one line; body = one JSON object)
- `GET /api/loop-log?after=<iso>` (streams lines newer than timestamp; for the UI panel)
- Static-file serving unchanged.
- Atomic write semantics preserved (temp file + rename) on config and db.
- `loop-log.jsonl`: append-only via `Bun.write` with append flag; rotate to `loop-log-YYYY-MM-DD.jsonl` when size exceeds 10 MB.

### Client storage (`js/storage.js`)

- `_state.config` and `_state.db` populated by `hydrate()` calling both endpoints in parallel.
- Mutations routed by key: `settings.*` + library entries → flush config; `domains` / `sets` / `seenStems` / `domainWeights` → flush db.
- Same 200ms debounce per file (independent timers).
- Migration from current `state.json`: on first hydrate, if `config.json` and `db.json` don't exist but `state.json` does, split it once and delete the legacy file.

---

## §2 — Thinking + Effort presets (per slot)

### Preset definitions

| Preset | Anthropic request body |
|---|---|
| **Off** (default) | `max_tokens: 4096` (Opus/Sonnet) or `2048` (Haiku); no `thinking`, no `output_config` |
| **Balanced** | `max_tokens: 16000`; `thinking: {type: "adaptive"}`; `output_config: {effort: "medium"}` |
| **Max** | `max_tokens: 24000` (Opus 4.7) / `20000` (Opus 4.6) / `16000` (Sonnet 4.6); `thinking: {type: "adaptive"}`; `output_config: {effort: "xhigh"}` (Opus 4.7) / `"max"` (others) |

### Model × preset support matrix

| Model | Off | Balanced | Max |
|---|:-:|:-:|:-:|
| `claude-opus-4-7` | ✅ | ✅ | ✅ (`xhigh`) |
| `claude-opus-4-6` | ✅ | ✅ | ✅ (`max`) |
| `claude-sonnet-4-6` | ✅ | ✅ | ✅ (`max`) |
| `claude-haiku-4-5` | ✅ | ❌ | ❌ |
| OpenAI / Groq models | ✅ | ❌ | ❌ |

Switching from a thinking-capable model to Haiku/OpenAI/Groq while a non-Off preset is selected auto-falls-back to Off with a one-time toast: *"<Model> doesn't support extended thinking — preset reset to Off."*

### UI

Each model slot row gets a sibling preset `<select>`. When the selected model doesn't support presets, the dropdown is disabled and shows "Off" only.

### Slots

Four independent slots in settings:

- **Creative**: model + preset (used by generation, synonyms, associations)
- **Scoring**: model + preset (used by fit batch)
- **Loop generation**: model + preset (default inherits Creative model, preset Off)
- **Loop scoring**: model + preset + an "enabled" toggle (default disabled — overnight scoring is wasteful)

### Defaults out of the box

- Creative: Opus 4.7, **Off**
- Scoring: Opus 4.7, **Off**
- Loop generation: Opus 4.7, **Off**
- Loop scoring: **disabled**

### Cost guardrails

- **Cost-tier badge** in the UI for each slot: 🟢 Off / 🟡 Balanced / 🔴 Max
- On loop start with any 🔴 slot active: confirmation modal *"Loop mode with Max preset can cost $100+ overnight. Continue?"*
- Live loop status surfaces a running token-cost estimate based on `response.usage` totals.

### Response parsing (already in place from hotfix)

```js
const textBlock = data.content?.find(b => b.type === 'text')
if (!textBlock?.text) throw new Error('Empty response from AI (stop_reason: ' + (data.stop_reason || 'unknown') + ')')
return textBlock.text
```

Handles thinking-block ordering for adaptive thinking and surfaces `stop_reason` when text is missing.

---

## §3 — Saved prompts & saved ideas libraries

### Data shape (in `config.json`)

```json
{
  "ideas": [
    { "id": "id_abc", "name": "OrderGuard rename", "text": "...", "createdAt": "…", "updatedAt": "…" }
  ],
  "prompts": {
    "generation": [
      { "id": "p_def", "name": "Brand-leaning", "text": "...", "isBuiltin": false, "createdAt": "…" }
    ],
    "scoring": [...],
    "synonym": [...],
    "association": [...]
  }
}
```

The four built-in `DEFAULT_*_PROMPT` exports remain in `js/generate.js` as seed entries in the library — flagged `isBuiltin: true`, non-deletable but forkable.

### UI

- **Idea Description textarea** gets a dropdown above it: *"Load saved idea ▾"* with each entry + "Save current as…" + "Update current" buttons.
- **System Prompt textareas** (all 4: generation, scoring, synonym, association) get the same treatment.
- "Save current as…" opens a small inline name-prompt rather than a modal.
- A separate **"Manage library"** collapsible section in settings lists all saved entries grouped by type, with rename / delete / duplicate.

---

## §4 — Loop Mode (client-side)

### Driver

```js
let _loopActive = false
let _loopController = null

async function loopTick() {
  while (_loopActive) {
    const start = Date.now()
    try { await runOneLoopIteration() }
    catch (e) { logLoopError(e) }
    const elapsed = (Date.now() - start) / 1000
    const wait = Math.max(0, getSetting('loopInterval') - elapsed)
    if (_loopActive) await sleep(wait * 1000)
  }
}
```

Recursive scheduling (next tick runs `interval` seconds AFTER current finishes, not from start). One in-flight tick at any time. Stop button flips `_loopActive` and the next sleep returns immediately.

### Per-tick algorithm

1. Read current loop settings + active idea description + active generation prompt
2. Build the system prompt: substitute `{{count}}` with batch size and `{{seen}}` with comma-joined last N seen stems
3. Call `generateDomainNames` with the loop's Creative model + preset
4. Filter returned stems against full seen-set (belt-and-suspenders dedup)
5. Append all returned stems to `db.seenStems`
6. For each surviving stem × active zones, call `checkDomainAvailable` (uses the existing 6-worker pool)
7. Available results → `db.domains` with `loopRunId` tag for filtering later
8. If Loop scoring is enabled, batch-score available results
9. `POST /api/loop-log` with: timestamp, iteration #, generated count, available count, error count, total cost estimate

### Settings (new keys in `config.json.settings`)

| Key | Default | Range |
|---|---|---|
| `loopEnabled` | false | bool |
| `loopInterval` | 30 | 10–600 sec |
| `loopMaxIterations` | null | null = unlimited |
| `loopMaxHours` | null | null = unlimited |
| `maxSeenStems` | 200 | 50–2000 |
| `loopCreativeModel` | (inherits Creative) | dropdown |
| `loopCreativePreset` | Off | Off / Balanced / Max |
| `loopScoringEnabled` | false | bool |
| `loopScoringModel` | (inherits Scoring) | dropdown |
| `loopScoringPreset` | Off | dropdown |
| `loopActiveIdeaId` | (current) | dropdown |
| `loopActivePromptId` | (current generation prompt) | dropdown |

### Seen-stem dedup

- `db.seenStems` = string array of every stem ever returned
- Per tick: serialize the **last `maxSeenStems`** (default 200) as comma-separated, inject as `{{seen}}` placeholder
- Generation prompt template gets a new optional section the user can include: *"Do NOT repeat any of these previously-generated stems: {{seen}}"* — only rendered when `{{seen}}` is non-empty
- Client-side dedup always runs after the call (filters returned stems against the full seenStems set)

### UI

New collapsible **"Loop Mode"** section in settings:

- Big Start/Stop button
- Interval slider (10s–10min)
- Max iterations / max hours inputs (blank = unlimited)
- Max seen stems input
- Loop model + preset dropdowns (with the cost-tier badge)
- Loop scoring toggle + model/preset
- Idea + prompt to use (dropdowns from libraries)
- Live status panel: *"Running — iteration 47/∞, found 12 / 2,820 seen, ETA next run 23s, est. cost so far $1.42, started 2h 18m ago"*
- Mini event log (last 20 entries from `/api/loop-log?after=<since-start>`)

### Found-domains export

New "Export available domains" button on the existing Available section: downloads `available-{timestamp}.json` with full records. Optional filter by `loopRunId` to export just one overnight run.

### Failure handling

- API 429 / 5xx → exponential backoff (2x interval) for that tick, then resume normal
- API 400 (e.g. malformed prompt with too-long seen-list) → stop loop, surface error
- Network blip → log to `loop-log.jsonl`, continue
- Browser tab put to background → JS still runs but throttled by macOS; that's the user's problem (they confirmed they handle Mac sleep themselves)

---

## §5 — UI Cleanup

Strip from `index.html`:

- "100% private. All your data stays in your browser…" banner (materially false now, state lives on disk via server)
- "Open source · View code on GitHub" line in the header
- "Star on GitHub" button + `api.github.com` stargazer fetch
- "Report Bug" button
- Footer GitHub link
- "How It Works" 3-step explainer (already dismissible; remove entirely)

Add `claude-haiku-4-5` to Anthropic model dropdown options array.

---

## Implementation work units

Three independent units, all parallelizable:

1. **Storage split + server endpoints** (`server.js` + `js/storage.js`) — coherent unit since they share wire format. Also handles `state.json` → `config.json` + `db.json` migration.
2. **Thinking presets + saved-prompt libraries + UI cleanup** (`index.html` + `js/app.js` + `js/generate.js`) — touches all three but tightly coupled (preset UI feeds preset values into generate.js; library UI feeds settings.activeIdeaId/activePromptId into the existing call sites).
3. **Loop mode** (`js/app.js` only, after unit 2 is in place) — depends on libraries (active idea/prompt) and presets (loopCreativePreset) existing.

Units 1 and 2 run in parallel. Unit 3 runs after both merge.

## Verification

- `bun server.js` serves the app, creates `config.json` + `db.json` on first save.
- Legacy `state.json` auto-splits and is deleted.
- Default config (everything Off) produces single search at expected cost (~$0.02 on Opus 4.7).
- Switching Creative to Balanced/Max increases per-search cost as expected and `response.usage.cache_creation_input_tokens` / `output_tokens` are visible.
- Switching to Haiku auto-falls-back to Off with toast.
- Saving an Idea / Prompt persists across server restart.
- Loop mode: start → see iterations log in real time → stop → all available domains landed in DB → export downloads the JSON.
- Loop with Max preset: confirmation modal fires.
