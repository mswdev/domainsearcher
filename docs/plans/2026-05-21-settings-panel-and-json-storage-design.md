# Settings Panel + JSON-File Storage — Design

**Status:** Approved 2026-05-21

## Goals

1. Let the user choose a Claude model independently for the **Creative** path (name generation, synonyms, associations) and the **Scoring** path (fit/pro/mem/brd batch).
2. Make the **batch size** for name generation user-configurable (currently hardcoded to 60).
3. Move state off browser `localStorage` so it survives port changes, browser data clears, and switching browsers.

## Non-goals

- Multi-provider mixing (would need two API keys; YAGNI).
- Cloud sync, multi-device sync, multi-user.
- Per-task model overrides beyond Creative + Scoring (4 slots was rejected as overkill).
- Replacing the existing `app.js` / `storage.js` / `generate.js` API surface beyond the minimum required.

## Storage architecture

Tiny **Bun** server serves the static app and exposes a single JSON state endpoint.

### Server (`server.js`, new, ~40 lines)

- `GET /` and any other path → static file from CWD (replaces `npx serve`).
- `GET /api/state` → reads `state.json`, returns `{}` if absent.
- `PUT /api/state` → atomic write: temp file + rename.
- Env vars: `PORT` (default 3000), `STATE_PATH` (default `./state.json`).
- Run with `bun server.js`.

### Client storage (`js/storage.js`, refactor)

Switch from per-key sync `localStorage` to **single in-memory object + debounced server flush**.

- Module-level `_state = { settings: {}, domains: [], sets: [] }`.
- `await hydrate()` at app boot — `GET /api/state`, populate `_state`.
- Public API unchanged: `saveSetting(key, val)`, `loadSetting(key)`, `db.upsert/createSet/...` all operate on `_state` synchronously, then schedule a 200ms-debounced `PUT /api/state` of the whole blob.
- One-time migration: on hydrate, if `localStorage` has any `ds_s_*` keys (or `ds_domains` / `ds_sets`), copy them into `_state`, push to server, clear `localStorage`.

### `state.json` shape

```json
{
  "settings": {
    "aiApiKey": "sk-ant-…",
    "creativeModel": "claude-opus-4-7",
    "scoringModel": "claude-opus-4-7",
    "batchSize": 60,
    "description": "…",
    "fitContext": "…",
    "activeSearch": {…},
    "genPrompt": "…",
    "fitPrompt": "…",
    "assocPrompt": "…",
    "synonymPrompt": "…",
    "domainWeights": {…}
  },
  "domains": [...],
  "sets": [...]
}
```

Mirrors current `ds_s_*` / `ds_domains` / `ds_sets` keys 1:1.

## Model settings

### New settings keys (now `state.settings.*`)

- `creativeModel` — default `claude-opus-4-7`
- `scoringModel` — default `claude-opus-4-7`
- `batchSize` — default `60`

### Per-provider dropdown options

| Provider (detected from API key prefix) | Creative / Scoring options |
|---|---|
| Anthropic (`sk-ant-`) | `claude-opus-4-7` (default), `claude-opus-4-6`, `claude-sonnet-4-6` |
| OpenAI (`sk-`) | `gpt-4o` (default), `gpt-4o-mini` |
| Groq (none / `gsk_`) | `llama-3.3-70b-versatile` (default), `llama-3.1-8b-instant` |

Dropdowns re-populate when the API key changes.

## `generate.js` changes

1. `aiChat(messages, apiKey, model)` — accepts model override; ignores hardcoded model strings when `model` is provided.
2. **Anthropic provider only:** include `thinking: {type: "adaptive"}` and `output_config: {effort: "high"}` in the request body. Bump `max_tokens` to 8192 to give adaptive thinking headroom.
3. Response parsing: replace `data.content?.[0]?.text` with `data.content.find(b => b.type === 'text')?.text || ''` — adaptive thinking prepends thinking blocks.
4. `generateDomainNames(description, prompt, apiKey, model, batchSize)` — substitute `{{count}}` in the system prompt (default prompt updated to use `{{count}}` instead of literal `60`).
5. `scoreFitBatch`, `generateSynonyms`, `associateDomains` — all accept a `model` param threaded through to `aiChat`.

## UI (`index.html` + `app.js`)

New collapsible **AI Models** section directly under the existing AI Key input:

- `<select id="creativeModel">` — populated dynamically from provider
- `<select id="scoringModel">` — populated dynamically from provider
- `<input type="number" id="batchSize" min="10" max="200" step="10" value="60">`
- Helper text: "Creative = naming + synonyms. Scoring = fit/brand/memorability."
- All save-on-change via existing `saveSetting()`.

`app.js`:

- Read `creativeModel` / `scoringModel` / `batchSize` from settings, pass into the relevant `generate.js` calls (`startSearch`, `rescoreFit`, `generateSynonyms`, `associateDomains`).
- Wire change handlers for the 3 new inputs.
- Re-populate the model dropdowns when the API key changes.
- Wrap app init in `async function init() { await hydrate(); ...rest... }`.

## Out of scope (deliberately)

- Custom-model text-input override (use the dropdown).
- Showing thinking blocks in the UI (Opus 4.7 default `display: "omitted"`, so they don't render anyway).
- Server-side cost tracking.
- Auth on the local server (single-user local app).

## Edge cases

- **State load fails** → use empty state, show a non-blocking warning at top of UI.
- **Server flush fails** → retry once silently, then show a one-time warning. Don't block UI.
- **Saved invalid model id** (e.g. provider changed) → fall back to provider default.
- **batchSize** clamped to [10, 200] on input change.
- **API key cleared** → dropdowns fall back to Groq defaults.

## Implementation work units (parallelizable)

1. `server.js` (new) + `js/storage.js` (refactor + migration). One coherent unit since they share the wire format.
2. `js/generate.js` — model threading, adaptive thinking, batchSize substitution, response-parsing fix.
3. `index.html` + `js/app.js` — settings UI + wiring.

All three are independent file sets and can be done in parallel.

## Verification

- `bun server.js` starts on :3000 and serves the app.
- After first load, `state.json` appears with hydrated `localStorage` contents.
- Killing and restarting the server preserves state.
- Changing models / batch size in UI persists across restart.
- Anthropic call with adaptive thinking produces successful generation (verify in network tab).
