// A small stand-in for the Lecture Assistant API, enough for the extension: logs what it receives.
import http from 'node:http'
import { mkdtempSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export function startMock({ failFirstUploads = 0, limitAtFinish = false, staysBusy = false } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'lk-chunks-'))
  const log = { dir, files: {}, chunks: [], finishes: [], deleted: [], opened: [], created: [], cancelled: [], uploadTries: 0 }
  let sessionId = 700
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x')
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const body = Buffer.concat(chunks)
      const send = (status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)) }
      const p = url.pathname.replace(/^\/api/, '')
      const auth = req.headers.authorization
      if (p === '/web') { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end('<title>web</title><p>the website</p>') }
      if (p === '/auth/config') return send(200, { google_enabled: false, google_client_id: null, limits: {} })
      if (p === '/auth/login') return send(200, { token: 'tok', expires_at: new Date(Date.now() + 864e5).toISOString() })
      if (auth !== 'Bearer tok') return send(401, { error: { code: 'unauthorized', message: 'Log in' } })
      if (p === '/auth/me') return send(200, { user: { id: 1, email: 'a@b.c', full_name: 'A B' } })
      if (p === '/courses') return send(200, [{ id: 1, name: 'BSc Computing' }])
      if (p === '/courses/1/modules') return send(200, [{ id: 11, name: 'Programming' }])
      if (p === '/modules/11/sessions') { sessionId += 1; log.created.push(JSON.parse(body.toString()).title); return send(201, { id: sessionId }) }
      if (req.method === 'DELETE') { log.deleted.push(p); return send(204, null) }
      const m = p.match(/^\/sessions\/(\d+)\/live(\/chunks|\/finish)?$/)
      if (m && !m[2] && req.method === 'POST') { log.opened.push(Number(m[1])); return send(200, { chunk_seconds: 300, overlap: 5 }) }
      if (m && m[2] === '/chunks') {
        log.uploadTries += 1
        if (log.uploadTries <= failFirstUploads) return send(500, { error: { code: 'error', message: 'boom' } })
        const name = (body.toString('latin1').match(/filename="([^"]+)"/) || [])[1]
        const start = body.indexOf('\r\n\r\n') + 4
        const end = body.lastIndexOf('\r\n--')
        const file = path.join(dir, name)
        writeFileSync(file, body.subarray(start, end))
        log.files[Number(url.searchParams.get('index'))] = file
        log.chunks.push({ index: Number(url.searchParams.get('index')), name, bytes: end - start })
        return send(200, { queued: Number(url.searchParams.get('index')), job_id: 1 })
      }
      if (m && !m[2] && req.method === 'GET') {
        const total = Number(url.searchParams.get('total') || 0)
        const have = new Set(log.chunks.map((c) => c.index))
        return send(200, { chunk_seconds: 300, overlap: 5, total, received: [...have], missing: Array.from({ length: total }, (_, i) => i).filter((i) => !have.has(i)) })
      }
      if (m && m[2] === '/finish') {
        if (limitAtFinish) return send(429, { error: { code: 'daily_limit', message: 'Daily limit reached (5 lectures); try again tomorrow' } })
        log.finishes.push({ total: Number(url.searchParams.get('total')), slides: (body.toString('latin1').match(/name="slides"; filename="([^"]+)"/g) || []).length })
        return send(200, { job_id: 1 })
      }
      if (/^\/sessions\/\d+\/cancel$/.test(p) && req.method === 'POST') { log.cancelled.push({ p, kind: url.searchParams.get('kind') }); staysBusy = 'cancelled'; return send(200, { state: 'cancelling' }) }
      if (p === '/jobs/1' && staysBusy === 'cancelled') return send(200, { id: 1, state: 'cancelled', stage: 'cancelled', percent: 10, message: '' })
      if (p === '/jobs/1' && staysBusy) return send(200, { id: 1, state: 'processing', stage: 'transcribe', percent: 12, message: 'Turning speech into text' })
      if (p === '/jobs/1') return send(200, { id: 1, state: 'done', stage: 'done', percent: 100, message: 'Done' })
      send(404, { error: { code: 'not_found', message: p } })
    })
  })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, log, url: `http://127.0.0.1:${server.address().port}`, close: () => server.close() })))
}
