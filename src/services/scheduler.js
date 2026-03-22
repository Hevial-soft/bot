// Планировщик задач — запросы отзывов, напоминания специалисту

"use strict";

const db = require("../db");
const notify = require("./notification");
const stock = require("./stock");

// Запустить все задачи (вызывается после инициализации бота)
function start(bot) {
  const GROUP_ID = process.env.SPECIALIST_GROUP_ID;

  // Каждые 60 минут — проверить заказы ожидающие отзыва
  setInterval(checkPendingReviews.bind(null, bot), 60 * 60 * 1000);

  // Каждые 30 минут — напомнить специалисту о необработанных заказах
  setInterval(remindSpecialistNewOrders.bind(null, bot), 30 * 60 * 1000);

  // Каждые 6 часов (в 09:00 UTC примерно) — проверить остатки материалов
  setInterval(
    () => {
      stock
        .checkLowStockAndNotify(bot, GROUP_ID ? parseInt(GROUP_ID) : null)
        .catch((err) => {
          console.error("[Scheduler] Ошибка checkLowStock:", err.message);
        });
    },
    6 * 60 * 60 * 1000,
  );

  console.log("[Scheduler] Запущен");
}

// Отправить запрос отзыва клиентам у которых статус DELIVERED
async function checkPendingReviews(bot) {
  try {
    const orders = await db.getPendingReviewOrders();
    for (const order of orders) {
      await notify.sendReviewRequest(
        order.telegram_user_id,
        order.order_number,
      );
      await db.markReviewSent(order.order_number);
      console.log(`[Scheduler] Запрос отзыва отправлен: ${order.order_number}`);
    }
  } catch (err) {
    console.error("[Scheduler] Ошибка checkPendingReviews:", err.message);
  }
}

// Напомнить специалисту о новых заказах которые висят > 1 часа
async function remindSpecialistNewOrders(bot) {
  try {
    const specialistId = process.env.SPECIALIST_CHAT_ID;
    if (!specialistId || !bot) return;

    const result = await db.pool.query(`
      SELECT order_number, created_at, material_code, quantity
      FROM orders
      WHERE status = 'NEW'
        AND created_at < NOW() - INTERVAL '1 hour'
    `);

    if (result.rows.length === 0) return;

    const list = result.rows
      .map((o) => `• ${o.order_number} — ${o.material_code}, ${o.quantity} шт`)
      .join("\n");

    await bot.telegram.sendMessage(
      parseInt(specialistId),
      `⚠️ *Необработанные заказы (> 1 часа):*\n\n${list}`,
      { parse_mode: "Markdown" },
    );
  } catch (err) {
    console.error("[Scheduler] Ошибка remindSpecialist:", err.message);
  }
}

module.exports = { start };
