// The upload queue: one part at a time, in order. A part stays in IndexedDB until the server has accepted it.
// Waits between tries: 2, 5, 15, 30, 60 s, then every 60 s. A 401 pauses the queue (the parts stay stored).
export const WAITS = [2, 5, 15, 30, 60]

export function makeQueue({ store, api, onChange = () => {}, sleep = (s) => new Promise((r) => setTimeout(r, s * 1000)), waits = WAITS }) {
  let running = false
  let again = false
  const status = { pending: 0, sent: 0, paused: null, fatal: null, retryIn: 0 }
  const emit = () => onChange({ ...status })

  async function count() {
    const all = await store.all()
    status.pending = all.filter((c) => c.state === 'pending').length
    status.sent = all.filter((c) => c.state === 'sent').length
  }

  async function runOnce() {
    for (;;) {
      const [next] = await store.pending()
      await count()
      emit()
      if (!next) return
      let attempt = 0
      for (;;) {
        try {
          await api.uploadChunk(next.sessionId, next.index, next.blob, next.name)
          await store.put({ ...next, state: 'sent' })              // the file stays until the lecture is finished, in case the server asks for it again
          status.paused = null
          status.fatal = null
          break
        } catch (e) {
          if (e.status === 401) { status.paused = 'login'; status.retryIn = 0; await count(); emit(); return }
          if (e.code === 'chunk_limit' || e.code === 'storage_full') { status.fatal = e.code; await count(); emit(); return }
          if (e.status === 409 || e.status === 404) {                      // the lecture is gone or already being processed: nothing to send
            await store.remove(next.sessionId, next.index)
            break
          }
          const wait = waits[Math.min(attempt, waits.length - 1)]
          attempt += 1
          status.retryIn = wait
          emit()
          await sleep(wait)
          status.retryIn = 0
        }
      }
    }
  }

  // Start (or nudge) the queue. Safe to call as often as you like.
  async function kick() {
    if (running) { again = true; return }
    running = true
    try {
      do { again = false; await runOnce() } while (again && !status.paused && !status.fatal)
    } finally {
      running = false
      await count()
      emit()
    }
  }

  return { kick, status: () => ({ ...status }), isRunning: () => running, refresh: async () => { await count(); emit(); return { ...status } } }
}
