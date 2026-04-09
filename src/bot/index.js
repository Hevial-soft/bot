const { Telegraf } = require("telegraf");
const dialog = require("./dialog");
const notify = require("../services/notification");
const db = require("../db");
const session = require("../middleware/session");
const STEPS = require("./steps");

const registerCallbacks = require("./callbacks");
const { registerSpecialistCommands } = require("../services/specialists");

const bot = new Telegraf(process.env.BOT_TOKEN);

// Устанавливаем экземпляр бота в сервис уведомлений раньше, чем регистрируем хендлеры
notify.setBotInstance(bot);
registerCallbacks(bot);
registerSpecialistCommands(bot);

// ── Middleware: логгер ────────────────────────────────────────────────────
bot.use(require("../middleware/logger"));

// ── Middleware: мост специалист ↔ клиент ─────────────────────────────────
bot.use(async (ctx, next) => {
  const chatId = ctx.chat?.id;
  if (!chatId) return next();

  // Если этот chat участвует в активном мосту — пересылаем
  if (await notify.isInBridge(chatId)) {
    const text = ctx.message?.text || null;
    const fileId =
      ctx.message?.document?.file_id ||
      (ctx.message?.photo
        ? ctx.message.photo[ctx.message.photo.length - 1].file_id
        : null);
    const type = ctx.message?.document
      ? "FILE"
      : ctx.message?.photo
        ? "PHOTO"
        : "TEXT";

    // Команды всё равно проходят дальше
    if (text && text.startsWith("/")) return next();

    const forwarded = await notify.forwardThroughBridge(
      chatId,
      text,
      fileId,
      type,
    );
    if (forwarded) return; // перехватили — дальше не идём
  }

  return next();
});

// ── Команды ───────────────────────────────────────────────────────────────
bot.start(async (ctx) => {
  try {
    const client = await db.getOrCreateClient(ctx.from);
    await dialog.handleStart(ctx, client);
  } catch (err) {
    console.error("Start error:", err);
    await ctx.reply("Что-то пошло не так. Попробуйте снова /start");
  }
});

bot.command("specialist", async (ctx) => {
  try {
    const client = await db.getOrCreateClient(ctx.from);
    await dialog.handleTransferToSpecialist(ctx, client);
  } catch (err) {
    console.error("Specialist command error:", err);
  }
});

bot.command("status", async (ctx) => {
  try {
    const client = await db.getOrCreateClient(ctx.from);
    await dialog.handleStatus(ctx, client);
  } catch (err) {
    console.error("Status command error:", err);
  }
});

bot.command("help", async (ctx) => {
  try {
    await ctx.reply(
      `📖 *Помощь Hevial*\n\n` +
        `/start — начать оформление заказа\n` +
        `/status — статус текущего заказа\n` +
        `/specialist — связаться со специалистом\n` +
        `/help — это сообщение`,
      { parse_mode: "Markdown" },
    );
  } catch (err) {
    console.error("Help error:", err);
  }
});

// ── Входящие сообщения (текст, фото, файлы) ──────────────────────────────
bot.on("message", async (ctx) => {
  try {
    if (ctx.chat.type !== "private") return;
    await dialog.handle(ctx);
  } catch (err) {
    console.error("Message handler error:", err.message, err.stack);
    await ctx.reply("Что-то пошло не так 😔 Попробуйте /start");
  }
});

// ── Callback от inline-кнопок ─────────────────────────────────────────────
bot.on("callback_query", async (ctx) => {
  try {
    const data = ctx.callbackQuery.data;
    const chatId = ctx.chat.id;
    const userId = ctx.from.id;

    // Отвечаем на callback чтобы убрать "часики" на кнопке
    await ctx.answerCbQuery();

    // ── Кнопки специалиста (управление заказами) ──────────────────────────
    if (data.startsWith("accept_")) {
      const orderNumber = data.replace("accept_", "");
      await db.changeOrderStatus(orderNumber, "ACCEPTED", "SPECIALIST");
      const order = await db.getOrderByNumber(orderNumber);
      // Уведомить клиента
      const client = await db.getOrCreateClient(ctx.from);
      // Получить chat_id клиента через заказ
      const clientInfo = await db.pool.query(
        "SELECT telegram_user_id FROM clients WHERE id = $1",
        [order.client_id],
      );
      const clientChatId = clientInfo.rows[0]?.telegram_user_id;
      if (clientChatId) {
        await notify.notifyClientStatusChange(
          clientChatId,
          orderNumber,
          "ACCEPTED",
        );
      }
      return ctx.reply(`✅ Заказ ${orderNumber} принят в работу.`);
    }

    if (data.startsWith("reject_")) {
      const orderNumber = data.replace("reject_", "");
      await db.changeOrderStatus(
        orderNumber,
        "PROCESSING",
        "SPECIALIST",
        "Требует уточнений",
      );
      return ctx.reply(`🔄 Заказ ${orderNumber} отправлен на уточнение.`);
    }

    if (data.startsWith("bridge_") && data.includes("_")) {
      // bridge_{orderNumber}_{clientChatId}
      const parts = data.split("_");
      const orderNumber = parts[1];
      const clientChatId = parseInt(parts[2]);
      await notify.openBridge(
        chatId,
        clientChatId,
        orderNumber,
        ctx.from.username || ctx.from.first_name,
      );
      return ctx.reply(
        `🔗 Диалог по заказу ${orderNumber} открыт. Пишите — клиент получит.`,
      );
    }

    // ── Кнопки клиентского диалога ────────────────────────────────────────
    // Подменяем текст сообщения на callback_data и передаём в dialog.handle
    // Telegraf не даёт изменить ctx.message, поэтому патчим вручную
    if (!ctx.message) {
      ctx.message = ctx.callbackQuery.message;
    }
    ctx.message = {
      ...ctx.message,
      text: data,
      from: ctx.from,
      chat: ctx.chat,
      message_id: ctx.callbackQuery.message.message_id,
    };

    await dialog.handle(ctx);
  } catch (err) {
    console.error("Callback error:", err.message);
    try {
      await ctx.reply("Ошибка. Попробуйте /start");
    } catch {}
  }
});

// Закрыть мост командой /endchat
bot.command("endchat", async (ctx) => {
  const closed = await notify.closeBridge(ctx.chat.id);
  if (closed) {
    return ctx.reply("🔌 Диалог закрыт.");
  }
  return ctx.reply("Активного диалога нет.");
});

module.exports = { bot };
