// iOS-замена preload.js и main.js: тот же window.sc, но запросы идут через нативный
// CapacitorHttp (у WKWebView свой origin, и api-v2 без CORS его бы не пустил).
//
// На устройстве нет консоли, и без диагностики поломка нативного моста выглядит как
// «Can't find variable: sc» в первом же месте, где вызывается sc.* — сам сбой пропадает.
// Поэтому при ошибке здесь window.sc всё равно ставится, но каждый метод кидает исходную причину.
let CapacitorHttp, SoundCloudLogin, NowPlaying, ChunkLoader, bridgeError
try {
  CapacitorHttp = Capacitor.Plugins.CapacitorHttp
  SoundCloudLogin = Capacitor.registerPlugin('SoundCloudLogin')
  NowPlaying = Capacitor.registerPlugin('NowPlaying')
  ChunkLoader = Capacitor.registerPlugin('ChunkLoader')
  if (!CapacitorHttp) throw new Error('Capacitor.Plugins.CapacitorHttp не зарегистрирован')
} catch (err) {
  bridgeError = err
}

const SC_API = 'https://api-v2.soundcloud.com'
// С мобильным UA soundcloud.com отдаёт другую страницу, без бандла с client_id.
const DESKTOP_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Safari/605.1.15'
const MOBILE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1'

let scClientId = localStorage.getItem('clientId')
let scClientIdRequest = null

async function fetchText(url, userAgent = DESKTOP_UA) {
  const res = await CapacitorHttp.get({ url, headers: { 'User-Agent': userAgent }, responseType: 'text' })
  return res.data
}

// Главная soundcloud.com из РФ без VPN не открывается, а m.soundcloud.com отдаёт clientId прямо в HTML
// (так же берёт ключ pwa/server.mjs). Десктопный бандл остаётся запасным путём.
async function scrapeClientId() {
  try {
    const match = (await fetchText('https://m.soundcloud.com/', MOBILE_UA)).match(/"clientId":"(\w{32})"/)
    if (match) return match[1]
  } catch {}
  const page = await fetchText('https://soundcloud.com/')
  const scripts = [...page.matchAll(/src="(https:\/\/a-v2\.sndcdn\.com\/assets\/[^"]+\.js)"/g)].map(m => m[1])
  for (const src of scripts.reverse()) {
    const match = (await fetchText(src)).match(/client_id:"(\w{32})"/)
    if (match) return match[1]
  }
  throw new Error('Не нашёл client_id на soundcloud.com')
}

function getScClientId(refresh) {
  if (scClientId && !refresh) return scClientId
  scClientIdRequest ??= scrapeClientId()
    .then(id => {
      scClientId = id
      localStorage.setItem('clientId', id)
      return id
    })
    .finally(() => {
      scClientIdRequest = null
    })
  return scClientIdRequest
}

async function scApi(target, method = 'GET', body = null, retried = false) {
  const url = new URL(target, SC_API)
  url.searchParams.set('client_id', await getScClientId())
  const token = localStorage.getItem('token')
  const headers = token ? { Authorization: `OAuth ${token}` } : {}
  if (body) headers['Content-Type'] = 'application/json'
  const res = await CapacitorHttp.request({ method, url: url.href, headers, data: body ?? undefined })
  if (res.status === 401 && !retried) {
    await getScClientId(true)
    return scApi(target, method, body, true)
  }
  if (res.status >= 400) throw new Error(`SoundCloud ответил ${res.status}`)
  if (!res.data) return null
  return typeof res.data === 'string' ? JSON.parse(res.data) : res.data
}

// Токены лицензии FairPlay по ссылке на поток: нативный плеер получает их вместе со ссылкой.
const licenseTokens = new Map()
// Обычные треки нативный плеер открывает файлом, DRM — ссылкой на HLS (см. scStream).
const nativePath = src => fileFromSrc(src) || (licenseTokens.has(src) ? src : '')

async function scStream(track) {
  // DRM-трек не склеить в файл, как остальные: ключ FairPlay выдаётся только на HLS-поток. Поэтому он
  // играет по ссылке, а ключ берёт NowPlaying (AppDelegate.swift). Из РФ без VPN CDN режет соединения.
  const fairplay = track.media.transcodings.find(t => t.format.protocol === 'cbc-encrypted-hls' && t.format.mime_type.startsWith('audio/mp4'))
  if (fairplay) {
    const url = new URL(fairplay.url)
    url.searchParams.set('track_authorization', track.track_authorization)
    const { url: src, licenseAuthToken } = await scApi(url.href)
    licenseTokens.set(src, licenseAuthToken)
    return { url: src, hls: false, preview: fairplay.snipped }
  }

  const usable = track.media.transcodings.filter(t => ['progressive', 'hls'].includes(t.format.protocol))
  const full = usable.filter(t => !t.snipped)
  const pool = full.length ? full : usable
  const coding = pool.find(t => t.format.protocol === 'progressive')
    ?? pool.find(t => t.format.mime_type.startsWith('audio/mp4'))
    // Opus в Ogg не играют ни hls.js, ни AVPlayer — MP3 надёжнее, чем то, что окажется первым.
    ?? pool.find(t => t.format.mime_type.startsWith('audio/mpeg'))
    ?? pool[0]
  if (!coding) throw new Error('У трека нет доступного потока')

  const url = new URL(coding.url)
  url.searchParams.set('track_authorization', track.track_authorization)
  const { url: src } = await scApi(url.href)
  // Из РФ без VPN CDN отдаёт ~16 КБ на соединение — качаем файл нативно кусками
  // (ChunkLoader в AppDelegate.swift) и играем локальную копию. HLS склеивается в один файл.
  const hls = coding.format.protocol === 'hls'
  const ext = coding.format.mime_type.startsWith('audio/mp4') ? 'm4a' : 'mp3'
  const { path } = await ChunkLoader.fetch({
    name: `${track.id}-${coding.preset}${coding.snipped ? '-preview' : ''}.${ext}`,
    urls: hls ? await hlsParts(src) : [src],
  })
  return { url: Capacitor.convertFileSrc(path), hls: false, preview: coding.snipped }
}

// Плейлист тоже может быть больше порога, поэтому и его через ChunkLoader. Имя уникальное:
// ссылки в плейлисте подписаны на время, старая копия не годится.
async function hlsParts(playlistUrl) {
  const { path } = await ChunkLoader.fetch({ name: `playlist-${Date.now()}.m3u8`, urls: [playlistUrl] })
  const text = await (await fetch(Capacitor.convertFileSrc(path))).text()
  const init = text.match(/#EXT-X-MAP:URI="([^"]+)"/)?.[1]
  const segments = text.split('\n').map(line => line.trim()).filter(line => line && !line.startsWith('#'))
  return [init, ...segments].filter(Boolean).map(part => new URL(part, playlistUrl).href)
}

// Офлайн-копии лежат файлами в Documents (ChunkLoader.keep): AVPlayer не умеет играть blob:
// из Cache Storage. Путь к контейнеру меняется при переустановке, поэтому храним только имя.
const loadDownloadMeta = () => JSON.parse(localStorage.getItem('downloads') ?? '[]')
const saveDownloadMeta = list => localStorage.setItem('downloads', JSON.stringify(list))
const fileFromSrc = src => decodeURIComponent(src.split('/_capacitor_file_')[1] ?? '')
// Файлы, которые нативный плеер сейчас играет или держит наготове. При скачивании их копируем,
// остальные переносим из кэша потока: копии забивали кэш при «Скачать всё», и его чистка удаляла
// файл следующего трека прямо перед переходом на него.
const inUse = { playing: '', upcoming: '' }

async function downloadSave(track, url) {
  const source = fileFromSrc(url)
  const name = `${track.id}.${source.split('/').pop().split('?')[0].split('.').pop()}`
  const move = source !== inUse.playing && source !== inUse.upcoming
  const { size } = await ChunkLoader.keep({ path: source, name, move })
  const meta = { id: track.id, title: track.title, artist: track.user.username, size, file: name }
  saveDownloadMeta([...loadDownloadMeta().filter(d => d.id !== track.id), meta])
  return meta
}

async function downloadGet(id) {
  const meta = loadDownloadMeta().find(d => d.id === id)
  if (!meta?.file) return null
  try {
    const { path } = await ChunkLoader.locate({ name: meta.file })
    return Capacitor.convertFileSrc(path)
  } catch {
    return null
  }
}

async function downloadRemove(id) {
  const meta = loadDownloadMeta().find(d => d.id === id)
  if (meta?.file) await ChunkLoader.drop({ name: meta.file })
  saveDownloadMeta(loadDownloadMeta().filter(d => d.id !== id))
}

function toBase64(bytes) {
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(binary)
}

const coverOf = track => (track.artwork_url || track.user?.avatar_url || '')
  .replace('-large.', '-t500x500.')
  .replace('://i1.sndcdn.com/', '://i3.sndcdn.com/')

// Вместо <audio> — нативный AVPlayer (NowPlayingPlugin в AppDelegate.swift): пока играл <audio>,
// экран блокировки и Dynamic Island принадлежали WebKit с его ±10 секундами. Класс повторяет
// ту часть HTMLMediaElement, которой пользуется renderer.js.
class NativeAudio extends EventTarget {
  #src = ''
  #time = 0
  #at = 0
  #duration = NaN
  #volume = 1
  #muted = false
  #advanced = null
  #keepPosition = false
  paused = true
  ended = false
  crossOrigin = null
  error = null

  constructor() {
    super()
    NowPlaying.addListener('player', event => this.#native(event))
  }

  #fire(type) {
    this.dispatchEvent(new Event(type))
  }

  #native(event) {
    if ('time' in event && !Number.isFinite(event.time)) return
    if (event.type === 'time') {
      this.#time = event.time
      this.#at = performance.now()
      this.#fire('timeupdate')
    } else if (event.type === 'state') {
      if (event.playing === !this.paused) return
      this.paused = !event.playing
      this.#at = performance.now()
      if (event.playing) {
        this.ended = false
        this.#fire('play')
        this.#fire('playing')
      } else {
        this.#fire('pause')
      }
    } else if (event.type === 'duration') {
      this.#duration = event.duration
      this.#fire('durationchange')
    } else if (event.type === 'advanced') {
      // Плеер сам перешёл на заранее отданный следующий трек (в фоне JS спал).
      this.#advanced = event.path
      inUse.playing = event.path
      inUse.upcoming = ''
      this.#time = 0
      this.#at = performance.now()
    } else if (event.type === 'ended') {
      this.ended = true
      this.#fire('ended')
    } else if (event.type === 'seeked') {
      this.#time = event.time
      this.#at = performance.now()
      this.#fire('seeked')
    } else if (event.type === 'error') {
      this.error = { message: event.message }
      this.#fire('error')
    }
  }

  get currentTime() {
    const elapsed = this.paused ? 0 : (performance.now() - this.#at) / 1000
    return Math.min(this.#time + elapsed, this.#duration || Infinity)
  }

  set currentTime(time) {
    // renderer открывает трек, на который плеер уже перешёл сам, и ставит позицию 0 — её пропускаем.
    if (this.#keepPosition) {
      this.#keepPosition = false
      return
    }
    this.#time = time
    this.#at = performance.now()
    NowPlaying.seek({ time })
  }

  get duration() {
    return this.#duration
  }

  get src() {
    return this.#src
  }

  set src(url) {
    const path = nativePath(url)
    inUse.playing = path
    this.#src = url
    this.ended = false
    this.error = null
    if (path && path === this.#advanced) {
      this.#advanced = null
      this.#keepPosition = true
      return
    }
    this.#advanced = null
    this.#time = 0
    this.#duration = NaN
    NowPlaying.open({ path, licenseToken: licenseTokens.get(url) })
  }

  get volume() {
    return this.#volume
  }

  set volume(value) {
    this.#volume = value
    NowPlaying.setVolume({ volume: value, muted: this.#muted })
    this.#fire('volumechange')
  }

  get muted() {
    return this.#muted
  }

  set muted(value) {
    this.#muted = value
    NowPlaying.setVolume({ volume: this.#volume, muted: value })
    this.#fire('volumechange')
  }

  play() {
    return NowPlaying.play()
  }

  pause() {
    NowPlaying.pause()
  }

  canPlayType() {
    return ''
  }

  getAttribute(name) {
    return name === 'src' && this.#src ? this.#src : null
  }
}

window.sc = bridgeError ? {
  api: () => Promise.reject(bridgeError),
  stream: () => Promise.reject(bridgeError),
  session: async () => ({ loggedIn: false }),
  login: () => Promise.reject(bridgeError),
  logout: async () => {},
  downloads: { save: () => Promise.reject(bridgeError), list: async () => [], remove: async () => {}, get: async () => null },
  saveFile: () => Promise.reject(bridgeError),
  mpris() {},
  onMedia() {},
} : {
  api: (target, method, body) => scApi(target, method, body),
  stream: scStream,
  drm: true,
  session: async () => ({ loggedIn: Boolean(localStorage.getItem('token')) }),
  async login() {
    const { token } = await SoundCloudLogin.login()
    if (token) localStorage.setItem('token', token)
    return Boolean(token)
  },
  async logout() {
    localStorage.removeItem('token')
    await SoundCloudLogin.logout()
  },
  downloads: { save: downloadSave, list: async () => loadDownloadMeta(), remove: downloadRemove, get: downloadGet },
  // WKWebView не умеет скачивать файлы (нет WKDownloadDelegate), а буфер обмена после сетевых
  // запросов уже закрыт: WebKit пускает запись только в свежем жесте, и резервная копия лайков
  // падала с NotAllowedError. Поэтому файл отдаём системному листу «Поделиться» → «Сохранить в Файлы».
  async saveFile(name, data) {
    const { completed } = await NowPlaying.shareFile(typeof data === 'string' ? { name, text: data } : { name, base64: toBase64(data) })
    return completed ? 'Готово' : 'Отменено'
  },
  createAudio: () => new NativeAudio(),
  // Следующий трек заранее уходит в нативный плеер: в фоне JS спит, а переходить надо.
  // null — следующего нет (или он ещё качается): плеер сам никуда не переходит.
  preloadNext(track, source) {
    const path = track ? nativePath(source.url) : ''
    if (track && !path) return
    inUse.upcoming = path
    NowPlaying.preloadNext(track ? {
      path,
      licenseToken: licenseTokens.get(source.url),
      title: track.title,
      artist: track.user.username,
      artUrl: coverOf(track),
      length: track.full_duration / 1000,
    } : { path }).catch(() => {})
  },
  // В фоне JS спит, и setTimeout в renderer.js не срабатывает — паузу ставит нативный таймер.
  setSleepTimer: seconds => NowPlaying.setSleepTimer({ seconds }).catch(() => {}),
  // Результат пишем в localStorage: экран «Настройки» покажет его без отдельной сборки с логами.
  async mpris(track) {
    try {
      await NowPlaying.update(track)
      localStorage.setItem('nowPlayingStatus', 'ok')
    } catch (err) {
      localStorage.setItem('nowPlayingStatus', `ошибка: ${err.message}`)
    }
  },
  onMedia(callback) {
    NowPlaying.addListener('command', ({ action, value }) => callback(action, value))
  },
  // Синхронизация с компьютером по Wi-Fi: слияние делает общий renderer.js, тут только транспорт.
  sync: {
    async pull(address, key) {
      const res = await CapacitorHttp.get({ url: `http://${address}/sync`, headers: { 'X-Sync-Key': key }, connectTimeout: 4000, readTimeout: 10000 })
      if (res.status !== 200) throw new Error(`компьютер ответил ${res.status}`)
      return typeof res.data === 'string' ? JSON.parse(res.data) : res.data
    },
    async push(address, key, snapshot) {
      const res = await CapacitorHttp.post({
        url: `http://${address}/sync`,
        headers: { 'X-Sync-Key': key, 'Content-Type': 'application/json' },
        data: snapshot,
        connectTimeout: 4000,
        readTimeout: 10000,
      })
      if (res.status !== 200) throw new Error(`компьютер ответил ${res.status}`)
    },
  },
  haptic: () => NowPlaying.haptic().catch(() => {}),
  setIcon: name => NowPlaying.setIcon({ name }),
}
