// The panel: login, ready, recording, after stop, processing, done. It only shows state; the work is in background.js.
import { makeApi, friendly } from './lib/api.js'
import { makeChunkStore, getSettings, setLocal, getLocal, loggedIn, DEFAULT_SERVER } from './lib/store.js'
import { mmss } from './lib/chunker.js'

const TEST = new URLSearchParams(location.search)                      // ?fake=1&L=10: a made-up stream and short parts, for the automatic tests only
const app = document.getElementById('app')
const who = document.getElementById('who')
const store = makeChunkStore()
const api = makeApi({ get: getSettings, onUnauthorized: () => setLocal({ token: null }) })
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
const $ = (sel) => app.querySelector(sel)

let settings = await getSettings()
let rec = (await getLocal('rec')).rec || { phase: 'idle' }
let queue = (await getLocal('queue')).queue || { pending: 0, sent: 0, paused: null, fatal: null, retryIn: 0 }
let seconds = rec.seconds || 0
let running = []
let notice = ''
let view = ''
let courses = null
let job = null
let jobTimer = null

const send = (msg) => chrome.runtime.sendMessage(msg).then((r) => { if (r && r.ok === false) throw new Error(r.error); return r && r.value })
const web = (path) => `${settings.server.replace(/\/+$/, '')}${path}`

chrome.storage.onChanged.addListener(async (c) => {
  if (c.rec) { rec = c.rec.newValue || { phase: 'idle' }; if (rec.phase !== 'recording') seconds = rec.seconds || seconds }
  if (c.queue) queue = c.queue.newValue || queue
  if (c.token || c.server || c.user) settings = await getSettings()
  render(!!(c.rec || c.token || c.server))
})
chrome.runtime.onMessage.addListener((m) => {
  if (m.source === 'offscreen' && m.type === 'tick') { seconds = m.t; running = m.running; updateLive() }
})

function currentView() {
  if (!loggedIn(settings)) return 'login'
  if (rec.phase === 'idle') return 'ready'
  return rec.phase
}

async function render(force) {
  const next = currentView()
  who.textContent = settings.user ? settings.user.email : ''
  if (!force && next === view) return updateLive()
  if (next !== view) notice = ''
  view = next
  const fn = { login, ready, recording: recordingView, paused: recordingView, stopped, finishing: stopped, processing, limit, done, failed }[next]
  app.innerHTML = ''
  await fn()
  updateLive()
}

const err = (m) => (m ? `<div class="error" role="alert">${esc(m)}</div>` : '')

// ---------- E1 log in
function login() {
  app.innerHTML = `
    <form class="card" id="f">
      <h1>Log in</h1>
      <div class="muted">Use the same account as on the website.</div>
      ${err(notice)}
      <label>Email<input type="email" name="email" autocomplete="username" required></label>
      <label>Password<input type="password" name="password" autocomplete="current-password" required></label>
      <details><summary>Server</summary><label>Address<input type="url" name="server" value="${esc(settings.server)}"></label></details>
      <button class="btn" type="submit">Log in</button>
      <div class="muted">No account yet? Create one on the website. Signed up with Google? Set a password there first.</div>
    </form>`
  $('#f').addEventListener('submit', async (e) => {
    e.preventDefault()
    const f = new FormData(e.target)
    const server = String(f.get('server') || DEFAULT_SERVER).trim().replace(/\/+$/, '')
    const btn = e.target.querySelector('button')
    btn.disabled = true
    try {
      await ensureHostPermission(server)
      await setLocal({ server })
      const r = await api.login(String(f.get('email')).trim(), String(f.get('password')))
      await setLocal({ token: r.token, expiresAt: r.expires_at })
      const me = await api.me().catch(() => null)
      await setLocal({ user: me })
      send({ type: 'kick' }).catch(() => {})
      notice = ''
    } catch (er) {
      notice = friendly(er)
      render(true)
    }
  })
}

async function ensureHostPermission(server) {
  const origin = `${new URL(server).origin}/*`
  if (await chrome.permissions.contains({ origins: [origin] })) return
  const ok = await chrome.permissions.request({ origins: [origin] })
  if (!ok) throw new Error('Allow the extension to talk to this server, then log in again.')
}

// ---------- E2 ready
async function ready() {
  app.innerHTML = '<div class="card muted">Loading your courses...</div>'
  let tab = null
  try { [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true }) } catch { /* no tab */ }
  try { courses = courses || await loadCourses() } catch (e) { app.innerHTML = `<div class="card">${err(friendly(e))}<button class="btn" id="retry">Try again</button></div>`; $('#retry').onclick = () => { courses = null; render(true) }; return }
  const flat = courses.flatMap((c) => c.modules.map((m) => ({ id: m.id, label: `${c.name} › ${m.name}` })))
  const last = settings.lastModule
  const title = `Lecture ${new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })} ${new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`
  const recordable = TEST.get('fake') || (tab && tab.url && /^https?:/i.test(tab.url))
  app.innerHTML = `
    <div class="card">
      <h1>Record a lecture</h1>
      ${err(notice)}
      ${flat.length ? '' : '<div class="info">You need a course and a module first. Create them on the website.</div>'}
      <label>Course and module<select id="mod">${flat.map((m) => `<option value="${m.id}" ${m.id === last ? 'selected' : ''}>${esc(m.label)}</option>`).join('')}</select></label>
      <label>Session title<input type="text" id="title" value="${esc(title)}" maxlength="160"></label>
      <div class="muted">Tab to record: <b>${esc(tab ? tab.title : 'none')}</b></div>
      ${recordable ? '' : '<div class="info">Open the lecture tab first. Browser pages (chrome://) cannot be recorded.</div>'}
      <label class="check"><input type="checkbox" id="video" ${settings.video ? 'checked' : ''}> Also record the picture (board, slides, screen)</label>
      <div class="muted">Only this tab is recorded, never your microphone. Notes are made after you press Stop.</div>
      <button class="btn record" id="go" ${flat.length && recordable ? '' : 'disabled'}>Start recording</button>
    </div>`
  $('#go').onclick = async () => {
    const moduleId = Number($('#mod').value)
    const t = $('#title').value.trim() || title
    const video = $('#video').checked
    await setLocal({ lastModule: moduleId, video })
    $('#go').disabled = true
    try {
      await send({ type: 'start', moduleId, title: t, video, tabId: tab && tab.id, fake: !!TEST.get('fake'), chunkSeconds: Number(TEST.get('L')) || undefined })
      notice = ''
    } catch (e) { notice = e.message; render(true) }
  }
}
async function loadCourses() {
  const cs = await api.courses()
  return Promise.all(cs.map(async (c) => ({ ...c, modules: await api.modules(c.id) })))
}

// ---------- E3 recording
function recordingView() {
  const paused = rec.phase === 'paused'
  app.innerHTML = `
    <div class="card ${paused ? 'paused' : ''}">
      <div class="live"><span class="dot"></span><span id="state">${paused ? 'Paused' : 'Recording'}</span></div>
      <div class="timer" id="timer">${mmss(seconds)}</div>
      <div class="muted center">${esc(rec.title || '')}</div>
      <div class="parts" id="parts" aria-label="Parts of 5 minutes"></div>
      ${err(notice)}
      <div class="row">
        <button class="btn ghost" id="pause">${paused ? 'Resume' : 'Pause'}</button>
        <button class="btn danger" id="stop">Stop and process</button>
      </div>
      <div class="muted center">Notes are made after you press Stop. You can close this panel; the recording continues.</div>
    </div>`
  $('#pause').onclick = () => send({ type: paused ? 'resume' : 'pause' }).catch((e) => { notice = e.message; render(true) })
  $('#stop').onclick = async () => { $('#stop').disabled = true; await send({ type: 'stop' }).catch((e) => { notice = e.message; render(true) }) }
  checkRecorderAlive()
}
async function checkRecorderAlive() {
  const alive = await send({ type: 'alive' }).catch(() => true)
  if (!alive && ['recording', 'paused'].includes(rec.phase)) {
    app.innerHTML = `<div class="card"><h1>The recording was interrupted</h1><div class="muted">The browser was closed or restarted. The parts that were saved can still be finished.</div>
      <button class="btn" id="rec">Finish recording from before</button><button class="btn ghost" id="drop">Discard</button></div>`
    $('#rec').onclick = () => send({ type: 'recover' })
    $('#drop').onclick = () => send({ type: 'reset' })
  }
}

// ---------- E4 after stop
function stopped() {
  const busy = rec.phase === 'finishing'
  app.innerHTML = `
    <div class="card">
      <h1>${busy ? 'Sending the last parts' : 'Recording stopped'}</h1>
      <div class="muted">${esc(rec.title || '')} · ${mmss(seconds)}</div>
      <div class="parts" id="parts"></div>
      <div class="bar"><span id="sendbar" style="width:0%"></span></div>
      <div id="queueinfo" class="muted"></div>
      ${err(rec.error || notice)}
      <label>Slides (optional, PDF or PPTX)<input type="file" id="slides" accept=".pdf,.pptx,.ppt,.docx" multiple ${busy ? 'disabled' : ''}></label>
      <button class="btn" id="make" ${busy ? 'disabled' : ''}>${busy ? 'Working...' : 'Make notes'}</button>
      <button class="btn ghost" id="drop" ${busy ? 'disabled' : ''}>Discard this recording</button>
    </div>`
  $('#make').onclick = async () => {
    $('#make').disabled = true
    const files = [...($('#slides').files || [])].map((f) => ({ name: f.name, blob: f }))
    await store.putSlides(rec.sessionId, files)
    await send({ type: 'finish' }).catch((e) => { notice = e.message; render(true) })
  }
  $('#drop').onclick = async () => {
    if (!confirm('Discard this recording? It cannot be recovered.')) return
    await store.clearSession(rec.sessionId)
    await api.deleteSession(rec.sessionId).catch(() => {})
    await send({ type: 'reset' })
  }
}

// ---------- E4b processing, limit, done, failed
async function processing() {
  app.innerHTML = `<div class="card"><h1>Making your notes</h1><div class="muted" id="jobmsg">Starting...</div><div class="bar"><span id="jobbar" style="width:5%"></span></div>
    <div class="muted">You can close this panel. You will find the notes on the website when they are ready.</div></div>`
  pollJob()
}
function pollJob() {
  clearTimeout(jobTimer)
  const tick = async () => {
    if (rec.phase !== 'processing' || !rec.jobId) return
    try {
      job = await api.job(rec.jobId)
      const bar = $('#jobbar'); const msg = $('#jobmsg')
      if (bar) bar.style.width = `${Math.max(5, job.percent || 0)}%`
      if (msg) msg.textContent = job.message || job.stage || 'Working...'
      if (job.state === 'done') return setLocal({ rec: { ...rec, phase: 'done' } })
      if (job.state === 'failed') return setLocal({ rec: { ...rec, phase: 'failed', error: job.error_message || 'Processing failed.' } })
    } catch { /* try again */ }
    jobTimer = setTimeout(tick, 2000)
  }
  tick()
}
function limit() {
  app.innerHTML = `<div class="card"><h1>Saved for tomorrow</h1>${err(rec.error)}
    <div class="muted">Your recording is on the server. Open the lecture on the website and press "Finish and make notes" when you can.</div>
    <a class="btn" target="_blank" rel="noopener" href="${esc(web('/sessions/' + rec.sessionId))}">Open the lecture</a>
    <button class="btn ghost" id="again">Record another lecture</button></div>`
  $('#again').onclick = () => send({ type: 'reset' })
}
function done() {
  app.innerHTML = `<div class="card center"><div class="big-check">✓</div><h1>Notes are ready</h1><div class="muted">${esc(rec.title || '')}</div>
    <a class="btn" target="_blank" rel="noopener" href="${esc(web('/sessions/' + rec.sessionId))}">Open notes</a>
    <a class="btn ghost" target="_blank" rel="noopener" href="${esc(web('/quiz/' + rec.sessionId))}">Take the quiz</a>
    <button class="btn ghost" id="again">Record another lecture</button></div>`
  $('#again').onclick = () => send({ type: 'reset' })
}
function failed() {
  app.innerHTML = `<div class="card"><h1>Processing failed</h1>${err(rec.error)}
    <button class="btn" id="retry">Try again</button>
    <a class="btn ghost" target="_blank" rel="noopener" href="${esc(web('/sessions/' + rec.sessionId))}">Open the lecture</a>
    <button class="btn ghost" id="again">Record another lecture</button></div>`
  $('#retry').onclick = async () => { await api.retry(rec.sessionId).then((j) => setLocal({ rec: { ...rec, phase: 'processing', jobId: j.job_id, error: null } })).catch((e) => { notice = friendly(e); render(true) }) }
  $('#again').onclick = () => send({ type: 'reset' })
}

// ---------- the parts of 5 minutes, the timer, the sending bar
async function updateLive() {
  const t = $('#timer'); if (t) t.textContent = mmss(seconds)
  const box = $('#parts')
  if (box && rec.sessionId) {
    const L = rec.chunkSeconds || 300
    const saved = new Map((await store.forSession(rec.sessionId)).map((c) => [c.index, c]))
    const n = ['recording', 'paused'].includes(rec.phase) ? Math.max(1, Math.ceil(seconds / L)) : (rec.total || saved.size)
    box.innerHTML = Array.from({ length: n }, (_, k) => {
      const c = saved.get(k)
      const cls = c ? (c.state === 'sent' ? 'sent' : 'pending') : running.includes(k) ? 'rec' : ''
      return `<span class="part ${cls}" title="${c ? (c.state === 'sent' ? 'sent' : 'saved, waiting to be sent') : 'recording'}">${k + 1}</span>`
    }).join('')
    const total = Math.max(1, rec.total || n)
    const sent = [...saved.values()].filter((c) => c.state === 'sent').length
    const bar = $('#sendbar'); if (bar) bar.style.width = `${Math.round((100 * sent) / total)}%`
    const info = $('#queueinfo')
    if (info) info.textContent = queue.paused === 'login' ? 'Log in again to continue sending.' : queue.fatal ? friendly({ code: queue.fatal }) : queue.retryIn ? `Could not send a part. Trying again in ${queue.retryIn} s.` : `${sent} of ${total} parts sent`
  }
}

if (rec.phase === 'processing') render(true)
else render(true)
