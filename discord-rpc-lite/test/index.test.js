const { test, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const net = require('node:net')
const os = require('node:os')
const path = require('node:path')
const { createPresence, socketPaths, encode } = require('../index')

// Разбирает поток кадров Discord IPC: op (uint32 LE), длина (uint32 LE), JSON.
function frames(socket, onFrame) {
  let buffer = Buffer.alloc(0)
  socket.on('data', chunk => {
    buffer = Buffer.concat([buffer, chunk])
    while (buffer.length >= 8 && buffer.length >= 8 + buffer.readUInt32LE(4)) {
      const length = buffer.readUInt32LE(4)
      onFrame(buffer.readUInt32LE(0), JSON.parse(buffer.subarray(8, 8 + length)))
      buffer = buffer.subarray(8 + length)
    }
  })
}

// Поддельный клиент Discord на первом же адресе, который проверяет модуль.
let dir
let server
let runtime
let connections = []

beforeEach(() => {
  runtime = process.env.XDG_RUNTIME_DIR
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'discord-rpc-lite-'))
  process.env.XDG_RUNTIME_DIR = dir
})

// Модуль держит соединение открытым, и без destroy() server.close() ждал бы его вечно.
afterEach(async () => {
  for (const socket of connections) socket.destroy()
  connections = []
  if (server) await new Promise(resolve => server.close(resolve))
  server = null
  if (runtime === undefined) delete process.env.XDG_RUNTIME_DIR
  else process.env.XDG_RUNTIME_DIR = runtime
  fs.rmSync(dir, { recursive: true, force: true })
})

function fakeDiscord(onConnection) {
  server = net.createServer(socket => {
    connections.push(socket)
    onConnection(socket)
  })
  return new Promise(resolve => server.listen(socketPaths()[0], resolve))
}

test('кадр: op и длина в little-endian, дальше JSON', () => {
  const frame = encode(1, { cmd: 'X' })
  assert.equal(frame.readUInt32LE(0), 1)
  assert.equal(frame.readUInt32LE(4), frame.length - 8)
  assert.deepEqual(JSON.parse(frame.subarray(8)), { cmd: 'X' })
})

test('адреса Discord для текущей системы', () => {
  const paths = socketPaths()
  assert.equal(paths.length, process.platform === 'win32' ? 10 : 30)
  if (process.platform === 'win32') {
    assert.equal(paths[0], '\\\\?\\pipe\\discord-ipc-0')
    assert.equal(paths[9], '\\\\?\\pipe\\discord-ipc-9')
  } else {
    assert.equal(paths[0], path.join(dir, 'discord-ipc-0'))
    assert.ok(paths.includes(path.join(dir, 'app/com.discordapp.Discord', 'discord-ipc-0')))
    assert.ok(paths.includes(path.join(dir, 'snap.discord', 'discord-ipc-9')))
  }
})

test('рукопожатие и статус уходят в Discord', { timeout: 10000 }, async () => {
  const received = []
  let finish
  const done = new Promise(resolve => { finish = resolve })
  await fakeDiscord(socket => frames(socket, (op, message) => {
    received.push({ op, message })
    if (op === 0) return socket.write(encode(1, { cmd: 'DISPATCH', evt: 'READY' }))
    socket.end()
    finish()
  }))

  const activity = { type: 2, details: 'Трек', state: 'Автор' }
  createPresence('1234567890').set(activity)
  await done

  assert.deepEqual(received[0], { op: 0, message: { v: 1, client_id: '1234567890' } })
  assert.equal(received[1].op, 1)
  assert.equal(received[1].message.cmd, 'SET_ACTIVITY')
  assert.equal(received[1].message.args.pid, process.pid)
  assert.deepEqual(received[1].message.args.activity, activity)
})

test('частые обновления схлопываются в одно', { timeout: 10000 }, async () => {
  const activities = []
  await fakeDiscord(socket => frames(socket, (op, message) => {
    if (op === 0) socket.write(encode(1, { evt: 'READY' }))
    else activities.push(message.args.activity)
  }))

  const presence = createPresence('1')
  for (let i = 0; i < 5; i++) presence.set({ details: `seek ${i}` })
  await new Promise(resolve => setTimeout(resolve, 2500))

  assert.deepEqual(activities, [{ details: 'seek 4' }])
})

test('отказ Discord не роняет приложение', { timeout: 10000 }, async () => {
  let handshakes = 0
  await fakeDiscord(socket => frames(socket, op => {
    if (op !== 0) return
    handshakes++
    socket.write(encode(2, { code: 4000, message: 'Invalid Client ID' }))
  }))

  const errors = []
  const original = console.error
  console.error = (...args) => errors.push(args.join(' '))
  try {
    createPresence('bad').set({ details: 'x' })
    await new Promise(resolve => setTimeout(resolve, 2500))
  } finally {
    console.error = original
  }

  assert.equal(handshakes, 1)
  assert.ok(errors.some(line => line.includes('Invalid Client ID')), errors.join('\n'))
})
