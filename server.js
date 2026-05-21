// Tiny Bun server: serves static files from CWD + split JSON state endpoints.
// Run with: bun server.js
// Env:
//   PORT        (default 3000)
//   CONFIG_PATH (default ./config.json)   — settings + libraries (rare writes)
//   DB_PATH     (default ./db.json)        — domains/sets/seen-stems (hot writes)
//   LOG_PATH    (default ./loop-log.jsonl) — append-only loop iteration log
//   STATE_PATH  (default ./state.json)     — legacy single-blob, kept for migration shim

import { appendFile } from 'node:fs/promises'

const PORT = Number(process.env.PORT) || 3000
const CONFIG_PATH = process.env.CONFIG_PATH || './config.json'
const DB_PATH = process.env.DB_PATH || './db.json'
const LOG_PATH = process.env.LOG_PATH || './loop-log.jsonl'
const STATE_PATH = process.env.STATE_PATH || './state.json'

const LOG_ROTATE_BYTES = 10 * 1024 * 1024 // 10 MB

// ---- helpers ---------------------------------------------------------------

async function readJsonFile(path) {
  const f = Bun.file(path)
  if (!(await f.exists())) {
    return new Response('{}', { headers: { 'Content-Type': 'application/json' } })
  }
  return new Response(f, { headers: { 'Content-Type': 'application/json' } })
}

async function atomicWriteJson(path, body) {
  const tmp = path + '.tmp'
  await Bun.write(tmp, body)
  await Bun.$`mv ${tmp} ${path}`.quiet()
}

function todayStamp() {
  const d = new Date()
  const yyyy = d.getUTCFullYear()
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0')
  const dd = String(d.getUTCDate()).padStart(2, '0')
  return `${yyyy}-${mm}-${dd}`
}

async function maybeRotateLog() {
  const f = Bun.file(LOG_PATH)
  if (!(await f.exists())) return
  if (f.size <= LOG_ROTATE_BYTES) return
  // Pick a rotated filename that doesn't already exist (multi-rotation same day).
  let base = LOG_PATH.replace(/\.jsonl$/, '') + '-' + todayStamp()
  let rotated = base + '.jsonl'
  let n = 1
  while (await Bun.file(rotated).exists()) {
    rotated = `${base}-${n}.jsonl`
    n++
  }
  await Bun.$`mv ${LOG_PATH} ${rotated}`.quiet()
}

async function appendLogLine(line) {
  await maybeRotateLog()
  // appendFile creates the file if absent. Built-in node:fs/promises — no npm.
  await appendFile(LOG_PATH, line, 'utf8')
}

// ---- server ----------------------------------------------------------------

Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url)
    const pathname = url.pathname

    // -- /api/config -------------------------------------------------------
    if (pathname === '/api/config') {
      if (req.method === 'GET') return readJsonFile(CONFIG_PATH)
      if (req.method === 'PUT') {
        const body = await req.text()
        await atomicWriteJson(CONFIG_PATH, body)
        return new Response('{"ok":true}', { headers: { 'Content-Type': 'application/json' } })
      }
      return new Response('Method Not Allowed', { status: 405 })
    }

    // -- /api/db -----------------------------------------------------------
    if (pathname === '/api/db') {
      if (req.method === 'GET') return readJsonFile(DB_PATH)
      if (req.method === 'PUT') {
        const body = await req.text()
        await atomicWriteJson(DB_PATH, body)
        return new Response('{"ok":true}', { headers: { 'Content-Type': 'application/json' } })
      }
      return new Response('Method Not Allowed', { status: 405 })
    }

    // -- /api/loop-log -----------------------------------------------------
    if (pathname === '/api/loop-log') {
      if (req.method === 'POST') {
        let bodyText
        try {
          bodyText = await req.text()
          // Validate it's parseable JSON; we re-stringify to normalize and
          // guarantee single-line storage.
          const obj = JSON.parse(bodyText)
          if (!obj || typeof obj !== 'object') throw new Error('not an object')
          await appendLogLine(JSON.stringify(obj) + '\n')
        } catch (e) {
          return new Response(JSON.stringify({ ok: false, error: String(e) }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' },
          })
        }
        return new Response('{"ok":true}', { headers: { 'Content-Type': 'application/json' } })
      }
      if (req.method === 'GET') {
        const after = url.searchParams.get('after') // ISO string, optional
        const afterMs = after ? Date.parse(after) : NaN
        const f = Bun.file(LOG_PATH)
        if (!(await f.exists())) {
          return new Response('', {
            headers: { 'Content-Type': 'application/x-ndjson' },
          })
        }
        const text = await f.text()
        const lines = text.split('\n').filter(Boolean)
        const out = []
        for (const line of lines) {
          if (!Number.isNaN(afterMs)) {
            // Parse just enough to filter by timestamp; on parse error, skip.
            try {
              const obj = JSON.parse(line)
              const ts = obj && obj.timestamp ? Date.parse(obj.timestamp) : NaN
              if (!Number.isNaN(ts) && ts > afterMs) out.push(line)
            } catch { /* skip malformed */ }
          } else {
            out.push(line)
          }
        }
        return new Response(out.length ? out.join('\n') + '\n' : '', {
          headers: { 'Content-Type': 'application/x-ndjson' },
        })
      }
      return new Response('Method Not Allowed', { status: 405 })
    }

    // -- /api/state (legacy compatibility shim) ----------------------------
    // Kept for ONE more release so old clients can read merged config+db,
    // and so the migration path can DELETE it after splitting.
    if (pathname === '/api/state') {
      if (req.method === 'GET') {
        // Prefer merged config+db; fall back to old state.json if those don't
        // exist (so a never-upgraded user still gets their data).
        const cfgFile = Bun.file(CONFIG_PATH)
        const dbFile = Bun.file(DB_PATH)
        const cfgExists = await cfgFile.exists()
        const dbExists = await dbFile.exists()
        if (cfgExists || dbExists) {
          const config = cfgExists ? await cfgFile.json().catch(() => ({})) : {}
          const dbObj = dbExists ? await dbFile.json().catch(() => ({})) : {}
          const merged = {
            settings: (config && config.settings) || {},
            domains: (dbObj && dbObj.domains) || [],
            sets: (dbObj && dbObj.sets) || [],
          }
          return new Response(JSON.stringify(merged), {
            headers: { 'Content-Type': 'application/json' },
          })
        }
        // No new files yet — serve legacy state.json if present.
        const f = Bun.file(STATE_PATH)
        if (!(await f.exists())) {
          return new Response('{}', { headers: { 'Content-Type': 'application/json' } })
        }
        return new Response(f, { headers: { 'Content-Type': 'application/json' } })
      }
      if (req.method === 'PUT') {
        // Deprecated. Don't write; log once-per-request.
        console.warn('[server] DEPRECATED: PUT /api/state ignored — use /api/config and /api/db.')
        return new Response('{"ok":true,"deprecated":true}', {
          headers: { 'Content-Type': 'application/json' },
        })
      }
      if (req.method === 'DELETE') {
        const f = Bun.file(STATE_PATH)
        if (await f.exists()) {
          try { await f.unlink() } catch (e) {
            console.warn('[server] failed to unlink legacy state.json:', e)
          }
        }
        return new Response('{"ok":true}', {
          headers: { 'Content-Type': 'application/json' },
        })
      }
      return new Response('Method Not Allowed', { status: 405 })
    }

    // -- Static files ------------------------------------------------------
    const filePath = '.' + (pathname === '/' ? '/index.html' : pathname)
    const file = Bun.file(filePath)
    if (await file.exists()) {
      return new Response(file) // Content-Type inferred by Bun.file
    }
    return new Response('Not Found', { status: 404 })
  },
})

console.log(
  `Serving at http://localhost:${PORT}\n` +
  `  config: ${CONFIG_PATH}\n` +
  `  db:     ${DB_PATH}\n` +
  `  log:    ${LOG_PATH}\n` +
  `  legacy: ${STATE_PATH} (GET only; PUT ignored)`,
)
