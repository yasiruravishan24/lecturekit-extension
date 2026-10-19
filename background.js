// The service worker: starts and stops the recorder, keeps the recording state, and sends the parts to the server.
// It can be shut down by Chrome at any time, so everything it needs is in chrome.storage / IndexedDB.
import { makeApi, ApiError, friendly } from './lib/api.js'
import { makeChunkStore, getSettings, setLocal, getLocal, loggedIn } from './lib/store.js'
import { makeQueue } from './lib/queue.js'

const store = makeChunkStore()
const api = makeApi({ get: getSettings, onUnauthorized: () => setLocal({ token: null }) })
const queue = makeQueue({ store, api, onChange: (q) => setLocal({ queue: q }) })

chrome.runtime.onInstalled.addListener(() => chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {}))
chrome.runtime.onStartup.addListener(() => { queue.kick() })
chrome.alarms.create('drain', { periodInMinutes: 1 })
chrome.alarms.onAlarm.addListener((a) => { if (a.name === 'drain') queue.kick() })
queue.kick()

const getRec = async () => (await getLocal('rec')).rec || { phase: 'idle' }
const setRec = async (patch) => { const rec = { ...(await getRec()), ...patch }; await setLocal({ rec }); return rec }
const resetRec = () => setLocal({ rec: { phase: 'idle' } })

async function offscreenAlive() {
  const ctxs = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] })
  return ctxs.length > 0
}
async function ensureOffscreen() {
  if (await offscreenAlive()) return
  await chrome.offscreen.createDocument({ url: 'offscreen.html', reasons: ['USER_MEDIA'], justification: 'Record the sound and picture of the lecture tab' })
}
const toOffscreen = (msg) => chrome.runtime.sendMessage({ target: 'offscreen', ...msg })

async function start(p) {
  const s = await getSettings()
  if (!loggedIn(s)) throw new ApiError(401, 'unauthorized', 'Log in first.')
  const cur = await getRec()
  if (['recording', 'paused'].includes(cur.phase)) throw new Error('A recording is already running.')
  let streamId = null
  if (!p.fake) {
    try { streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: p.tabId }) }
    catch (e) { throw new Error('This tab cannot be recorded. Open the lecture tab, click the Lecture Assistant icon on it, and press Start again. (Chrome pages cannot be recorded.)') }
  }
  const session = await api.createSession(p.moduleId, p.title)
  try {
    const live = await api.openLive(session.id)
    await ensureOffscreen()
    const L = (p.fake && p.chunkSeconds) || live.chunk_seconds
    const r = await toOffscreen({ type: 'start', streamId, sessionId: session.id, video: !!p.video, L, overlap: live.overlap, fake: !!p.fake })
    if (!r || !r.ok) throw new Error((r && r.error) || 'The recorder did not start.')
    await setRec({ phase: 'recording', sessionId: session.id, moduleId: p.moduleId, title: p.title, video: !!p.video, chunkSeconds: L, overlap: live.overlap, seconds: 0, total: null, jobId: null, error: null, startedAt: Date.now() })
  } catch (e) {
    api.deleteSession(session.id).catch(() => {})                  // do not leave an empty lecture behind
    throw e
  }
}

async function stop() {
  const r = await toOffscreen({ type: 'stop' })
  if (r && r.ok === false) throw new Error(r.error)
}

// the panel was closed or the browser restarted while recording and the recorder is gone: finish what is saved
async function recover() {
  const rec = await getRec()
  const saved = await store.forSession(rec.sessionId)
  await setRec({ phase: 'stopped', total: saved.length })
  queue.kick()
}

async function finish() {
  const rec = await getRec()
  if (!['stopped', 'failed'].includes(rec.phase) || !rec.total) throw new Error('Nothing to finish.')
  await setRec({ phase: 'finishing', error: null })
  try {
    for (let guard = 0; guard < 4; guard++) {                      // 1. all parts on the server
      queue.kick()
      for (;;) {
        const q = await queue.refresh()
        if (q.paused || q.fatal) throw new ApiError(q.paused ? 401 : 429, q.paused || q.fatal, q.paused ? 'Log in again to continue sending.' : friendly({ code: q.fatal }))
        if (!q.pending && !queue.isRunning()) break
        await new Promise((r) => setTimeout(r, 700))
      }
      const status = await api.liveStatus(rec.sessionId, rec.total)       // 2. does the server agree?
      if (!status.missing.length) break
      for (const k of status.missing) {                                    // send those again
        const c = await store.get(rec.sessionId, k)
        if (c && c.blob) await store.put({ ...c, state: 'pending' })
      }
      if (guard === 3) throw new Error(`Part ${status.missing[0] + 1} did not arrive. Try again.`)
    }
    const slides = await store.getSlides(rec.sessionId)
    try {
      const { job_id } = await api.finish(rec.sessionId, rec.total, slides)
      await setRec({ phase: 'processing', jobId: job_id })
    } catch (e) {
      if (e.code !== 'daily_limit') throw e
      await setRec({ phase: 'limit', error: friendly(e) })
    }
    await store.clearSession(rec.sessionId)                                // the server has everything
    await store.clearSlides(rec.sessionId)
  } catch (e) {
    await setRec({ phase: 'stopped', error: friendly(e) })
  }
}

chrome.runtime.onMessage.addListener((m, _sender, respond) => {
  if (m.target === 'offscreen') return
  const done = (p) => { p.then((v) => respond({ ok: true, value: v }), (e) => respond({ ok: false, error: friendly(e) })); return true }
  if (m.source === 'offscreen') {
    if (m.type === 'tick') setRec({ seconds: m.t })
    else if (m.type === 'chunk-saved') queue.kick()
    else if (m.type === 'stopped') {
      setRec({ phase: m.total ? 'stopped' : 'idle', total: m.total, seconds: m.seconds }).then(() => {
        queue.kick()
        chrome.offscreen.closeDocument().catch(() => {})
      })
    }
    return
  }
  switch (m.type) {
    case 'start': return done(start(m))
    case 'pause': return done(toOffscreen({ type: 'pause' }).then(() => setRec({ phase: 'paused' })))
    case 'resume': return done(toOffscreen({ type: 'resume' }).then(() => setRec({ phase: 'recording' })))
    case 'stop': return done(stop())
    case 'recover': return done(recover())
    case 'finish': return done(finish())
    case 'kick': return done(Promise.resolve(queue.kick()))
    case 'reset': return done(resetRec())
    case 'alive': return done(offscreenAlive())
    default:
  }
})
