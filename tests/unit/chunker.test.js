import test from 'node:test'
import assert from 'node:assert/strict'
import { activeChunks, chunkStart, chunkEnd, finalPlan, mmss } from '../../lib/chunker.js'

test('chunk k covers [k*300 - 5, (k+1)*300], the first starts at 0', () => {
  assert.equal(chunkStart(0), 0)
  assert.equal(chunkStart(1), 295)
  assert.equal(chunkStart(2), 595)
  assert.equal(chunkEnd(0), 300)
  assert.equal(chunkEnd(2), 900)
})

test('one recorder most of the time, two around every boundary', () => {
  assert.deepEqual(activeChunks(0), [0])
  assert.deepEqual(activeChunks(100), [0])
  assert.deepEqual(activeChunks(294.9), [0])
  assert.deepEqual(activeChunks(295), [0, 1])
  assert.deepEqual(activeChunks(299.9), [0, 1])
  assert.deepEqual(activeChunks(300), [1])
  assert.deepEqual(activeChunks(595), [1, 2])
  assert.deepEqual(activeChunks(900), [3])
})

test('works with short test chunks too', () => {
  assert.deepEqual(activeChunks(14, 20, 5), [0])
  assert.deepEqual(activeChunks(15, 20, 5), [0, 1])
  assert.deepEqual(activeChunks(20, 20, 5), [1])
})

test('Stop in the middle of a chunk keeps it', () => {
  assert.deepEqual(finalPlan(70, 20, 5), { total: 4, drop: [] })        // chunks 0..3 for a 70 s test lecture
  assert.deepEqual(finalPlan(150), { total: 1, drop: [] })
  assert.deepEqual(finalPlan(1), { total: 1, drop: [] })
})

test('Stop just before a boundary drops the chunk that only repeats the overlap', () => {
  assert.deepEqual(finalPlan(297), { total: 1, drop: [1] })              // chunk 1 started at 295 and has 2 s of its own: drop
  assert.deepEqual(finalPlan(300), { total: 2, drop: [] })               // chunk 1 has exactly 5 s: keep
  assert.deepEqual(finalPlan(304), { total: 2, drop: [] })
})

test('nothing recorded, nothing to send', () => {
  assert.deepEqual(finalPlan(0), { total: 0, drop: [] })
})

test('timer text', () => {
  assert.equal(mmss(0), '0:00')
  assert.equal(mmss(65.9), '1:05')
  assert.equal(mmss(3661), '1:01:01')
})
