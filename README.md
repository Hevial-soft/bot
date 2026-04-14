# Hevial Bot

Telegram-бот для 3D-печати. Принимает заказы, подбирает материал, уведомляет специалиста.

## Быстрый старт

### 1. Установить зависимости
```bash
npm install
```

### 2. Создать .env файл
```bash
cp .env.example .env
```
Заполнить:
- `BOT_TOKEN` — токен от @BotFather
- `SPECIALIST_CHAT_ID` — ваш Telegram ID
- `ANTHROPIC_API_KEY` — ключ Claude API
- `DB_PASSWORD` — пароль PostgreSQL

### 3. Создать базу данных
```bash
psql -U postgres -c "CREATE DATABASE hevial_db"
psql -U postgres -d hevial_db -f hevial_full_schema.sql
```

### 4. Запустить
```bash
# Продакшен
npm start

# Разработка (с авторестартом)
npm run dev
```

## Структура проекта

```
src/
├── bot/
│   ├── dialog.js          — главная логика диалога (все шаги)
│   ├── index.js           — Telegraf бот, роутинг команд и callback
│   ├── steps.js           — константы шагов диалога
│   └── middleware/
│       └── logger.js      — логирование запросов
├── services/
│   ├── session.js         — хранение состояния диалога в памяти
│   ├── ai.js              — подбор материала (эвристика + Claude API)
│   ├── pricing.js         — расчёт стоимости и сроков
│   ├── notification.js    — уведомления специалиста + мост диалога
│   └── scheduler.js       — автозадачи (отзывы, напоминания)
└── db/
    └── index.js           — все запросы к PostgreSQL
```

## Как работает мост специалист ↔ клиент

1. Клиент нажимает "Связаться со специалистом"
2. Специалист получает уведомление с кнопкой "💬 Начать диалог"
3. Нажимает — открывается мост
4. Теперь специалист просто пишет боту — клиент получает сообщения
5. Клиент отвечает — специалист получает с пометкой "👤 Клиент"
6. Закрыть диалог: `/endchat`

## Статусы заказа

```
NEW → PROCESSING → ACCEPTED → PAID → IN_PROGRESS → READY → DELIVERED → CLOSED
```
