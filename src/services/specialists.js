// src/services/specialists.js — v2.1
// Панель специалиста: просмотр заказов, подтверждение, коррекция цены

'use strict';

const db     = require('../db');
const notify = require('./notification');
const { handleStockInput } = require('./stock');

// ── Проверка прав ─────────────────────────────────────────────────────────

async function isSpecialist(telegramId) {
  const spec = await db.getSpecialistById(telegramId);
  return !!spec && spec.is_active;
}

async function isAdmin(telegramId) {
  const spec = await db.getSpecialistById(telegramId);
  return !!spec && spec.is_active && spec.role === 'admin';
}

function requireSpecialist() {
  return async (ctx, next) => {
    if (!(await isSpecialist(ctx.from?.id)))
      return ctx.reply('⛔ У вас нет доступа к этой команде.');
    return next();
  };
}

function requireAdmin() {
  return async (ctx, next) => {
    if (!(await isAdmin(ctx.from?.id)))
      return ctx.reply('⛔ Только для администратора.');
    return next();
  };
}

// ── Форматирование ────────────────────────────────────────────────────────

function statusIcon(s) {
  return { NEW:'🆕',ACCEPTED:'✅',PAID:'💳',IN_PROGRESS:'🖨',
           READY:'📦',DELIVERED:'🚗',CLOSED:'✔️',CANCELLED:'❌' }[s] || '📋';
}
function deliveryLabel(d) {
  return { COURIER:'🚗 Курьер',SDEK:'📦 СДЭК',PICKUP:'🤝 Самовывоз' }[d] || d;
}
function urgencyLabel(u) {
  return { STANDARD:'Стандарт',PLUS200:'🚀 +200₽',PLUS500:'⚡ +500₽',PLUS800:'🔥 +800₽' }[u] || u;
}

function buildOrderCard(order) {
  const clientTag = order.username
    ? `@${order.username}`
    : `[${order.first_name||'Клиент'}](tg://user?id=${order.telegram_user_id})`;
  const dims = (order.size_x && order.size_y && order.size_z)
    ? `${order.size_x}×${order.size_y}×${order.size_z} мм` : 'не указаны';
  const price = order.total_price ? `*${order.total_price} ₽*` : '_рассчитывается_';

  return `${statusIcon(order.status)} *Заказ ${order.order_number}*\n\n` +
    `👤 Клиент: ${clientTag}\n` +
    `🆔 TG ID: \`${order.telegram_user_id}\`\n` +
    `📊 Статус: *${order.status}*\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `🧱 Материал: *${order.material_code}* (${order.method_code})\n` +
    `📐 Размеры: ${dims}\n` +
    (order.volume_cm3 ? `📦 Объём: ~${parseFloat(order.volume_cm3).toFixed(1)} см³\n` : '') +
    `🔢 Количество: *${order.quantity} шт*\n` +
    `⏱ Срочность: ${urgencyLabel(order.urgency)}\n` +
    `🚚 Доставка: ${deliveryLabel(order.delivery_type)}\n` +
    `💰 Стоимость: ${price}\n` +
    `📅 Срок: ${order.ready_date || 'уточняется'}\n` +
    (order.use_description
      ? `━━━━━━━━━━━━━━━━━━━━\n📝 Задача: _${order.use_description}_\n` : '');
}

function buildOrderButtons(order) {
  const n   = order.order_number;
  const tid = order.telegram_user_id;

  if (['NEW','ACCEPTED'].includes(order.status)) {
    return { inline_keyboard: [
      [{ text: '👀 Файл получил, проверю',      callback_data: `spec_seen_${n}`    }],
      [{ text: '✅ Подтвердить (цена та же)',    callback_data: `spec_confirm_${n}` },
       { text: '💰 Изменить цену',               callback_data: `spec_price_${n}`   }],
      [{ text: '⚠️ Проблема с файлом',           callback_data: `spec_issue_${n}`   }],
      [{ text: '💬 Написать клиенту',            callback_data: `bridge_open_${n}_${tid}` },
       { text: '🖨 Сразу в печать',              callback_data: `spec_inprod_${n}`  }],
    ]};
  }
  if (['PAID','IN_PROGRESS'].includes(order.status)) {
    return { inline_keyboard: [
      [{ text: '🖨 В печать',  callback_data: `spec_inprod_${n}` },
       { text: '📦 Готово',    callback_data: `spec_ready_${n}`  }],
      [{ text: '💬 Написать клиенту', callback_data: `bridge_open_${n}_${tid}` }],
    ]};
  }
  if (order.status === 'READY') {
    return { inline_keyboard: [
      [{ text: '🚗 Выдан/Отправлен', callback_data: `spec_deliver_${n}` }],
      [{ text: '💬 Написать клиенту', callback_data: `bridge_open_${n}_${tid}` }],
    ]};
  }
  return { inline_keyboard: [
    [{ text: '💬 Написать клиенту', callback_data: `bridge_open_${n}_${tid}` }],
  ]};
}

// ── Регистрация команд ────────────────────────────────────────────────────

function registerSpecialistCommands(bot) {

  // /menu
  bot.command('menu', requireSpecialist(), async (ctx) => {
    return ctx.reply(
      `👋 *Панель специалиста Hevial*\n\n` +
      `/orders — все активные заказы\n` +
      `/myorders — мои заказы\n` +
      `/order HVL-00001 — карточка заказа\n` +
      `/setstatus HVL-00001 IN_PROGRESS — смена статуса\n` +
      `/setprice HVL-00001 1500 — установить цену\n` +
      `/endchat — завершить диалог с клиентом\n` +
      `/whoami — кто я в системе`,
      { parse_mode: 'Markdown' }
    );
  });

  // /orders
  bot.command('orders', requireSpecialist(), async (ctx) => {
    const orders = await db.getActiveOrders(20);
    if (!orders.length)
      return ctx.reply('📭 Активных заказов нет.');

    // Группируем по статусу
    const groups = {};
    for (const o of orders) {
      if (!groups[o.status]) groups[o.status] = [];
      groups[o.status].push(o);
    }
    let text = `📋 *Активные заказы (${orders.length}):*\n\n`;
    for (const st of ['NEW','ACCEPTED','PAID','IN_PROGRESS','READY']) {
      if (!groups[st]?.length) continue;
      text += `${statusIcon(st)} *${st}*\n`;
      for (const o of groups[st]) {
        const mine = o.assigned_specialist_id === ctx.from.id ? ' *(мой)*' : '';
        text += `  • \`${o.order_number}\` — ${o.first_name||'Клиент'} | ` +
                `${o.material_code} ${o.quantity}шт | ` +
                `${o.total_price||'?'}₽${mine}\n`;
      }
      text += '\n';
    }
    text += `_/order HVL-00001 — детали заказа_`;

    // Кнопки быстрого доступа к первым 5
    const btns = orders.slice(0,5).map(o => ([{
      text: `${statusIcon(o.status)} ${o.order_number}`,
      callback_data: `spec_view_${o.order_number}`,
    }]));

    return ctx.reply(text, {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: btns }
    });
  });

  // /myorders
  bot.command('myorders', requireSpecialist(), async (ctx) => {
    const orders = await db.getOrdersBySpecialist(ctx.from.id);
    if (!orders.length)
      return ctx.reply('У вас нет активных заказов.');
    let text = `🖨 *Ваши заказы (${orders.length}):*\n\n`;
    for (const o of orders)
      text += `${statusIcon(o.status)} \`${o.order_number}\` — ${o.first_name||'Клиент'} | ${o.material_code} | *${o.status}*\n`;
    return ctx.reply(text, { parse_mode: 'Markdown' });
  });

  // /order HVL-00001
  bot.command('order', requireSpecialist(), async (ctx) => {
    const num = ctx.message.text.split(' ')[1]?.toUpperCase();
    if (!num) return ctx.reply('Использование: /order HVL-00001');
    const order = await db.getOrderByNumber(num);
    if (!order) return ctx.reply(`Заказ *${num}* не найден.`, { parse_mode: 'Markdown' });
    return ctx.reply(buildOrderCard(order), {
      parse_mode: 'Markdown',
      reply_markup: buildOrderButtons(order),
    });
  });

  // /setstatus
  bot.command('setstatus', requireSpecialist(), async (ctx) => {
    const [, num, st] = ctx.message.text.split(' ');
    const valid = ['NEW','ACCEPTED','PAID','IN_PROGRESS','READY','DELIVERED','CLOSED','CANCELLED'];
    if (!num || !st) return ctx.reply(`Использование: /setstatus HVL-00001 IN_PROGRESS\nСтатусы: ${valid.join(', ')}`);
    if (!valid.includes(st.toUpperCase())) return ctx.reply(`Неверный статус. Доступные:\n${valid.join(', ')}`);
    const order = await db.getOrderByNumber(num.toUpperCase());
    if (!order) return ctx.reply(`Заказ ${num} не найден.`);
    await db.updateOrderStatus(num.toUpperCase(), st.toUpperCase());
    await notify.notifyClientStatusChange(order.telegram_user_id, num.toUpperCase(), st.toUpperCase());
    await db.assignSpecialistToOrder(num.toUpperCase(), ctx.from.id);
    return ctx.reply(`✅ *${num}*: статус → *${st.toUpperCase()}*, клиент уведомлён.`, { parse_mode: 'Markdown' });
  });

  // /setprice
  bot.command('setprice', requireSpecialist(), async (ctx) => {
    const [, num, p] = ctx.message.text.split(' ');
    const price = parseFloat(p);
    if (!num || isNaN(price)) return ctx.reply('Использование: /setprice HVL-00001 1500');
    const order = await db.getOrderByNumber(num.toUpperCase());
    if (!order) return ctx.reply(`Заказ ${num} не найден.`);
    await db.updateOrder(num.toUpperCase(), { total_price: price });
    await sendPaymentRequest(ctx, { ...order, total_price: price });
    return ctx.reply(`✅ Цена *${num}*: *${price} ₽*. Клиент получил ссылку на оплату.`, { parse_mode: 'Markdown' });
  });

  // /whoami
  bot.command('whoami', async (ctx) => {
    const spec = await db.getSpecialistById(ctx.from.id);
    if (!spec?.is_active)
      return ctx.reply(
        `Вы не зарегистрированы.\nВаш TG ID: \`${ctx.from.id}\`\n\nПопросите администратора: /addspec ${ctx.from.id} Имя`,
        { parse_mode: 'Markdown' }
      );
    return ctx.reply(
      `👤 *${spec.name}* | ${spec.role}\nID: \`${spec.telegram_id}\`\n/menu — команды`,
      { parse_mode: 'Markdown' }
    );
  });

  // ── КНОПКИ ──────────────────────────────────────────────────────────────

  // Просмотр из /orders
  bot.action(/^spec_view_([A-Z0-9-]+)$/, requireSpecialist(), async (ctx) => {
    await ctx.answerCbQuery();
    const order = await db.getOrderByNumber(ctx.match[1]);
    if (!order) return;
    return ctx.reply(buildOrderCard(order), {
      parse_mode: 'Markdown', reply_markup: buildOrderButtons(order)
    });
  });

  // 👀 Файл получил
  bot.action(/^spec_seen_([A-Z0-9-]+)$/, requireSpecialist(), async (ctx) => {
    await ctx.answerCbQuery('Клиент уведомлён ✅');
    const n = ctx.match[1];
    const order = await db.getOrderByNumber(n);
    if (!order) return;
    await db.assignSpecialistToOrder(n, ctx.from.id);
    const specName = ctx.from.first_name || 'Специалист';
    try {
      await ctx.telegram.sendMessage(order.telegram_user_id,
        `👀 *${specName}* уже посмотрел вашу заявку и займётся ею сегодня.\n\n` +
        `Вы получите уведомление с подтверждением стоимости.`,
        { parse_mode: 'Markdown' });
    } catch {}
    try {
      await ctx.editMessageReplyMarkup({ inline_keyboard: [
        [{ text: `👀 Взял @${ctx.from.username||specName}`, callback_data: 'noop' }],
        [{ text: '✅ Подтвердить (цена та же)', callback_data: `spec_confirm_${n}` },
         { text: '💰 Изменить цену',            callback_data: `spec_price_${n}`   }],
        [{ text: '⚠️ Проблема с файлом',        callback_data: `spec_issue_${n}`   }],
        [{ text: '💬 Написать клиенту', callback_data: `bridge_open_${n}_${order.telegram_user_id}` }],
      ]});
    } catch {}
  });

  // ✅ Подтвердить — цена та же
  bot.action(/^spec_confirm_([A-Z0-9-]+)$/, requireSpecialist(), async (ctx) => {
    await ctx.answerCbQuery('Отправляем ссылку на оплату...');
    const n = ctx.match[1];
    const order = await db.getOrderByNumber(n);
    if (!order) return;
    await db.updateOrderStatus(n, 'ACCEPTED');
    await db.assignSpecialistToOrder(n, ctx.from.id);
    await sendPaymentRequest(ctx, order);
    try {
      await ctx.editMessageReplyMarkup({ inline_keyboard: [
        [{ text: `✅ Подтвердил @${ctx.from.username||ctx.from.first_name}`, callback_data: 'noop' }],
        [{ text: '🖨 В печать', callback_data: `spec_inprod_${n}` }],
        [{ text: '💬 Написать клиенту', callback_data: `bridge_open_${n}_${order.telegram_user_id}` }],
      ]});
    } catch {}
  });

  // 💰 Изменить цену
  bot.action(/^spec_price_([A-Z0-9-]+)$/, requireSpecialist(), async (ctx) => {
    await ctx.answerCbQuery();
    const n = ctx.match[1];
    const order = await db.getOrderByNumber(n);
    if (!order) return;
    await db.setSpecialistState(ctx.from.id, { action: 'awaiting_price', orderNumber: n });
    return ctx.reply(
      `💰 *Введите новую цену для заказа ${n}*\n\n` +
      `Текущая: ${order.total_price ? order.total_price+' ₽' : 'не установлена'}\n\n` +
      `Напишите сумму и причину:\n` +
      `_Пример: 1500 Требуются поддержки_\n\n` +
      `/cancel_price — отменить`,
      { parse_mode: 'Markdown' }
    );
  });

  // ⚠️ Проблема с файлом
  bot.action(/^spec_issue_([A-Z0-9-]+)$/, requireSpecialist(), async (ctx) => {
    await ctx.answerCbQuery();
    const n = ctx.match[1];
    return ctx.reply(`⚠️ *Укажите проблему с файлом ${n}:*`, {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: [
        [{ text: '📏 Неверный масштаб',         callback_data: `spec_iss_scale_${n}`  }],
        [{ text: '🧱 Слишком тонкие стенки',     callback_data: `spec_iss_walls_${n}`  }],
        [{ text: '🔧 Сломанная геометрия',       callback_data: `spec_iss_mesh_${n}`   }],
        [{ text: '📐 Нет файла / не тот формат', callback_data: `spec_iss_fmt_${n}`    }],
        [{ text: '✍️ Написать своё',              callback_data: `spec_iss_own_${n}`    }],
      ]}
    });
  });

  bot.action(/^spec_iss_(scale|walls|mesh|fmt|own)_([A-Z0-9-]+)$/, requireSpecialist(), async (ctx) => {
    await ctx.answerCbQuery();
    const [, type, n] = ctx.match;
    const order = await db.getOrderByNumber(n);
    if (!order) return;

    if (type === 'own') {
      await db.setSpecialistState(ctx.from.id, { action: 'awaiting_issue_text', orderNumber: n });
      return ctx.reply('Напишите что не так с файлом — бот объяснит клиенту понятным языком:');
    }

    const msgs = {
      scale: 'Файл экспортирован в неверных единицах (скорее всего дюймы вместо мм). Исправьте масштаб в CAD-программе и пришлите снова.',
      walls: 'Некоторые элементы модели слишком тонкие — они не напечатаются качественно. Нужно утолщить стенки до 0.8 мм в CAD.',
      mesh:  'В файле обнаружены ошибки геометрии. Можно исправить бесплатно в программе Meshmixer — или мы поможем за дополнительную плату.',
      fmt:   'Нам нужен файл в формате STL, STEP или OBJ. Пришлите правильный формат или уточните у специалиста.',
    };

    await notifyClientFileIssue(ctx, order, msgs[type]);
    await db.updateOrderStatus(n, 'CANCELLED');
    try {
      await ctx.editMessageReplyMarkup({ inline_keyboard: [
        [{ text: `⚠️ Проблема с файлом — клиент уведомлён`, callback_data: 'noop' }],
      ]});
    } catch {}
    return ctx.reply('✅ Клиент уведомлён, заказ отменён. Если пришлёт новый файл — создастся новая заявка.');
  });

  // 🖨 В печать
  bot.action(/^spec_inprod_([A-Z0-9-]+)$/, requireSpecialist(), async (ctx) => {
    await ctx.answerCbQuery();
    const n = ctx.match[1];
    const order = await db.getOrderByNumber(n);
    if (!order) return;
    await db.updateOrderStatus(n, 'IN_PROGRESS');
    await db.assignSpecialistToOrder(n, ctx.from.id);
    await notify.notifyClientStatusChange(order.telegram_user_id, n, 'IN_PROGRESS');
    try {
      await ctx.editMessageReplyMarkup({ inline_keyboard: [
        [{ text: `🖨 В печати — @${ctx.from.username||ctx.from.first_name}`, callback_data: 'noop' }],
        [{ text: '📦 Готово', callback_data: `spec_ready_${n}` }],
        [{ text: '💬 Написать клиенту', callback_data: `bridge_open_${n}_${order.telegram_user_id}` }],
      ]});
    } catch {}
  });

  // 📦 Готово
  bot.action(/^spec_ready_([A-Z0-9-]+)$/, requireSpecialist(), async (ctx) => {
    await ctx.answerCbQuery('Клиент уведомлён!');
    const n = ctx.match[1];
    const order = await db.getOrderByNumber(n);
    if (!order) return;
    await db.updateOrderStatus(n, 'READY');
    await notify.notifyClientStatusChange(order.telegram_user_id, n, 'READY');
    try {
      await ctx.editMessageReplyMarkup({ inline_keyboard: [
        [{ text: '📦 Готово ✅', callback_data: 'noop' }],
        [{ text: '🚗 Выдан/Отправлен', callback_data: `spec_deliver_${n}` }],
        [{ text: '💬 Написать клиенту', callback_data: `bridge_open_${n}_${order.telegram_user_id}` }],
      ]});
    } catch {}
  });

  // 🚗 Выдан
  bot.action(/^spec_deliver_([A-Z0-9-]+)$/, requireSpecialist(), async (ctx) => {
    await ctx.answerCbQuery('Отмечено как выдано');
    const n = ctx.match[1];
    const order = await db.getOrderByNumber(n);
    if (!order) return;
    await db.updateOrderStatus(n, 'DELIVERED');
    await notify.notifyClientStatusChange(order.telegram_user_id, n, 'DELIVERED');
    try {
      await ctx.editMessageReplyMarkup({ inline_keyboard: [
        [{ text: '🚗 Выдан ✅', callback_data: 'noop' }],
      ]});
    } catch {}
  });

  // ── Ввод цены/текста проблемы текстом ────────────────────────────────
  bot.on('text', requireSpecialist(), async (ctx, next) => {
    const state = await db.getSpecialistState(ctx.from.id);
    if (!state) return next();

    if (state.action === 'awaiting_price') {
      const parts = ctx.message.text.trim().split(' ');
      const price = parseFloat(parts[0]);
      const reason = parts.slice(1).join(' ') || 'корректировка стоимости';
      if (isNaN(price) || price <= 0)
        return ctx.reply('Введите число. Пример: `1500 Требуются поддержки`', { parse_mode: 'Markdown' });
      const order = await db.getOrderByNumber(state.orderNumber);
      if (!order) { await db.clearSpecialistState(ctx.from.id); return ctx.reply('Заказ не найден.'); }
      await db.updateOrder(state.orderNumber, { total_price: price });
      await db.clearSpecialistState(ctx.from.id);
      await notifyClientPriceAdjusted(ctx, order, price, reason);
      return ctx.reply(`✅ Цена обновлена: *${price} ₽*\nКлиент получил запрос на подтверждение.`, { parse_mode: 'Markdown' });
    }

    if (state.action === 'awaiting_issue_text') {
      const order = await db.getOrderByNumber(state.orderNumber);
      if (order) {
        await notifyClientFileIssue(ctx, order, ctx.message.text.trim());
        await db.updateOrderStatus(state.orderNumber, 'CANCELLED');
      }
      await db.clearSpecialistState(ctx.from.id);
      return ctx.reply('✅ Клиент уведомлён о проблеме с файлом.');
    }

    return next();
  });

  bot.command('cancel_price', requireSpecialist(), async (ctx) => {
    await db.clearSpecialistState(ctx.from.id);
    return ctx.reply('Отменено. /orders — вернуться к заказам');
  });

  bot.command('endchat', requireSpecialist(), async (ctx) => {
    if (ctx.chat.type !== 'private') return;
    const closed = await notify.closeBridge(ctx.from.id);
    if (!closed) return ctx.reply('У вас нет активного диалога с клиентом.');
  });

  // ── Управление специалистами (admin) ─────────────────────────────────
  bot.command('specialists', requireAdmin(), async (ctx) => {
    const list = await db.getAllSpecialists();
    if (!list.length) return ctx.reply('Список пуст. /addspec 123456789 Имя');
    const lines = list.map(s => `${s.is_active?'✅':'❌'} *${s.name}* | \`${s.telegram_id}\` | ${s.role}`).join('\n');
    return ctx.reply(`👥 *Специалисты:*\n\n${lines}`, { parse_mode: 'Markdown' });
  });

  bot.command('addspec', requireAdmin(), async (ctx) => {
    const [, id, name, role] = ctx.message.text.split(' ');
    if (!id || !name) return ctx.reply('Использование: /addspec 123456789 Имя [admin]');
    await db.addSpecialist({ telegramId: parseInt(id), name, role: role === 'admin' ? 'admin' : 'specialist' });
    return ctx.reply(`✅ *${name}* (\`${id}\`) добавлен.`, { parse_mode: 'Markdown' });
  });

  bot.command('removespec', requireAdmin(), async (ctx) => {
    const id = parseInt(ctx.message.text.split(' ')[1]);
    if (!id) return ctx.reply('Использование: /removespec 123456789');
    await db.deactivateSpecialist(id);
    return ctx.reply(`✅ Специалист \`${id}\` деактивирован.`, { parse_mode: 'Markdown' });
  });

  bot.action('noop', (ctx) => ctx.answerCbQuery());
}

// ── Уведомления клиенту ───────────────────────────────────────────────────

async function sendPaymentRequest(ctx, order) {
  try {
    await ctx.telegram.sendMessage(order.telegram_user_id,
      `✅ *Заказ ${order.order_number} подтверждён!*\n\n` +
      `🧱 ${order.material_code} (${order.method_code})\n` +
      `📐 ${order.size_x}×${order.size_y}×${order.size_z} мм · ${order.quantity} шт\n` +
      `💰 Стоимость: *${order.total_price} ₽*\n` +
      `📅 Готовность: *${order.ready_date||'уточняется'}*\n\n` +
      `Для начала печати оплатите заказ:`,
      {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: [
          // TODO: заменить на реальную ссылку ЮКасса после интеграции
          [{ text: `💳 Оплатить ${order.total_price} ₽`, url: `https://hevial.ru/pay/${order.order_number}` }],
          [{ text: '💬 Есть вопрос', callback_data: 'action_specialist' }],
        ]}
      }
    );
  } catch (e) { console.error('[sendPaymentRequest]', e.message); }
}

async function notifyClientPriceAdjusted(ctx, order, newPrice, reason) {
  try {
    await ctx.telegram.sendMessage(order.telegram_user_id,
      `💰 *Уточнение по заказу ${order.order_number}*\n\n` +
      `Специалист скорректировал стоимость:\n` +
      `Причина: _${reason}_\n` +
      `Новая стоимость: *${newPrice} ₽*\n\n` +
      `Подтвердите для начала печати:`,
      {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: [
          [{ text: `✅ Согласен, оплатить ${newPrice} ₽`, url: `https://hevial.ru/pay/${order.order_number}` }],
          [{ text: '💬 Уточнить у специалиста', callback_data: 'action_specialist' }],
          [{ text: '❌ Отменить заказ',          callback_data: 'cmd_cancel'        }],
        ]}
      }
    );
  } catch (e) { console.error('[notifyClientPriceAdjusted]', e.message); }
}

async function notifyClientFileIssue(ctx, order, description) {
  try {
    await ctx.telegram.sendMessage(order.telegram_user_id,
      `⚠️ *По вашему заказу ${order.order_number} есть вопрос*\n\n` +
      `${description}\n\n` +
      `Что хотите сделать?`,
      {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: [
          [{ text: '📎 Прислать новый файл',      callback_data: 'action_new_file'   }],
          [{ text: '💬 Обсудить со специалистом', callback_data: 'action_specialist' }],
          [{ text: '📐 Заказать моделирование',   callback_data: 'type_modeling'     }],
          [{ text: '❌ Отменить заявку',           callback_data: 'cmd_cancel'        }],
        ]}
      }
    );
  } catch (e) { console.error('[notifyClientFileIssue]', e.message); }
}

module.exports = {
  isSpecialist, isAdmin,
  requireSpecialist, requireAdmin,
  registerSpecialistCommands,
  buildOrderCard, buildOrderButtons,
};
