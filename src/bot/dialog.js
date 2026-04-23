const STEPS = require("./steps");
const db = require("../db");
const ai = require("../services/ai");
const pricing = require("../services/pricing");
const notify = require("../services/notification");
const stl = require("../services/stl_analyzer"); // анализатор STL
const stock = require("../services/stock");

// ═══════════════════════════════════════════════════════════════════════════
// ГЛАВНАЯ ТОЧКА ВХОДА
// ═══════════════════════════════════════════════════════════════════════════

async function handle(ctx) {
  try {
    const userId = ctx.from.id;
    const msg = ctx.message;
    const text = msg?.text?.trim() || "";

    // Клиент из БД (создаём если новый)
    const client = await db.getOrCreateClient(ctx.from);
    if (client.is_blocked)
      return ctx.reply(
        "Ваш аккаунт заблокирован. Напишите на 3d.homis@gmail.com",
      );

    // ── Глобальные команды (работают на любом шаге) ──────
    if (text === "/start") return handleStart(ctx, client);
    if (text === "/cancel") return handleCancel(ctx, client);
    if (text === "/specialist") return handleTransferToSpecialist(ctx, client);
    if (text === "/status") return handleStatus(ctx, client);
    if (text === "/help") return handleHelp(ctx);

    // ── Загружаем сессию из БД (персистентная!) ──────────
    const s = await db.getOrCreateSession(userId, ctx.chat.id);

    // Лог
    console.log(
      `[Dialog] user=${userId} step=${s.currentStep} text="${text.slice(0, 40)}"`,
    );

    // Сохраняем сообщение пользователя
    await saveUserMessage(msg, client, s);

    // ── Маршрутизация ─────────────────────────────────────
    switch (s.currentStep) {
      // Общие
      case STEPS.START:
        return handleStart(ctx, client);

      // Вход
      case STEPS.AWAITING_ORDER_TYPE:
        return handleOrderType(ctx, msg, s, client);
      case STEPS.AWAITING_FILE:
        return handleAwaitingFile(ctx, msg, s, client);

      // Ветка моделирования
      case STEPS.MODELING_USE_CASE:
        return handleModelingUseCase(ctx, msg, s, client);
      case STEPS.MODELING_DIMENSIONS:
        return handleModelingDimensions(ctx, msg, s, client);
      case STEPS.MODELING_IS_BROKEN:
        return handleModelingIsBroken(ctx, msg, s, client);
      case STEPS.MODELING_DELIVERY:
        return handleModelingDelivery(ctx, msg, s, client);
      case STEPS.MODELING_URGENCY:
        return handleModelingUrgency(ctx, msg, s, client);
      case STEPS.MODELING_SUMMARY:
        return handleModelingSummary(ctx, msg, s, client);

      // Ветка печати
      case STEPS.AWAITING_USE_CASE:
        return handleUseCase(ctx, msg, s, client);
      case STEPS.MATERIAL_SUGGESTION:
        return handleMaterialSuggestion(ctx, msg, s, client);
      case STEPS.MATERIAL_CLIENT_CHOICE:
        return handleMaterialClientChoice(ctx, msg, s, client);
      case STEPS.MATERIAL_CHECK:
        return checkMaterialCompatibility(ctx, s, s.clientMaterialWish);
      case STEPS.MATERIAL_CONFLICT_RESOLVE:
        return handleMaterialConflict(ctx, msg, s, client);
      case STEPS.METHOD_WARNING:
        return handleMethodWarning(ctx, msg, s, client);
      case STEPS.AWAITING_STL_ANALYSIS:
        return handleStlAnalysis(ctx, msg, s, client);
      case STEPS.AWAITING_SIZE:
        return handleSize(ctx, msg, s, client);
      case STEPS.AWAITING_QUANTITY:
        return handleQuantity(ctx, msg, s, client);
      case STEPS.AWAITING_URGENCY:
        return handleUrgency(ctx, msg, s, client);
      case STEPS.AWAITING_DELIVERY:
        return handleDelivery(ctx, msg, s, client);
      case STEPS.ORDER_SUMMARY:
        return handleOrderSummary(ctx, msg, s, client);
      case STEPS.AWAITING_REVIEW:
        return handleReview(ctx, msg, s, client);

      // Специалист
      case STEPS.WAITING_SPECIALIST:
        return handleWaitingSpecialist(ctx, msg, s, client);

      // Заказ уже оформлен — предлагаем новый
      case STEPS.ORDER_CONFIRMED:
      case STEPS.MODELING_CONFIRMED:
      case STEPS.CANCELLED:
        return ctx.reply(
          "Ваш заказ уже оформлен 👍\n\nХотите создать новый?",
          btn([
            ["🆕 Новый заказ", "action_new"],
            ["📋 Статус заказа", "action_status"],
          ]),
        );

      default:
        console.warn(`[Dialog] Неизвестный шаг: ${s.currentStep}`);
        return handleStart(ctx, client);
    }
  } catch (err) {
    console.error("[Dialog] Error:", err.message, err.stack);
    try {
      await ctx.reply("Что-то пошло не так 😔 Попробуйте /start");
    } catch {}
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// ШАГ 0 — СТАРТ
// ═══════════════════════════════════════════════════════════════════════════

async function handleStart(ctx, client) {
  // Сбросить сессию в БД
  await db.resetSession(ctx.from.id, ctx.chat.id, STEPS.AWAITING_ORDER_TYPE);

  return ctx.reply(
    `👋 Привет, *${escapeMarkdown(client.first_name)}*!\n\n` +
      `Я бот *Hevial* — 3D-печать и моделирование под ваш запрос.\n` +
      `Не нужно разбираться в материалах — просто опишите задачу.\n\n` +
      `Что хотите сделать?`,
    {
      parse_mode: "Markdown",
      ...btn([
        ["🖨 Заказать 3D-печать", "type_print"],
        ["📐 Нужно 3D-моделирование", "type_modeling"],
        ["💬 Связаться со специалистом", "action_specialist"],
      ]),
    },
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// ШАГ 1 — ВЫБОР ТИПА ЗАКАЗА
// ═══════════════════════════════════════════════════════════════════════════

async function handleOrderType(ctx, msg, s, client) {
  const text = msg?.text?.trim() || ctx.callbackQuery?.data?.trim();

  if (text === "type_print" || text.includes("печат")) {
    await db.updateSession(s.id, {
      currentStep: STEPS.AWAITING_FILE,
      orderType: "PRINT",
    });
    return ctx.reply("📁 Есть файл модели или фото детали?", {
      ...btn([
        ["📎 Загрузить STL/STEP", "file_upload"],
        ["📷 Только фото + размеры", "file_photo"],
        ["❓ Ничего нет, опишу задачу", "file_none"],
      ]),
      ...cancelRow(),
    });
  }

  if (text === "type_modeling" || text.includes("модел")) {
    await db.updateSession(s.id, {
      currentStep: STEPS.MODELING_USE_CASE,
      orderType: "MODELING",
    });
    return askModelingUseCase(ctx);
  }

  if (text === "action_new") return handleStart(ctx, client);
  if (text === "action_status") return handleStatus(ctx, client);
  if (text === "action_specialist")
    return handleTransferToSpecialist(ctx, client);

  // Повтор
  return handleStart(ctx, client);
}

// ═══════════════════════════════════════════════════════════════════════════
// ШАГ 2 — ФАЙЛ / ФОТО / НЕТ ФАЙЛА
// ═══════════════════════════════════════════════════════════════════════════

async function handleAwaitingFile(ctx, msg, s, client) {
  const text = msg?.text?.trim() || ctx.callbackQuery?.data?.trim() || "";

  // Прислали STL/STEP/документ
  if (msg?.document) {
    const fileId = msg.document.file_id;
    const fileName = msg.document.file_name || "";
    const isStl = /\.(stl|step|stp|obj|3mf)$/i.test(fileName);

    await db.updateSession(s.id, {
      fileId,
      fileName,
      currentStep: STEPS.AWAITING_USE_CASE,
    });

    if (isStl) {
      // Запустим анализ STL — размеры возьмём из файла
      await db.updateSession(s.id, {
        currentStep: STEPS.AWAITING_STL_ANALYSIS,
      });
      await ctx.reply("📁 Файл получен! Анализирую размеры модели...");
      return runStlAnalysis(ctx, s, fileId);
    }

    return askUseCase(ctx);
  }

  // Прислали фото
  if (msg?.photo) {
    const photoId = msg.photo[msg.photo.length - 1].file_id;
    await db.updateSession(s.id, {
      photoId,
      currentStep: STEPS.AWAITING_USE_CASE,
    });
    return ctx.reply(
      "📷 Фото получено!\n\nОпишите деталь и укажите размеры (Д×Ш×В в мм).\nЕсли размеры неизвестны — мы можем сделать 3D-моделирование.",
      {
        ...btn([["📐 Нужно моделирование", "need_modeling"]]),
        ...cancelRow(),
      },
    );
  }

  // Кнопки
  if (text === "file_upload") {
    await db.updateSession(s.id, { currentStep: STEPS.AWAITING_FILE });
    return ctx.reply("📎 Отправьте файл модели (STL, STEP, OBJ, 3MF):");
  }

  if (text === "file_photo") {
    await db.updateSession(s.id, { currentStep: STEPS.AWAITING_FILE });
    return ctx.reply(
      "📷 Отправьте фото детали (можно несколько) и укажите размеры:",
    );
  }

  if (text === "file_none" || text === "file_desc") {
    await db.updateSession(s.id, { currentStep: STEPS.AWAITING_USE_CASE });
    return askUseCase(ctx);
  }

  if (text === "need_modeling") {
    await db.updateSession(s.id, {
      currentStep: STEPS.MODELING_USE_CASE,
      orderType: "MODELING",
    });
    return askModelingUseCase(ctx);
  }

  // Ничего не прислали — повторяем
  return ctx.reply("📁 Есть файл модели или фото детали?", {
    ...btn([
      ["📎 Загрузить STL/STEP", "file_upload"],
      ["📷 Только фото + размеры", "file_photo"],
      ["❓ Ничего нет, опишу задачу", "file_none"],
    ]),
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// ВЕТКА 3D-МОДЕЛИРОВАНИЯ
// ═══════════════════════════════════════════════════════════════════════════

function askModelingUseCase(ctx) {
  return ctx.reply(
    "📐 *Расскажите о детали, которую нужно смоделировать:*\n\n" +
      "Например: _корпус для электроники_, _кронштейн крепления_, _декоративная накладка_\n\n" +
      "Чем подробнее — тем точнее будет модель 🎯",
    { parse_mode: "Markdown" },
  );
}

async function handleModelingUseCase(ctx, msg, s, client) {
  const text = msg?.text?.trim() || "";
  if (text.length < 5) {
    return ctx.reply(
      "Пожалуйста, опишите подробнее — что за деталь и для чего она нужна?",
      { reply_markup: cancelRow() },
    );
  }

  await db.updateSession(s.id, {
    useDescription: text,
    currentStep: STEPS.MODELING_DIMENSIONS,
  });

  return ctx.reply(
    "📏 *Габариты детали*\n\nЕсли знаете — укажите приблизительные размеры (мм).\nЕсли нет — нажмите «Не знаю».",
    {
      ...btn([["❓ Не знаю размеры", "dim_unknown"]]),
    },
  );
}

async function handleModelingDimensions(ctx, msg, s, client) {
  const text = msg?.text?.trim() || ctx.callbackQuery?.data?.trim() || "";

  let dimensions = null;
  if (text !== "dim_unknown") {
    dimensions = parseDimensions(text);
    if (!dimensions && text.length > 2) {
      return ctx.reply(
        "Не смог распознать размеры. Напишите три числа через пробел: `50 30 20`\nИли нажмите «Не знаю».",
        {
          parse_mode: "Markdown",
          ...btn([["❓ Не знаю размеры", "dim_unknown"]]),
          ...cancelRow(),
        },
      );
    }
  }

  await db.updateSession(s.id, {
    sizeX: dimensions?.[0] || null,
    sizeY: dimensions?.[1] || null,
    sizeZ: dimensions?.[2] || null,
    currentStep: STEPS.MODELING_IS_BROKEN,
  });

  return ctx.reply(
    "🔧 *Это существующая деталь, которую нужно воссоздать?*\n\n" +
      "Например: сломана деталь, нет чертежей, нужен реверс-инжиниринг.",
    {
      ...btn([
        ["✅ Да, нужен реверс-инжиниринг", "modeling_reverse"],
        ["❌ Нет, нужна новая деталь", "modeling_new"],
      ]),
      ...cancelRow(),
    },
  );
}

async function handleModelingIsBroken(ctx, msg, s, client) {
  const text = msg?.text?.trim() || ctx.callbackQuery?.data?.trim() || "";
  const isReverse = text === "modeling_reverse" || text.includes("реверс");

  await db.updateSession(s.id, {
    isReverse,
    currentStep: STEPS.MODELING_DELIVERY,
  });

  const reverseNote = isReverse
    ? "\n\n🔄 *Реверс-инжиниринг:* для точного результата желательно прислать нам деталь физически."
    : "";

  return ctx.reply(
    `📦 *Доставка детали*${reverseNote}\n\n` +
      "Для качественного моделирования лучше передать нам деталь.\n" +
      "Как удобно?",
    {
      ...btn([
        ["📦 Отправлю СДЭК", "delivery_cdek"],
        ["🚗 Заберите у меня (+300₽, МКАД)", "delivery_pickup"],
        ["📷 Только по фото/описанию", "delivery_photo"],
      ]),
    },
  );
}

async function handleModelingDelivery(ctx, msg, s, client) {
  const text = msg?.text?.trim() || ctx.callbackQuery?.data?.trim() || "";

  let deliveryType = "PHOTO";
  let deliveryNote = "📷 Будем работать по фото и описанию.";

  if (text === "delivery_cdek") {
    deliveryType = "CDEK";
    deliveryNote =
      "📦 Хорошо! После подтверждения заказа мы пришлём адрес для отправки СДЭК.";
  } else if (text === "delivery_pickup") {
    deliveryType = "COURIER_PICKUP";
    deliveryNote =
      "🚗 Наш курьер заберёт деталь в пределах МКАД (+300₽ к стоимости).";
  }

  await db.updateSession(s.id, {
    modelingDelivery: deliveryType,
    currentStep: STEPS.MODELING_URGENCY,
  });

  return ctx.reply(
    `${deliveryNote}\n\n` +
      "⏱ *Выберите срочность моделирования:*\n\n" +
      "• Стандарт: *от 5 дней* (зависит от сложности)\n" +
      "• Срочно: *3–5 дней* (+1 000 ₽)",
    {
      ...btn([
        ["⏱ Стандарт (от 5 дней)", "modeling_standard"],
        ["🚀 Срочно (+1 000 ₽)", "modeling_urgent"],
      ]),
      ...cancelRow(),
    },
  );
}

async function handleModelingUrgency(ctx, msg, s, client) {
  const text = msg?.text?.trim() || ctx.callbackQuery?.data?.trim() || "";
  const isUrgent = text === "modeling_urgent";

  await db.updateSession(s.id, {
    modelingUrgency: isUrgent ? "URGENT" : "STANDARD",
    currentStep: STEPS.MODELING_SUMMARY,
  });

  return showModelingSummary(ctx, s, client, isUrgent);
}

async function showModelingSummary(ctx, s, client, isUrgent) {
  const deliveryLabels = {
    CDEK: "📦 Отправка СДЭК",
    COURIER_PICKUP: "🚗 Забираем курьером (+300₽)",
    PHOTO: "📷 По фото/описанию",
  };
  const delivery = s.modelingDelivery || "PHOTO";
  const urgencyText = isUrgent
    ? "🚀 Срочно 3–5 дней (+1 000 ₽)"
    : "⏱ Стандарт от 5 дней";
  const dims =
    s.sizeX && s.sizeY && s.sizeZ
      ? `${s.sizeX}×${s.sizeY}×${s.sizeZ} мм`
      : "не указаны";

  return ctx.reply(
    `📋 *Итог заявки на моделирование*\n\n` +
      `📝 Описание: _${escapeMarkdown(s.useDescription)}_\n` +
      `📐 Габариты: *${escapeMarkdown(dims)}*\n` +
      `🔧 Тип: *${s.isReverse ? "Реверс-инжиниринг" : "Новая деталь"}*\n` +
      `📦 Передача детали: *${deliveryLabels[delivery]}*\n` +
      `⏱ Срочность: *${urgencyText}*\n\n` +
      `💰 Стоимость моделирования рассчитывается индивидуально — ` +
      `специалист свяжется с вами и озвучит цену.\n\n` +
      `Подтвердить заявку?`,
    {
      parse_mode: "Markdown",
      ...btn([
        ["✅ Подтвердить", "modeling_confirm"],
        ["✏️ Изменить", "modeling_edit"],
        ["❌ Отменить", "cmd_cancel"],
      ]),
    },
  );
}

async function handleModelingSummary(ctx, msg, s, client) {
  const text = msg?.text?.trim() || ctx.callbackQuery?.data?.trim() || "";

  if (text === "modeling_edit") {
    await db.updateSession(s.id, { currentStep: STEPS.MODELING_USE_CASE });
    return askModelingUseCase(ctx);
  }

  if (text === "modeling_confirm") {
    // Создаём заявку на моделирование в БД
    const order = await db.createModelingOrder({
      clientId: client.id,
      telegramId: ctx.from.id,
      useDescription: s.useDescription,
      sizeX: s.sizeX,
      sizeY: s.sizeY,
      sizeZ: s.sizeZ,
      isReverse: s.isReverse,
      deliveryType: s.modelingDelivery,
      urgency: s.modelingUrgency,
      photoId: s.photoId,
    });

    if (!order || !order.id) {
      console.error("Failed to create modeling order", order);
      return ctx.reply(
        "Произошла ошибка при создании заказа. Попробуйте позже или /start",
      );
    }

    // Проверяем, что order существует
    const orderNumber = order?.order_number ?? "№?";

    // Обновляем сессию с правильным orderId
    await db.updateSession(s.id, {
      currentStep: STEPS.MODELING_CONFIRMED,
      orderNumber,
    });

    // Отправляем уведомление специалистам
    await notify.notifyModelingOrder(order, client, ctx.from);

    // Сообщение пользователю
    return ctx.reply(
      `✅ *Заявка ${orderNumber} принята!*\n\n` +
        `Специалист свяжется с вами напрямую в Telegram для уточнения деталей и стоимости.\n\n` +
        `⏱ Обычно это занимает до *1 рабочего дня*.\n\n` +
        `/status — статус заявки\n` +
        `/help — помощь`,
      { parse_mode: "Markdown", reply_markup: { remove_keyboard: true } },
    );
  }

  return showModelingSummary(ctx, s, client, s.modelingUrgency === "URGENT");
}

// ═══════════════════════════════════════════════════════════════════════════
// ВЕТКА ПЕЧАТИ — ШАГ 3: ОПИСАНИЕ + УСЛОВИЯ ИСПОЛЬЗОВАНИЯ
// ═══════════════════════════════════════════════════════════════════════════

function askUseCase(ctx) {
  return ctx.reply(
    "🎯 *Расскажите о детали:*\n\n" +
      "• Где и как будет использоваться?\n" +
      "• Какие внешние факторы? (улица, вода, нагрузка, температура)\n" +
      "• Примерные размеры: Длина × Ширина × Высота (мм)\n\n" +
      "_Например: крепёж велосипеда, улица, нагрузка 5кг, 50×30×20 мм_",
    {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: cancelRow(),
      },
    },
  );
}

async function handleUseCase(ctx, msg, s, client) {
  const text =
    escapeMarkdown(msg?.text?.trim()) || ctx.callbackQuery?.data?.trim() || "";

  if (text === "action_specialist")
    return handleTransferToSpecialist(ctx, client);

  if (text.length < 5) {
    return ctx.reply(
      "Расскажите подробнее — где и как будет использоваться деталь?",
    );
  }

  await db.updateSession(s.id, { useDescription: text });

  // Попробовать вытащить размеры из описания
  const dims = parseDimensions(text);
  if (dims) {
    await db.updateSession(s.id, {
      sizeX: dims[0],
      sizeY: dims[1],
      sizeZ: dims[2],
    });
  }

  // Клиент уже назвал материал?
  const named = extractMaterial(text);
  if (named) {
    await db.updateSession(s.id, {
      clientMaterialWish: named,
      currentStep: STEPS.MATERIAL_CHECK,
    });
    return askMaterialChoice(ctx, named);
  }

  // ИИ подбирает
  await ctx.sendChatAction("typing");
  const materials = await db.getAllMaterials();
  const suggestedRaw = await ai.suggestMaterial(text, materials);
  const suggested = normalizeMaterial(suggestedRaw);
  const material = materials.find(
    (m) => normalizeMaterial(m.code) === suggested,
  );

  await db.updateSession(s.id, {
    suggestedMaterial: normalizeMaterial(suggested),
    currentStep: STEPS.MATERIAL_SUGGESTION,
  });

  const suggestionText = ai.formatSuggestion(suggested, material);
  return ctx.reply(suggestionText, { parse_mode: "Markdown" });
}

// ═══════════════════════════════════════════════════════════════════════════
// МАТЕРИАЛ
// ═══════════════════════════════════════════════════════════════════════════

async function handleMaterialSuggestion(ctx, msg, s, client) {
  const text = msg?.text?.trim() || ctx.callbackQuery?.data?.trim() || "";

  if (
    text === "mat_agree" ||
    text.toLowerCase().includes("согла") ||
    text.includes("✅")
  ) {
    const confirmed = s.suggestedMaterial;
    await db.updateSession(s.id, { confirmedMaterial: confirmed });
    s.confirmedMaterial = confirmed; // обновляем объект в памяти
    return proceedToMethodWarning(ctx, s); // передаем уже обновленный объект
  }

  if (text === "mat_alternatives" || text.includes("🔄")) {
    const materials = await db.getAllMaterials();
    const alts = materials
      .filter((m) => m.code !== s.suggestedMaterial)
      .slice(0, 3);
    const altText =
      "🔄 *Альтернативные варианты:*\n\n" +
      alts
        .map(
          (m) =>
            `• *${escapeMarkdown(m.display_name)}*\n  ${escapeMarkdown(m.use_cases.slice(0, 2).join(", "))}`,
        )
        .join("\n\n");
    return ctx.reply(altText, {
      parse_mode: "Markdown",
      ...btn([
        ["✅ Подходит", "mat_agree"],
        ["✏️ Хочу конкретный", "mat_own"],
        ["💬 Позвать специалиста", "action_specialist"],
        ["❌ Отменить заказ", "cmd_cancel"],
      ]),
    });
  }

  if (text === "mat_own" || text.includes("✏️")) {
    await db.updateSession(s.id, { currentStep: STEPS.MATERIAL_CLIENT_CHOICE });
    return ctx.reply(
      "Напишите какой материал хотите (например: PLA, PETG, TPU, смола):",
    );
  }

  if (text === "action_specialist")
    return handleTransferToSpecialist(ctx, client);

  return ctx.reply("Пожалуйста, выберите один из вариантов:", {
    ...btn([
      ["✅ Согласен", "mat_agree"],
      ["🔄 Другие варианты", "mat_alternatives"],
      ["✏️ Свой выбор", "mat_own"],
      ["❌ Отменить", "cmd_cancel"],
    ]),
  });
}

async function handleMaterialClientChoice(ctx, msg, s, client) {
  const text = msg?.text?.trim() || ctx.callbackQuery?.data || "";
  const material = extractMaterial(text);

  if (!material) {
    return ctx.reply(
      "Не распознал материал. Напишите: PLA, PETG, ABS, TPU, PEEK, нейлон, смола.",
      { reply_markup: { inline_keyboard: cancelRow() } },
    );
  }

  await db.updateSession(s.id, {
    clientMaterialWish: normalizeMaterial(material),
    currentStep: STEPS.MATERIAL_CHECK,
  });
  return checkMaterialCompatibility(ctx, s, material);
}

async function checkMaterialCompatibility(ctx, s, materialCode) {
  materialCode = normalizeMaterial(materialCode);
  const material = await db.getMaterialByCode(materialCode);

  if (!material) {
    await db.updateSession(s.id, { currentStep: STEPS.MATERIAL_CLIENT_CHOICE });
    return ctx.reply(
      `Материал *${escapeMarkdown(materialCode)}* не найден в каталоге.\nДоступные: PLA, PETG, ABS, TPU, PEEK, Nylon, PC, SBS, Silk, Resin.`,
      { parse_mode: "Markdown" },
    );
  }

  const { compatible, conflicts } = ai.checkCompatibility(
    material,
    s.useDescription || "",
  );

  if (!compatible) {
    const recommended = s.suggestedMaterial || "PETG";
    await db.updateSession(s.id, {
      currentStep: STEPS.MATERIAL_CONFLICT_RESOLVE,
    });
    return ctx.reply(
      `⚠️ *Внимание!*\n\nВы выбрали *${escapeMarkdown(material.display_name)}*, но он может не подойти:\n` +
        `— ${conflicts.join("\n— ")}\n\n` +
        `Рекомендую *${escapeMarkdown(recommended)}* для ваших условий.\n\nКак поступим?`,
      {
        parse_mode: "Markdown",
        ...btn([
          [
            `🔄 Принять рекомендацию (${escapeMarkdown(recommended)})`,
            "conflict_accept",
          ],
          [`✅ Оставить ${escapeMarkdown(materialCode)}`, "conflict_keep"],
          ["❌ Отменить", "cmd_cancel"],
        ]),
      },
    );
  }

  await db.updateSession(s.id, { confirmedMaterial: materialCode });
  // Обновляем сессию в памяти, чтобы последующие вызовы использовали новый материал
  s.confirmedMaterial = materialCode;
  return proceedToMethodWarning(ctx, s);
}

async function handleMaterialConflict(ctx, msg, s, client) {
  const text = msg?.text?.trim() || "";
  const accept = text === "conflict_accept" || text.includes("🔄");
  const confirmed = normalizeMaterial(
    accept ? s.suggestedMaterial || "PETG" : s.clientMaterialWish,
  );
  await db.updateSession(s.id, {
    confirmedMaterial: confirmed,
    materialOverridden: !accept,
  });
  // Обновляем сессию в памяти, чтобы новый материал сразу использовался в дальнейшем
  s.confirmedMaterial = confirmed;
  s.materialOverridden = !accept;
  return proceedToMethodWarning(ctx, s);
}

// ═══════════════════════════════════════════════════════════════════════════
// ПРЕДУПРЕЖДЕНИЕ О МЕТОДЕ + ОГРАНИЧЕНИЯ ПЕЧАТИ
// ═══════════════════════════════════════════════════════════════════════════

async function proceedToMethodWarning(ctx, s) {
  if (!s.confirmedMaterial) {
    console.error("❌ confirmedMaterial is NULL", s);
    return ctx.reply(
      "Ошибка: материал не определён. Попробуйте ещё раз /start",
    );
  }

  const method = (s.confirmedMaterial || "").startsWith("RESIN")
    ? "RESIN"
    : "FDM";
  const material = await db.getMaterialByCode(s.confirmedMaterial);
  const warning = material?.surface_note || "";

  // Лимиты рабочей зоны
  const maxSize = method === "RESIN" ? 218 : 250;
  const sizeNote =
    method === "RESIN"
      ? `⚠️ *Ограничение фотополимера:* максимальный размер *${maxSize} мм* по любой стороне.`
      : `ℹ️ Рабочая зона FDM: до *${maxSize} мм* по любой стороне.`;

  const text =
    method === "RESIN"
      ? `✅ Материал: *${escapeMarkdown(material?.display_name || s.confirmedMaterial)}* (фотополимер)\n\n` +
        `ℹ️ ${warning}\n${sizeNote}\n⏱ Срок — *5 рабочих дней*`
      : `✅ Материал: *${material?.display_name || s.confirmedMaterial}* (FDM)\n\n` +
        `ℹ️ ${warning}\n${sizeNote}\n` +
        `Если нужна идеальная гладкость — только фотополимер.`;

  await db.updateSession(s.id, {
    confirmedMethod: method,
    currentStep: STEPS.METHOD_WARNING,
  });

  return ctx.reply(text + "\n\nПродолжаем?", {
    parse_mode: "Markdown",
    ...btn([
      ["✅ Понятно, продолжаем", "method_ok"],
      ["🔄 Изменить материал", "method_change"],
      ["❌ Отменить", "cmd_cancel"],
    ]),
  });
}

async function handleMethodWarning(ctx, msg, s, client) {
  const text = msg?.text?.trim() || ctx.callbackQuery?.data?.trim() || "";

  if (text === "method_change" || text.includes("🔄")) {
    await db.updateSession(s.id, { currentStep: STEPS.MATERIAL_CLIENT_CHOICE });
    return ctx.reply("Напишите какой материал хотите:");
  }

  // Если есть STL — уже проанализирован, переходим к количеству
  if (s.fileId && s.sizeX) {
    await db.updateSession(s.id, { currentStep: STEPS.AWAITING_QUANTITY });
    return ctx.reply(
      `📐 Размеры из файла: *${s.sizeX}×${s.sizeY}×${s.sizeZ} мм*\n\nСколько штук нужно напечатать?`,
      { parse_mode: "Markdown" },
    );
  }

  // Если есть размеры из описания — переходим к количеству
  if (s.sizeX && s.sizeY && s.sizeZ) {
    await db.updateSession(s.id, { currentStep: STEPS.AWAITING_QUANTITY });
    return ctx.reply("Сколько штук нужно напечатать?");
  }

  // Нет размеров — просим указать
  await db.updateSession(s.id, { currentStep: STEPS.AWAITING_SIZE });
  return ctx.reply(
    "📐 Укажите размеры детали в мм:\nФормат: *Длина Ширина Высота*\nНапример: `50 30 20`\n\nИли загрузите STL/STEP файл.",
    { parse_mode: "Markdown" },
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// STL-АНАЛИЗ
// ═══════════════════════════════════════════════════════════════════════════

async function runStlAnalysis(ctx, s, fileId) {
  try {
    // Скачиваем файл и анализируем
    const fileLink = await ctx.telegram.getFileLink(fileId);
    const dims = await stl.analyze(fileLink.href);

    if (dims) {
      await db.updateSession(s.id, {
        sizeX: Math.ceil(dims.x),
        sizeY: Math.ceil(dims.y),
        sizeZ: Math.ceil(dims.z),
        volumeCm3: dims.volumeCm3,
        currentStep: STEPS.AWAITING_USE_CASE,
      });

      await ctx.reply(
        `✅ *Модель проанализирована:*\n` +
          `📐 Размеры: *${Math.ceil(dims.x)}×${Math.ceil(dims.y)}×${Math.ceil(dims.z)} мм*\n` +
          `📦 Объём: *${dims.volumeCm3.toFixed(1)} см³*\n\n` +
          `Теперь расскажите как будет использоваться деталь.`,
        { parse_mode: "Markdown" },
      );
      return askUseCase(ctx);
    }
  } catch (err) {
    console.error("[STL] Analysis failed:", err.message);
  }

  // Если анализ не удался — просим ввести вручную
  await db.updateSession(s.id, { currentStep: STEPS.AWAITING_SIZE });
  return ctx.reply(
    "⚠️ Не удалось автоматически определить размеры.\nПожалуйста, укажите вручную (Д×Ш×В в мм):",
  );
}

async function handleStlAnalysis(ctx, msg, s, client) {
  // Ждём пока анализ завершится (обычно мгновенно)
  // Если сюда попали — значит что-то пошло не так, просим размеры
  await db.updateSession(s.id, { currentStep: STEPS.AWAITING_SIZE });
  return ctx.reply("Укажите размеры вручную (Д×Ш×В в мм):");
}

// ═══════════════════════════════════════════════════════════════════════════
// РАЗМЕРЫ (ручной ввод)
// ═══════════════════════════════════════════════════════════════════════════

async function handleSize(ctx, msg, s, client) {
  // Прислали файл прямо здесь
  if (msg?.document) {
    const fileId = msg.document.file_id;
    const fileName = msg.document.file_name || "";
    if (/\.(stl|step|stp|obj|3mf)$/i.test(fileName)) {
      await db.updateSession(s.id, {
        fileId,
        fileName,
        currentStep: STEPS.AWAITING_STL_ANALYSIS,
      });
      await ctx.reply("📁 Анализирую файл...");
      return runStlAnalysis(ctx, s, fileId);
    }
  }

  const text = msg?.text?.trim() || "";
  const dims = parseDimensions(text);

  if (!dims) {
    return ctx.reply(
      "Не смог распознать размеры. Напишите три числа через пробел: `50 30 20`\nИли загрузите STL-файл.",
      { parse_mode: "Markdown" },
    );
  }

  const [x, y, z] = dims;
  const maxAllowed = s.confirmedMethod === "RESIN" ? 218 : 250;
  const maxDim = Math.max(x, y, z);

  if (maxDim > maxAllowed) {
    return ctx.reply(
      `⚠️ Деталь *${maxDim} мм* превышает рабочую зону ${s.confirmedMethod} (${maxAllowed} мм).\n\n` +
        `Для таких размеров нужен расчёт специалиста.`,
      {
        parse_mode: "Markdown",
        ...btn([
          ["💬 Связаться со специалистом", "action_specialist"],
          ["✏️ Ввести другие размеры", "size_retry"],
          ["❌ Отменить", "cmd_cancel"],
        ]),
      },
    );
  }

  await db.updateSession(s.id, {
    sizeX: x,
    sizeY: y,
    sizeZ: z,
    currentStep: STEPS.AWAITING_QUANTITY,
  });
  return ctx.reply("Сколько штук нужно напечатать?");
}

// ═══════════════════════════════════════════════════════════════════════════
// КОЛИЧЕСТВО
// ═══════════════════════════════════════════════════════════════════════════

async function handleQuantity(ctx, msg, s, client) {
  const text = msg?.text?.trim() || ctx.callbackQuery?.data?.trim() || "";
  if (text === "qty_continue") {
    await db.updateSession(s.id, { currentStep: STEPS.AWAITING_URGENCY });
    return buildUrgencyMessage(ctx, s);
  }

  const qty = +text;
  if (!qty || qty < 1) {
    return ctx.reply("Введите количество цифрой, например: 2");
  }

  await db.updateSession(s.id, { quantity: qty });

  if (qty > 10) {
    return ctx.reply(
      `📦 Партия *${qty} шт* — рассчитываем индивидуально.\nПодключить специалиста?`,
      {
        parse_mode: "Markdown",
        ...btn([
          ["✅ Да, соедините со специалистом", "action_specialist"],
          ["📝 Продолжить без расчёта", "qty_continue"],
          ["❌ Отменить", "cmd_cancel"],
        ]),
      },
    );
  }

  await db.updateSession(s.id, { currentStep: STEPS.AWAITING_URGENCY });
  return buildUrgencyMessage(ctx, s);
}

// ═══════════════════════════════════════════════════════════════════════════
// СРОЧНОСТЬ
// ═══════════════════════════════════════════════════════════════════════════

async function handleUrgency(ctx, msg, s, client) {
  const text = msg?.text?.trim() || ctx.callbackQuery?.data?.trim() || "";
  const urgency = parseUrgency(text);
  await db.updateSession(s.id, {
    urgency,
    currentStep: STEPS.AWAITING_DELIVERY,
  });

  return ctx.reply("🚚 Как хотите получить заказ?", {
    parse_mode: "Markdown",
    ...btn([
      ["🚗 Курьер по Москве (бесплатно)", "delivery_courier"],
      ["📦 СДЭК (рассчитаем отдельно)", "delivery_sdek"],
      ["🤝 Самовывоз", "delivery_pickup"],
    ]),
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// ДОСТАВКА + СОЗДАНИЕ ЧЕРНОВИКА ЗАКАЗА
// ═══════════════════════════════════════════════════════════════════════════

async function handleDelivery(ctx, msg, s, client) {
  const text = msg?.text?.trim() || ctx.callbackQuery?.data?.trim() || "";
  let deliveryType = null;
  let deliveryNote = "";

  if (text === "delivery_courier" || text.includes("Курьер")) {
    deliveryType = "COURIER";
    deliveryNote = "";
  } else if (text === "delivery_sdek" || text.includes("СДЭК")) {
    deliveryType = "SDEK";
    deliveryNote = "\n📦 Стоимость СДЭК рассчитаем после оформления.";
  } else if (text === "delivery_pickup" || text.includes("Самовывоз")) {
    deliveryType = "PICKUP";
    deliveryNote = "\n🤝 Место встречи согласуем в чате.";
  } else {
    return ctx.reply(
      "Выберите способ получения:",

      {
        parse_mode: "Markdown",
        ...btn([
          ["🚗 Курьер по Москве", "delivery_courier"],
          ["📦 СДЭК", "delivery_sdek"],
          ["🤝 Самовывоз", "delivery_pickup"],
        ]),
      },
    );
  }

  await db.updateSession(s.id, { deliveryType });

  // Создаём черновик заказа в БД
  const order = await buildAndSaveOrder(s, client);
  await db.updateSession(s.id, {
    orderId: Number.isInteger(order?.id) && order.id > 0 ? order.id : null,
    orderNumber: order.order_number,
    currentStep: STEPS.ORDER_SUMMARY,
  });

  // Обновляем s для summary
  s.orderId = order.id;
  s.orderNumber = order.order_number;

  return buildOrderSummary(ctx, order, deliveryNote);
}

// ═══════════════════════════════════════════════════════════════════════════
// ПОДТВЕРЖДЕНИЕ ЗАКАЗА
// ═══════════════════════════════════════════════════════════════════════════

async function handleOrderSummary(ctx, msg, s, client) {
  const text = msg?.text?.trim() || ctx.callbackQuery?.data?.trim() || "";

  if (text === "order_confirm" || text.includes("✅")) {
    const order = await db.confirmOrder(s.orderNumber);
    await notify.notifyNewOrder(order, client);
    await db.updateSession(s.id, { currentStep: STEPS.ORDER_CONFIRMED });

    return ctx.reply(
      `✅ *Заказ ${order.order_number} принят!*\n\n` +
        `Специалист проверит детали и подтвердит в ближайшее время.\n\n` +
        `/status — статус заказа\n` +
        `/specialist — связаться со специалистом`,
      { parse_mode: "Markdown", reply_markup: { remove_keyboard: true } },
    );
  }

  if (text === "order_edit" || text.includes("✏️")) {
    await db.updateSession(s.id, { currentStep: STEPS.AWAITING_USE_CASE });
    return askUseCase(ctx);
  }

  if (text === "order_cancel" || text === "cmd_cancel")
    return handleCancel(ctx, client);

  // Повторить summary
  const order = await db.getOrderByNumber(s.orderNumber);
  if (order) return buildOrderSummary(ctx, order, "");

  if (order.volume_cm3 && order.material_code) {
    const material = await db.getMaterialByCode(order.material_code);
    const estimatedGrams = Math.round(
      parseFloat(order.volume_cm3) *
        parseFloat(material.density || 1.24) *
        parseFloat(material.fill_coef || 0.3),
    );
    await stock.reserveMaterial(
      order.material_code,
      estimatedGrams,
      order.order_number,
    );
  }

  return ctx.reply("Подтвердите или отмените заказ:", {
    parse_mode: "Markdown",
    ...btn([
      ["✅ Подтвердить", "order_confirm"],
      ["✏️ Изменить", "order_edit"],
      ["❌ Отменить", "cmd_cancel"],
    ]),
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// ОТЗЫВ
// ═══════════════════════════════════════════════════════════════════════════

async function handleReview(ctx, msg, s, client) {
  const text = msg?.text?.trim() || ctx.callbackQuery?.data?.trim() || "";

  if (text === "skip_review") {
    if (s.orderNumber) await db.markReviewSent(s.orderNumber);
    await db.updateSession(s.id, { currentStep: STEPS.CANCELLED });
    return ctx.reply("Спасибо! Обращайтесь снова 🙏", {
      reply_markup: { remove_keyboard: true },
    });
  }

  if (text.length > 5) {
    if (s.orderNumber) await db.saveReview(s.orderNumber, text, null);
    await db.updateSession(s.id, { currentStep: STEPS.CANCELLED });
    return ctx.reply(
      "Спасибо за отзыв! Это помогает нам становиться лучше 🙏",
      { reply_markup: { remove_keyboard: true } },
    );
  }

  return ctx.reply("Оставьте отзыв:", {
    parse_mode: "Markdown",
    ...btn([
      ["⭐ Оставить отзыв", "review_write"],
      ["➡️ Пропустить", "skip_review"],
    ]),
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// СПЕЦИАЛИСТ / МОСТ
// ═══════════════════════════════════════════════════════════════════════════

async function handleTransferToSpecialist(ctx, client) {
  const s = await db.getOrCreateSession(ctx.from.id, ctx.chat.id);
  await db.updateSession(s.id, {
    currentStep: STEPS.WAITING_SPECIALIST,
    awaitingSpecialist: true,
  });

  await ctx.reply(
    "💬 *Соединяю вас со специалистом.*\n\n" +
      "Опишите вашу задачу — специалист ответит в рабочее время (пн–пт 10:00–19:00 МСК).",
    { parse_mode: "Markdown", reply_markup: { remove_keyboard: true } },
  );
}

async function handleWaitingSpecialist(ctx, msg, s, client) {
  const text = msg?.text || null;
  const fileId =
    msg?.document?.file_id ||
    (msg?.photo ? msg.photo[msg.photo.length - 1].file_id : null);
  const msgType = msg?.document ? "FILE" : msg?.photo ? "PHOTO" : "TEXT";
  
  if (!s.specialist_notified) {
    await notify.notifySpecialistGroup(ctx, client, s);
    await db.updateSession(s.id, { specialist_notified: true });
  }

  const forwarded = await notify.forwardThroughBridge(
    ctx.chat.id,
    text,
    fileId,
    msgType,
  );
  if (!forwarded) {
    return ctx.reply(
      "✉️ Сообщение получено. Специалист ответит в рабочее время.",
    );
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// КОМАНДЫ
// ═══════════════════════════════════════════════════════════════════════════

async function handleCancel(ctx, client) {
  // Загружаем сессию чтобы снять резерв материала если он был
  const s = await db.getOrCreateSession(ctx.from.id, ctx.chat.id);

  await db.resetSession(ctx.from.id, ctx.chat.id, STEPS.CANCELLED);

  if (s.orderNumber && s.confirmedMaterial && s.volumeCm3) {
    // Снимаем резерв если был
    const estimatedGrams = Math.round(
      parseFloat(s.volumeCm3) * getMaterialDensity(s.confirmedMaterial) * 0.3,
    );
    await stock.releaseMaterial(
      s.confirmedMaterial,
      estimatedGrams,
      s.orderNumber,
    );
  }

  return ctx.reply(
    "❌ Заказ отменён.\n\nНапишите /start чтобы начать заново.",
    { reply_markup: { remove_keyboard: true } },
  );
}

async function handleStatus(ctx, client) {
  // Support: "/status" (current active order for user) or
  // "/status HVL-00001" (fetch by order number, including DELIVERED/CLOSED)
  const text = ctx.message?.text || "";
  const parts = text.trim().split(/\s+/);
  const requestedNumber = parts[1]?.toUpperCase();

  let order;
  if (requestedNumber) {
    order = await db.getOrderByNumber(requestedNumber);
    if (!order) return ctx.reply(`Заказ ${requestedNumber} не найден.`);
  } else {
    order = await db.getActiveOrderByTelegramId(ctx.from.id);
    if (!order)
      return ctx.reply("У вас нет активных заказов.\n/start — создать новый");
  }

  const labels = {
    NEW: "⏳ Новый",
    PROCESSING: "🔄 В обработке",
    ACCEPTED: "✅ Принят",
    PAID: "💳 Оплачен",
    IN_PROGRESS: "🖨 Печатается",
    READY: "📦 Готов",
    DELIVERED: "🚗 Выдан",
    CLOSED: "✔️ Закрыт",
    MODELING: "📐 Моделирование",
    MODELING_DONE: "✅ Модель готова",
  };

  // Build response; include delivered_at if present
  const created =
    order.created_at?.toISOString?.().split("T")[0] || "неизвестно";
  const ready = order.ready_date || "уточняется";
  const delivered = order.delivered_at
    ? order.delivered_at.toISOString().split("T")[0]
    : null;

  let resp =
    `📋 *Заказ ${order.order_number}*\n` +
    `Статус: *${labels[order.status] || order.status}*\n` +
    `Создан: ${created}\n` +
    `Готовность: ${ready}`;

  if (delivered) {
    resp += `\nВыдан: ${delivered}`;
  }

  return ctx.reply(resp, { parse_mode: "Markdown" });
}

async function handleHelp(ctx) {
  return ctx.reply(
    `📖 *Помощь Hevial*\n\n` +
      `/start — начать оформление заказа\n` +
      `/cancel — отменить текущий заказ\n` +
      `/status — статус текущего заказа\n` +
      `/specialist — связаться со специалистом\n` +
      `/help — это сообщение\n\n` +
      `*Способы передачи файла:*\n` +
      `— Загрузить STL/STEP прямо в чат\n` +
      `— Прислать фото детали с размерами`,
    { parse_mode: "Markdown" },
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ
// ═══════════════════════════════════════════════════════════════════════════

function askMaterialChoice(ctx, material) {
  return ctx.reply(
    `Вы упомянули *${material}*. Это ваш выбор или хотите рекомендацию от ИИ?`,
    {
      parse_mode: "Markdown",
      ...btn([
        [`✅ Да, хочу ${material}`, "mat_keep_own"],
        ["🤖 Подобрать под задачу", "mat_ai"],
        ["❌ Отменить", "cmd_cancel"],
      ]),
    },
  );
}

function buildUrgencyMessage(ctx, s) {
  const baseDays = s.confirmedMethod === "RESIN" ? 5 : 2;
  const date = new Date();
  date.setDate(date.getDate() + baseDays);

  const options = {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  };
  let dateStr = date.toLocaleDateString("ru-RU", options);

  // Сделать первую букву заглавной
  dateStr = dateStr.charAt(0).toUpperCase() + dateStr.slice(1);

  return ctx.reply(
    `⏱ *Срочность изготовления*\n\nОриентировочная готовность: *${dateStr}*`,
    {
      parse_mode: "Markdown",
      ...btn([
        ["⏱ Стандарт (без наценки)", "urgency_standard"],
        ["🚀 Быстрее (+200 ₽)", "urgency_200"],
        ["⚡ Срочно (+500 ₽)", "urgency_500"],
        ["🔥 Максимум (+800 ₽)", "urgency_800"],
      ]),
      ...cancelRow(),
    },
  );
}

async function buildOrderSummary(ctx, order, extra = "") {
  const deliveryLabels = {
    COURIER: "🚗 Курьер (бесплатно)",
    SDEK: "📦 СДЭК",
    PICKUP: "🤝 Самовывоз",
  };
  const urgencyLabels = {
    STANDARD: "Стандарт",
    PLUS200: "+200₽",
    PLUS500: "+500₽",
    PLUS800: "+800₽",
  };
  const price = order.total_price
    ? `${order.total_price} ₽`
    : "рассчитывается специалистом";

  // Преобразуем дату готовности
  let readyDateStr = "уточняется"; // по умолчанию
  if (order.ready_date) {
    const readyDate = new Date(order.ready_date); // создаём объект Date
    const options = {
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
    }; // формат
    readyDateStr = readyDate.toLocaleDateString("ru-RU", options); // на русском
    readyDateStr = readyDateStr.charAt(0).toUpperCase() + readyDateStr.slice(1); // заглавная первая буква
  }

  return ctx.reply(
    `📋 *Проверьте ваш заказ ${escapeMarkdown(order.order_number)}*\n\n` +
      `🧱 Материал: *${escapeMarkdown(order.material_code)}* (${escapeMarkdown(order.method_code)})\n` +
      `📐 Размеры: *${escapeMarkdown(order.size_x)}×${escapeMarkdown(order.size_y)}×${escapeMarkdown(order.size_z)} мм*\n` +
      `🔢 Количество: *${escapeMarkdown(order.quantity)} шт*\n` +
      `⏱ Срочность: *${urgencyLabels[order.urgency] || order.urgency}*\n` +
      `🚚 Доставка: *${deliveryLabels[order.delivery_type] || order.delivery_type}*\n` +
      `📅 Готовность: *${escapeMarkdown(readyDateStr)}*\n` +
      `───────────────\n` +
      `💰 Стоимость: *${escapeMarkdown(price)}*${escapeMarkdown(extra)}\n\n` +
      `Всё верно? Подтвердите заказ.`,
    {
      parse_mode: "Markdown",
      ...btn([
        ["✅ Подтвердить заказ", "order_confirm"],
        ["✏️ Изменить данные", "order_edit"],
        ["❌ Отменить", "cmd_cancel"],
      ]),
    },
  );
}

async function buildAndSaveOrder(s, client) {
  // ✅ ЖЁСТКАЯ ВАЛИДАЦИЯ МАТЕРИАЛА
  const normalizedMaterial = normalizeMaterial(s.confirmedMaterial);

  console.log("🧱 RAW MATERIAL:", s.confirmedMaterial);
  console.log("🧱 NORMALIZED:", normalizedMaterial);

  const materialExists = await db.getMaterialByCode(normalizedMaterial);

  if (!materialExists) {
    console.error("❌ INVALID MATERIAL:", normalizedMaterial);

    throw new Error(`Material ${normalizedMaterial} does not exist in DB`);
  }

  const order = await db.createOrderDraft(client.id);
  console.log("ORDER ID:", order.id);

  const check = await db.pool.query("SELECT id FROM orders WHERE id = $1", [
    order.id,
  ]);

  console.log("FOUND IN DB:", check.rows);
  const material = await db.getMaterialByCode(s.confirmedMaterial);

  const readyDate = await pricing.calcReadyDate({
    method_code: s.confirmedMethod,
    size_x: s.sizeX,
    size_y: s.sizeY,
    size_z: s.sizeZ,
    urgency: s.urgency,
  });

  const { total, base, urgencyFee } = await pricing.calcTotal(
    { delivery_type: s.deliveryType, urgency: s.urgency, quantity: s.quantity },
    material,
    s.volumeCm3, // объём из STL-анализа если есть
  );

  await db.updateOrder(order.order_number, {
    method_code: s.confirmedMethod,
    material_code: normalizedMaterial,
    client_material_wish: s.clientMaterialWish,
    material_overridden: s.materialOverridden,
    size_x: s.sizeX,
    size_y: s.sizeY,
    size_z: s.sizeZ,
    volume_cm3: s.volumeCm3,
    quantity: s.quantity,
    is_batch: s.quantity > 10,
    file_url: s.fileId ? `tg_file:${s.fileId}` : null,
    photo_url: s.photoId,
    use_description: s.useDescription,
    urgency: s.urgency,
    delivery_type: s.deliveryType,
    base_price: base,
    urgency_fee: urgencyFee,
    delivery_fee: 0,
    total_price: total,
    ready_date: readyDate,
  });

  return db.getOrderByNumber(order.order_number);
}

async function saveUserMessage(msg, client, s) {
  const type = msg?.document ? "FILE" : msg?.photo ? "PHOTO" : "TEXT";
  const fileId =
    msg?.document?.file_id ||
    (msg?.photo ? msg.photo[msg.photo.length - 1].file_id : null);
  await db.saveDialogMessage({
    clientId: client.id,
    orderId: Number.isInteger(s.orderId) && s.orderId > 0 ? s.orderId : null,
    orderNumber: s.orderNumber,
    sessionId: s.id,
    role: "USER",
    messageType: type,
    messageText: msg?.text || null,
    fileId,
    dialogStep: s.currentStep,
    telegramMsgId: msg?.message_id,
  });
}

// ─── Парсеры ─────────────────────────────────────────────────────────────

function extractMaterial(text) {
  if (typeof text !== "string" || !text.trim()) return null;

  const t = text.toUpperCase().replace(/[^A-ZА-Я0-9_]/g, " ");

  // ── ФОТОПОЛИМЕР / RESIN ──
  if (
    t.includes("ФОТОПОЛИМЕР") ||
    t.includes("PHOTOPOLYMER") ||
    t.includes("UV RESIN") ||
    t.includes("UV") ||
    t.includes("SLA") ||
    t.includes("LCD")
  ) {
    return "RESIN_STD";
  }
  
  // ── СМОЛА (разговорное) ──
  if (t.includes("СМОЛ") || t.includes("RESIN")) {
    return "RESIN_STD";
  }

  if (t.includes("FLEX")) return "RESIN_FLEX";
  if (t.includes("PEEK")) return "PEEK";
  if (t.includes("PETG")) return "PETG";
  if (t.includes("ABS")) return "ABS";
  if (t.includes("TPU")) return "TPU";

  if (t.includes("NYLON") || t.includes("НЕЙЛОН") || t.includes("PA"))
    return "NYLON";

  if (t.includes("SILK") || t.includes("ШЕЛК")) return "SILK";

  if (t.includes("SBS")) return "SBS";
  if (t.includes("PC") || t.includes("ПОЛИКАРБ")) return "PC";

  if (t.includes("PLA") || t.includes("ПЛА")) return "PLA";

  return null;
}

function parseDimensions(text) {
  if (!text) return null;
  try {
    const parts = text
      .trim()
      .replace(/[xXхХ×*]/g, " ")
      .split(/\s+/)
      .filter(Boolean);
    if (parts.length >= 3) {
      const nums = parts.slice(0, 3).map((p) => parseInt(p.replace(/\D/g, "")));
      if (nums.every((n) => !isNaN(n) && n > 0)) return nums;
    }
  } catch {}
  return null;
}

function normalizeMaterial(input) {
  if (!input) return null;

  if (typeof input === "object") {
    input = input.CODE || input.code;
  }

  if (!input || typeof input !== "string") return null;

  const map = {
    RESIN: "RESIN_STD",
    RESINSTD: "RESIN_STD",
    RESINFLEX: "RESIN_FLEX",
    FLEX: "RESIN_FLEX",
    PA: "NYLON",
    PET: "PETG",
  };

  const cleaned = String(input).toUpperCase().trim();

  return map[cleaned] || cleaned;
}

function parseNumber(text) {
  if (!text) return null;
  const n = parseInt(text.trim().replace(/\D/g, ""));
  return isNaN(n) ? null : n;
}

function parseUrgency(text) {
  if (!text) return "STANDARD";
  if (text.includes("800") || text === "urgency_800") return "PLUS800";
  if (text.includes("500") || text === "urgency_500") return "PLUS500";
  if (text.includes("200") || text === "urgency_200") return "PLUS200";
  return "STANDARD";
}

// ─── Хелперы для клавиатур ────────────────────────────────────────────────

// Принимает массив пар [text, callback] и опциональный доп.ряд
function btn(rows, extra = null) {
  const keyboard = rows.map(([text, cb]) => [
    { text: String(text), callback_data: String(cb) },
  ]);
  if (extra) {
    if (Array.isArray(extra.inline_keyboard)) {
      extra.inline_keyboard.forEach((row) => keyboard.push(row));
    }
  }
  return { reply_markup: { inline_keyboard: keyboard } };
}

// Приблизительная плотность материала (г/см³) для расчёта веса
function getMaterialDensity(materialCode) {
  const densities = {
    PLA: 1.24,
    PETG: 1.27,
    ABS: 1.05,
    TPU: 1.21,
    NYLON: 1.14,
    PC: 1.2,
    PEEK: 1.32,
    SBS: 1.01,
    SILK: 1.24,
    RESIN_STD: 1.1,
    RESIN_FLEX: 1.08,
  };
  if (!materialCode) return 1.24;
  const code = materialCode.toUpperCase();
  return densities[code] || 1.24;
}

function escapeMarkdown(text) {
  if (text === null || text === undefined) return "";
  return String(text).replace(/([_*`\[\]\(\)])/g, "\\$1");
}

function cancelRow() {
  return [
    [{ text: "❌ Отменить заказ", callback_data: "cmd_cancel" }],
    [
      {
        text: "💬 Связаться со специалистом",
        callback_data: "action_specialist",
      },
    ],
  ];
}

module.exports = {
  handle,
  handleStart,
  handleTransferToSpecialist,
  handleStatus,
  handleCancel,
};
