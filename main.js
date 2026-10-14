const { app, BrowserWindow, Menu, Notification, Tray, ipcMain, nativeImage, net, session, shell } = require('electron')
const { execFile } = require('node:child_process')
const http = require('node:http')
const os = require('node:os')
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const { createPresence } = require('./discord')

const API = 'https://api-v2.soundcloud.com'
// С дефолтным UA (в нём есть «Electron») страница входа SoundCloud и Google
// считают браузер небезопасным и не пускают.
const isWindows = process.platform === 'win32'
const UA = `Mozilla/5.0 (${isWindows ? 'Windows NT 10.0; Win64; x64' : 'X11; Linux x86_64'}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36`

app.userAgentFallback = UA

let win
let quitting = false
let config = {}
let clientId

const configPath = () => path.join(app.getPath('userData'), 'config.json')

function loadConfig() {
  try {
    config = JSON.parse(fs.readFileSync(configPath(), 'utf8'))
  } catch (err) {
    if (err.code !== 'ENOENT') throw err
  }
}

function saveConfig() {
  fs.writeFileSync(configPath(), JSON.stringify(config, null, 2))
}

// Берём ключ публичного веб-клиента SoundCloud, чтобы не регистрировать своё приложение.
// Ключ периодически меняют — тогда API отвечает 401 и мы достаём новый.
async function fetchClientId() {
  const page = await (await net.fetch('https://soundcloud.com/')).text()
  const scripts = [...page.matchAll(/src="(https:\/\/a-v2\.sndcdn\.com\/assets\/[^"]+\.js)"/g)].map(m => m[1])
  for (const src of scripts.reverse()) {
    const match = (await (await net.fetch(src)).text()).match(/client_id:"(\w{32})"/)
    if (match) return match[1]
  }
  throw new Error('Не нашёл client_id на soundcloud.com')
}

function getClientId(refresh) {
  if (refresh || !clientId) {
    clientId = fetchClientId().then(id => {
      config.clientId = id
      saveConfig()
      return id
    }, err => {
      clientId = null
      throw err
    })
  }
  return clientId
}

async function api(target, method = 'GET', body = null, retried = false) {
  const url = new URL(target, API)
  url.searchParams.set('client_id', await getClientId())
  const headers = config.token ? { Authorization: `OAuth ${config.token}` } : {}
  if (body) headers['Content-Type'] = 'application/json'
  // Запись (лайки) SoundCloud закрывает DataDome: без его куки из окна входа ответ — 403 с капчей.
  const fetcher = method === 'GET' ? net : session.fromPartition('persist:soundcloud')
  const res = await fetcher.fetch(url.href, { method, headers, body: body ? JSON.stringify(body) : undefined })
  if (res.status === 401 && !retried) {
    await getClientId(true)
    return api(target, method, body, true)
  }
  if (res.status === 403 && method !== 'GET' && !retried) {
    const captcha = (await res.text()).match(/"url":"([^"]*captcha-delivery[^"]*)"/)?.[1]
    // t=fe — капча, её можно пройти; t=bv — блокировка, окно показало бы только «You have been blocked».
    if (captcha && new URL(captcha).searchParams.get('t') !== 'bv') {
      await solveCaptcha(captcha)
      return api(target, method, body, true)
    }
    throw new Error('SoundCloud сейчас не даёт менять аккаунт с этого компьютера (защита от ботов) — сделай это с телефона, на ПК подтянется само')
  }
  if (!res.ok) throw new Error(`SoundCloud ответил ${res.status}`)
  // Запись тоже может вернуть объект: созданный плейлист нужен со своим id.
  const text = await res.text()
  return text ? JSON.parse(text) : null
}

async function streamSource(track) {
  const usable = track.media.transcodings.filter(t => ['progressive', 'hls'].includes(t.format.protocol))
  const full = usable.filter(t => !t.snipped)
  const pool = full.length ? full : usable
  const coding = pool.find(t => t.format.protocol === 'progressive')
    ?? pool.find(t => t.format.mime_type.startsWith('audio/mp4'))
    ?? pool[0]
  if (!coding) throw new Error('У трека нет доступного потока')

  const url = new URL(coding.url)
  url.searchParams.set('track_authorization', track.track_authorization)
  const { url: src } = await api(url.href)
  return { url: src, hls: coding.format.protocol === 'hls', preview: coding.snipped }
}

function login() {
  const ses = session.fromPartition('persist:soundcloud')
  return new Promise(resolve => {
    const popup = new BrowserWindow({
      width: 480,
      height: 760,
      parent: win,
      modal: true,
      title: 'Вход в SoundCloud',
      autoHideMenuBar: true,
      webPreferences: { session: ses },
    })
    const onCookie = (_event, cookie, _cause, removed) => {
      if (cookie.name !== 'oauth_token' || removed) return
      config.token = cookie.value
      saveConfig()
      popup.close()
    }
    ses.cookies.on('changed', onCookie)
    popup.on('closed', () => {
      ses.cookies.removeListener('changed', onCookie)
      resolve(Boolean(config.token))
    })
    popup.loadURL('https://soundcloud.com/signin')
  })
}

// Для записи (лайк, плейлист) DataDome время от времени требует капчу. Показываем её страницу
// в той же сессии, что и вход: после решения кука datadome обновляется и запрос повторяется.
function solveCaptcha(captchaUrl) {
  const ses = session.fromPartition('persist:soundcloud')
  return new Promise(resolve => {
    const popup = new BrowserWindow({
      width: 460,
      height: 640,
      parent: win,
      modal: true,
      title: 'Проверка SoundCloud',
      autoHideMenuBar: true,
      webPreferences: { session: ses },
    })
    const openedAt = Date.now()
    // Страница капчи может сама поставить куку при загрузке — это ещё не решение.
    const onCookie = (_event, cookie, _cause, removed) => {
      if (cookie.name !== 'datadome' || removed || Date.now() - openedAt < 1500) return
      setTimeout(() => popup.isDestroyed() || popup.close(), 600)
    }
    ses.cookies.on('changed', onCookie)
    popup.on('closed', () => {
      ses.cookies.removeListener('changed', onCookie)
      resolve()
    })
    popup.loadURL(captchaUrl)
  })
}

async function logout() {
  delete config.token
  saveConfig()
  await session.fromPartition('persist:soundcloud').clearStorageData()
}

// Токен уходит в PWA на телефоне по одноразовому коду: вход SoundCloud в Safari
// не перехватить, а вводить токен руками неудобно.
async function pairPhone() {
  if (!config.token) throw new Error('сначала войди в SoundCloud на компьютере')
  // Адрес своего сервера PWA (pwa/server.mjs) — в config.json, ключ pwaUrl.
  const PWA_URL = config.pwaUrl
  if (!PWA_URL) throw new Error('не задан адрес сервера PWA (pwaUrl в config.json)')
  const res = await net.fetch(`${PWA_URL}/api/pair`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: config.token }),
  })
  if (!res.ok) throw new Error(`сервер PWA ответил ${res.status}`)
  const { code } = await res.json()
  return { code, url: new URL(PWA_URL).host }
}

// Синхронизация с телефоном идёт напрямую по Wi-Fi: компьютер держит маленький сервер,
// телефон забирает снимок, сливает со своим и отправляет обратно. Ключ вводится один раз,
// чтобы чужое устройство в той же сети ничего не получило.
const SYNC_PORT = 47821
let syncSnapshot = null

// Первый попавшийся IPv4 бывает мостом libvirt или туннелем VPN — телефону нужен адрес в домашней сети.
function lanAddress() {
  const skip = /^(lo|virbr|docker|br-|veth|tun|tap|wg|tailscale|vEthernet|VirtualBox|VMware|Loopback)/i
  const candidates = Object.entries(os.networkInterfaces())
    .filter(([name]) => !skip.test(name))
    .flatMap(([, addresses]) => addresses)
    .filter(a => a.family === 'IPv4' && !a.internal)
  return (candidates.find(a => /^(192\.168|10\.|172\.(1[6-9]|2\d|3[01]))/.test(a.address)) ?? candidates[0])?.address ?? '127.0.0.1'
}

function syncKey() {
  if (!config.syncKey) {
    config.syncKey = crypto.randomBytes(4).toString('hex')
    saveConfig()
  }
  return config.syncKey
}

// Ключ короткий, поэтому подбор режем: после 20 неверных попыток адрес больше не слушаем.
const syncFailures = new Map()

function startSyncServer() {
  const server = http.createServer((req, res) => {
    const reply = (code, body) => {
      res.writeHead(code, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      })
      res.end(JSON.stringify(body ?? {}))
    }
    if (req.method === 'OPTIONS') return reply(200)
    const from = req.socket.remoteAddress
    if ((syncFailures.get(from) ?? 0) >= 20) return reply(429, { error: 'слишком много неверных ключей' })
    if (req.headers['x-sync-key'] !== syncKey()) {
      syncFailures.set(from, (syncFailures.get(from) ?? 0) + 1)
      return reply(403, { error: 'ключ не подходит' })
    }
    if (req.method === 'GET') return reply(200, syncSnapshot ?? {})
    let body = ''
    req.on('data', chunk => {
      body += chunk
      if (body.length > 5e6) req.destroy()
    })
    req.on('end', () => {
      try {
        const merged = JSON.parse(body)
        win?.webContents.send('sync:apply', merged)
        reply(200, { ok: true })
      } catch (err) {
        reply(400, { error: err.message })
      }
    })
  })
  // Порт занят (вторая копия приложения) — без синхронизации, но не падаем: необработанный
  // 'error' у сервера уронил бы весь main-процесс.
  server.on('error', err => console.error('Синхронизация недоступна:', err.message))
  server.listen(SYNC_PORT)
}

const downloadsDir = () => path.join(app.getPath('userData'), 'downloads')
const downloadPath = id => path.join(downloadsDir(), `${id}.audio`)

async function downloadSave(track, url) {
  fs.mkdirSync(downloadsDir(), { recursive: true })
  const res = await net.fetch(url)
  if (!res.ok) throw new Error(`сервер отдал ${res.status}`)
  fs.writeFileSync(downloadPath(track.id), Buffer.from(await res.arrayBuffer()))
  const meta = { id: track.id, title: track.title, artist: track.user.username, size: fs.statSync(downloadPath(track.id)).size }
  config.downloads ??= {}
  config.downloads[track.id] = meta
  saveConfig()
  return meta
}

function downloadRemove(id) {
  fs.rmSync(downloadPath(id), { force: true })
  delete config.downloads?.[id]
  saveConfig()
}

function downloadGet(id) {
  return config.downloads?.[id] ? pathToFileURL(downloadPath(id)).href : null
}

function saveFile(name, text) {
  fs.writeFileSync(path.join(app.getPath('downloads'), name), text)
  return `Сохранено в Загрузки: ${name}`
}

function createWindow() {
  win = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 900,
    minHeight: 600,
    title: 'Cloudwave',
    // Прозрачность нужна только под размытие Hyprland; на Windows прозрачное окно не
    // растягивается за края и теряет тень, поэтому там обычное окно (фон — .win в style.css).
    transparent: !isWindows,
    backgroundColor: isWindows ? '#16161a' : '#00000000',
    icon: path.join(__dirname, 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  })
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) shell.openExternal(url)
    return { action: 'deny' }
  })
  // Окно закрывается в трей, музыка играет дальше; выход — из меню трея или MPRIS.
  win.on('close', event => {
    if (quitting) return
    event.preventDefault()
    win.hide()
  })
  win.loadFile('index.html')
}

let fullBounds = null

// Hyprland сам раскладывает окна и игнорирует setBounds у плиточного окна, поэтому там
// окно делаем плавающим, меняем размер и закрепляем поверх через hyprctl.
function hyprMiniMode(on) {
  const target = `pid:${process.pid}`
  const commands = on
    ? [`setfloating ${target}`, `resizewindowpixel exact 440 88,${target}`, `pin ${target}`]
    : [`pin ${target}`, `settiled ${target}`]
  execFile('hyprctl', ['--batch', commands.map(command => `dispatch ${command}`).join(' ; ')], err => {
    if (err) console.error('hyprctl:', err.message)
  })
}

function setMiniMode(on) {
  if (process.env.HYPRLAND_INSTANCE_SIGNATURE) {
    win.setMinimumSize(on ? 360 : 900, on ? 88 : 600)
    return hyprMiniMode(on)
  }
  if (on) {
    fullBounds = win.getBounds()
    win.setMinimumSize(360, 88)
    // Размер содержимого, а не окна: на Windows рамка с заголовком съела бы половину 88 пикселей.
    win.setContentBounds({ x: fullBounds.x, y: fullBounds.y, width: 440, height: 88 })
    win.setAlwaysOnTop(true, 'floating')
  } else {
    win.setAlwaysOnTop(false)
    win.setMinimumSize(900, 600)
    if (fullBounds) win.setBounds(fullBounds)
  }
}

function showWindow() {
  win.show()
  win.focus()
}

// Chromium внутри Electron не публикует плеер в MPRIS, поэтому поднимаем сервис сами.
function setupMpris() {
  if (process.platform !== 'linux') return
  const Player = require('mpris-service')
  let playback = { seconds: 0, at: 0, playing: false }
  let mpris
  // Без адреса сессионной шины dbus-next бросает прямо в конструкторе — окно бы так и не открылось.
  try {
    mpris = Player({
      name: 'cloudwave',
      identity: 'Cloudwave',
      desktopEntry: 'cloudwave',
      supportedInterfaces: ['player'],
    })
  } catch (err) {
    return console.error('MPRIS:', err.message)
  }
  // Без D-Bus плеер должен работать дальше, а необработанный 'error' уронил бы main.
  mpris.on('error', err => console.error('MPRIS:', err.message))

  // Позицию клиенты запрашивают когда угодно, а renderer присылает её только на play/pause/seek.
  mpris.getPosition = () => {
    const elapsed = playback.playing ? (Date.now() - playback.at) / 1000 : 0
    return Math.round((playback.seconds + elapsed) * 1e6)
  }

  for (const action of ['play', 'pause', 'playpause', 'stop', 'next', 'previous']) {
    mpris.on(action, () => send(action))
  }
  mpris.on('seek', offset => send('seekBy', Number(offset) / 1e6))
  mpris.on('position', event => send('seekTo', Number(event.position) / 1e6))
  mpris.on('raise', showWindow)
  mpris.on('quit', () => app.quit())

  ipcMain.on('mpris:state', (_event, track) => {
    playback = { seconds: track.position, at: Date.now(), playing: track.playing }
    mpris.metadata = {
      'mpris:trackid': mpris.objectPath(`track/${track.id}`),
      'mpris:length': Math.round(track.length * 1e6),
      'mpris:artUrl': track.artUrl,
      'xesam:title': track.title,
      'xesam:artist': [track.artist],
      'xesam:album': track.album,
      'xesam:url': track.url,
    }
    mpris.playbackStatus = track.playing ? 'Playing' : 'Paused'
    if (track.seeked) mpris.seeked(Math.round(track.position * 1e6))
  })
}

const send = (...args) => win?.webContents.send('media', ...args)

function setupTray() {
  const tray = new Tray(path.join(__dirname, 'tray.png'))
  let shown = {}
  const render = track => {
    const label = track.id ? `${track.title} — ${track.artist}` : 'Cloudwave'
    tray.setToolTip(label)
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: label.length > 60 ? `${label.slice(0, 59)}…` : label, enabled: false },
      { type: 'separator' },
      { label: track.playing ? 'Пауза' : 'Играть', click: () => send('playpause') },
      { label: 'Следующий', click: () => send('next') },
      { label: 'Предыдущий', click: () => send('previous') },
      { type: 'separator' },
      { label: 'Показать окно', click: showWindow },
      { label: 'Выйти', click: () => app.quit() },
    ]))
  }
  render(shown)
  tray.on('click', () => (win.isVisible() ? win.hide() : showWindow()))
  ipcMain.on('mpris:state', (_event, track) => {
    if (track.id === shown.id && track.playing === shown.playing) return
    shown = track
    render(track)
  })
}

// Уведомление только когда окно не в фокусе: иначе трек и так на экране.
function setupNotifications() {
  let lastId
  ipcMain.on('mpris:state', async (_event, track) => {
    if (!track.playing || track.id === lastId) return
    lastId = track.id
    if (win.isFocused()) return
    const art = track.artUrl
      ? await net.fetch(track.artUrl).then(res => res.arrayBuffer()).then(buf => nativeImage.createFromBuffer(Buffer.from(buf)), () => undefined)
      : undefined
    const note = new Notification({ title: track.title, body: track.artist, icon: art, silent: true })
    note.on('click', showWindow)
    note.show()
  })
}

// Discord требует от 2 до 128 символов в каждой строке статуса.
const clip = text => text.padEnd(2).slice(0, 128)

let presence = null

function setDiscordId(id) {
  presence?.set(null)
  presence = id ? createPresence(id) : null
}

function setupDiscord() {
  setDiscordId(config.discordClientId)
  ipcMain.on('mpris:state', (_event, track) => {
    if (!presence) return
    if (!track.playing) return presence.set(null)
    const start = Math.round(Date.now() - track.position * 1000)
    presence.set({
      type: 2,
      details: clip(track.title),
      state: clip(track.artist),
      timestamps: { start, end: Math.round(start + track.length * 1000) },
      assets: track.artUrl ? { large_image: track.artUrl, large_text: clip(track.album || track.title) } : undefined,
      // Кнопку видят другие, а сам владелец статуса — нет: так устроен Discord.
      buttons: [{ label: 'Слушать в SoundCloud', url: track.url }],
    })
  })
}

ipcMain.handle('sc:api', (_event, target, method, body) => api(target, method, body))
ipcMain.handle('sc:stream', (_event, track) => streamSource(track))
ipcMain.handle('sc:session', () => ({ loggedIn: Boolean(config.token) }))
ipcMain.handle('sc:login', login)
ipcMain.handle('sc:logout', logout)
ipcMain.handle('sc:pairPhone', pairPhone)
ipcMain.handle('sc:downloadSave', (_event, track, url) => downloadSave(track, url))
ipcMain.handle('sc:downloadList', () => Object.values(config.downloads ?? {}))
ipcMain.handle('sc:downloadRemove', (_event, id) => downloadRemove(id))
ipcMain.handle('sc:downloadGet', (_event, id) => downloadGet(id))
ipcMain.handle('sc:saveFile', (_event, name, text) => saveFile(name, text))
ipcMain.handle('sc:syncInfo', () => ({ address: `${lanAddress()}:${SYNC_PORT}`, key: syncKey() }))
ipcMain.on('sync:publish', (_event, snapshot) => {
  syncSnapshot = snapshot
})
ipcMain.handle('sc:miniMode', (_event, on) => setMiniMode(on))
ipcMain.handle('sc:discordId', () => config.discordClientId ?? '')
ipcMain.handle('sc:setDiscordId', (_event, id) => {
  config.discordClientId = id
  saveConfig()
  setDiscordId(id)
})

// Вторая копия заняла бы порт синхронизации и завела второй значок в трее — вместо неё показываем окно.
if (!app.requestSingleInstanceLock()) app.exit()
app.on('second-instance', () => win && showWindow())

// Без AppUserModelId Windows не показывает уведомления.
if (isWindows) app.setAppUserModelId('com.cloudwave.app')

app.whenReady().then(() => {
  loadConfig()
  if (config.clientId) clientId = Promise.resolve(config.clientId)
  startSyncServer()
  setupMpris()
  setupTray()
  setupNotifications()
  setupDiscord()
  createWindow()
})

app.on('before-quit', () => {
  quitting = true
})

app.on('window-all-closed', () => app.quit())
