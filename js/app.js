import { db, saveSetting, loadSetting, hydrate, lib, logLoopIteration, fetchLoopLog } from './storage.js?v=21'
import { checkDomainAvailable, checkMultipleZones } from './check.js?v=21'
import { generateDomainNames, scoreFitBatch, associateDomains, generateSynonyms, detectProvider, DEFAULT_SYSTEM_PROMPT, DEFAULT_ASSOC_PROMPT, DEFAULT_FIT_PROMPT, DEFAULT_SYNONYM_PROMPT, AIAPIError, getLastUsage } from './generate.js?v=21'

// Active search controller
let _abortController = null

// Zone cache, fit cache, association cache for scoring
let zoneCache = {}
let fitCache = {}
let assocCache = {}

// Track which favorite IDs have already had zones/fit/assoc loaded this session
// Prevents redundant re-checks when favorites list changes (toggle, etc.)
const _loadedFavIds = new Set()

// Active search state (stored in localStorage for resume)
let _activeSearch = null

// --- Zone selector (multi-select) ---
function getSelectedZones() {
  const active = Array.from(document.querySelectorAll('#zoneSelector .zone-active'))
    .map(el => el.dataset.zone)
  return active.length ? active : ['ai']
}

function getCompareZones() {
  return Array.from(document.querySelectorAll('#compareZoneSelector .zone-compare-active'))
    .map(el => el.dataset.zone)
}

function removeZone(e, x) {
  e.stopPropagation()
  const btn = x.closest('button')
  if (btn.closest('#compareZoneSelector')) { btn.remove(); saveCompareZones() }
  else if (btn.closest('#checkZoneSelector')) { btn.remove(); saveCheckZones() }
  else { btn.remove(); saveSearchZones() }
}

function _zoneLabel(zones) {
  if (!zones.length) return 'no zones'
  if (zones.length === 1) return '.' + zones[0]
  return '.' + zones[0] + ' +' + (zones.length - 1) + ' more'
}

function zoneX() {
  return '<span class="zone-x" onclick="removeZone(event,this)">&#x2715;</span>'
}

function toggleSearchZone(btn) {
  btn.classList.toggle('zone-active')
  saveSearchZones()
}

function toggleCompareZone(btn) {
  btn.classList.toggle('zone-compare-active')
  saveCompareZones()
}

// Validate that a TLD exists by checking its SOA record via DNS-over-HTTPS
async function validateTLD(zone, input) {
  const prev = input.placeholder
  input.placeholder = 'checking .' + zone + '...'
  input.disabled = true
  try {
    const res = await fetch('https://cloudflare-dns.com/dns-query?name=' + zone + '&type=SOA', {
      headers: { Accept: 'application/dns-json' },
      signal: AbortSignal.timeout(5000),
    })
    if (!res.ok) return true // can't verify, allow it
    const data = await res.json()
    if (data.Status === 3) { // NXDOMAIN — TLD doesn't exist
      input.value = ''
      input.placeholder = '.' + zone + ' is not a real TLD'
      setTimeout(() => { input.placeholder = prev }, 2000)
      return false
    }
    return true
  } catch {
    return true // network error, allow it
  } finally {
    input.disabled = false
    if (input.placeholder === 'checking .' + zone + '...') input.placeholder = prev
  }
}

async function addCustomZone() {
  const input = document.getElementById('customZone')
  const zone = input.value.trim().toLowerCase().replace(/[^a-z0-9]/g, '')
  if (!zone) return
  const existing = document.querySelector('#zoneSelector [data-zone="' + zone + '"]')
  if (existing) { toggleSearchZone(existing); input.value = ''; return }
  if (!await validateTLD(zone, input)) return
  const btn = document.createElement('button')
  btn.onclick = function(e) { if (!e.target.classList.contains('zone-x')) toggleSearchZone(this) }
  btn.dataset.zone = zone
  btn.className = 'zone-tag zone-active'
  btn.innerHTML = '.' + zone + zoneX()
  const container = document.getElementById('zoneSelector')
  container.insertBefore(btn, container.lastElementChild)
  input.value = ''
  saveSearchZones()
}

async function addCustomCompareZone() {
  const input = document.getElementById('customCompareZone')
  const zone = input.value.trim().toLowerCase().replace(/[^a-z0-9]/g, '')
  if (!zone) return
  const existing = document.querySelector('#compareZoneSelector [data-zone="' + zone + '"]')
  if (existing) { existing.classList.add('zone-compare-active'); input.value = ''; return }
  if (!await validateTLD(zone, input)) return
  const btn = document.createElement('button')
  btn.onclick = function(e) { if (!e.target.classList.contains('zone-x')) toggleCompareZone(this) }
  btn.dataset.zone = zone
  btn.className = 'zone-tag zone-compare-active'
  btn.innerHTML = '.' + zone + zoneX()
  const container = document.getElementById('compareZoneSelector')
  container.insertBefore(btn, container.lastElementChild)
  input.value = ''
  saveCompareZones()
}

// Save/load zones for a selector. htmlDefaults = zones that have buttons in the HTML.
// Any zone NOT in htmlDefaults needs to be recreated on load.
function _saveZones(settingKey, selectorId, activeClass, htmlDefaults) {
  const all = Array.from(document.querySelectorAll('#' + selectorId + ' [data-zone]'))
  saveSetting(settingKey, {
    active: all.filter(b => b.classList.contains(activeClass)).map(b => b.dataset.zone),
    extra:  all.filter(b => !htmlDefaults.includes(b.dataset.zone)).map(b => b.dataset.zone),
  })
}

function _loadZones(settingKey, selectorId, activeClass, htmlDefaults, makeBtn) {
  const state = loadSetting(settingKey)
  if (!state) return
  const container = document.getElementById(selectorId)
  // Toggle existing HTML-default buttons
  container.querySelectorAll('[data-zone]').forEach(btn => {
    if (htmlDefaults.includes(btn.dataset.zone))
      btn.classList.toggle(activeClass, state.active.includes(btn.dataset.zone))
  })
  // Recreate any added zones that aren't in the HTML defaults
  const toAdd = [...new Set([...(state.extra || []), ...(state.custom || [])])]
  for (const z of toAdd) {
    if (container.querySelector('[data-zone="' + z + '"]')) continue
    const btn = makeBtn(z, state.active.includes(z))
    container.insertBefore(btn, container.lastElementChild)
  }
}

// Search zones — HTML defaults: ai com io app dev co email to direct
const SEARCH_DEFAULTS  = ['ai', 'com', 'io', 'app', 'dev', 'co', 'email', 'to', 'direct']
// Compare zones — HTML defaults: com io co app dev email to direct  (no ai)
const COMPARE_DEFAULTS = ['com', 'io', 'co', 'app', 'dev', 'email', 'to', 'direct']
// Check zones — HTML defaults: com io ai app co
const CHECK_DEFAULTS   = ['com', 'io', 'ai', 'app', 'co']

function saveSearchZones() {
  _saveZones('searchZones', 'zoneSelector', 'zone-active', SEARCH_DEFAULTS)
}
function saveCompareZones() {
  _saveZones('compareZones', 'compareZoneSelector', 'zone-compare-active', COMPARE_DEFAULTS)
}
function saveCheckZones() {
  _saveZones('checkZones', 'checkZoneSelector', 'zone-active', CHECK_DEFAULTS)
}

function loadSearchZones() {
  _loadZones('searchZones', 'zoneSelector', 'zone-active', SEARCH_DEFAULTS, (z, active) => {
    const btn = document.createElement('button')
    btn.onclick = function(e) { if (!e.target.classList.contains('zone-x')) toggleSearchZone(this) }
    btn.dataset.zone = z
    btn.className = 'zone-tag' + (active ? ' zone-active' : '')
    btn.innerHTML = '.' + z + zoneX()
    return btn
  })
}
function loadCompareZones() {
  _loadZones('compareZones', 'compareZoneSelector', 'zone-compare-active', COMPARE_DEFAULTS, (z, active) => {
    const btn = document.createElement('button')
    btn.onclick = function(e) { if (!e.target.classList.contains('zone-x')) toggleCompareZone(this) }
    btn.dataset.zone = z
    btn.className = 'zone-tag' + (active ? ' zone-compare-active' : '')
    btn.innerHTML = '.' + z + zoneX()
    return btn
  })
}
function loadCheckZones() {
  _loadZones('checkZones', 'checkZoneSelector', 'zone-active', CHECK_DEFAULTS, (z, active) => {
    const btn = document.createElement('button')
    btn.onclick = function() { toggleCheckZone(this) }
    btn.dataset.zone = z
    btn.className = 'zone-tag' + (active ? ' zone-active' : '')
    btn.innerHTML = '.' + z + zoneX()
    return btn
  })
}

// --- Quick check zones ---
function getCheckZones() {
  return [...document.querySelectorAll('#checkZoneSelector .zone-tag.zone-active')]
    .map(b => b.dataset.zone).filter(Boolean)
}


function toggleCheckZone(btn) {
  if (event.target.classList.contains('zone-x')) return
  btn.classList.toggle('zone-active')
  saveCheckZones()
}

async function addCustomCheckZone() {
  const input = document.getElementById('customCheckZone')
  const zone = input.value.trim().toLowerCase().replace(/^\./, '').replace(/[^a-z0-9]/g, '')
  if (!zone) return
  const container = document.getElementById('checkZoneSelector')
  if ([...container.querySelectorAll('.zone-tag')].some(b => b.dataset.zone === zone)) { input.value = ''; return }
  if (!await validateTLD(zone, input)) return
  const btn = document.createElement('button')
  btn.dataset.zone = zone
  btn.onclick = function() { toggleCheckZone(this) }
  btn.className = 'zone-tag zone-active'
  btn.innerHTML = '.' + zone + zoneX()
  container.insertBefore(btn, container.lastElementChild)
  input.value = ''
  saveCheckZones()
}

// --- Quick check ---
function _domainCheckRow(domain, available, recordId, favorite) {
  const badge = available === true
    ? '<span class="bg-green-100 text-green-700 text-sm font-medium px-3 py-1 rounded-full">Available</span>'
    : available === false
      ? '<span class="text-red-400 text-sm">Taken</span>'
      : '<span class="text-yellow-500 text-sm" title="Check failed — RDAP returned an unexpected response">? Unknown</span>'
  const nameClass = available === true ? 'text-green-700 font-semibold' : 'text-gray-400'
  const favBtn = '<button onclick="toggleCheckFav(\'' + recordId + '\',this)" class="ml-2" aria-label="' + (favorite ? 'Remove from favorites' : 'Add to favorites') + '">' + starIcon(favorite) + '</button>'
  const link = '<a href="https://' + domain + '" target="_blank" rel="noopener" class="font-mono ' + nameClass + ' hover:underline">' + domain + '</a>'
  return '<div class="flex items-center gap-3 py-1">' + link + badge + favBtn + '</div>'
}

async function checkOne() {
  const input = document.getElementById('checkDomain')
  const raw = input.value.trim().toLowerCase()
  const dotIdx = raw.indexOf('.')
  const hasZone = dotIdx > 0 && dotIdx < raw.length - 1
  let name, zones
  if (hasZone) {
    name = raw.slice(0, dotIdx).replace(/[^a-z0-9-]/g, '')
    zones = [raw.slice(dotIdx + 1)]
  } else {
    name = raw.replace(/[^a-z0-9-]/g, '')
    zones = getCheckZones()
  }
  if (!name) return

  const synonymsOn = document.getElementById('synonymsToggle')?.classList.contains('active')
  const resultDiv = document.getElementById('checkResult')
  resultDiv.classList.remove('hidden')
  resultDiv.innerHTML = '<span class="text-gray-400 text-sm">Checking ' + name + (zones.length > 1 ? ' across ' + zones.length + ' zones' : '.' + zones[0]) + '...</span>'

  // Check the original name
  let html = ''
  for (const zone of zones) {
    const domain = name + '.' + zone
    resultDiv.innerHTML = '<span class="text-gray-400 text-sm">Checking ' + domain + '...</span>' + html
    const available = await checkDomainAvailable(domain)
    const record = db.upsert(domain, { domain, available }, { available })
    html += _domainCheckRow(domain, available, record.id, record.favorite)
  }
  resultDiv.innerHTML = html
  loadSaved()

  // Synonyms
  if (synonymsOn) {
    resultDiv.innerHTML = html + '<div class="text-xs text-cyan-500 mt-2 mb-1">generating synonyms...</div>'
    const aiKey = loadSetting('aiApiKey') || undefined
    const synonymPrompt = document.getElementById('synonymsPromptBox')?.value || loadSetting('synonymPrompt') || undefined
    let synonyms = []
    try { synonyms = await generateSynonyms(name, aiKey, synonymPrompt, loadSetting('creativeModel'), loadSetting('creativePreset') || 'off') } catch {}

    if (synonyms.length) {
      html += '<div class="text-xs text-cyan-500 font-medium mt-3 mb-1">synonyms of "' + name + '"</div>'
      for (const syn of synonyms) {
        for (const zone of zones) {
          const domain = syn + '.' + zone
          resultDiv.innerHTML = html + '<span class="text-gray-400 text-xs">checking ' + domain + '...</span>'
          const available = await checkDomainAvailable(domain)
          const record = db.upsert(domain, { domain, available }, { available })
          html += _domainCheckRow(domain, available, record.id, record.favorite)
        }
      }
    } else {
      html += '<div class="text-xs text-gray-400 mt-2">no synonyms returned</div>'
    }
    resultDiv.innerHTML = html
    loadSaved()
  }
}

function toggleMenu(menuId) {
  const menu = document.getElementById(menuId)
  if (!menu) return
  const isOpen = !menu.classList.contains('hidden')
  document.querySelectorAll('.domain-menu').forEach(m => m.classList.add('hidden'))
  if (!isOpen) {
    menu.classList.remove('hidden')
    const close = (e) => { if (!menu.contains(e.target) && e.target.getAttribute('data-menu') !== menuId) { menu.classList.add('hidden'); document.removeEventListener('click', close) } }
    setTimeout(() => document.addEventListener('click', close), 0)
  }
}

function starIcon(filled) {
  return filled
    ? '<span class="cursor-pointer text-yellow-400 hover:text-yellow-500 text-lg">&#9733;</span>'
    : '<span class="cursor-pointer text-gray-300 hover:text-yellow-400 text-lg">&#9734;</span>'
}

function doubleStarIcon(isSuper) {
  return isSuper
    ? '<span class="cursor-pointer text-orange-500 hover:text-orange-600 text-lg font-bold">&#9733;&#9733;</span>'
    : '<span class="cursor-pointer text-gray-300 hover:text-orange-400 text-lg">&#9733;&#9733;</span>'
}

function toggleCheckFav(id, btn) {
  const record = db.toggleFavorite(id)
  if (record) btn.innerHTML = starIcon(record.favorite)
  loadSaved()
}

function toggleFav(id) {
  db.toggleFavorite(id)
  loadSaved()
}

function toggleSuper(id) {
  db.toggleSuper(id)
  loadSaved()
}

function domainRow(d, opts = {}) {
  const badge = opts.noBadge ? '' : (d.available === true
    ? '<span class="text-green-600 text-xs font-medium">✓</span>'
    : d.available === false
      ? '<span class="text-red-300 text-xs">✗</span>'
      : '<span class="text-yellow-500 text-xs" title="RDAP check inconclusive — short domains and some registries are unreliable">?</span>')
  const star = '<button onclick="toggleFav(\'' + d.id + '\')" aria-label="' + (d.favorite ? 'Remove from favorites' : 'Add to favorites') + '">' + starIcon(d.favorite) + '</button>'
  const superStar = opts.showSuper
    ? '<button onclick="toggleSuper(\'' + d.id + '\')" title="Super favorite" aria-label="Toggle super favorite">' + doubleStarIcon(d.superFavorite) + '</button>'
    : ''
  const del = opts.showDelete
    ? '<button onclick="deleteDomain(\'' + d.id + '\',this)" class="text-gray-300 hover:text-red-400 text-xs ml-1" aria-label="Remove domain">x</button>'
    : ''
  const desc = opts.showDesc && d.description
    ? '<span class="text-xs text-gray-400 ml-3">' + d.description.slice(0, 40) + '</span>'
    : ''
  const nameClass = d.available === true ? (opts.bold ? 'text-green-800 font-semibold' : 'text-green-700 font-semibold text-sm') : 'text-gray-400 text-sm'
  const rowBg = d.superFavorite && opts.showSuper ? ' bg-orange-50' : ''
  const zonesId = opts.showZones ? 'zones-' + d.id : ''
  const zonesRow = opts.showZones
    ? '<div id="' + zonesId + '" class="px-6 pb-2 text-xs text-gray-400">checking other zones...</div>'
    : ''
  return '<div class="' + (opts.compact ? 'px-3' : 'px-6') + rowBg + ' ' + (opts.compact ? 'py-2' : 'pt-3 ' + (opts.showZones ? 'pb-1' : 'pb-3')) + '">'
    + '<div class="flex items-center justify-between">'
    + '<div><span class="font-mono ' + nameClass + '">' + d.domain + '</span>' + desc + '</div>'
    + '<div class="flex items-center gap-2">' + superStar + star + badge + del + '</div>'
    + '</div></div>' + zonesRow
}

// --- Scoring functions ---
function scoreLength(name) {
  const len = name.length
  if (len === 5) return 10
  if (len === 4) return 9
  if (len === 6) return 8
  if (len === 3) return 7
  if (len === 7) return 6
  if (len === 8) return 4
  if (len === 9) return 2
  if (len === 10) return 1
  return 0
}

function scorePronounceable(name) {
  if (/[^a-z0-9]/.test(name)) return 1
  let score = 7
  const syllables = (name.match(/[aeiouy]+/g) || []).length
  if (syllables === 2) score += 3
  else if (syllables === 1) score += 1
  else if (syllables === 3) score += 1
  if (syllables === 0) score -= 4
  score -= (name.match(/[^aeiouy]{3,}/g) || []).reduce((s, c) => s + (c.length - 2) * 2, 0)
  score -= (name.match(/[aeiouy]{3,}/g) || []).length * 2
  if (/([^aeiouy])\1/.test(name)) score -= 1
  if (/[0-9]/.test(name)) score -= 3
  return Math.max(0, Math.min(10, Math.round(score)))
}

function scoreMemorability(name) {
  let score = 6
  if (name.length <= 5) score += 2
  else if (name.length <= 7) score += 1
  if (name.length >= 5 && /er$/.test(name)) score -= 4
  if (/^(over|under|after|before|into|using|along|direct|post|mail|send|get|set|from|inbox|outbox|client|server|agent|proxy|relay|notify|message)$/.test(name)) score -= 4
  if (/[0-9]/.test(name)) score -= 2
  if (!/er$|or$|ing$/.test(name) && /x$|ex$|ix$|ax$|ify$|io$|ze$|ly$/.test(name)) score += 1
  return Math.max(0, Math.min(10, Math.round(score)))
}

function scoreBrandability(name) {
  const n = name.toLowerCase()
  let score = 4
  if (n.length >= 5 && /er$/.test(n)) {
    score += 0
  } else if (/^(over|under|after|before|into|using|along|direct|post|mail|send|inbox|outbox|client|server|agent|proxy|relay|message|notify|with|from)$/.test(n)) {
    score -= 2
  } else if (/^(get|set|run|send|mail|post|use|put|add|out|top)(box|hub|lab|app|net|web|base|core|mail|out|go|up|in|all|pro|fast)$/.test(n)) {
    score += 1
  } else {
    score += 4
  }
  const vr = (n.match(/[aeiouy]/g) || []).length / n.length
  if (vr >= 0.25 && vr <= 0.55) score += 1
  if (!/er$|or$/.test(n) && /[aeiouxzln]$/.test(n)) score += 1
  if (n.length >= 4 && n.length <= 7) score += 1
  if (/[0-9]/.test(n)) score -= 3
  return Math.max(0, Math.min(10, Math.round(score)))
}

function scoreZones(zones) {
  if (!zones) return 0
  const compareZones = getCompareZones()
  const relevant = compareZones.length ? compareZones.filter(z => z in zones) : Object.keys(zones)
  const freeCount = relevant.filter(z => zones[z]).length
  const total = relevant.length || 1
  return Math.round(freeCount / total * 10)
}

function getWeights() {
  const n = id => { const el = document.getElementById(id); if (!el) return 1; const v = parseFloat(el.value); return isNaN(v) ? 0 : Math.max(0, v) }
  return { len: n('wLen'), pro: n('wPro'), mem: n('wMem'), brd: n('wBrd'), zon: n('wZon'), fit: n('wFit') }
}

function scoreDomain(name, zones, aiScores) {
  const len = scoreLength(name)
  // PRO/MEM/BRD: use AI scores when available, fall back to computed
  const pro = aiScores?.pro ?? scorePronounceable(name)
  const mem = aiScores?.mem ?? scoreMemorability(name)
  const brd = aiScores?.brd ?? scoreBrandability(name)
  const zon = scoreZones(zones)
  const f = aiScores?.fit ?? 0
  const w = getWeights()
  const total = Math.round(len * w.len + pro * w.pro + mem * w.mem + brd * w.brd + zon * w.zon + f * w.fit)
  const maxTotal = (w.len + w.pro + w.mem + w.brd + w.zon + w.fit) * 10
  return { len, pro, mem, brd, zon, fit: f, total, maxTotal }
}

function scoreBar(val, max) {
  const pct = Math.round(val / max * 100)
  const color = pct >= 70 ? 'bg-green-400' : pct >= 40 ? 'bg-yellow-400' : 'bg-red-300'
  return '<div style="width:100%;background:#f3f4f6;border-radius:3px;height:6px"><div class="' + color + '" style="width:' + pct + '%;height:6px;border-radius:3px"></div></div>'
    + '<div class="text-center text-xs font-mono" style="margin-top:1px;font-size:10px">' + val + '</div>'
}

function scoreCell(val, weight) {
  if (weight === 0) return '<div style="text-align:center;color:#d1d5db;font-size:13px;line-height:2">—</div>'
  return scoreBar(val, 10)
}

function zonePillsHTML(zones, filterZones, name) {
  const compareZones = filterZones || getCompareZones()
  const entries = compareZones.length
    ? compareZones.filter(z => z in zones).map(z => [z, zones[z]])
    : Object.entries(zones)
  if (!entries.length) return ''
  return entries.map(([z, avail]) => {
    const url = name ? 'https://' + name + '.' + z : null
    const link = url ? ' href="' + url + '" target="_blank" rel="noopener"' : ''
    const tag = url ? 'a' : 'span'
    return avail === true
      ? '<' + tag + link + ' style="background:#dcfce7;color:#15803d;padding:1px 6px;border-radius:3px;font-size:10.5px;font-family:monospace;font-weight:600;text-decoration:none;cursor:pointer">.' + z + '</' + tag + '>'
      : avail === false
        ? '<' + tag + link + ' style="background:#f1f5f9;color:#94a3b8;padding:1px 6px;border-radius:3px;font-size:10.5px;font-family:monospace;text-decoration:none;cursor:pointer">.' + z + '</' + tag + '>'
        : '<' + tag + link + ' title="Check failed" style="background:#fef9c3;color:#b45309;padding:1px 6px;border-radius:3px;font-size:10.5px;font-family:monospace;text-decoration:none;cursor:pointer">.' + z + '?</' + tag + '>'
  }).join(' ')
}

function scoreCard(s, rank) {
  const { id, domain, scores, superFavorite: isSuper, available } = s
  const medalColors = ['#eab308', '#9ca3af', '#d97706']
  const medalLabel = rank < 3
    ? '<span style="color:' + medalColors[rank] + ';font-weight:700;font-size:12px">#' + (rank + 1) + '</span>'
    : '<span style="color:#d1d5db;font-size:12px">' + (rank + 1) + '.</span>'
  const mx = scores.maxTotal || 70
  const totalPct = Math.round(scores.total / mx * 100)
  const totalColor = totalPct >= 67 ? '#15803d' : totalPct >= 47 ? '#a16207' : '#dc2626'
  const totalBg   = totalPct >= 67 ? '#f0fdf4' : totalPct >= 47 ? '#fefce8' : '#fff1f2'
  const nameColor = available ? '#166534' : '#6b7280'
  const zones = zoneCache[id] || {}
  const stem = domain.replace(/\.[a-z]+$/, '')
  const pills = Object.keys(zones).length ? zonePillsHTML(zones, null, stem) : '<span style="color:#d1d5db;font-size:11px">checking zones…</span>'
  const assocRaw = assocCache[id]
  const assoc = Array.isArray(assocRaw) ? assocRaw.join(' · ') : (assocRaw || null)
  const superBtn = '<button onclick="toggleSuper(\'' + id + '\')" title="Super favorite" aria-label="Toggle super favorite" style="font-size:18px;line-height:1;color:' + (isSuper ? '#f97316' : '#d1d5db') + '" onmouseover="this.style.color=\'#f97316\'" onmouseout="this.style.color=\'' + (isSuper ? '#f97316' : '#d1d5db') + '\'">&#9733;&#9733;</button>'
  const starBtn  = '<button onclick="toggleFav(\'' + id + '\')" title="Remove from favorites" aria-label="Remove from favorites" style="font-size:20px;line-height:1;color:#fbbf24" onmouseover="this.style.color=\'#f59e0b\'" onmouseout="this.style.color=\'#fbbf24\'">&#9733;</button>'
  const delBtn   = '<button onclick="deleteDomain(\'' + id + '\',this)" title="Delete" aria-label="Remove domain" style="font-size:15px;color:#d1d5db;padding:2px" onmouseover="this.style.color=\'#f87171\'" onmouseout="this.style.color=\'#d1d5db\'">&#x2715;</button>'

  const w = getWeights()
  function miniBar(label, val, weight) {
    if (weight === 0) return '<div style="display:flex;align-items:center;gap:6px;min-width:0">'
      + '<span style="font-size:10px;font-weight:700;color:#d1d5db;width:26px;flex-shrink:0">' + label + '</span>'
      + '<div style="flex:1;background:#f3f4f6;border-radius:3px;height:6px;min-width:0"></div>'
      + '<span style="font-size:13px;color:#d1d5db;width:14px;text-align:right">—</span>'
      + '</div>'
    const pct = Math.round(val / 10 * 100)
    const color = pct >= 70 ? '#4ade80' : pct >= 40 ? '#facc15' : '#fca5a5'
    return '<div style="display:flex;align-items:center;gap:6px;min-width:0">'
      + '<span style="font-size:10px;font-weight:700;color:#7c3aed;width:26px;flex-shrink:0">' + label + '</span>'
      + '<div style="flex:1;background:#f3f4f6;border-radius:3px;height:6px;min-width:0">'
      + '<div style="width:' + pct + '%;height:6px;border-radius:3px;background:' + color + '"></div></div>'
      + '<span style="font-size:11px;font-family:monospace;color:#6b7280;width:14px;text-align:right">' + val + '</span>'
      + '</div>'
  }

  return '<div style="background:' + (isSuper ? '#fff7ed' : 'white') + ';border:1.5px solid ' + (isSuper ? '#fed7aa' : '#e9d5ff') + ';border-radius:12px;padding:14px;display:flex;flex-direction:column;gap:10px">'
    // Header: rank + domain + actions
    + '<div style="display:flex;align-items:flex-start;justify-content:space-between;gap:8px">'
    +   '<div style="display:flex;align-items:center;gap:6px;min-width:0;flex:1">'
    +     medalLabel
    +     '<span style="font-family:monospace;font-weight:700;font-size:15px;color:' + nameColor + ';word-break:break-all">' + domain + '</span>'
    +   '</div>'
    +   '<div style="display:flex;align-items:center;gap:4px;flex-shrink:0">'
    +     superBtn + starBtn + delBtn
    +   '</div>'
    + '</div>'
    // Zones
    + '<div id="zones-' + id + '" style="display:flex;flex-wrap:wrap;gap:4px">' + pills + '</div>'
    // Association
    + (assoc
      ? '<div id="assoc-' + id + '" style="font-size:12px;font-style:italic;color:#6b7280;line-height:1.4">' + assoc + '</div>'
      : '<div id="assoc-' + id + '" style="font-size:12px;color:#d1d5db">…</div>')
    // Score grid
    + '<div style="display:grid;grid-template-columns:1fr 1fr;gap:5px 12px">'
    +   miniBar('LEN', scores.len, w.len) + miniBar('PRO', scores.pro, w.pro)
    +   miniBar('MEM', scores.mem, w.mem) + miniBar('BRD', scores.brd, w.brd)
    +   miniBar('ZON', scores.zon, w.zon) + miniBar('FIT', scores.fit, w.fit)
    + '</div>'
    // Total
    + '<div style="display:flex;align-items:center;justify-content:flex-end;gap:8px">'
    +   '<span style="font-size:11px;color:#a78bfa">TOTAL</span>'
    +   '<span style="font-size:18px;font-weight:800;color:' + totalColor + ';background:' + totalBg + ';padding:2px 10px;border-radius:8px">' + scores.total + '</span>'
    +   ''
    + '</div>'
    + '</div>'
}

function scoreRow(s, rank) {
  const { id, domain, scores, superFavorite: isSuper, available } = s
  const medalColors = ['text-yellow-500', 'text-gray-400', 'text-amber-600']
  const medal = rank < 3 ? '<span class="' + medalColors[rank] + ' font-bold text-xs mr-0.5">#' + (rank + 1) + '</span>' : '<span class="text-gray-300 text-xs mr-0.5">' + (rank + 1) + '.</span>'
  const mx = scores.maxTotal || 70
  const totalColor = scores.total >= mx * 0.67 ? 'text-green-700 bg-green-50' : scores.total >= mx * 0.47 ? 'text-yellow-700 bg-yellow-50' : 'text-red-600 bg-red-50'
  const rowBg = isSuper ? ' bg-orange-50' : ''
  const nameColor = available ? 'text-green-800' : 'text-gray-500'
  const zones = zoneCache[id] || {}
  const stem = domain.replace(/\.[a-z]+$/, '')
  const pills = Object.keys(zones).length ? zonePillsHTML(zones, null, stem) : '<span class="text-gray-300 text-xs">checking...</span>'
  const superBtn = '<button onclick="toggleSuper(\'' + id + '\')" title="Super favorite" aria-label="Toggle super favorite" style="font-size:16px;line-height:1;color:' + (isSuper ? '#f97316' : '#d1d5db') + '" onmouseover="this.style.color=\'#f97316\'" onmouseout="this.style.color=\'' + (isSuper ? '#f97316' : '#d1d5db') + '\'">&#9733;&#9733;</button>'
  const starBtn = '<button onclick="toggleFav(\'' + id + '\')" title="Remove from favorites" aria-label="Remove from favorites" style="font-size:18px;line-height:1;color:#fbbf24" onmouseover="this.style.color=\'#f59e0b\'" onmouseout="this.style.color=\'#fbbf24\'">&#9733;</button>'
  const delBtn = '<button onclick="deleteDomain(\'' + id + '\',this)" title="Delete" aria-label="Remove domain" style="font-size:14px;font-weight:bold;color:#d1d5db" onmouseover="this.style.color=\'#f87171\'" onmouseout="this.style.color=\'#d1d5db\'">&#x2715;</button>'
  const assocRaw = assocCache[id]
  const assoc = Array.isArray(assocRaw) ? assocRaw.join(' · ') : (assocRaw || null)
  return '<tr class="hover:bg-purple-25' + rowBg + '">'
    + '<td class="px-3 py-2" style="width:160px">'
    + '<div class="flex items-center gap-1 flex-wrap">' + medal + '<span class="font-mono font-semibold ' + nameColor + '">' + domain + '</span></div>'
    + '</td>'
    + '<td class="px-2 py-2" style="width:210px">'
    + '<div id="zones-' + id + '" class="flex flex-wrap gap-1">' + pills + '</div>'
    + '</td>'
    + '<td class="px-2 py-2">'
    + '<div id="assoc-' + id + '" class="text-sm italic ' + (assoc ? 'text-gray-500' : 'text-gray-300') + '" style="line-height:1.35;white-space:normal">' + (assoc || '…') + '</div>'
    + '</td>'
    + (()=>{ const w = getWeights(); return ''
    + '<td class="py-2" style="width:52px">' + scoreCell(scores.len, w.len) + '</td>'
    + '<td class="py-2" style="width:52px">' + scoreCell(scores.pro, w.pro) + '</td>'
    + '<td class="py-2" style="width:52px">' + scoreCell(scores.mem, w.mem) + '</td>'
    + '<td class="py-2" style="width:52px">' + scoreCell(scores.brd, w.brd) + '</td>'
    + '<td class="py-2" style="width:52px">' + scoreCell(scores.zon, w.zon) + '</td>'
    + '<td class="py-2" style="width:52px">' + scoreCell(scores.fit, w.fit) + '</td>'
    })()
    + '<td class="py-2 text-center" style="width:70px"><span class="font-bold text-base ' + totalColor + ' px-1.5 py-0.5 rounded">' + scores.total + '</span></td>'
    + '<td class="py-2" style="width:80px">' + scoreBar(scores.total, mx) + '</td>'
    + '<td class="px-2 py-2 text-center whitespace-nowrap" style="min-width:90px">'
    + '<div class="flex items-center justify-center gap-2">' + superBtn + starBtn + delBtn + '</div>'
    + '</td>'
    + '</tr>'
}

function renderZonePills(el, zones, filterZones, name) {
  el.innerHTML = '<div class="flex flex-wrap gap-1">' + zonePillsHTML(zones, filterZones, name) + '</div>'
}

async function loadFavData(favorites) {
  const compareZones = getCompareZones()

  // Load all data from DB into in-memory caches (don't overwrite existing in-memory cache)
  for (const d of favorites) {
    if (!zoneCache[d.id]) zoneCache[d.id] = d.zones ? JSON.parse(d.zones) : {}
    if (fitCache[d.id] == null && (d.fitScore != null || d.proScore != null)) {
      fitCache[d.id] = { fit: d.fitScore ?? null, pro: d.proScore ?? null, mem: d.memScore ?? null, brd: d.brdScore ?? null }
    }
    if (assocCache[d.id] == null && d.association) {
      try { assocCache[d.id] = JSON.parse(d.association) } catch { assocCache[d.id] = [d.association] }
    }
  }

  // Auto-set FIT context if empty
  const fitInput = document.getElementById('fitContext')
  if (!fitInput.value.trim()) {
    const descriptions = [...new Set(favorites.map(d => d.description).filter(Boolean))]
    if (descriptions.length) fitInput.value = descriptions.join('; ')
  }

  // Render immediately with what we have
  renderScores(favorites)

  // Only fetch zones/fit/assoc for NEW favorites not yet loaded this session
  const newFavs = favorites.filter(d => !_loadedFavIds.has(d.id))
  if (!newFavs.length) return
  newFavs.forEach(d => _loadedFavIds.add(d.id))

  const aiKey = loadSetting('aiApiKey') || undefined

  // Zones: only check zones missing from in-memory cache
  const needZonesFetch = []
  for (const d of newFavs) {
    const cached = zoneCache[d.id] || {}
    const missing = compareZones.filter(z => !(z in cached))
    if (missing.length) needZonesFetch.push({ d, missing })
  }
  for (const { d, missing } of needZonesFetch) {
    const name = d.domain.replace(/\.[a-z]+$/, '')
    const el = document.getElementById('zones-' + d.id)
    try {
      const zones = await checkMultipleZones(name, missing)
      zoneCache[d.id] = { ...zoneCache[d.id], ...zones }
      db.update(d.id, { zones: JSON.stringify(zoneCache[d.id]) })
      if (el) renderZonePills(el, zoneCache[d.id], compareZones, name)
    } catch {
      if (el) el.innerHTML = '<span class="text-gray-300 text-xs">zone check failed</span>'
    }
  }
  if (needZonesFetch.length) renderScores(favorites)

  // AI scores (FIT+PRO+MEM+BRD): only for new favorites without scores
  const fitContext = fitInput.value.trim()
  const needFit = newFavs.filter(d => fitCache[d.id] == null)
  if (needFit.length && fitContext) {
    try {
      const scores = await scoreFitBatch(needFit.map(d => d.domain), fitContext, aiKey, undefined, loadSetting('scoringModel'), loadSetting('scoringPreset') || 'off')
      for (const d of needFit) {
        if (scores[d.domain] !== undefined) {
          const s = scores[d.domain]
          fitCache[d.id] = s
          db.update(d.id, { fitScore: s.fit, proScore: s.pro ?? null, memScore: s.mem ?? null, brdScore: s.brd ?? null })
        }
      }
      renderScores(favorites)
    } catch {}
  }

  // Associations: only for new favorites without one
  const assocPrompt = getAssocPrompt()
  const needAssoc = newFavs.filter(d => assocCache[d.id] == null)
  if (needAssoc.length) {
    try {
      const assocs = await associateDomains(needAssoc.map(d => d.domain), aiKey, assocPrompt, loadSetting('creativeModel'), loadSetting('creativePreset') || 'off')
      for (const d of needAssoc) {
        if (assocs[d.domain]) {
          assocCache[d.id] = assocs[d.domain]
          db.update(d.id, { association: JSON.stringify(assocs[d.domain]) })
          const el = document.getElementById('assoc-' + d.id)
          if (el) {
            el.textContent = assocs[d.domain].join(' · ')
            el.className = 'text-sm italic text-gray-500'
          }
        }
      }
    } catch {}
  }
}

async function refreshZones() {
  const favorites = window._lastFavorites
  if (!favorites?.length) return
  const btn = document.querySelector('button[onclick="refreshZones()"]')
  if (btn) { btn.textContent = '⏳'; btn.style.opacity = '1'; btn.disabled = true }
  const compareZones = getCompareZones()
  for (const d of favorites) {
    const name = d.domain.replace(/\.[a-z]+$/, '')
    const el = document.getElementById('zones-' + d.id)
    if (el) el.innerHTML = '<span class="text-gray-300 text-xs">checking...</span>'
    try {
      const zones = await checkMultipleZones(name, compareZones)
      zoneCache[d.id] = { ...zoneCache[d.id], ...zones }
      db.update(d.id, { zones: JSON.stringify(zoneCache[d.id]) })
      if (el) renderZonePills(el, zoneCache[d.id], compareZones, name)
    } catch {
      if (el) el.innerHTML = '<span class="text-gray-300 text-xs">failed</span>'
    }
  }
  renderScores(favorites)
  if (btn) { btn.innerHTML = '&#x21bb;'; btn.style.opacity = '0.6'; btn.disabled = false }
}

async function refreshAssociations() {
  const favorites = window._lastFavorites
  if (!favorites?.length) return
  const btn = document.querySelector('button[onclick="refreshAssociations()"]')
  if (btn) { btn.textContent = '⏳'; btn.style.opacity = '1'; btn.disabled = true }
  const aiKey = loadSetting('aiApiKey') || undefined
  const assocPrompt = getAssocPrompt()
  try {
    const assocs = await associateDomains(favorites.map(d => d.domain), aiKey, assocPrompt, loadSetting('creativeModel'), loadSetting('creativePreset') || 'off')
    const updated = Object.keys(assocs).length
    if (!updated) throw new Error('AI returned no associations — check API key or prompt')
    for (const d of favorites) {
      if (assocs[d.domain]) {
        assocCache[d.id] = assocs[d.domain]
        db.update(d.id, { association: JSON.stringify(assocs[d.domain]) })
      }
    }
    renderScores(favorites)
    if (btn) { btn.innerHTML = '&#x21bb;'; btn.style.opacity = '0.5'; btn.disabled = false }
  } catch (e) {
    if (btn) { btn.innerHTML = '&#x21bb;'; btn.style.opacity = '0.5'; btn.disabled = false }
    alert('Association refresh failed: ' + e.message)
  }
}

function renderScores(favorites) {
  if (!favorites) return
  window._lastFavorites = favorites
  const scoreSection = document.getElementById('scoreSection')
  const scoreBody = document.getElementById('scoreTableBody')
  if (!favorites.length) { scoreSection.classList.add('hidden'); return }

  const scored = favorites.map(d => {
    const name = d.domain.replace(/\.[a-z]+$/, '')
    const zones = zoneCache[d.id] || null
    const aiScores = fitCache[d.id] ?? null
    const scores = scoreDomain(name, zones, aiScores)
    return { id: d.id, domain: d.domain, name, scores, superFavorite: d.superFavorite, available: d.available }
  })
  scored.sort((a, b) => {
    if (a.superFavorite !== b.superFavorite) return b.superFavorite ? 1 : -1
    return b.scores.total - a.scores.total
  })

  const superCount = favorites.filter(d => d.superFavorite).length
  document.getElementById('favCount').textContent = favorites.length + (superCount ? ' ★★' + superCount : '')
  scoreBody.innerHTML = scored.map((s, i) => scoreRow(s, i)).join('')
  document.getElementById('scoreCards').innerHTML = scored.map((s, i) => scoreCard(s, i)).join('')
  scoreSection.classList.remove('hidden')
}

async function rescoreFit() {
  const context = document.getElementById('fitContext').value.trim()
  if (!context) { alert('Enter an app idea description for FIT scoring'); return }
  const btn = document.querySelector('#scoreSection button[onclick="rescoreFit()"]')
  const origText = btn.textContent
  btn.textContent = 'Scoring...'
  btn.disabled = true

  const domains = db.findMany()
  const favorites = domains.filter(d => d.favorite)
  if (!favorites.length) { btn.textContent = origText; btn.disabled = false; return }

  fitCache = {}
  renderScores(favorites)

  const aiKey = loadSetting('aiApiKey') || undefined
  const fitPrompt = document.getElementById('fitPromptBox')?.value || loadSetting('fitPrompt') || undefined
  try {
    const scores = await scoreFitBatch(favorites.map(d => d.domain), context, aiKey, fitPrompt, loadSetting('scoringModel'), loadSetting('scoringPreset') || 'off')
    for (const d of favorites) {
      if (scores[d.domain] !== undefined) {
        const s = scores[d.domain]
        fitCache[d.id] = s
        db.update(d.id, { fitScore: s.fit, proScore: s.pro ?? null, memScore: s.mem ?? null, brdScore: s.brd ?? null })
      }
    }
    renderScores(favorites)
  } catch (e) {
    console.error('AI re-score failed', e)
  }
  btn.textContent = origText
  btn.disabled = false
}

const PAGE_SIZE = 100

function renderSavedAvailPage(available, page) {
  const savedList = document.getElementById('savedAvailList')
  const total = available.length
  const totalPages = Math.ceil(total / PAGE_SIZE)
  const start = page * PAGE_SIZE
  const slice = available.slice(start, start + PAGE_SIZE)
  savedList.innerHTML = slice.map(d => domainRow(d, { compact: true, showDelete: true, noBadge: true })).join('')
  const ctrl = document.getElementById('savedAvailPager')
  if (totalPages <= 1) { if (ctrl) ctrl.innerHTML = ''; return }
  ctrl.innerHTML = (page > 0 ? '<button onclick="window._savedAvailPage(' + (page - 1) + ')" class="px-3 py-1 text-sm bg-green-100 text-green-700 rounded hover:bg-green-200">&larr; Prev</button>' : '')
    + '<span class="text-sm text-gray-500 mx-3">' + (start + 1) + '–' + Math.min(start + PAGE_SIZE, total) + ' of ' + total + '</span>'
    + (page < totalPages - 1 ? '<button onclick="window._savedAvailPage(' + (page + 1) + ')" class="px-3 py-1 text-sm bg-green-100 text-green-700 rounded hover:bg-green-200">Next &rarr;</button>' : '')
  window._savedAvailAll = available
  window._savedAvailPage = (p) => renderSavedAvailPage(available, p)
}

function renderHistoryPage(allDomains, page) {
  const list = document.getElementById('historyList')
  const total = allDomains.length
  const totalPages = Math.ceil(total / PAGE_SIZE)
  const start = page * PAGE_SIZE
  const slice = allDomains.slice(start, start + PAGE_SIZE)
  list.innerHTML = slice.map(d => domainRow(d, { compact: true })).join('')
  const ctrl = document.getElementById('historyPager')
  if (totalPages <= 1) { if (ctrl) ctrl.innerHTML = ''; return }
  ctrl.innerHTML = (page > 0 ? '<button onclick="window._historyPage(' + (page - 1) + ')" class="px-3 py-1 text-sm bg-gray-100 text-gray-600 rounded hover:bg-gray-200">&larr; Prev</button>' : '')
    + '<span class="text-sm text-gray-500 mx-3">' + (start + 1) + '–' + Math.min(start + PAGE_SIZE, total) + ' of ' + total + '</span>'
    + (page < totalPages - 1 ? '<button onclick="window._historyPage(' + (page + 1) + ')" class="px-3 py-1 text-sm bg-gray-100 text-gray-600 rounded hover:bg-gray-200">Next &rarr;</button>' : '')
  window._historyPage = (p) => renderHistoryPage(allDomains, p)
}

function loadSaved() {
  const domains = db.findMany()
  loadSets()
  if (!domains.length) {
    document.getElementById('scoreSection').classList.add('hidden')
    document.getElementById('savedSection').classList.add('hidden')
    document.getElementById('historySection').classList.add('hidden')
    return
  }

  const favorites = domains.filter(d => d.favorite)
  favorites.sort((a, b) => (b.superFavorite ? 1 : 0) - (a.superFavorite ? 1 : 0))
  const available = domains.filter(d => d.available && !d.favorite)

  if (favorites.length) {
    loadFavData(favorites)
  } else {
    document.getElementById('scoreSection').classList.add('hidden')
  }

  const savedSection = document.getElementById('savedSection')
  if (available.length) {
    savedSection.classList.remove('hidden')
    document.getElementById('savedAvailCount').textContent = available.length
    renderSavedAvailPage(available, 0)
  } else {
    savedSection.classList.add('hidden')
  }

  const historySection = document.getElementById('historySection')
  historySection.classList.remove('hidden')
  document.getElementById('historyTotal').textContent = domains.length
  renderHistoryPage(domains, 0)
}

function deleteDomain(id) {
  db.delete(id)
  loadSaved()
}

function clearHistory() {
  if (!confirm('Clear all saved domains?')) return
  db.deleteMany()
  zoneCache = {}
  fitCache = {}
  assocCache = {}
  _loadedFavIds.clear()
  window._lastFavorites = []
  loadSaved()
}

async function copyFavDomains() {
  const favs = window._lastFavorites
  if (!favs?.length) return
  const text = favs.map(d => d.domain).join('\n')
  await navigator.clipboard.writeText(text)
  const btn = document.getElementById('copyFavsBtn')
  if (btn) { btn.textContent = 'Copied!'; setTimeout(() => btn.textContent = 'Copy', 1500) }
}

function clearFavoritesOnly() {
  if (!confirm('Clear all favorites without saving?')) return
  db.clearFavorites()
  zoneCache = {}
  fitCache = {}
  assocCache = {}
  _loadedFavIds.clear()
  window._lastFavorites = []
  document.getElementById('scoreSection').classList.add('hidden')
  loadSaved()
}

async function promptSaveFavs() {
  const name = prompt('Name this favorite set:')
  if (!name) return
  const fitContext = document.getElementById('fitContext').value.trim()
  const set = db.createSet(name, fitContext || null)
  if (!set) { alert('No favorites to save'); return }
  loadSets()
}

// Generic section collapse — works for any section with {name}Body and {name}CollapseIcon elements
function toggleSectionCollapse(name) {
  const body = document.getElementById(name + 'Body') || document.getElementById(name + 'FormBody')
  const icon = document.getElementById(name + 'CollapseIcon')
  if (!body) return
  const collapsed = body.classList.toggle('hidden')
  if (icon) icon.textContent = collapsed ? '▸' : '▾'
  localStorage.setItem(name + 'Collapsed', collapsed ? '1' : '')
}

function restoreSectionCollapse(name) {
  if (!localStorage.getItem(name + 'Collapsed')) return
  const body = document.getElementById(name + 'Body') || document.getElementById(name + 'FormBody')
  const icon = document.getElementById(name + 'CollapseIcon')
  if (body) body.classList.add('hidden')
  if (icon) icon.textContent = '▸'
}

// Backwards-compatible aliases
function toggleSearchCollapse() { toggleSectionCollapse('search') }
function toggleSetsCollapse() { toggleSectionCollapse('sets') }

function loadSets() {
  const sets = db.listSets()
  const section = document.getElementById('setsSection')
  const list = document.getElementById('setsBody')
  const grid = document.getElementById('row1Grid')
  if (!sets.length) {
    section.classList.add('hidden')
    grid.classList.remove('xl:grid-cols-2')
    return
  }
  grid.classList.add('xl:grid-cols-2')
  section.classList.remove('hidden')
  list.innerHTML = sets.map(s => {
    const date = new Date(s.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
    const domains = JSON.parse(s.domains)
    const superCount = domains.filter(d => d.superFavorite).length
    const preview = domains.slice(0, 4).map(d => d.domain).join(', ') + (domains.length > 4 ? '...' : '')
    return '<div class="px-6 py-3 flex items-center justify-between hover:bg-amber-25">'
      + '<div>'
      + '<span class="font-semibold text-amber-900">' + s.name + '</span>'
      + '<span class="text-xs text-amber-500 ml-2">' + s.count + ' domains' + (superCount ? ' (' + superCount + ' super)' : '') + '</span>'
      + '<span class="text-xs text-gray-400 ml-2">' + date + '</span>'
      + '<div class="text-xs text-gray-400 font-mono mt-0.5">' + preview + '</div>'
      + (s.fitContext ? '<div class="text-xs text-purple-400 mt-0.5">FIT: ' + s.fitContext + '</div>' : '')
      + '</div>'
      + '<div class="flex items-center gap-2">'
      + '<button onclick="restoreSet(\'' + s.id + '\')" class="text-xs bg-amber-100 hover:bg-amber-200 text-amber-800 px-3 py-1 rounded font-medium">Restore</button>'
      + '<button onclick="deleteSet(\'' + s.id + '\')" class="text-gray-300 hover:text-red-400 text-xs">x</button>'
      + '</div>'
      + '</div>'
  }).join('')
  restoreSectionCollapse('sets')
}

function restoreSet(id) {
  if (!confirm('This will replace your current favorites with the saved set. Continue?')) return
  const data = db.restoreSet(id)
  if (data?.fitContext != null) {
    const el = document.getElementById('fitContext')
    el.value = data.fitContext
    onFitContextInput()
  }
  zoneCache = {}
  fitCache = {}
  assocCache = {}
  _loadedFavIds.clear()
  loadSaved()
}

function deleteSet(id) {
  db.deleteSet(id)
  loadSets()
}

function exportData() {
  db.exportJSON()
}

// --- Main search ---
async function startSearch() {
  const desc = document.getElementById('description').value.trim()
  if (!desc) return

  const btn = document.getElementById('searchBtn')
  btn.disabled = true
  btn.textContent = 'Searching...'
  btn.classList.add('opacity-50')
  document.getElementById('stopBtn').classList.remove('hidden')
  document.getElementById('statusMsg').textContent = ''

  if (_abortController) _abortController.abort()
  _abortController = new AbortController()
  const signal = _abortController.signal

  const zones = getSelectedZones()
  const customPrompt = document.getElementById('promptBox').value.trim()
  const aiKey = loadSetting('aiApiKey') || undefined

  // Save active search state for resume
  const activeSearch = { description: desc, zones, prompt: customPrompt || '' }
  saveSetting('activeSearch', activeSearch)
  document.getElementById('resumeBanner').classList.add('hidden')

  try {
    document.getElementById('statusMsg').textContent = 'Generating domain name ideas...'
    let names
    try {
      names = await generateDomainNames(desc, customPrompt || undefined, aiKey, loadSetting('creativeModel'), loadSetting('batchSize') || 60, loadSetting('creativePreset') || 'off')
    } catch (e) {
      document.getElementById('statusMsg').textContent = 'Error: ' + e.message
      searchDone()
      return
    }

    if (signal.aborted) { searchDone(); return }

    const stems = [...new Set(names.map(n => n.replace(/\.[a-z]+$/, '')))]
    document.getElementById('generatedWordsList').textContent = stems.join('  ·  ')
    document.getElementById('generatedWords').classList.remove('hidden')

    const total = names.length * zones.length
    document.getElementById('statusMsg').textContent = 'Checking availability of ' + total + ' domains across ' + zones.length + ' zone' + (zones.length > 1 ? 's' : '') + '...'

    const tasks = names.flatMap(name => zones.map(zone => name + '.' + zone))
    let nextIdx = 0
    let completed = 0
    const CONCURRENCY = 6

    const worker = async () => {
      while (true) {
        if (signal.aborted) return
        const taskIdx = nextIdx++
        if (taskIdx >= tasks.length) return
        const domain = tasks[taskIdx]

        document.getElementById('statusMsg').textContent = 'Checking ' + domain + '... (' + (completed + 1) + '/' + total + ')'

        const available = await checkDomainAvailable(domain, signal)
        if (signal.aborted) return

        const record = db.upsert(domain, { domain, available, description: desc }, { available, description: desc })

        // Append to history
        const historySection = document.getElementById('historySection')
        historySection.classList.remove('hidden')
        const historyList = document.getElementById('historyList')
        const hrow = document.createElement('div')
        hrow.innerHTML = domainRow(record, { compact: true })
        historyList.insertBefore(hrow.firstChild, historyList.firstChild)
        const ht = document.getElementById('historyTotal')
        ht.textContent = parseInt(ht.textContent || '0') + 1

        // Append available to saved section (not unknown)
        if (available === true) {
          const savedSection = document.getElementById('savedSection')
          savedSection.classList.remove('hidden')
          const savedList = document.getElementById('savedAvailList')
          const srow = document.createElement('div')
          srow.innerHTML = domainRow(record, { compact: true, showDelete: true, noBadge: true })
          savedList.insertBefore(srow.firstChild, savedList.firstChild)
          const sc = document.getElementById('savedAvailCount')
          sc.textContent = parseInt(sc.textContent || '0') + 1
        }

        completed++
      }
    }

    const workers = []
    for (let w = 0; w < Math.min(CONCURRENCY, tasks.length); w++) workers.push(worker())
    await Promise.all(workers)
  } catch (e) {
    if (!signal.aborted) {
      document.getElementById('statusMsg').textContent = 'Error: ' + e.message
    }
  }

  searchDone()
  loadSaved()
}

function searchDone() {
  _abortController = null
  saveSetting('activeSearch', null)
  const btn = document.getElementById('searchBtn')
  btn.disabled = false
  btn.textContent = 'Search Domains'
  btn.classList.remove('opacity-50')
  document.getElementById('stopBtn').classList.add('hidden')
  const status = document.getElementById('statusMsg')
  if (!status.textContent.startsWith('Error') && !status.textContent.startsWith('Stopped')) {
    status.textContent = 'Done! (auto-saved)'
  }
  document.getElementById('generatedWords').classList.add('hidden')
}

function stopSearch() {
  if (_abortController) {
    _abortController.abort()
    _abortController = null
  }
  document.getElementById('statusMsg').textContent = 'Stopped.'
  searchDone()
  loadSaved()
}

// --- Settings ---
let _saveDescTimer = null
function onDescriptionInput() {
  clearTimeout(_saveDescTimer)
  _saveDescTimer = setTimeout(() => {
    saveSetting('description', document.getElementById('description').value)
  }, 600)
}

function loadDescription() {
  const val = loadSetting('description')
  if (val) document.getElementById('description').value = val
}

let _saveFitTimer = null
function onFitContextInput() {
  clearTimeout(_saveFitTimer)
  _saveFitTimer = setTimeout(() => {
    const val = document.getElementById('fitContext').value
    saveSetting('fitContext', val)
  }, 600)
}

function loadFitContext() {
  const val = loadSetting('fitContext')
  if (val != null) document.getElementById('fitContext').value = val
}

function saveWeights() {
  // Skip save if the active field is mid-edit (empty, not yet "0" or another value)
  const active = document.activeElement
  if (active && active.value === '' && ['wLen','wPro','wMem','wBrd','wZon','wFit'].includes(active.id)) return
  saveSetting('domainWeights', getWeights())
}

function loadWeights() {
  const w = loadSetting('domainWeights')
  if (!w) return
  const ids = { len: 'wLen', pro: 'wPro', mem: 'wMem', brd: 'wBrd', zon: 'wZon', fit: 'wFit' }
  for (const [k, elId] of Object.entries(ids)) {
    if (w[k] != null) {
      const el = document.getElementById(elId)
      if (el) el.value = w[k]
    }
  }
}

let _savedPromptValue = ''
function loadGenPrompt() {
  const val = loadSetting('genPrompt')
  // If saved prompt is the old default (before STEP 1/STEP 2 rewrite), replace with new default
  const isOldDefault = val && val.startsWith('You are a creative domain name generator.')
  _savedPromptValue = (val && !isOldDefault) ? val : DEFAULT_SYSTEM_PROMPT
  if (isOldDefault) saveSetting('genPrompt', null)
  document.getElementById('promptBox').value = _savedPromptValue
  document.getElementById('promptBox').addEventListener('input', () => {
    const changed = document.getElementById('promptBox').value !== _savedPromptValue
    document.getElementById('savePromptBtn').classList.toggle('hidden', !changed)
  })
}

function resetPrompt() {
  document.getElementById('promptBox').value = DEFAULT_SYSTEM_PROMPT
  saveGenPrompt()
}

function saveGenPrompt(showConfirm) {
  _savedPromptValue = document.getElementById('promptBox').value
  saveSetting('genPrompt', _savedPromptValue)
  document.getElementById('savePromptBtn').classList.add('hidden')
  if (showConfirm) {
    const el = document.getElementById('promptSaved')
    el.classList.remove('hidden')
    setTimeout(() => el.classList.add('hidden'), 2000)
  }
}

// --- Association prompt settings ---
let _savedAssocPromptValue = ''

function getAssocPrompt() {
  const box = document.getElementById('assocPromptBox')
  const val = box?.value || loadSetting('assocPrompt') || undefined
  // Auto-save if textarea differs from last saved value
  if (box && val && val !== _savedAssocPromptValue) {
    _savedAssocPromptValue = val
    saveSetting('assocPrompt', val)
    document.getElementById('saveAssocPromptBtn')?.classList.add('hidden')
  }
  return val
}

function loadAssocPrompt() {
  const val = loadSetting('assocPrompt')
  _savedAssocPromptValue = val || DEFAULT_ASSOC_PROMPT
  const box = document.getElementById('assocPromptBox')
  box.value = _savedAssocPromptValue
  box.addEventListener('input', () => {
    const changed = box.value !== _savedAssocPromptValue
    document.getElementById('saveAssocPromptBtn').classList.toggle('hidden', !changed)
  })
}

function resetAssocPrompt() {
  document.getElementById('assocPromptBox').value = DEFAULT_ASSOC_PROMPT
  saveAssocPrompt()
}

function saveAssocPrompt(showConfirm) {
  _savedAssocPromptValue = document.getElementById('assocPromptBox').value
  saveSetting('assocPrompt', _savedAssocPromptValue)
  document.getElementById('saveAssocPromptBtn').classList.add('hidden')
  if (showConfirm) {
    const el = document.getElementById('assocPromptSaved')
    el.classList.remove('hidden')
    setTimeout(() => el.classList.add('hidden'), 2000)
  }
  // Auto-refresh associations with new prompt
  const favorites = window._lastFavorites
  if (favorites?.length) {
    assocCache = {}
    refreshAssociations()
  }
}

let _savedFitPromptValue = ''
function loadFitPrompt() {
  const val = loadSetting('fitPrompt')
  // Auto-upgrade: old prompt only scored FIT (no PRO/MEM/BRD)
  const isOldFormat = val && !val.includes('PRO:')
  _savedFitPromptValue = (val && !isOldFormat) ? val : DEFAULT_FIT_PROMPT
  if (isOldFormat) saveSetting('fitPrompt', DEFAULT_FIT_PROMPT)
  const box = document.getElementById('fitPromptBox')
  box.value = _savedFitPromptValue
  box.addEventListener('input', () => {
    const changed = box.value !== _savedFitPromptValue
    document.getElementById('saveFitPromptBtn').classList.toggle('hidden', !changed)
  })
}

function resetFitPrompt() {
  document.getElementById('fitPromptBox').value = DEFAULT_FIT_PROMPT
  saveFitPrompt()
}

function saveFitPrompt(showConfirm) {
  _savedFitPromptValue = document.getElementById('fitPromptBox').value
  saveSetting('fitPrompt', _savedFitPromptValue)
  document.getElementById('saveFitPromptBtn').classList.add('hidden')
  if (showConfirm) {
    const el = document.getElementById('fitPromptSaved')
    el.classList.remove('hidden')
    setTimeout(() => el.classList.add('hidden'), 2000)
  }
}

let _savedSynonymPromptValue = ''
function loadSynonymPrompt() {
  const val = loadSetting('synonymPrompt')
  _savedSynonymPromptValue = val || DEFAULT_SYNONYM_PROMPT
  document.getElementById('synonymsPromptBox').value = _savedSynonymPromptValue
  document.getElementById('synonymsPromptBox').addEventListener('input', () => {
    const changed = document.getElementById('synonymsPromptBox').value !== _savedSynonymPromptValue
    document.getElementById('saveSynonymPromptBtn').classList.toggle('hidden', !changed)
  })
  // Restore toggle state
  if (loadSetting('synonymsOn')) {
    document.getElementById('synonymsToggle')?.classList.add('active')
    document.getElementById('synonymsToggle').style.cssText = 'background:#0891b2;color:#fff;border-color:#0891b2'
    document.getElementById('synonymsPromptControls')?.classList.remove('hidden')
  }
}

function toggleSynonyms() {
  const btn = document.getElementById('synonymsToggle')
  const on = !btn.classList.contains('active')
  btn.classList.toggle('active', on)
  btn.style.cssText = on ? 'background:#0891b2;color:#fff;border-color:#0891b2' : ''
  document.getElementById('synonymsPromptControls').classList.toggle('hidden', !on)
  saveSetting('synonymsOn', on)
}

function resetSynonymPrompt() {
  document.getElementById('synonymsPromptBox').value = DEFAULT_SYNONYM_PROMPT
  saveSynonymPrompt()
}

function saveSynonymPrompt(showConfirm) {
  _savedSynonymPromptValue = document.getElementById('synonymsPromptBox').value
  saveSetting('synonymPrompt', _savedSynonymPromptValue)
  document.getElementById('saveSynonymPromptBtn').classList.add('hidden')
  if (showConfirm) {
    const el = document.getElementById('synonymPromptSaved')
    el.classList.remove('hidden')
    setTimeout(() => el.classList.add('hidden'), 2000)
  }
}

function checkActiveSearch() {
  const job = loadSetting('activeSearch')
  if (!job) return
  _activeSearch = job
  document.getElementById('resumeBanner').classList.remove('hidden')
}

function dismissResume() {
  document.getElementById('resumeBanner').classList.add('hidden')
  saveSetting('activeSearch', null)
  _activeSearch = null
}

function resumeSearch() {
  if (!_activeSearch) return
  document.getElementById('resumeBanner').classList.add('hidden')
  document.getElementById('description').value = _activeSearch.description
  if (_activeSearch.prompt) document.getElementById('promptBox').value = _activeSearch.prompt
  startSearch()
}

let _savedAiKey = ''

function _updateProviderBadge(key) {
  const label = document.getElementById('aiProviderLabel')
  const badge = document.getElementById('aiProviderBadge')
  const addBtn = document.getElementById('addKeyBtn')
  const hasCustomKey = key && key.length > 0
  const providerName = hasCustomKey ? detectProvider(key) : 'Groq'
  label.textContent = providerName
  if (hasCustomKey) {
    badge.className = 'inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-semibold bg-cyan-50 text-cyan-700 border border-cyan-200'
    badge.querySelector('span').className = 'w-1.5 h-1.5 rounded-full bg-cyan-400 inline-block'
    addBtn.textContent = '✓ my key'
    addBtn.className = 'text-xs text-cyan-600 border border-cyan-300 px-2.5 py-1 rounded-full'
  } else {
    badge.className = 'inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-semibold bg-orange-100 text-orange-700 border border-orange-200'
    badge.querySelector('span').className = 'w-1.5 h-1.5 rounded-full bg-orange-400 inline-block'
    addBtn.textContent = '+ add my key'
    addBtn.className = 'text-xs text-gray-400 hover:text-cyan-600 border border-gray-200 hover:border-cyan-400 px-2.5 py-1 rounded-full transition-colors'
  }
}

function toggleKeyInput() {
  const row = document.getElementById('aiKeyRow')
  const visible = !row.classList.contains('hidden')
  row.classList.toggle('hidden', visible)
  if (!visible) document.getElementById('aiKeyInput').focus()
}

function onAiKeyInput(val) {
  _updateProviderBadge(val)
  document.getElementById('saveAiKeyBtn').classList.toggle('hidden', val === _savedAiKey)
}

function saveAiKey() {
  const key = document.getElementById('aiKeyInput').value
  _savedAiKey = key
  saveSetting('aiApiKey', key)
  document.getElementById('saveAiKeyBtn').classList.add('hidden')
  _updateProviderBadge(key)
  if (!key) document.getElementById('aiKeyRow').classList.add('hidden')
  populateModelDropdowns()
  const el = document.getElementById('aiKeySaved')
  el.classList.remove('hidden')
  setTimeout(() => el.classList.add('hidden'), 2000)
}

function clearAiKey() {
  document.getElementById('aiKeyInput').value = ''
  _savedAiKey = ''
  _updateProviderBadge('')
  document.getElementById('saveAiKeyBtn').classList.add('hidden')
  document.getElementById('aiKeyRow').classList.add('hidden')
  saveSetting('aiApiKey', '')
  populateModelDropdowns()
}

function loadAiKey() {
  const val = loadSetting('aiApiKey')
  if (val) {
    _savedAiKey = val
    document.getElementById('aiKeyInput').value = val
    document.getElementById('aiKeyRow').classList.remove('hidden')
  }
  _updateProviderBadge(val || '')
}

// --- Model dropdowns ---
const MODEL_OPTIONS = {
  'Claude (Anthropic)': [
    { id: 'claude-opus-4-7', label: 'Claude Opus 4.7 (default)' },
    { id: 'claude-opus-4-6', label: 'Claude Opus 4.6' },
    { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6' },
    { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5 (cheapest)' },
  ],
  'OpenAI': [
    { id: 'gpt-4o', label: 'GPT-4o (default)' },
    { id: 'gpt-4o-mini', label: 'GPT-4o mini' },
  ],
  'Groq (default)': [
    { id: 'llama-3.3-70b-versatile', label: 'Llama 3.3 70B Versatile (default)' },
    { id: 'llama-3.1-8b-instant', label: 'Llama 3.1 8B Instant' },
  ],
  'Groq': [
    { id: 'llama-3.3-70b-versatile', label: 'Llama 3.3 70B Versatile (default)' },
    { id: 'llama-3.1-8b-instant', label: 'Llama 3.1 8B Instant' },
  ],
}

function populateModelDropdowns() {
  const key = loadSetting('aiApiKey') || ''
  const provider = detectProvider(key)
  const options = MODEL_OPTIONS[provider] || MODEL_OPTIONS['Groq (default)']
  const defaultId = options[0].id
  const validIds = options.map(o => o.id)

  const slots = [
    ['creativeModel', 'creativeModel', null],
    ['scoringModel', 'scoringModel', null],
    ['loopCreativeModel', 'loopCreativeModel', 'creativeModel'],
    ['loopScoringModel', 'loopScoringModel', 'scoringModel'],
  ]
  for (const [selectId, settingKey, fallbackKey] of slots) {
    const sel = document.getElementById(selectId)
    if (!sel) continue
    const saved = loadSetting(settingKey) ?? (fallbackKey ? loadSetting(fallbackKey) : null)
    const chosen = validIds.includes(saved) ? saved : defaultId
    while (sel.firstChild) sel.removeChild(sel.firstChild)
    for (const o of options) {
      const opt = document.createElement('option')
      opt.value = o.id
      opt.textContent = o.label
      if (o.id === chosen) opt.selected = true
      sel.appendChild(opt)
    }
    if (loadSetting(settingKey) !== chosen) saveSetting(settingKey, chosen)
  }
  updatePresetAvailability()
}

function onCreativeModelChange(val) { saveSetting('creativeModel', val); updatePresetAvailability() }
function onScoringModelChange(val) { saveSetting('scoringModel', val); updatePresetAvailability() }
function onBatchSizeInput(val) {
  const n = parseInt(val, 10)
  const clamped = isNaN(n) ? 60 : Math.min(200, Math.max(10, n))
  saveSetting('batchSize', clamped)
}

function loadBatchSize() {
  const v = loadSetting('batchSize')
  if (v != null) document.getElementById('batchSize').value = v
}

// --- Thinking presets ---
const THINKING_MODELS = ['claude-opus-4-7', 'claude-opus-4-6', 'claude-sonnet-4-6']
const PRESET_BADGE_CONFIG = {
  off:      { color: 'bg-green-500',  label: 'Off', title: 'No thinking. Cheapest.' },
  balanced: { color: 'bg-yellow-500', label: 'Bal', title: 'Adaptive thinking, medium effort. ~5-10x cost.' },
  max:      { color: 'bg-red-500',    label: 'Max', title: 'Adaptive thinking, max effort. ~10-20x cost.' },
}

function labelForModel(id) {
  for (const opts of Object.values(MODEL_OPTIONS)) {
    const found = opts.find(o => o.id === id)
    if (found) return found.label
  }
  return id || 'This model'
}

function updateCostBadge(slot) {
  const badge = document.getElementById(slot + 'CostBadge')
  if (!badge) return
  const preset = loadSetting(slot + 'Preset') || 'off'
  const c = PRESET_BADGE_CONFIG[preset] || PRESET_BADGE_CONFIG.off
  badge.innerHTML = ''
  const dot = document.createElement('span')
  dot.className = `inline-block w-2 h-2 rounded-full ${c.color} mr-1.5 align-middle`
  const text = document.createElement('span')
  text.textContent = c.label
  text.className = 'text-xs text-gray-600 align-middle'
  badge.title = c.title
  badge.appendChild(dot)
  badge.appendChild(text)
}

function updatePresetAvailability() {
  for (const slot of ['creative', 'scoring', 'loopCreative', 'loopScoring']) {
    const model = loadSetting(slot + 'Model')
    const presetSel = document.getElementById(slot + 'Preset')
    if (!presetSel) continue
    const supportsThinking = THINKING_MODELS.includes(model)
    Array.from(presetSel.options).forEach(opt => {
      if (opt.value !== 'off') opt.disabled = !supportsThinking
    })
    if (!supportsThinking && (loadSetting(slot + 'Preset') || 'off') !== 'off') {
      saveSetting(slot + 'Preset', 'off')
      presetSel.value = 'off'
      toast(labelForModel(model) + " doesn't support extended thinking — preset reset to Off.")
    }
    updateCostBadge(slot)
  }
}

function onCreativePresetChange(val) {
  saveSetting('creativePreset', val)
  updateCostBadge('creative')
}

function onScoringPresetChange(val) {
  saveSetting('scoringPreset', val)
  updateCostBadge('scoring')
}

function loadPresets() {
  for (const slot of ['creative', 'scoring', 'loopCreative', 'loopScoring']) {
    if (loadSetting(slot + 'Preset') == null) saveSetting(slot + 'Preset', 'off')
    const sel = document.getElementById(slot + 'Preset')
    if (sel) sel.value = loadSetting(slot + 'Preset') || 'off'
  }
}

function toast(msg) {
  const el = document.createElement('div')
  el.textContent = msg
  el.className = 'fixed bottom-6 left-1/2 -translate-x-1/2 z-50 px-4 py-2 bg-gray-900 text-white text-sm rounded-lg shadow-lg'
  document.body.appendChild(el)
  setTimeout(() => el.remove(), 3000)
}

// --- Saved library: ideas + prompts ---
function populateIdeaPicker() {
  const sel = document.getElementById('ideaPicker')
  if (!sel) return
  const current = sel.value
  const items = (lib && lib.ideas && typeof lib.ideas.list === 'function') ? lib.ideas.list() : []
  sel.innerHTML = '<option value="">— Choose saved idea —</option>'
  for (const it of items) {
    const opt = document.createElement('option')
    opt.value = it.id
    opt.textContent = it.name
    sel.appendChild(opt)
  }
  if (current && items.some(it => it.id === current)) sel.value = current
}

function onIdeaPicked() {
  const sel = document.getElementById('ideaPicker')
  const id = sel.value
  if (!id) return
  const item = lib.ideas.get(id)
  if (!item) return
  const ta = document.getElementById('description')
  ta.value = item.text || ''
  onDescriptionInput()
}

function onIdeaSave() {
  const text = document.getElementById('description').value
  const name = prompt('Name this idea:')
  if (!name) return
  const created = lib.ideas.create(name, text)
  populateIdeaPicker()
  if (created?.id) document.getElementById('ideaPicker').value = created.id
  populateLoopPickers()
}

function onIdeaUpdate() {
  const id = document.getElementById('ideaPicker').value
  if (!id) { toast('No saved idea selected'); return }
  lib.ideas.update(id, { text: document.getElementById('description').value })
  toast('Idea updated')
  populateLoopPickers()
}

function onIdeaDelete() {
  const sel = document.getElementById('ideaPicker')
  const id = sel.value
  if (!id) { toast('No saved idea selected'); return }
  const item = lib.ideas.get(id)
  if (!confirm('Delete saved idea "' + (item?.name || id) + '"?')) return
  lib.ideas.delete(id)
  populateIdeaPicker()
  sel.value = ''
  populateLoopPickers()
}

const PROMPT_KIND_CONFIG = {
  generation: { pickerId: 'generationPromptPicker', textareaId: 'promptBox' },
  scoring:    { pickerId: 'scoringPromptPicker',    textareaId: 'fitPromptBox' },
  synonym:    { pickerId: 'synonymPromptPicker',    textareaId: 'synonymsPromptBox' },
  association:{ pickerId: 'associationPromptPicker', textareaId: 'assocPromptBox' },
}

function populatePromptPicker(kind) {
  const cfg = PROMPT_KIND_CONFIG[kind]
  const sel = document.getElementById(cfg.pickerId)
  if (!sel) return
  const current = sel.value
  const items = (lib && lib.prompts && typeof lib.prompts.list === 'function') ? lib.prompts.list(kind) : []
  sel.innerHTML = '<option value="">— Choose saved prompt —</option>'
  for (const it of items) {
    const opt = document.createElement('option')
    opt.value = it.id
    opt.textContent = it.name + (it.isBuiltin ? ' (built-in)' : '')
    sel.appendChild(opt)
  }
  if (current && items.some(it => it.id === current)) sel.value = current
}

function _promptPickedHandler(kind) {
  const cfg = PROMPT_KIND_CONFIG[kind]
  const id = document.getElementById(cfg.pickerId).value
  if (!id) return
  const item = lib.prompts.get(kind, id)
  if (!item) return
  const ta = document.getElementById(cfg.textareaId)
  ta.value = item.text || ''
  ta.dispatchEvent(new Event('input'))
}

function _promptSaveHandler(kind) {
  const cfg = PROMPT_KIND_CONFIG[kind]
  const text = document.getElementById(cfg.textareaId).value
  const name = prompt('Name this ' + kind + ' prompt:')
  if (!name) return
  const created = lib.prompts.create(kind, { name, text })
  populatePromptPicker(kind)
  if (created?.id) document.getElementById(cfg.pickerId).value = created.id
  populateLoopPickers()
}

function _promptUpdateHandler(kind) {
  const cfg = PROMPT_KIND_CONFIG[kind]
  const id = document.getElementById(cfg.pickerId).value
  if (!id) { toast('No saved prompt selected'); return }
  lib.prompts.update(kind, id, { text: document.getElementById(cfg.textareaId).value })
  toast('Prompt updated')
}

function _promptDeleteHandler(kind) {
  const cfg = PROMPT_KIND_CONFIG[kind]
  const sel = document.getElementById(cfg.pickerId)
  const id = sel.value
  if (!id) { toast('No saved prompt selected'); return }
  const item = lib.prompts.get(kind, id)
  if (item?.isBuiltin) { toast('Built-in prompts cannot be deleted'); return }
  if (!confirm('Delete saved prompt "' + (item?.name || id) + '"?')) return
  lib.prompts.delete(kind, id)
  populatePromptPicker(kind)
  sel.value = ''
  populateLoopPickers()
}

function onGenerationPromptPicked() { _promptPickedHandler('generation') }
function onGenerationPromptSave()    { _promptSaveHandler('generation') }
function onGenerationPromptUpdate()  { _promptUpdateHandler('generation') }
function onGenerationPromptDelete()  { _promptDeleteHandler('generation') }

function onScoringPromptPicked() { _promptPickedHandler('scoring') }
function onScoringPromptSave()    { _promptSaveHandler('scoring') }
function onScoringPromptUpdate()  { _promptUpdateHandler('scoring') }
function onScoringPromptDelete()  { _promptDeleteHandler('scoring') }

function onSynonymPromptPicked() { _promptPickedHandler('synonym') }
function onSynonymPromptSave()    { _promptSaveHandler('synonym') }
function onSynonymPromptUpdate()  { _promptUpdateHandler('synonym') }
function onSynonymPromptDelete()  { _promptDeleteHandler('synonym') }

function onAssociationPromptPicked() { _promptPickedHandler('association') }
function onAssociationPromptSave()    { _promptSaveHandler('association') }
function onAssociationPromptUpdate()  { _promptUpdateHandler('association') }
function onAssociationPromptDelete()  { _promptDeleteHandler('association') }

// --- Loop Mode ---
function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

let _loopActive = false
let _loopStartTime = null
let _loopIteration = 0
let _loopFoundCount = 0
let _loopController = null
let _loopRunId = null
let _loopStatusTimer = null
let _loopBackoffMultiplier = 1
let _loopTotalCost = 0

// Per-million-token pricing (USD) for the Anthropic models we support.
// in = input, out = output, cc = cache_creation_input, cr = cache_read_input.
const PRICING = {
  'claude-opus-4-7':   { in: 5,  out: 25, cc: 6.25, cr: 0.50 },
  'claude-opus-4-6':   { in: 5,  out: 25, cc: 6.25, cr: 0.50 },
  'claude-sonnet-4-6': { in: 3,  out: 15, cc: 3.75, cr: 0.30 },
  'claude-haiku-4-5':  { in: 1,  out: 5,  cc: 1.25, cr: 0.10 },
}

function estimateCost(usage, model) {
  if (!usage) return 0
  const p = PRICING[model]
  if (!p) return 0
  return (
    (usage.input_tokens || 0) * p.in / 1_000_000 +
    (usage.output_tokens || 0) * p.out / 1_000_000 +
    (usage.cache_creation_input_tokens || 0) * p.cc / 1_000_000 +
    (usage.cache_read_input_tokens || 0) * p.cr / 1_000_000
  )
}

function populateLoopPickers() {
  const ideaSel = document.getElementById('loopActiveIdea')
  if (ideaSel) {
    const cur = loadSetting('loopActiveIdea') || ''
    const items = (lib && lib.ideas && typeof lib.ideas.list === 'function') ? lib.ideas.list() : []
    ideaSel.innerHTML = '<option value="">— Use current description —</option>'
    for (const it of items) {
      const opt = document.createElement('option')
      opt.value = it.id
      opt.textContent = it.name
      if (it.id === cur) opt.selected = true
      ideaSel.appendChild(opt)
    }
  }
  const promptSel = document.getElementById('loopActivePrompt')
  if (promptSel) {
    const cur = loadSetting('loopActivePrompt') || ''
    const items = (lib && lib.prompts && typeof lib.prompts.list === 'function') ? lib.prompts.list('generation') : []
    promptSel.innerHTML = '<option value="">— Use default —</option>'
    for (const it of items) {
      const opt = document.createElement('option')
      opt.value = it.id
      opt.textContent = it.name + (it.isBuiltin ? ' (built-in)' : '')
      if (it.id === cur) opt.selected = true
      promptSel.appendChild(opt)
    }
  }
}

function loadLoopSettings() {
  if (loadSetting('loopInterval') == null) saveSetting('loopInterval', 30)
  if (loadSetting('loopMaxSeenStems') == null) saveSetting('loopMaxSeenStems', 200)
  if (loadSetting('loopCreativePreset') == null) saveSetting('loopCreativePreset', 'off')
  if (loadSetting('loopScoringPreset') == null) saveSetting('loopScoringPreset', 'off')
  if (loadSetting('loopScoringEnabled') == null) saveSetting('loopScoringEnabled', false)
  if (loadSetting('loopCreativeModel') == null) {
    const fallback = loadSetting('creativeModel')
    if (fallback) saveSetting('loopCreativeModel', fallback)
  }
  if (loadSetting('loopScoringModel') == null) {
    const fallback = loadSetting('scoringModel')
    if (fallback) saveSetting('loopScoringModel', fallback)
  }

  const setVal = (id, key) => {
    const el = document.getElementById(id)
    const v = loadSetting(key)
    if (el && v != null) el.value = v
  }
  setVal('loopInterval', 'loopInterval')
  setVal('loopMaxIterations', 'loopMaxIterations')
  setVal('loopMaxHours', 'loopMaxHours')
  setVal('loopMaxSeenStems', 'loopMaxSeenStems')
  const scEn = document.getElementById('loopScoringEnabled')
  if (scEn) scEn.checked = !!loadSetting('loopScoringEnabled')
}

function onLoopIntervalInput(val) {
  const n = parseInt(val, 10)
  const clamped = isNaN(n) ? 30 : Math.min(600, Math.max(10, n))
  saveSetting('loopInterval', clamped)
}
function onLoopMaxIterationsInput(val) {
  if (val === '' || val == null) { saveSetting('loopMaxIterations', null); return }
  const n = parseInt(val, 10)
  saveSetting('loopMaxIterations', isNaN(n) ? null : Math.max(1, n))
}
function onLoopMaxHoursInput(val) {
  if (val === '' || val == null) { saveSetting('loopMaxHours', null); return }
  const n = parseFloat(val)
  saveSetting('loopMaxHours', isNaN(n) ? null : Math.max(0.1, n))
}
function onLoopMaxSeenStemsInput(val) {
  const n = parseInt(val, 10)
  const clamped = isNaN(n) ? 200 : Math.min(2000, Math.max(50, n))
  saveSetting('loopMaxSeenStems', clamped)
}
function onLoopCreativeModelChange(val) { saveSetting('loopCreativeModel', val); updatePresetAvailability() }
function onLoopScoringModelChange(val) { saveSetting('loopScoringModel', val); updatePresetAvailability() }
function onLoopCreativePresetChange(val) { saveSetting('loopCreativePreset', val); updateCostBadge('loopCreative') }
function onLoopScoringPresetChange(val) { saveSetting('loopScoringPreset', val); updateCostBadge('loopScoring') }
function onLoopScoringEnabledChange(checked) { saveSetting('loopScoringEnabled', !!checked) }
function onLoopActiveIdeaChange(val) { saveSetting('loopActiveIdea', val || null) }
function onLoopActivePromptChange(val) { saveSetting('loopActivePrompt', val || null) }

function onLoopToggle() {
  if (_loopActive) { stopLoop(); return }
  const apiKey = loadSetting('aiApiKey')
  if (!apiKey) { alert('Set an API key first'); return }
  const creativePreset = loadSetting('loopCreativePreset') || 'off'
  const scoringPreset = loadSetting('loopScoringPreset') || 'off'
  const scoringEnabled = loadSetting('loopScoringEnabled') || false
  if (creativePreset === 'max' || (scoringEnabled && scoringPreset === 'max')) {
    if (!confirm('Loop mode with Max preset can cost $100+ overnight. Continue?')) return
  }
  startLoop()
}

function startLoop() {
  _loopActive = true
  _loopStartTime = Date.now()
  _loopIteration = 0
  _loopFoundCount = 0
  _loopBackoffMultiplier = 1
  _loopTotalCost = 0
  _loopRunId = 'loop_' + Date.now()
  _loopController = new AbortController()
  const btn = document.getElementById('loopStartStop')
  if (btn) {
    btn.textContent = 'Stop Loop'
    btn.classList.remove('bg-indigo-600', 'hover:bg-indigo-700')
    btn.classList.add('bg-red-600', 'hover:bg-red-700')
  }
  const status = document.getElementById('loopStatus')
  if (status) status.classList.remove('hidden')
  _loopStatusTimer = setInterval(updateLoopStatus, 1000)
  updateLoopStatus()
  refreshLoopEventLog()
  loopTick()
}

function stopLoop() {
  _loopActive = false
  if (_loopController) { try { _loopController.abort() } catch {} }
  if (_loopStatusTimer) { clearInterval(_loopStatusTimer); _loopStatusTimer = null }
  const btn = document.getElementById('loopStartStop')
  if (btn) {
    btn.textContent = 'Start Loop'
    btn.classList.remove('bg-red-600', 'hover:bg-red-700')
    btn.classList.add('bg-indigo-600', 'hover:bg-indigo-700')
  }
  toast('Loop stopped after ' + _loopIteration + ' iterations, found ' + _loopFoundCount + ' domains')
}

async function loopTick() {
  while (_loopActive) {
    const maxIter = loadSetting('loopMaxIterations')
    const maxHours = loadSetting('loopMaxHours')
    if (maxIter && _loopIteration >= maxIter) { stopLoop(); return }
    if (maxHours && (Date.now() - _loopStartTime) / 3600000 >= maxHours) { stopLoop(); return }

    const start = Date.now()
    try {
      await runOneLoopIteration()
      // Successful iteration clears any prior backoff.
      _loopBackoffMultiplier = 1
    } catch (e) {
      logLoopIteration({ timestamp: new Date().toISOString(), iteration: _loopIteration, error: String(e) })
      console.error('Loop iteration failed', e)
      if (e instanceof AIAPIError && e.status === 400) {
        toast('Loop stopped: API returned 400 (likely prompt too long). Reduce max-seen-stems.')
        stopLoop()
        return
      }
      if (e instanceof AIAPIError && (e.status === 429 || e.status >= 500)) {
        _loopBackoffMultiplier = Math.min((_loopBackoffMultiplier || 1) * 2, 8)
      } else {
        _loopBackoffMultiplier = 1
      }
    }
    _loopIteration++
    const elapsed = (Date.now() - start) / 1000
    const interval = Math.max(10, loadSetting('loopInterval') || 30)
    const wait = Math.max(0, interval * (_loopBackoffMultiplier || 1) - elapsed)
    if (_loopActive && wait > 0) await sleep(wait * 1000)
  }
}

async function runOneLoopIteration() {
  const apiKey = loadSetting('aiApiKey')
  const model = loadSetting('loopCreativeModel') || loadSetting('creativeModel')
  const preset = loadSetting('loopCreativePreset') || 'off'
  const batchSize = loadSetting('batchSize') || 60
  const maxSeen = loadSetting('loopMaxSeenStems') || 200
  const ideaId = loadSetting('loopActiveIdea')
  const promptId = loadSetting('loopActivePrompt')

  const idea = ideaId ? lib.ideas.get(ideaId)?.text : loadSetting('description')
  if (!idea) throw new Error('No active idea')

  const customPrompt = promptId ? lib.prompts.get('generation', promptId)?.text : null
  const seen = db.getSeenStems()
  const seenSlice = seen.slice(-maxSeen).join(', ')

  let finalPrompt = null
  if (customPrompt) {
    finalPrompt = customPrompt.includes('{{seen}}')
      ? customPrompt.replaceAll('{{seen}}', seenSlice)
      : (seenSlice ? customPrompt + '\n\nDo NOT repeat any of these previously-generated stems: ' + seenSlice : customPrompt)
  }
  const ideaWithSeen = (!customPrompt && seenSlice)
    ? idea + '\n\nDo NOT repeat any of these previously-generated stems: ' + seenSlice
    : idea

  let iterationCost = 0

  const names = await generateDomainNames(ideaWithSeen, finalPrompt || undefined, apiKey, model, batchSize, preset)
  iterationCost += estimateCost(getLastUsage(), model)
  const seenSet = new Set(seen)
  const fresh = names.filter(n => !seenSet.has(n))
  db.addSeenStems(names)

  const zones = getSelectedZones()
  const tasks = fresh.flatMap(name => zones.map(z => name + '.' + z))
  const available = []
  const CONCURRENCY = 6
  let nextIdx = 0
  const worker = async () => {
    while (_loopActive) {
      const i = nextIdx++
      if (i >= tasks.length) return
      const domain = tasks[i]
      let isAvail
      try {
        isAvail = await checkDomainAvailable(domain, _loopController.signal)
      } catch (e) {
        if (_loopController?.signal.aborted) return
        throw e
      }
      db.upsert(
        domain,
        { domain, available: isAvail, description: idea, loopRunId: _loopRunId },
        { available: isAvail, description: idea, loopRunId: _loopRunId }
      )
      if (isAvail === true) available.push(domain)
    }
  }
  if (tasks.length) {
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, tasks.length) }, worker))
  }

  _loopFoundCount += available.length

  if (loadSetting('loopScoringEnabled') && available.length) {
    const scoringModel = loadSetting('loopScoringModel') || loadSetting('scoringModel')
    const scoringPreset = loadSetting('loopScoringPreset') || 'off'
    try {
      const scores = await scoreFitBatch(available, idea, apiKey, null, scoringModel, scoringPreset)
      iterationCost += estimateCost(getLastUsage(), scoringModel)
      for (const [domain, s] of Object.entries(scores || {})) {
        const rec = db.findUnique(domain)
        if (rec) db.update(rec.id, { fitScore: s.fit, proScore: s.pro, memScore: s.mem, brdScore: s.brd })
      }
    } catch (e) {
      console.error('Loop scoring failed', e)
    }
  }

  _loopTotalCost += iterationCost

  logLoopIteration({
    timestamp: new Date().toISOString(),
    iteration: _loopIteration,
    runId: _loopRunId,
    generated: names.length,
    fresh: fresh.length,
    checked: tasks.length,
    available: available.length,
    model,
    preset,
    cost: iterationCost,
  })

  try { loadSaved() } catch {}
  setTimeout(refreshLoopEventLog, 500)
}

function updateLoopStatus() {
  if (!_loopActive) return
  const el = document.getElementById('loopStatus')
  if (!el) return
  const seenCount = db.getSeenStems().length
  const maxIter = loadSetting('loopMaxIterations')
  const elapsed = Math.floor((Date.now() - _loopStartTime) / 1000)
  const hrs = Math.floor(elapsed / 3600)
  const mins = Math.floor((elapsed % 3600) / 60)
  const secs = elapsed % 60
  const elapsedStr = hrs > 0 ? hrs + 'h ' + mins + 'm' : mins + 'm ' + secs + 's'
  el.textContent = 'Running — iteration ' + _loopIteration + '/' + (maxIter || '∞') +
    ', found ' + _loopFoundCount + ' / ' + seenCount + ' seen, started ' + elapsedStr + ' ago' +
    ', ~$' + _loopTotalCost.toFixed(2) + ' so far'
}

async function refreshLoopEventLog() {
  if (!_loopStartTime) return
  const sinceIso = new Date(_loopStartTime).toISOString()
  try {
    const lines = await fetchLoopLog(sinceIso)
    const el = document.getElementById('loopEventLog')
    if (!el) return
    const last20 = lines.slice(-20)
    el.innerHTML = ''
    for (const l of last20) {
      const div = document.createElement('div')
      const t = (l.timestamp || '').slice(11, 19)
      const errPart = l.error ? ' ERROR: ' + l.error : ''
      div.textContent = '[' + t + '] iter#' + l.iteration + ': gen=' + (l.generated || 0) +
        ' fresh=' + (l.fresh || 0) + ' avail=' + (l.available || 0) + errPart
      el.appendChild(div)
    }
  } catch {}
}

function onExportAvailable() {
  const records = db.findMany().filter(r => r.available === true)
  const blob = new Blob([JSON.stringify(records, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = 'available-' + new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19) + '.json'
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

// --- Init ---
async function init() {
  await hydrate()
  loadWeights()
  loadSearchZones()
  loadCompareZones()
  loadCheckZones()
  loadGenPrompt()
  loadAssocPrompt()
  loadFitPrompt()
  loadSynonymPrompt()
  loadAiKey()
  loadFitContext()
  loadDescription()
  loadBatchSize()
  loadPresets()
  populateModelDropdowns()
  populateIdeaPicker()
  populatePromptPicker('generation')
  populatePromptPicker('scoring')
  populatePromptPicker('synonym')
  populatePromptPicker('association')
  loadLoopSettings()
  populateLoopPickers()
  loadSaved()
  checkActiveSearch()

  // Restore collapsed states
  ;['search', 'score', 'saved', 'history', 'loop'].forEach(restoreSectionCollapse)
}
init()

// Expose all functions called from inline onclick attributes
Object.assign(window, {
  toggleFav,
  toggleSuper,
  toggleCheckFav,
  startSearch,
  stopSearch,
  checkOne,
  deleteDomain,
  clearHistory,
  copyFavDomains,
  clearFavoritesOnly,
  promptSaveFavs,
  restoreSet,
  deleteSet,
  toggleSectionCollapse,
  toggleSetsCollapse,
  toggleSearchCollapse,
  exportData,
  rescoreFit,
  refreshZones,
  refreshAssociations,
  toggleSearchZone,
  toggleCheckZone,
  addCustomCheckZone,
  toggleCompareZone,
  removeZone,
  addCustomZone,
  addCustomCompareZone,
  saveGenPrompt,
  resetPrompt,
  saveAssocPrompt,
  resetAssocPrompt,
  saveFitPrompt,
  resetFitPrompt,
  toggleSynonyms,
  saveSynonymPrompt,
  resetSynonymPrompt,
  toggleKeyInput,
  saveAiKey,
  clearAiKey,
  onAiKeyInput,
  onFitContextInput,
  onDescriptionInput,
  onCreativeModelChange,
  onScoringModelChange,
  onCreativePresetChange,
  onScoringPresetChange,
  onBatchSizeInput,
  saveWeights,
  renderScores,
  dismissResume,
  resumeSearch,
  toggleMenu,
  onIdeaPicked,
  onIdeaSave,
  onIdeaUpdate,
  onIdeaDelete,
  onGenerationPromptPicked,
  onGenerationPromptSave,
  onGenerationPromptUpdate,
  onGenerationPromptDelete,
  onScoringPromptPicked,
  onScoringPromptSave,
  onScoringPromptUpdate,
  onScoringPromptDelete,
  onSynonymPromptPicked,
  onSynonymPromptSave,
  onSynonymPromptUpdate,
  onSynonymPromptDelete,
  onAssociationPromptPicked,
  onAssociationPromptSave,
  onAssociationPromptUpdate,
  onAssociationPromptDelete,
  onLoopToggle,
  onExportAvailable,
  onLoopIntervalInput,
  onLoopMaxIterationsInput,
  onLoopMaxHoursInput,
  onLoopMaxSeenStemsInput,
  onLoopCreativeModelChange,
  onLoopScoringModelChange,
  onLoopCreativePresetChange,
  onLoopScoringPresetChange,
  onLoopScoringEnabledChange,
  onLoopActiveIdeaChange,
  onLoopActivePromptChange,
})
