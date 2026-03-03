/**
 * Logger Middleware для Telegraf бота
 * Логирует все входящие и исходящие сообщения, команды, ошибки
 */

const fs = require('fs');
const path = require('path');

// Директория для логов
const logsDir = path.join(__dirname, '../../logs');

// Создать директорию logs если не существует
if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true });
}

/**
 * Получить путь к файлу лога
 * @param {string} type - Тип лога (messages, commands, errors, bridge)
 * @returns {string} Полный путь к файлу
 */
function getLogPath(type = 'messages') {
  const date = new Date().toISOString().split('T')[0];
  return path.join(logsDir, `${type}-${date}.log`);
}

/**
 * Записать в лог файл
 * @param {string} type - Тип лога
 * @param {Object} data - Данные для логирования
 */
function writeLog(type, data) {
  const timestamp = new Date().toISOString();
  const logPath = getLogPath(type);
  
  const logEntry = {
    timestamp,
    ...data,
  };
  
  fs.appendFileSync(logPath, JSON.stringify(logEntry) + '\n');
}

/**
 * Форматировать данные пользователя
 * @param {Object} user - Объект пользователя от Telegram
 * @returns {Object} Форматированные данные
 */
function formatUser(user) {
  if (!user) return null;
  
  return {
    id: user.id,
    username: user.username || 'unknown',
    first_name: user.first_name,
    last_name: user.last_name,
    is_bot: user.is_bot,
  };
}

/**
 * Форматировать данные сообщения
 * @param {Object} message - Объект сообщения от Telegram
 * @returns {Object} Форматированные данные
 */
function formatMessage(message) {
  if (!message) return null;
  
  return {
    message_id: message.message_id,
    type: message.text ? 'text' : message.photo ? 'photo' : message.document ? 'document' : 'unknown',
    text: message.text ? message.text.substring(0, 100) : null,
    date: new Date(message.date * 1000).toISOString(),
  };
}

/**
 * Middleware логгер для Telegraf
 * @param {Object} ctx - Контекст Telegraf
 * @param {Function} next - Следующий middleware
 */
async function loggerMiddleware(ctx, next) {
  const startTime = Date.now();
  
  try {
    const user = formatUser(ctx.from);
    const chat = {
      id: ctx.chat?.id,
      type: ctx.chat?.type,
      title: ctx.chat?.title || ctx.chat?.first_name,
    };

    // ── Логирование входящих сообщений ─────────────────────────────────
    if (ctx.message) {
      const message = formatMessage(ctx.message);
      
      // Если это команда
      if (ctx.message.text?.startsWith('/')) {
        const command = ctx.message.text.split(' ')[0];
        writeLog('commands', {
          command,
          chat,
          user,
          message,
        });
        console.log(`[CMD] ${user.username}@${chat.id}: ${command}`);
      } else {
        // Обычное сообщение
        writeLog('messages', {
          chat,
          user,
          message,
        });
        console.log(`[MSG] ${user.username}: ${message.text || `[${message.type}]`}`);
      }
    }

    // ── Логирование callback queries ────────────────────────────────────
    if (ctx.callbackQuery) {
      const data = ctx.callbackQuery.data.substring(0, 50);
      writeLog('messages', {
        type: 'callback_query',
        chat,
        user,
        data,
      });
      console.log(`[CALLBACK] ${user.username}: ${data}`);
    }

    // ── Выполнить следующий middleware ─────────────────────────────────
    await next();

    // ── Логирование времени обработки ──────────────────────────────────
    const duration = Date.now() - startTime;
    if (duration > 1000) {
      console.warn(`⚠️ Slow request: ${duration}ms for ${user.username}`);
      writeLog('errors', {
        type: 'slow_request',
        duration,
        user,
        chat,
      });
    }

  } catch (error) {
    // ── Логирование ошибок ────────────────────────────────────────────
    const duration = Date.now() - startTime;
    const user = formatUser(ctx.from);
    const chat = { id: ctx.chat?.id, type: ctx.chat?.type };
    
    writeLog('errors', {
      error: error.message,
      stack: error.stack,
      duration,
      user,
      chat,
    });
    
    console.error(`❌ Error [${duration}ms]: ${error.message}`);
    
    // Пробросить ошибку дальше
    throw error;
  }
}

/**
 * Получить логи за определённый период
 * @param {string} type - Тип лога
 * @param {number} lines - Количество последних строк
 * @returns {Array} Массив логов
 */
function readLogs(type = 'messages', lines = 50) {
  const logPath = getLogPath(type);
  
  if (!fs.existsSync(logPath)) {
    return [];
  }
  
  const content = fs.readFileSync(logPath, 'utf-8');
  const logLines = content.trim().split('\n');
  
  return logLines.slice(-lines).map(line => {
    try {
      return JSON.parse(line);
    } catch {
      return null;
    }
  }).filter(Boolean);
}

/**
 * Очистить старые логи (старше N дней)
 * @param {number} days - Количество дней
 */
function cleanOldLogs(days = 7) {
  const now = Date.now();
  const maxAge = days * 24 * 60 * 60 * 1000;
  
  try {
    const files = fs.readdirSync(logsDir);
    
    files.forEach(file => {
      const filePath = path.join(logsDir, file);
      const stats = fs.statSync(filePath);
      
      if (now - stats.mtime.getTime() > maxAge) {
        fs.unlinkSync(filePath);
        console.log(`🗑️ Deleted old log: ${file}`);
      }
    });
  } catch (err) {
    console.error('Error cleaning logs:', err);
  }
}

module.exports = loggerMiddleware;
module.exports.writeLog = writeLog;
module.exports.readLogs = readLogs;
module.exports.cleanOldLogs = cleanOldLogs;
module.exports.getLogPath = getLogPath;
