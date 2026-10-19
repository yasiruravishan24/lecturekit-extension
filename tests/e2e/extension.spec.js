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
  await page.evaluate((u) => chrome.storage.local.set({ server: u }), mock.url)          // a build of the extension has its server built in
  await page.reload()
  await page.getByLabel('Email').fill('a@b.c')
  await page.getByLabel('Password').fill('secret')
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
  await page.locator('#slides').setInputFiles({ name: 'slides.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 test') })      // slides are asked for before the recording
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

  await expect(page.getByRole('heading', { name: 'Notes are ready' })).toBeVisible({ timeout: 60000 })      // nothing more to press after Stop
  expect(mock.log.finishes).toEqual([{ total: 3, slides: 1 }])
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
  await expect(page.getByRole('heading', { name: 'Saved for tomorrow' })).toBeVisible({ timeout: 60000 })
  await context.close(); mock.close()
})


test('already logged in on the website: one click to use the same login', async () => {
  const mock = await startMock()
  const { context, id } = await launch()
  const web = await context.newPage()
  await web.goto(`${mock.url}/web`)
  await web.evaluate(() => { localStorage.setItem('lk_token', 'tok'); localStorage.setItem('lk_expires', new Date(Date.now() + 864e5).toISOString()) })
  const page = await context.newPage()
  await page.goto(`chrome-extension://${id}/sidepanel.html?fake=1&L=10`)
  await page.evaluate(([url]) => chrome.storage.local.set({ server: url }), [mock.url])
  await page.reload()
  await expect(page.getByRole('button', { name: 'Continue as A B' })).toBeVisible()
  await expect(page.getByLabel('Email')).toHaveCount(0)                                            // no log-in form while that choice is offered
  await page.getByRole('button', { name: 'Use a different account' }).click()
  await expect(page.getByLabel('Email')).toBeVisible()
  await expect(page.getByRole('link', { name: 'Create an account' })).toHaveAttribute('href', `${mock.url}/register`)
  await expect(page.getByRole('button', { name: /Continue with Google/ })).toBeDisabled()          // not set up on this server
  await page.getByRole('button', { name: 'Back' }).click()
  await page.getByRole('button', { name: 'Continue as A B' }).click()
  await expect(page.getByRole('heading', { name: 'Record a lecture' })).toBeVisible()
  await expect(page.locator('#avatar')).toHaveText('AB')                                           // the round profile button
  await page.getByRole('button', { name: 'Account menu' }).click()
  await expect(page.locator('#acct-name')).toHaveText('A B')
  await page.getByRole('menuitem', { name: 'Log out' }).click()
  await expect(page.getByLabel('Email')).toBeVisible()                                             // logging out shows the log-in form
  await context.close(); mock.close()
})

test('the panel uses the same theme as the website, and follows it when it changes', async () => {
  const mock = await startMock()
  const { context, id } = await launch()
  const web = await context.newPage()
  await web.goto(`${mock.url}/web`)
  await web.evaluate(() => localStorage.setItem('lk_theme', 'light'))
  const page = await context.newPage()
  await page.goto(`chrome-extension://${id}/sidepanel.html?fake=1&L=10`)
  await page.evaluate((u) => chrome.storage.local.set({ server: u }), mock.url)
  await page.reload()
  const bg = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor)
  await expect.poll(bg, { timeout: 8000 }).toBe('rgb(244, 246, 250)')                               // light, as on the website
  await web.evaluate(() => localStorage.setItem('lk_theme', 'dark'))                                  // the person switches the website to dark
  await expect.poll(bg, { timeout: 10000 }).toBe('rgb(15, 22, 35)')                                  // the panel follows, without a reload
  await page.reload()                                                                                 // remembered right away, before the website tab is read
  await expect.poll(bg, { timeout: 3000 }).toBe('rgb(15, 22, 35)')
  await context.close(); mock.close()
})
