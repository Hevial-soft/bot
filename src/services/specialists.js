// src/services/specialists.js — v2.2
// Панель специалиста: просмотр заказов, подтверждение, коррекция цены
"use strict";

const db = require("../db");
const notify = require("./notification");
const { handleStockInput } = require("./stock");

// ── Проверка прав ─────────────────────────────────────────────────────────

async function isSpecialist(telegramId) {
  const spec = await db.getSpecialistById(telegramId);
  return !!spec && spec.is_active;
}

async function isAdmin(telegramId) {
  const spec = await db.getSpecialistById(telegramId);
  return !!spec && spec.is_active && spec.role === "admin";
}

function requireSpecialist() {
  return async (ctx, next) => {
    if (!(await isSpecialist(ctx.from?.id)))
      return safeReply(ctx, "⛔ У вас нет доступа к этой команде.");
    return next();
  };
}

function requireAdmin() {
  return async (ctx, next) => {
    if (!(await isAdmin(ctx.from?.id)))
      return safeReply(ctx, "⛔ Только для администратора.");
    return next();
  };
}

// ── Вспомогательные безопасные отправители ─────────────────────────────────
// Эти обёртки ловят ошибки парсинга Markdown у Telegram и пробуют повторно
// отправить сообщение без разбора разметки, чтобы избежать падений.

function _stripMarkdownLike(s) {
  if (s === null || s === undefined) return "";
  return String(s).replace(/[*_`\[\]]/g, "");
}

async function safeSendMessage(ctxOrTelegram, chatId, text, options = {}) {
  // Guard: ensure chatId is present and looks valid
  if (chatId === null || chatId === undefined || chatId === "") {
    console.error("[safeSendMessage] missing chatId, aborting send");
    return null;
  }

  const telegram = ctxOrTelegram?.telegram || ctxOrTelegram;
  if (!telegram || typeof telegram.sendMessage !== "function") {
    console.error("[safeSendMessage] invalid telegram object");
    throw new Error("Invalid telegram object");
  }

  try {
    return await telegram.sendMessage(chatId, text, options);
  } catch (err) {
    // Логируем и пробуем отправить без parse_mode, затем в "плоском" виде
    console.error(
      "[safeSendMessage] send failed:",
      err && (err.response?.description || err.message || err),
    );
    const opts = Object.assign({}, options);
    if (opts.parse_mode) {
      delete opts.parse_mode;
      try {
        return await telegram.sendMessage(chatId, text, opts);
      } catch (e) {
        console.error(
          "[safeSendMessage] retry without parse_mode failed:",
          e && (e.response?.description || e.message || e),
        );
      }
    }
    try {
      const plain = _stripMarkdownLike(text);
      return await telegram.sendMessage(chatId, plain, {});
    } catch (e) {
      console.error(
        "[safeSendMessage] final retry failed:",
        e && (e.response?.description || e.message || e),
      );
      throw err;
    }
  }
}

async function safeReply(ctx, text, options = {}) {
  if (!ctx || typeof ctx.reply !== "function") {
    console.error("[safeReply] invalid ctx");
    throw new Error("Invalid ctx");
  }
  try {
    return await ctx.reply(text, options);
  } catch (err) {
    console.error(
      "[safeReply] reply failed:",
      err && (err.response?.description || err.message || err),
    );
    const opts = Object.assign({}, options);
    if (opts.parse_mode) {
      delete opts.parse_mode;
      try {
        return await ctx.reply(text, opts);
      } catch (e) {
        console.error(
          "[safeReply] retry without parse_mode failed:",
          e && (e.response?.description || e.message || e),
        );
      }
    }
    try {
      const plain = _stripMarkdownLike(text);
      return await ctx.reply(plain, {});
    } catch (e) {
      console.error(
        "[safeReply] final retry failed:",
        e && (e.response?.description || e.message || e),
      );
      throw err;
    }
  }
}

// ── Форматирование ────────────────────────────────────────────────────────

function statusIcon(s) {
  return (
    {
      NEW: "🆕",
      ACCEPTED: "✅",
      PAID: "💳",
      IN_PROGRESS: "🖨",
      READY: "📦",
      DELIVERED: "🚗",
      CLOSED: "✔️",
      CANCELLED: "❌",
    }[s] || "📋"
  );
}
function deliveryLabel(d) {
  return (
    { COURIER: "🚗 Курьер", SDEK: "📦 СДЭК", PICKUP: "🤝 Самовывоз" }[d] || d
  );
}
function urgencyLabel(u) {
  return (
    {
      STANDARD: "Стандарт",
      PLUS200: "🚀 +200₽",
      PLUS500: "⚡ +500₽",
      PLUS800: "🔥 +800₽",
    }[u] || u
  );
}

function escapeMd(s) {
  if (s === null || s === undefined) return "";
  return String(s)
    .replace(/\\/g, "\\\\")
    .replace(/([_*\[\]()`])/g, "\\$1");
}

function buildOrderCard(order) {
  const clientTag = order.username
    ? `@${escapeMd(order.username)}`
    : `${escapeMd(order.first_name || "Клиент")}`;
  const dims =
    order.size_x && order.size_y && order.size_z
      ? `${order.size_x}×${order.size_y}×${order.size_z} мм`
      : "не указаны";
  const price = order.total_price
    ? `*${escapeMd(order.total_price)} ₽*`
    : "_рассчитывается_";

  return (
    `${statusIcon(order.status)} *Заказ ${escapeMd(order.order_number)}*\n\n` +
    `👤 Клиент: ${clientTag}\n` +
    `🆔 TG ID: \`${escapeMd(order.telegram_user_id)}\`\n` +
    `📊 Статус: *${escapeMd(order.status)}*\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `🧱 Материал: *${escapeMd(order.material_code)}* (${escapeMd(order.method_code)})\n` +
    `📐 Размеры: ${dims}\n` +
    (order.volume_cm3
      ? `📦 Объём: ~${parseFloat(order.volume_cm3).toFixed(1)} см³\n`
      : "") +
    `🔢 Количество: *${order.quantity} шт*\n` +
    `⏱ Срочность: ${urgencyLabel(order.urgency)}\n` +
    `🚚 Доставка: ${deliveryLabel(order.delivery_type)}\n` +
    `💰 Стоимость: ${price}\n` +
    `📅 Срок: ${escapeMd(order.ready_date || "уточняется")}\n` +
    (order.use_description
      ? `━━━━━━━━━━━━━━━━━━━━\n📝 Задача: _${escapeMd(order.use_description)}_\n`
      : "")
  );
}

function buildOrderButtons(order) {
  const n = order.order_number;
  const tid = order.telegram_user_id;

  if (["NEW", "ACCEPTED"].includes(order.status)) {
    return {
      inline_keyboard: [
        [{ text: "👀 Файл получил, проверю", callback_data: `spec_seen_${n}` }],
        [
          {
            text: "✅ Подтвердить (цена та же)",
            callback_data: `spec_confirm_${n}`,
          },
          { text: "💰 Изменить цену", callback_data: `spec_price_${n}` },
        ],
        [{ text: "⚠️ Проблема с файлом", callback_data: `spec_issue_${n}` }],
        [
          {
            text: "💬 Написать клиенту",
            callback_data: `bridge_open_${n}_${tid}`,
          },
          { text: "🖨 Сразу в печать", callback_data: `spec_inprod_${n}` },
        ],
      ],
    };
  }
  if (["PAID", "IN_PROGRESS"].includes(order.status)) {
    return {
      inline_keyboard: [
        [
          { text: "🖨 В печать", callback_data: `spec_inprod_${n}` },
          { text: "📦 Готово", callback_data: `spec_ready_${n}` },
        ],
        [
          {
            text: "💬 Написать клиенту",
            callback_data: `bridge_open_${n}_${tid}`,
          },
        ],
      ],
    };
  }
  if (order.status === "READY") {
    return {
      inline_keyboard: [
        [{ text: "🚗 Выдан/Отправлен", callback_data: `spec_deliver_${n}` }],
        [
          {
            text: "💬 Написать клиенту",
            callback_data: `bridge_open_${n}_${tid}`,
          },
        ],
      ],
    };
  }
  return {
    inline_keyboard: [
      [
        {
          text: "💬 Написать клиенту",
          callback_data: `bridge_open_${n}_${tid}`,
        },
      ],
    ],
  };
}

// ── Регистрация команд ────────────────────────────────────────────────────

function registerSpecialistCommands(bot) {
  // /menu
  bot.command("menu", requireSpecialist(), async (ctx) => {
    return safeReply(
      ctx,
      `👋 *Панель специалиста Hevial*\n\n` +
        `/orders — все активные заказы\n` +
        `/myorders — мои заказы\n` +
        `/order HVL-00001 — карточка заказа\n` +
        `/setstatus HVL-00001 IN_PROGRESS — смена статуса\n` +
        `/setprice HVL-00001 1500 — установить цену\n` +
        `/endchat — завершить диалог с клиентом\n` +
        `/whoami — кто я в системе`,
      { parse_mode: "Markdown" },
    );
  });

  // /orders
  bot.command("orders", requireSpecialist(), async (ctx) => {
    const orders = await db.getActiveOrders(20);
    if (!orders.length) return safeReply(ctx, "📭 Активных заказов нет.");

    // Группируем по статусу
    const groups = {};
    for (const o of orders) {
      if (!groups[o.status]) groups[o.status] = [];
      groups[o.status].push(o);
    }
    let text = `📋 *Активные заказы (${orders.length}):*\n\n`;
    for (const st of ["NEW", "ACCEPTED", "PAID", "IN_PROGRESS", "READY"]) {
      if (!groups[st]?.length) continue;
      text += `${statusIcon(st)} *${st}*\n`;
      for (const o of groups[st]) {
        const mine = o.assigned_specialist_id === ctx.from.id ? " *(мой)*" : "";
        text += `  • \`${escapeMd(o.order_number)}\` — ${escapeMd(o.first_name || "Клиент")} | ${escapeMd(o.material_code)} ${escapeMd(o.quantity)}шт | ${escapeMd(o.total_price || "?")}₽${mine}\n`;
      }
      text += "\n";
    }
    text += `_/order HVL-00001 — детали заказа_`;

    const btns = orders
      .slice(0, 5)
      .map((o) => [
        {
          text: `${statusIcon(o.status)} ${o.order_number}`,
          callback_data: `spec_view_${o.order_number}`,
        },
      ]);

    return safeReply(ctx, text, {
      parse_mode: "Markdown",
      reply_markup: { inline_keyboard: btns },
    });
  });

  // /myorders
  bot.command("myorders", requireSpecialist(), async (ctx) => {
    const orders = await db.getOrdersBySpecialist(ctx.from.id);
    if (!orders.length) return safeReply(ctx, "У вас нет активных заказов.");
    let text = `🖨 *Ваши заказы (${orders.length}):*\n\n`;
    for (const o of orders)
      text += `${statusIcon(o.status)} \`${escapeMd(o.order_number)}\` — ${escapeMd(o.first_name || "Клиент")} | ${escapeMd(o.material_code)} | *${escapeMd(o.status)}*\n`;
    return safeReply(ctx, text, { parse_mode: "Markdown" });
  });

  // /order HVL-00001
  bot.command("order", requireSpecialist(), async (ctx) => {
    const num = ctx.message.text.split(" ")[1]?.toUpperCase();
    if (!num) return safeReply(ctx, "Использование: /order HVL-00001");
    const order = await db.getOrderByNumber(num);
    if (!order)
      return safeReply(ctx, `Заказ *${num}* не найден.`, {
        parse_mode: "Markdown",
      });
    return safeReply(ctx, buildOrderCard(order), {
      parse_mode: "Markdown",
      reply_markup: buildOrderButtons(order),
    });
  });

  // /setstatus
  bot.command("setstatus", requireSpecialist(), async (ctx) => {
    const [, num, st] = ctx.message.text.split(" ");
    const valid = [
      "NEW",
      "ACCEPTED",
      "PAID",
      "IN_PROGRESS",
      "READY",
      "DELIVERED",
      "CLOSED",
      "CANCELLED",
    ];
    if (!num || !st)
      return safeReply(
        ctx,
        `Использование: /setstatus HVL-00001 IN_PROGRESS\nСтатусы: ${valid.join(", ")}`,
      );
    if (!valid.includes(st.toUpperCase()))
      return safeReply(ctx, `Неверный статус. Доступные:\n${valid.join(", ")}`);
    const order = await db.getOrderByNumber(num.toUpperCase());
    if (!order) return safeReply(ctx, `Заказ ${num} не найден.`);
    await db.updateOrderStatus(num.toUpperCase(), st.toUpperCase());
    await notify.notifyClientStatusChange(
      order.telegram_user_id,
      num.toUpperCase(),
      st.toUpperCase(),
    );
    await db.assignSpecialistToOrder(num.toUpperCase(), ctx.from.id);
    return safeReply(
      ctx,
      `✅ *${num}*: статус → *${st.toUpperCase()}*, клиент уведомлён.`,
      { parse_mode: "Markdown" },
    );
  });

  // /setprice
  bot.command("setprice", requireSpecialist(), async (ctx) => {
    const [, num, p] = ctx.message.text.split(" ");
    const price = parseFloat(p);
    if (!num || isNaN(price))
      return safeReply(ctx, "Использование: /setprice HVL-00001 1500");
    const order = await db.getOrderByNumber(num.toUpperCase());
    if (!order) return safeReply(ctx, `Заказ ${num} не найден.`);
    await db.updateOrder(num.toUpperCase(), { total_price: price });
    await sendPaymentRequest(ctx, { ...order, total_price: price });
    return safeReply(
      ctx,
      `✅ Цена *${num}*: *${price} ₽*. Клиент получил ссылку на оплату.`,
      { parse_mode: "Markdown" },
    );
  });

  // /whoami
  bot.command("whoami", async (ctx) => {
    const spec = await db.getSpecialistById(ctx.from.id);
    if (!spec?.is_active)
      return safeReply(
        ctx,
        `Вы не зарегистрированы.\nВаш TG ID: \`${ctx.from.id}\`\n\nПопросите администратора: /addspec ${ctx.from.id} Имя`,
        { parse_mode: "Markdown" },
      );
    return safeReply(
      ctx,
      `👤 *${escapeMd(spec.name)}* | ${escapeMd(spec.role)}\nID: \`${escapeMd(spec.telegram_id)}\`\n/menu — команды`,
      { parse_mode: "Markdown" },
    );
  });

  // ── Кнопки ──────────────────────────────────────────────────────────────

  // Просмотр из /orders
  bot.action(/^spec_view_([A-Z0-9-]+)$/, requireSpecialist(), async (ctx) => {
    await ctx.answerCbQuery();
    const order = await db.getOrderByNumber(ctx.match[1]);
    if (!order) return;
    return safeReply(ctx, buildOrderCard(order), {
      parse_mode: "Markdown",
      reply_markup: buildOrderButtons(order),
    });
  });

  // 👀 Файл получил
  bot.action(/^spec_seen_([A-Z0-9-]+)$/, requireSpecialist(), async (ctx) => {
    await ctx.answerCbQuery("Клиент уведомлён ✅");
    const n = ctx.match[1];
    const order = await db.getOrderByNumber(n);
    if (!order) return;
    await db.assignSpecialistToOrder(n, ctx.from.id);
    const specName = ctx.from.first_name || "Специалист";

    try {
      if (!order.telegram_user_id) {
        console.error("[spec_seen] missing telegram_user_id for order", n);
      } else {
        await safeSendMessage(
          ctx,
          order.telegram_user_id,
          `👀 *${escapeMd(specName)}* уже посмотрел вашу заявку и займётся ею сегодня.\n\n` +
            `Вы получите уведомление с подтверждением стоимости.`,
          { parse_mode: "Markdown" },
        );
      }
    } catch (e) {
      console.error(
        "[spec_seen] safeSendMessage failed:",
        e && (e.response?.description || e.message || e),
      );
    }

    try {
      await ctx.editMessageReplyMarkup({
        inline_keyboard: [
          [
            {
              text: `👀 Взял @${ctx.from.username || specName}`,
              callback_data: "noop",
            },
          ],
          [
            {
              text: "✅ Подтвердить (цена та же)",
              callback_data: `spec_confirm_${n}`,
            },
            { text: "💰 Изменить цену", callback_data: `spec_price_${n}` },
          ],
          [{ text: "⚠️ Проблема с файлом", callback_data: `spec_issue_${n}` }],
          [
            {
              text: "💬 Написать клиенту",
              callback_data: `bridge_open_${n}_${order.telegram_user_id}`,
            },
          ],
        ],
      });
    } catch (e) {
      // ignore edit errors
    }
  });

  // ✅ Подтвердить — цена та же
  bot.action(
    /^spec_confirm_([A-Z0-9-]+)$/,
    requireSpecialist(),
    async (ctx) => {
      await ctx.answerCbQuery("Отправляем ссылку на оплату...");
      const n = ctx.match[1];
      const order = await db.getOrderByNumber(n);
      if (!order) return;
      await db.updateOrderStatus(n, "ACCEPTED");
      await db.assignSpecialistToOrder(n, ctx.from.id);
      await sendPaymentRequest(ctx, order);
      try {
        await ctx.editMessageReplyMarkup({
          inline_keyboard: [
            [
              {
                text: `✅ Подтвердил @${ctx.from.username || ctx.from.first_name}`,
                callback_data: "noop",
              },
            ],
            [{ text: "🖨 В печать", callback_data: `spec_inprod_${n}` }],
            [
              {
                text: "💬 Написать клиенту",
                callback_data: `bridge_open_${n}_${order.telegram_user_id}`,
              },
            ],
          ],
        });
      } catch (e) {
        // ignore
      }
    },
  );

  // 💰 Изменить цену
  bot.action(/^spec_price_([A-Z0-9-]+)$/, requireSpecialist(), async (ctx) => {
    await ctx.answerCbQuery();
    const n = ctx.match[1];
    const order = await db.getOrderByNumber(n);
    if (!order) return;
    await db.setSpecialistState(ctx.from.id, {
      action: "awaiting_price",
      orderNumber: n,
    });
    return safeReply(
      ctx,
      `💰 *Введите новую цену для заказа ${n}*\n\n` +
        `Текущая: ${order.total_price ? order.total_price + " ₽" : "не установлена"}\n\n` +
        `Напишите сумму и причину:\n` +
        `_Пример: 1500 Требуются поддержки_\n\n` +
        `/cancel_price — отменить`,
      { parse_mode: "Markdown" },
    );
  });

  // ⚠️ Проблема с файлом
  bot.action(/^spec_issue_([A-Z0-9-]+)$/, requireSpecialist(), async (ctx) => {
    await ctx.answerCbQuery();
    const n = ctx.match[1];
    return safeReply(ctx, `⚠️ *Укажите проблему с файлом ${n}:*`, {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: "📏 Неверный масштаб",
              callback_data: `spec_iss_scale_${n}`,
            },
          ],
          [
            {
              text: "🧱 Слишком тонкие стенки",
              callback_data: `spec_iss_walls_${n}`,
            },
          ],
          [
            {
              text: "🔧 Сломанная геометрия",
              callback_data: `spec_iss_mesh_${n}`,
            },
          ],
          [
            {
              text: "📐 Нет файла / не тот формат",
              callback_data: `spec_iss_fmt_${n}`,
            },
          ],
          [{ text: "✍️ Написать своё", callback_data: `spec_iss_own_${n}` }],
        ],
      },
    });
  });

  bot.action(
    /^spec_iss_(scale|walls|mesh|fmt|own)_([A-Z0-9-]+)$/,
    requireSpecialist(),
    async (ctx) => {
      await ctx.answerCbQuery();
      const [, type, n] = ctx.match;
      const order = await db.getOrderByNumber(n);
      if (!order) return;

      if (type === "own") {
        await db.setSpecialistState(ctx.from.id, {
          action: "awaiting_issue_text",
          orderNumber: n,
        });
        return safeReply(
          ctx,
          "Напишите что не так с файлом — бот объяснит клиенту понятным языком:",
        );
      }

      const msgs = {
        scale:
          "Файл экспортирован в неверных единицах (скорее всего дюймы вместо мм). Исправьте масштаб в CAD-программе и пришлите снова.",
        walls:
          "Некоторые элементы модели слишком тонкие — они не напечатаются качественно. Нужно утолщить стенки до 0.8 мм в CAD.",
        mesh: "В файле обнаружены ошибки геометрии. Можно исправить бесплатно в программе Meshmixer — или мы поможем за дополнительную плату.",
        fmt: "Нам нужен файл в формате STL, STEP или OBJ. Пришлите правильный формат или уточните у специалиста.",
      };

      await notifyClientFileIssue(ctx, order, msgs[type]);
      await db.updateOrderStatus(n, "CANCELLED");
      try {
        await ctx.editMessageReplyMarkup({
          inline_keyboard: [
            [
              {
                text: `⚠️ Проблема с файлом — клиент уведомлён`,
                callback_data: "noop",
              },
            ],
          ],
        });
      } catch (e) {
        // ignore
      }
      return safeReply(
        ctx,
        "✅ Клиент уведомлён, заказ отменён. Если пришлёт новый файл — создастся новая заявка.",
      );
    },
  );

  // 🖨 В печать
  bot.action(/^spec_inprod_([A-Z0-9-]+)$/, requireSpecialist(), async (ctx) => {
    await ctx.answerCbQuery();
    const n = ctx.match[1];
    const order = await db.getOrderByNumber(n);
    if (!order) return;
    await db.updateOrderStatus(n, "IN_PROGRESS");
    await db.assignSpecialistToOrder(n, ctx.from.id);
    await notify.notifyClientStatusChange(
      order.telegram_user_id,
      n,
      "IN_PROGRESS",
    );
    try {
      await ctx.editMessageReplyMarkup({
        inline_keyboard: [
          [
            {
              text: `🖨 В печати — @${ctx.from.username || ctx.from.first_name}`,
              callback_data: "noop",
            },
          ],
          [{ text: "📦 Готово", callback_data: `spec_ready_${n}` }],
          [
            {
              text: "💬 Написать клиенту",
              callback_data: `bridge_open_${n}_${order.telegram_user_id}`,
            },
          ],
        ],
      });
    } catch (e) {
      // ignore
    }
  });

  // 📦 Готово
  bot.action(/^spec_ready_([A-Z0-9-]+)$/, requireSpecialist(), async (ctx) => {
    await ctx.answerCbQuery("Клиент уведомлён!");
    const n = ctx.match[1];
    const order = await db.getOrderByNumber(n);
    if (!order) return;
    await db.updateOrderStatus(n, "READY");
    await notify.notifyClientStatusChange(order.telegram_user_id, n, "READY");
    try {
      await ctx.editMessageReplyMarkup({
        inline_keyboard: [
          [{ text: "📦 Готово ✅", callback_data: "noop" }],
          [{ text: "🚗 Выдан/Отправлен", callback_data: `spec_deliver_${n}` }],
          [
            {
              text: "💬 Написать клиенту",
              callback_data: `bridge_open_${n}_${order.telegram_user_id}`,
            },
          ],
        ],
      });
    } catch (e) {
      // ignore
    }
  });

  // 🚗 Выдан
  bot.action(
    /^spec_deliver_([A-Z0-9-]+)$/,
    requireSpecialist(),
    async (ctx) => {
      await ctx.answerCbQuery("Отмечено как выдано");
      const n = ctx.match[1];
      const order = await db.getOrderByNumber(n);
      if (!order) return;
      await db.updateOrderStatus(n, "DELIVERED");
      await notify.notifyClientStatusChange(
        order.telegram_user_id,
        n,
        "DELIVERED",
      );
      try {
        await ctx.editMessageReplyMarkup({
          inline_keyboard: [[{ text: "🚗 Выдан ✅", callback_data: "noop" }]],
        });
      } catch (e) {
        // ignore
      }
    },
  );

  // ── Ввод цены/текста проблемы текстом ────────────────────────────────
  bot.on("text", requireSpecialist(), async (ctx, next) => {
    const state = await db.getSpecialistState(ctx.from.id);
    if (!state) return next();

    if (state.action === "awaiting_price") {
      const parts = ctx.message.text.trim().split(" ");
      const price = parseFloat(parts[0]);
      const reason = parts.slice(1).join(" ") || "корректировка стоимости";
      if (isNaN(price) || price <= 0)
        return safeReply(
          ctx,
          "Введите число. Пример: `1500 Требуются поддержки`",
          { parse_mode: "Markdown" },
        );
      const order = await db.getOrderByNumber(state.orderNumber);
      if (!order) {
        await db.clearSpecialistState(ctx.from.id);
        return safeReply(ctx, "Заказ не найден.");
      }
      await db.updateOrder(state.orderNumber, { total_price: price });
      await db.clearSpecialistState(ctx.from.id);
      await notifyClientPriceAdjusted(ctx, order, price, reason);
      return safeReply(
        ctx,
        `✅ Цена обновлена: *${price} ₽*\nКлиент получил запрос на подтверждение.`,
        { parse_mode: "Markdown" },
      );
    }

    if (state.action === "awaiting_issue_text") {
      const order = await db.getOrderByNumber(state.orderNumber);
      if (order) {
        await notifyClientFileIssue(ctx, order, ctx.message.text.trim());
        await db.updateOrderStatus(state.orderNumber, "CANCELLED");
      }
      await db.clearSpecialistState(ctx.from.id);
      return safeReply(ctx, "✅ Клиент уведомлён о проблеме с файлом.");
    }

    return next();
  });

  bot.command("cancel_price", requireSpecialist(), async (ctx) => {
    await db.clearSpecialistState(ctx.from.id);
    return safeReply(ctx, "Отменено. /orders — вернуться к заказам");
  });

  bot.command("endchat", requireSpecialist(), async (ctx) => {
    if (ctx.chat.type !== "private") return;
    const closed = await notify.closeBridge(ctx.from.id);
    if (!closed)
      return safeReply(ctx, "У вас нет активного диалога с клиентом.");
  });

  // ── Управление специалистами (admin) ─────────────────────────────────
  bot.command("specialists", requireAdmin(), async (ctx) => {
    const list = await db.getAllSpecialists();
    if (!list.length)
      return safeReply(ctx, "Список пуст. /addspec 123456789 Имя");
    const lines = list
      .map(
        (s) =>
          `${s.is_active ? "✅" : "❌"} *${s.name}* | \`${s.telegram_id}\` | ${s.role}`,
      )
      .join("\n");
    return safeReply(ctx, `👥 *Специалисты:*\n\n${lines}`, {
      parse_mode: "Markdown",
    });
  });

  bot.command("addspec", requireAdmin(), async (ctx) => {
    const [, id, name, role] = ctx.message.text.split(" ");
    if (!id || !name)
      return safeReply(ctx, "Использование: /addspec 123456789 Имя [admin]");
    await db.addSpecialist({
      telegramId: parseInt(id),
      name,
      role: role === "admin" ? "admin" : "specialist",
    });
    return safeReply(ctx, `✅ *${name}* (\`${id}\`) добавлен.`, {
      parse_mode: "Markdown",
    });
  });

  bot.command("removespec", requireAdmin(), async (ctx) => {
    const id = parseInt(ctx.message.text.split(" ")[1]);
    if (!id) return safeReply(ctx, "Использование: /removespec 123456789");
    await db.deactivateSpecialist(id);
    return safeReply(ctx, `✅ Специалист \`${id}\` деактивирован.`, {
      parse_mode: "Markdown",
    });
  });

  bot.action("noop", (ctx) => ctx.answerCbQuery());
}

// ── Уведомления клиенту ───────────────────────────────────────────────────

async function sendPaymentRequest(ctx, order) {
  try {
    if (!order.telegram_user_id) {
      console.error(
        "[sendPaymentRequest] missing telegram_user_id for order",
        order.order_number,
      );
      return;
    }
    await safeSendMessage(
      ctx,
      order.telegram_user_id,
      `✅ *Заказ ${escapeMd(order.order_number)} подтверждён!*\n\n` +
        `🧱 ${escapeMd(order.material_code)} (${escapeMd(order.method_code)})\n` +
        `📐 ${escapeMd(order.size_x)}×${escapeMd(order.size_y)}×${escapeMd(order.size_z)} мм · ${escapeMd(order.quantity)} шт\n` +
        `💰 Стоимость: *${escapeMd(order.total_price)} ₽*\n` +
        `📅 Готовность: *${escapeMd(order.ready_date || "уточняется")}*\n\n` +
        `Для начала печати оплатите заказ:`,
      {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: `💳 Оплатить ${order.total_price} ₽`,
                url: `https://hevial.ru/pay/${order.order_number}`,
              },
            ],
            [{ text: "💬 Есть вопрос", callback_data: "action_specialist" }],
          ],
        },
      },
    );
  } catch (e) {
    console.error(
      "[sendPaymentRequest]",
      e && (e.response?.description || e.message || e),
    );
  }
}

async function notifyClientPriceAdjusted(ctx, order, newPrice, reason) {
  try {
    if (!order.telegram_user_id) {
      console.error(
        "[notifyClientPriceAdjusted] missing telegram_user_id for order",
        order.order_number,
      );
      return;
    }
    await safeSendMessage(
      ctx,
      order.telegram_user_id,
      `💰 *Уточнение по заказу ${escapeMd(order.order_number)}*\n\n` +
        `Специалист скорректировал стоимость:\n` +
        `Причина: _${escapeMd(reason)}_\n` +
        `Новая стоимость: *${escapeMd(newPrice)} ₽*\n\n` +
        `Подтвердите для начала печати:`,
      {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: `✅ Согласен, оплатить ${newPrice} ₽`,
                url: `https://hevial.ru/pay/${order.order_number}`,
              },
            ],
            [
              {
                text: "💬 Уточнить у специалиста",
                callback_data: "action_specialist",
              },
            ],
            [{ text: "❌ Отменить заказ", callback_data: "cmd_cancel" }],
          ],
        },
      },
    );
  } catch (e) {
    console.error(
      "[notifyClientPriceAdjusted]",
      e && (e.response?.description || e.message || e),
    );
  }
}

async function notifyClientFileIssue(ctx, order, description) {
  try {
    if (!order.telegram_user_id) {
      console.error(
        "[notifyClientFileIssue] missing telegram_user_id for order",
        order.order_number,
      );
      return;
    }
    await safeSendMessage(
      ctx,
      order.telegram_user_id,
      `⚠️ *По вашему заказу ${escapeMd(order.order_number)} есть вопрос*\n\n` +
        `${escapeMd(description)}\n\n` +
        `Что хотите сделать?`,
      {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: "📎 Прислать новый файл",
                callback_data: "action_new_file",
              },
            ],
            [
              {
                text: "💬 Обсудить со специалистом",
                callback_data: "action_specialist",
              },
            ],
            [
              {
                text: "📐 Заказать моделирование",
                callback_data: "type_modeling",
              },
            ],
            [{ text: "❌ Отменить заявку", callback_data: "cmd_cancel" }],
          ],
        },
      },
    );
  } catch (e) {
    console.error(
      "[notifyClientFileIssue]",
      e && (e.response?.description || e.message || e),
    );
  }
}

module.exports = {
  isSpecialist,
  isAdmin,
  requireSpecialist,
  requireAdmin,
  registerSpecialistCommands,
  buildOrderCard,
  buildOrderButtons,
};
