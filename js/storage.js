import {
  DEFAULT_SYSTEM_PROMPT,
  DEFAULT_FIT_PROMPT,
  DEFAULT_SYNONYM_PROMPT,
  DEFAULT_ASSOC_PROMPT,
} from './generate.js'

// In-memory state with debounced server flush.
//
// Storage is split into two files server-side:
//   /api/config — settings + saved-idea + saved-prompt libraries (cold)
//   /api/db     — domains, sets, seenStems, domainWeights (hot)
//   /api/loop-log — append-only iteration log (POST), tail-streamed (GET)
//
// Public API (signatures preserved 1:1 with the previous single-blob version):
//   - hydrate()                          (await before using anything else)
//   - saveSetting(key, value)
//   - loadSetting(key)
//   - db.findMany()
//   - db.findUnique(domain)
//   - db.upsert(domain, createData, updateData)
//   - db.update(id, data)
//   - db.delete(id)
//   - db.deleteMany()
//   - db.toggleFavorite(id)
//   - db.toggleSuper(id)
//   - db.clearFavorites()
//   - db.createSet(name, fitContext)
//   - db.listSets()
//   - db.deleteSet(id)
//   - db.restoreSet(id)
//   - db.exportJSON()
//
// NEW exports (used by Unit B and Unit C):
//   - lib.ideas.list() / get(id) / create(name, text) / update(id, patch) / delete(id)
//   - lib.prompts.list(kind) / get(kind,id) / create(kind, entry) / update(kind,id,patch) / delete(kind,id)
//   - logLoopIteration(entry)            (fire-and-forget POST /api/loop-log)
//   - fetchLoopLog(afterIso)             (GET /api/loop-log?after=...)
//   - db.addSeenStems(stems)             (de-duped append)
//   - db.getSeenStems()                  (array copy)

const PROMPT_KINDS = ['generation', 'scoring', 'synonym', 'association']

function _emptyConfig() {
  return {
    settings: {},
    ideas: [],
    prompts: { generation: [], scoring: [], synonym: [], association: [] },
  }
}

function _emptyDb() {
  return { domains: [], sets: [], seenStems: [], domainWeights: {} }
}

const _state = { config: _emptyConfig(), db: _emptyDb() }

let _hydrated = false
let _hydratePromise = null

const FLUSH_DEBOUNCE_MS = 200
const FLUSH_RETRY_MS = 500

// Independent debounce timers for the two files.
let _configFlushTimer = null
let _dbFlushTimer = null

function _scheduleConfigFlush() {
  if (_configFlushTimer) clearTimeout(_configFlushTimer)
  _configFlushTimer = setTimeout(_flushConfig, FLUSH_DEBOUNCE_MS)
}

function _scheduleDbFlush() {
  if (_dbFlushTimer) clearTimeout(_dbFlushTimer)
  _dbFlushTimer = setTimeout(_flushDb, FLUSH_DEBOUNCE_MS)
}

async function _putConfig() {
  const res = await fetch('/api/config', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(_state.config),
  })
  if (!res.ok) throw new Error('PUT /api/config failed: ' + res.status)
}

async function _putDb() {
  const res = await fetch('/api/db', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(_state.db),
  })
  if (!res.ok) throw new Error('PUT /api/db failed: ' + res.status)
}

async function _flushConfig() {
  _configFlushTimer = null
  try {
    await _putConfig()
  } catch (e) {
    setTimeout(async () => {
      try {
        await _putConfig()
      } catch (e2) {
        console.warn('[storage] Failed to flush config to /api/config (kept in memory):', e2)
      }
    }, FLUSH_RETRY_MS)
  }
}

async function _flushDb() {
  _dbFlushTimer = null
  try {
    await _putDb()
  } catch (e) {
    setTimeout(async () => {
      try {
        await _putDb()
      } catch (e2) {
        console.warn('[storage] Failed to flush db to /api/db (kept in memory):', e2)
      }
    }, FLUSH_RETRY_MS)
  }
}

// ---- migration helpers -----------------------------------------------------

function _normalizeConfigShape(c) {
  const out = _emptyConfig()
  if (!c || typeof c !== 'object') return out
  if (c.settings && typeof c.settings === 'object') out.settings = c.settings
  if (Array.isArray(c.ideas)) out.ideas = c.ideas
  if (c.prompts && typeof c.prompts === 'object') {
    for (const k of PROMPT_KINDS) {
      if (Array.isArray(c.prompts[k])) out.prompts[k] = c.prompts[k]
    }
  }
  return out
}

function _normalizeDbShape(d) {
  const out = _emptyDb()
  if (!d || typeof d !== 'object') return out
  if (Array.isArray(d.domains)) out.domains = d.domains
  if (Array.isArray(d.sets)) out.sets = d.sets
  if (Array.isArray(d.seenStems)) out.seenStems = d.seenStems
  if (d.domainWeights && typeof d.domainWeights === 'object') out.domainWeights = d.domainWeights
  return out
}

function _isConfigEmpty(c) {
  return (
    Object.keys(c.settings).length === 0 &&
    c.ideas.length === 0 &&
    PROMPT_KINDS.every(k => c.prompts[k].length === 0)
  )
}

function _isDbEmpty(d) {
  return (
    d.domains.length === 0 &&
    d.sets.length === 0 &&
    d.seenStems.length === 0 &&
    Object.keys(d.domainWeights).length === 0
  )
}

// Split a legacy state.json blob {settings,domains,sets} into the new shape.
function _adoptLegacyStateBlob(legacy) {
  if (!legacy || typeof legacy !== 'object') return false
  const hasSettings = legacy.settings && typeof legacy.settings === 'object' && Object.keys(legacy.settings).length > 0
  const hasDomains = Array.isArray(legacy.domains) && legacy.domains.length > 0
  const hasSets = Array.isArray(legacy.sets) && legacy.sets.length > 0
  if (!hasSettings && !hasDomains && !hasSets) return false

  // Settings: pull domainWeights out into db, keep everything else in config.
  const settings = hasSettings ? { ...legacy.settings } : {}
  let dw = {}
  if (settings.domainWeights && typeof settings.domainWeights === 'object') {
    dw = settings.domainWeights
    delete settings.domainWeights
  }

  _state.config.settings = settings
  _state.config.ideas = []
  _state.config.prompts = { generation: [], scoring: [], synonym: [], association: [] }
  _state.db.domains = hasDomains ? legacy.domains : []
  _state.db.sets = hasSets ? legacy.sets : []
  _state.db.seenStems = []
  _state.db.domainWeights = dw
  return true
}

function _migrateFromLocalStorage() {
  if (typeof localStorage === 'undefined') return false
  if (_state.config.settings && _state.config.settings._migratedFromLocalStorage) return false

  let migrated = false
  const migratedKeys = []

  // Settings: ds_s_FOO -> _state.config.settings.FOO
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)
      if (k && k.startsWith('ds_s_')) {
        const subKey = k.slice('ds_s_'.length)
        const raw = localStorage.getItem(k)
        try {
          _state.config.settings[subKey] = raw == null ? null : JSON.parse(raw)
        } catch {
          _state.config.settings[subKey] = raw
        }
        migratedKeys.push(k)
        migrated = true
      }
    }
  } catch {}

  // Domains
  try {
    const rawDomains = localStorage.getItem('ds_domains')
    if (rawDomains != null) {
      try { _state.db.domains = JSON.parse(rawDomains) || [] } catch { _state.db.domains = [] }
      migratedKeys.push('ds_domains')
      migrated = true
    }
  } catch {}

  // Sets
  try {
    const rawSets = localStorage.getItem('ds_sets')
    if (rawSets != null) {
      try { _state.db.sets = JSON.parse(rawSets) || [] } catch { _state.db.sets = [] }
      migratedKeys.push('ds_sets')
      migrated = true
    }
  } catch {}

  if (migrated) {
    // Pull domainWeights out of settings (old location) into db.
    if (_state.config.settings.domainWeights && typeof _state.config.settings.domainWeights === 'object') {
      _state.db.domainWeights = _state.config.settings.domainWeights
      delete _state.config.settings.domainWeights
    }
    _state.config.settings._migratedFromLocalStorage = true
    // Clear only the keys we migrated. Leaves things like `hideHowItWorks` alone.
    for (const k of migratedKeys) {
      try { localStorage.removeItem(k) } catch {}
    }
  }
  return migrated
}

// ---- hydrate ---------------------------------------------------------------

export async function hydrate() {
  if (_hydrated) return
  if (_hydratePromise) return _hydratePromise

  _hydratePromise = (async () => {
    // 1. Parallel-fetch the two new endpoints.
    let cfgRaw = null
    let dbRaw = null
    try {
      const [cfgRes, dbRes] = await Promise.all([
        fetch('/api/config', { method: 'GET' }),
        fetch('/api/db', { method: 'GET' }),
      ])
      if (cfgRes.ok) cfgRaw = await cfgRes.json().catch(() => null)
      if (dbRes.ok) dbRaw = await dbRes.json().catch(() => null)
    } catch (e) {
      console.warn('[storage] Failed to fetch /api/config or /api/db:', e)
    }

    _state.config = _normalizeConfigShape(cfgRaw)
    _state.db = _normalizeDbShape(dbRaw)

    const cfgEmpty = _isConfigEmpty(_state.config)
    const dbEmpty = _isDbEmpty(_state.db)

    // 2. If both server-side files are empty, try legacy state.json shim.
    let migratedFromLegacyState = false
    if (cfgEmpty && dbEmpty) {
      try {
        const res = await fetch('/api/state', { method: 'GET' })
        if (res.ok) {
          const legacy = await res.json().catch(() => null)
          migratedFromLegacyState = _adoptLegacyStateBlob(legacy)
        }
      } catch (e) {
        console.warn('[storage] legacy /api/state fetch failed (ignoring):', e)
      }
    }

    // 3. If still empty, try the OLD localStorage migration.
    let migratedFromLocal = false
    if (cfgEmpty && dbEmpty && !migratedFromLegacyState) {
      migratedFromLocal = _migrateFromLocalStorage()
    }

    // 4. Push migrated data to the server (await directly to bypass debounce
    //    so we can delete state.json once written), then unlink state.json.
    if (migratedFromLegacyState || migratedFromLocal) {
      try {
        await Promise.all([_putConfig(), _putDb()])
        if (migratedFromLegacyState) {
          try {
            await fetch('/api/state', { method: 'DELETE' })
          } catch (e) {
            console.warn('[storage] failed to DELETE legacy /api/state:', e)
          }
        }
      } catch (e) {
        // Fall back to debounced retry on failure.
        console.warn('[storage] initial migration flush failed; falling back to debounced flush:', e)
        _scheduleConfigFlush()
        _scheduleDbFlush()
      }
    }

    // 5. Seed built-in prompts into each library if not already present.
    //    Done after migration so re-hydrates don't duplicate the seeds.
    const builtins = {
      generation:  { name: 'Default — startup brandable names', text: DEFAULT_SYSTEM_PROMPT },
      scoring:     { name: 'Default — fit/pro/mem/brd scoring', text: DEFAULT_FIT_PROMPT },
      synonym:     { name: 'Default — synonym expansion', text: DEFAULT_SYNONYM_PROMPT },
      association: { name: 'Default — domain associations', text: DEFAULT_ASSOC_PROMPT },
    }
    let seededAny = false
    for (const [kind, { name, text }] of Object.entries(builtins)) {
      if (!_state.config.prompts[kind]) _state.config.prompts[kind] = []
      const hasBuiltin = _state.config.prompts[kind].some(p => p && p.isBuiltin)
      if (!hasBuiltin) {
        _state.config.prompts[kind].unshift({
          id: 'builtin_' + kind,
          name,
          text,
          isBuiltin: true,
          createdAt: new Date().toISOString(),
        })
        seededAny = true
      }
    }
    if (seededAny) _scheduleConfigFlush()

    _hydrated = true
  })()

  return _hydratePromise
}

// ---- Settings --------------------------------------------------------------

export function saveSetting(key, value) {
  _state.config.settings[key] = value
  _scheduleConfigFlush()
}

export function loadSetting(key) {
  const v = _state.config.settings[key]
  return v === undefined ? null : v
}

// ---- Domain DB -------------------------------------------------------------

class DomainDB {
  findMany() {
    return [..._state.db.domains].sort((a, b) => new Date(b.checkedAt) - new Date(a.checkedAt))
  }

  findUnique(domain) {
    return _state.db.domains.find(d => d.domain === domain) || null
  }

  upsert(domain, createData, updateData) {
    const idx = _state.db.domains.findIndex(d => d.domain === domain)
    if (idx >= 0) {
      _state.db.domains[idx] = { ..._state.db.domains[idx], ...updateData, checkedAt: new Date().toISOString() }
      _scheduleDbFlush()
      return _state.db.domains[idx]
    } else {
      const record = {
        id: crypto.randomUUID(),
        domain,
        available: null,
        favorite: false,
        superFavorite: false,
        description: null,
        fitScore: null,
        zones: null,
        association: null,
        checkedAt: new Date().toISOString(),
        ...createData,
      }
      _state.db.domains.unshift(record)
      _scheduleDbFlush()
      return record
    }
  }

  update(id, data) {
    const idx = _state.db.domains.findIndex(d => d.id === id)
    if (idx < 0) return null
    _state.db.domains[idx] = { ..._state.db.domains[idx], ...data }
    _scheduleDbFlush()
    return _state.db.domains[idx]
  }

  delete(id) {
    _state.db.domains = _state.db.domains.filter(d => d.id !== id)
    _scheduleDbFlush()
  }

  deleteMany() {
    _state.db.domains = []
    _scheduleDbFlush()
  }

  toggleFavorite(id) {
    const idx = _state.db.domains.findIndex(d => d.id === id)
    if (idx < 0) return null
    const wasFav = _state.db.domains[idx].favorite
    _state.db.domains[idx] = {
      ..._state.db.domains[idx],
      favorite: !wasFav,
      // unfavoriting also clears superFavorite
      superFavorite: wasFav ? false : _state.db.domains[idx].superFavorite,
    }
    _scheduleDbFlush()
    return _state.db.domains[idx]
  }

  toggleSuper(id) {
    const idx = _state.db.domains.findIndex(d => d.id === id)
    if (idx < 0) return null
    const wasSuper = _state.db.domains[idx].superFavorite
    _state.db.domains[idx] = {
      ..._state.db.domains[idx],
      superFavorite: !wasSuper,
      favorite: true, // super always implies favorite
    }
    _scheduleDbFlush()
    return _state.db.domains[idx]
  }

  clearFavorites() {
    _state.db.domains = _state.db.domains.map(d => ({ ...d, favorite: false, superFavorite: false }))
    _scheduleDbFlush()
  }

  createSet(name, fitContext) {
    const favorites = _state.db.domains.filter(d => d.favorite)
    if (!favorites.length) return null
    const set = {
      id: crypto.randomUUID(),
      name,
      fitContext: fitContext || null,
      domains: JSON.stringify(favorites),
      count: favorites.length,
      createdAt: new Date().toISOString(),
    }
    _state.db.sets.unshift(set)
    _scheduleDbFlush()
    return set
  }

  listSets() {
    return _state.db.sets.map(s => ({
      ...s,
      count: s.count || (JSON.parse(s.domains || '[]').length),
    }))
  }

  deleteSet(id) {
    _state.db.sets = _state.db.sets.filter(s => s.id !== id)
    _scheduleDbFlush()
  }

  restoreSet(id) {
    const set = _state.db.sets.find(s => s.id === id)
    if (!set) return null
    const savedDomains = JSON.parse(set.domains || '[]')

    // Clear current favorites
    _state.db.domains = _state.db.domains.map(d => ({ ...d, favorite: false, superFavorite: false }))

    // Upsert each saved domain back as favorite
    for (const saved of savedDomains) {
      const idx = _state.db.domains.findIndex(d => d.domain === saved.domain)
      if (idx >= 0) {
        _state.db.domains[idx] = { ..._state.db.domains[idx], favorite: true, superFavorite: saved.superFavorite || false }
      } else {
        _state.db.domains.unshift({
          ...saved,
          id: crypto.randomUUID(),
          checkedAt: new Date().toISOString(),
        })
      }
    }
    _scheduleDbFlush()
    return { fitContext: set.fitContext, restored: savedDomains.length }
  }

  // Additive variant of restoreSet — adds the set's domains to current
  // favorites without clearing what's already starred. Used to combine
  // multiple saved sets into a single working favorites list.
  // Accepts a single id or an array of ids.
  mergeSets(ids) {
    const idList = Array.isArray(ids) ? ids : [ids]
    let added = 0       // brand-new domain rows created
    let promoted = 0    // existing non-favorite rows flipped to favorite
    let alreadyFav = 0  // already a favorite — no-op
    const fitContexts = []
    for (const id of idList) {
      const set = _state.db.sets.find(s => s.id === id)
      if (!set) continue
      if (set.fitContext) fitContexts.push(set.fitContext)
      const savedDomains = JSON.parse(set.domains || '[]')
      for (const saved of savedDomains) {
        const idx = _state.db.domains.findIndex(d => d.domain === saved.domain)
        if (idx >= 0) {
          const cur = _state.db.domains[idx]
          if (cur.favorite) {
            alreadyFav++
            // Promote to super if the merged set marked it so.
            if (saved.superFavorite && !cur.superFavorite) {
              _state.db.domains[idx] = { ...cur, superFavorite: true }
            }
          } else {
            _state.db.domains[idx] = {
              ...cur,
              favorite: true,
              superFavorite: cur.superFavorite || saved.superFavorite || false,
            }
            promoted++
          }
        } else {
          _state.db.domains.unshift({
            ...saved,
            id: crypto.randomUUID(),
            favorite: true,
            checkedAt: new Date().toISOString(),
          })
          added++
        }
      }
    }
    _scheduleDbFlush()
    return { added, promoted, alreadyFav, fitContexts }
  }

  exportJSON() {
    const data = {
      domains: _state.db.domains,
      sets: _state.db.sets,
      exportedAt: new Date().toISOString(),
    }
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'domainsearcher-backup-' + new Date().toISOString().slice(0, 10) + '.json'
    a.click()
    URL.revokeObjectURL(url)
  }

  // ---- seenStems (NEW) ----
  addSeenStems(stems) {
    if (!Array.isArray(stems) || stems.length === 0) return
    const seen = new Set(_state.db.seenStems)
    let added = 0
    for (const raw of stems) {
      if (typeof raw !== 'string') continue
      const s = raw.trim()
      if (!s) continue
      if (seen.has(s)) continue
      seen.add(s)
      _state.db.seenStems.push(s)
      added++
    }
    // Cap growth so a 12-hour loop doesn't bloat db.json. Keep most-recent 4000.
    if (_state.db.seenStems.length > 4000) {
      _state.db.seenStems = _state.db.seenStems.slice(-4000)
    }
    if (added > 0) _scheduleDbFlush()
  }

  getSeenStems() {
    return [..._state.db.seenStems]
  }
}

export const db = new DomainDB()

// ---- Libraries (saved ideas + saved prompts) -------------------------------

function _newId() {
  // Match existing pattern (`crypto.randomUUID()` is used elsewhere in this file).
  return crypto.randomUUID()
}

function _nowIso() {
  return new Date().toISOString()
}

const ideasLib = {
  list() {
    return [..._state.config.ideas]
  },
  get(id) {
    return _state.config.ideas.find(x => x.id === id) || null
  },
  create(name, text) {
    const entry = {
      id: _newId(),
      name: String(name || '').trim() || 'Untitled',
      text: String(text || ''),
      createdAt: _nowIso(),
      updatedAt: _nowIso(),
    }
    _state.config.ideas.unshift(entry)
    _scheduleConfigFlush()
    return entry
  },
  update(id, patch) {
    const idx = _state.config.ideas.findIndex(x => x.id === id)
    if (idx < 0) return null
    const cur = _state.config.ideas[idx]
    const next = { ...cur }
    if (patch && typeof patch.name === 'string') next.name = patch.name
    if (patch && typeof patch.text === 'string') next.text = patch.text
    next.updatedAt = _nowIso()
    _state.config.ideas[idx] = next
    _scheduleConfigFlush()
    return next
  },
  delete(id) {
    const before = _state.config.ideas.length
    _state.config.ideas = _state.config.ideas.filter(x => x.id !== id)
    if (_state.config.ideas.length !== before) _scheduleConfigFlush()
  },
}

function _assertKind(kind) {
  if (!PROMPT_KINDS.includes(kind)) {
    throw new Error(`Unknown prompt kind: ${kind} (expected one of ${PROMPT_KINDS.join(', ')})`)
  }
}

const promptsLib = {
  list(kind) {
    _assertKind(kind)
    return [..._state.config.prompts[kind]]
  },
  get(kind, id) {
    _assertKind(kind)
    return _state.config.prompts[kind].find(x => x.id === id) || null
  },
  create(kind, entry) {
    _assertKind(kind)
    const e = entry || {}
    const record = {
      id: _newId(),
      name: String(e.name || '').trim() || 'Untitled',
      text: String(e.text || ''),
      isBuiltin: !!e.isBuiltin,
      createdAt: _nowIso(),
      updatedAt: _nowIso(),
    }
    _state.config.prompts[kind].unshift(record)
    _scheduleConfigFlush()
    return record
  },
  update(kind, id, patch) {
    _assertKind(kind)
    const arr = _state.config.prompts[kind]
    const idx = arr.findIndex(x => x.id === id)
    if (idx < 0) return null
    const cur = arr[idx]
    const next = { ...cur }
    if (patch && typeof patch.name === 'string') next.name = patch.name
    if (patch && typeof patch.text === 'string') next.text = patch.text
    next.updatedAt = _nowIso()
    arr[idx] = next
    _scheduleConfigFlush()
    return next
  },
  delete(kind, id) {
    _assertKind(kind)
    const arr = _state.config.prompts[kind]
    const idx = arr.findIndex(x => x.id === id)
    if (idx < 0) return null
    if (arr[idx].isBuiltin) {
      // Refuse to delete built-in entries. Caller can detect via return value.
      return { ok: false, reason: 'builtin' }
    }
    arr.splice(idx, 1)
    _scheduleConfigFlush()
    return { ok: true }
  },
}

export const lib = {
  ideas: ideasLib,
  prompts: promptsLib,
}

// ---- Loop log (audit) ------------------------------------------------------

export function logLoopIteration(entry) {
  // Fire-and-forget. Don't block callers on network.
  const body = (entry && typeof entry === 'object') ? entry : { value: entry }
  // Default timestamp if caller didn't supply one (server filters by this).
  if (!body.timestamp) body.timestamp = new Date().toISOString()
  fetch('/api/loop-log', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).catch(err => {
    console.warn('[storage] logLoopIteration failed:', err)
  })
}

export async function fetchLoopLog(afterIso) {
  const url = afterIso
    ? `/api/loop-log?after=${encodeURIComponent(afterIso)}`
    : '/api/loop-log'
  const res = await fetch(url, { method: 'GET' })
  if (!res.ok) throw new Error('GET /api/loop-log failed: ' + res.status)
  const text = await res.text()
  if (!text) return []
  const out = []
  for (const line of text.split('\n')) {
    if (!line) continue
    try { out.push(JSON.parse(line)) } catch { /* skip malformed line */ }
  }
  return out
}
