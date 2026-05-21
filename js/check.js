/**
 * Domain availability: per-TLD RDAP routing + DNS-over-HTTPS double-check
 *
 * Logic:
 *   RDAP 200 → taken (always reliable)
 *   RDAP 404 → not conclusive — confirm via DoH A-record lookup:
 *     DoH NXDOMAIN (Status=3) → available
 *     DoH has A/CNAME/NS in Answer OR NS/SOA in Authority → taken
 *     DoH inconclusive → null (unknown)
 *   RDAP error/timeout → DoH only
 *
 * Routing: each TLD is sent to its authoritative RDAP server (loaded from
 * IANA's bootstrap registry) to avoid the rdap.org aggregator's rate limits.
 * Falls back to rdap.org if no authoritative server is known.
 */

// Static fallback covers the top TLDs so early checks don't block on bootstrap.
const STATIC_RDAP_MAP = {
  com: 'https://rdap.verisign.com/com/v1/',
  net: 'https://rdap.verisign.com/com/v1/',
  org: 'https://rdap.publicinterestregistry.org/rdap/',
  io: 'https://rdap.identitydigital.services/rdap/',
  ai: 'https://rdap.identitydigital.services/rdap/',
  sh: 'https://rdap.identitydigital.services/rdap/',
  co: 'https://rdap.nic.co/',
  app: 'https://www.registry.google/rdap/',
  dev: 'https://www.registry.google/rdap/',
  xyz: 'https://rdap.centralnic.com/xyz/',
}

let rdapMap = { ...STATIC_RDAP_MAP }

const bootstrapPromise = (async () => {
  try {
    const res = await fetch('https://data.iana.org/rdap/dns.json', {
      signal: AbortSignal.timeout(4000),
    })
    if (!res.ok) return
    const data = await res.json()
    const next = { ...STATIC_RDAP_MAP }
    for (const entry of data.services || []) {
      const [tlds, urls] = entry
      if (!Array.isArray(tlds) || !Array.isArray(urls) || urls.length === 0) continue
      let base = urls.find(u => u.startsWith('https://')) || urls[0]
      if (!base) continue
      if (!base.endsWith('/')) base += '/'
      for (const tld of tlds) {
        if (!next[tld]) next[tld] = base
      }
    }
    rdapMap = next
  } catch {
    // bootstrap failed; keep static map
  }
})()

let bootstrapAwaited = false
async function ensureBootstrap() {
  if (bootstrapAwaited) return
  bootstrapAwaited = true
  try {
    await Promise.race([
      bootstrapPromise,
      new Promise(r => setTimeout(r, 2000)),
    ])
  } catch {
    // ignore
  }
}

function rdapUrlFor(domain) {
  const tld = domain.slice(domain.lastIndexOf('.') + 1).toLowerCase()
  const base = rdapMap[tld]
  if (base) return base + 'domain/' + domain
  return 'https://rdap.org/domain/' + domain
}

function fallbackRdapUrl(domain) {
  return 'https://rdap.org/domain/' + domain
}

const sleep = ms => new Promise(r => setTimeout(r, ms))

async function fetchRdap(url, signal) {
  return fetch(url, {
    method: 'GET',
    redirect: 'follow',
    signal: signal ?? AbortSignal.timeout(10000),
  })
}

async function rdapWithRetry(domain, signal) {
  const primary = rdapUrlFor(domain)
  const fallback = fallbackRdapUrl(domain)
  const usingFallback = primary === fallback

  for (let attempt = 0; attempt <= 2; attempt++) {
    if (signal?.aborted) return null
    try {
      const res = await fetchRdap(primary, signal)
      if (res.status === 429) {
        if (attempt < 2) {
          await sleep(Math.min(300 * Math.pow(2, attempt), 4000))
          continue
        }
        break
      }
      if (res.status >= 500 && res.status < 600) {
        if (attempt === 0) {
          await sleep(500)
          continue
        }
        return { error: true }
      }
      return { status: res.status }
    } catch {
      return { error: true }
    }
  }

  if (!usingFallback) {
    try {
      const res = await fetchRdap(fallback, signal)
      if (res.status === 429) return { error: true }
      return { status: res.status }
    } catch {
      return { error: true }
    }
  }
  return { error: true }
}

function interpretDoh(data) {
  if (data.Status === 3) return true
  if (data.Status === 0) {
    const answer = data.Answer || []
    const authority = data.Authority || []
    if (answer.some(r => r.type === 1 || r.type === 28 || r.type === 5)) return false
    if (answer.some(r => r.type === 2)) return false
    if (authority.some(r => r.type === 2 || r.type === 6)) return false
    if (answer.length === 0 && authority.length === 0) return true
  }
  return null
}

async function queryDoh(url, signal) {
  try {
    const res = await fetch(url, {
      headers: { Accept: 'application/dns-json' },
      signal: signal ?? AbortSignal.timeout(6000),
    })
    if (!res.ok) return null
    return interpretDoh(await res.json())
  } catch {
    return null
  }
}

async function checkViaDoh(domain, signal) {
  const cf = 'https://cloudflare-dns.com/dns-query?name=' + encodeURIComponent(domain) + '&type=A'
  const google = 'https://dns.google/resolve?name=' + encodeURIComponent(domain) + '&type=A'
  const [a, b] = await Promise.all([queryDoh(cf, signal), queryDoh(google, signal)])
  if (a === null && b === null) return null
  if (a === null) return b
  if (b === null) return a
  // Prefer "taken" (false) when providers disagree — safer conservative answer.
  if (a !== b) return false
  return a
}

export async function checkDomainAvailable(domain, signal) {
  await ensureBootstrap()
  const rdap = await rdapWithRetry(domain, signal)
  if (rdap && !rdap.error) {
    if (rdap.status === 200) return false
    if (rdap.status === 404) return await checkViaDoh(domain, signal)
  }
  return await checkViaDoh(domain, signal)
}

export async function checkMultipleZones(name, zones, signal) {
  const results = {}
  for (const zone of zones) {
    if (signal?.aborted) break
    results[zone] = await checkDomainAvailable(name + '.' + zone, signal)
  }
  return results
}
