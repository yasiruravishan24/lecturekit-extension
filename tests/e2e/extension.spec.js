// Loads the real extension in Chromium and runs a short recording of a made-up stream (the real tab capture needs a
// click on the toolbar icon, which a test cannot do) against a mock server with 10-second parts.
import { test, expect, chromium } from '@playwright/test'
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { startMock } from './mock-server.js'

const root = path.resolve(import.meta.dirname, '../..')

async function launch() {
  const ext = path.join(mkdtempSync(path.join(os.tmpdir(), 'lk-ext-')), 'ext')
  cpSync(root, ext, { recursive: true, filter: (s) => !/node_modules|test-results|\.git|tests|\.zip/.test(s) })
  const manifest = JSON.parse(readFileSync(path.join(ext, 'manifest.json'), 'utf8'))
  manifest.host_permissions.push('http://127.0.0.1/*')                              // the mock server (the real build does not have this)
  writeFileSync(path.join(ext, 'manifest.json'), JSON.stringify(manifest))
  const context = await chromium.launchPersistentContext(mkdtempSync(path.join(os.tmpdir(), 'lk-profile-')), {
    channel: 'chromium', headless: true,
    args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`, '--autoplay-policy=no-user-gesture-required'],
  })
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker')
  return { context, id: new URL(worker.url()).host }
}

async function logIn(page, mock) {
  await page.getByLabel('Email').fill('a@b.c')
  await page.getByLabel('Password').fill('secret')
  await page.locator('summary', { hasText: 'Server' }).click()
  await page.getByLabel('Address').fill(mock.url)
  await page.getByRole('button', { name: 'Log in' }).click()
  await expect(page.getByRole('heading', { name: 'Record a lecture' })).toBeVisible()
}

test('record, pause, stop, send every part (even after failures), finish and open the notes', async () => {
  const mock = await startMock({ failFirstUploads: 2 })
  const { context, id } = await launch()
  const page = await context.newPage()
  await page.goto(`chrome-extension://${id}/sidepanel.html?fake=1&L=10`)
  await logIn(page, mock)

  await page.getByLabel('Session title').fill('Test lecture')
  await page.getByRole('button', { name: 'Start recording' }).click()
  await expect(page.getByText('Recording', { exact: true })).toBeVisible()
  await expect.poll(() => mock.log.opened.length).toBe(1)
  await page.waitForTimeout(6000)
  await page.getByRole('button', { name: 'Pause' }).click()
  await expect(page.getByText('Paused', { exact: true })).toBeVisible()
  await page.waitForTimeout(1500)                                                       // the last tick arrives
  const frozen = await page.locator('#timer').textContent()
  await page.waitForTimeout(3000)
  expect(await page.locator('#timer').textContent()).toBe(frozen)                    // the clock stops while paused
  await page.getByRole('button', { name: 'Resume' }).click()
  await page.waitForTimeout(19500)                                                      // about 25.5 s of recorded time in all
  await page.getByRole('button', { name: 'Stop and process' }).click()
  await expect(page.getByRole('heading', { name: 'Recording stopped' })).toBeVisible({ timeout: 20000 })

  await expect.poll(() => new Set(mock.log.chunks.map((c) => c.index)).size, { timeout: 60000 }).toBe(3)       // 0, 1, 2; the part that only repeats the overlap is dropped
  expect([...new Set(mock.log.chunks.map((c) => c.index))].sort()).toEqual([0, 1, 2])
  expect(mock.log.chunks.every((c) => c.bytes > 1000)).toBe(true)
  expect(mock.log.chunks[0].name).toBe('chunk_00000.webm')
  // every part plays on its own and has about the length the plan says: [0,10], [5,20], [15,25.5] seconds
  const seconds = (f) => { const r = spawnSync('ffmpeg', ['-v', 'error', '-i', f, '-f', 'null', '-', '-progress', 'pipe:1']); return Number(/out_time_us=(\d+)/g.exec(r.stdout.toString().split('\n').filter((l) => l.startsWith('out_time_us')).pop() || 'out_time_us=0')[1]) / 1e6 }
  expect(seconds(mock.log.files[0])).toBeGreaterThan(8)
  expect(seconds(mock.log.files[1])).toBeGreaterThan(12)
  expect(seconds(mock.log.files[1])).toBeLessThan(17)
  expect(seconds(mock.log.files[2])).toBeGreaterThan(8)
  expect(mock.log.uploadTries).toBeGreaterThan(3)                                      // two failures were retried

  await page.getByRole('button', { name: 'Make notes' }).click()
  await expect(page.getByRole('heading', { name: 'Notes are ready' })).toBeVisible({ timeout: 30000 })
  expect(mock.log.finishes).toEqual([{ total: 3, slides: 0 }])
  expect(mock.log.deleted).toEqual([])
  await expect(page.getByRole('link', { name: 'Open notes' })).toHaveAttribute('href', `${mock.url}/sessions/701`)
  await context.close(); mock.close()
})

test('the daily limit at the end keeps the recording for later', async () => {
  const mock = await startMock({ limitAtFinish: true })
  const { context, id } = await launch()
  const page = await context.newPage()
  await page.goto(`chrome-extension://${id}/sidepanel.html?fake=1&L=10`)
  await logIn(page, mock)
  await page.getByRole('button', { name: 'Start recording' }).click()
  await expect(page.getByText('Recording', { exact: true })).toBeVisible()
  await page.waitForTimeout(4000)
  await page.getByRole('button', { name: 'Stop and process' }).click()
  await expect(page.getByRole('heading', { name: 'Recording stopped' })).toBeVisible({ timeout: 20000 })
  await page.getByRole('button', { name: 'Make notes' }).click()
  await expect(page.getByRole('heading', { name: 'Saved for tomorrow' })).toBeVisible({ timeout: 30000 })
  await context.close(); mock.close()
})
