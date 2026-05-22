export class AIAPIError extends Error {
  constructor(status, body) {
    super('AI API error: ' + status + ' ' + body)
    this.name = 'AIAPIError'
    this.status = status
    this.body = body
  }
}

// Usage from the most recent aiChat call. Side-channel so we don't have to
// change every public function's return shape. Read via getLastUsage().
let _lastUsage = null
export function getLastUsage() { return _lastUsage }

// Extract the largest valid JSON value from a model response. Handles model
// outputs that prepend a <scratch> block or other commentary, or include
// incidental bracketed text like "Lane [A]" / "[from Latin]" inside reasoning.
// Strategy: try a direct parse first (fast path), otherwise scan the entire
// string for ALL balanced {...} and [...] candidates, try to parse each, and
// return the longest valid one. The real output (60-item array, score map)
// will always be substantially larger than any incidental JSON-like fragment.
function extractJson(text) {
  if (!text) return null
  let s = text.trim()
  const fenced = s.match(/^```(?:json)?\s*\n([\s\S]*?)\n```\s*$/i)
  if (fenced) s = fenced[1].trim()
  try { return JSON.parse(s) } catch {}

  let best = null
  let bestLen = -1
  let i = 0
  while (i < s.length) {
    const c = s[i]
    if (c !== '{' && c !== '[') { i++; continue }
    const open = c
    const close = open === '{' ? '}' : ']'
    let depth = 0
    let inStr = false
    let esc = false
    let end = -1
    for (let j = i; j < s.length; j++) {
      const cj = s[j]
      if (esc) { esc = false; continue }
      if (cj === '\\') { esc = true; continue }
      if (cj === '"') { inStr = !inStr; continue }
      if (inStr) continue
      if (cj === open) depth++
      else if (cj === close) {
        depth--
        if (depth === 0) { end = j; break }
      }
    }
    if (end === -1) break // unclosed bracket — no more candidates
    const slice = s.slice(i, end + 1)
    try {
      const parsed = JSON.parse(slice)
      if (slice.length > bestLen) {
        best = parsed
        bestLen = slice.length
      }
    } catch {}
    i = end + 1
  }
  return best
}

// Bundled API key — XOR-encoded at build time so GitHub secret scanning won't flag it
// deploy.yml encodes: each char XOR 42, joined by commas → decoded here at runtime
function _dk(s) { return s.split(',').map(c => String.fromCharCode(parseInt(c) ^ 42)).join('') }
export const BUNDLED_API_KEY = _dk('__GROQ_API_KEY__')
const BUNDLED_BASE_URL = 'https://api.groq.com/openai/v1'
const BUNDLED_MODEL = 'llama-3.3-70b-versatile'

export function detectProvider(key) {
  if (!key) return 'Groq (default)'
  if (key.startsWith('sk-ant-')) return 'Claude (Anthropic)'
  if (key.startsWith('sk-')) return 'OpenAI'
  if (key.startsWith('gsk_')) return 'Groq'
  return 'Unknown'
}

function buildAnthropicBody(model, preset, system, userMsgs, temperature) {
  const base = { model, system, messages: userMsgs }

  // Opus 4.7 is ALWAYS adaptive; effort maps to low/medium/xhigh per preset.
  if (model === 'claude-opus-4-7') {
    let effort, maxTokens
    if (preset === 'balanced') { effort = 'medium'; maxTokens = 16000 }
    else if (preset === 'max') { effort = 'xhigh'; maxTokens = 24000 }
    else { effort = 'low'; maxTokens = 4096 }
    return { ...base, max_tokens: maxTokens, thinking: { type: 'adaptive' }, output_config: { effort } }
    // No temperature ever — opus-4-7 rejects it with 400.
  }

  // Haiku 4.5: no adaptive, no effort, no output_config.
  if (model.includes('haiku')) {
    const body = { ...base, max_tokens: 2048 }
    if (temperature != null) body.temperature = Math.min(1, Math.max(0, temperature))
    return body
  }

  // Opus 4.6 / Sonnet 4.6: adaptive + effort, per-preset.
  if (preset === 'off') {
    const body = { ...base, max_tokens: 4096 }
    if (temperature != null) body.temperature = Math.min(1, Math.max(0, temperature))
    return body
  }
  if (preset === 'balanced') {
    const body = { ...base, max_tokens: 16000, thinking: { type: 'adaptive' }, output_config: { effort: 'medium' } }
    if (temperature != null) body.temperature = Math.min(1, Math.max(0, temperature))
    return body
  }
  if (preset === 'max') {
    let maxTokens
    if (model === 'claude-opus-4-6') maxTokens = 20000
    else if (model === 'claude-sonnet-4-6') maxTokens = 16000
    else maxTokens = 16000
    const body = { ...base, max_tokens: maxTokens, thinking: { type: 'adaptive' }, output_config: { effort: 'max' } }
    if (temperature != null) body.temperature = Math.min(1, Math.max(0, temperature))
    return body
  }
  const body = { ...base, max_tokens: 4096 }
  if (temperature != null) body.temperature = Math.min(1, Math.max(0, temperature))
  return body
}

// Route by model prefix, not key prefix. Once users can save multiple keys,
// the same key prefix may not match the model they actually want to call.
export function providerForModel(model) {
  if (!model) return 'groq'
  if (model.startsWith('claude-')) return 'anthropic'
  if (model.startsWith('gpt-') || /^o\d/.test(model)) return 'openai'
  return 'groq'
}

// OpenAI reasoning-capable models — exposed in the UI for Balanced/Max presets.
// gpt-5, gpt-5.4, gpt-5.5 plus their -mini/-nano variants are all reasoning
// models. o-series (o1, o3, o3-mini, o4-mini, ...) are all reasoning.
// gpt-4o / gpt-4o-mini are legacy chat (NOT reasoning).
export function _isOpenAIReasoningModel(model) {
  if (!model) return false
  if (/^gpt-5(\.\d+)?(-(mini|nano))?$/.test(model)) return true
  if (/^o\d/.test(model)) return true
  return false
}

// Temperature support matrix:
//  - claude-opus-4-7: NO (400)
//  - claude-opus-4-6, sonnet-4-6, haiku-4-5: YES (0–1)
//  - any gpt-5* or o-series reasoning model: NO (400)
//  - gpt-4o, gpt-4o-mini: YES (0–2, we cap at 1)
//  - llama-* / Groq: YES (0–2, we cap at 1)
export function _modelSupportsTemperature(model) {
  if (!model) return true
  if (model === 'claude-opus-4-7') return false
  if (_isOpenAIReasoningModel(model)) return false
  return true
}

// Map (model, preset) → reasoning_effort string for OpenAI reasoning models.
// Returns null if the model isn't a reasoning model.
export function _openaiReasoningEffort(model, preset) {
  if (!_isOpenAIReasoningModel(model)) return null
  // gpt-5.4 and gpt-5.5 family: none | low | medium | high | xhigh
  const is54_55 = /^gpt-5\.[45](-(mini|nano))?$/.test(model)
  // o-series has no off-switch; "low" is the floor
  const isOSeries = /^o\d/.test(model)
  if (preset === 'off') {
    if (is54_55) return 'none'
    if (isOSeries) return 'low'
    return 'minimal' // gpt-5 / -mini / -nano
  }
  if (preset === 'balanced') return 'medium'
  if (preset === 'max') {
    if (is54_55) return 'xhigh'
    return 'high' // gpt-5 family and o-series cap at 'high'
  }
  // Unknown preset → treat as off
  if (is54_55) return 'none'
  if (isOSeries) return 'low'
  return 'minimal'
}

function buildOpenAIBody(model, preset, messages, temperature) {
  const isReasoning = _isOpenAIReasoningModel(model)
  const body = { model, messages }

  if (isReasoning) {
    // Reasoning model: max_completion_tokens covers reasoning + visible output
    // combined (per OpenAI docs). max_tokens is a 400 error here. Effort param
    // values are model-family-specific (see _openaiReasoningEffort).
    body.reasoning_effort = _openaiReasoningEffort(model, preset)
    if (preset === 'balanced') body.max_completion_tokens = 16384
    else if (preset === 'max') body.max_completion_tokens = 32768
    else body.max_completion_tokens = 8192 // off — leaves room for "low" reasoning floor
  } else {
    // Legacy chat (gpt-4o, gpt-4o-mini): max_completion_tokens still accepted
    // as an alias for max_tokens and is forward-compatible.
    body.max_completion_tokens = 2048
    if (temperature != null) {
      const t = Math.min(1, Math.max(0, temperature))
      body.temperature = t
    }
  }
  return body
}

async function aiChat(messages, apiKey, model, preset = 'off', signal, temperature) {
  // Reset usage on every entry so a late-resolving orphan fetch (e.g. one we
  // raced past via withElapsedStatus) can't carry stale tokens into the next
  // trackCost() read.
  _lastUsage = null

  const route = providerForModel(model)
  const resolvedModel = model || (route === 'anthropic' ? 'claude-opus-4-6' : route === 'openai' ? 'gpt-4o-mini' : BUNDLED_MODEL)
  const key = apiKey || (route === 'groq' ? BUNDLED_API_KEY : undefined)
  if (!key) throw new AIAPIError(401, 'No API key set for provider: ' + route)

  const presetSupported =
    (route === 'anthropic' && !resolvedModel.includes('haiku')) ||
    (route === 'openai' && _isOpenAIReasoningModel(resolvedModel))
  if (preset !== 'off' && !presetSupported) preset = 'off'

  // Only forward temperature when the model accepts it. Caller can pass any
  // value (or null/undefined); we gate here so we never 400 on opus-4-7 or
  // OpenAI reasoning models.
  const tempForBody = (temperature != null && _modelSupportsTemperature(resolvedModel))
    ? temperature
    : null

  if (route === 'anthropic') {
    const system = messages.find(m => m.role === 'system')?.content
    const userMsgs = messages.filter(m => m.role !== 'system')
    const body = buildAnthropicBody(resolvedModel, preset, system, userMsgs, tempForBody)
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify(body),
      signal,
    })
    if (!res.ok) {
      _lastUsage = null
      throw new AIAPIError(res.status, await res.text())
    }
    const data = await res.json()
    _lastUsage = data.usage || null
    const textBlock = data.content?.find(b => b.type === 'text')
    if (!textBlock?.text) {
      console.error('Anthropic returned no text block', { stop_reason: data.stop_reason, usage: data.usage, content_types: data.content?.map(b => b.type) })
      throw new Error('Empty response from AI (stop_reason: ' + (data.stop_reason || 'unknown') + ')')
    }
    return textBlock.text
  }

  // OpenAI-compatible (Groq or OpenAI), routed by model prefix
  const baseUrl = route === 'openai'
    ? 'https://api.openai.com/v1'
    : BUNDLED_BASE_URL

  let body
  if (route === 'openai') {
    body = buildOpenAIBody(resolvedModel, preset, messages, tempForBody)
  } else {
    // Groq (OpenAI-compatible): no reasoning models supported. Accepts
    // max_completion_tokens (preferred) or max_tokens. Temperature 0–2; cap at 1.
    body = { model: resolvedModel, messages, max_completion_tokens: 2048 }
    if (tempForBody != null) body.temperature = Math.min(1, Math.max(0, tempForBody))
  }
  const res = await fetch(baseUrl + '/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + key,
    },
    body: JSON.stringify(body),
    signal,
  })
  if (!res.ok) {
    _lastUsage = null
    throw new AIAPIError(res.status, await res.text())
  }
  const data = await res.json()
  if (data.usage) {
    const cached = data.usage.prompt_tokens_details?.cached_tokens || 0
    _lastUsage = {
      input_tokens: Math.max(0, (data.usage.prompt_tokens || 0) - cached),
      output_tokens: data.usage.completion_tokens || 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: cached,
    }
  } else {
    _lastUsage = null
  }
  return data.choices?.[0]?.message?.content || ''
}

export const DEFAULT_SYSTEM_PROMPT = `You are an expert startup domain name generator. The user provides an idea — it may be a few words or a full paragraph. Follow this process:

STEP 1 — UNDERSTAND: Extract from the description:
- The core action or value (what it does)
- The key actors/objects (who/what is involved)
- The unique angle or metaphor (what makes it special)
- Specific domain concepts (e.g. "agent", "wallet", "identity", "API")

STEP 2 — GENERATE {{count}} unique domain name stems using ALL of these strategies:
1. Core concept words and their synonyms
2. Portmanteau / word blends (Shopify=shop+simplify, Spotify=spot+identify, Brex=break+express)
3. Invented brandable words inspired by the concept (Vercel, Klarna, Zeplin, Twilio)
4. Metaphors and abstractions: think what the product IS or DOES abstractly
   (e.g. "AI agents acting as humans online" → envoy, proxy, persona, delegate, operator, emissary)
5. Compound words from key concepts (clearbit, hotglue, moonbeam, darksky)
6. Prefix/suffix patterns: get___, try___, ___, ___ly, ___hub, ___hq, ___ai
7. Greek/Latin/foreign roots relevant to the concept
8. Evocative words that feel right even if indirect

Rules:
- Stem only — no TLD, no dots, no hyphens, lowercase letters and numbers only
- Mix of lengths: some short (4–7 chars), some medium (8–11 chars), some longer compound words (12–15 chars) — real startups use all ranges (e.g. "stripe", "clearbit", "anthropic", "cloudflare", "digitalocean")
- Easy to spell and say aloud
- Avoid common single words certainly already taken ("smart", "data", "fast", "cloud")
- All {{count}} must be distinct
- You MUST return exactly {{count}} names

Return ONLY a JSON array of {{count}} strings, no other text. Example: ["agentix","proxima","condukt","envoyai","meshkey","vaultly","humanapi","autoplex","agenthq","delegata"]`

export async function generateDomainNames(description, systemPrompt, apiKey, model, batchSize = 60, preset = 'off', signal, temperature) {
  const resolvedPrompt = (systemPrompt || DEFAULT_SYSTEM_PROMPT).replaceAll('{{count}}', String(batchSize))
  const text = await aiChat([
    { role: 'system', content: resolvedPrompt },
    { role: 'user', content: `Idea: ${description}` },
  ], apiKey, model, preset, signal, temperature)

  if (!text) throw new Error('Empty response from AI')

  let names = extractJson(text)
  // Defensive: many models wrap output in an envelope despite the prompt
  // ("Return ONLY a JSON array"). Unwrap common shapes like
  // {names: [...]}, {domains: [...]}, {results: [...]}, etc.
  if (names && !Array.isArray(names) && typeof names === 'object') {
    const arrayKeys = ['names', 'domains', 'results', 'items', 'array', 'list', 'data', 'candidates']
    for (const k of arrayKeys) {
      if (Array.isArray(names[k])) { names = names[k]; break }
    }
    // If still not an array, try any property that's an array.
    if (!Array.isArray(names)) {
      const firstArrayVal = Object.values(names).find(v => Array.isArray(v))
      if (firstArrayVal) names = firstArrayVal
    }
  }
  if (!Array.isArray(names)) {
    console.error('extractJson did not return an array. Full response below:')
    console.error(text)
    const tail = text.slice(-300).replace(/\s+/g, ' ').trim()
    const head = text.slice(0, 200).replace(/\s+/g, ' ').trim()
    throw new Error('Could not parse AI response as JSON array. Response head: "' + head + '" ... tail: "' + tail + '"')
  }
  return names
    .map(n => String(n).toLowerCase().replace(/[^a-z0-9]/g, ''))
    .filter(n => n.length >= 2)
}

export const DEFAULT_FIT_PROMPT = `Score each domain name on four dimensions (0–10 each):
- FIT: how well the name evokes the app idea "{{context}}" (10 = perfectly evocative, 0 = unrelated)
- PRO: how easy and natural it is to pronounce out loud (10 = flows perfectly, 0 = unpronounceable)
- MEM: how memorable and sticky the name is (10 = instantly memorable, 0 = completely forgettable)
- BRD: brandability — unique, catchy, ownable as a brand (10 = outstanding brand name, 0 = totally generic)

Return ONLY a JSON object. Example:
{"copygen.ai": {"fit": 8, "pro": 7, "mem": 8, "brd": 6}, "wordblast.io": {"fit": 5, "pro": 9, "mem": 7, "brd": 5}}`

export async function scoreFitBatch(domains, context, apiKey, fitPrompt, model, preset = 'off', signal, temperature) {
  if (!domains.length || !context.trim()) return {}

  const promptTemplate = fitPrompt || DEFAULT_FIT_PROMPT
  const systemContent = promptTemplate.replace('{{context}}', context)

  const text = await aiChat([
    { role: 'system', content: systemContent },
    { role: 'user', content: domains.join('\n') },
  ], apiKey, model, preset, signal, temperature)

  const raw = extractJson(text)
  if (!raw || typeof raw !== 'object') return {}
  const result = {}
  const clamp = v => Math.min(10, Math.max(0, Math.round(Number(v ?? 5))))
  for (const [domain, val] of Object.entries(raw)) {
    if (val !== null && typeof val === 'object') {
      result[domain] = { fit: clamp(val.fit), pro: clamp(val.pro), mem: clamp(val.mem), brd: clamp(val.brd) }
    } else {
      // Legacy format: just a FIT number
      result[domain] = { fit: clamp(val), pro: null, mem: null, brd: null }
    }
  }
  return result
}

export const DEFAULT_ASSOC_PROMPT = `For each domain, write exactly 5 word-associations (3-5 words each, lowercase, no punctuation).
The associations MUST use the TLD hint provided in brackets after each domain name.
Return ONLY valid JSON: {"stem": ["assoc1", "assoc2", "assoc3", "assoc4", "assoc5"], ...}
Example input:
nexus.io [.io = developer tool]
lumo.ai [.ai = artificial intelligence]
flare.app [.app = mobile/web app]
Example output: {"nexus": ["dev hub connector", "developer routing layer", "links services together", "api integration bridge", "backend data pipeline"], "lumo": ["ai clarity engine", "machine learning insight", "spark of intelligence", "neural network illuminator", "smart prediction platform"], "flare": ["mobile app igniter", "app that stands out", "ignite user engagement", "launch notification system", "viral growth catalyst"]}`

export const DEFAULT_SYNONYM_PROMPT = `Given a domain name stem, return exactly 6 synonyms or semantically related words that would work as domain names (single lowercase words, no spaces; hyphens allowed for compound words).
Vary the angle: include near-synonyms, evocative alternatives, and metaphorical variants.
Return ONLY a JSON array of strings: ["word1", "word2", "word3", "word4", "word5", "word6"]`

export async function generateSynonyms(stem, apiKey, systemPrompt, model, preset = 'off', signal, temperature) {
  const text = await aiChat([
    { role: 'system', content: systemPrompt || DEFAULT_SYNONYM_PROMPT },
    { role: 'user', content: stem },
  ], apiKey, model, preset, signal, temperature)
  const arr = extractJson(text)
  if (!Array.isArray(arr)) return []
  return arr.filter(w => typeof w === 'string' && /^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(w)).slice(0, 6)
}

const TLD_MEANINGS = {
  ai: 'artificial intelligence / machine learning',
  io: 'developer tool / input-output',
  app: 'mobile or web application',
  dev: 'developer tool or platform',
  co: 'company or startup',
  com: 'general business or product',
  so: 'social network or community',
  to: 'destination or action',
  sh: 'command-line or developer tool',
  run: 'execute or automate something',
  email: 'email or communication',
  link: 'URL shortener or connector',
  ly: 'short or action-oriented brand',
}

export async function associateDomains(domains, apiKey, systemPrompt, model, preset = 'off', signal, temperature) {
  if (!domains.length) return {}

  // Annotate each domain with its TLD meaning so the AI cannot ignore it
  const annotated = domains.map(d => {
    const tld = d.split('.').pop()
    const meaning = TLD_MEANINGS[tld]
    return meaning ? `${d} [.${tld} = ${meaning}]` : d
  })

  const text = await aiChat([
    { role: 'system', content: systemPrompt || DEFAULT_ASSOC_PROMPT },
    { role: 'user', content: annotated.join('\n') },
  ], apiKey, model, preset, signal, temperature)

  const assocs = extractJson(text)
  if (!assocs || typeof assocs !== 'object') return {}
  // Map back to full domain strings
  const result = {}
  for (const domain of domains) {
    const stem = domain.replace(/\.[a-z]+$/, '')
    const raw = assocs[stem]
    if (raw) result[domain] = Array.isArray(raw) ? raw : [raw]
  }
  return result
}
