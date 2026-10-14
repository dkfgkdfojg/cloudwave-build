// Пример: любая активность в профиле Discord через discord.js из корня репозитория.
// Запуск: node example.js <Application ID> [game|music|video|competing]
// Discord (приложение, не вкладка браузера) должен быть запущен на этом же компьютере.

const { createPresence } = require('../../discord')

const clientId = process.argv[2] || process.env.DISCORD_CLIENT_ID
if (!clientId) {
  console.error('Укажи Application ID: node example.js 123456789012345678 [game|music|video|competing]')
  process.exit(1)
}

const now = Date.now()

// type: 0 — «Играет в», 2 — «Слушает», 3 — «Смотрит», 5 — «Соревнуется в».
// Тип 1 (стрим) и 4 (свой статус) через RPC поставить нельзя.
const activities = {
  game: {
    type: 0,
    details: 'Главное меню',              // первая строка под названием приложения
    state: 'В группе',                     // вторая строка
    timestamps: { start: now },            // «прошло 00:05» — счётчик от этого момента
    party: { id: 'party-1', size: [2, 4] },// «(2 из 4)» после state
    assets: {
      large_image: 'logo',                 // ключ картинки из Rich Presence → Art Assets приложения…
      large_text: 'Подсказка при наведении',
      small_image: 'https://example.com/cover.png', // …или прямая https-ссылка
      small_text: 'Уровень 12',
    },
  },
  music: {
    type: 2,
    details: 'Название трека',
    state: 'Исполнитель',
    // start + end рисуют полосу прогресса трека.
    timestamps: { start: now - 30_000, end: now + 180_000 },
    assets: { large_image: 'https://example.com/cover.png', large_text: 'Альбом' },
    // До двух кнопок. Их видят другие, а сам владелец статуса — нет.
    buttons: [{ label: 'Слушать', url: 'https://soundcloud.com' }],
  },
  video: {
    type: 3,
    details: 'Серия 3',
    state: 'Сезон 1',
    timestamps: { start: now, end: now + 45 * 60_000 },
  },
  competing: {
    type: 5,
    details: 'Финал',
    state: 'Счёт 2:1',
  },
}

const activity = activities[process.argv[3] ?? 'game']
if (!activity) {
  console.error(`Нет такой активности. Есть: ${Object.keys(activities).join(', ')}`)
  process.exit(1)
}

const presence = createPresence(clientId)
presence.set(activity)
console.log('Статус отправлен — смотри свой профиль в Discord. Ctrl+C — убрать и выйти.')

// Пока процесс жив, статус держится; можно менять его в любой момент новым set().
const keepAlive = setInterval(() => {}, 1 << 30)

process.on('SIGINT', () => {
  presence.set(null) // null убирает активность
  clearInterval(keepAlive)
  // set() отправляет с задержкой 1,5 с (Discord пропускает не больше 5 обновлений за 20 с).
  setTimeout(() => process.exit(0), 2000)
})
