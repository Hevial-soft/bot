// Аналог DialogManager.java — центральная машина состояний диалога

const STEPS       = require('../steps');
const session     = require('../../middleware/session');
const db          = require('../../db');
const ai          = require('../../services/ai');
const pricing     = require('../handlers/pricing');
const notify      = require('../handlers/notification');

// ── Главная точка входа ───────────────────────────────────────────────────

async function handle(ctx) {
  try {
    const userId = ctx.from.id;
    const chatId = ctx.chat.id;
    const msg    = ctx.message;

    // Получить или создать клиента в БД
    const client = await db.getOrCreateClient(ctx.from);

    // Проверить блокировку
    if (client.is_blocked) {
      return ctx.reply('Ваш аккаунт заблокирован. Обратитесь в поддержку.');
    }

    // Глобальные команды — работают из любого состояния
    const text = msg?.text?.trim() || '';
    if (text === '/start')      return handleStart(ctx, client);
    if (text === '/specialist') return handleTransferToSpecialist(ctx, client);
    if (text === '/status')     return handleStatus(ctx, client);
    if (text === '/help')       return handleHelp(ctx);

    // Получить сессию
    const s = session.getOrCreate(userId, chatId);
    console.log(`[Handle] Пользователь ${userId}, текущий шаг: ${s.currentStep}, сообщение: "${text.substring(0, 30)}..."`);

    // Сохранить сообщение пользователя в историю
    await saveUserMessage(msg, client, s);

    // Маршрутизация по текущему шагу
    switch (s.currentStep) {
      case STEPS.START:
        await handleStart(ctx, client); break;
      case STEPS.AWAITING_FILE:
        await handleAwaitingFile(ctx, msg, s, client); break;
      case STEPS.AWAITING_LINK:
        await handleAwaitingLink(ctx, msg, s, client); break;
      case STEPS.AWAITING_USE_CASE:
        await handleUseCase(ctx, msg, s, client); break;
      case STEPS.MATERIAL_SUGGESTION:
        await handleMaterialSuggestion(ctx, msg, s, client); break;
      case STEPS.MATERIAL_CLIENT_CHOICE:
        await handleMaterialClientChoice(ctx, msg, s, client); break;
      case STEPS.MATERIAL_CHECK:
        await checkMaterialCompatibility(ctx, s, s.clientMaterialWish); break;
      case STEPS.MATERIAL_CONFLICT_RESOLVE:
        await handleMaterialConflict(ctx, msg, s, client); break;
      case STEPS.METHOD_WARNING:
        await handleMethodWarning(ctx, msg, s, client); break;
      case STEPS.AWAITING_SIZE:
        await handleSize(ctx, msg, s, client); break;
      case STEPS.AWAITING_QUANTITY:
        await handleQuantity(ctx, msg, s, client); break;
      case STEPS.AWAITING_URGENCY:
        await handleUrgency(ctx, msg, s, client); break;
      case STEPS.AWAITING_DELIVERY:
        await handleDelivery(ctx, msg, s, client); break;
      case STEPS.ORDER_SUMMARY:
        await handleOrderSummary(ctx, msg, s, client); break;
      case STEPS.AWAITING_REVIEW:
        await handleReview(ctx, msg, s, client); break;
      case STEPS.WAITING_SPECIALIST:
        await handleWaitingSpecialist(ctx, msg, s, client); break;
      default:
        console.warn(`[Dialog] Неизвестный шаг: ${s.currentStep}`);
        await ctx.reply('Введите /start чтобы начать.');
    }

    console.log(`[Handle] После обработки шаг ${s.currentStep}`);
    session.save(userId, s);
  } catch (err) {
    console.error('[Dialog] Handle error:', err.message, err.stack);
    try {
      await ctx.reply('Что-то пошло не так 😔 Попробуйте /start');
    } catch (replyErr) {
      console.error('[Dialog] Failed to send error reply:', replyErr.message);
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// ШАГ 1 — СТАРТ
// ═══════════════════════════════════════════════════════════════════════════

async function handleStart(ctx, client) {
  const s = session.reset(ctx.from.id, ctx.chat.id);
  session.nextStep(s, STEPS.AWAITING_FILE);
  session.save(ctx.from.id, s);

  return ctx.reply(
    `👋 Привет, ${client.first_name}!\n\n` +
    `Я бот *Hevial* — 3D-печать под ваш запрос.\n` +
    `Не нужно разбираться в материалах — просто опишите задачу.\n\n` +
    `Что хотите сделать?`,
    {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: [
        [{ text: '🖨 Оформить заказ',           callback_data: 'action_order' }],
        [{ text: '🔗 Заказ по ссылке на модель', callback_data: 'action_link'  }],
        [{ text: '💬 Связаться со специалистом', callback_data: 'action_specialist' }],
      ]}
    }
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// ШАГ 2 — ФАЙЛ / ССЫЛКА / ФОТО
// ═══════════════════════════════════════════════════════════════════════════

async function handleAwaitingFile(ctx, msg, s, client) {
  const text = msg?.text?.trim() || '';
  console.log(`[HandleAwaitingFile] Получено сообщение: "${text}"`, { hasDocument: !!msg?.document, hasPhoto: !!msg?.photo });

  if (text.includes('специалист') || text === 'action_specialist')
    return handleTransferToSpecialist(ctx, client);

  if (text.includes('ссылк') || text === 'action_link') {
    console.log('[HandleAwaitingFile] Переход на AWAITING_LINK');
    session.nextStep(s, STEPS.AWAITING_LINK);
    return ctx.reply('🔗 Пришлите ссылку на модель (Thingiverse, Cults3D и др.):');
  }

  if (text.includes('опишу') || text === 'file_none') {
    console.log('[HandleAwaitingFile] Выбран способ описания, переход на AWAITING_USE_CASE');
    session.nextStep(s, STEPS.AWAITING_USE_CASE);
    return askUseCase(ctx);
  }

  if (text === 'file_upload' || text === 'file_photo') {
    console.log('[HandleAwaitingFile] Ожидание загрузки файла/фото...');
    session.nextStep(s, STEPS.AWAITING_FILE);
    const helpMsg = text === 'file_photo' 
      ? 'Загрузите фото детали (можно несколько) и напишите размеры.'
      : 'Загрузите файл модели (STL, STEP и т.д.)';
    return ctx.reply(helpMsg);
  }

  if (text === 'action_order' || text === 'order') {
    console.log('[HandleAwaitingFile] Повторный запрос файла для заказа');
    session.nextStep(s, STEPS.AWAITING_FILE);
    return ctx.reply('У вас есть файл модели или фото детали?', {
      reply_markup: { inline_keyboard: [
        [{ text: '📎 Загрузить файл',         callback_data: 'file_upload' }],
        [{ text: '📷 Только фото + размеры',   callback_data: 'file_photo'  }],
        [{ text: '❓ Ничего нет, опишу задачу', callback_data: 'file_none'  }],
      ]}
    });
  }

  if (msg?.document) {
    console.log('[HandleAwaitingFile] Файл получен, переход на AWAITING_USE_CASE');
    s.fileUrl = 'tg_file:' + msg.document.file_id;
    session.nextStep(s, STEPS.AWAITING_USE_CASE);
    console.log(`[HandleAwaitingFile] Новый шаг установлен: ${s.currentStep}`);
    return askUseCase(ctx);
  }

  if (msg?.photo) {
    s.photoFileId = msg.photo[msg.photo.length - 1].file_id;
    session.nextStep(s, STEPS.AWAITING_USE_CASE);
    return askUseCase(ctx);
  }

  session.nextStep(s, STEPS.AWAITING_FILE);
  return ctx.reply('У вас есть файл модели или фото детали?', {
    reply_markup: { inline_keyboard: [
      [{ text: '📎 Загрузить файл',         callback_data: 'file_upload' }],
      [{ text: '📷 Только фото + размеры',   callback_data: 'file_photo'  }],
      [{ text: '❓ Ничего нет, опишу задачу', callback_data: 'file_none'  }],
    ]}
  });
}

async function handleAwaitingLink(ctx, msg, s, client) {
  const text = msg?.text?.trim() || '';
  if (text.startsWith('http')) {
    s.fileUrl = text;
    session.nextStep(s, STEPS.AWAITING_USE_CASE);
    return askUseCase(ctx);
  }
  session.incrementRetry(s);
  if (session.isRetryLimitReached(s)) return handleTransferToSpecialist(ctx, client);
  return ctx.reply('Пожалуйста, пришлите полную ссылку (начинается с https://...)');
}

// ═══════════════════════════════════════════════════════════════════════════
// ШАГ 3 — ОПИСАНИЕ ИСПОЛЬЗОВАНИЯ
// ═══════════════════════════════════════════════════════════════════════════

async function handleUseCase(ctx, msg, s, client) {
  const text = msg?.text?.trim() || '';
  console.log(`[HandleUseCase] Описание использования: "${text.substring(0, 50)}..."`);
  
  if (text.length < 5) {
    console.log('[HandleUseCase] Описание слишком короткое');
    session.incrementRetry(s);
    return ctx.reply('Расскажите подробнее — где будет использоваться деталь? (среда, нагрузки, температура)');
  }

  s.useDescription = text;

  // Клиент уже назвал материал?
  const named = extractMaterial(text);
  if (named) {
    console.log(`[HandleUseCase] Распознан материал: ${named}`);
    s.clientMaterialWish = named;
    session.nextStep(s, STEPS.MATERIAL_CHECK);
    return askMaterialChoice(ctx, named);
  }

  // ИИ подбирает
  console.log('[HandleUseCase] Запрос материалов из БД и вызов AI...');
  const materials  = await db.getAllMaterials();
  const suggested  = await ai.suggestMaterial(text, materials);
  const material    = materials.find(m => m.code === suggested);
  s.suggestedMaterial = suggested;
  console.log(`[HandleUseCase] AI выбрал: ${suggested}`);
  session.nextStep(s, STEPS.MATERIAL_SUGGESTION);

  const suggestionText = ai.formatSuggestion(suggested, material);
  return ctx.reply(suggestionText, { parse_mode: 'Markdown' });
}

// ═══════════════════════════════════════════════════════════════════════════
// ШАГ 4 — ПОДБОР МАТЕРИАЛА
// ═══════════════════════════════════════════════════════════════════════════

async function handleMaterialSuggestion(ctx, msg, s, client) {
  const text = msg?.text?.trim() || '';
  console.log(`[MaterialSuggestion] Входящий текст: "${text}"`);
  console.log(`[MaterialSuggestion] Suggested material: ${s.suggestedMaterial}`);

  if (text === 'mat_agree' || text.includes('✅') || text.includes('mat_agree') || text.toLowerCase().includes('согла')) {
    console.log('[MaterialSuggestion] Пользователь согласился с материалом');
    s.confirmedMaterial = s.suggestedMaterial;
    return proceedToMethodWarning(ctx, s);
  }

  if (text === 'mat_alternatives' || text.includes('🔄') || text.includes('mat_alternatives')) {
    console.log('[MaterialSuggestion] Пользователь запросил альтернативы');
    const materials    = await db.getAllMaterials();
    const alternatives = materials
      .filter(m => m.code !== s.suggestedMaterial)
      .slice(0, 3);
    const altText = '🔄 *Альтернативные варианты:*\n\n' +
      alternatives.map(m =>
        `• *${m.display_name}*\n  Применение: ${m.use_cases.slice(0,2).join(', ')}`
      ).join('\n\n');
    return ctx.reply(altText, {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: [
        [{ text: '✅ Подходит',               callback_data: 'mat_agree'   }],
        [{ text: '✏️ Хочу конкретный',        callback_data: 'mat_own'     }],
        [{ text: '💬 Позвать специалиста',    callback_data: 'action_specialist' }],
      ]}
    });
  }

  if (text === 'mat_own' || text.includes('✏️') || text.includes('mat_own')) {
    console.log('[MaterialSuggestion] Пользователь хочет выбрать сам');
    session.nextStep(s, STEPS.MATERIAL_CLIENT_CHOICE);
    return ctx.reply('Напишите какой материал хотите (например: PLA, PETG, фотополимер):');
  }

  if (text === 'action_specialist' || text.includes('специалист')) {
    console.log('[MaterialSuggestion] Пользователь запросил специалиста из альтернатив');
    return handleTransferToSpecialist(ctx, client);
  }

  console.log(`[MaterialSuggestion] Не распознан callback, повтор ${s.retryCount}`);
  session.incrementRetry(s);
  return ctx.reply('Пожалуйста, выберите один из вариантов:', {
    reply_markup: { inline_keyboard: [
      [{ text: '✅ Согласен',         callback_data: 'mat_agree'        }],
      [{ text: '🔄 Другие варианты', callback_data: 'mat_alternatives' }],
      [{ text: '✏️ Свой выбор',      callback_data: 'mat_own'          }],
    ]}
  });
}

async function handleMaterialClientChoice(ctx, msg, s, client) {
  const text     = msg?.text?.trim() || '';
  console.log(`[MaterialClientChoice] Входящий текст: "${text}"`);
  
  const material = extractMaterial(text);
  if (!material) {
    console.log('[MaterialClientChoice] Материал не распознан');
    session.incrementRetry(s);
    if (session.isRetryLimitReached(s)) return handleTransferToSpecialist(ctx, client);
    return ctx.reply('Не распознал материал. Напишите: PLA, PETG, ABS, TPU, PEEK, нейлон, фотополимер');
  }
  console.log(`[MaterialClientChoice] Распознан материал: ${material}`);
  s.clientMaterialWish = material;
  session.nextStep(s, STEPS.MATERIAL_CHECK);
  return checkMaterialCompatibility(ctx, s, material);
}

async function checkMaterialCompatibility(ctx, s, materialCode) {
  const material = await db.getMaterialByCode(materialCode);

  if (!material) {
    session.nextStep(s, STEPS.MATERIAL_CLIENT_CHOICE);
    return ctx.reply(
      `Материал *${materialCode}* не найден. Доступные: PLA, PETG, ABS, TPU, PEEK, Nylon, PC, SBS, Silk, Resin.`,
      { parse_mode: 'Markdown' }
    );
  }

  const { compatible, conflicts } = ai.checkCompatibility(material, s.useDescription || '');

  if (!compatible) {
    session.nextStep(s, STEPS.MATERIAL_CONFLICT_RESOLVE);
    const recommended = s.suggestedMaterial || 'PETG';
    return ctx.reply(
      `⚠️ *Внимание!*\n\nВы выбрали *${material.display_name}*, но он может не подойти:\n— ${conflicts.join('\n— ')}\n\nРекомендую *${recommended}* для ваших условий.\n\nКак поступим?`,
      {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: [
          [{ text: `🔄 Принять рекомендацию`,           callback_data: 'conflict_accept' }],
          [{ text: `✅ Оставить ${materialCode}`,        callback_data: 'conflict_keep'   }],
        ]}
      }
    );
  }

  s.confirmedMaterial = materialCode;
  return proceedToMethodWarning(ctx, s);
}

async function handleMaterialConflict(ctx, msg, s, client) {
  const text = msg?.text?.trim() || '';
  console.log(`[MaterialConflict] Входящий текст: "${text}"`);
  
  if (text.includes('🔄') || text === 'conflict_accept') {
    console.log('[MaterialConflict] Пользователь согласился с рекомендацией');
    s.confirmedMaterial = s.suggestedMaterial || 'PETG';
    s.materialOverridden = false;
  } else {
    console.log('[MaterialConflict] Пользователь оставил свой выбор');
    s.confirmedMaterial  = s.clientMaterialWish;
    s.materialOverridden = true;
  }
  return proceedToMethodWarning(ctx, s);
}

// ═══════════════════════════════════════════════════════════════════════════
// ШАГ 5 — ПРЕДУПРЕЖДЕНИЕ О МЕТОДЕ
// ═══════════════════════════════════════════════════════════════════════════

async function proceedToMethodWarning(ctx, s) {
  const method  = s.confirmedMaterial?.startsWith('RESIN') ? 'RESIN' : 'FDM';
  s.confirmedMethod = method;

  const material = await db.getMaterialByCode(s.confirmedMaterial);
  const warning  = material?.surface_note || '';

  let text;
  if (method === 'RESIN') {
    text = `✅ Материал: *${material?.display_name || s.confirmedMaterial}* (фотополимер)\n\nℹ️ ${warning}\n⏱ Срок — *5 дней*\n\nПродолжаем?`;
  } else {
    text = `✅ Материал: *${material?.display_name || s.confirmedMaterial}* (FDM)\n\nℹ️ ${warning}\nЕсли нужна идеальная гладкость — только фотополимер.\n\nПродолжаем?`;
  }

  session.nextStep(s, STEPS.METHOD_WARNING);
  return ctx.reply(text, {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: [
      [{ text: '✅ Понятно, продолжаем', callback_data: 'method_ok'     }],
      [{ text: '🔄 Изменить материал',  callback_data: 'method_change' }],
    ]}
  });
}

async function handleMethodWarning(ctx, msg, s, client) {
  const text = msg?.text?.trim() || '';
  console.log(`[MethodWarning] Входящий текст: "${text}"`);
  
  if (text.includes('🔄') || text === 'method_change') {
    console.log('[MethodWarning] Пользователь хочет изменить материал');
    session.nextStep(s, STEPS.MATERIAL_CLIENT_CHOICE);
    return ctx.reply('Напишите какой материал хотите использовать:');
  }
  
  console.log('[MethodWarning] Переход на размеры');
  session.nextStep(s, STEPS.AWAITING_SIZE);
  return ctx.reply(
    '📐 Укажите размеры детали в мм:\nФормат: *Длина Ширина Высота*\nНапример: `50 30 20`\n\nИли загрузите STL/STEP файл.',
    { parse_mode: 'Markdown' }
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// ШАГ 6 — РАЗМЕРЫ
// ═══════════════════════════════════════════════════════════════════════════

async function handleSize(ctx, msg, s, client) {
  if (msg?.document) {
    s.fileUrl = 'tg_file:' + msg.document.file_id;
    session.nextStep(s, STEPS.AWAITING_QUANTITY);
    return ctx.reply('📁 Файл получен! Размеры рассчитаем из него.\n\nСколько штук нужно напечатать?');
  }

  const text = msg?.text?.trim() || '';
  const dims = parseDimensions(text);

  if (!dims) {
    session.incrementRetry(s);
    if (session.isRetryLimitReached(s)) return handleTransferToSpecialist(ctx, client);
    return ctx.reply('Не смог распознать размеры. Напишите три числа: `50 30 20`', { parse_mode: 'Markdown' });
  }

  s.sizeX = dims[0]; s.sizeY = dims[1]; s.sizeZ = dims[2];

  const maxAllowed = s.confirmedMethod === 'RESIN' ? 218 : 250;
  const maxDim     = session.getMaxDimension(s);

  if (maxDim > maxAllowed) {
    return ctx.reply(
      `⚠️ Деталь *${maxDim} мм* превышает рабочую зону ${s.confirmedMethod} (${maxAllowed} мм).\n\nДля таких размеров нужен расчёт специалиста.`,
      {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: [
          [{ text: '💬 Связаться со специалистом', callback_data: 'action_specialist' }],
          [{ text: '✏️ Ввести другие размеры',     callback_data: 'size_retry'        }],
        ]}
      }
    );
  }

  session.nextStep(s, STEPS.AWAITING_QUANTITY);
  return ctx.reply('Сколько штук нужно напечатать?');
}

// ═══════════════════════════════════════════════════════════════════════════
// ШАГ 7 — КОЛИЧЕСТВО
// ═══════════════════════════════════════════════════════════════════════════

async function handleQuantity(ctx, msg, s, client) {
  const qty = parseNumber(msg?.text);
  if (!qty || qty < 1) {
    session.incrementRetry(s);
    return ctx.reply('Введите количество цифрой, например: 2');
  }

  s.quantity = qty;

  if (qty > 10) {
    s.isBatch = true;
    return ctx.reply(
      `📦 Партия *${qty} шт* — рассчитываем индивидуально.\nПодключить специалиста?`,
      {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: [
          [{ text: '✅ Да, соедините со специалистом', callback_data: 'action_specialist' }],
          [{ text: '📝 Продолжить без расчёта',        callback_data: 'qty_continue'      }],
        ]}
      }
    );
  }

  session.nextStep(s, STEPS.AWAITING_URGENCY);
  return buildUrgencyMessage(ctx, s);
}

// ═══════════════════════════════════════════════════════════════════════════
// ШАГ 8 — СРОЧНОСТЬ
// ═══════════════════════════════════════════════════════════════════════════

async function handleUrgency(ctx, msg, s, client) {
  const text = msg?.text?.trim() || '';
  s.urgency  = parseUrgency(text);
  session.nextStep(s, STEPS.AWAITING_DELIVERY);

  return ctx.reply('🚚 Как хотите получить заказ?', {
    reply_markup: { inline_keyboard: [
      [{ text: '🚗 Курьер по Москве (бесплатно)', callback_data: 'delivery_courier' }],
      [{ text: '📦 СДЭК (рассчитаем отдельно)',   callback_data: 'delivery_sdek'    }],
      [{ text: '🤝 Самовывоз',                    callback_data: 'delivery_pickup'  }],
    ]}
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// ШАГ 9 — ДОСТАВКА + СОЗДАНИЕ ЗАКАЗА
// ═══════════════════════════════════════════════════════════════════════════

async function handleDelivery(ctx, msg, s, client) {
  const text = msg?.text?.trim() || '';
  let deliveryNote = '';

  if (text.includes('Курьер') || text === 'delivery_courier') {
    s.deliveryType = 'COURIER';
  } else if (text.includes('СДЭК') || text === 'delivery_sdek') {
    s.deliveryType = 'SDEK';
    deliveryNote   = '\n📦 Стоимость СДЭК рассчитаем отдельно после оформления.';
  } else if (text.includes('Самовывоз') || text === 'delivery_pickup') {
    s.deliveryType = 'PICKUP';
    deliveryNote   = '\n🤝 Место встречи согласуем в чате.';
  } else {
    return ctx.reply('Выберите способ получения заказа:', {
      reply_markup: { inline_keyboard: [
        [{ text: '🚗 Курьер по Москве (бесплатно)', callback_data: 'delivery_courier' }],
        [{ text: '📦 СДЭК',                         callback_data: 'delivery_sdek'    }],
        [{ text: '🤝 Самовывоз',                    callback_data: 'delivery_pickup'  }],
      ]}
    });
  }

  // Создаём заказ в БД
  const order = await buildAndSaveOrder(s, client);
  s.orderId     = order.id;
  s.orderNumber = order.order_number;

  // Привязываем диалог к заказу
  await db.linkSessionToOrder(s.sessionId, order.id, order.order_number);

  session.nextStep(s, STEPS.ORDER_SUMMARY);
  return buildOrderSummary(ctx, order, deliveryNote);
}

// ═══════════════════════════════════════════════════════════════════════════
// ШАГ 10 — ИТОГ И ПОДТВЕРЖДЕНИЕ
// ═══════════════════════════════════════════════════════════════════════════

async function handleOrderSummary(ctx, msg, s, client) {
  const text = msg?.text?.trim() || '';

  if (text.includes('✅') || text === 'order_confirm') {
    const order = await db.confirmOrder(s.orderNumber);
    await db.saveDialogMessage({
      clientId: client.id, orderId: order.id,
      orderNumber: order.order_number, sessionId: s.sessionId,
      role: 'SYSTEM', messageType: 'SYSTEM_EVENT',
      messageText: 'Создан заказ ' + order.order_number,
      dialogStep: STEPS.ORDER_CONFIRMED,
    });

    // Уведомить специалиста
    await notify.notifyNewOrder(order, client);

    session.nextStep(s, STEPS.ORDER_CONFIRMED);
    return ctx.reply(
      `✅ *Заказ ${order.order_number} принят!*\n\nМы проверим детали и подтвердим в ближайшее время.\nСпециалист напишет вам в рабочее время.\n\n/status — узнать статус\n/specialist — позвать специалиста`,
      { parse_mode: 'Markdown', reply_markup: { remove_keyboard: true } }
    );
  }

  if (text.includes('✏️') || text === 'order_edit') {
    session.nextStep(s, STEPS.AWAITING_USE_CASE);
    return askUseCase(ctx);
  }

  if (text.includes('❌') || text === 'order_cancel') {
    session.nextStep(s, STEPS.CANCELLED);
    return ctx.reply('Заказ отменён. Напишите /start чтобы начать заново.',
      { reply_markup: { remove_keyboard: true } });
  }

  return ctx.reply('Подтвердите или отмените заказ:', {
    reply_markup: { inline_keyboard: [
      [{ text: '✅ Подтвердить заказ', callback_data: 'order_confirm' }],
      [{ text: '✏️ Изменить',         callback_data: 'order_edit'    }],
      [{ text: '❌ Отменить',          callback_data: 'order_cancel'  }],
    ]}
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// ШАГ 11 — ОТЗЫВ
// ═══════════════════════════════════════════════════════════════════════════

async function handleReview(ctx, msg, s, client) {
  const text = msg?.text?.trim() || '';

  if (text === 'skip_review' || text.includes('Пропустить')) {
    if (s.orderNumber) await db.markReviewSent(s.orderNumber);
    session.nextStep(s, STEPS.CANCELLED);
    return ctx.reply('Спасибо! Обращайтесь снова 🙏', { reply_markup: { remove_keyboard: true } });
  }

  if (text.length > 5) {
    if (s.orderNumber) await db.saveReview(s.orderNumber, text, null);
    session.nextStep(s, STEPS.CANCELLED);
    return ctx.reply('Спасибо за отзыв! Это помогает нам становиться лучше 🙏',
      { reply_markup: { remove_keyboard: true } });
  }

  return ctx.reply('Оставьте отзыв или пропустите:', {
    reply_markup: { inline_keyboard: [
      [{ text: '⭐ Оставить отзыв', callback_data: 'review_write' }],
      [{ text: '➡️ Пропустить',    callback_data: 'skip_review'  }],
    ]}
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// СПЕЦИАЛИСТ
// ═══════════════════════════════════════════════════════════════════════════

async function handleTransferToSpecialist(ctx, client) {
  const s = session.getOrCreate(ctx.from.id, ctx.chat.id);
  session.nextStep(s, STEPS.WAITING_SPECIALIST);
  s.awaitingSpecialist = true;
  session.save(ctx.from.id, s);

  // Открыть мост специалист ↔ клиент
  const specialistId = notify.getSpecialistChatId();
  if (specialistId) {
    notify.openBridge(s.orderNumber || 'no-order', specialistId, ctx.chat.id);

    await ctx.reply(
      '💬 *Соединяю вас со специалистом.*\n\nОпишите вашу задачу — специалист ответит в рабочее время (пн–пт 10:00–19:00 МСК).',
      { parse_mode: 'Markdown', reply_markup: { remove_keyboard: true } }
    );

    // Уведомить специалиста
    try {
      await ctx.telegram.sendMessage(specialistId,
        `💬 *Клиент ${client.first_name} запросил специалиста*\n` +
        (s.orderNumber ? `Заказ: ${s.orderNumber}\n` : '') +
        `ID: ${ctx.from.id}`,
        {
          parse_mode: 'Markdown',
          reply_markup: { inline_keyboard: [
            [{ text: '💬 Начать диалог', callback_data: `bridge_open_${ctx.chat.id}` }],
          ]}
        }
      );
    } catch(e) { console.error('Specialist notify error:', e.message); }
  } else {
    await ctx.reply(
      '💬 Соединяю вас со специалистом.\n\nОпишите задачу — ответим в рабочее время (пн–пт 10:00–19:00 МСК).',
      { reply_markup: { remove_keyboard: true } }
    );
  }
}

async function handleWaitingSpecialist(ctx, msg, s, client) {
  // Пересылаем сообщение специалисту через мост
  const text     = msg?.text || null;
  const fileId   = msg?.document?.file_id || (msg?.photo ? msg.photo[msg.photo.length-1].file_id : null);
  const msgType  = msg?.document ? 'FILE' : msg?.photo ? 'PHOTO' : 'TEXT';

  const forwarded = await notify.forwardThroughBridge(ctx.chat.id, text, fileId, msgType);

  if (!forwarded) {
    return ctx.reply('✉️ Сообщение получено. Специалист ответит в рабочее время. Можете продолжать писать.');
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// КОМАНДЫ
// ═══════════════════════════════════════════════════════════════════════════

async function handleStatus(ctx, client) {
  const order = await db.getActiveOrderByTelegramId(ctx.from.id);
  if (!order) {
    return ctx.reply('У вас нет активных заказов.\n/start — создать новый');
  }

  const statusLabels = {
    NEW: '⏳ Новый', PROCESSING: '🔄 В обработке',
    ACCEPTED: '✅ Принят', PAID: '💳 Оплачен',
    IN_PROGRESS: '🖨 Печатается', READY: '📦 Готов',
    DELIVERED: '🚗 Выдан', CLOSED: '✔️ Закрыт',
  };

  return ctx.reply(
    `📋 *Заказ ${order.order_number}*\nСтатус: *${statusLabels[order.status] || order.status}*\nСоздан: ${order.created_at?.toISOString?.().split('T')[0]}\nГотовность: ${order.ready_date || 'уточняется'}`,
    { parse_mode: 'Markdown' }
  );
}

async function handleHelp(ctx) {
  return ctx.reply(
    `📖 *Помощь Hevial*\n\n` +
    `/start — начать оформление заказа\n` +
    `/status — статус текущего заказа\n` +
    `/specialist — связаться со специалистом\n` +
    `/help — это сообщение\n\n` +
    `*Способы передачи файла:*\n` +
    `— Загрузить STL/STEP прямо в чат\n` +
    `— Прислать ссылку на Thingiverse/Cults3D\n` +
    `— Прислать фото детали с размерами`,
    { parse_mode: 'Markdown' }
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ
// ═══════════════════════════════════════════════════════════════════════════

function askUseCase(ctx) {
  return ctx.reply(
    'Отлично! Расскажите где и как будет использоваться деталь?\n\n' +
    'Например: *на улице, крепёж велосипеда* или *гибкий чехол для телефона*\n\n' +
    'Чем подробнее — тем точнее подберём материал 🎯',
    { parse_mode: 'Markdown' }
  );
}

function askMaterialChoice(ctx, material) {
  return ctx.reply(
    `Вы упомянули *${material}*. Это ваш выбор или хотите рекомендацию?`,
    {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: [
        [{ text: `✅ Да, хочу ${material}`, callback_data: 'mat_keep_own' }],
        [{ text: '🤖 Подобрать под задачу', callback_data: 'mat_ai'       }],
      ]}
    }
  );
}

function buildUrgencyMessage(ctx, s) {
  const baseDays = s.confirmedMethod === 'RESIN' ? 5 : 2;
  const date     = new Date();
  date.setDate(date.getDate() + baseDays);
  const dateStr  = date.toISOString().split('T')[0];

  return ctx.reply(
    `⏱ *Срочность изготовления*\n\nОриентировочная готовность: *${dateStr}*\n\nВыберите вариант:`,
    {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: [
        [{ text: '⏱ Стандарт (без наценки)', callback_data: 'urgency_standard' }],
        [{ text: '🚀 Быстрее +200 ₽',        callback_data: 'urgency_200'      }],
        [{ text: '⚡ Срочно +500 ₽',          callback_data: 'urgency_500'      }],
        [{ text: '🔥 Максимум +800 ₽',        callback_data: 'urgency_800'      }],
      ]}
    }
  );
}

async function buildOrderSummary(ctx, order, extra = '') {
  const deliveryLabels = { COURIER: '🚗 Курьер (бесплатно)', SDEK: '📦 СДЭК', PICKUP: '🤝 Самовывоз' };
  const urgencyLabels  = { STANDARD: 'Стандарт', PLUS200: '+200 ₽', PLUS500: '+500 ₽', PLUS800: '+800 ₽' };
  const price = order.total_price ? `${order.total_price} ₽` : 'рассчитывается';

  return ctx.reply(
    `📋 *Итог заказа ${order.order_number}*\n\n` +
    `Материал: *${order.material_code}* (${order.method_code})\n` +
    `Количество: *${order.quantity} шт*\n` +
    `Срочность: *${urgencyLabels[order.urgency] || order.urgency}*\n` +
    `Доставка: *${deliveryLabels[order.delivery_type] || order.delivery_type}*\n` +
    `Готовность: *${order.ready_date || 'уточняется'}*\n` +
    `───────────────\n` +
    `💰 Стоимость: *${price}*${extra}\n\n` +
    `Подтвердить заказ?`,
    {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: [
        [{ text: '✅ Подтвердить заказ', callback_data: 'order_confirm' }],
        [{ text: '✏️ Изменить',         callback_data: 'order_edit'    }],
        [{ text: '❌ Отменить',          callback_data: 'order_cancel'  }],
      ]}
    }
  );
}

async function buildAndSaveOrder(s, client) {
  const order = await db.createOrderDraft(client.id);

  const material = await db.getMaterialByCode(s.confirmedMaterial);
  const readyDate = await pricing.calcReadyDate({
    method_code: s.confirmedMethod,
    size_x: s.sizeX, size_y: s.sizeY, size_z: s.sizeZ,
    urgency: s.urgency,
  });

  const { total, base, urgencyFee } = await pricing.calcTotal(
    { delivery_type: s.deliveryType, urgency: s.urgency, quantity: s.quantity },
    material
  );

  await db.updateOrder(order.order_number, {
    method_code:          s.confirmedMethod,
    material_code:        s.confirmedMaterial,
    client_material_wish: s.clientMaterialWish,
    material_overridden:  s.materialOverridden,
    size_x:               s.sizeX,
    size_y:               s.sizeY,
    size_z:               s.sizeZ,
    quantity:             s.quantity,
    is_batch:             s.isBatch,
    file_url:             s.fileUrl,
    photo_url:            s.photoFileId,
    use_description:      s.useDescription,
    urgency:              s.urgency,
    delivery_type:        s.deliveryType,
    base_price:           base,
    urgency_fee:          urgencyFee,
    delivery_fee:         0,
    total_price:          total,
    ready_date:           readyDate,
  });

  return db.getOrderByNumber(order.order_number);
}

// Распознать материал из текста
function extractMaterial(text) {
  if (!text) return null;
  const t = text.toUpperCase().replace(/[^A-ZА-Я0-9_]/g, ' ');
  if (t.includes('RESIN') || t.includes('ФОТО'))   return 'RESIN_STD';
  if (t.includes('FLEX'))                           return 'RESIN_FLEX';
  if (t.includes('PEEK'))                           return 'PEEK';
  if (t.includes('PETG'))                           return 'PETG';
  if (t.includes('ABS'))                            return 'ABS';
  if (t.includes('TPU'))                            return 'TPU';
  if (t.includes('NYLON') || t.includes('НЕЙЛОН')) return 'NYLON';
  if (t.includes('SILK')  || t.includes('ШЕЛК'))   return 'SILK';
  if (t.includes('SBS'))                            return 'SBS';
  if (t.includes('PC')    || t.includes('ПОЛИКАРБ'))return 'PC';
  if (t.includes('PLA')   || t.includes('ПЛА'))     return 'PLA';
  return null;
}

function parseDimensions(text) {
  if (!text) return null;
  try {
    const parts = text.trim().replace(/[xXхХ×*]/g, ' ').split(/\s+/).filter(Boolean);
    if (parts.length >= 3) {
      const nums = parts.slice(0, 3).map(p => parseInt(p.replace(/\D/g, '')));
      if (nums.every(n => !isNaN(n) && n > 0)) return nums;
    }
  } catch {}
  return null;
}

function parseNumber(text) {
  if (!text) return null;
  const n = parseInt(text.trim().replace(/\D/g, ''));
  return isNaN(n) ? null : n;
}

function parseUrgency(text) {
  if (text.includes('800') || text.includes('🔥') || text === 'urgency_800') return 'PLUS800';
  if (text.includes('500') || text.includes('⚡') || text === 'urgency_500') return 'PLUS500';
  if (text.includes('200') || text.includes('🚀') || text === 'urgency_200') return 'PLUS200';
  return 'STANDARD';
}

async function saveUserMessage(msg, client, s) {
  const type   = msg?.document ? 'FILE' : msg?.photo ? 'PHOTO' : 'TEXT';
  const fileId = msg?.document?.file_id ||
                 (msg?.photo ? msg.photo[msg.photo.length-1].file_id : null);
  await db.saveDialogMessage({
    clientId:     client.id,
    orderId:      s.orderId,
    orderNumber:  s.orderNumber,
    sessionId:    s.sessionId,
    role:         'USER',
    messageType:  type,
    messageText:  msg?.text || null,
    fileId,
    dialogStep:   s.currentStep,
    telegramMsgId: msg?.message_id,
  });
}

module.exports = { handle, handleStart, handleTransferToSpecialist, handleStatus };
