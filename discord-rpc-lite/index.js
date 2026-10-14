const net = require('node:net')
const path = require('node:path')

// Discord Rich Presence по локальному IPC-сокету клиента. Кадр: op (uint32 LE), длина (uint32 LE), JSON.
const HANDSHAKE = 0
const FRAME = 1
const CLOSE = 2

// Обычный клиент кладёт сокет в XDG_RUNTIME_DIR (на macOS — в TMPDIR), flatpak и snap — в свои
// подкаталоги. На Windows вместо сокета именованный канал.
function socketPaths() {
  if (process.platform === 'win32') return Array.from({ length: 10 }, (_, i) => `\\\\?\\pipe\\discord-ipc-${i}`)
  const runtime = process.env.XDG_RUNTIME_DIR || process.env.TMPDIR || '/tmp'
  const dirs = [runtime, path.join(runtime, 'app/com.discordapp.Discord'), path.join(runtime, 'snap.discord')]
  return dirs.flatMap(dir => Array.from({ length: 10 }, (_, i) => path.join(dir, `discord-ipc-${i}`)))
}

function encode(op, payload) {
  const body = Buffer.from(JSON.stringify(payload))
  const header = Buffer.alloc(8)
  header.writeUInt32LE(op, 0)
  header.writeUInt32LE(body.length, 4)
  return Buffer.concat([header, body])
}

function openSocket() {
  const paths = socketPaths()
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const target = paths.shift()
      if (!target) return reject(new Error('Discord не запущен'))
      const socket = net.createConnection(target)
      socket.once('error', attempt)
      socket.once('connect', () => {
        socket.removeListener('error', attempt)
        resolve(socket)
      })
    }
    attempt()
  })
}

// Ждём READY: на неизвестный id приложения Discord отвечает CLOSE, и это надо показать.
function handshake(socket, clientId) {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0)
    const onData = chunk => {
      buffer = Buffer.concat([buffer, chunk])
      if (buffer.length < 8 || buffer.length < 8 + buffer.readUInt32LE(4)) return
      socket.removeListener('data', onData)
      const message = JSON.parse(buffer.subarray(8, 8 + buffer.readUInt32LE(4)))
      if (buffer.readUInt32LE(0) === CLOSE) reject(new Error(`Discord отказал: ${message.message}`))
      else resolve()
    }
    socket.on('data', onData)
    socket.once('close', () => reject(new Error('Discord закрыл соединение')))
    socket.write(encode(HANDSHAKE, { v: 1, client_id: clientId }))
  })
}

function createPresence(clientId) {
  let socket = null
  let connecting = null
  let wanted = null
  let sent
  let timer

  async function connect() {
    const candidate = await openSocket()
    try {
      await handshake(candidate, clientId)
    } catch (err) {
      candidate.destroy()
      throw err
    }
    // Ответы не нужны, но поток надо вычитывать, иначе Discord упрётся в полный буфер.
    candidate.on('data', () => {})
    candidate.on('error', () => {})
    candidate.on('close', () => {
      socket = null
      sent = undefined
    })
    socket = candidate
  }

  async function flush() {
    const payload = JSON.stringify(wanted)
    if (payload === sent) return
    if (!socket) {
      connecting ??= connect().finally(() => { connecting = null })
      await connecting
    }
    socket.write(encode(FRAME, {
      cmd: 'SET_ACTIVITY',
      args: { pid: process.pid, activity: wanted },
      nonce: String(Date.now()),
    }))
    sent = payload
  }

  // Discord пропускает не больше 5 обновлений за 20 с, а приложение может слать состояние хоть на каждый кадр.
  function schedule() {
    clearTimeout(timer)
    timer = setTimeout(() => flush().catch(err => console.error('Discord:', err.message)), 1500)
  }

  // Discord могут запустить позже приложения.
  setInterval(() => {
    if (!socket && !connecting && wanted) schedule()
  }, 30000).unref()

  return {
    set(activity) {
      wanted = activity
      schedule()
    },
  }
}

module.exports = { createPresence, socketPaths, encode }
