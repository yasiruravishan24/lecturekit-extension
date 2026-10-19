// Owns the tab's stream and the recorders, so that closing the side panel does not stop a lecture.
// One MediaRecorder per chunk: a recorder cut into parts would give pieces that cannot be played alone (see chunker.js).
import { activeChunks, finalPlan } from './lib/chunker.js'
import { makeChunkStore } from './lib/store.js'

const store = makeChunkStore()
let rec = null

const say = (msg) => chrome.runtime.sendMessage({ source: 'offscreen', ...msg }).catch(() => {})

// A timer that is not slowed down while this page is hidden: a Worker.
function makeTicker(ms, fn) {
  const code = `setInterval(() => postMessage(0), ${ms})`
  const worker = new Worker(URL.createObjectURL(new Blob([code], { type: 'text/javascript' })))
  worker.onmessage = fn
  return worker
}

function fakeStream(video) {
  const ctx = new AudioContext()
  const dest = ctx.createMediaStreamDestination()
  const osc = ctx.createOscillator()
  osc.frequency.value = 220
  const gain = ctx.createGain()
  gain.gain.value = 0.02
  osc.connect(gain).connect(dest)
  osc.start()
  const tracks = [...dest.stream.getAudioTracks()]
  if (video) {
    const canvas = Object.assign(document.createElement('canvas'), { width: 640, height: 360 })
    const g = canvas.getContext('2d')
    let n = 0
    setInterval(() => { g.fillStyle = '#fff'; g.fillRect(0, 0, 640, 360); g.fillStyle = '#000'; g.font = '40px sans-serif'; g.fillText(`test frame ${n++}`, 40, 180) }, 100)
    tracks.push(...canvas.captureStream(10).getVideoTracks())
  }
  return new MediaStream(tracks)
}

async function start(m) {
  let stream
  if (m.fake) {
    stream = fakeStream(m.video)
  } else {
    const tab = { chromeMediaSource: 'tab', chromeMediaSourceId: m.streamId }
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { mandatory: tab },
      video: m.video ? { mandatory: { ...tab, maxWidth: 1280, maxHeight: 720, maxFrameRate: 10 } } : false,
    })
  }
  let ctx = null
  if (!m.fake && stream.getAudioTracks().length) {                       // tab capture mutes the tab: play it again so the person can still hear it
    ctx = new AudioContext()
    ctx.createMediaStreamSource(new MediaStream(stream.getAudioTracks())).connect(ctx.destination)
  }
  const hasVideo = stream.getVideoTracks().length > 0
  const mime = hasVideo && MediaRecorder.isTypeSupported('video/webm;codecs=vp8,opus') ? 'video/webm;codecs=vp8,opus' : 'audio/webm;codecs=opus'
  rec = { stream, ctx, mime, hasVideo, sessionId: m.sessionId, L: m.L, overlap: m.overlap, t: 0, last: performance.now(), paused: false,
          recorders: new Map(), started: new Set(), saving: [], stopping: false, tick: 0 }
  rec.worker = makeTicker(250, onTick)
  onTick()
}

function startRecorder(k) {
  const source = rec.mime.startsWith('video') ? rec.stream : new MediaStream(rec.stream.getAudioTracks())
  const mr = new MediaRecorder(source, { mimeType: rec.mime, audioBitsPerSecond: 64000, videoBitsPerSecond: 600000 })
  const parts = []
  mr.ondataavailable = (e) => { if (e.data && e.data.size) parts.push(e.data) }
  const saved = new Promise((resolve) => {
    mr.onstop = async () => {
      const blob = new Blob(parts, { type: rec.mime.split(';')[0] })
      await store.put({ sessionId: rec.sessionId, index: k, blob, name: `chunk_${String(k).padStart(5, '0')}.webm`, state: 'pending' })
      say({ type: 'chunk-saved', index: k })
      resolve()
    }
  })
  rec.saving.push(saved)
  mr.start(1000)
  if (rec.paused) mr.pause()
  rec.recorders.set(k, mr)
  rec.started.add(k)
}

function stopRecorder(k) {
  const mr = rec.recorders.get(k)
  if (mr && mr.state !== 'inactive') mr.stop()
  rec.recorders.delete(k)
}

function onTick() {
  if (!rec || rec.stopping) return
  const now = performance.now()
  if (!rec.paused) rec.t += (now - rec.last) / 1000
  rec.last = now
  const want = new Set(activeChunks(rec.t, rec.L, rec.overlap))
  for (const k of want) if (!rec.started.has(k)) startRecorder(k)
  for (const k of [...rec.recorders.keys()]) if (!want.has(k)) stopRecorder(k)
  rec.tick += 1
  if (rec.tick % 4 === 0) say({ type: 'tick', t: rec.t, running: [...rec.recorders.keys()], paused: rec.paused })
}

function pause() {
  if (!rec || rec.paused) return
  onTick()
  rec.paused = true
  for (const mr of rec.recorders.values()) if (mr.state === 'recording') mr.pause()
}

function resume() {
  if (!rec || !rec.paused) return
  rec.paused = false
  rec.last = performance.now()
  for (const mr of rec.recorders.values()) if (mr.state === 'paused') mr.resume()
}

async function stop() {
  if (!rec) return say({ type: 'stopped', total: 0, seconds: 0 })
  onTick()
  rec.stopping = true
  const T = rec.t
  rec.worker.terminate()
  for (const k of [...rec.recorders.keys()]) stopRecorder(k)
  await Promise.all(rec.saving)
  const plan = finalPlan(T, rec.L, rec.overlap)
  for (const k of plan.drop) await store.remove(rec.sessionId, k)
  rec.stream.getTracks().forEach((t) => t.stop())
  if (rec.ctx) rec.ctx.close().catch(() => {})
  const sessionId = rec.sessionId
  rec = null
  say({ type: 'stopped', total: plan.total, seconds: T, sessionId })
}

chrome.runtime.onMessage.addListener((m, _sender, respond) => {
  if (m.target !== 'offscreen') return
  const done = (p) => p.then(() => respond({ ok: true }), (e) => respond({ ok: false, error: String(e && e.message || e) }))
  if (m.type === 'start') done(start(m))
  else if (m.type === 'pause') { pause(); respond({ ok: true }) }
  else if (m.type === 'resume') { resume(); respond({ ok: true }) }
  else if (m.type === 'stop') done(stop())
  else if (m.type === 'ping') respond({ ok: true, recording: !!rec, t: rec ? rec.t : 0 })
  return true
})
