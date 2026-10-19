import test from 'node:test'
import assert from 'node:assert/strict'
import { makeQueue } from '../../lib/queue.js'
import { ApiError } from '../../lib/api.js'

function fakeStore(items) {
  const rows = new Map(items.map((c) => [`${c.sessionId}:${c.index}`, { state: 'pending', name: `c${c.index}.webm`, blob: 'b', ...c }]))
  return {
    rows,
    all: async () => [...rows.values()],
    pending: async () => [...rows.values()].filter((c) => c.state === 'pending').sort((a, b) => a.sessionId - b.sessionId || a.index - b.index),
    put: async (c) => { rows.set(`${c.sessionId}:${c.index}`, c) },
    remove: async (s, i) => { rows.delete(`${s}:${i}`) },
  }
}
const noSleep = () => Promise.resolve()

test('sends the parts in order and marks them sent', async () => {
  const sent = []
  const store = fakeStore([{ sessionId: 1, index: 1 }, { sessionId: 1, index: 0 }, { sessionId: 1, index: 2 }])
  const q = makeQueue({ store, api: { uploadChunk: async (s, i) => { sent.push(i) } }, sleep: noSleep })
  await q.kick()
  assert.deepEqual(sent, [0, 1, 2])
  assert.equal(q.status().pending, 0)
  assert.equal(q.status().sent, 3)
})

test('a failing part is tried again with growing waits, and nothing is lost', async () => {
  const waits = []
  let fail = 3
  const store = fakeStore([{ sessionId: 1, index: 0 }, { sessionId: 1, index: 1 }])
  const q = makeQueue({
    store, sleep: async (s) => { waits.push(s) },
    api: { uploadChunk: async () => { if (fail-- > 0) throw new ApiError(0, 'network', 'down') } },
  })
  await q.kick()
  assert.deepEqual(waits, [2, 5, 15])
  assert.equal(q.status().sent, 2)
})

test('a 401 pauses the queue and keeps every part', async () => {
  const store = fakeStore([{ sessionId: 1, index: 0 }, { sessionId: 1, index: 1 }])
  const q = makeQueue({ store, sleep: noSleep, api: { uploadChunk: async () => { throw new ApiError(401, 'unauthorized', 'no') } } })
  await q.kick()
  assert.equal(q.status().paused, 'login')
  assert.equal(q.status().pending, 2)
})

test('after logging in again the same parts go through', async () => {
  let loggedIn = false
  const store = fakeStore([{ sessionId: 1, index: 0 }])
  const q = makeQueue({ store, sleep: noSleep, api: { uploadChunk: async () => { if (!loggedIn) throw new ApiError(401, 'unauthorized', 'no') } } })
  await q.kick()
  loggedIn = true
  await q.kick()
  assert.equal(q.status().paused, null)
  assert.equal(q.status().sent, 1)
})

test('chunk_limit stops the queue for good', async () => {
  const store = fakeStore([{ sessionId: 1, index: 0 }])
  const q = makeQueue({ store, sleep: noSleep, api: { uploadChunk: async () => { throw new ApiError(429, 'chunk_limit', 'too many') } } })
  await q.kick()
  assert.equal(q.status().fatal, 'chunk_limit')
  assert.equal(q.status().pending, 1)
})

test('a lecture that is gone (404) or already processed (409) is dropped, not retried', async () => {
  const store = fakeStore([{ sessionId: 1, index: 0 }, { sessionId: 2, index: 0 }])
  let calls = 0
  const q = makeQueue({ store, sleep: noSleep, api: { uploadChunk: async (s) => { calls++; throw new ApiError(s === 1 ? 404 : 409, 'x', 'x') } } })
  await q.kick()
  assert.equal(calls, 2)
  assert.equal((await store.all()).length, 0)
})

test('kick while running does not start a second runner', async () => {
  const store = fakeStore([{ sessionId: 1, index: 0 }])
  let active = 0, peak = 0
  const q = makeQueue({ store, sleep: noSleep, api: { uploadChunk: async () => { active++; peak = Math.max(peak, active); await new Promise((r) => setTimeout(r, 20)); active-- } } })
  await Promise.all([q.kick(), q.kick(), q.kick()])
  assert.equal(peak, 1)
})
