// notification.js — уведомления и мост специалист ↔ клиент
// Версия 2.0:
//   - Группа специалистов вместо одного chat_id
//   - Мосты хранятся в БД (не теряются при рестарте)
//   - Отдельный флоу для заказов моделирования (без моста, только user_id)
//   - Кнопка "Взять диалог" — любой специалист из группы

'use strict';

const db = require('../db');

let _bot = null;

function setBotInstance(bot) {
  _bot = bot;
}

// ID группы специалистов из .env
function getGroupId() {
  const id = process.env.SPECIALIST_GROUP_ID;
  return id ? parseInt(id) : null;
}

// ═══════════════════════════════════════════════════════════════════════════
// УВЕДОМЛЕНИЯ О НОВЫХ ЗАКАЗАХ (ПЕЧАТЬ)
// ═══════════════════════════════════════════════════════════════════════════

async function notifyNewOrder(order, client) {
  const groupId = getGroupId();
  if (!groupId || !_bot) return;

  const urgencyLabels = {
    STANDARD: 'Стандарт', PLUS200: '🚀 +200₽',
    PLUS500:  '⚡ +500₽',  PLUS800: '🔥 +800₽',
  };
  const deliveryLabels = {
    COURIER: '🚗 Курьер', SDEK: '📦 СДЭК', PICKUP: '🤝 Самовывоз',
  };

  const clientTag = client.username
    ? `@${client.username}`
    : `[${client.first_name}](tg://user?id=${client.telegram_user_id})`;

  const text =
    `🆕 *Новый заказ ${order.order_number}*\n\n` +
    `👤 Клиент: ${clientTag}\n` +
    `🆔 TG ID: \`${client.telegram_user_id}\`\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `🧱 Материал: *${order.material_code}* (${order.method_code})\n` +
    `📐 Размер: ${order.size_x || '?'}×${order.size_y || '?'}×${order.size_z || '?'} мм\n` +
    (order.volume_cm3 ? `📦 Объём: ${parseFloat(order.volume_cm3).toFixed(1)} см³\n` : '') +
    `🔢 Количество: ${order.quantity} шт\n` +
    `⏱ Срочность: ${urgencyLabels[order.urgency] || order.urgency}\n` +
    `🚚 Доставка: ${deliveryLabels[order.delivery_type] || order.delivery_type}\n` +
    `💰 Сумма: ${order.total_price ? order.total_price + ' ₽' : 'не рассчитана'}\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `📝 Задача: _${order.use_description || 'не указана'}_`;

  try {
    await _bot.telegram.sendMessage(groupId, text, {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: '✅ Принять заказ',    callback_data: `accept_${order.order_number}` }],
          [{ text: '💬 Написать клиенту', callback_data: `bridge_open_${order.order_number}_${client.telegram_user_id}` }],
          [{ text: '❌ Отклонить',        callback_data: `reject_${order.order_number}` }],
        ]
      }
    });
  } catch (err) {
    console.error('[Notify] notifyNewOrder error:', err.message);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// УВЕДОМЛЕНИЯ О ЗАКАЗАХ МОДЕЛИРОВАНИЯ
// Специалист связывается напрямую — без моста
// ═══════════════════════════════════════════════════════════════════════════

async function notifyModelingOrder(order, client, fromUser) {
  const groupId = getGroupId();
  if (!groupId || !_bot) return;

  const urgencyLabels = {
    STANDARD: '⏱ Стандарт (от 5 дней)',
    URGENT:   '🚀 Срочно 3–5 дней (+1 000₽)',
  };
  const deliveryLabels = {
    CDEK:           '📦 Отправка СДЭК',
    COURIER_PICKUP: '🚗 Забираем курьером (+300₽)',
    PHOTO:          '📷 По фото/описанию',
  };

  const dims = (order.size_x && order.size_y && order.size_z)
    ? `${order.size_x}×${order.size_y}×${order.size_z} мм`
    : 'не указаны';

  // Прямая ссылка на клиента для связи
  const clientLink = fromUser.username
    ? `@${fromUser.username}`
    : `[${client.first_name}](tg://user?id=${order.telegram_id})`;

  const text =
    `📐 *Заявка на 3D-моделирование ${order.order_number}*\n\n` +
    `👤 Клиент: ${clientLink}\n` +
    `🆔 TG ID: \`${order.telegram_id}\`\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `📝 Описание: _${order.use_description}_\n` +
    `📐 Габариты: *${dims}*\n` +
    `🔧 Тип: *${order.is_reverse ? 'Реверс-инжиниринг' : 'Новая деталь'}*\n` +
    `📦 Передача: *${deliveryLabels[order.delivery_type] || order.delivery_type}*\n` +
    `⏱ Срочность: *${urgencyLabels[order.urgency] || order.urgency}*\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `⚠️ *Связаться напрямую с клиентом — нажав на его имя выше.*\n` +
    `Мост не используется.`;

  try {
    // Пересылаем фото если было
    if (order.photo_id) {
      await _bot.telegram.sendPhoto(groupId, order.photo_id, {
        caption: `📷 Фото детали — заявка ${order.order_number}`,
      });
    }

    await _bot.telegram.sendMessage(groupId, text, {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: '✅ Взял в работу', callback_data: `modeling_take_${order.order_number}` }],
        ]
      }
    });
  } catch (err) {
    console.error('[Notify] notifyModelingOrder error:', err.message);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// УВЕДОМЛЕНИЕ КОГДА КЛИЕНТ ЗАПРОСИЛ СПЕЦИАЛИСТА В ПРОЦЕССЕ ДИАЛОГА
// Постит полный контекст + кнопку "Взять диалог" (мост)
// ═══════════════════════════════════════════════════════════════════════════

async function notifySpecialistGroup(ctx, client, session) {
  const groupId = getGroupId();
  if (!groupId || !_bot) return;

  // Загружаем последние сообщения диалога
  const history = await db.getRecentMessages(client.id, 8);
  const historyText = history.length > 0
    ? history.map(m => {
        const icon = m.role === 'USER' ? '👤' : '🤖';
        return `${icon} ${(m.message_text || '[файл]').slice(0, 100)}`;
      }).join('\n')
    : '_история пуста_';

  const clientTag = client.username
    ? `@${client.username}`
    : `[${client.first_name}](tg://user?id=${ctx.from.id})`;

  const orderInfo = session.order_number
    ? `📋 Заказ: *${session.order_number}*\n` +
      `🧱 Материал: ${session.confirmed_material || 'не выбран'}\n` +
      `📐 Размер: ${session.size_x ? `${session.size_x}×${session.size_y}×${session.size_z} мм` : 'не указан'}\n`
    : '_Заказ ещё не оформлен_\n';

  const text =
    `🆘 *Клиент запросил специалиста*\n\n` +
    `👤 Клиент: ${clientTag}\n` +
    `🆔 TG ID: \`${ctx.from.id}\`\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    orderInfo +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `💬 *Последние сообщения:*\n${historyText}`;

  try {
    // Пересылаем фото если было в сессии
    if (session.photo_id) {
      await _bot.telegram.sendPhoto(groupId, session.photo_id, {
        caption: `📷 Фото от клиента — ${client.first_name}`,
      });
    }

    const msg = await _bot.telegram.sendMessage(groupId, text, {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: '🙋 Взять диалог', callback_data: `take_dialog_${ctx.from.id}` }],
        ]
      }
    });

    // Сохраняем message_id карточки чтобы потом обновить "Взял @username"
    await db.saveGroupMessageId(ctx.from.id, msg.message_id, groupId);

  } catch (err) {
    console.error('[Notify] notifySpecialistGroup error:', err.message);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// МОСТ СПЕЦИАЛИСТ ↔ КЛИЕНТ
// Мосты хранятся в БД — не теряются при рестарте
// ═══════════════════════════════════════════════════════════════════════════

// Открыть мост: специалист взял диалог
async function openBridge(specialistChatId, clientChatId, orderNumber, specialistUsername) {
  // Проверяем что у специалиста нет активного моста
  const existing = await db.getBridgeBySpecialist(specialistChatId);
  if (existing) {
    await _bot.telegram.sendMessage(specialistChatId,
      `⚠️ У вас уже открыт диалог с клиентом по заказу *${existing.order_number}*.\n` +
      `Сначала завершите его командой /endchat`,
      { parse_mode: 'Markdown' }
    );
    return false;
  }

  await db.createBridge({
    specialistChatId,
    clientChatId,
    orderNumber,
    specialistUsername,
  });

  console.log(`[Bridge] Открыт: специалист ${specialistChatId} ↔ клиент ${clientChatId}`);

  // Уведомляем специалиста
  await _bot.telegram.sendMessage(specialistChatId,
    `✅ *Диалог открыт!*\n\nВы ведёте переписку с клиентом${orderNumber ? ` по заказу *${orderNumber}*` : ''}.\n\n` +
    `Всё что вы пишете сюда — получает клиент.\n` +
    `/endchat — завершить диалог`,
    { parse_mode: 'Markdown' }
  );

  // Уведомляем клиента
  await _bot.telegram.sendMessage(clientChatId,
    `✅ *Специалист подключился!*\n\nТеперь вы общаетесь напрямую. Пишите — специалист ответит.`,
    { parse_mode: 'Markdown' }
  );

  return true;
}

async function closeBridge(specialistChatId) {
  const bridge = await db.getBridgeBySpecialist(specialistChatId);
  if (!bridge) return false;

  await db.deleteBridge(specialistChatId);

  console.log(`[Bridge] Закрыт: специалист ${specialistChatId}`);

  // Уведомляем обоих
  try {
    await _bot.telegram.sendMessage(specialistChatId,
      '✅ Диалог завершён. Клиент переведён обратно в бота.');
    await _bot.telegram.sendMessage(bridge.client_chat_id,
      '✅ Специалист завершил диалог. Если нужна помощь — /specialist',
      { parse_mode: 'Markdown' }
    );
  } catch (err) {
    console.error('[Bridge] close notify error:', err.message);
  }

  // Возвращаем клиента в бота (сбрасываем шаг WAITING_SPECIALIST)
  await db.resetSessionStep(bridge.client_chat_id, 'ORDER_CONFIRMED');

  return true;
}

// Получить мост по chat_id (специалист или клиент)
async function getBridge(chatId) {
  return db.getBridgeByAnyParty(chatId);
}

async function isInBridge(chatId) {
  const bridge = await db.getBridgeByAnyParty(chatId);
  return !!bridge;
}

// ── Переслать сообщение через мост ───────────────────────────────────────

async function forwardThroughBridge(fromChatId, text, fileId, messageType) {
  const bridge = await db.getBridgeByAnyParty(fromChatId);
  if (!bridge || !_bot) return false;

  // Определяем направление
  const isSpecialist = bridge.specialist_chat_id === fromChatId;
  const targetId     = isSpecialist ? bridge.client_chat_id : bridge.specialist_chat_id;
  const prefix       = isSpecialist
    ? '💬 *Специалист:*'
    : `👤 *Клиент [${bridge.order_number || ''}]:*`;

  try {
    if (messageType === 'PHOTO' && fileId) {
      await _bot.telegram.sendPhoto(targetId, fileId, {
        caption: `${prefix}${text ? ' ' + text : ''}`,
        parse_mode: 'Markdown',
      });
    } else if (messageType === 'FILE' && fileId) {
      await _bot.telegram.sendDocument(targetId, fileId, {
        caption: `${prefix}${text ? ' ' + text : ''}`,
        parse_mode: 'Markdown',
      });
    } else if (text) {
      await _bot.telegram.sendMessage(targetId,
        `${prefix} ${text}`, { parse_mode: 'Markdown' });
    }
    return true;
  } catch (err) {
    console.error('[Bridge] forward error:', err.message);
    return false;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// УВЕДОМЛЕНИЯ О СМЕНЕ СТАТУСА
// ═══════════════════════════════════════════════════════════════════════════

async function notifyClientStatusChange(clientChatId, orderNumber, newStatus) {
  if (!_bot) return;

  const messages = {
    ACCEPTED:    `✅ Заказ *${orderNumber}* принят в работу!`,
    PAID:        `💳 Оплата по заказу *${orderNumber}* получена. Передаём в производство.`,
    IN_PROGRESS: `🖨 Заказ *${orderNumber}* печатается!`,
    READY:       `📦 Заказ *${orderNumber}* готов! Свяжемся для передачи.`,
    DELIVERED:   `✔️ Заказ *${orderNumber}* выдан. Спасибо за заказ!`,
    CANCELLED:   `❌ Заказ *${orderNumber}* отменён.`,
    MODELING:    `📐 Заявка на моделирование *${orderNumber}* принята специалистом.`,
    MODELING_DONE: `✅ 3D-модель по заявке *${orderNumber}* готова! Специалист свяжется с вами.`,
  };

  const msg = messages[newStatus];
  if (!msg || !clientChatId) return;

  try {
    await _bot.telegram.sendMessage(clientChatId, msg, { parse_mode: 'Markdown' });
  } catch (err) {
    console.error('[Notify] statusChange error:', err.message);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// ОБНОВЛЕНИЕ КАРТОЧКИ В ГРУППЕ
// Когда специалист взял диалог — обновляем сообщение "Взял @username"
// ═══════════════════════════════════════════════════════════════════════════

async function updateGroupCard(clientTelegramId, specialistUsername) {
  if (!_bot) return;
  const meta = await db.getGroupMessageId(clientTelegramId);
  if (!meta) return;

  try {
    await _bot.telegram.editMessageReplyMarkup(
      meta.group_id,
      meta.message_id,
      null,
      {
        inline_keyboard: [
          [{ text: `✅ Взял @${specialistUsername || 'специалист'}`, callback_data: 'noop' }],
        ]
      }
    );
  } catch (err) {
    // Сообщение могло быть удалено — не критично
    console.warn('[Notify] updateGroupCard:', err.message);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// ЗАПРОС ОТЗЫВА
// ═══════════════════════════════════════════════════════════════════════════

async function sendReviewRequest(clientChatId, orderNumber) {
  if (!_bot || !clientChatId) return;
  try {
    await _bot.telegram.sendMessage(clientChatId,
      `🙏 Ваш заказ *${orderNumber}* выдан!\n\nОставьте отзыв — это помогает нам становиться лучше.`,
      {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [{ text: '⭐ Оставить отзыв', callback_data: `review_${orderNumber}`      }],
            [{ text: '➡️ Пропустить',     callback_data: `skip_review_${orderNumber}` }],
          ]
        }
      }
    );
  } catch (err) {
    console.error('[Notify] sendReviewRequest error:', err.message);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// НАПОМИНАНИЕ О БРОШЕННОМ ЗАКАЗЕ
// ═══════════════════════════════════════════════════════════════════════════

async function sendAbandonedReminder(clientChatId, orderNumber, stepLabel) {
  if (!_bot || !clientChatId) return;
  try {
    await _bot.telegram.sendMessage(clientChatId,
      `👋 Вы не закончили оформление заказа!\n\n` +
      `Остановились на шаге: *${stepLabel}*\n\n` +
      `Хотите продолжить?`,
      {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [{ text: '▶️ Продолжить заказ', callback_data: 'action_continue' }],
            [{ text: '❌ Отменить',         callback_data: 'cmd_cancel'       }],
          ]
        }
      }
    );
  } catch (err) {
    console.error('[Notify] abandonedReminder error:', err.message);
  }
}

module.exports = {
  setBotInstance,

  // Заказы
  notifyNewOrder,
  notifyModelingOrder,
  notifySpecialistGroup,

  // Мост
  openBridge,
  closeBridge,
  getBridge,
  isInBridge,
  forwardThroughBridge,
  updateGroupCard,

  // Клиент
  notifyClientStatusChange,
  sendReviewRequest,
  sendAbandonedReminder,
};