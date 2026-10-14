# discord-rpc-lite

Discord Rich Presence для Node.js без библиотек.

*Zero-dependency Discord Rich Presence for Node.js — any activity type, Windows / Linux / macOS.*

`index.js` — около ста строк на чистом Node.js, без зависимостей. Он ставит в
профиле Discord любую активность: «Играет в», «Слушает», «Смотрит», «Соревнуется в». Работает на
Windows (именованный канал), Linux (обычный клиент, flatpak, snap) и macOS.
Выделен из [Cloudwave](https://github.com/dkfgkdfojg/cloudwave-build): плеер показывает через
него текущий трек.

## Быстрый старт

1. На https://discord.com/developers/applications создай приложение (New Application). Его
   название будет в статусе: «Играет в <название>». Скопируй **Application ID**.
2. Картинки по желанию: Rich Presence → Art Assets, загрузить и запомнить ключ (например `logo`).
   Можно вместо ключа дать прямую `https://`-ссылку на картинку.
3. Запусти Discord-приложение (не браузерную версию) и пример:

```sh
node example.js <Application ID> game    # или music, video, competing
```

Ctrl+C убирает статус и выходит.

## В своём коде

Скопируй `index.js` к себе (например, как `discord-rpc.js`), дальше так:

```js
const { createPresence } = require('./discord-rpc')

const presence = createPresence('123456789012345678') // Application ID

presence.set({
  type: 0,                                   // 0 играет, 2 слушает, 3 смотрит, 5 соревнуется
  details: 'Первая строка',
  state: 'Вторая строка',
  timestamps: { start: Date.now() },         // счётчик «прошло»; с end — обратный отсчёт / прогресс
  assets: { large_image: 'logo', large_text: 'Подсказка' },
  buttons: [{ label: 'Сайт', url: 'https://example.com' }],
})

presence.set(null)                           // убрать статус
```

`set()` можно вызывать сколько угодно часто: модуль сам выжидает 1,5 с и шлёт только последнее
состояние, а одинаковое повторно не отправляет. Если Discord запустили позже, модуль переподключится
сам (проверка раз в 30 с).

## Что стоит знать

- Каждая строка (`details`, `state`, `large_text`…) — от 2 до 128 символов, иначе Discord отклонит
  всю активность.
- Discord пропускает не больше 5 обновлений за 20 секунд.
- Кнопок максимум две, и сам владелец статуса их не видит — только другие.
- Discord видит статус, пока жив процесс, который его поставил: закрылась программа — статус пропал.
- Неверный Application ID: Discord закрывает соединение, модуль пишет ошибку в `console.error`.
- Протокол: кадр = op (uint32 LE) + длина (uint32 LE) + JSON. Сначала рукопожатие
  `{ v: 1, client_id }` с op 0, потом команды `SET_ACTIVITY` с op 1.

## Тесты

```sh
npm test
```

Поднимают поддельный клиент Discord на том же адресе, куда ходит модуль, и проверяют рукопожатие,
отправку статуса, схлопывание частых обновлений и отказ Discord. Проверены на Linux.

## Лицензия

MIT
