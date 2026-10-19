// npm run pack  ->  lecturekit-extension.zip with only what Chrome needs (no tests, no node_modules).
// LK_SERVER=https://your.domain npm run pack   builds the address of your server into the extension (log-in has no server field).
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const out = path.join(root, 'lecturekit-extension.zip')
if (existsSync(out)) rmSync(out)
const files = ['manifest.json', 'background.js', 'offscreen.html', 'offscreen.js', 'sidepanel.html', 'sidepanel.js', 'sidepanel.css', 'css', 'icons', 'lib']
const work = mkdtempSync(path.join(os.tmpdir(), 'lk-pack-'))
for (const f of files) cpSync(path.join(root, f), path.join(work, f), { recursive: true })

const server = (process.env.LK_SERVER || '').trim().replace(/\/+$/, '')
if (server) {
  const origin = new URL(server).origin
  const store = path.join(work, 'lib/store.js')
  writeFileSync(store, readFileSync(store, 'utf8').replace(/export const DEFAULT_SERVER = '[^']*'/, `export const DEFAULT_SERVER = '${origin}'`))
  const manifestFile = path.join(work, 'manifest.json')
  const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'))
  manifest.host_permissions = [`${origin}/*`]
  writeFileSync(manifestFile, JSON.stringify(manifest, null, 2))
  console.log(`server built in: ${origin}`)
}
execFileSync('zip', ['-r', '-q', out, ...files, '-x', '*.DS_Store'], { cwd: work })
rmSync(work, { recursive: true, force: true })
console.log(`wrote ${out}`)
