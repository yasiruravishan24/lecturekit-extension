// The chunk schedule (WEB_AND_EXTENSION_PLAN.md 5.4). Pure functions, so they can be tested without a browser.
// Chunk k is a complete audio/video file that covers lecture time [max(0, k*L - overlap), (k+1)*L].
// Time here is RECORDED time: a pause stops the clock, so a pause never leaves a gap in the timeline.

export const DEFAULT_CHUNK_SECONDS = 300
export const DEFAULT_OVERLAP = 5

export const chunkStart = (k, L = DEFAULT_CHUNK_SECONDS, overlap = DEFAULT_OVERLAP) => Math.max(0, k * L - overlap)
export const chunkEnd = (k, L = DEFAULT_CHUNK_SECONDS) => (k + 1) * L

// The chunks whose recorder must be running at recorded time t. Two of them around every boundary (the overlap).
export function activeChunks(t, L = DEFAULT_CHUNK_SECONDS, overlap = DEFAULT_OVERLAP) {
  const base = Math.floor(t / L)
  const out = []
  for (const k of [base, base + 1]) {
    if (k >= 0 && chunkStart(k, L, overlap) <= t && t < chunkEnd(k, L)) out.push(k)
  }
  return out
}

// What to keep when the person presses Stop after T recorded seconds.
// A newest chunk with less than `overlap` seconds of its own sound only repeats the end of the one before it: drop it.
export function finalPlan(T, L = DEFAULT_CHUNK_SECONDS, overlap = DEFAULT_OVERLAP) {
  if (!(T > 0)) return { total: 0, drop: [] }
  let last = 0
  while (chunkStart(last + 1, L, overlap) <= T) last += 1
  if (last >= 1 && T - chunkStart(last, L, overlap) < overlap) return { total: last, drop: [last] }
  return { total: last + 1, drop: [] }
}

export const mmss = (seconds) => {
  const s = Math.max(0, Math.floor(seconds))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const r = String(s % 60).padStart(2, '0')
  return h ? `${h}:${String(m).padStart(2, '0')}:${r}` : `${m}:${r}`
}
