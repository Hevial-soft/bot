require('dotenv').config();

const { bot } = require('./bot/index.js');

// Запуск бота
bot.launch().catch((err) => {
  console.error('Bot launch error:', err);
  process.exit(1);
});

// Graceful shutdown
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
