// The server calls the extension needs. Same routes and error shape as the web app (lecturekit-web/src/api).
export class ApiError extends Error {
  constructor(status, code, message) {
    super(message)
    this.status = status
    this.code = code
  }
}

const FRIENDLY = {
  daily_limit: "You have reached today's limit. The recording stays saved; press \"Finish and make notes\" on the website tomorrow.",
  email_not_verified: 'Confirm your email first: open the website and enter the code we emailed you.',
  invalid_credentials: 'Wrong email or password.',
  terms_required: 'This Google account has no Lecture Assistant account yet. Sign up on the website once (it asks you to accept the terms), then come back.',
  google_disabled: 'Google sign-in is not set up on this server.',
  chunk_limit: 'This recording is too long (the server accepts about 16 hours).',
  storage_full: 'Your storage is full. Delete lectures on the website to free space.',
}
export const friendly = (e) => (e && (FRIENDLY[e.code] || e.message)) || 'Something went wrong. Try again.'

// settings: { server: 'https://host', token } read by `get()` each time, so a login in another place is picked up at once.
export function makeApi({ get, onUnauthorized = () => {}, fetchImpl = (...a) => fetch(...a) }) {
  async function request(method, path, { json, form, query, signal } = {}) {
    const { server, token } = await get()
    const url = new URL(`${server.replace(/\/+$/, '')}/api${path}`)
    for (const [k, v] of Object.entries(query || {})) if (v != null) url.searchParams.set(k, v)
    const headers = {}
    if (token) headers.Authorization = `Bearer ${token}`
    if (json) headers['Content-Type'] = 'application/json'
    let res
    try {
      res = await fetchImpl(url.toString(), { method, headers, body: json ? JSON.stringify(json) : form, signal })
    } catch (e) {
      throw new ApiError(0, 'network', 'The server cannot be reached. Check your connection.')
    }
    const text = await res.text()
    let body = null
    try { body = text ? JSON.parse(text) : null } catch { /* not JSON */ }
    if (!res.ok) {
      const err = (body && body.error) || {}
      if (res.status === 401) onUnauthorized()
      throw new ApiError(res.status, err.code || (res.status === 401 ? 'unauthorized' : 'error'), err.message || `Request failed (${res.status})`)
    }
    return body
  }
  return {
    request,
    login: (email, password) => request('POST', '/auth/login', { json: { email, password } }),
    config: () => request('GET', '/auth/config'),
    google: (idToken) => request('POST', '/auth/google', { json: { id_token: idToken, accept_terms: false } }),
    me: () => request('GET', '/auth/me'),
    courses: () => request('GET', '/courses'),
    modules: (courseId) => request('GET', `/courses/${courseId}/modules`),
    createSession: (moduleId, title) => request('POST', `/modules/${moduleId}/sessions`, { json: { title } }),
    getSession: (id) => request('GET', `/sessions/${id}`),
    openLive: (id) => request('POST', `/sessions/${id}/live`),
    uploadChunk: (id, index, blob, name) => {
      const form = new FormData()
      form.append('chunk', blob, name)
      return request('POST', `/sessions/${id}/live/chunks`, { query: { index }, form })
    },
    liveStatus: (id, total) => request('GET', `/sessions/${id}/live`, { query: { total } }),
    finish: (id, total, slides = []) => {
      const form = new FormData()
      for (const s of slides) form.append('slides', s.blob, s.name)
      return request('POST', `/sessions/${id}/live/finish`, { query: { total }, form })
    },
    job: (id) => request('GET', `/jobs/${id}`),
    retry: (id) => request('POST', `/sessions/${id}/retry`),
    cancel: (id) => request('POST', `/sessions/${id}/cancel`, { query: { kind: 'main' } }),      // stop making the notes: the lecture and its recording are deleted
    deleteSession: (id) => request('DELETE', `/sessions/${id}`),
  }
}
