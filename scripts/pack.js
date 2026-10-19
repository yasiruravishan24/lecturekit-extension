// npm run pack  ->  lecturekit-extension.zip with only what Chrome needs (no tests, no node_modules).
import { execFileSync } from 'node:child_process'
import { existsSync, rmSync } from 'node:fs'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const out = path.join(root, 'lecturekit-extension.zip')
if (existsSync(out)) rmSync(out)
const files = ['manifest.json', 'background.js', 'offscreen.html', 'offscreen.js', 'sidepanel.html', 'sidepanel.js', 'sidepanel.css', 'css', 'icons', 'lib']
execFileSync('zip', ['-r', '-q', out, ...files, '-x', '*.DS_Store'], { cwd: root })
console.log(`wrote ${out}`)
