// The panel: login, ready, recording, after stop, processing, done. It only shows state; the work is in background.js.
import { makeApi, friendly } from './lib/api.js'
import { makeChunkStore, getSettings, setLocal, getLocal, loggedIn, DEFAULT_SERVER } from './lib/store.js'
import { mmss } from './lib/chunker.js'

const TEST = new URLSearchParams(location.search)                      // ?fake=1&L=10: a made-up stream and short parts, for the automatic tests only
const app = document.getElementById('app')
const logoutBtn = document.getElementById('logout')
const acct = document.getElementById('acct')
const avatar = document.getElementById('avatar')
const menu = document.getElementById('menu')
const store = makeChunkStore()
const api = makeApi({ get: getSettings, onUnauthorized: () => setLocal({ token: null }) })
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
const $ = (sel) => app.querySelector(sel)

let settings = await getSettings()
applyTheme(settings.theme)
let rec = (await getLocal('rec')).rec || { phase: 'idle' }
let queue = (await getLocal('queue')).queue || { pending: 0, sent: 0, paused: null, fatal: null, retryIn: 0 }
let seconds = rec.seconds || 0
let notice = ''
let view = ''
let courses = null
let showForm = false
let job = null
let jobTimer = null

const send = (msg) => chrome.runtime.sendMessage(msg).then((r) => { if (r && r.ok === false) throw new Error(r.error); return r && r.value })
const web_url = (path) => `${settings.server.replace(/\/+$/, '')}${path}`
const web = (path) => `${settings.server.replace(/\/+$/, '')}${path}`

chrome.storage.onChanged.addListener(async (c) => {
  let redraw = false
  if (c.rec) {
    const before = rec
    rec = c.rec.newValue || { phase: 'idle' }
    if (rec.phase !== 'recording') seconds = rec.seconds || seconds
    redraw = before.phase !== rec.phase || before.error !== rec.error || before.jobId !== rec.jobId || before.total !== rec.total || before.sessionId !== rec.sessionId
  }
  if (c.queue) queue = c.queue.newValue || queue
  if (c.token || c.server || c.user) settings = await getSettings()
  render(redraw || !!(c.token || c.server || c.user))
})
chrome.runtime.onMessage.addListener((m) => {
  if (m.source === 'offscreen' && m.type === 'tick') { seconds = m.t; updateLive() }
})

function currentView() {
  if (!loggedIn(settings)) return 'login'
  if (rec.phase === 'idle') return 'ready'
  return rec.phase
}

async function render(force) {
  const next = currentView()
  paintAccount()
  if (!force && next === view) return updateLive()
  if (next !== view) notice = ''
  view = next
  const fn = { login, ready, recording: recordingView, paused: recordingView, stopped, finishing: stopped, processing, limit, done, failed }[next]
  app.innerHTML = ''
  app.classList.remove('centered')
  await fn()
  updateLive()
}

const err = (m) => (m ? `<div class="error" role="alert">${esc(m)}</div>` : '')

// the round profile button of the header, with a menu (name, email, log out) like the website's
const initials = (u) => {
  const words = String((u && (u.full_name || u.email)) || '?').replace(/@.*/, '').split(/[\s._-]+/).filter(Boolean)
  return (words.length > 1 ? words[0][0] + words[words.length - 1][0] : (words[0] || '?').slice(0, 2)).toUpperCase()
}
function paintAccount() {
  acct.hidden = !loggedIn(settings)
  const u = settings.user
  avatar.textContent = initials(u)
  document.getElementById('avatar2').textContent = initials(u)
  document.getElementById('acct-name').textContent = (u && u.full_name) || 'Account'
  document.getElementById('acct-mail').textContent = (u && u.email) || ''
}
const closeMenu = () => { menu.hidden = true; avatar.setAttribute('aria-expanded', 'false') }
avatar.onclick = () => { menu.hidden = !menu.hidden; avatar.setAttribute('aria-expanded', String(!menu.hidden)) }
document.addEventListener('mousedown', (e) => { if (!acct.contains(e.target)) closeMenu() })
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { closeMenu(); avatar.focus() } })

logoutBtn.onclick = async () => {
  closeMenu()
  if (['recording', 'paused'].includes(rec.phase) && !confirm('A recording is running. Log out anyway? Recording continues but parts cannot be sent until you log in again.')) return
  await setLocal({ token: null, expiresAt: null, user: null })
  showForm = true                                                       // logging out here means: let me type another account
}

// ---------- E1 log in
async function login() {
  app.innerHTML = '<div class="card muted">Checking your login...</div>'
  const [web, cfg] = await Promise.all([findWebSession(), api.config().catch(() => null)])
  const welcome = web && !showForm
  app.classList.add('centered')
  app.innerHTML = `
    ${welcome ? `<div class="card">
      <h1>Welcome back</h1>
      <div class="muted">You are already logged in on the website.</div>
      <button class="btn" id="web">Continue as ${esc(web.user.full_name || web.user.email)}</button>
      <button class="link" id="other" type="button">Use a different account</button>
    </div>` : `
    <form class="card" id="f">
      <h1>Log in</h1>
      ${web ? '' : '<div class="muted">Use the same account as on the website. If the website is open and you are logged in there, this panel can use that login.</div>'}
      ${err(notice)}
      <label>Email<input type="email" name="email" autocomplete="username" required></label>
      <label>Password<input type="password" name="password" autocomplete="current-password" required></label>
      <button class="btn" type="submit">Log in</button>
      <div class="or"><span>or</span></div>
      <button class="btn google" type="button" id="google" ${cfg && cfg.google_enabled ? '' : 'disabled'} title="${cfg && cfg.google_enabled ? '' : 'Google sign-in is not set up on this server'}">
        <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true"><path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9.1 3.6l6.8-6.8C35.8 2.4 30.3 0 24 0 14.6 0 6.5 5.4 2.6 13.2l7.9 6.1C12.4 13.6 17.7 9.5 24 9.5z"/><path fill="#4285F4" d="M46.5 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.7c-.6 3-2.2 5.5-4.7 7.2l7.6 5.9c4.4-4.1 6.9-10.1 6.9-17.6z"/><path fill="#FBBC05" d="M10.5 28.7A14.5 14.5 0 0 1 9.5 24c0-1.6.3-3.2.8-4.7l-7.9-6.1A24 24 0 0 0 0 24c0 3.9.9 7.5 2.6 10.8l7.9-6.1z"/><path fill="#34A853" d="M24 48c6.5 0 11.9-2.1 15.9-5.8l-7.6-5.9c-2.1 1.4-4.9 2.3-8.3 2.3-6.3 0-11.6-4.1-13.5-9.8l-7.9 6.1C6.5 42.6 14.6 48 24 48z"/></svg>
        Continue with Google
      </button>
      <div class="muted center">New here? <a href="${esc(web_url('/register'))}" target="_blank" rel="noopener">Create an account</a></div>
      ${web ? '<button class="link" id="back" type="button">Back</button>' : ''}
    </form>`}`
  if (welcome) $('#other').onclick = () => { showForm = true; render(true) }
  if (web && showForm && $('#back')) $('#back').onclick = () => { showForm = false; render(true) }
  if (welcome) $('#web').onclick = async () => { await setLocal({ token: web.token, expiresAt: web.expires, user: web.user }); send({ type: 'kick' }).catch(() => {}) }
  if ($('#google')) $('#google').onclick = () => googleLogin(cfg)
  if ($('#f')) $('#f').addEventListener('submit', async (e) => {
    e.preventDefault()
    const f = new FormData(e.target)
    const server = settings.server
    const btn = e.target.querySelector('button[type=submit]')
    btn.disabled = true
    try {
      await ensureHostPermission(server)
      await setLocal({ server })
      const r = await api.login(String(f.get('email')).trim(), String(f.get('password')))
      await setLocal({ token: r.token, expiresAt: r.expires_at })
      const me = await api.me().catch(() => null)
      await setLocal({ user: me && me.user ? me.user : me })
      send({ type: 'kick' }).catch(() => {})
      notice = ''
    } catch (er) {
      notice = friendly(er)
      render(true)
    }
  })
}

// What the website keeps in its local storage (login, theme), read from an open tab of it. null when no such tab is open.
async function readWebStorage(keys) {
  try {
    const origin = new URL(settings.server).origin
    if (!(await chrome.permissions.contains({ origins: [`${origin}/*`] }))) return null
    for (const tab of await chrome.tabs.query({ url: `${origin}/*` })) {
      const [res] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, args: [keys], func: (ks) => Object.fromEntries(ks.map((k) => [k, localStorage.getItem(k)])) })
      if (res && res.result) return res.result
    }
  } catch { /* no such tab, or no permission */ }
  return null
}

// Already logged in on the website? Its token is in that page's local storage (with the person's one click to use it).
async function findWebSession() {
  const r = await readWebStorage(['lk_token', 'lk_expires'])
  if (!r || !r.lk_token || (r.lk_expires && new Date(r.lk_expires) < new Date())) return null
  const origin = new URL(settings.server).origin
  const me = await fetch(`${origin}/api/auth/me`, { headers: { Authorization: `Bearer ${r.lk_token}` } }).then((x) => (x.ok ? x.json() : null)).catch(() => null)
  return me && (me.user || me.email) ? { token: r.lk_token, expires: r.lk_expires, user: me.user || me } : null
}

// The same theme as the website: light, dark, or the system's. Remembered, so it also applies when no website tab is open.
function applyTheme(mode) {
  if (mode === 'light' || mode === 'dark') document.documentElement.dataset.theme = mode
  else delete document.documentElement.dataset.theme
}
async function followWebsiteTheme() {
  const r = await readWebStorage(['lk_theme'])
  if (!r) return
  const mode = r.lk_theme === 'light' || r.lk_theme === 'dark' ? r.lk_theme : 'auto'          // the website's own "auto" follows the system
  applyTheme(mode)
  if (mode !== settings.theme) { settings.theme = mode; setLocal({ theme: mode }) }
}

// Google: the extension opens Google's own sign-in window and gets an ID token, which the server checks (same as the website).
async function googleLogin(cfg) {
  try {
    const nonce = crypto.randomUUID()
    const url = 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
      client_id: cfg.google_client_id, response_type: 'id_token', redirect_uri: chrome.identity.getRedirectURL(),
      scope: 'openid email profile', nonce, prompt: 'select_account',
    })
    const back = await chrome.identity.launchWebAuthFlow({ url, interactive: true })
    const idToken = new URLSearchParams(new URL(back).hash.slice(1)).get('id_token')
    if (!idToken) throw new Error('Google did not sign you in.')
    const r = await api.google(idToken)
    await setLocal({ token: r.token, expiresAt: r.expires_at, user: r.user })
    send({ type: 'kick' }).catch(() => {})
  } catch (e) {
    notice = /redirect_uri_mismatch|invalid/i.test(e.message || '') ? `Google refused the sign-in. Add ${chrome.identity.getRedirectURL()} as an authorised redirect URI of the Google client.` : friendly(e)
    render(true)
  }
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
  const { target } = await getLocal('target')                          // the tab on which the icon was clicked (that is the one Chrome lets us record)
  try { tab = target ? await chrome.tabs.get(target.id) : null } catch { tab = null }
  if (!tab) { try { [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true }) } catch { /* no tab */ } }
  try { courses = courses || await loadCourses() } catch (e) { app.innerHTML = `<div class="card">${err(friendly(e))}<button class="btn" id="retry">Try again</button></div>`; $('#retry').onclick = () => { courses = null; render(true) }; return }
  const lastCourse = courses.find((c) => c.modules.some((m) => m.id === settings.lastModule)) || courses.find((c) => c.modules.length) || courses[0] || null
  let course = lastCourse
  let mod = course ? (course.modules.find((m) => m.id === settings.lastModule) || course.modules[0] || null) : null
  const title = `Lecture ${new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })} ${new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`
  const recordable = TEST.get('fake') || (tab && tab.url && /^https?:/i.test(tab.url))
  app.innerHTML = `
    <div class="card">
      <h1>Record a lecture</h1>
      ${err(notice)}
      ${courses.some((c) => c.modules.length) ? '' : '<div class="info">You need a course and a module first. Create them on the website.</div>'}
      <div class="field"><span class="lbl" id="courselbl">Course</span><div id="coursepick"></div></div>
      <div class="field"><span class="lbl" id="modlbl">Module</span><div id="modpick"></div></div>
      <label>Session title<input type="text" id="title" value="${esc(title)}" maxlength="160"></label>
      ${recordable ? '' : '<div class="info">Open the lecture tab, click the extension icon on it, then press Start. Browser pages (chrome://) cannot be recorded.</div>'}
      <label>Slides (optional, PDF or PPTX)<input type="file" id="slides" accept=".pdf,.pptx,.ppt,.docx" multiple></label>
      <label class="check"><input type="checkbox" id="video" ${settings.video ? 'checked' : ''}> Also record the picture (board, slides, screen)</label>
      <div class="muted">Only the tab is recorded, never your microphone. Notes are made after you press Stop.</div>
      <button class="btn record" id="go" ${recordable ? '' : 'disabled'}>Start recording</button>
    </div>`
  const go = $('#go')
  const showModules = () => {
    picker($('#modpick'), course ? course.modules.map((m) => ({ id: m.id, label: m.name })) : [], () => mod && { id: mod.id, label: mod.name }, (m) => { mod = course.modules.find((x) => x.id === m.id); canGo() },
      'modlbl', course && !course.modules.length ? 'This course has no modules yet' : 'Choose a module')
    canGo()
  }
  const canGo = () => { go.disabled = !(recordable && mod) }
  picker($('#coursepick'), courses.map((c) => ({ id: c.id, label: c.name })), () => course && { id: course.id, label: course.name },
    (c) => { course = courses.find((x) => x.id === c.id); mod = course.modules[0] || null; showModules() }, 'courselbl', 'Choose a course')
  showModules()
  $('#go').onclick = async () => {
    const t = $('#title').value.trim() || title
    const video = $('#video').checked
    const files = [...($('#slides').files || [])].map((f) => ({ name: f.name, blob: f }))
    await setLocal({ lastModule: mod.id, video })
    $('#go').disabled = true
    try {
      await send({ type: 'start', moduleId: mod.id, title: t, video, tabId: tab && tab.id, fake: !!TEST.get('fake'), chunkSeconds: Number(TEST.get('L')) || undefined })
      const { rec: started } = await getLocal('rec')
      if (files.length && started && started.sessionId) await store.putSlides(started.sessionId, files)      // sent when the notes are made
      notice = ''
    } catch (e) { notice = e.message; render(true) }
  }
}

// A drop-down that looks the same everywhere (the browser's own list does not follow the dark theme).
function picker(host, items, get, set, labelId, placeholder) {
  host.innerHTML = `<div class="pick"><button type="button" class="pick-btn" aria-haspopup="listbox" aria-expanded="false" aria-labelledby="${labelId}" ${items.length ? '' : 'disabled'}></button><ul class="pick-list" role="listbox" hidden></ul></div>`
  const btn = host.querySelector('.pick-btn')
  const list = host.querySelector('.pick-list')
  list.innerHTML = items.map((i) => `<li role="option" class="pick-item" data-id="${i.id}" tabindex="-1">${esc(i.label)}</li>`).join('')
  const paint = () => {
    const c = get()
    btn.innerHTML = `<span class="${c ? '' : 'ph'}">${esc(c ? c.label : placeholder)}</span>`
    list.querySelectorAll('.pick-item').forEach((li) => li.setAttribute('aria-selected', String(!!c && Number(li.dataset.id) === c.id)))
  }
  const close = () => { list.hidden = true; btn.setAttribute('aria-expanded', 'false') }
  const open = () => { if (!items.length) return; list.hidden = false; btn.setAttribute('aria-expanded', 'true'); const on = list.querySelector('[aria-selected=true]'); if (on) on.scrollIntoView({ block: 'nearest' }) }
  btn.onclick = () => (list.hidden ? open() : close())
  list.onclick = (e) => { const li = e.target.closest('.pick-item'); if (!li) return; set(items.find((i) => i.id === Number(li.dataset.id))); paint(); close(); btn.focus() }
  host.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { close(); btn.focus() }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const cur = get()
      const i = items.findIndex((x) => cur && x.id === cur.id)
      const next = items[Math.min(items.length - 1, Math.max(0, i + (e.key === 'ArrowDown' ? 1 : -1)))]
      if (next) { set(next); paint() }
    }
  })
  document.addEventListener('mousedown', (e) => { if (!host.contains(e.target)) close() })
  paint()
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

// ---------- E4 after stop: the rest is sent and the notes are started by themselves
function stopped() {
  const busy = rec.phase === 'finishing'
  app.innerHTML = `
    <div class="card">
      <h1>${rec.error ? 'Could not finish' : 'Sending your recording'}</h1>
      <div class="muted">${esc(rec.title || '')} · ${mmss(seconds)}</div>
      <div class="bar"><span id="sendbar" style="width:0%"></span></div>
      <div id="queueinfo" class="muted"></div>
      ${err(rec.error || notice)}
      ${rec.error ? '<button class="btn" id="make">Try again</button>' : ''}
      <button class="btn ghost" id="drop" ${busy ? 'disabled' : ''}>Discard this recording</button>
    </div>`
  const make = $('#make')
  if (make) make.onclick = () => { make.disabled = true; send({ type: 'finish' }).catch((e) => { notice = e.message; render(true) }) }
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

// ---------- the timer and the sending bar
async function updateLive() {
  const timer = $('#timer'); if (timer) timer.textContent = mmss(seconds)
  const bar = $('#sendbar')
  if (bar && rec.sessionId) {
    const saved = await store.forSession(rec.sessionId)
    const total = Math.max(1, rec.total || saved.length)
    const sent = saved.filter((c) => c.state === 'sent').length
    bar.style.width = `${Math.round((100 * sent) / total)}%`
    const info = $('#queueinfo')
    if (info) info.textContent = queue.paused === 'login' ? 'Log in again to continue sending.' : queue.fatal ? friendly({ code: queue.fatal }) : queue.retryIn ? `Could not send a part. Trying again in ${queue.retryIn} s.` : rec.phase === 'finishing' ? 'Making your notes ready...' : `${sent} of ${total} sent`
  }
}

render(true)
followWebsiteTheme()
setInterval(followWebsiteTheme, 3000)                                   // the website's theme button works while this panel is open
