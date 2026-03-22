// bot_callbacks.js
// Добавить эти обработчики в src/bot/index.js
// Обрабатывают кнопки из группы специалистов

"use strict";

const notify = require("../services/notification");
const db = require("../db");

module.exports = function registerCallbacks(bot) {
  // ── Взять диалог (клиент запросил специалиста) ────────────────────────
  // callback: take_dialog_{clientTelegramId}
  bot.action(/^take_dialog_(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery();

    const clientTelegramId = parseInt(ctx.match[1]);
    const specialistChatId = ctx.from.id;
    const specialistUsername = ctx.from.username || ctx.from.first_name;

    // Получаем chat_id клиента (у нас telegram_id = chat_id для личных чатов)
    const clientChatId = clientTelegramId;

    const opened = await notify.openBridge(
      specialistChatId,
      clientChatId,
      null, // orderNumber неизвестен — свободный диалог
      specialistUsername,
    );

    if (opened) {
      // Обновляем карточку в группе — "Взял @username"
      await notify.updateGroupCard(clientTelegramId, specialistUsername);
    }
  });

  // ── Открыть мост по заказу (из карточки заказа) ───────────────────────
  // callback: bridge_open_{orderNumber}_{clientTelegramId}
  bot.action(/^bridge_open_([A-Z0-9-]+)_(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery();

    const orderNumber = ctx.match[1];
    const clientTelegramId = parseInt(ctx.match[2]);
    const specialistChatId = ctx.from.id;
    const specialistUsername = ctx.from.username || ctx.from.first_name;

    await notify.openBridge(
      specialistChatId,
      clientTelegramId,
      orderNumber,
      specialistUsername,
    );
  });

  // ── Принять заказ ─────────────────────────────────────────────────────
  // callback: accept_{orderNumber}
  bot.action(/^accept_([A-Z0-9-]+)$/, async (ctx) => {
    await ctx.answerCbQuery("Заказ принят ✅");

    const orderNumber = ctx.match[1];
    const order = await db.getOrderByNumber(orderNumber);
    if (!order) return ctx.answerCbQuery("Заказ не найден");

    await db.updateOrderStatus(orderNumber, "ACCEPTED");
    await notify.notifyClientStatusChange(
      order.client_chat_id,
      orderNumber,
      "ACCEPTED",
    );

    // Обновляем кнопки — убираем "Принять"
    try {
      await ctx.editMessageReplyMarkup({
        inline_keyboard: [
          [
            {
              text: `✅ Принял @${ctx.from.username || ctx.from.first_name}`,
              callback_data: "noop",
            },
          ],
          [
            {
              text: "💬 Написать клиенту",
              callback_data: `bridge_open_${orderNumber}_${order.client_telegram_id}`,
            },
          ],
        ],
      });
    } catch {}
  });

  // ── Отклонить заказ ───────────────────────────────────────────────────
  // callback: reject_{orderNumber}
  bot.action(/^reject_([A-Z0-9-]+)$/, async (ctx) => {
    await ctx.answerCbQuery("Заказ отклонён");

    const orderNumber = ctx.match[1];
    const order = await db.getOrderByNumber(orderNumber);
    if (!order) return;

    await db.updateOrderStatus(orderNumber, "CANCELLED");
    await notify.notifyClientStatusChange(
      order.client_telegram_id,
      orderNumber,
      "CANCELLED",
    );

    try {
      await ctx.editMessageReplyMarkup({
        inline_keyboard: [
          [
            {
              text: `❌ Отклонил @${ctx.from.username || ctx.from.first_name}`,
              callback_data: "noop",
            },
          ],
        ],
      });
    } catch {}
  });

  // ── Взять заявку на моделирование ─────────────────────────────────────
  // callback: modeling_take_{orderNumber}
  bot.action(/^modeling_take_([A-Z0-9-]+)$/, async (ctx) => {
    await ctx.answerCbQuery("Заявка взята в работу ✅");

    const orderNumber = ctx.match[1];
    await db.updateModelingOrderStatus(
      orderNumber,
      "IN_PROGRESS",
      ctx.from.id,
      ctx.from.username,
    );
    await notify.notifyClientStatusChange(null, orderNumber, "MODELING"); // без chat_id — специалист свяжется сам

    try {
      await ctx.editMessageReplyMarkup({
        inline_keyboard: [
          [
            {
              text: `✅ Взял @${ctx.from.username || ctx.from.first_name}`,
              callback_data: "noop",
            },
          ],
        ],
      });
    } catch {}
  });

  // ── Команда завершить мост (/endchat) ─────────────────────────────────
  bot.command("endchat", async (ctx) => {
    // Работает только в личке специалиста
    if (ctx.chat.type !== "private") return;

    const closed = await notify.closeBridge(ctx.from.id);
    if (!closed) {
      return ctx.reply("У вас нет активного диалога с клиентом.");
    }
  });

  // ── Заглушка для кнопок "noop" (уже обработанные) ────────────────────
  bot.action("noop", (ctx) => ctx.answerCbQuery());

  // ── Кнопка "Отменить" из диалога ─────────────────────────────────────
  bot.action("cmd_cancel", async (ctx) => {
    await ctx.answerCbQuery();
    const dialog = require("./dialog");
    const client = await db.getOrCreateClient(ctx.from);
    await dialog.handleCancel(ctx, client);
  });

  // ── Кнопка "Связаться со специалистом" ───────────────────────────────
  bot.action("action_specialist", async (ctx) => {
    await ctx.answerCbQuery();
    const dialog = require("./dialog");
    const client = await db.getOrCreateClient(ctx.from);
    await dialog.handleTransferToSpecialist(ctx, client);
  });
};
