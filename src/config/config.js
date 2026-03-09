require('dotenv').config()

module.exports = {
  bot: {
    token: process.env.BOT_TOKEN,
  },
  db: {
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    host: process.env.DB_HOST || 'localhost',
    port: process.env.DB_PORT || 5432,
    database: process.env.DB_NAME,
  },
  ai: {
    apiKey: process.env.ANTHROPIC_API_KEY,
  },
  env: process.env.NODE_ENV || 'development',
}
