// Собирает www/ для Capacitor из файлов десктопной версии: интерфейс общий,
// вместо preload.js подключается bridge.js.
import fs from 'node:fs'
import path from 'node:path'

const here = import.meta.dirname
const root = path.join(here, '..')
const www = path.join(here, 'www')

fs.rmSync(www, { recursive: true, force: true })
fs.mkdirSync(www)

fs.copyFileSync(path.join(root, 'style.css'), path.join(www, 'style.css'))
fs.copyFileSync(path.join(root, 'renderer.js'), path.join(www, 'renderer.js'))
fs.copyFileSync(path.join(here, 'bridge.js'), path.join(www, 'bridge.js'))
// Без бандлера Capacitor.registerPlugin и Capacitor.Plugins.CapacitorHttp берутся не из
// нативного моста (тот добавляет только сообщения), а из этого браузерного билда ядра.
fs.copyFileSync(path.join(here, 'node_modules/@capacitor/core/dist/capacitor.js'), path.join(www, 'capacitor.js'))
fs.cpSync(path.join(here, 'node_modules/hls.js/dist/hls.min.js'), path.join(www, 'node_modules/hls.js/dist/hls.min.js'))
fs.cpSync(path.join(here, 'node_modules/@fontsource-variable/inter'), path.join(www, 'node_modules/@fontsource-variable/inter'), { recursive: true })

const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8')
const withBridge = html.replace('<script src="renderer.js">', '<script src="capacitor.js"></script>\n  <script src="bridge.js"></script>\n  <script src="renderer.js">')
if (withBridge === html) throw new Error('В index.html не нашёлся <script src="renderer.js">')
fs.writeFileSync(path.join(www, 'index.html'), withBridge)
