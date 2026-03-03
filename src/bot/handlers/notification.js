// Уведомления специалиста + мост для диалога
// Вариант 2: Bridge — специалист просто пишет боту, бот пересылает клиенту

// Map: chatId -> orderNumber (для моста)
const activeBridges = new Map();

let _bot = null; // ссылка на экземпляр бота (устанавливается при старте)

function setBotInstance(bot) {
  _bot = bot;
}

// Telegram chat_id специалиста из .env
function getSpecialistChatId() {
  return process.env.SPECIALIST_CHAT_ID
    ? parseInt(process.env.SPECIALIST_CHAT_ID)
    : null;
}

// ── Уведомить специалиста о новом заказе ─────────────────────────────────

async function notifyNewOrder(order, client) {
  const specialistId = getSpecialistChatId();
  if (!specialistId || !_bot) return;

  const urgencyLabels = {
    STANDARD: 'Стандарт',
    PLUS200:  '🚀 +200₽',
    PLUS500:  '⚡ +500₽',
    PLUS800:  '🔥 +800₽',
  };

  const deliveryLabels = {
    COURIER: '🚗 Курьер',
    SDEK:    '📦 СДЭК',
    PICKUP:  '🤝 Самовывоз',
  };

  const text = `🆕 *Новый заказ ${order.order_number}*

👤 Клиент: ${client.first_name}${client.username ? ' (@' + client.username + ')' : ''}
📦 Материал: *${order.material_code}* (${order.method_code})
📐 Размер: ${order.size_x || '?'}×${order.size_y || '?'}×${order.size_z || '?'} мм
🔢 Кол-во: ${order.quantity} шт
⏱ Срочность: ${urgencyLabels[order.urgency] || order.urgency}
🚚 Доставка: ${deliveryLabels[order.delivery_type] || order.delivery_type}
💰 Сумма: ${order.total_price ? order.total_price + ' ₽' : 'не рассчитана'}
📝 Задача: ${order.use_description || 'не указана'}`;

  try {
    await _bot.telegram.sendMessage(specialistId, text, {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: '✅ Принять заказ',    callback_data: `accept_${order.order_number}` }],
          [{ text: '💬 Написать клиенту', callback_data: `bridge_${order.order_number}_${client.telegram_user_id}` }],
          [{ text: '❌ Отклонить',        callback_data: `reject_${order.order_number}` }],
        ]
      }
    });
  } catch (err) {
    console.error('Ошибка уведомления специалиста:', err.message);
  }
}

// ── Активировать мост специалист ↔ клиент ────────────────────────────────

function openBridge(orderNumber, specialistChatId, clientChatId) {
  activeBridges.set(specialistChatId, { orderNumber, clientChatId, role: 'specialist' });
  activeBridges.set(clientChatId,    { orderNumber, clientChatId: specialistChatId, role: 'client' });
  console.log(`Bridge открыт: заказ ${orderNumber}`);
}

function closeBridge(orderNumber) {
  for (const [key, val] of activeBridges.entries()) {
    if (val.orderNumber === orderNumber) activeBridges.delete(key);
  }
  console.log(`Bridge закрыт: заказ ${orderNumber}`);
}

function getBridge(chatId) {
  return activeBridges.get(chatId) || null;
}

function isInBridge(chatId) {
  return activeBridges.has(chatId);
}

// ── Переслать сообщение через мост ───────────────────────────────────────

async function forwardThroughBridge(fromChatId, text, fileId, messageType) {
  const bridge = getBridge(fromChatId);
  if (!bridge || !_bot) return false;

  const targetId = bridge.clientChatId;
  const prefix   = bridge.role === 'specialist'
    ? '💬 *Специалист:*'
    : `👤 *Клиент [${bridge.orderNumber}]:*`;

  try {
    if (messageType === 'PHOTO' && fileId) {
      await _bot.telegram.sendPhoto(targetId, fileId,
        { caption: `${prefix} ${text || ''}`, parse_mode: 'Markdown' });
    } else if (messageType === 'FILE' && fileId) {
      await _bot.telegram.sendDocument(targetId, fileId,
        { caption: `${prefix} ${text || ''}`, parse_mode: 'Markdown' });
    } else {
      await _bot.telegram.sendMessage(targetId,
        `${prefix} ${text}`, { parse_mode: 'Markdown' });
    }
    return true;
  } catch (err) {
    console.error('Ошибка пересылки через мост:', err.message);
    return false;
  }
}

// ── Уведомить клиента о смене статуса ────────────────────────────────────

async function notifyClientStatusChange(clientChatId, orderNumber, newStatus) {
  if (!_bot) return;

  const messages = {
    ACCEPTED:    `✅ Заказ *${orderNumber}* принят специалистом!`,
    PAID:        `💳 Заказ *${orderNumber}* оплачен. Передаём в работу.`,
    IN_PROGRESS: `🖨 Заказ *${orderNumber}* печатается!`,
    READY:       `📦 Заказ *${orderNumber}* готов! Свяжемся для передачи.`,
    DELIVERED:   `✔️ Заказ *${orderNumber}* выдан. Спасибо!`,
  };

  const msg = messages[newStatus];
  if (!msg) return;

  try {
    await _bot.telegram.sendMessage(clientChatId, msg, { parse_mode: 'Markdown' });
  } catch (err) {
    console.error('Ошибка уведомления клиента:', err.message);
  }
}

// ── Запрос отзыва ─────────────────────────────────────────────────────────

async function sendReviewRequest(clientChatId, orderNumber) {
  if (!_bot) return;
  try {
    await _bot.telegram.sendMessage(clientChatId,
      `🙏 Ваш заказ *${orderNumber}* выдан!\n\nБудем рады отзыву — это помогает нам становиться лучше.`,
      {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [{ text: '⭐ Оставить отзыв', callback_data: `review_${orderNumber}` }],
            [{ text: '➡️ Пропустить',     callback_data: `skip_review_${orderNumber}` }],
          ]
        }
      }
    );
  } catch (err) {
    console.error('Ошибка запроса отзыва:', err.message);
  }
}

module.exports = {
  setBotInstance,
  notifyNewOrder,
  openBridge, closeBridge, getBridge, isInBridge,
  forwardThroughBridge,
  notifyClientStatusChange,
  sendReviewRequest,
  getSpecialistChatId,
};
