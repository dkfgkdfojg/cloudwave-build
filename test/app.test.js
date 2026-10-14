const { test, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { execFile } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { fileURLToPath } = require('node:url')
const { _electron: electron } = require('playwright-core')
const electronPath = require('electron')

// Запускаем настоящее приложение с отдельной папкой данных, чтобы не трогать свой конфиг.
const root = path.join(__dirname, '..')
const SYNC = 'http://127.0.0.1:47821'
const SYNC_KEY = 'test-key'
const TRACK_ID = 42

// Под root (контейнер) и на Ubuntu 24.04 в CI, где AppArmor запрещает песочнице user namespaces,
// Chromium без этого флага не стартует.
const sandbox = process.platform === 'linux' && (process.getuid?.() === 0 || process.env.CI) ? ['--no-sandbox'] : []

let dir
let app
let page

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cloudwave-app-'))
  fs.mkdirSync(path.join(dir, 'downloads'))
  fs.writeFileSync(path.join(dir, 'downloads', `${TRACK_ID}.audio`), 'не звук, но файл')
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
    syncKey: SYNC_KEY,
    downloads: { [TRACK_ID]: { id: TRACK_ID, title: 'Трек', artist: 'Автор', size: 1 } },
  }))
  app = await electron.launch({ executablePath: electronPath, args: [root, `--user-data-dir=${dir}`, ...sandbox], cwd: root })
  page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
})

after(async () => {
  if (app) {
    const closed = new Promise(resolve => app.once('close', resolve))
    // Крестик прячет окно в трей, поэтому выходим как из меню трея.
    await app.evaluate(({ app }) => app.quit()).catch(() => {})
    await closed
  }
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
})

test('приложение берёт данные из выданной папки', async () => {
  const userData = await app.evaluate(({ app }) => app.getPath('userData'))
  assert.equal(fs.realpathSync(userData), fs.realpathSync(dir))
})

test('окно открывается с интерфейсом', async () => {
  assert.equal(await page.title(), 'Cloudwave')
  assert.ok(await page.locator('#play').count())
  assert.ok(await page.locator('#search-input').count())
})

test('мост sc на месте и знает платформу', async () => {
  const bridge = await page.evaluate(() => ({
    platform: window.sc.platform,
    methods: ['api', 'stream', 'session', 'login', 'logout', 'saveFile', 'miniMode', 'mpris', 'onMedia'].filter(name => typeof window.sc[name] !== 'function'),
    win: document.documentElement.classList.contains('win'),
  }))
  assert.equal(bridge.platform, process.platform)
  assert.deepEqual(bridge.methods, [])
  assert.equal(bridge.win, process.platform === 'win32')
})

test('на Windows окно непрозрачное', { skip: process.platform !== 'win32' }, async () => {
  const background = await page.evaluate(() => getComputedStyle(document.body).backgroundColor)
  const alpha = /\/\s*([\d.]+)\)$/.exec(background)?.[1]
  assert.ok(alpha === undefined || Number(alpha) === 1, background)
})

test('без входа приложение не считает себя залогиненным', async () => {
  assert.deepEqual(await page.evaluate(() => window.sc.session()), { loggedIn: false })
})

test('скачанный трек отдаётся корректной file://-ссылкой', async () => {
  const href = await page.evaluate(id => window.sc.downloads.get(id), TRACK_ID)
  assert.match(href, /^file:\/\/\//)
  assert.equal(fs.realpathSync(fileURLToPath(href)), fs.realpathSync(path.join(dir, 'downloads', `${TRACK_ID}.audio`)))
  assert.equal(await page.evaluate(() => window.sc.downloads.get(999)), null)
})

test('список загрузок читается из конфига', async () => {
  const list = await page.evaluate(() => window.sc.downloads.list())
  assert.deepEqual(list.map(item => item.id), [TRACK_ID])
})

test('сервер синхронизации пускает только с ключом', async () => {
  const info = await page.evaluate(() => window.sc.sync.info())
  assert.equal(info.key, SYNC_KEY)
  assert.match(info.address, /^\d+\.\d+\.\d+\.\d+:47821$/)

  assert.equal((await fetch(SYNC, { headers: { 'x-sync-key': 'wrong' } })).status, 403)

  await page.evaluate(() => window.sc.sync.publish({ history: ['проверка'] }))
  const res = await fetch(SYNC, { headers: { 'x-sync-key': SYNC_KEY } })
  assert.equal(res.status, 200)
  assert.deepEqual(await res.json(), { history: ['проверка'] })
})

test('вторая копия не запускается, а показывает первую', { timeout: 30000 }, async () => {
  const started = Date.now()
  await new Promise((resolve, reject) => {
    execFile(electronPath, [root, `--user-data-dir=${dir}`, ...sandbox], { timeout: 20000 }, err => (err ? reject(err) : resolve()))
  })
  assert.ok(Date.now() - started < 20000)
  assert.ok(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()))
})
