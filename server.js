// Tiny Bun server: serves static files from CWD + a single JSON state endpoint.
// Run with: bun server.js
// Env: PORT (default 3000), STATE_PATH (default ./state.json)

const PORT = Number(process.env.PORT) || 3000
const STATE_PATH = process.env.STATE_PATH || './state.json'

Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url)
    const pathname = url.pathname

    if (pathname === '/api/state') {
      if (req.method === 'GET') {
        const f = Bun.file(STATE_PATH)
        if (!(await f.exists())) {
          return new Response('{}', { headers: { 'Content-Type': 'application/json' } })
        }
        return new Response(f, { headers: { 'Content-Type': 'application/json' } })
      }
      if (req.method === 'PUT') {
        const body = await req.text()
        // Atomic write: tmp file + rename.
        const tmp = STATE_PATH + '.tmp'
        await Bun.write(tmp, body)
        await Bun.$`mv ${tmp} ${STATE_PATH}`.quiet()
        return new Response('{"ok":true}', { headers: { 'Content-Type': 'application/json' } })
      }
      return new Response('Method Not Allowed', { status: 405 })
    }

    // Static files from CWD. Default `/` to `index.html`.
    const filePath = '.' + (pathname === '/' ? '/index.html' : pathname)
    const file = Bun.file(filePath)
    if (await file.exists()) {
      return new Response(file) // Content-Type inferred by Bun.file
    }
    return new Response('Not Found', { status: 404 })
  },
})

console.log(`Serving at http://localhost:${PORT} (state at ${STATE_PATH})`)
