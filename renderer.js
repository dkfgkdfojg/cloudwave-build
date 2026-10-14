const $ = selector => document.querySelector(selector)

// На iPhone звук играет нативный AVPlayer (см. mobile/bridge.js), иначе экран блокировки занимает WebKit.
const audio = sc.createAudio?.() ?? $('#audio')
// На iPhone композитинг дорогой: класс включает облегчённые стили (см. .native в style.css).
const native = Boolean(window.Capacitor)
document.documentElement.classList.toggle('native', native)
// На Windows окно непрозрачное (размытия под ним нет), см. .win в style.css.
const windows = sc.platform === 'win32'
document.documentElement.classList.toggle('win', windows)
// PWA в Safari на iPhone — тоже iOS: звук, пропущенный через Web Audio, там замолкает при блокировке экрана.
const ios = native || /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.userAgent.includes('Macintosh') && navigator.maxTouchPoints > 1)
const main = $('#main')
const view = $('#view')
const searchInput = $('#search-input')

const GENRES = ['lofi', 'phonk', 'drum and bass', 'deep house', 'techno', 'ambient', 'jazz', 'hyperpop', 'русский рэп', 'synthwave']
const TRACK_FORMS = ['трек', 'трека', 'треков']

const state = {
  me: null,
  loggedIn: false,
  playlists: [],
  likedIds: new Set(),
  downloads: new Map(),
  queue: [],
  original: [],
  index: -1,
  context: null,
  // Продолжение списка, из которого играет очередь (следующая страница лайков, поиска).
  more: null,
  shuffle: false,
  repeat: false,
  seeking: false,
}

const lists = new Map()
const backStack = []
let listSeq = 0
let navToken = 0
let playToken = 0
let current = { name: 'home' }
let hls = null
let wave = null
let waveHover = null
let reloadedFor = null
let skipStreak = 0
let listened = JSON.parse(localStorage.getItem('listened') ?? 'null')
let lastPosition = null
let sleepTimer = null
let sleepAt = null
let pendingTrack = null
let audioCtx = null
let compressor = null
let analyser = null
let beatFrame = 0
let lastStep = 1

/* ---------- форматирование ---------- */

const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

function plural(n, forms) {
  const mod10 = n % 10
  const mod100 = n % 100
  if (mod10 === 1 && mod100 !== 11) return forms[0]
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return forms[1]
  return forms[2]
}

function fmtTime(seconds) {
  const total = Math.floor(seconds || 0)
  const h = Math.floor(total / 3600)
  const m = Math.floor(total / 60) % 60
  const s = String(total % 60).padStart(2, '0')
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`
}

function fmtLong(ms) {
  const minutes = Math.round(ms / 60000)
  const h = Math.floor(minutes / 60)
  return h ? `${h} ч ${minutes % 60} мин` : `${minutes} мин`
}

function fmtCount(n) {
  n ??= 0
  if (n >= 1e6) return `${(n / 1e6).toFixed(1).replace(/\.0$/, '').replace('.', ',')} млн`
  if (n >= 1e4) return `${Math.round(n / 1e3)} тыс.`
  return n.toLocaleString('ru-RU')
}

const fmtDate = iso => new Date(iso).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short', year: 'numeric' })
const fmtSize = bytes => bytes >= 1e6 ? `${(bytes / 1e6).toFixed(1)} МБ` : `${Math.round(bytes / 1e3)} КБ`
const countOf = (n, forms) => `${fmtCount(n)} ${plural(n ?? 0, forms)}`
const errorText = err => err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
const today = () => new Date().toLocaleDateString('sv')

// i1.sndcdn.com из РФ сбрасывают по SNI, а i2–i4 — тот же CloudFront с теми же картинками.
const unblockImage = url => url?.replace('://i1.sndcdn.com/', '://i3.sndcdn.com/')
const artUrl = (url, size = 't500x500') => unblockImage(url)?.replace('-large.', `-${size}.`) ?? ''
const cover = (item, size) => artUrl(item.artwork_url || item.user?.avatar_url, size)
const playable = track => track?.media?.transcodings?.length > 0
const previewOnly = track => track.media.transcodings.every(t => t.snipped)
// Лейбловые треки SoundCloud отдаёт только с DRM (FairPlay/Widevine): hls и progressive у них
// в списке есть, но отвечают 404. Отличить можно по зашифрованным вариантам среди транскодингов.
const encrypted = track => Boolean(track.media?.transcodings.some(t => t.format.protocol.includes('encrypted')))
// С Widevine (castlabs Electron на ПК) зашифрованные треки играют, без него — только видны в списках.
const drmOnly = track => !sc.drm && encrypted(track)
const hideDrm = () => localStorage.getItem('hideDrm') === '1'
const listable = track => playable(track) && !(hideDrm() && drmOnly(track))

let toastTimer
function toast(text) {
  const el = $('#toast')
  el.textContent = text
  el.classList.add('show')
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => el.classList.remove('show'), 3500)
}

/* ---------- разметка ---------- */

function artBox(url, className = '', extra = '') {
  const img = url ? `<img src="${esc(unblockImage(url))}" alt="" loading="lazy" decoding="async">` : ''
  return `<span class="art ${className}">${img}${extra}</span>`
}

function section(title, body, extra = '') {
  return `<section class="section"><div class="section-head"><h2 class="section-title">${title}</h2>${extra}</div>${body}</section>`
}

function stateBlock(title, text, actions = '', icon = 'i-search') {
  return `<div class="state"><svg aria-hidden="true"><use href="#${icon}"/></svg><h2>${title}</h2><p>${text}</p>${actions}</div>`
}

// Заглушка повторяет форму будущей страницы: у главной полки карточек, у плейлиста шапка и строки.
function skeleton(name) {
  const row = '<div class="skel-row"><span class="skel skel-art"></span><span class="skel-lines"><span class="skel"></span><span class="skel"></span></span></div>'
  const shelf = `<span class="skel skel-title"></span><div class="skel-shelf">${'<div class="skel-card"><span class="skel skel-cover"></span><span class="skel"></span><span class="skel skel-short"></span></div>'.repeat(6)}</div>`
  const hero = '<div class="skel-hero"><span class="skel skel-hero-art"></span><span class="skel-lines"><span class="skel skel-short"></span><span class="skel skel-big"></span><span class="skel"></span></span></div>'
  const body = {
    home: `<span class="skel skel-big"></span>${shelf}${shelf}`,
    playlist: hero + row.repeat(6),
    system: hero + row.repeat(6),
    mix: hero + row.repeat(6),
    likes: hero + row.repeat(6),
    localPlaylist: hero + row.repeat(6),
    user: hero + shelf + row.repeat(4),
    search: shelf + row.repeat(6),
    library: `<span class="skel skel-big"></span>${shelf}${shelf}`,
    history: `<span class="skel skel-big"></span><div class="skel-stats">${'<span class="skel"></span>'.repeat(3)}</div>${row.repeat(6)}`,
  }[name] ?? row.repeat(8)
  return `<div class="skeleton" aria-busy="true">${body}</div>`
}

function trackRows(tracks, listId, offset = 0) {
  // Кнопка скачивания нужна только в приложении на телефоне: на ПК для этого есть меню «⋯».
  const downloadable = native && current.name === 'likes'
  return tracks.map((t, i) => {
    const index = offset + i
    return `
      <div class="row${drmOnly(t) ? ' is-locked' : ''}${downloadable && !encrypted(t) ? ' has-download' : ''}" role="button" tabindex="0" data-list="${listId}" data-index="${index}" data-track="${t.id}"${index < 16 ? ` style="--i:${index}"` : ''}>
        <span class="row-num">
          <span class="row-index">${index + 1}</span>
          <span class="eq" aria-hidden="true"><i></i><i></i><i></i></span>
          <svg class="row-play" aria-hidden="true"><use href="#i-play"/></svg>
        </span>
        ${artBox(cover(t, 'large'), 'row-art')}
        <span class="row-main">
          <span class="row-line"><span class="row-title" title="${esc(t.title)}">${esc(t.title)}</span>${drmOnly(t) ? '<span class="tag" title="SoundCloud отдаёт этот трек только с DRM — сторонние плееры его не сыграют">DRM</span>' : previewOnly(t) ? '<span class="tag">превью</span>' : ''}</span>
          <button class="link row-artist" data-user="${t.user.id}">${esc(t.user.username)}</button>
        </span>
        <span class="row-plays">${fmtCount(t.playback_count)}</span>
        <span class="row-dur">${fmtTime(t.full_duration / 1000)}</span>
        ${downloadable && !encrypted(t) ? downloadButton(t) : ''}
        <button class="icon-btn row-more" data-more data-list="${listId}" data-index="${index}" aria-label="Ещё"><svg aria-hidden="true"><use href="#i-more"/></svg></button>
      </div>`
  }).join('')
}

function downloadButton(track) {
  const done = state.downloads.has(track.id)
  return `<button class="icon-btn row-download${done ? ' is-done' : ''}" data-download="${track.id}" aria-label="${done ? 'Удалить загрузку' : 'Скачать для офлайна'}"><svg aria-hidden="true"><use href="#i-download"/></svg></button>`
}

function trackTable(tracks, listId) {
  return `
    <div class="tracks" data-list-root="${listId}">
      <div class="tracks-head" aria-hidden="true"><span>#</span><span></span><span>Название</span><span>Прослушивания</span><span>Длина</span><span></span></div>
      ${trackRows(tracks, listId)}
    </div>`
}

function playlistCard(p) {
  return `
    <button class="card" data-playlist="${p.id}">
      ${artBox(artUrl(p.artwork_url || p.user?.avatar_url, 't300x300'))}
      <span class="card-title" title="${esc(p.title)}">${esc(p.title)}</span>
      <span class="card-meta">${p.is_album ? 'Альбом' : 'Плейлист'} · ${countOf(p.track_count, TRACK_FORMS)}</span>
    </button>`
}

function userCard(u) {
  return `
    <button class="card card-user" data-user="${u.id}">
      ${artBox(artUrl(u.avatar_url, 't300x300'), 'round')}
      <span class="card-title">${esc(u.username)}</span>
      <span class="card-meta">${countOf(u.followers_count, ['подписчик', 'подписчика', 'подписчиков'])}</span>
    </button>`
}

function heroActions(listId, count, extra = '') {
  const disabled = count ? '' : ' disabled'
  return `
    <div class="hero-actions">
      <button class="play-btn play-btn-lg" data-play-list="${listId}" aria-label="Слушать"${disabled}><svg><use href="#i-play"/></svg></button>
      <button class="btn" data-shuffle-list="${listId}"${disabled}><svg><use href="#i-shuffle"/></svg>Перемешать</button>
      ${extra}
    </div>`
}

const genreSection = () =>
  section('Быстрый поиск', `<div class="chips">${GENRES.map(g => `<button class="chip" data-search="${esc(g)}">${esc(g)}</button>`).join('')}</div>`)

const SELECTION_TITLES = {
  'personalized-tracks': 'Больше того, что тебе нравится',
  'recently-played': 'Недавно сыгранные',
  'your-moods': 'Миксы для тебя',
  'made-for-you': 'Сделано для тебя',
  'liked-by': 'Выбор артистов',
  'artist-stations': 'Станции артистов',
  buzzing: 'Артисты на подъёме',
  'trending-by-genre-playlists': 'В тренде по жанрам',
  'personalized-albums': 'Альбомы для тебя',
  'personalised-curated-global': 'Подборки SoundCloud',
}

// urn вида soundcloud:selections:liked-by-123456 — хвост с id пользователя отрезаем.
const selectionKey = selection => selection.urn.split(':')[2].replace(/-\d+$/, '')

function systemCard(p) {
  const meta = p.short_description || countOf(p.tracks?.length, TRACK_FORMS)
  return `
    <button class="card" data-system="${esc(p.urn)}">
      ${artBox(artUrl(p.calculated_artwork_url || p.artwork_url, 't300x300'))}
      <span class="card-title" title="${esc(p.title)}">${esc(p.short_title || p.title)}</span>
      <span class="card-meta" title="${esc(meta)}">${esc(meta)}</span>
    </button>`
}

function selectionSection(selection, feature) {
  const key = selectionKey(selection)
  // В recently-played один и тот же микс приходит по разу на каждое прослушивание.
  const items = [...new Map(selection.items.collection.map(item => [item.urn ?? `${item.kind}:${item.id}`, item])).values()]
  if (!items.length) return ''
  const featured = key === 'recently-played' && feature
  const rest = featured ? items.slice(1) : items
  const strip = rest.length
    ? `<div class="strip">${rest.map(item => (item.kind === 'system-playlist' ? systemCard(item) : item.kind === 'user' ? userCard(item) : playlistCard(item))).join('')}</div>`
    : ''
  return section(SELECTION_TITLES[key] ?? esc(selection.title), featured ? feature + strip : strip)
}

function miniRow(t, listId, index) {
  return `
    <div class="mini-row" role="button" tabindex="0" data-list="${listId}" data-index="${index}" data-track="${t.id}">
      ${artBox(cover(t, 'large'), 'mini-art')}
      <span class="row-main">
        <span class="row-title" title="${esc(t.title)}">${esc(t.title)}</span>
        <button class="link row-artist" data-user="${t.user.id}">${esc(t.user.username)}</button>
      </span>
      <span class="mini-plays"><svg aria-hidden="true"><use href="#i-play"/></svg>${fmtCount(t.playback_count)}</span>
      <button class="icon-btn mini-more" data-more data-list="${listId}" data-index="${index}" aria-label="Ещё"><svg aria-hidden="true"><use href="#i-more"/></svg></button>
    </div>`
}

function featurePanel(mix, tracks, listId) {
  return `
    <div class="feature">
      <div class="feature-art">
        ${artBox(artUrl(mix.calculated_artwork_url || mix.artwork_url))}
        <button class="play-btn play-btn-lg feature-play" data-play-system="${esc(mix.urn)}" aria-label="Слушать «${esc(mix.title)}»"><svg><use href="#i-play"/></svg></button>
      </div>
      <div class="feature-body">
        <p class="eyebrow">${esc(mix.title)}</p>
        <div class="feature-tracks">${tracks.map((t, i) => miniRow(t, listId, i)).join('')}</div>
        <button class="btn feature-open" data-system="${esc(mix.urn)}">Перейти к плейлисту</button>
      </div>
    </div>`
}

function userLine(u) {
  return `
    <button class="user-line" data-user="${u.id}">
      ${artBox(u.avatar_url, 'round')}
      <span class="row-main">
        <span class="row-title">${esc(u.username)}</span>
        <span class="user-stats">${countOf(u.followers_count, ['подписчик', 'подписчика', 'подписчиков'])} · ${countOf(u.track_count, TRACK_FORMS)}</span>
      </span>
    </button>`
}

const asideBlock = (title, body, extra = '') =>
  `<section class="aside-block"><div class="section-head"><h2 class="aside-title">${title}</h2>${extra}</div>${body}</section>`

/* ---------- данные ---------- */

function registerList(tracks, context, next = null, id = `l${++listSeq}`) {
  // Списки больше не чистятся при каждом переходе: на них ссылается сохранённая главная.
  // Повторно зарегистрированный список (из снимка главной) переносим в конец: Map оставлял его
  // на старом месте, и чистка выкидывала его, пока строки ещё на экране, — клик по треку падал.
  lists.delete(id)
  if (lists.size > 80) for (const key of [...lists.keys()].slice(0, 40)) lists.delete(key)
  lists.set(id, { tracks, context, next })
  return id
}

// Плейлисты и лайки отдают полные данные только у первых треков, остальные — заглушки с id.
async function hydrate(tracks) {
  tracks = tracks.filter(Boolean)
  const missing = tracks.filter(t => !t.media).map(t => t.id)
  const chunks = []
  for (let i = 0; i < missing.length; i += 50) chunks.push(missing.slice(i, i + 50))
  const pages = await Promise.all(chunks.map(ids => sc.api(`/tracks?ids=${ids.join(',')}`)))
  const full = new Map(pages.flat().map(t => [t.id, t]))
  return tracks.map(t => full.get(t.id) ?? t).filter(listable)
}

async function loadPlaylists() {
  const [own, liked] = await Promise.all([
    sc.api(`/users/${state.me.id}/playlists?limit=50`),
    sc.api(`/users/${state.me.id}/playlist_likes?limit=50`),
  ])
  const all = [...own.collection, ...liked.collection.map(item => item.playlist)].filter(Boolean)
  return [...new Map(all.map(p => [p.id, p])).values()]
}

function attachPager(listId) {
  const list = lists.get(listId)
  const root = view.querySelector(`[data-list-root="${listId}"]`)
  if (!list.next || !root) return

  const sentinel = document.createElement('div')
  sentinel.className = 'sentinel'
  root.after(sentinel)

  let busy = false
  const observer = new IntersectionObserver(async ([entry]) => {
    if (!entry.isIntersecting || busy || !list.next) return
    busy = true
    try {
      const page = await sc.api(list.next.href)
      const tracks = await hydrate(list.next.pick(page))
      root.insertAdjacentHTML('beforeend', trackRows(tracks, listId, list.tracks.length))
      list.tracks.push(...tracks)
      list.next = page.next_href ? { ...list.next, href: page.next_href } : null
      markCurrent()
    } catch (err) {
      toast(`Не догрузил список: ${errorText(err)}`)
      return
    } finally {
      busy = false
    }
    observer.unobserve(sentinel)
    if (list.next) observer.observe(sentinel)
    else sentinel.remove()
  }, { root: main, rootMargin: '800px' })
  observer.observe(sentinel)
}

function trackListened() {
  const delta = audio.currentTime - lastPosition
  lastPosition = audio.currentTime
  if (audio.paused || !(delta > 0 && delta < 2)) return
  if (listened?.day !== today()) listened = { day: today(), seconds: 0 }
  listened.seconds += delta
  listenedDays[today()] = (listenedDays[today()] ?? 0) + delta
  lifetime.seconds += delta
}

// Для статистики за неделю и месяц; дни старше двух месяцев выкидываем при сохранении.
let listenedDays = JSON.parse(localStorage.getItem('listenedDays') ?? '{}')

function saveListened() {
  localStorage.setItem('listened', JSON.stringify(listened))
  saveLifetime()
  const oldest = new Date(Date.now() - 60 * 864e5).toLocaleDateString('sv')
  listenedDays = Object.fromEntries(Object.entries(listenedDays).filter(([day]) => day >= oldest))
  localStorage.setItem('listenedDays', JSON.stringify(listenedDays))
}
// Минуты каждое устройство считает только свои, чужие приходят синхронизацией и лежат
// отдельно по id устройства — иначе при каждом обмене одно и то же время складывалось бы заново.
const deviceId = localStorage.getItem('deviceId') ?? (() => {
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
  localStorage.setItem('deviceId', id)
  return id
})()
let peerListened = JSON.parse(localStorage.getItem('peerListened') ?? '{}')
const daySeconds = day => (listenedDays[day] ?? 0) + Object.values(peerListened).reduce((sum, days) => sum + (days[day] ?? 0), 0)
const listenedToday = () => daySeconds(today())

/* ---------- история и миксы Cloudwave ---------- */

let history = JSON.parse(localStorage.getItem('history') ?? '[]')

// Счётчики за всё время: история хранит последние 500 треков, минуты по дням — 60 дней,
// поэтому «всего» считаем отдельно. Первый раз заполняем из того, что уже накопилось.
let lifetime = JSON.parse(localStorage.getItem('lifetime') ?? 'null') ?? {
  plays: history.length,
  seconds: Object.values(listenedDays).reduce((sum, seconds) => sum + seconds, 0),
  tracks: [...new Set(history.map(h => h.id))],
  artists: [],
}
let peerLifetime = JSON.parse(localStorage.getItem('peerLifetime') ?? '{}')
const saveLifetime = () => localStorage.setItem('lifetime', JSON.stringify(lifetime))

function lifetimeTotals() {
  const peers = Object.values(peerLifetime)
  return {
    plays: lifetime.plays + peers.reduce((sum, p) => sum + (p.plays ?? 0), 0),
    seconds: lifetime.seconds + peers.reduce((sum, p) => sum + (p.seconds ?? 0), 0),
    tracks: new Set([...lifetime.tracks, ...peers.flatMap(p => p.tracks ?? [])]).size,
    artists: new Set([...lifetime.artists, ...peers.flatMap(p => p.artists ?? [])]).size,
  }
}

// Дни подряд, когда слушал хотя бы минуту; сегодняшний день ещё не прерывает серию.
function listeningStreak() {
  const day = new Date()
  if (daySeconds(day.toLocaleDateString('sv')) < 60) day.setDate(day.getDate() - 1)
  let streak = 0
  while (daySeconds(day.toLocaleDateString('sv')) >= 60) {
    streak++
    day.setDate(day.getDate() - 1)
  }
  return streak
}

function addToHistory(track) {
  if (history[0]?.id === track.id) return
  history = [{ id: track.id, at: Date.now() }, ...history].slice(0, 500)
  localStorage.setItem('history', JSON.stringify(history))
  lifetime.plays++
  if (!lifetime.tracks.includes(track.id)) lifetime.tracks.push(track.id)
  if (track.user?.id && !lifetime.artists.includes(track.user.id)) lifetime.artists.push(track.user.id)
  saveLifetime()
  publishSnapshot()
}

// Случайность с зерном от даты: миксы меняются раз в сутки, а не при каждом открытии главной.
function seededRandom(seed) {
  let x = [...seed].reduce((h, c) => Math.imul(h ^ c.charCodeAt(0), 16777619), 2166136261)
  return () => {
    x ^= x << 13
    x ^= x >>> 17
    x ^= x << 5
    return (x >>> 0) / 2 ** 32
  }
}

function pickRandom(items, count, random) {
  const pool = [...items]
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1))
    ;[pool[i], pool[j]] = [pool[j], pool[i]]
  }
  return pool.slice(0, count)
}

const uniqueTracks = tracks => [...new Map(tracks.map(t => [t.id, t])).values()]

// Миксы строятся на персональных подборках самого SoundCloud (/mixed-selections):
// «Your Mix 1–10» под вкус, «Daily Drops» и «Weekly Wave» с новинками. Раньше зёрна брались
// случайно из 200 лайков, а настроение — вообще поиском по тегу, и в миксы лезло старое и чужое.
const MOOD_SLOTS = {
  morning: { title: 'Для разгона', about: 'Твой микс на утро', hue: 65, mixes: [0, 1, 2] },
  day: { title: 'В фоне', about: 'Твой микс на день', hue: 230, mixes: [3, 4, 5] },
  evening: { title: 'Вечерний вайб', about: 'Твой микс на вечер', hue: 300, mixes: [6, 7] },
  night: { title: 'Спокойное', about: 'Твой микс на ночь', hue: 270, mixes: [8, 9] },
}

// Слишком короткое — перебивки и скиты, слишком длинное — сеты и подкасты, совсем без
// прослушиваний — залитый мусор.
const worthListening = track => {
  const seconds = track.full_duration / 1000
  return seconds > 45 && seconds < 600 && (track.playback_count ?? 0) >= 200
}

const selectionTracks = (selections, key) => (selections.collection.find(s => selectionKey(s) === key)?.items.collection ?? [])

async function hydrateMix(items, random, limit = 30, extra = () => true) {
  const ids = uniqueTracks(items.map(t => ({ id: t.id }))).map(t => t.id)
  const tracks = (await hydrate(ids.slice(0, 200).map(id => ({ id })))).filter(t => !drmOnly(t) && worthListening(t) && extra(t))
  return pickRandom(tracks, limit, random)
}

async function buildMixes() {
  const random = seededRandom(`${today()}:${state.me.id}`)
  const [selections, likesPage] = await Promise.all([
    sc.api('/mixed-selections?limit=20'),
    sc.api(`/users/${state.me.id}/track_likes?limit=60`),
  ])
  // Лайки приходят новыми вперёд — свежие вкусы весят больше старых.
  const liked = likesPage.collection.map(item => item.track).filter(t => t && playable(t) && !drmOnly(t))
  const likedIds = new Set(liked.map(t => t.id))
  const heard = new Set(history.map(h => h.id))

  const moods = selectionTracks(selections, 'your-moods')
  const slot = MOOD_SLOTS[timeOfDay()]
  const moodTracks = slot.mixes.flatMap(i => moods[i]?.tracks ?? [])
  const personal = selectionTracks(selections, 'personalized-tracks').flatMap(item => item.tracks ?? [])
  const fresh = selectionTracks(selections, 'made-for-you').flatMap(item => item.tracks ?? [])

  const genres = new Map()
  for (const t of liked.slice(0, 40)) {
    const genre = t.genre?.trim().toLowerCase()
    if (genre) genres.set(genre, [...(genres.get(genre) ?? []), t])
  }
  const topGenre = [...genres].filter(([, tracks]) => tracks.length >= 3).sort((a, b) => b[1].length - a[1].length)[0]
  // Станция SoundCloud — его же радио по треку, оно ближе к вкусу, чем /related.
  const stationTracks = topGenre
    ? (await Promise.all(pickRandom(topGenre[1], 3, random).map(seed =>
        sc.api(`/stations/soundcloud:track-stations:${seed.id}/tracks?limit=25`).then(r => r.collection, () => []))))
      .flat()
    : []

  const mixes = [
    {
      id: `mood:${timeOfDay()}`,
      hue: slot.hue,
      title: slot.title,
      about: slot.about,
      tracks: await hydrateMix([...moodTracks, ...pickRandom(liked.slice(0, 20), 6, random)], random),
    },
    {
      id: 'daily',
      hue: 300,
      title: 'Микс дня',
      about: 'Похожее на то, что ты слушаешь',
      tracks: await hydrateMix([...personal, ...pickRandom(liked, 10, random)], random, 40),
    },
    {
      id: 'discover',
      hue: 190,
      title: 'Открытия',
      about: 'Новое под твой вкус, чего ты ещё не слышал',
      tracks: await hydrateMix(fresh.length ? fresh : personal, random, 30, t => !likedIds.has(t.id) && !heard.has(t.id)),
    },
    ...(topGenre && stationTracks.length ? [{
      id: `genre:${topGenre[0]}`,
      hue: [...topGenre[0]].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7),
      title: `Микс: ${topGenre[0][0].toUpperCase()}${topGenre[0].slice(1)}`,
      about: 'Радио SoundCloud по твоим лайкам этого жанра',
      tracks: await hydrateMix([...stationTracks, ...topGenre[1]], random),
    }] : []),
  ]
  return mixes.filter(mix => mix.tracks.length >= 8).map(({ tracks, ...mix }) => ({
    ...mix,
    cover: cover(tracks[0], 't300x300'),
    covers: tracks.slice(0, 4).map(t => cover(t, 't300x300')),
    trackIds: tracks.map(t => t.id),
  }))
}

let mixesBuild = null

// Ключ с временем суток: утренний микс не должен висеть до вечера.
async function loadMixes() {
  const key = `v3:${today()}:${timeOfDay()}:${state.me.id}`
  const cached = JSON.parse(localStorage.getItem('mixes') ?? 'null')
  if (cached?.key === key) return cached.mixes
  mixesBuild ??= buildMixes()
    .then(mixes => {
      localStorage.setItem('mixes', JSON.stringify({ key, mixes }))
      return mixes
    })
    .finally(() => {
      mixesBuild = null
    })
  return mixesBuild
}

// Коллаж из четырёх обложек с градиентом своего оттенка; у старых кэшей covers ещё нет.
function mixArt(mix, className = '') {
  const covers = mix.covers?.length >= 4 ? mix.covers.slice(0, 4) : [mix.cover]
  return `
    <span class="art mix-art ${className}" style="--mix-hue: ${mix.hue ?? 300}">
      <span class="mix-tiles${covers.length === 4 ? ' is-grid' : ''}">${covers.map(url => (url ? `<img src="${esc(unblockImage(url))}" alt="" loading="lazy">` : '<i></i>')).join('')}</span>
      <span class="mix-badge">Cloudwave</span>
    </span>`
}

function mixCard(mix) {
  return `
    <button class="card" data-mix="${esc(mix.id)}">
      ${mixArt(mix)}
      <span class="card-title" title="${esc(mix.title)}">${esc(mix.title)}</span>
      <span class="card-meta" title="${esc(mix.about)}">${esc(mix.about)}</span>
    </button>`
}

async function shareTrack(track) {
  const text = `${track.title} — ${track.user.username}`
  if (navigator.share) {
    try {
      await navigator.share({ title: text, url: track.permalink_url })
    } catch (err) {
      if (err.name !== 'AbortError') toast(errorText(err))
    }
    return
  }
  await navigator.clipboard.writeText(track.permalink_url)
  toast('Ссылка скопирована')
}

async function playStation(track) {
  try {
    const related = await sc.api(`/tracks/${track.id}/related?limit=30`)
    const tracks = [track, ...related.collection.filter(t => playable(t) && !drmOnly(t) && t.id !== track.id)]
    playList(registerList(tracks, { label: `Станция: ${track.title}` }), 0)
  } catch (err) {
    toast(`Не собрал станцию: ${errorText(err)}`)
  }
}

function dayLabel(at) {
  const day = new Date(at).toDateString()
  if (day === new Date().toDateString()) return 'Сегодня'
  if (day === new Date(Date.now() - 864e5).toDateString()) return 'Вчера'
  return new Date(at).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' })
}

/* ---------- настройки ---------- */

const loadLocalPlaylists = () => JSON.parse(localStorage.getItem('localPlaylists') ?? '{}')
function saveLocalPlaylists(data) {
  localStorage.setItem('localPlaylists', JSON.stringify(data))
  publishSnapshot()
}
const refreshSettings = () => current.name === 'settings' && go('settings', null, false)

function createLocalPlaylist(name) {
  const playlists = loadLocalPlaylists()
  const id = `p${Date.now()}`
  playlists[id] = { id, name, trackIds: [], updatedAt: Date.now() }
  saveLocalPlaylists(playlists)
  return playlists[id]
}

function addToLocalPlaylist(id, track) {
  const playlists = loadLocalPlaylists()
  const playlist = playlists[id]
  if (!playlist) return
  if (playlist.trackIds.includes(track.id)) {
    toast(`Уже есть в «${playlist.name}»`)
    return
  }
  playlist.trackIds.push(track.id)
  playlist.updatedAt = Date.now()
  saveLocalPlaylists(playlists)
  toast(`Добавлено в «${playlist.name}»`)
}

function removeFromLocalPlaylist(id, trackId) {
  const playlists = loadLocalPlaylists()
  if (!playlists[id]) return
  playlists[id].trackIds = playlists[id].trackIds.filter(t => t !== trackId)
  playlists[id].updatedAt = Date.now()
  saveLocalPlaylists(playlists)
}

function deleteLocalPlaylist(id) {
  const playlists = loadLocalPlaylists()
  delete playlists[id]
  saveLocalPlaylists(playlists)
  const deleted = JSON.parse(localStorage.getItem('deletedPlaylists') ?? '{}')
  deleted[id] = Date.now()
  localStorage.setItem('deletedPlaylists', JSON.stringify(deleted))
}

// Миксы пересобираются каждый день, поэтому понравившийся сохраняем копией в плейлист SoundCloud.
async function saveMixAsPlaylist(listId, title) {
  const tracks = lists.get(listId)?.tracks ?? []
  if (!tracks.length) return
  try {
    await createPlaylist(title, tracks.map(t => t.id))
    toast(`Сохранено в плейлист «${title}» — вкладка «Моё»`)
  } catch (err) {
    toast(`Не сохранилось: ${errorText(err)}`)
  }
}

/* ---------- плейлисты SoundCloud ---------- */

// Плейлисты живут в аккаунте SoundCloud: так они сразу одинаковые на ПК, телефоне и сайте.
const ownPlaylists = () => state.playlists.filter(p => p.user?.id === state.me?.id)
const isOwnPlaylist = id => ownPlaylists().some(p => p.id === Number(id))

async function refreshPlaylists() {
  state.playlists = await loadPlaylists()
  renderSidebarPlaylists()
}

async function createPlaylist(title, trackIds = []) {
  const playlist = await sc.api('/playlists', 'POST', { playlist: { title, sharing: 'private', tracks: trackIds } })
  await refreshPlaylists()
  return playlist
}

// Список треков берём у сервера, а не из state.playlists: там у длинных плейлистов заглушки.
async function playlistTrackIds(id) {
  return (await sc.api(`/playlists/${id}`)).tracks.map(t => t.id)
}

async function updatePlaylist(id, fields) {
  await sc.api(`/playlists/${id}`, 'PUT', { playlist: fields })
  await refreshPlaylists()
}

async function addToPlaylist(id, track) {
  const ids = await playlistTrackIds(id)
  const title = state.playlists.find(p => p.id === Number(id))?.title ?? 'плейлист'
  if (ids.includes(track.id)) return toast(`Уже есть в «${title}»`)
  await updatePlaylist(id, { tracks: [...ids, track.id] })
  toast(`Добавлено в «${title}»`)
}

async function removeFromPlaylist(id, trackId) {
  await updatePlaylist(id, { tracks: (await playlistTrackIds(id)).filter(t => t !== trackId) })
}

function openPlaylistDialog(track) {
  pendingTrack = track ?? null
  const local = Object.values(loadLocalPlaylists())
  $('#playlist-picker').innerHTML = [
    // Записывать в SoundCloud получается только из приложения на iPhone: с ПК DataDome отвечает 403.
    ...(native ? ownPlaylists() : []).map(p => `<button class="menu-item" data-add-sc-playlist="${p.id}"><svg aria-hidden="true"><use href="#i-playlist"/></svg>${esc(p.title)} · ${countOf(p.track_count, TRACK_FORMS)}</button>`),
    ...local.map(p => `<button class="menu-item" data-add-playlist="${p.id}"><svg aria-hidden="true"><use href="#i-playlist"/></svg>${esc(p.name)} · в приложении</button>`),
  ].join('')
  $('#playlist-dialog').querySelector('.eyebrow').textContent = track ? 'Добавить в плейлист' : 'Новый плейлист'
  $('#playlist-picker').hidden = !track
  $('#playlist-dialog').showModal()
  if (!track) $('#new-playlist-form').name.focus()
}

function openRenameDialog(id) {
  const playlist = state.playlists.find(p => p.id === Number(id))
  const form = $('#rename-form')
  form.dataset.playlist = id
  form.name.value = playlist?.title ?? ''
  $('#rename-dialog').showModal()
  form.name.select()
}

// Удаление без системного окна: первое нажатие просит подтвердить, второе удаляет.
let deleteArmed = null

async function deletePlaylist(button) {
  const id = button.dataset.deleteScPlaylist
  if (deleteArmed !== id) {
    deleteArmed = id
    button.textContent = 'Точно удалить?'
    setTimeout(() => {
      if (deleteArmed !== id) return
      deleteArmed = null
      button.textContent = 'Удалить'
    }, 3000)
    return
  }
  deleteArmed = null
  try {
    await sc.api(`/playlists/${id}`, 'DELETE')
    await refreshPlaylists()
    toast('Плейлист удалён')
    go('library', null, false)
  } catch (err) {
    toast(`Не удалился: ${errorText(err)}`)
  }
}

function setSleepTimer(minutes) {
  clearTimeout(sleepTimer)
  sleepTimer = null
  sleepAt = null
  // На iPhone при заблокированном экране JS в WKWebView спит и setTimeout не срабатывает,
  // поэтому паузу ставит нативный таймер, а здесь остаётся только отметка для интерфейса.
  sc.setSleepTimer?.(minutes > 0 ? minutes * 60 : 0)
  if (minutes > 0) {
    sleepAt = Date.now() + minutes * 60000
    sleepTimer = setTimeout(() => {
      if (!sc.setSleepTimer) audio.pause()
      sleepAt = null
      toast('Таймер сна: пауза')
      refreshSettings()
    }, minutes * 60000)
    toast(`Пауза через ${minutes} мин`)
  } else if (minutes === 0) {
    toast('Таймер сна отключён')
  }
  refreshSettings()
}

const normalizeEnabled = () => localStorage.getItem('normalize') === '1'

// Компрессор — не настоящее выравнивание LUFS (для него нужен анализ всего трека заранее),
// а грубое сглаживание пиков: сближает громкость треков без предварительного анализа.
function applyNormalize(on) {
  if (!compressor) return
  compressor.threshold.value = on ? -28 : 0
  compressor.ratio.value = on ? 6 : 1
  compressor.knee.value = on ? 12 : 0
}

function ensureAudioGraph() {
  if (audioCtx || ios || !(audio instanceof HTMLMediaElement)) return
  try {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)()
    compressor = audioCtx.createDynamicsCompressor()
    analyser = audioCtx.createAnalyser()
    analyser.fftSize = 256
    audioCtx.createMediaElementSource(audio).connect(compressor).connect(audioCtx.destination)
    compressor.connect(analyser)
    applyNormalize(normalizeEnabled())
  } catch {
    // Web Audio недоступен в этом WebView — играем без выравнивания громкости.
  }
}

// Фон «Сейчас играет» пульсирует по басам. Только на ПК: на iOS звук, пропущенный через
// Web Audio, замолкает при блокировке экрана.
function startBeat() {
  const now = $('#now')
  if (ios || beatFrame || now.hidden || audio.paused) return
  ensureAudioGraph()
  if (!analyser) return
  const bins = new Uint8Array(analyser.frequencyBinCount)
  let level = 0
  const tick = () => {
    if (now.hidden || audio.paused) {
      beatFrame = 0
      now.style.setProperty('--beat', 0)
      return
    }
    analyser.getByteFrequencyData(bins)
    // Резкая атака и плавный спад, иначе фон дёргается на каждом кадре.
    level = Math.max((bins[1] + bins[2] + bins[3] + bins[4]) / 1020, level * 0.9)
    now.style.setProperty('--beat', (level ** 2).toFixed(3))
    beatFrame = requestAnimationFrame(tick)
  }
  beatFrame = requestAnimationFrame(tick)
}

// Без сети «Загрузки» строятся из данных, сохранённых при скачивании: гидрации через API
// там не будет, а без неё скачанный трек нельзя было даже включить.
const loadOfflineTracks = () => JSON.parse(localStorage.getItem('offlineTracks') ?? '{}')

function rememberOffline(tracks) {
  const saved = loadOfflineTracks()
  for (const t of tracks) {
    saved[t.id] = {
      id: t.id,
      title: t.title,
      permalink_url: t.permalink_url,
      artwork_url: t.artwork_url,
      full_duration: t.full_duration,
      playback_count: t.playback_count,
      likes_count: t.likes_count,
      reposts_count: t.reposts_count,
      genre: t.genre,
      created_at: t.created_at,
      release_date: t.release_date,
      user: { id: t.user.id, username: t.user.username, avatar_url: t.user.avatar_url },
    }
  }
  localStorage.setItem('offlineTracks', JSON.stringify(saved))
}

function forgetOffline(id) {
  const saved = loadOfflineTracks()
  delete saved[id]
  localStorage.setItem('offlineTracks', JSON.stringify(saved))
}

async function downloadTrack(track, quiet = false) {
  if (!quiet) toast(`Скачивается «${track.title}»…`)
  try {
    const { source } = await freshStream(track)
    if (source.hls) throw new Error('HLS-поток нельзя сохранить одним файлом')
    const meta = await sc.downloads.save(track, source.url)
    state.downloads.set(track.id, meta)
    rememberOffline([track])
    if (!quiet) toast(`Скачано: ${meta.title}`)
    return true
  } catch (err) {
    if (!quiet) toast(`Не скачалось: ${errorText(err)}`)
    return false
  }
}

const findTrack = id => [...lists.values()].flatMap(list => list.tracks).find(t => t.id === id)

function markDownloaded(id, done) {
  for (const button of document.querySelectorAll(`[data-download="${id}"]`)) {
    button.classList.toggle('is-done', done)
    button.setAttribute('aria-label', done ? 'Удалить загрузку' : 'Скачать для офлайна')
  }
}

async function toggleDownload(id) {
  if (state.downloads.has(id)) {
    await removeDownload(id)
    markDownloaded(id, false)
    return
  }
  const track = findTrack(id)
  if (track && await downloadTrack(track)) markDownloaded(id, true)
}

// Качаем по одному: параллельно телефон и так режет сеть, а после трёх подряд неудач
// дальше идти незачем — обычно это кончившийся интернет.
async function downloadList(listId) {
  const list = lists.get(listId)
  if (!list) return
  // «Всё» — это все лайки, а не только страницы, подгруженные прокруткой. Догружаем в свою
  // копию: курсор списка на экране двигает только прокрутка, иначе она потом падала на пустом
  // курсоре, и остаток лайков на экране так и не появлялся.
  const tracks = [...list.tracks]
  try {
    for (let next = list.next; next;) {
      const page = await sc.api(next.href)
      tracks.push(...await hydrate(next.pick(page)))
      next = page.next_href ? { ...next, href: page.next_href } : null
    }
  } catch (err) {
    toast(`Не догрузил список: ${errorText(err)}`)
  }
  const pending = uniqueTracks(tracks).filter(t => !encrypted(t) && !state.downloads.has(t.id))
  if (!pending.length) {
    toast('Всё уже скачано')
    return
  }
  let done = 0
  let failed = 0
  for (const track of pending) {
    toast(`Скачиваю ${done + failed + 1} из ${pending.length}: ${track.title}`)
    if (await downloadTrack(track, true)) {
      markDownloaded(track.id, true)
      done++
      failed = 0
    } else if (++failed >= 3) {
      break
    }
  }
  toast(`Скачано ${done} из ${pending.length}`)
}

async function removeDownload(id) {
  await sc.downloads.remove(id)
  state.downloads.delete(id)
  forgetOffline(id)
  refreshSettings()
}

async function exportLikes() {
  const pick = page => page.collection.map(item => item.track)
  let page = await sc.api(`/users/${state.me.id}/track_likes?limit=200&linked_partitioning=1`)
  const all = [...pick(page)]
  while (page.next_href) {
    page = await sc.api(page.next_href)
    all.push(...pick(page))
  }
  const data = all.filter(Boolean).map(t => ({ id: t.id, title: t.title, artist: t.user?.username, url: t.permalink_url }))
  return sc.saveFile(`cloudwave-likes-${today()}.json`, JSON.stringify(data, null, 2))
}

/* ---------- экраны ---------- */

const views = { home: renderHome, library: renderLibrary, history: renderHistory, recap: renderRecap, mix: renderMix, search: renderSearch, likes: renderLikes, playlist: renderPlaylist, system: renderSystem, user: renderUser, settings: renderSettings, localPlaylist: renderLocalPlaylist }

async function go(name, arg, remember = true) {
  if (remember) backStack.push(current)
  current = { name, arg }
  const token = ++navToken
  closeMenu()
  highlightNav()
  if (name === 'search' && searchInput.value !== (arg ?? '')) searchInput.value = arg ?? ''
  view.innerHTML = skeleton(name)
  main.scrollTop = 0

  const mount = html => {
    if (token !== navToken) return false
    view.innerHTML = html
    markCurrent()
    return true
  }
  try {
    await views[name](arg, mount)
  } catch (err) {
    mount(stateBlock('Не получилось загрузить', esc(errorText(err)), '<button class="btn" data-action="retry">Повторить</button>'))
  }
}

function back() {
  const prev = backStack.pop()
  if (prev) go(prev.name, prev.arg, false)
}

function highlightNav() {
  const items = [...document.querySelectorAll('.nav-item')]
  const active = items.find(item => item.dataset.view === current.name)
  for (const item of items) {
    item.classList.toggle('active', item === active)
    item.toggleAttribute('aria-current', item === active)
  }
  const indicator = $('.nav-indicator')
  indicator.classList.toggle('visible', Boolean(active))
  if (active) indicator.style.transform = `translateY(${active.offsetTop}px)`

  for (const item of document.querySelectorAll('.side-playlist')) {
    item.classList.toggle('active', current.name === 'playlist' && item.dataset.playlist === String(current.arg))
  }
}

function greeting() {
  const hour = new Date().getHours()
  const text = hour < 5 ? 'Доброй ночи' : hour < 12 ? 'Доброе утро' : hour < 18 ? 'Добрый день' : 'Добрый вечер'
  const name = state.me ? `, ${esc(state.me.first_name || state.me.username)}` : ''
  return `<h1 class="page-title">${text}${name}</h1>`
}

// Главная собирается из нескольких запросов и гидрации — это секунды. Поэтому показываем
// снимок прошлой отрисовки сразу, а свежие данные подкладываем следом.
const HOME_FRESH_MS = 5 * 60000

function homeSnapshot() {
  try {
    return JSON.parse(localStorage.getItem('homeSnapshot') ?? 'null')
  } catch {
    return null
  }
}

function saveHomeSnapshot() {
  const html = view.innerHTML
  const used = [...new Set([...html.matchAll(/data-list="(l\d+)"/g)].map(m => m[1]))]
  const snapshot = {
    at: Date.now(),
    html,
    lists: used.map(id => ({ id, tracks: lists.get(id)?.tracks ?? [], context: lists.get(id)?.context ?? null })),
  }
  try {
    localStorage.setItem('homeSnapshot', JSON.stringify(snapshot))
  } catch {
    // Снимок не влез в хранилище — не беда, просто главная будет собираться заново.
    localStorage.removeItem('homeSnapshot')
  }
}

async function renderHome(_arg, mount) {
  if (!state.me) {
    mount(`
      ${greeting()}
      <div class="connect">
        <div class="panel panel-main">
          <svg class="panel-mark" aria-hidden="true"><use href="#i-logo"/></svg>
          <h2>Подключи SoundCloud</h2>
          <p>Подтянутся твои лайки и плейлисты. Пароль вводится на странице SoundCloud, приложению достаётся только токен сессии.</p>
          <button class="btn btn-accent" data-action="login">Войти в SoundCloud</button>
        </div>
        <form class="panel" id="profile-form">
          <h2>Без входа</h2>
          <p>Вставь ссылку на свой профиль — будут видны публичные лайки и плейлисты.</p>
          <div class="field-row">
            <input class="field" name="url" placeholder="soundcloud.com/имя" required spellcheck="false">
            <button class="btn">Открыть</button>
          </div>
        </form>
      </div>
      ${genreSection()}`)
    return
  }

  const snapshot = homeSnapshot()
  if (snapshot?.html) {
    for (const list of snapshot.lists) {
      registerList(list.tracks, list.context, null, list.id)
      // Иначе следующий новый список получил бы номер уже занятый снимком.
      listSeq = Math.max(listSeq, Number(list.id.slice(1)))
    }
    if (!mount(snapshot.html)) return
    fillMixes()
    if (Date.now() - snapshot.at < HOME_FRESH_MS) return
    // Снимок устарел — обновляем молча, поверх уже показанного. Не вышло (нет сети) — снимок
    // остаётся на экране, а не сменяется экраном ошибки.
    return buildHome(html => {
      if (current.name !== 'home') return false
      view.innerHTML = html
      markCurrent()
      return true
    }).catch(() => {})
  }
  await buildHome(mount)
}

async function buildHome(mount) {
  // Подборки главной SoundCloud отдаются только с токеном; при входе по ссылке на профиль их нет.
  const [likes, selections, suggested] = await Promise.all([
    sc.api(`/users/${state.me.id}/track_likes?limit=20`),
    state.loggedIn ? sc.api('/mixed-selections?limit=12') : null,
    state.loggedIn ? sc.api('/me/suggested/users/who_to_follow?limit=5') : null,
  ])
  // Большой блок — только у подборки SoundCloud с треками: обычный плейлист или профиль из
  // «Недавно сыгранных» его кнопками не открыть, а без треков падала вся главная.
  const first = selections?.collection.find(s => selectionKey(s) === 'recently-played')?.items.collection[0]
  const recent = first?.kind === 'system-playlist' && first.tracks?.length ? first : null
  const [liked, recentTracks] = await Promise.all([
    hydrate(likes.collection.map(item => item.track)),
    recent ? hydrate(recent.tracks.slice(0, 5)) : [],
  ])
  const likesId = registerList(liked, { label: 'Лайки' })
  const recentId = registerList(recentTracks, { label: recent?.title })
  const feature = recentTracks.length ? featurePanel(recent, recentTracks, recentId) : ''

  const feed = selections
    ? selections.collection.map(s => selectionSection(s, feature)).join('')
    : state.playlists.length ? section('Плейлисты', `<div class="strip">${state.playlists.slice(0, 16).map(playlistCard).join('')}</div>`) : ''

  // Ушли с главной, пока она грузилась, — в снимок попала бы чужая страница (или её скелетон),
  // и следующие пять минут «Главная» показывала бы её.
  const ok = mount(`
    ${greeting()}
    <dl class="stats home-stats">
      <div><dt>Лайки</dt><dd>${fmtCount(state.me.likes_count)}</dd></div>
      <div><dt>Плейлисты</dt><dd>${fmtCount(state.playlists.length)}</dd></div>
      <div><dt>Подписки</dt><dd>${fmtCount(state.me.followings_count)}</dd></div>
      <div><dt>Сегодня в ушах</dt><dd>${fmtLong(listenedToday() * 1000)}</dd></div>
    </dl>
    <div class="home">
      <div class="home-main"><div id="cw-mixes"></div>${feed || genreSection()}</div>
      <aside class="home-aside">
        ${suggested?.collection.length ? asideBlock('Кого послушать', suggested.collection.map(item => userLine(item.user)).join('')) : ''}
        ${asideBlock('Лайки',
          liked.length ? liked.slice(0, 6).map((t, i) => miniRow(t, likesId, i)).join('') : '<p class="sidebar-empty">Лайков пока нет</p>',
          '<button class="section-link" data-view="likes">Все</button>')}
      </aside>
    </div>`)
  if (!ok) return
  saveHomeSnapshot()
  fillMixes()
}

// Миксы собираются из пары десятков запросов — главную ради них не держим.
function fillMixes() {
  if (!view.querySelector('#cw-mixes') || !state.loggedIn) return
  loadMixes().then(mixes => {
    const slot = view.querySelector('#cw-mixes')
    if (slot && mixes.length) slot.outerHTML = section('От Cloudwave', `<div class="strip">${mixes.map(mixCard).join('')}</div>`)
    if (current.name === 'home') saveHomeSnapshot()
  }, err => toast(`Не собрал миксы: ${errorText(err)}`))
}

async function renderMix(id, mount) {
  const mix = (await loadMixes()).find(m => m.id === id)
  if (!mix) {
    mount(stateBlock('Микс обновился', 'Миксы пересобираются раз в сутки, свежие — на главной.', '<button class="btn" data-view="home">На главную</button>', 'i-playlist'))
    return
  }
  const tracks = await hydrate(mix.trackIds.map(trackId => ({ id: trackId })))
  const listId = registerList(tracks, { label: mix.title })
  mount(`
    <header class="hero">
      ${mixArt(mix, 'hero-art')}
      <div class="hero-info">
        <p class="eyebrow">Микс от Cloudwave · обновляется каждый день</p>
        <h1 class="hero-title">${esc(mix.title)}</h1>
        <p class="meta"><span>${esc(mix.about)}</span><span>${countOf(tracks.length, TRACK_FORMS)}</span></p>
        ${heroActions(listId, tracks.length, `<button class="btn" data-save-mix="${listId}" data-mix-title="${esc(mix.title)}"><svg aria-hidden="true"><use href="#i-playlist"/></svg>Сохранить</button>`)}
      </div>
    </header>
    ${trackTable(tracks, listId)}`)
}

async function historyStats(days) {
  const tracks = new Map((await hydrate([...new Set(history.map(h => h.id))].map(id => ({ id })))).map(t => [t.id, t]))
  const since = Date.now() - days * 864e5
  const sinceDay = new Date(since).toLocaleDateString('sv')
  const plays = history.filter(h => h.at >= since && tracks.has(h.id))
  const allDays = new Set([...Object.keys(listenedDays), ...Object.values(peerListened).flatMap(Object.keys)])
  const seconds = [...allDays].filter(day => day > sinceDay).reduce((sum, day) => sum + daySeconds(day), 0)
  const trackCounts = new Map()
  const artistCounts = new Map()
  for (const { id } of plays) {
    const track = tracks.get(id)
    trackCounts.set(track, (trackCounts.get(track) ?? 0) + 1)
    artistCounts.set(track.user, (artistCounts.get(track.user) ?? 0) + 1)
  }
  // Один автор приходит разными объектами у разных треков — сводим по id.
  const byArtist = new Map()
  for (const [user, n] of artistCounts) byArtist.set(user.id, [user, (byArtist.get(user.id)?.[1] ?? 0) + n])
  const top = counts => [...counts].sort((a, b) => b[1] - a[1]).slice(0, 5)
  return { tracks, plays, seconds, trackCounts, topTracks: top(trackCounts), topArtists: top(byArtist.values()) }
}

async function renderRecap(_arg, mount) {
  const stats = await historyStats(7)
  if (!stats.plays.length) {
    mount(`<h1 class="page-title">Итоги недели</h1>${stateBlock('Неделя пустая', 'Послушай что-нибудь — итоги соберутся из истории.', '<button class="btn" data-view="home">На главную</button>', 'i-history')}`)
    return
  }
  const [artist, artistPlays] = stats.topArtists[0]
  const listId = registerList(stats.topTracks.map(([t]) => t), { label: 'Итоги недели' })
  mount(`
    <div class="recap">
      <section class="recap-slide recap-minutes">
        <p class="eyebrow">Итоги недели · ${esc(recapRange())}</p>
        <p class="recap-huge">${fmtCount(Math.round(stats.seconds / 60))}</p>
        <p class="recap-caption">${plural(Math.round(stats.seconds / 60), ['минута', 'минуты', 'минут'])} музыки, ${countOf(stats.plays.length, ['прослушивание', 'прослушивания', 'прослушиваний'])}</p>
      </section>
      <section class="recap-slide recap-artist">
        <p class="eyebrow">Автор недели</p>
        ${artBox(artUrl(artist.avatar_url, 't500x500'), 'round recap-avatar')}
        <p class="recap-name">${esc(artist.username)}</p>
        <p class="recap-caption">${countOf(artistPlays, ['прослушивание', 'прослушивания', 'прослушиваний'])}</p>
      </section>
      <section class="recap-slide recap-tracks">
        <p class="eyebrow">Треки недели</p>
        ${stats.topTracks.map(([t, n], i) => `
          <div class="recap-track" role="button" tabindex="0" data-list="${listId}" data-index="${i}" data-track="${t.id}">
            <span class="recap-rank">${i + 1}</span>
            ${artBox(cover(t, 't300x300'))}
            <span class="row-main"><span class="row-title">${esc(t.title)}</span><span class="user-stats">${esc(t.user.username)} · ${n}×</span></span>
          </div>`).join('')}
      </section>
      <button class="btn btn-accent recap-share" data-action="shareRecap">Поделиться картинкой</button>
    </div>`)
  recapStats = stats
  // Картинку рисуем сразу: к нажатию «Поделиться» она готова, и лист открывается в том же жесте.
  // Когда её рисовали по нажатию, пока грузились обложки, жест истекал, и iOS отказывал navigator.share.
  recapPicture = recapImage(stats)
  recapPicture.catch(() => {})
}

let recapStats = null
let recapPicture = null

function recapRange() {
  const fmt = date => date.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' })
  return `${fmt(new Date(Date.now() - 6 * 864e5))} — ${fmt(new Date())}`
}

function loadImage(url) {
  return new Promise(resolve => {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => resolve(img)
    img.onerror = () => resolve(null)
    img.src = url
  })
}

// Картинка 1080×1920 под сторис: цифры недели, автор и пять треков.
async function recapImage(stats) {
  const canvas = document.createElement('canvas')
  canvas.width = 1080
  canvas.height = 1920
  const ctx = canvas.getContext('2d')
  const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()
  const bg = ctx.createLinearGradient(0, 0, 1080, 1920)
  bg.addColorStop(0, '#2a1a4a')
  bg.addColorStop(1, '#0c0814')
  ctx.fillStyle = bg
  ctx.fillRect(0, 0, 1080, 1920)
  ctx.fillStyle = '#b58cff'
  ctx.fillStyle = accent
  ctx.globalAlpha = 0.35
  ctx.beginPath()
  ctx.arc(900, 260, 420, 0, Math.PI * 2)
  ctx.fill()
  ctx.globalAlpha = 1

  const font = (weight, size) => `${weight} ${size}px "Inter Variable", system-ui, sans-serif`
  ctx.fillStyle = '#f4efff'
  ctx.font = font(600, 40)
  ctx.fillText(`CLOUDWAVE · ${recapRange().toUpperCase()}`, 80, 140)
  ctx.font = font(800, 260)
  ctx.fillText(fmtCount(Math.round(stats.seconds / 60)), 72, 420)
  ctx.font = font(500, 52)
  ctx.fillText(`${plural(Math.round(stats.seconds / 60), ['минута', 'минуты', 'минут'])} музыки за неделю`, 80, 500)

  const [artist] = stats.topArtists[0]
  const avatar = await loadImage(artUrl(artist.avatar_url, 't500x500'))
  if (avatar) {
    ctx.save()
    ctx.beginPath()
    ctx.arc(230, 760, 150, 0, Math.PI * 2)
    ctx.clip()
    ctx.drawImage(avatar, 80, 610, 300, 300)
    ctx.restore()
  }
  ctx.font = font(500, 40)
  ctx.fillText('Автор недели', 420, 730)
  ctx.font = font(800, 72)
  ctx.fillText(artist.username.slice(0, 18), 420, 815)

  ctx.font = font(500, 40)
  ctx.fillText('Треки недели', 80, 1060)
  const covers = await Promise.all(stats.topTracks.map(([t]) => loadImage(cover(t, 't300x300'))))
  stats.topTracks.forEach(([t], i) => {
    const y = 1110 + i * 150
    if (covers[i]) ctx.drawImage(covers[i], 80, y, 120, 120)
    ctx.font = font(800, 56)
    ctx.fillText(t.title.length > 24 ? `${t.title.slice(0, 23)}…` : t.title, 230, y + 60)
    ctx.font = font(500, 38)
    ctx.globalAlpha = 0.7
    ctx.fillText(t.user.username.slice(0, 30), 230, y + 108)
    ctx.globalAlpha = 1
  })
  return new Promise(resolve => canvas.toBlob(resolve, 'image/png'))
}

function localPlaylistCard(playlist) {
  return `
    <button class="card" data-local-playlist="${playlist.id}">
      <span class="art"><svg class="card-mark" aria-hidden="true"><use href="#i-playlist"/></svg></span>
      <span class="card-title" title="${esc(playlist.name)}">${esc(playlist.name)}</span>
      <span class="card-meta">${countOf(playlist.trackIds.length, TRACK_FORMS)}</span>
    </button>`
}

async function renderLibrary(_arg, mount) {
  const local = Object.values(loadLocalPlaylists())
  const own = ownPlaylists()
  const liked = state.playlists.filter(p => p.user?.id !== state.me?.id)
  const downloaded = [...state.downloads.values()]
  const recent = history.slice(0, 20)
  const totals = lifetimeTotals()

  const ok = mount(`
    <h1 class="page-title">Моё</h1>
    <dl class="stats library-stats">
      <div><dt>Прослушано песен</dt><dd>${fmtCount(totals.plays)}</dd></div>
      <div><dt>Всего</dt><dd>${fmtLong(totals.seconds * 1000)}</dd></div>
      <div><dt>Сегодня</dt><dd>${fmtLong(listenedToday() * 1000)}</dd></div>
      <div><dt>Разных треков</dt><dd>${fmtCount(totals.tracks)}</dd></div>
      <div><dt>Разных авторов</dt><dd>${fmtCount(totals.artists)}</dd></div>
      <div><dt>Дней подряд</dt><dd>${listeningStreak()}</dd></div>
    </dl>
    ${section('Мои плейлисты', own.length || local.length
      ? `<div class="strip">${own.map(playlistCard).join('')}${local.map(localPlaylistCard).join('')}</div>`
      : `<p class="sidebar-empty">${state.loggedIn ? 'Пока пусто. Создай плейлист — он появится и в SoundCloud.' : 'Плейлисты создаются в аккаунте SoundCloud — сначала войди.'}</p>`,
      state.loggedIn ? '<button class="section-link" data-action="createPlaylist">Новый</button>' : '')}
    ${liked.length ? section('Лайкнутые плейлисты', `<div class="strip">${liked.map(playlistCard).join('')}</div>`) : ''}
    ${section('Загрузки', downloaded.length
      ? `<div id="library-downloads">${downloaded.map(d => `<div class="setting-list-row"><span class="setting-list-title">${esc(d.title)} — ${esc(d.artist)}</span></div>`).join('')}</div>`
      : '<p class="sidebar-empty">Скачанных треков нет.</p>')}
    ${section('Недавно слушал', recent.length ? '<div id="library-recent"></div>' : '<p class="sidebar-empty">История пуста.</p>',
      '<button class="section-link" data-view="history">Вся история</button>')}`)
  if (!ok) return

  const fill = (selector, tracks, label, limit = tracks.length) => {
    const slot = view.querySelector(selector)
    if (!slot || !tracks.length) return
    const listId = registerList(tracks, { label })
    slot.innerHTML = tracks.slice(0, limit).map((t, i) => miniRow(t, listId, i)).join('')
    markCurrent()
  }

  // Без сети гидрация падает — тогда загрузки строятся из данных, сохранённых при скачивании
  // (раньше оставались одни названия, и скачанное офлайн было не включить). Трек могли удалить
  // из SoundCloud, а копия осталась — её тоже показываем.
  if (downloaded.length) {
    const ids = downloaded.map(d => d.id)
    hydrate(ids.map(id => ({ id }))).then(tracks => {
      rememberOffline(tracks)
      return tracks
    }, () => []).then(tracks => {
      const full = new Map(tracks.map(t => [t.id, t]))
      const saved = loadOfflineTracks()
      fill('#library-downloads', ids.map(id => full.get(id) ?? saved[id]).filter(Boolean), 'Загрузки')
    })
  }
  if (!recent.length) return

  // Без сети не валим всю страницу вместе с загрузками — пустеет только этот раздел.
  let tracks
  try {
    tracks = await hydrate([...new Set(recent.map(h => h.id))].map(id => ({ id })))
  } catch {
    const slot = view.querySelector('#library-recent')
    if (slot) slot.innerHTML = '<p class="sidebar-empty">Без сети не загрузилось.</p>'
    return
  }
  fill('#library-recent', tracks, 'Недавно слушал', 8)
}

async function renderHistory(period = '7', mount) {
  if (!history.length) {
    mount(`<h1 class="page-title">История</h1>${stateBlock('Пока пусто', 'Здесь будет всё, что играло в Cloudwave.', '', 'i-history')}`)
    return
  }
  const { tracks, plays, seconds, trackCounts, topTracks, topArtists } = await historyStats(Number(period))
  const topListId = registerList(topTracks.map(([t]) => t), { label: 'Чаще всего' })

  const days = new Map()
  for (const { id, at } of history.slice(0, 200)) {
    const track = tracks.get(id)
    if (track) days.set(dayLabel(at), [...(days.get(dayLabel(at)) ?? []), track])
  }

  mount(`
    <h1 class="page-title">История</h1>
    <div class="chips history-periods">
      <button class="chip" data-view="recap">Итоги недели</button>
      ${[['7', 'Неделя'], ['30', 'Месяц']].map(([value, label]) => `<button class="chip" data-history-period="${value}" aria-pressed="${value === period}">${label}</button>`).join('')}
    </div>
    <dl class="stats">
      <div><dt>Прослушиваний</dt><dd>${fmtCount(plays.length)}</dd></div>
      <div><dt>Разных треков</dt><dd>${fmtCount(trackCounts.size)}</dd></div>
      <div><dt>Время</dt><dd>${fmtLong(seconds * 1000)}</dd></div>
    </dl>
    ${topTracks.length ? `<div class="home">
      <div class="home-main">${section('Чаще всего', topTracks.map(([t], i) => miniRow(t, topListId, i)).join(''))}</div>
      <aside class="home-aside">${asideBlock('Любимые авторы', topArtists.map(([user, n]) => `
        <button class="user-line" data-user="${user.id}">
          ${artBox(user.avatar_url, 'round')}
          <span class="row-main">
            <span class="row-title">${esc(user.username)}</span>
            <span class="user-stats">${countOf(n, ['прослушивание', 'прослушивания', 'прослушиваний'])}</span>
          </span>
        </button>`).join(''))}</aside>
    </div>` : ''}
    ${[...days].map(([label, dayTracks]) => section(label, trackTable(dayTracks, registerList(dayTracks, { label: 'История' })))).join('')}`)
}

async function renderSearch(query, mount) {
  const q = query?.trim()
  if (!q) {
    mount(`<h1 class="page-title">Поиск</h1>${genreSection()}`)
    searchInput.focus()
    return
  }

  const params = `q=${encodeURIComponent(q)}`
  // Авторы и плейлисты второстепенны: если упал только их запрос, треки всё равно показываем.
  const empty = { collection: [] }
  const [tracks, playlists, users] = await Promise.all([
    sc.api(`/search/tracks?${params}&limit=30&linked_partitioning=1`),
    sc.api(`/search/playlists?${params}&limit=12`).catch(() => empty),
    sc.api(`/search/users?${params}&limit=8`).catch(() => empty),
  ])
  const found = tracks.collection.filter(listable)
  const id = registerList(found, { label: `Поиск «${q}»` }, tracks.next_href && { href: tracks.next_href, pick: page => page.collection })

  if (!found.length && !playlists.collection.length && !users.collection.length) {
    mount(`<h1 class="page-title">«${esc(q)}»</h1>${stateBlock('Ничего не нашлось', 'Попробуй написать иначе или латиницей — SoundCloud ищет по оригинальным названиям.')}`)
    return
  }

  const ok = mount(`
    <h1 class="page-title">«${esc(q)}»</h1>
    <p class="page-sub">${countOf(tracks.total_results ?? found.length, TRACK_FORMS)} на SoundCloud</p>
    ${users.collection.length ? section('Авторы', `<div class="strip">${users.collection.map(userCard).join('')}</div>`) : ''}
    ${playlists.collection.length ? section('Плейлисты', `<div class="strip">${playlists.collection.map(playlistCard).join('')}</div>`) : ''}
    ${found.length ? section('Треки', trackTable(found, id)) : ''}`)
  if (ok) attachPager(id)
}

async function renderLikes(_arg, mount) {
  if (!state.me) {
    mount(`<h1 class="page-title">Лайки</h1>${stateBlock('Лайков пока не видно', 'Войди в SoundCloud или вставь ссылку на профиль на главной.', '<button class="btn" data-view="home">На главную</button>', 'i-heart')}`)
    return
  }

  const pick = page => page.collection.map(item => item.track)
  const page = await sc.api(`/users/${state.me.id}/track_likes?limit=50&linked_partitioning=1`)
  const tracks = await hydrate(pick(page))
  const id = registerList(tracks, { label: 'Лайки' }, page.next_href && { href: page.next_href, pick })

  const ok = mount(`
    <header class="hero">
      <span class="art hero-art hero-art-likes"><svg aria-hidden="true"><use href="#i-heart"/></svg></span>
      <div class="hero-info">
        <p class="eyebrow">Коллекция</p>
        <h1 class="hero-title">Лайки</h1>
        <p class="meta"><span>${esc(state.me.username)}</span><span>${countOf(state.me.likes_count, TRACK_FORMS)}</span></p>
        ${heroActions(id, tracks.length, native ? `<button class="btn" data-download-all="${id}"><svg aria-hidden="true"><use href="#i-download"/></svg>Скачать всё</button>` : '')}
      </div>
    </header>
    ${tracks.length ? trackTable(tracks, id) : stateBlock('Пусто', 'Лайкни что-нибудь в SoundCloud — появится здесь.', '', 'i-heart')}`)
  if (ok) attachPager(id)
}

const playlistLiked = id => state.playlists.some(p => p.id === Number(id))

async function togglePlaylistLike(id) {
  if (!state.loggedIn) return toast('Нужен вход в SoundCloud')
  const liked = playlistLiked(id)
  try {
    await sc.api(`/users/${state.me.id}/playlist_likes/${id}`, liked ? 'DELETE' : 'PUT')
    state.playlists = await loadPlaylists()
    renderSidebarPlaylists()
    for (const button of document.querySelectorAll(`[data-like-playlist="${id}"]`)) {
      button.setAttribute('aria-pressed', !liked)
      button.querySelector('use').setAttribute('href', liked ? '#i-heart' : '#i-heart-filled')
    }
    toast(liked ? 'Плейлист убран из лайков' : 'Плейлист в лайках')
  } catch (err) {
    toast(`Не получилось: ${errorText(err)}`)
  }
}

async function renderPlaylist(playlistId, mount) {
  const playlist = await sc.api(`/playlists/${playlistId}`)
  const tracks = await hydrate(playlist.tracks)
  const listId = registerList(tracks, { label: playlist.title })
  const missing = playlist.track_count - tracks.length
  const art = artUrl(playlist.artwork_url || tracks[0]?.artwork_url || playlist.user.avatar_url)

  mount(`
    <header class="hero">
      ${artBox(art, 'hero-art')}
      <div class="hero-info">
        <p class="eyebrow">${playlist.is_album ? 'Альбом' : 'Плейлист'}</p>
        <h1 class="hero-title">${esc(playlist.title)}</h1>
        <p class="meta">
          <button class="link" data-user="${playlist.user.id}">${esc(playlist.user.username)}</button>
          <span>${countOf(playlist.track_count, TRACK_FORMS)}</span>
          <span>${fmtLong(playlist.duration)}</span>
          <span>обновлён ${fmtDate(playlist.last_modified)}</span>
          ${missing > 0 ? `<span class="warn">${missing} недоступно</span>` : ''}
        </p>
        ${playlist.user.id === state.me?.id ? `
          <div class="hero-actions hero-manage">
            <button class="btn" data-rename-sc-playlist="${playlist.id}">Переименовать</button>
            <button class="btn" data-sharing-sc-playlist="${playlist.id}" data-sharing="${playlist.sharing}">${playlist.sharing === 'private' ? 'Открыть всем' : 'Сделать приватным'}</button>
            <button class="btn" data-delete-sc-playlist="${playlist.id}">Удалить</button>
          </div>` : ''}
        ${heroActions(listId, tracks.length, state.loggedIn && playlist.user.id !== state.me.id ? `<button class="btn like-btn" data-like-playlist="${playlist.id}" aria-pressed="${playlistLiked(playlist.id)}" aria-label="Лайкнуть плейлист"><svg aria-hidden="true"><use href="#${playlistLiked(playlist.id) ? 'i-heart-filled' : 'i-heart'}"/></svg></button>` : '')}
      </div>
    </header>
    ${tracks.length ? trackTable(tracks, listId) : stateBlock('Слушать нечего', 'Треки из этого плейлиста удалены или закрыты для твоего региона.', '', 'i-playlist')}`)
}

const loadSystemPlaylist = urn => sc.api(`/system-playlists/${encodeURIComponent(urn)}`)

async function renderSystem(urn, mount) {
  const playlist = await loadSystemPlaylist(urn)
  const tracks = await hydrate(playlist.tracks)
  const listId = registerList(tracks, { label: playlist.title })

  mount(`
    <header class="hero">
      ${artBox(artUrl(playlist.calculated_artwork_url || playlist.artwork_url), 'hero-art')}
      <div class="hero-info">
        <p class="eyebrow">Подборка SoundCloud</p>
        <h1 class="hero-title">${esc(playlist.title)}</h1>
        <p class="meta">
          ${playlist.short_description ? `<span>${esc(playlist.short_description)}</span>` : ''}
          <span>${countOf(tracks.length, TRACK_FORMS)}</span>
          ${playlist.last_updated ? `<span>обновлено ${fmtDate(playlist.last_updated)}</span>` : ''}
        </p>
        ${heroActions(listId, tracks.length)}
      </div>
    </header>
    ${tracks.length ? trackTable(tracks, listId) : stateBlock('Подборка пуста', 'SoundCloud пока ничего сюда не положил.', '', 'i-playlist')}`)
}

async function renderUser(userId, mount) {
  // Популярное и плейлисты второстепенны: если упал только их запрос, страницу автора всё равно показываем.
  const empty = { collection: [] }
  const [user, top, page, playlists] = await Promise.all([
    sc.api(`/users/${userId}`),
    sc.api(`/users/${userId}/toptracks?limit=10`).catch(() => empty),
    sc.api(`/users/${userId}/tracks?limit=30&linked_partitioning=1`),
    sc.api(`/users/${userId}/playlists?limit=12`).catch(() => empty),
  ])
  const topTracks = top.collection.filter(listable).slice(0, 5)
  const all = page.collection.filter(listable)
  const topId = registerList(topTracks, { label: user.username })
  const allId = registerList(all, { label: user.username }, page.next_href && { href: page.next_href, pick: p => p.collection })
  const place = [user.city, user.country_code].filter(Boolean).join(', ')

  const ok = mount(`
    <header class="hero">
      ${artBox(artUrl(user.avatar_url), 'hero-art round')}
      <div class="hero-info">
        <p class="eyebrow">Автор${user.verified ? ' · подтверждён' : ''}</p>
        <h1 class="hero-title">${esc(user.username)}</h1>
        <p class="meta">
          ${place ? `<span>${esc(place)}</span>` : ''}
          <span>${countOf(user.followers_count, ['подписчик', 'подписчика', 'подписчиков'])}</span>
          <span>${countOf(user.track_count, TRACK_FORMS)}</span>
          <a class="link" href="${esc(user.permalink_url)}" target="_blank">SoundCloud</a>
        </p>
        ${heroActions(topTracks.length ? topId : allId, topTracks.length || all.length)}
      </div>
    </header>
    ${topTracks.length ? section('Популярное', trackTable(topTracks, topId)) : ''}
    ${playlists.collection.length ? section('Плейлисты', `<div class="strip">${playlists.collection.map(playlistCard).join('')}</div>`) : ''}
    ${section('Все треки', all.length ? trackTable(all, allId) : stateBlock('Треков нет', 'Автор пока ничего не выложил.', '', 'i-playlist'))}`)
  if (ok) attachPager(allId)
}

async function renderLocalPlaylist(id, mount) {
  const playlist = loadLocalPlaylists()[id]
  if (!playlist) {
    mount(stateBlock('Плейлист не найден', 'Возможно, его удалили в настройках.', '<button class="btn" data-view="settings">К настройкам</button>', 'i-playlist'))
    return
  }
  const tracks = await hydrate(playlist.trackIds.map(trackId => ({ id: trackId })))
  const listId = registerList(tracks, { label: playlist.name })

  mount(`
    <header class="hero">
      <span class="art hero-art hero-art-likes"><svg aria-hidden="true"><use href="#i-playlist"/></svg></span>
      <div class="hero-info">
        <p class="eyebrow">Локальный плейлист</p>
        <h1 class="hero-title">${esc(playlist.name)}</h1>
        <p class="meta"><span>${countOf(tracks.length, TRACK_FORMS)}</span></p>
        ${heroActions(listId, tracks.length)}
      </div>
    </header>
    ${tracks.length ? trackTable(tracks, listId) : stateBlock('Пусто', 'Добавляй треки через «⋯» → «В плейлист».', '', 'i-playlist')}`)
}

function renderSettings(_arg, mount) {
  sc.sync?.info?.().then(info => {
    const slot = view.querySelector('#sync-info')
    if (slot) slot.innerHTML = `Адрес: <b>${esc(info.address)}</b><br>Ключ: <b>${esc(info.key)}</b>`
  })
  sc.discord?.get().then(id => {
    const input = view.querySelector('#discord-id')
    if (input) input.value = id
  })
  const playlists = Object.values(loadLocalPlaylists())
  const downloaded = [...state.downloads.values()]
  const totalSize = downloaded.reduce((sum, d) => sum + (d.size || 0), 0)
  const on = normalizeEnabled()

  mount(`
    <h1 class="page-title">Настройки</h1>

    ${section('Оформление', `
      <div class="setting-row">
        <span class="setting-label"><b>Тема</b></span>
        <div class="chips">
          ${THEMES.map(([value, label]) => `<button class="chip" data-theme-set="${value}" aria-pressed="${themeChoice() === value}">${label}</button>`).join('')}
        </div>
      </div>
      <div class="setting-row">
        <span class="setting-label"><b>Акцент</b><br>По умолчанию цвет берётся из обложки трека.</span>
        <div class="chips">
          ${ACCENTS.map(([value, label]) => `<button class="chip swatch" data-accent-set="${value}" aria-pressed="${accentChoice() === value}" title="${label}"${value === 'cover' ? '' : ` style="--swatch: oklch(0.7 0.15 ${value})"`}>${value === 'cover' ? label : ''}</button>`).join('')}
        </div>
      </div>
      ${sc.setIcon ? `<div class="setting-row">
        <span class="setting-label"><b>Иконка приложения</b></span>
        <div class="chips">
          ${[['default', 'Обычная'], ['AppIconDark', 'Тёмная'], ['AppIconLight', 'Светлая'], ['AppIconNeon', 'Неон']].map(([value, label]) => `<button class="chip" data-icon-set="${value}" aria-pressed="${(localStorage.getItem('appIcon') ?? 'default') === value}">${label}</button>`).join('')}
        </div>
      </div>` : ''}`)}

    ${section('Аккаунт', `
      <div class="setting-row">
        <span class="setting-label">${state.me ? `<b>${esc(state.me.username)}</b><br>${state.loggedIn ? 'Вход через SoundCloud' : 'По ссылке на профиль, без входа'}` : 'Не выполнен вход'}</span>
        ${state.me ? '<button class="btn" data-action="logout">Выйти</button>' : '<button class="btn btn-accent" data-action="login">Войти в SoundCloud</button>'}
      </div>`)}

    ${sc.sync ? section('Синхронизация', sc.sync.pull ? `
      <form class="setting-row" id="sync-form">
        <span class="setting-label"><b>Связать с компьютером</b><br>На ПК открой Настройки → Синхронизация и перепиши оттуда адрес и ключ. Оба устройства должны быть в одном Wi-Fi.</span>
        <span class="field-row">
          <input class="field" name="address" value="${esc(syncPeer()?.address ?? '')}" placeholder="192.168.0.10:47821" inputmode="url" autocomplete="off" spellcheck="false">
          <input class="field" name="key" value="${esc(syncPeer()?.key ?? '')}" placeholder="ключ" autocomplete="off" spellcheck="false">
          <button class="btn">Связать</button>
        </span>
      </form>
      <div class="setting-row">
        <span class="setting-label">${localStorage.getItem('syncedAt') ? `Последний раз: ${new Date(Number(localStorage.getItem('syncedAt'))).toLocaleString('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' })}` : 'Ещё не синхронизировались'}</span>
        <button class="btn" data-action="syncNow"${syncPeer()?.address ? '' : ' disabled'}>Синхронизировать</button>
      </div>` : `
      <div class="setting-row">
        <span class="setting-label"><b>Для телефона</b><br>Введи это в Cloudwave на iPhone: Настройки → Синхронизация. Переносятся история, статистика, свои плейлисты и очередь — только если аккаунт SoundCloud тот же.</span>
        <span class="setting-label" id="sync-info">…</span>
      </div>`) : ''}

    ${section('Аудио', `
      <div class="setting-row"${audio instanceof HTMLMediaElement && !ios ? '' : ' hidden'}>
        <span class="setting-label"><b>Выравнивать громкость</b><br>Компрессор сглаживает пики между тихими и громкими треками. Экспериментально.</span>
        <button class="btn" data-action="toggleNormalize" aria-pressed="${on}">${on ? 'Включено' : 'Выключено'}</button>
      </div>
      <div class="setting-row">
        <span class="setting-label"><b>Скрывать DRM-треки</b><br>Лейбловые треки SoundCloud отдаёт только с защитой, сторонние плееры их не играют.</span>
        <button class="btn" data-action="toggleHideDrm" aria-pressed="${hideDrm()}">${hideDrm() ? 'Включено' : 'Выключено'}</button>
      </div>`)}

    ${section('Таймер сна', `
      <div class="setting-row">
        <span class="setting-label">${sleepAt ? `Пауза в ${new Date(sleepAt).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}` : 'Не установлен'}</span>
        <div class="chips">
          ${[15, 30, 45, 60].map(m => `<button class="chip" data-sleep="${m}">${m} мин</button>`).join('')}
          ${sleepAt ? '<button class="chip" data-sleep="0">Отключить</button>' : ''}
        </div>
      </div>`)}

    ${section('Загрузки', downloaded.length ? `
      <p class="page-sub">${countOf(downloaded.length, TRACK_FORMS)} · ${fmtSize(totalSize)}</p>
      <div class="setting-list">
        ${downloaded.map(d => `
          <div class="setting-list-row">
            <span class="setting-list-title">${esc(d.title)} — ${esc(d.artist)}</span>
            <button class="icon-btn" data-remove-download="${d.id}" aria-label="Удалить загрузку"><svg aria-hidden="true"><use href="#i-close"/></svg></button>
          </div>`).join('')}
      </div>` : stateBlock('Загрузок нет', 'Качай треки через «⋯» → «Скачать для офлайна».', '', 'i-download'))}

    ${section('Плейлисты', `
      ${playlists.length ? `<div class="setting-list">
        ${playlists.map(p => `
          <div class="setting-list-row">
            <button class="link" data-local-playlist="${p.id}">${esc(p.name)} · ${countOf(p.trackIds.length, TRACK_FORMS)}</button>
            <button class="icon-btn" data-delete-playlist="${p.id}" aria-label="Удалить плейлист"><svg aria-hidden="true"><use href="#i-close"/></svg></button>
          </div>`).join('')}
      </div>` : '<p class="sidebar-empty">Пока нет ни одного</p>'}
      <button class="btn" data-action="createPlaylist" style="margin-top: 12px">Создать плейлист</button>
      <button class="btn" data-action="importPlaylist" style="margin-top: 12px">Импорт JSON</button>`)}

    ${sc.discord ? section('Discord', `
      <form class="setting-row" id="discord-form">
        <span class="setting-label"><b>Статус «Слушает»</b><br>Создай приложение на discord.com/developers/applications и вставь его Application ID. Имя приложения Discord покажет в статусе. Пустое поле выключает статус.</span>
        <span class="field-row">
          <input class="field" name="discordId" id="discord-id" inputmode="numeric" pattern="\\d{17,20}" placeholder="Application ID" autocomplete="off">
          <button class="btn">Сохранить</button>
        </span>
      </form>`) : ''}

    ${section('Горячие клавиши', `
      <dl class="hotkeys">
        ${[
          ['Пробел', 'Играть / пауза'],
          ['← →', 'Перемотка на 5 с'],
          ['Ctrl + ← →', 'Предыдущий / следующий трек'],
          ['Ctrl + ↑ ↓', 'Громкость'],
          ['M', 'Звук вкл/выкл'],
          ['L', 'Лайк'],
          ['S / R', 'Перемешать / повтор'],
          ['Q', 'Очередь'],
          ['/ или Ctrl + K', 'Поиск'],
        ].map(([keys, what]) => `<div><dt><kbd>${keys}</kbd></dt><dd>${what}</dd></div>`).join('')}
      </dl>`)}

    ${section('Резервная копия', `
      <div class="setting-row">
        <span class="setting-label">Список лайков в JSON — на случай проблем с аккаунтом SoundCloud.</span>
        <button class="btn" data-action="backupLikes"${state.me ? '' : ' disabled'}>Скачать</button>
      </div>`)}

    ${localStorage.getItem('nowPlayingStatus') ? section('Диагностика', `
      <div class="setting-row">
        <span class="setting-label">Экран блокировки (NowPlaying)</span>
        <span class="setting-label">${esc(localStorage.getItem('nowPlayingStatus'))}</span>
      </div>`) : ''}`)
}

function renderAccount() {
  const el = $('#account')
  if (!state.me) {
    el.innerHTML = '<button class="btn btn-block" data-action="login"><svg aria-hidden="true"><use href="#i-user"/></svg>Войти в SoundCloud</button>'
    return
  }
  el.innerHTML = `
    <div class="account-row">
      ${artBox(state.me.avatar_url, 'round')}
      <span class="account-meta">
        <span class="account-name">${esc(state.me.username)}</span>
        <span class="account-sub">${state.loggedIn ? 'Вход через SoundCloud' : 'По ссылке, без входа'}</span>
      </span>
      ${state.loggedIn && sc.pairPhone ? '<button class="icon-btn" data-action="pairPhone" aria-label="Войти на телефоне" title="Войти на телефоне"><svg><use href="#i-phone"/></svg></button>' : ''}
      <button class="icon-btn" data-action="logout" aria-label="Выйти" title="Выйти"><svg><use href="#i-logout"/></svg></button>
    </div>`
}

function renderSidebarPlaylists() {
  const el = $('#sidebar-playlists')
  if (!state.me || !state.playlists.length) {
    el.innerHTML = `<p class="sidebar-empty">${state.me ? 'Плейлистов пока нет' : 'Появятся после входа'}</p>`
    return
  }
  el.innerHTML = state.playlists.map(p => `
    <button class="side-playlist" data-playlist="${p.id}" title="${esc(p.title)}">
      ${artBox(p.artwork_url || p.user?.avatar_url)}
      <span class="side-meta">
        <span class="side-title">${esc(p.title)}</span>
        <span class="side-sub">${esc(p.user?.username)} · ${p.track_count}</span>
      </span>
    </button>`).join('')
  highlightNav()
}

async function boot() {
  const { loggedIn } = await sc.session()
  const profileId = localStorage.getItem('profile')
  Object.assign(state, { loggedIn, me: null, playlists: [], likedIds: new Set() })

  try {
    if (loggedIn) {
      state.me = await sc.api('/me')
      localStorage.setItem('me', JSON.stringify(state.me))
    } else if (profileId) {
      state.me = await sc.api(`/users/${profileId}`)
    }
    if (state.me) state.playlists = await loadPlaylists()
    if (loggedIn) state.likedIds = new Set((await sc.api('/me/track_likes/ids?limit=5000')).collection)
  } catch (err) {
    if (loggedIn && errorText(err).includes('401')) {
      await sc.logout()
      localStorage.removeItem('me')
      state.loggedIn = false
      toast('Сессия SoundCloud истекла — войди заново')
    } else {
      // Без сети не выкидываем на экран входа: профиль — из прошлого запуска, главная — из снимка,
      // а скачанное в «Моё» играет и так.
      if (loggedIn) state.me ??= JSON.parse(localStorage.getItem('me') ?? 'null')
      toast(errorText(err))
    }
  }

  try {
    state.downloads = new Map((await sc.downloads.list()).map(d => [d.id, d]))
  } catch (err) {
    toast(`Загрузки недоступны: ${errorText(err)}`)
  }

  renderAccount()
  renderSidebarPlaylists()
  syncLikeButtons()
  go(current.name, current.arg, false)
  restoreSession().catch(() => {})
  publishSnapshot()
  syncNow()
}

/* ---------- синхронизация между устройствами ---------- */

const syncPeer = () => JSON.parse(localStorage.getItem('syncPeer') ?? 'null')

function localSnapshot() {
  return {
    account: state.me?.id ?? null,
    device: deviceId,
    at: Date.now(),
    history,
    listenedDays,
    peerListened,
    lifetime,
    peerLifetime,
    localPlaylists: loadLocalPlaylists(),
    deletedPlaylists: JSON.parse(localStorage.getItem('deletedPlaylists') ?? '{}'),
    session: JSON.parse(localStorage.getItem('session') ?? 'null'),
  }
}

// Сливаем с точки зрения mine. История объединяется; минуты чужих устройств лежат по их id
// (берём большее — счётчик только растёт); плейлисты и очередь выигрывают более свежие,
// удалённый плейлист не воскресает, если удаление новее правки.
function mergeSnapshots(mine, theirs) {
  if (!mine.account || !theirs?.account || mine.account !== theirs.account) return null

  const seen = new Set()
  const history = [...mine.history, ...(theirs.history ?? [])]
    .sort((a, b) => b.at - a.at)
    .filter(item => {
      const key = `${item.id}:${item.at}`
      return !seen.has(key) && seen.add(key)
    })
    .slice(0, 500)

  const peers = {}
  const addPeer = (device, days) => {
    if (!device || device === mine.device) return
    const into = (peers[device] ??= {})
    for (const [day, seconds] of Object.entries(days ?? {})) into[day] = Math.max(into[day] ?? 0, seconds)
  }
  for (const [device, days] of Object.entries(mine.peerListened ?? {})) addPeer(device, days)
  for (const [device, days] of Object.entries(theirs.peerListened ?? {})) addPeer(device, days)
  addPeer(theirs.device, theirs.listenedDays)

  const peerLife = {}
  const addLife = (device, life) => {
    if (!device || device === mine.device || !life) return
    const into = peerLife[device] ?? { plays: 0, seconds: 0, tracks: [], artists: [] }
    peerLife[device] = {
      plays: Math.max(into.plays, life.plays ?? 0),
      seconds: Math.max(into.seconds, life.seconds ?? 0),
      tracks: [...new Set([...into.tracks, ...(life.tracks ?? [])])],
      artists: [...new Set([...into.artists, ...(life.artists ?? [])])],
    }
  }
  for (const [device, life] of Object.entries(mine.peerLifetime ?? {})) addLife(device, life)
  for (const [device, life] of Object.entries(theirs.peerLifetime ?? {})) addLife(device, life)
  addLife(theirs.device, theirs.lifetime)

  const deletedPlaylists = { ...mine.deletedPlaylists }
  for (const [id, at] of Object.entries(theirs.deletedPlaylists ?? {})) deletedPlaylists[id] = Math.max(deletedPlaylists[id] ?? 0, at)
  const localPlaylists = { ...mine.localPlaylists }
  for (const [id, playlist] of Object.entries(theirs.localPlaylists ?? {})) {
    const own = localPlaylists[id]
    if (!own || (playlist.updatedAt ?? 0) > (own.updatedAt ?? 0)) localPlaylists[id] = playlist
  }
  for (const [id, at] of Object.entries(deletedPlaylists)) {
    if (localPlaylists[id] && (localPlaylists[id].updatedAt ?? 0) <= at) delete localPlaylists[id]
  }

  const session = (theirs.session?.at ?? 0) > (mine.session?.at ?? 0) ? theirs.session : mine.session
  return {
    account: mine.account,
    device: mine.device,
    at: Date.now(),
    history,
    listenedDays: mine.listenedDays,
    peerListened: peers,
    lifetime: mine.lifetime,
    peerLifetime: peerLife,
    localPlaylists,
    deletedPlaylists,
    session,
  }
}

function applySnapshot(snapshot) {
  const sessionChanged = (snapshot.session?.at ?? 0) > (JSON.parse(localStorage.getItem('session') ?? 'null')?.at ?? 0)
  history = snapshot.history
  peerListened = snapshot.peerListened
  peerLifetime = snapshot.peerLifetime ?? peerLifetime
  localStorage.setItem('history', JSON.stringify(history))
  localStorage.setItem('peerListened', JSON.stringify(peerListened))
  localStorage.setItem('peerLifetime', JSON.stringify(peerLifetime))
  localStorage.setItem('deletedPlaylists', JSON.stringify(snapshot.deletedPlaylists))
  localStorage.setItem('localPlaylists', JSON.stringify(snapshot.localPlaylists))
  renderSidebarPlaylists()
  if (!sessionChanged) return
  localStorage.setItem('session', JSON.stringify(snapshot.session))
  // Здесь ничего не играет — подхватываем очередь с другого устройства, чтобы продолжить с того же места.
  if (!audio.getAttribute('src')) {
    state.index = -1
    restoreSession().catch(() => {})
  }
}

let syncing = false

async function syncNow(manual = false) {
  const peer = syncPeer()
  if (syncing || !sc.sync?.pull || !peer?.address || !state.me) return
  syncing = true
  try {
    const theirs = await sc.sync.pull(peer.address, peer.key)
    if (!theirs?.at) {
      if (manual) toast('Cloudwave на компьютере ещё не загрузился — открой его и войди в SoundCloud')
      return
    }
    const merged = mergeSnapshots(localSnapshot(), theirs)
    if (!merged) {
      if (manual) toast('На устройствах разные аккаунты SoundCloud — не синхронизирую')
      return
    }
    applySnapshot(merged)
    await sc.sync.push(peer.address, peer.key, merged)
    localStorage.setItem('syncedAt', String(Date.now()))
    if (manual) toast('Синхронизировано с компьютером')
    if (['library', 'history', 'recap'].includes(current.name)) go(current.name, current.arg, false)
  } catch (err) {
    if (manual) toast(`Компьютер не ответил: ${errorText(err)}`)
  } finally {
    syncing = false
  }
}

// На компьютере снимок просто лежит наготове: телефон сам его забирает и присылает слитый.
function publishSnapshot() {
  if (state.me) sc.sync?.publish?.(localSnapshot())
}

sc.sync?.onApply?.(incoming => {
  const merged = mergeSnapshots(localSnapshot(), incoming)
  if (!merged) return
  applySnapshot(merged)
  publishSnapshot()
  if (['library', 'history', 'recap'].includes(current.name)) go(current.name, current.arg, false)
})

/* ---------- сохранение сессии ---------- */

// Очередь и позиция переживают перезапуск: трек встаёт на паузу там же, где остановился.
let resumeAt = 0
let sessionSavedAt = 0
// Что это устройство записало последним. Время сессии двигается, только когда очередь или место
// в ней правда поменялись: иначе простой уход в фон делал старую очередь «свежей», и синхронизация
// перебивала ею ту, что на самом деле слушали на другом устройстве.
let ownSession = null
let restoreToken = 0

function sessionState(position) {
  // Радио растит очередь бесконечно — храним окно вокруг текущего трека.
  const start = Math.max(0, state.index - 100)
  return {
    ids: state.queue.slice(start, start + 400).map(t => t.id),
    index: state.index - start,
    position: Math.floor(position),
    context: state.context?.label ? { label: state.context.label } : null,
    shuffle: state.shuffle,
    repeat: state.repeat,
  }
}

function saveSession(position = audio.getAttribute('src') ? audio.currentTime : resumeAt) {
  if (!state.queue[state.index]) return
  sessionSavedAt = performance.now()
  const session = sessionState(position)
  const body = JSON.stringify(session)
  if (body === ownSession) return
  ownSession = body
  localStorage.setItem('session', JSON.stringify({ ...session, at: Date.now() }))
  publishSnapshot()
}

async function restoreSession() {
  const saved = JSON.parse(localStorage.getItem('session') ?? 'null')
  if (!saved?.ids?.length || state.index >= 0) return
  // При запуске своя очередь и пришедшая синхронизацией восстанавливаются наперегонки —
  // побеждает запрошенная последней (она свежее), а не та, что быстрее догрузилась.
  const token = ++restoreToken
  const tracks = await hydrate(saved.ids.map(id => ({ id })))
  const index = tracks.findIndex(t => t.id === saved.ids[saved.index])
  if (token !== restoreToken || index < 0 || state.index >= 0) return
  Object.assign(state, { queue: tracks, original: tracks, index, context: saved.context, shuffle: saved.shuffle, repeat: saved.repeat, more: null })
  resumeAt = saved.position ?? 0
  ownSession = JSON.stringify(sessionState(resumeAt))
  syncToggles()
  showTrack(tracks[index], true)
  $('#time-cur').textContent = fmtTime(resumeAt)
  $('#now-cur').textContent = fmtTime(resumeAt)
}

// Минуты прослушивания раньше сохранялись только на паузе: iOS выгружает приложение без
// beforeunload, и всё прослушанное с последней паузы пропадало.
function saveProgress() {
  saveSession()
  saveListened()
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') saveProgress()
  else syncNow()
})
setInterval(() => syncNow(), 10 * 60000)
window.addEventListener('pagehide', saveProgress)

const actions = {
  retry: () => go(current.name, current.arg, false),
  async pairPhone() {
    try {
      const { code, url } = await sc.pairPhone()
      $('#pair-code').textContent = `${code.slice(0, 3)} ${code.slice(3)}`
      $('#pair-url').textContent = url
      $('#pair-dialog').showModal()
    } catch (err) {
      toast(`Не получилось получить код: ${errorText(err)}`)
    }
  },
  async login() {
    try {
      if (!(await sc.login())) return
    } catch (err) {
      toast(`Не получилось войти: ${errorText(err)}`)
      return
    }
    localStorage.removeItem('profile')
    localStorage.removeItem('homeSnapshot')
    current = { name: 'home' }
    await boot()
  },
  async logout() {
    if (state.loggedIn) await sc.logout()
    localStorage.removeItem('me')
    localStorage.removeItem('profile')
    localStorage.removeItem('homeSnapshot')
    current = { name: 'home' }
    await boot()
  },
  toggleNormalize() {
    const on = !normalizeEnabled()
    localStorage.setItem('normalize', on ? '1' : '0')
    if (on) ensureAudioGraph()
    applyNormalize(on)
    go('settings', null, false)
  },
  syncNow: () => syncNow(true),
  async shareRecap() {
    const blob = await (recapPicture ?? recapImage(recapStats))
    const file = new File([blob], `cloudwave-${today()}.png`, { type: 'image/png' })
    // В приложении на iPhone — нативный лист: ссылка с download в WKWebView ничего не делает.
    if (native) {
      try {
        toast(await sc.saveFile(file.name, new Uint8Array(await blob.arrayBuffer())))
      } catch (err) {
        toast(errorText(err))
      }
      return
    }
    if (navigator.canShare?.({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: 'Мои итоги недели в Cloudwave' })
      } catch (err) {
        if (err.name !== 'AbortError') toast(errorText(err))
      }
      return
    }
    const link = document.createElement('a')
    link.href = URL.createObjectURL(blob)
    link.download = file.name
    link.click()
    setTimeout(() => URL.revokeObjectURL(link.href), 10000)
  },
  toggleHideDrm() {
    localStorage.setItem('hideDrm', hideDrm() ? '0' : '1')
    go('settings', null, false)
  },
  createPlaylist: () => openPlaylistDialog(null),
  // Формат тот же, что у резервной копии лайков: [{ id, title, artist, url }].
  importPlaylist() {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.json,application/json'
    input.onchange = async () => {
      const file = input.files[0]
      if (!file) return
      let items
      try {
        items = JSON.parse(await file.text())
      } catch {
        toast('Файл не читается как JSON')
        return
      }
      const list = Array.isArray(items) ? items : items?.tracks ?? []
      const trackIds = [...new Set(list.map(item => Number(item?.id ?? item)).filter(id => Number.isInteger(id) && id > 0))]
      if (!trackIds.length) {
        toast('В файле нет id треков SoundCloud')
        return
      }
      const playlists = loadLocalPlaylists()
      const id = `p${Date.now()}`
      const name = items.name ?? file.name.replace(/\.json$/i, '')
      playlists[id] = { id, name, trackIds, updatedAt: Date.now() }
      saveLocalPlaylists(playlists)
      toast(`Плейлист «${name}»: ${countOf(trackIds.length, TRACK_FORMS)}`)
      go('localPlaylist', id)
    }
    input.click()
  },
  async backupLikes() {
    try {
      toast(await exportLikes())
    } catch (err) {
      toast(errorText(err))
    }
  },
}

/* ---------- плеер ---------- */

function shuffled(tracks, firstIndex) {
  const rest = tracks.filter((_, i) => i !== firstIndex)
  for (let i = rest.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[rest[i], rest[j]] = [rest[j], rest[i]]
  }
  return [tracks[firstIndex], ...rest]
}

function playList(listId, index, shuffle = false) {
  const list = lists.get(listId)
  if (!list) return
  // Дальше по списку одни DRM-треки — очередь не трогаем. Иначе новая очередь вставала при старом
  // индексе: на экране прежний трек, а лайк и «следующий» относились к треку из нового списка.
  if (!list.tracks.slice(shuffle || state.shuffle ? 0 : index).some(t => !drmOnly(t))) {
    toast(`«${list.tracks[index]?.title ?? 'Трек'}» есть только с DRM — дальше в списке играть нечего`)
    return
  }
  if (shuffle) state.shuffle = true
  // Очередь — своя копия списка. Раньше это был тот же массив, и «Играть следующим», удаление
  // из очереди и радио сдвигали строки на экране: клик по треку включал соседний.
  state.original = [...list.tracks]
  state.context = list.context
  state.more = list.next
  state.queue = state.shuffle ? shuffled(state.original, index) : state.original
  syncToggles()
  playAt(state.shuffle ? 0 : index)
}

async function playSystem(urn) {
  try {
    const playlist = await loadSystemPlaylist(urn)
    const listId = registerList(await hydrate(playlist.tracks), { label: playlist.title })
    playList(listId, 0)
  } catch (err) {
    toast(errorText(err))
  }
}

async function resolveSource(track) {
  const cached = prefetched.get(track.id)
  if (cached) {
    prefetched.delete(track.id)
    return cached
  }
  const offlineSrc = await sc.downloads.get(track.id)
  if (offlineSrc) return { track, source: { url: offlineSrc, hls: false, preview: false } }
  return freshStream(track)
}

async function freshStream(track) {
  try {
    return { track, source: await sc.stream(track) }
  } catch {
    // Если список долго был открыт, track_authorization у трека мог протухнуть — запрашиваем трек заново.
    const fresh = await sc.api(`/tracks/${track.id}`)
    return { track: fresh, source: await sc.stream(fresh) }
  }
}

// step — куда листали: неиграющий трек пропускаем в ту же сторону, иначе «назад» на нём
// отбрасывало бы обратно вперёд.
async function playAt(index, step = 1, skipping = false, startAt = 0) {
  const queued = state.queue[index]
  if (!queued) return
  if (drmOnly(queued)) {
    // Тост только на явный выбор такого трека; при листании молча идём дальше.
    if (!skipping && index !== state.index + step) toast(`«${queued.title}» есть только с DRM, включаю следующий`)
    return playAt(index + step, step, true)
  }
  const token = ++playToken
  lastStep = step
  state.index = index
  reloadedFor = null
  showTrack(queued)

  let resolved
  try {
    resolved = await resolveSource(queued)
  } catch (err) {
    if (token !== playToken) return
    toast(`«${queued.title}» не играет: ${errorText(err)}`)
    if (++skipStreak >= 3) return
    if (step > 0) next()
    else if (index > 0) playAt(index - 1, -1)
    return
  }
  if (token !== playToken) return

  skipStreak = 0
  // Свежий объект трека (с новым track_authorization) вливаем в прежний, а не подменяем: на прежний
  // ссылается исходный порядок, и после подмены выключение перемешивания теряло текущий трек.
  if (resolved.track !== queued) Object.assign(queued, resolved.track)
  load(resolved.source, startAt)
  // Дотягиваем очередь заранее, пока играет последний трек, — иначе на стыке будет пауза.
  if (!state.repeat && index >= state.queue.length - 1) extendQueue()
  prefetchNext()
}

// Ссылка на поток резолвится не мгновенно — заранее резолвим следующий трек в очереди,
// пока играет текущий, чтобы на стыке треков не было паузы.
const prefetched = new Map()
// DRM-треки плеер всё равно перепрыгнет, поэтому заранее готовим первый играющий после текущего;
// с повтором после последнего трека играет первый.
const nextPlayable = index => state.queue.slice(index + 1).find(t => !drmOnly(t))
  ?? (state.repeat ? state.queue.find(t => !drmOnly(t)) : undefined)

// Нативный плеер на iPhone переходит на следующий трек сам, пока JS в фоне спит, — поэтому после
// любой правки очереди он должен знать актуальный следующий. Пока тот не готов, не знает никакого:
// иначе в конце трека включался бы убранный или сдвинутый трек.
function prefetchNext(track = nextPlayable(state.index)) {
  if (state.index < 0) return
  if (!track) {
    sc.preloadNext?.(null)
    return
  }
  const handOver = ready => {
    if (nextPlayable(state.index)?.id === track.id) sc.preloadNext?.(ready.track, ready.source)
  }
  const ready = prefetched.get(track.id)
  if (ready) return handOver(ready)
  sc.preloadNext?.(null)
  resolveSource(track).then(r => {
    prefetched.set(track.id, r)
    handOver(r)
  }).catch(() => {})
}

// Так же, как веб-плеер soundcloud.com: токен лицензии уходит параметром license_token.
const drmConfig = token => ({
  emeEnabled: true,
  drmSystems: { 'com.widevine.alpha': { licenseUrl: 'https://license.media-streaming.soundcloud.cloud/playback/widevine' } },
  licenseXhrSetup(xhr, url) {
    const withToken = new URL(url)
    withToken.searchParams.set('license_token', token)
    xhr.open('POST', withToken.href, true)
  },
})

function load(source, startAt) {
  hls?.destroy()
  hls = null
  // Safari на iOS играет HLS сам, а MediaSource для hls.js там есть не везде. Chromium в Electron тоже
  // говорит, что умеет HLS, но его встроенный плеер не знает EME — зашифрованный поток ведёт только hls.js.
  if (source.hls && (source.licenseToken || !audio.canPlayType('application/vnd.apple.mpegurl'))) {
    hls = new Hls({ startPosition: startAt, ...(source.licenseToken && drmConfig(source.licenseToken)) })
    hls.on(Hls.Events.ERROR, (_event, data) => {
      if (data.fatal) recover()
    })
    hls.loadSource(source.url)
    hls.attachMedia(audio)
  } else {
    // Без CORS-режима Web Audio получил бы от чужого CDN тишину; у файлов и capacitor:// его нет.
    audio.crossOrigin = /^https?:/.test(source.url) ? 'anonymous' : null
    audio.src = source.url
    audio.currentTime = startAt
  }
  if (normalizeEnabled()) ensureAudioGraph()
  audioCtx?.resume().catch(() => {})
  audio.play().catch(err => {
    if (err.name !== 'AbortError') throw err
  })
  $('#preview-badge').hidden = !source.preview
}

// Ссылки на поток подписаны на ограниченное время: после долгой паузы CDN отвечает ошибкой.
// Один раз берём свежую ссылку и продолжаем с того же места, при повторной ошибке — дальше.
async function recover() {
  const track = state.queue[state.index]
  if (!track) return
  if (reloadedFor === track.id) {
    toast('Поток оборвался, включаю следующий')
    next()
    return
  }
  reloadedFor = track.id
  const position = audio.currentTime
  try {
    const { source } = await resolveSource(track)
    if (state.queue[state.index] === track) load(source, position)
  } catch (err) {
    toast(errorText(err))
  }
}

function togglePlay() {
  if (state.index < 0) return
  // Очередь восстановлена после перезапуска, а поток ещё не загружен — продолжаем с сохранённого места.
  if (!audio.getAttribute('src')) {
    const at = resumeAt
    resumeAt = 0
    return playAt(state.index, 1, false, at)
  }
  if (audio.paused) audio.play()
  else audio.pause()
}

async function next() {
  if (state.index + 1 < state.queue.length) return playAt(state.index + 1)
  if (state.repeat && state.queue.length) return playAt(0)
  // Очередь кончилась — продолжаем сам список, а за ним похожими треками, как радио в SoundCloud.
  // Пока грузили, могли выбрать другой трек — тогда его не перескакиваем.
  const index = state.index
  if (await extendQueue() && state.index === index) playAt(index + 1)
}

let extendPromise = null

function extendQueue() {
  extendPromise ??= growFromRelated().finally(() => {
    extendPromise = null
  })
  return extendPromise
}

async function growFromRelated() {
  const queue = state.queue
  const seed = queue[queue.length - 1]
  if (!seed) return false
  try {
    const seen = new Set(queue.map(t => t.id))
    let fresh = []
    // Сначала — следующие страницы списка, из которого играем: лайки не должны обрываться
    // на 50-м треке и уходить в похожие только потому, что список не долистали.
    let more = state.more
    while (!fresh.length && more) {
      const page = await sc.api(more.href)
      const tracks = await hydrate(more.pick(page))
      more = page.next_href ? { ...more, href: page.next_href } : null
      fresh = tracks.filter(t => !drmOnly(t) && !seen.has(t.id))
    }
    const radio = !fresh.length
    if (radio) {
      const related = await sc.api(`/tracks/${seed.id}/related?limit=20`)
      fresh = related.collection.filter(t => playable(t) && !drmOnly(t) && !seen.has(t.id))
    }
    // Пока грузили, могли включить другой список — к нему чужие треки не цепляем.
    if (state.queue !== queue) return false
    state.more = more
    if (!fresh.length) return false
    state.queue.push(...fresh)
    state.original = state.queue
    if (radio) {
      state.context ??= {}
      state.context.label ??= 'Радио'
    }
    renderQueue()
    prefetchNext()
    return true
  } catch (err) {
    toast(`Не подтянул похожие: ${errorText(err)}`)
    return false
  }
}

function prev() {
  if (audio.currentTime > 3 || state.index <= 0) audio.currentTime = 0
  else playAt(state.index - 1, -1)
}

function toggleShuffle() {
  state.shuffle = !state.shuffle
  const track = state.queue[state.index]
  if (track) {
    state.queue = state.shuffle ? shuffled(state.original, state.original.indexOf(track)) : state.original
    state.index = state.queue.indexOf(track)
  }
  syncToggles()
  renderQueue()
  prefetchNext()
}

function toggleRepeat() {
  state.repeat = !state.repeat
  syncToggles()
  prefetchNext()
}

function syncToggles() {
  $('#shuffle').setAttribute('aria-pressed', state.shuffle)
  $('#repeat').setAttribute('aria-pressed', state.repeat)
}

// blur(90px) на картинке во весь экран, которая ещё и плывёт, iPhone пересчитывает каждый кадр.
// Там размываем один раз: обложка 12×12, растянутая сглаживанием до 96×96, и есть размытие.
let backdropToken = 0

function setBackdrop(small, big) {
  const img = $('#now-backdrop')
  if (!native) {
    img.src = big
    return
  }
  // При быстром листании обложка прошлого трека могла догрузиться последней и остаться фоном.
  const token = ++backdropToken
  const source = new Image()
  source.crossOrigin = 'anonymous'
  source.onload = () => {
    if (token !== backdropToken) return
    const tiny = new OffscreenCanvas(12, 12)
    tiny.getContext('2d').drawImage(source, 0, 0, 12, 12)
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = 96
    const ctx = canvas.getContext('2d')
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(tiny, 0, 0, 96, 96)
    img.src = canvas.toDataURL('image/jpeg', 0.8)
  }
  source.src = small
}

function setArt(el, url) {
  el.innerHTML = url ? `<img src="${esc(url)}" alt="">` : ''
}

// Новая обложка и название въезжают с той стороны, куда листали.
function slideIn(el, distance = 24) {
  el?.animate([
    { opacity: 0, transform: `translateX(${lastStep * distance}px) scale(.97)` },
    { opacity: 1, transform: 'none' },
  ], { duration: 380, easing: 'cubic-bezier(.16, 1, .3, 1)' })
}

function showTrack(track, restoring = false) {
  const big = cover(track, 't500x500')
  $('#open-now').disabled = false
  $('#player-title').textContent = track.title
  $('#player-artist').textContent = track.user.username
  setArt($('#player-art'), cover(track, 't300x300'))
  setArt($('#now-art'), big)
  slideIn($('#now-art img'), 40)
  slideIn($('#player-art img'), 12)
  slideIn($('.player-meta'), 12)
  slideIn($('#now-title'), 16)
  if (big) setBackdrop(cover(track, 't67x67'), big)
  else $('#now-backdrop').removeAttribute('src')

  $('#now-context').textContent = state.context ? `Сейчас играет · ${state.context.label}` : 'Сейчас играет'
  $('#now-title').textContent = track.title
  $('#now-artist').textContent = track.user.username
  $('#now-artist').dataset.user = track.user.id
  $('#now-source').href = track.permalink_url
  $('#now-stats').innerHTML = [
    ['Прослушивания', fmtCount(track.playback_count)],
    ['Лайки', fmtCount(track.likes_count)],
    ['Репосты', fmtCount(track.reposts_count)],
    ['Жанр', esc(track.genre || '—')],
    ['Год', new Date(track.release_date || track.created_at).getFullYear()],
  ].map(([term, value]) => `<div><dt>${term}</dt><dd>${value}</dd></div>`).join('')

  const duration = fmtTime(track.full_duration / 1000)
  $('#time-dur').textContent = duration
  $('#now-dur').textContent = duration
  document.title = `${track.title} — ${track.user.username}`

  syncMpris()
  syncLikeButtons()
  applyAccent(cover(track, 't67x67'))
  loadWave(track)
  loadLyrics(track)
  // Восстановленный после перезапуска трек ещё никто не слушал — в историю его не пишем.
  if (!restoring) addToHistory(track)
  if (audio.getAttribute('src')) saveSession(0)
  markCurrent()
}

let likeBusy = false

async function toggleLike() {
  const track = state.queue[state.index]
  // canLike — кнопки скрыты (PWA), но клавиша L и экран блокировки всё равно сюда попадают.
  if (!track || !state.loggedIn || likeBusy || sc.canLike === false) return
  const liked = state.likedIds.has(track.id)
  likeBusy = true
  sc.haptic?.()
  setLiked(track.id, !liked)
  try {
    await sc.api(`/users/${state.me.id}/track_likes/${track.id}`, liked ? 'DELETE' : 'PUT')
    state.me.likes_count += liked ? -1 : 1
  } catch (err) {
    setLiked(track.id, liked)
    toast(`Не получилось ${liked ? 'убрать лайк' : 'лайкнуть'}: ${errorText(err)}`)
  } finally {
    likeBusy = false
  }
}

function setLiked(trackId, liked) {
  if (liked) state.likedIds.add(trackId)
  else state.likedIds.delete(trackId)
  syncLikeButtons(true)
  syncMpris()
}

function syncLikeButtons(animate = false) {
  const track = state.queue[state.index]
  const liked = Boolean(track) && state.likedIds.has(track.id)
  for (const button of [$('#like'), $('#now-like')]) {
    button.hidden = !state.loggedIn || !track || sc.canLike === false
    button.setAttribute('aria-pressed', liked)
    button.setAttribute('aria-label', liked ? 'Убрать лайк' : 'Лайкнуть')
    button.querySelector('use').setAttribute('href', liked ? '#i-heart-filled' : '#i-heart')
    if (animate) {
      button.classList.remove('pop')
      void button.offsetWidth
      button.classList.add('pop')
    }
  }
  $('#now-like span').textContent = liked ? 'В лайках' : 'Лайкнуть'
}

function syncMpris(seeked = false) {
  const track = state.queue[state.index]
  if (!track) return
  sc.mpris({
    id: track.id,
    title: track.title,
    artist: track.user.username,
    album: state.context?.label ?? '',
    artUrl: cover(track, 't500x500'),
    url: track.permalink_url,
    length: Number.isFinite(audio.duration) && audio.duration ? audio.duration : track.full_duration / 1000,
    position: audio.currentTime,
    playing: !audio.paused,
    liked: state.likedIds.has(track.id),
    seeked,
  })
  // На Windows MPRIS нет: медиаклавиши и плашку громкости с обложкой даёт Media Session Chromium.
  if (windows) {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: track.title,
      artist: track.user.username,
      album: state.context?.label ?? '',
      artwork: [{ src: cover(track, 't500x500'), sizes: '500x500' }],
    })
    navigator.mediaSession.playbackState = audio.paused ? 'paused' : 'playing'
  }
}

function markCurrent() {
  const id = state.queue[state.index]?.id
  for (const el of document.querySelectorAll('.row[data-track], .card[data-track], .mini-row[data-track]')) {
    el.classList.toggle('is-current', Number(el.dataset.track) === id)
  }
  renderQueue()
}

function syncPlayButton() {
  const paused = audio.paused
  const button = $('#play')
  document.body.classList.toggle('is-paused', paused)
  button.querySelector('use').setAttribute('href', paused ? '#i-play' : '#i-pause')
  button.setAttribute('aria-label', paused ? 'Играть' : 'Пауза')
  button.classList.remove('pop')
  void button.offsetWidth
  button.classList.add('pop')
  syncMpris()
}

function setRange(input, value) {
  input.value = value
  input.style.setProperty('--fill', `${(value - input.min) / (input.max - input.min) * 100}%`)
}

function syncVolume() {
  const muted = audio.muted || audio.volume === 0
  $('#mute use').setAttribute('href', muted ? '#i-mute' : '#i-volume')
  $('#mute').setAttribute('aria-label', muted ? 'Включить звук' : 'Выключить звук')
}

/* ---------- цвет из обложки ---------- */

/* ---------- оформление ---------- */

const ACCENTS = [['cover', 'Из обложки'], ['300', 'Сиреневый'], ['250', 'Синий'], ['190', 'Бирюзовый'], ['145', 'Зелёный'], ['65', 'Янтарный'], ['20', 'Красный']]
const accentChoice = () => localStorage.getItem('accent') ?? 'cover'
const themeChoice = () => localStorage.getItem('theme') ?? 'glass'
const systemLight = matchMedia('(prefers-color-scheme: light)')

const THEMES = [['dark', 'Тёмная'], ['light', 'Светлая'], ['system', 'Как в системе'], ['glass', 'Жидкое стекло'], ['oled', 'OLED'], ['mono', 'Монохром'], ['dexter', 'Фиолетовая']]
// У этих тем свой цвет, обложка его не перекрашивает.
const THEME_ACCENTS = { mono: 'oklch(0.93 0 0)', dexter: 'oklch(0.68 0.2 300)' }

function applyTheme() {
  const choice = themeChoice()
  document.documentElement.dataset.theme = choice === 'system' ? (systemLight.matches ? 'light' : 'dark') : choice
  const track = state.queue[state.index]
  applyAccent(track && cover(track, 't67x67'))
}
systemLight.addEventListener('change', applyTheme)

function timeOfDay() {
  const hour = new Date().getHours()
  return hour >= 5 && hour < 12 ? 'morning' : hour < 18 ? 'day' : hour < 23 ? 'evening' : 'night'
}

function applyTimeOfDay() {
  const root = document.documentElement
  for (const slot of ['morning', 'day', 'evening', 'night']) root.classList.toggle(`time-${slot}`, slot === timeOfDay())
}
setInterval(applyTimeOfDay, 10 * 60000)

let accentToken = 0

function applyAccent(url) {
  const root = document.documentElement
  // Обложка, запрошенная раньше, могла догрузиться позже и перекрасить интерфейс под прошлый трек
  // (или поверх темы с собственным цветом) — учитываем только последний запрос.
  const token = ++accentToken
  const themed = THEME_ACCENTS[document.documentElement.dataset.theme]
  if (themed) {
    root.style.setProperty('--accent-src', themed)
    return
  }
  if (accentChoice() !== 'cover') {
    root.style.setProperty('--accent-src', `oklch(0.7 0.15 ${accentChoice()})`)
    return
  }
  if (!url) {
    root.style.removeProperty('--accent-src')
    return
  }
  const img = new Image()
  img.crossOrigin = 'anonymous'
  img.onload = () => {
    if (token !== accentToken) return
    const color = dominantColor(img)
    if (color) root.style.setProperty('--accent-src', color)
    else root.style.removeProperty('--accent-src')
  }
  img.src = url
}

// Средний цвет всей обложки почти всегда грязно-серый, поэтому раскладываем насыщенные
// пиксели по 12 корзинам оттенка и берём самую «тяжёлую».
function dominantColor(img) {
  const size = 32
  const ctx = new OffscreenCanvas(size, size).getContext('2d')
  ctx.drawImage(img, 0, 0, size, size)
  const { data } = ctx.getImageData(0, 0, size, size)
  const buckets = Array.from({ length: 12 }, () => ({ r: 0, g: 0, b: 0, w: 0 }))

  for (let i = 0; i < data.length; i += 4) {
    const [r, g, b] = [data[i], data[i + 1], data[i + 2]]
    const max = Math.max(r, g, b)
    const d = max - Math.min(r, g, b)
    if (!d || max < 60 || max > 250) continue
    const hue = max === r ? ((g - b) / d + 6) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4
    const w = (d / max) ** 2
    const bucket = buckets[Math.floor(hue * 2) % 12]
    bucket.r += r * w
    bucket.g += g * w
    bucket.b += b * w
    bucket.w += w
  }

  const best = buckets.reduce((a, b) => (b.w > a.w ? b : a))
  if (best.w < size * size * 0.03) return null
  return `rgb(${best.r / best.w | 0} ${best.g / best.w | 0} ${best.b / best.w | 0})`
}

/* ---------- волна ---------- */

async function loadWave(track) {
  wave = null
  requestDraw()
  const url = track.waveform_url?.replace(/\.png$/, '.json')
  if (!url) return
  let data
  try {
    data = await (await fetch(url)).json()
  } catch {
    // Без сети волна остаётся ровной — не повод для необработанной ошибки.
    return
  }
  if (state.queue[state.index]?.id !== track.id) return
  wave = data
  requestDraw()
}

let drawPending = false
function requestDraw() {
  if (drawPending || $('#now').hidden) return
  drawPending = true
  requestAnimationFrame(() => {
    drawPending = false
    drawWave()
  })
}

function drawWave() {
  const canvas = $('#wave-canvas')
  const { width, height } = canvas.getBoundingClientRect()
  const dpr = devicePixelRatio
  if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
    canvas.width = Math.round(width * dpr)
    canvas.height = Math.round(height * dpr)
  }
  const ctx = canvas.getContext('2d')
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, width, height)

  const style = getComputedStyle($('#wave'))
  const bar = 3
  const step = bar + 2
  const count = Math.floor(width / step)
  const progress = audio.duration ? audio.currentTime / audio.duration : 0

  for (let i = 0; i < count; i++) {
    let level = 0.04
    if (wave) {
      const from = Math.floor(i / count * wave.samples.length)
      const to = Math.max(from + 1, Math.floor((i + 1) / count * wave.samples.length))
      level = Math.max(...wave.samples.slice(from, to)) / wave.height
    }
    const h = Math.max(3, level * height)
    const fraction = (i + 0.5) / count
    ctx.globalAlpha = 1
    if (fraction <= progress) {
      ctx.fillStyle = style.color
    } else if (waveHover !== null && fraction <= waveHover) {
      ctx.fillStyle = style.color
      ctx.globalAlpha = 0.45
    } else {
      ctx.fillStyle = style.textDecorationColor
    }
    ctx.beginPath()
    ctx.roundRect(i * step, (height - h) / 2, bar, h, 1.5)
    ctx.fill()
  }
}

function toggleNow(open) {
  if (open && state.index < 0) return
  const apply = () => {
    const focusInside = $('#now').contains(document.activeElement)
    $('#now').hidden = !open
    document.body.classList.toggle('now-open', open)
    if (open) {
      drawWave()
      startBeat()
      $('#now-close').focus({ focusVisible: false })
    } else if (focusInside) {
      $('#open-now').focus({ focusVisible: false })
    }
  }
  // View Transition снимает снимок всей страницы — на iPhone это заметный рывок.
  if (native || !document.startViewTransition || matchMedia('(prefers-reduced-motion: reduce)').matches) apply()
  else document.startViewTransition(apply)
}

/* ---------- слова песни ---------- */

const lyricsEl = $('#now-lyrics')
const lyricsCache = new Map()
let lyrics = null
let lyricsLine = -1
let lyricsFollowAt = 0

// Поиск LRCLIB требует все слова запроса, поэтому скобки («(prod. …)», «[Original Version]»), feat. и хэштеги
// выкидываем целиком. Ремиксы от этого не перепутаются — их отсекает сверка длительности.
const TITLE_JUNK = /\([^)]*\)|\[[^\]]*\]|\b(feat|ft)\.? [^-–—]*|#\S+/gi

function lyricsQuery(track) {
  const title = track.publisher_metadata?.release_title || track.title
  // В заливках «Автор - Название» автор уже в названии, а ник залившего только сбивает поиск.
  const artist = / [-–—] /.test(title) ? '' : track.publisher_metadata?.artist || track.user.username
  return `${artist} ${title}`.replace(TITLE_JUNK, ' ').replace(/\s+/g, ' ').trim()
}

function lyricsParts(track) {
  const title = track.publisher_metadata?.release_title || track.title
  const [artist, name] = / [-–—] /.test(title)
    ? [title.split(/ [-–—] /)[0], title.split(/ [-–—] /).slice(1).join(' - ')]
    : [track.publisher_metadata?.artist || track.user.username, title]
  const clean = text => text.replace(TITLE_JUNK, ' ').replace(/\s+/g, ' ').trim()
  return { artist_name: clean(artist), track_name: clean(name) }
}

async function fetchLyrics(track) {
  // Точный запрос отдаёт одну запись на несколько КБ, и из РФ без VPN он проходит. Ответ поиска —
  // десятки записей на сотни КБ — режется на ~16 КБ и висит, поэтому поиск только запасной и с таймаутом.
  const exact = await fetch(`https://lrclib.net/api/get?${new URLSearchParams({ ...lyricsParts(track), duration: Math.round(track.full_duration / 1000) })}`, { signal: AbortSignal.timeout(10000) })
  if (exact.ok) return exact.json()
  // 400 — после чистки от скобок и feat. от названия ничего не осталось: тогда тоже пробуем поиск.
  if (exact.status !== 404 && exact.status !== 400) throw new Error(`LRCLIB ответил ${exact.status}`)
  const response = await fetch(`https://lrclib.net/api/search?${new URLSearchParams({ q: lyricsQuery(track) })}`, { signal: AbortSignal.timeout(15000) })
  if (!response.ok) throw new Error(`LRCLIB ответил ${response.status}`)
  const seconds = track.full_duration / 1000
  // Длительность отсекает чужие версии: у speed up и slowed тайминги строк не совпадут.
  // Пара секунд расхождения — обычное дело для заливок на SoundCloud с обрезанной тишиной.
  const gap = found => Math.abs(found.duration - seconds)
  const close = (await response.json()).filter(found => gap(found) <= 5).sort((a, b) => gap(a) - gap(b))
  return close.find(found => found.syncedLyrics) ?? close.find(found => found.plainLyrics || found.instrumental) ?? null
}

function parseLrc(text) {
  const lines = []
  for (const raw of text.split('\n')) {
    const words = raw.replace(/\[[^\]]*\]/g, '').trim()
    for (const [, min, sec] of raw.matchAll(/\[(\d+):(\d+(?:\.\d+)?)\]/g)) {
      lines.push({ time: min * 60 + Number(sec), text: words })
    }
  }
  return lines.sort((a, b) => a.time - b.time)
}

function lyricsMessage(text, missing = false) {
  lyricsEl.classList.remove('is-synced')
  lyricsEl.innerHTML = `<p class="lyrics-empty">${text}</p>`
  // Когда текста нет, панель на месте обложки только занимает экран — возвращаем обложку.
  $('#now').classList.toggle('no-lyrics', missing)
}

async function loadLyrics(track) {
  lyrics = null
  lyricsLine = -1
  if (lyricsEl.hidden) return
  let found = lyricsCache.get(track.id)
  if (found === undefined) {
    lyricsMessage('Ищу текст…')
    try {
      found = await fetchLyrics(track)
    } catch {
      if (state.queue[state.index]?.id === track.id) lyricsMessage('Не удалось загрузить текст', true)
      return
    }
    lyricsCache.set(track.id, found)
  }
  if (state.queue[state.index]?.id !== track.id || lyricsEl.hidden) return

  if (!found) return lyricsMessage('Текста для этого трека не нашлось', true)
  if (found.instrumental) return lyricsMessage('Инструментал, без слов', true)
  const synced = Boolean(found.syncedLyrics)
  const lines = synced ? parseLrc(found.syncedLyrics) : (found.plainLyrics ?? '').split('\n').map(text => ({ text: text.trim() }))
  // Запись без единой строки текста (пустая, битый LRC) — это «не нашлось». Раньше на ней падал
  // split, и панель навсегда оставалась на «Ищу текст…».
  if (!lines.some(line => line.text)) return lyricsMessage('Текста для этого трека не нашлось', true)
  $('#now').classList.remove('no-lyrics')
  lyrics = { synced, lines }
  lyricsEl.classList.toggle('is-synced', synced)
  lyricsEl.innerHTML = lyrics.lines.map((line, i) => synced
    ? `<button class="lyrics-line" data-line="${i}">${line.text ? line.text.split(/\s+/).map(word => `<span class="lw">${esc(word)}</span>`).join(' ') : '♪'}</button>`
    : `<p class="lyrics-line">${esc(line.text) || '&nbsp;'}</p>`).join('')
  lyricsEl.scrollTop = 0
  syncLyrics()
}

function syncLyrics() {
  if (!lyrics?.synced || lyricsEl.hidden) return
  // Подсвечиваем чуть заранее — глазу нужно время добраться до строки.
  const line = lyrics.lines.findLastIndex(({ time }) => time <= audio.currentTime + 0.25)
  if (line === lyricsLine) return
  lyricsEl.querySelector('.is-active')?.classList.remove('is-active')
  lyricsLine = line
  if (line < 0) return
  const el = lyricsEl.children[line]
  el.classList.add('is-active')
  startKaraoke()
  if (performance.now() < lyricsFollowAt) return
  lyricsEl.scrollTo({ top: el.offsetTop - (lyricsEl.clientHeight - el.offsetHeight) / 2, behavior: 'smooth' })
}

// LRCLIB знает только начало строк, поэтому слова заливаются равномерно по буквам за время
// строки. Длинную паузу до следующей строки (проигрыш) не растягиваем: ~13 букв в секунду.
function wordFill(line, time) {
  const { time: start, text } = lyrics.lines[line]
  const next = lyrics.lines[line + 1]?.time ?? start + 6
  const letters = text.replace(/\s+/g, '').length || 1
  const progress = (time - start) / Math.min(next - start, Math.max(1.2, letters / 13))
  return progress * letters
}

let karaokeFrame = 0

function startKaraoke() {
  if (karaokeFrame) return
  const tick = () => {
    const el = lyricsEl.children[lyricsLine]
    if (!lyrics?.synced || lyricsEl.hidden || !el) {
      karaokeFrame = 0
      return
    }
    let filled = wordFill(lyricsLine, audio.currentTime + 0.25)
    for (const word of el.querySelectorAll('.lw')) {
      const length = word.textContent.length
      word.style.setProperty('--p', Math.min(1, Math.max(0, filled / length)).toFixed(3))
      filled -= length
    }
    // На iPhone перерисовка текста с градиентом дорогая — хватает 15 кадров в секунду.
    karaokeFrame = audio.paused ? 0 : native ? setTimeout(() => requestAnimationFrame(tick), 50) : requestAnimationFrame(tick)
  }
  karaokeFrame = requestAnimationFrame(tick)
}

function toggleKaraoke(on = !$('#now').classList.contains('karaoke')) {
  $('#now').classList.toggle('karaoke', on)
  $('#now-karaoke').setAttribute('aria-pressed', on)
  if (on && lyricsEl.hidden) toggleLyrics(true)
  lyricsLine = -1
  syncLyrics()
}

function toggleLyrics(open = lyricsEl.hidden) {
  lyricsEl.hidden = !open
  $('#now').classList.toggle('show-lyrics', open)
  $('#now-lyrics-toggle').setAttribute('aria-pressed', open)
  $('#now-karaoke').hidden = !open
  if (!open) $('#now').classList.remove('karaoke')
  localStorage.setItem('lyrics', open)
  if (open && state.index >= 0) loadLyrics(state.queue[state.index])
}

/* ---------- очередь ---------- */

const queueBody = $('#queue-body')

function queueRow(track, qindex, current) {
  return `
    <div class="q-row${current ? ' is-current' : ''}" data-qindex="${qindex}" data-track="${track.id}" role="button" tabindex="0">
      ${artBox(cover(track, 'large'), 'q-art')}
      <span class="row-main">
        <span class="row-title" title="${esc(track.title)}">${esc(track.title)}</span>
        <span class="row-artist">${esc(track.user.username)}</span>
      </span>
      <span class="q-grip" aria-hidden="true"><svg><use href="#i-grip"/></svg></span>
      <button class="icon-btn q-remove" data-q-remove="${qindex}" aria-label="Убрать из очереди"><svg><use href="#i-close"/></svg></button>
    </div>`
}

function renderQueue() {
  if ($('#queue').hidden) return
  if (state.index < 0 || !state.queue.length) {
    queueBody.innerHTML = '<p class="queue-empty">Очередь пуста. Включи трек — здесь появится, что играет дальше.</p>'
    return
  }
  // У радио очередь растёт без конца, а сотни строк в DOM на телефоне заметно тормозят.
  const upcoming = state.queue.slice(state.index + 1, state.index + 101)
  queueBody.innerHTML = `
    <p class="eyebrow queue-group">Сейчас играет</p>
    ${queueRow(state.queue[state.index], state.index, true)}
    ${upcoming.length
      ? `<p class="eyebrow queue-group">Дальше</p>${upcoming.map((t, i) => queueRow(t, state.index + 1 + i, false)).join('')}`
      : '<p class="queue-hint">Дальше треков нет — когда очередь закончится, добавятся похожие.</p>'}`
}

function toggleQueue(open = $('#queue').hidden) {
  $('#queue').hidden = !open
  $('#queue-toggle').setAttribute('aria-pressed', open)
  renderQueue()
}

function queueAdd(track, playNext) {
  if (state.index < 0) {
    state.queue = [track]
    state.original = state.queue
    state.context = { label: 'Очередь' }
    state.more = null
    playAt(0)
  } else {
    state.queue.splice(playNext ? state.index + 1 : state.queue.length, 0, track)
    state.original = state.queue
    toast(playNext ? 'Играет следующим' : 'Добавлено в очередь')
    prefetchNext()
  }
  renderQueue()
}

function queueRemove(qindex) {
  if (qindex <= state.index) return
  state.queue.splice(qindex, 1)
  state.original = state.queue
  renderQueue()
  prefetchNext()
}

// Точка вставки при перетаскивании: строка под курсором и с какой стороны от неё.
function dropTarget(clientY) {
  const rows = [...queueBody.querySelectorAll('.q-row')].filter(r => Number(r.dataset.qindex) > state.index)
  for (const el of rows) {
    const box = el.getBoundingClientRect()
    if (clientY < box.top + box.height / 2) return { qindex: Number(el.dataset.qindex), before: true, el }
  }
  const last = rows[rows.length - 1]
  return last ? { qindex: Number(last.dataset.qindex), before: false, el: last } : null
}

function markDrop(clientY) {
  for (const el of queueBody.querySelectorAll('.drop-before, .drop-after')) el.classList.remove('drop-before', 'drop-after')
  const target = dropTarget(clientY)
  if (target) target.el.classList.add(target.before ? 'drop-before' : 'drop-after')
}

function moveInQueue(from, target) {
  const [track] = state.queue.splice(from, 1)
  let dest = target.qindex + (target.before ? 0 : 1)
  if (from < dest) dest--
  state.queue.splice(dest, 0, track)
  state.original = state.queue
  renderQueue()
  prefetchNext()
}

let dragFrom = null
let dragMoved = false

queueBody.addEventListener('pointerdown', event => {
  const grip = event.target.closest('.q-grip')
  if (!grip) return
  dragFrom = Number(grip.closest('.q-row').dataset.qindex)
  if (dragFrom <= state.index) {
    dragFrom = null
    return
  }
  dragMoved = false
  event.preventDefault()
  grip.closest('.q-row').classList.add('dragging')
  grip.setPointerCapture(event.pointerId)
})
queueBody.addEventListener('pointermove', event => {
  if (dragFrom === null) return
  dragMoved = true
  markDrop(event.clientY)
})
queueBody.addEventListener('pointerup', event => {
  if (dragFrom === null) return
  const target = dropTarget(event.clientY)
  for (const el of queueBody.querySelectorAll('.dragging, .drop-before, .drop-after')) el.classList.remove('dragging', 'drop-before', 'drop-after')
  if (dragMoved && target) moveInQueue(dragFrom, target)
  dragFrom = null
})
queueBody.addEventListener('click', event => {
  if (dragMoved) {
    dragMoved = false
    return
  }
  const remove = event.target.closest('[data-q-remove]')
  if (remove) return queueRemove(Number(remove.dataset.qRemove))
  const row = event.target.closest('.q-row')
  if (row) playAt(Number(row.dataset.qindex))
})

/* меню действий с треком */

let menuTrack = null

function openMenu(el) {
  const list = lists.get(el.dataset.list)
  menuTrack = list?.tracks[Number(el.dataset.index)]
  if (!menuTrack) return
  document.querySelector('.row-more.open, .mini-more.open')?.classList.remove('open')
  const menu = $('#track-menu')
  menu.querySelector('[data-menu="removeFromPlaylist"]').hidden = !(current.name === 'localPlaylist' || (current.name === 'playlist' && isOwnPlaylist(current.arg)))
  menu.hidden = false
  const box = el.getBoundingClientRect()
  const x = Math.max(8, Math.min(box.right - menu.offsetWidth, innerWidth - menu.offsetWidth - 8))
  const below = box.bottom + 4
  const y = below + menu.offsetHeight > innerHeight - 8 ? box.top - menu.offsetHeight - 4 : below
  menu.style.left = `${x}px`
  menu.style.top = `${Math.max(8, y)}px`
  el.classList.add('open')
}

function closeMenu() {
  $('#track-menu').hidden = true
  document.querySelector('.row-more.open, .mini-more.open')?.classList.remove('open')
  menuTrack = null
}

$('#track-menu').addEventListener('click', event => {
  const item = event.target.closest('[data-menu]')
  if (!item || !menuTrack) return
  const track = menuTrack
  closeMenu()
  if (item.dataset.menu === 'next') queueAdd(track, true)
  else if (item.dataset.menu === 'add') queueAdd(track, false)
  else if (item.dataset.menu === 'artist') go('user', track.user.id)
  else if (item.dataset.menu === 'station') playStation(track)
  else if (item.dataset.menu === 'share') shareTrack(track)
  else if (item.dataset.menu === 'playlist') openPlaylistDialog(track)
  else if (item.dataset.menu === 'download') downloadTrack(track)
  else if (item.dataset.menu === 'removeFromPlaylist') {
    if (current.name === 'localPlaylist') {
      removeFromLocalPlaylist(current.arg, track.id)
      go('localPlaylist', current.arg, false)
    } else {
      const id = current.arg
      removeFromPlaylist(id, track.id).then(() => go('playlist', id, false), err => toast(`Не убралось: ${errorText(err)}`))
    }
  }
})
document.addEventListener('pointerdown', event => {
  if (!$('#track-menu').hidden && !event.target.closest('#track-menu, [data-more]')) closeMenu()
}, true)

/* ---------- события ---------- */

document.addEventListener('click', event => {
  const more = event.target.closest('[data-more]')
  if (more) return openMenu(more)

  const target = event.target.closest('button, a[data-user], [data-list]')
  if (!target) return
  const { dataset } = target

  if (dataset.user) {
    if (target.closest('#now')) toggleNow(false)
    go('user', dataset.user)
  } else if (dataset.playlist) {
    go('playlist', dataset.playlist)
  } else if (dataset.system) {
    go('system', dataset.system)
  } else if (dataset.playSystem) {
    playSystem(dataset.playSystem)
  } else if (dataset.mix) {
    go('mix', dataset.mix)
  } else if (dataset.view) {
    go(dataset.view)
  } else if (dataset.search) {
    go('search', dataset.search)
  } else if (dataset.playList) {
    playList(dataset.playList, 0)
  } else if (dataset.shuffleList) {
    playList(dataset.shuffleList, Math.floor(Math.random() * (lists.get(dataset.shuffleList)?.tracks.length ?? 0)), true)
  } else if (dataset.list) {
    if (Number(dataset.track) === state.queue[state.index]?.id) togglePlay()
    else playList(dataset.list, Number(dataset.index))
  } else if (dataset.localPlaylist) {
    go('localPlaylist', dataset.localPlaylist)
  } else if (dataset.download) {
    toggleDownload(Number(dataset.download))
  } else if (dataset.downloadAll) {
    downloadList(dataset.downloadAll)
  } else if (dataset.likePlaylist) {
    togglePlaylistLike(dataset.likePlaylist)
  } else if (dataset.saveMix) {
    saveMixAsPlaylist(dataset.saveMix, dataset.mixTitle)
  } else if (dataset.historyPeriod) {
    go('history', dataset.historyPeriod, false)
  } else if (dataset.themeSet) {
    localStorage.setItem('theme', dataset.themeSet)
    applyTheme()
    refreshSettings()
  } else if (dataset.accentSet) {
    localStorage.setItem('accent', dataset.accentSet)
    const track = state.queue[state.index]
    if (dataset.accentSet === 'cover' && !track) document.documentElement.style.removeProperty('--accent-src')
    applyAccent(track && cover(track, 't67x67'))
    refreshSettings()
  } else if (dataset.iconSet) {
    sc.setIcon(dataset.iconSet)
      .then(() => localStorage.setItem('appIcon', dataset.iconSet), err => toast(`Иконку не сменить: ${errorText(err)}`))
      .finally(refreshSettings)
  } else if (dataset.sleep !== undefined) {
    setSleepTimer(Number(dataset.sleep))
  } else if (dataset.removeDownload) {
    removeDownload(Number(dataset.removeDownload))
  } else if (dataset.deletePlaylist) {
    deleteLocalPlaylist(dataset.deletePlaylist)
    refreshSettings()
  } else if (dataset.addScPlaylist) {
    const track = pendingTrack
    pendingTrack = null
    $('#playlist-dialog').close()
    if (track) addToPlaylist(dataset.addScPlaylist, track).catch(err => toast(`Не добавилось: ${errorText(err)}`))
  } else if (dataset.renameScPlaylist) {
    openRenameDialog(dataset.renameScPlaylist)
  } else if (dataset.deleteScPlaylist) {
    deletePlaylist(target)
  } else if (dataset.sharingScPlaylist) {
    const makePublic = dataset.sharing === 'private'
    updatePlaylist(dataset.sharingScPlaylist, { sharing: makePublic ? 'public' : 'private' })
      .then(() => {
        toast(makePublic ? 'Плейлист открыт всем' : 'Плейлист стал приватным')
        go('playlist', dataset.sharingScPlaylist, false)
      }, err => toast(`Не получилось: ${errorText(err)}`))
  } else if (dataset.addPlaylist) {
    if (pendingTrack) addToLocalPlaylist(dataset.addPlaylist, pendingTrack)
    pendingTrack = null
    $('#playlist-dialog').close()
    refreshSettings()
  } else if (dataset.action) {
    actions[dataset.action]()
  }
})

view.addEventListener('submit', async event => {
  event.preventDefault()
  const form = event.target
  if (form.id === 'sync-form') {
    // Адрес переписывают с экрана компьютера как попало: со схемой, со слешем в конце, без порта —
    // а запрос уходит на http://<адрес>/sync, и всё это его ломало.
    const address = form.address.value.trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, '')
    const withPort = !address || /:\d+$/.test(address) ? address : `${address}:47821`
    localStorage.setItem('syncPeer', JSON.stringify({ address: withPort, key: form.key.value.trim() }))
    await syncNow(true)
    refreshSettings()
    return
  }
  if (form.id === 'discord-form') {
    await sc.discord.set(form.discordId.value.trim())
    toast(form.discordId.value.trim() ? 'Статус в Discord включён' : 'Статус в Discord выключен')
    return
  }
  const button = form.querySelector('button')
  let url = form.url.value.trim()
  if (!/^https?:\/\//.test(url)) url = `https://${url}`

  button.disabled = true
  button.setAttribute('aria-busy', 'true')
  try {
    const found = await sc.api(`/resolve?url=${encodeURIComponent(url)}`)
    if (found.kind !== 'user') {
      toast('Это ссылка не на профиль — открой свою страницу SoundCloud и скопируй адрес')
      return
    }
    localStorage.setItem('profile', found.id)
    await boot()
  } catch (err) {
    toast(errorText(err).includes('404') ? 'Такого профиля на SoundCloud нет' : errorText(err))
  } finally {
    button.disabled = false
    button.removeAttribute('aria-busy')
  }
})

$('#new-playlist-form').addEventListener('submit', event => {
  event.preventDefault()
  const form = event.target
  const name = form.name.value.trim()
  if (!name) return
  const track = pendingTrack
  form.reset()
  pendingTrack = null
  $('#playlist-dialog').close()
  // Новые плейлисты живут в приложении: так они создаются и на ПК, и на телефоне и ездят между ними синхронизацией.
  const playlist = createLocalPlaylist(name)
  if (track) addToLocalPlaylist(playlist.id, track)
  else go('localPlaylist', playlist.id)
  refreshSettings()
})

$('#rename-form').addEventListener('submit', async event => {
  event.preventDefault()
  const form = event.target
  const name = form.name.value.trim()
  $('#rename-dialog').close()
  if (!name) return
  try {
    await updatePlaylist(form.dataset.playlist, { title: name })
    go('playlist', form.dataset.playlist, false)
  } catch (err) {
    toast(`Не переименовался: ${errorText(err)}`)
  }
})

let searchTimer
searchInput.addEventListener('input', () => {
  clearTimeout(searchTimer)
  searchTimer = setTimeout(() => go('search', searchInput.value, current.name !== 'search'), 350)
})
searchInput.addEventListener('keydown', event => {
  if (event.key !== 'Enter') return
  clearTimeout(searchTimer)
  go('search', searchInput.value, current.name !== 'search')
})

// По event.code, а не key: на русской раскладке key у тех же клавиш другой.
const LETTER_KEYS = {
  KeyM: () => { audio.muted = !audio.muted },
  KeyL: toggleLike,
  KeyS: toggleShuffle,
  KeyR: toggleRepeat,
  KeyQ: () => toggleQueue(),
}

function nudgeVolume(step) {
  const input = $('#volume')
  input.value = Math.min(100, Math.max(0, Number(input.value) + step))
  input.dispatchEvent(new Event('input'))
}

document.addEventListener('keydown', event => {
  if (event.key === 'Escape') {
    if (!$('#track-menu').hidden) return closeMenu()
    if (!$('#now').hidden) return toggleNow(false)
    if (!$('#queue').hidden) return toggleQueue(false)
  }
  if (event.target.matches('input')) {
    if (event.key === 'Escape') event.target.blur()
    return
  }
  // Тоже по event.code: на русской раскладке эта клавиша даёт «.», а Ctrl+K — «л».
  if (event.key === '/' || event.code === 'Slash' || (event.ctrlKey && event.code === 'KeyK')) {
    event.preventDefault()
    searchInput.focus()
  } else if (event.code === 'Space') {
    event.preventDefault()
    togglePlay()
  } else if (event.key === 'Enter' && event.target.matches('[role="button"]')) {
    event.target.click()
  } else if (event.altKey && event.key === 'ArrowLeft') {
    back()
  } else if (event.ctrlKey && event.key === 'ArrowRight') {
    next()
  } else if (event.ctrlKey && event.key === 'ArrowLeft') {
    prev()
  } else if (event.ctrlKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
    event.preventDefault()
    nudgeVolume(event.key === 'ArrowUp' ? 5 : -5)
  } else if (event.ctrlKey || event.metaKey || event.altKey) {
    return
  } else if (event.code in LETTER_KEYS) {
    LETTER_KEYS[event.code]()
  } else if (event.key === 'ArrowRight' && audio.duration) {
    audio.currentTime = Math.min(audio.duration, audio.currentTime + 5)
  } else if (event.key === 'ArrowLeft' && audio.duration) {
    audio.currentTime = Math.max(0, audio.currentTime - 5)
  }
})

window.addEventListener('mouseup', event => {
  if (event.button === 3) back()
})

// На телефоне мини-плеер сжимается, пока листаешь вниз, и возвращается при прокрутке вверх.
let lastScroll = 0
main.addEventListener('scroll', () => {
  main.classList.toggle('scrolled', main.scrollTop > 4)
  const delta = main.scrollTop - lastScroll
  if (Math.abs(delta) > 8) {
    document.body.classList.toggle('player-compact', delta > 0 && main.scrollTop > 120)
    lastScroll = main.scrollTop
  }
}, { passive: true })

if (sc.miniMode) {
  $('#mini-mode').hidden = false
  $('#mini-mode').addEventListener('click', async () => {
    const on = !document.body.classList.contains('mini-mode')
    document.body.classList.toggle('mini-mode', on)
    $('#mini-mode').setAttribute('aria-pressed', on)
    if (on) {
      toggleNow(false)
      toggleQueue(false)
    }
    await sc.miniMode(on)
  })
}

$('#play').addEventListener('click', togglePlay)
$('#next').addEventListener('click', next)
$('#prev').addEventListener('click', prev)
$('#shuffle').addEventListener('click', toggleShuffle)
$('#repeat').addEventListener('click', toggleRepeat)
$('#open-now').addEventListener('click', () => toggleNow(true))
$('#now-close').addEventListener('click', () => toggleNow(false))
$('#like').addEventListener('click', toggleLike)
$('#now-like').addEventListener('click', toggleLike)
$('#now-add').addEventListener('click', () => {
  const track = state.queue[state.index]
  if (track) openPlaylistDialog(track)
})
$('#queue-toggle').addEventListener('click', () => toggleQueue())
$('#queue-close').addEventListener('click', () => toggleQueue(false))
$('#now-queue').addEventListener('click', () => {
  toggleNow(false)
  toggleQueue(true)
})
$('#now-lyrics-toggle').addEventListener('click', () => toggleLyrics())
$('#now-karaoke').addEventListener('click', () => toggleKaraoke())
audio.addEventListener('play', startKaraoke)

lyricsEl.addEventListener('click', event => {
  const line = event.target.closest('[data-line]')
  if (!line) return
  audio.currentTime = lyrics.lines[line.dataset.line].time
  lyricsFollowAt = 0
})
// Пока человек сам листает текст, не утаскиваем его обратно к текущей строке.
for (const type of ['wheel', 'touchmove']) {
  lyricsEl.addEventListener(type, () => {
    lyricsFollowAt = performance.now() + 4000
  }, { passive: true })
}

$('#seek').addEventListener('input', event => {
  state.seeking = true
  setRange(event.target, event.target.value)
  $('#time-cur').textContent = fmtTime(event.target.value / 1000 * (audio.duration || 0))
})
$('#seek').addEventListener('change', event => {
  state.seeking = false
  if (audio.duration) audio.currentTime = event.target.value / 1000 * audio.duration
})

$('#volume').addEventListener('input', event => {
  const value = Number(event.target.value)
  setRange(event.target, value)
  // Громкость на слух логарифмическая: линейный ползунок почти весь ход звучит одинаково громко.
  audio.volume = (value / 100) ** 2
  audio.muted = false
  localStorage.setItem('volume', value)
})
$('#mute').addEventListener('click', () => {
  audio.muted = !audio.muted
})

const waveEl = $('#wave')
waveEl.addEventListener('pointermove', event => {
  const rect = waveEl.getBoundingClientRect()
  waveHover = (event.clientX - rect.left) / rect.width
  requestDraw()
})
waveEl.addEventListener('pointerleave', () => {
  waveHover = null
  requestDraw()
})
waveEl.addEventListener('click', event => {
  const rect = waveEl.getBoundingClientRect()
  if (audio.duration) audio.currentTime = (event.clientX - rect.left) / rect.width * audio.duration
})
new ResizeObserver(requestDraw).observe(waveEl)

audio.addEventListener('play', () => {
  syncPlayButton()
  startBeat()
})
audio.addEventListener('pause', () => {
  syncPlayButton()
  saveListened()
  saveSession()
})
audio.addEventListener('playing', () => {
  reloadedFor = null
})
audio.addEventListener('ended', next)
audio.addEventListener('volumechange', syncVolume)
audio.addEventListener('error', () => {
  if (!hls && audio.getAttribute('src')) recover()
})
audio.addEventListener('durationchange', () => {
  if (!Number.isFinite(audio.duration)) return
  $('#time-dur').textContent = fmtTime(audio.duration)
  $('#now-dur').textContent = fmtTime(audio.duration)
  syncMpris()
})
audio.addEventListener('timeupdate', () => {
  const { currentTime, duration } = audio
  const known = Number.isFinite(duration) && duration > 0
  if (!state.seeking) {
    setRange($('#seek'), known ? currentTime / duration * 1000 : 0)
    $('#time-cur').textContent = fmtTime(currentTime)
  }
  $('#now-cur').textContent = fmtTime(currentTime)
  $('#player').style.setProperty('--progress', known ? currentTime / duration : 0)
  if (performance.now() - sessionSavedAt > 15000) saveProgress()
  trackListened()
  requestDraw()
  syncLyrics()
})
window.addEventListener('beforeunload', saveListened)

// На телефоне мини-плеер листается пальцем: влево — следующий трек, вправо — предыдущий.
let swipeFrom = null
$('#player').addEventListener('touchstart', event => {
  const { clientX, clientY } = event.touches[0]
  swipeFrom = { x: clientX, y: clientY }
}, { passive: true })
$('#player').addEventListener('touchend', event => {
  const from = swipeFrom
  swipeFrom = null
  if (!from || document.body.classList.contains('now-open') || event.target.closest('.controls')) return
  const dx = event.changedTouches[0].clientX - from.x
  const dy = event.changedTouches[0].clientY - from.y
  if (Math.abs(dx) < 60 || Math.abs(dy) > Math.abs(dx) / 2) return
  sc.haptic?.()
  if (dx < 0) next()
  else if (state.index > 0) playAt(state.index - 1, -1)
})

// Экран «Сейчас играет» закрывается свайпом вниз, если он прокручен до верха.
let pullFrom = null
$('#now').addEventListener('touchstart', event => {
  const { clientX, clientY } = event.touches[0]
  pullFrom = $('#now').scrollTop <= 0 && !event.target.closest('.now-lyrics, .wave') ? { x: clientX, y: clientY } : null
}, { passive: true })
$('#now').addEventListener('touchend', event => {
  const from = pullFrom
  pullFrom = null
  if (!from) return
  const dx = event.changedTouches[0].clientX - from.x
  const dy = event.changedTouches[0].clientY - from.y
  if (dy > 120 && Math.abs(dx) < dy / 2) toggleNow(false)
})

// Долгое нажатие на трек открывает то же меню, что и «⋯»: на телефоне в кнопку трудно попасть.
let pressTimer = null
let pressStart = null
let pressFired = false
document.addEventListener('touchstart', event => {
  const row = event.target.closest('.row[data-list], .mini-row[data-list]')
  if (!row || event.target.closest('[data-more], [data-user]')) return
  pressStart = { x: event.touches[0].clientX, y: event.touches[0].clientY }
  pressTimer = setTimeout(() => {
    pressFired = true
    sc.haptic?.()
    openMenu(row)
  }, 450)
}, { passive: true })
document.addEventListener('touchmove', event => {
  if (!pressStart) return
  const { clientX, clientY } = event.touches[0]
  if (Math.hypot(clientX - pressStart.x, clientY - pressStart.y) > 10) clearTimeout(pressTimer)
}, { passive: true })
document.addEventListener('touchend', event => {
  clearTimeout(pressTimer)
  pressStart = null
  // Иначе после долгого нажатия сработает обычный тап и включит трек.
  if (pressFired) event.preventDefault()
  pressFired = false
})

audio.addEventListener('seeked', () => syncMpris(true))

const mediaActions = {
  play: () => audio.paused && togglePlay(),
  pause: () => audio.pause(),
  stop: () => audio.pause(),
  playpause: togglePlay,
  next,
  previous: prev,
  like: toggleLike,
  seekBy: seconds => {
    audio.currentTime = Math.max(0, audio.currentTime + seconds)
  },
  seekTo: seconds => {
    audio.currentTime = seconds
  },
}
sc.onMedia((action, value) => mediaActions[action](value))
if (windows) {
  for (const [action, handler] of Object.entries({ play: 'play', pause: 'pause', stop: 'stop', nexttrack: 'next', previoustrack: 'previous' })) {
    navigator.mediaSession.setActionHandler(action, () => mediaActions[handler]())
  }
  navigator.mediaSession.setActionHandler('seekto', details => mediaActions.seekTo(details.seekTime))
}

const savedVolume = Number(localStorage.getItem('volume') ?? 80)
setRange($('#volume'), savedVolume)
audio.volume = (savedVolume / 100) ** 2
syncVolume()
syncPlayButton()
if (localStorage.getItem('lyrics') === 'true') toggleLyrics(true)
applyTheme()
applyTimeOfDay()
if (accentChoice() !== 'cover') applyAccent(null)
boot()
