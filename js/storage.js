// In-memory state with debounced server flush to /api/state.
// Public API (preserved 1:1 from the previous localStorage-backed version):
//   - hydrate()                          (NEW: await before using anything else)
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

const _state = { settings: {}, domains: [], sets: [] }

let _hydrated = false
let _hydratePromise = null
let _flushTimer = null
const FLUSH_DEBOUNCE_MS = 200
const FLUSH_RETRY_MS = 500

function _scheduleFlush() {
  if (_flushTimer) clearTimeout(_flushTimer)
  _flushTimer = setTimeout(_flush, FLUSH_DEBOUNCE_MS)
}

async function _putState() {
  const res = await fetch('/api/state', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(_state),
  })
  if (!res.ok) throw new Error('PUT /api/state failed: ' + res.status)
}

async function _flush() {
  _flushTimer = null
  try {
    await _putState()
  } catch (e) {
    // Retry once after a short delay, then warn and keep data in memory.
    setTimeout(async () => {
      try {
        await _putState()
      } catch (e2) {
        console.warn('[storage] Failed to flush state to /api/state (kept in memory):', e2)
      }
    }, FLUSH_RETRY_MS)
  }
}

function _migrateFromLocalStorage() {
  // Only run if there's no migration marker already in _state.
  if (_state.settings && _state.settings._migratedFromLocalStorage) return false
  if (typeof localStorage === 'undefined') return false

  let migrated = false
  const migratedKeys = []

  // Settings: ds_s_FOO -> _state.settings.FOO
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)
      if (k && k.startsWith('ds_s_')) {
        const subKey = k.slice('ds_s_'.length)
        const raw = localStorage.getItem(k)
        try {
          _state.settings[subKey] = raw == null ? null : JSON.parse(raw)
        } catch {
          _state.settings[subKey] = raw
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
      try { _state.domains = JSON.parse(rawDomains) || [] } catch { _state.domains = [] }
      migratedKeys.push('ds_domains')
      migrated = true
    }
  } catch {}

  // Sets
  try {
    const rawSets = localStorage.getItem('ds_sets')
    if (rawSets != null) {
      try { _state.sets = JSON.parse(rawSets) || [] } catch { _state.sets = [] }
      migratedKeys.push('ds_sets')
      migrated = true
    }
  } catch {}

  if (migrated) {
    _state.settings._migratedFromLocalStorage = true
    // Clear only the keys we migrated. Leaves things like `hideHowItWorks` alone.
    for (const k of migratedKeys) {
      try { localStorage.removeItem(k) } catch {}
    }
  }
  return migrated
}

export async function hydrate() {
  if (_hydrated) return
  if (_hydratePromise) return _hydratePromise

  _hydratePromise = (async () => {
    let serverState = null
    try {
      const res = await fetch('/api/state', { method: 'GET' })
      if (res.ok) {
        serverState = await res.json()
      }
    } catch (e) {
      console.warn('[storage] Failed to fetch /api/state, starting empty:', e)
    }

    if (serverState && typeof serverState === 'object') {
      _state.settings = (serverState.settings && typeof serverState.settings === 'object') ? serverState.settings : {}
      _state.domains  = Array.isArray(serverState.domains) ? serverState.domains : []
      _state.sets     = Array.isArray(serverState.sets) ? serverState.sets : []
    }

    // One-time migration from localStorage if server state is empty or unmigrated.
    const serverEmpty = !serverState
      || (Object.keys(_state.settings).length === 0
          && _state.domains.length === 0
          && _state.sets.length === 0)
    const noMarker = !_state.settings._migratedFromLocalStorage

    if (serverEmpty || noMarker) {
      const didMigrate = _migrateFromLocalStorage()
      if (didMigrate) _scheduleFlush()
    }

    _hydrated = true
  })()

  return _hydratePromise
}

// ---------- Settings ----------

export function saveSetting(key, value) {
  _state.settings[key] = value
  _scheduleFlush()
}

export function loadSetting(key) {
  const v = _state.settings[key]
  return v === undefined ? null : v
}

// ---------- Domain DB ----------

class DomainDB {
  findMany() {
    return [..._state.domains].sort((a, b) => new Date(b.checkedAt) - new Date(a.checkedAt))
  }

  findUnique(domain) {
    return _state.domains.find(d => d.domain === domain) || null
  }

  upsert(domain, createData, updateData) {
    const idx = _state.domains.findIndex(d => d.domain === domain)
    if (idx >= 0) {
      _state.domains[idx] = { ..._state.domains[idx], ...updateData, checkedAt: new Date().toISOString() }
      _scheduleFlush()
      return _state.domains[idx]
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
      _state.domains.unshift(record)
      _scheduleFlush()
      return record
    }
  }

  update(id, data) {
    const idx = _state.domains.findIndex(d => d.id === id)
    if (idx < 0) return null
    _state.domains[idx] = { ..._state.domains[idx], ...data }
    _scheduleFlush()
    return _state.domains[idx]
  }

  delete(id) {
    _state.domains = _state.domains.filter(d => d.id !== id)
    _scheduleFlush()
  }

  deleteMany() {
    _state.domains = []
    _scheduleFlush()
  }

  toggleFavorite(id) {
    const idx = _state.domains.findIndex(d => d.id === id)
    if (idx < 0) return null
    const wasFav = _state.domains[idx].favorite
    _state.domains[idx] = {
      ..._state.domains[idx],
      favorite: !wasFav,
      // unfavoriting also clears superFavorite
      superFavorite: wasFav ? false : _state.domains[idx].superFavorite,
    }
    _scheduleFlush()
    return _state.domains[idx]
  }

  toggleSuper(id) {
    const idx = _state.domains.findIndex(d => d.id === id)
    if (idx < 0) return null
    const wasSuper = _state.domains[idx].superFavorite
    _state.domains[idx] = {
      ..._state.domains[idx],
      superFavorite: !wasSuper,
      favorite: true, // super always implies favorite
    }
    _scheduleFlush()
    return _state.domains[idx]
  }

  clearFavorites() {
    _state.domains = _state.domains.map(d => ({ ...d, favorite: false, superFavorite: false }))
    _scheduleFlush()
  }

  createSet(name, fitContext) {
    const favorites = _state.domains.filter(d => d.favorite)
    if (!favorites.length) return null
    const set = {
      id: crypto.randomUUID(),
      name,
      fitContext: fitContext || null,
      domains: JSON.stringify(favorites),
      count: favorites.length,
      createdAt: new Date().toISOString(),
    }
    _state.sets.unshift(set)
    _scheduleFlush()
    return set
  }

  listSets() {
    return _state.sets.map(s => ({
      ...s,
      count: s.count || (JSON.parse(s.domains || '[]').length),
    }))
  }

  deleteSet(id) {
    _state.sets = _state.sets.filter(s => s.id !== id)
    _scheduleFlush()
  }

  restoreSet(id) {
    const set = _state.sets.find(s => s.id === id)
    if (!set) return null
    const savedDomains = JSON.parse(set.domains || '[]')

    // Clear current favorites
    _state.domains = _state.domains.map(d => ({ ...d, favorite: false, superFavorite: false }))

    // Upsert each saved domain back as favorite
    for (const saved of savedDomains) {
      const idx = _state.domains.findIndex(d => d.domain === saved.domain)
      if (idx >= 0) {
        _state.domains[idx] = { ..._state.domains[idx], favorite: true, superFavorite: saved.superFavorite || false }
      } else {
        _state.domains.unshift({
          ...saved,
          id: crypto.randomUUID(),
          checkedAt: new Date().toISOString(),
        })
      }
    }
    _scheduleFlush()
    return { fitContext: set.fitContext, restored: savedDomains.length }
  }

  exportJSON() {
    const data = {
      domains: _state.domains,
      sets: _state.sets,
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
}

export const db = new DomainDB()
