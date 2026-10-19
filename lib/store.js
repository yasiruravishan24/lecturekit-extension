// Everything the extension keeps. Settings and the recording state live in chrome.storage.local; the recorded parts
// (big files) live in IndexedDB until the server has them, so a closed browser or a failed upload loses nothing.
const DB = 'lecturekit'

export function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1)
    req.onupgradeneeded = () => {
      const db = req.result
      db.createObjectStore('chunks', { keyPath: ['sessionId', 'index'] })       // { sessionId, index, blob|null, name, state: 'pending'|'sent' }
      db.createObjectStore('slides', { keyPath: 'sessionId' })                  // { sessionId, files: [{ name, blob }] }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

const run = (db, store, mode, fn) => new Promise((resolve, reject) => {
  const tx = db.transaction(store, mode)
  const out = fn(tx.objectStore(store))
  tx.oncomplete = () => resolve(out && 'result' in out ? out.result : undefined)
  tx.onerror = () => reject(tx.error)
})

export function makeChunkStore(dbPromise = openDb()) {
  return {
    async put(rec) { const db = await dbPromise; return run(db, 'chunks', 'readwrite', (s) => s.put(rec)) },
    async get(sessionId, index) { const db = await dbPromise; return run(db, 'chunks', 'readonly', (s) => s.get([sessionId, index])) },
    async remove(sessionId, index) { const db = await dbPromise; return run(db, 'chunks', 'readwrite', (s) => s.delete([sessionId, index])) },
    async all() { const db = await dbPromise; return run(db, 'chunks', 'readonly', (s) => s.getAll()) },
    async forSession(sessionId) { return (await this.all()).filter((c) => c.sessionId === sessionId).sort((a, b) => a.index - b.index) },
    async pending() { return (await this.all()).filter((c) => c.state === 'pending').sort((a, b) => a.sessionId - b.sessionId || a.index - b.index) },
    async clearSession(sessionId) { for (const c of await this.forSession(sessionId)) await this.remove(sessionId, c.index) },
    async putSlides(sessionId, files) { const db = await dbPromise; return run(db, 'slides', 'readwrite', (s) => s.put({ sessionId, files })) },
    async getSlides(sessionId) { const db = await dbPromise; const r = await run(db, 'slides', 'readonly', (s) => s.get(sessionId)); return (r && r.files) || [] },
    async clearSlides(sessionId) { const db = await dbPromise; return run(db, 'slides', 'readwrite', (s) => s.delete(sessionId)) },
  }
}

const area = () => chrome.storage.local
export const getLocal = async (keys) => area().get(keys)
export const setLocal = async (obj) => area().set(obj)
export const removeLocal = async (keys) => area().remove(keys)

export const DEFAULT_SERVER = 'https://localhost:8443'
export async function getSettings() {
  const s = await area().get(['server', 'token', 'expiresAt', 'user', 'lastModule', 'video'])
  return { server: s.server || DEFAULT_SERVER, token: s.token || null, expiresAt: s.expiresAt || null, user: s.user || null, lastModule: s.lastModule || null, video: s.video !== false }
}
export const loggedIn = (s) => !!s.token && (!s.expiresAt || new Date(s.expiresAt) > new Date())
