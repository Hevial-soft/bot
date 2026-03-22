// src/services/stock.js
// Учёт остатков материалов
// Списание после печати, пополнение, резервирование, уведомления

'use strict';

const db = require('../db');

// ── Пороги для уведомлений ────────────────────────────────────────────────
const STATUS_LABELS = {
  OK:  '✅ В наличии',
  LOW: '⚠️ Заканчивается',
  OUT: '❌ Нет в наличии',
};

// ═══════════════════════════════════════════════════════════════════════════
// ОСНОВНЫЕ ОПЕРАЦИИ
// ═══════════════════════════════════════════════════════════════════════════

// Списать граммы после печати
async function consumeMaterial(materialCode, grams, orderNumber, specialistId, note = '') {
  if (!grams || grams <= 0) return null;

  await db.pool.query(
    `INSERT INTO stock_transactions
       (material_code, type, amount_grams, order_number, specialist_id, note)
     VALUES ($1, 'USE', $2, $3, $4, $5)`,
    [materialCode, grams, orderNumber || null, specialistId || null, note || 'Списание после печати']
  );

  return getStockByCode(materialCode);
}

// Пополнить остаток (купили катушку)
async function addStock(materialCode, grams, specialistId, note = '') {
  await db.pool.query(
    `INSERT INTO stock_transactions
       (material_code, type, amount_grams, specialist_id, note)
     VALUES ($1, 'ADD', $2, $3, $4)`,
    [materialCode, grams, specialistId || null, note || 'Пополнение']
  );

  return getStockByCode(materialCode);
}

// Ручная корректировка (инвентаризация)
async function adjustStock(materialCode, actualGrams, specialistId, note = '') {
  const current = await getStockByCode(materialCode);
  if (!current) return null;

  const diff = actualGrams - current.stock_grams;
  if (Math.abs(diff) < 0.1) return current; // ничего не изменилось

  const adjGrams = Math.abs(diff);
  const type = diff > 0 ? 'ADD' : 'USE';

  await db.pool.query(
    `INSERT INTO stock_transactions
       (material_code, type, amount_grams, specialist_id, note)
     VALUES ($1, $2, $3, $4, $5)`,
    [materialCode, type, adjGrams, specialistId || null,
     note || `Корректировка: было ${current.stock_grams}г, стало ${actualGrams}г`]
  );

  return getStockByCode(materialCode);
}

// Зарезервировать под заказ (вызывается при подтверждении)
async function reserveMaterial(materialCode, grams, orderNumber) {
  if (!grams || grams <= 0) return null;
  await db.pool.query(
    `INSERT INTO stock_transactions
       (material_code, type, amount_grams, order_number, note)
     VALUES ($1, 'RESERVE', $2, $3, 'Резерв под заказ')`,
    [materialCode, grams, orderNumber]
  );
}

// Снять резерв (отмена заказа)
async function releaseMaterial(materialCode, grams, orderNumber) {
  if (!grams || grams <= 0) return null;
  await db.pool.query(
    `INSERT INTO stock_transactions
       (material_code, type, amount_grams, order_number, note)
     VALUES ($1, 'RELEASE', $2, $3, 'Снятие резерва (отмена)')`,
    [materialCode, grams, orderNumber]
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// ЧТЕНИЕ ДАННЫХ
// ═══════════════════════════════════════════════════════════════════════════

// Остаток по одному материалу
async function getStockByCode(materialCode) {
  const res = await db.pool.query(
    `SELECT * FROM v_stock WHERE material_code = $1`,
    [materialCode]
  );
  return res.rows[0] || null;
}

// Все остатки
async function getAllStock() {
  const res = await db.pool.query(`SELECT * FROM v_stock ORDER BY type, material_code`);
  return res.rows;
}

// Только те у которых LOW или OUT
async function getLowStockMaterials() {
  const res = await db.pool.query(
    `SELECT * FROM v_stock WHERE status IN ('LOW', 'OUT') ORDER BY available_grams ASC`
  );
  return res.rows;
}

// История транзакций по материалу
async function getTransactionHistory(materialCode, limit = 20) {
  const res = await db.pool.query(
    `SELECT t.*, s.name as specialist_name
     FROM stock_transactions t
     LEFT JOIN specialists s ON t.specialist_id = s.telegram_id
     WHERE t.material_code = $1
     ORDER BY t.created_at DESC
     LIMIT $2`,
    [materialCode, limit]
  );
  return res.rows;
}

// Проверить есть ли нужное количество (с учётом резерва)
async function hasEnoughStock(materialCode, requiredGrams) {
  const stock = await getStockByCode(materialCode);
  if (!stock) return false;
  return stock.available_grams >= requiredGrams;
}

// Найти альтернативы если материал закончился
async function findAlternatives(materialCode) {
  const material = await db.pool.query(
    `SELECT * FROM material WHERE code = $1`, [materialCode]
  );
  if (!material.rows[0]) return [];

  const mat = material.rows[0];

  // Ищем материалы того же типа с достаточным остатком
  const res = await db.pool.query(
    `SELECT m.*, ms.stock_grams, ms.available_grams
     FROM material m
     JOIN material_stock ms ON m.code = ms.material_code
     WHERE m.type = $1
       AND m.code != $2
       AND m.is_active = TRUE
       AND (ms.stock_grams - ms.reserved_grams) > 50
     ORDER BY ms.available_grams DESC
     LIMIT 3`,
    [mat.type, materialCode]
  );

  return res.rows;
}

// ═══════════════════════════════════════════════════════════════════════════
// ФОРМАТИРОВАНИЕ ДЛЯ БОТА
// ═══════════════════════════════════════════════════════════════════════════

// Форматировать полную таблицу остатков
function formatStockTable(stocks) {
  if (!stocks.length) return 'Данных об остатках нет.';

  // Группируем по типу
  const groups = { FDM: [], RESIN: [] };
  for (const s of stocks) {
    const g = s.type === 'RESIN' ? 'RESIN' : 'FDM';
    if (!groups[g]) groups[g] = [];
    groups[g].push(s);
  }

  let text = '📦 *Остатки материалов:*\n\n';

  for (const [type, items] of Object.entries(groups)) {
    if (!items.length) continue;
    text += `*── ${type} ──*\n`;
    for (const s of items) {
      const avail = parseFloat(s.available_grams);
      const bar   = stockBar(avail, s.min_threshold_g);
      const icon  = s.status === 'OUT' ? '❌' : s.status === 'LOW' ? '⚠️' : '✅';
      text += `${icon} \`${s.material_code}\` — *${Math.round(avail)}г* доступно ${bar}\n`;
      if (parseFloat(s.reserved_grams) > 0)
        text += `   _зарезервировано: ${Math.round(s.reserved_grams)}г_\n`;
    }
    text += '\n';
  }

  text += `_Обновлено: ${new Date().toLocaleString('ru-RU')}_`;
  return text;
}

// Мини-индикатор уровня
function stockBar(availGrams, threshold) {
  if (availGrams <= 0)   return '▱▱▱▱▱';
  if (availGrams < threshold * 0.5) return '▰▱▱▱▱';
  if (availGrams < threshold)       return '▰▰▱▱▱';
  if (availGrams < threshold * 2)   return '▰▰▰▱▱';
  if (availGrams < threshold * 4)   return '▰▰▰▰▱';
  return '▰▰▰▰▰';
}

// Форматировать одну строку для быстрого отчёта
function formatSingleStock(s) {
  const avail = Math.round(parseFloat(s.available_grams));
  const total = Math.round(parseFloat(s.stock_grams));
  const resv  = Math.round(parseFloat(s.reserved_grams));
  const icon  = s.status === 'OUT' ? '❌' : s.status === 'LOW' ? '⚠️' : '✅';

  let text = `${icon} *${s.display_name}* (\`${s.material_code}\`)\n`;
  text += `   Доступно: *${avail}г*`;
  if (resv > 0) text += ` (всего ${total}г, резерв ${resv}г)`;
  text += `\n   Статус: ${STATUS_LABELS[s.status]}`;
  return text;
}

// ═══════════════════════════════════════════════════════════════════════════
// ИНТЕГРАЦИЯ С ПОДБОРОМ МАТЕРИАЛА
// Вызывается из ai.js перед тем как предлагать материал клиенту
// ═══════════════════════════════════════════════════════════════════════════

// Проверить материал перед предложением клиенту
// Возвращает: { available: true/false, alternativeCode: null/'PETG', reason: '' }
async function checkMaterialAvailability(materialCode, requiredGrams = 50) {
  const stock = await getStockByCode(materialCode);

  if (!stock || stock.status === 'OUT') {
    // Нет совсем — ищем альтернативы
    const alternatives = await findAlternatives(materialCode);
    return {
      available:       false,
      alternativeCode: alternatives[0]?.code || null,
      alternatives,
      reason:          'нет в наличии',
    };
  }

  if (parseFloat(stock.available_grams) < requiredGrams) {
    const alternatives = await findAlternatives(materialCode);
    return {
      available:       false,
      alternativeCode: alternatives[0]?.code || null,
      alternatives,
      reason:          `остаток ${Math.round(stock.available_grams)}г — может не хватить`,
    };
  }

  return { available: true, alternativeCode: null, alternatives: [], reason: '' };
}

// ═══════════════════════════════════════════════════════════════════════════
// КОМАНДЫ СПЕЦИАЛИСТА — регистрируются в specialists.js
// ═══════════════════════════════════════════════════════════════════════════

function registerStockCommands(bot, requireSpecialist) {

  // /stock — просмотр всех остатков
  bot.command('stock', requireSpecialist(), async (ctx) => {
    const stocks = await getAllStock();
    const text   = formatStockTable(stocks);

    return ctx.reply(text, {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: '➕ Добавить катушку',    callback_data: 'stock_add_menu'    }],
          [{ text: '📝 Списать после печати', callback_data: 'stock_use_menu'    }],
          [{ text: '🔧 Корректировка',        callback_data: 'stock_adjust_menu' }],
        ]
      }
    });
  });

  // /addstock PETG 1000 — добавить катушку
  // /addstock PETG 1000 Новая катушка REC
  bot.command('addstock', requireSpecialist(), async (ctx) => {
    const parts = ctx.message.text.split(' ');
    const code  = parts[1]?.toUpperCase();
    const grams = parseFloat(parts[2]);
    const note  = parts.slice(3).join(' ') || '';

    if (!code || isNaN(grams) || grams <= 0)
      return ctx.reply(
        '📝 Использование:\n`/addstock PETG 1000` — добавить 1 катушку 1кг\n`/addstock PETG 500 REC прозрачный`',
        { parse_mode: 'Markdown' }
      );

    const stock = await addStock(code, grams, ctx.from.id, note);
    if (!stock)
      return ctx.reply(`Материал \`${code}\` не найден в каталоге.`, { parse_mode: 'Markdown' });

    return ctx.reply(
      `✅ *Добавлено: ${grams}г ${code}*\n\n${formatSingleStock(stock)}`,
      { parse_mode: 'Markdown' }
    );
  });

  // /usestock PETG 45 HVL-00012 — списать после печати
  bot.command('usestock', requireSpecialist(), async (ctx) => {
    const parts  = ctx.message.text.split(' ');
    const code   = parts[1]?.toUpperCase();
    const grams  = parseFloat(parts[2]);
    const order  = parts[3]?.toUpperCase() || null;

    if (!code || isNaN(grams) || grams <= 0)
      return ctx.reply(
        '📝 Использование:\n`/usestock PETG 45 HVL-00012` — списать 45г после печати\n`/usestock PETG 45` — без привязки к заказу',
        { parse_mode: 'Markdown' }
      );

    const stock = await consumeMaterial(code, grams, order, ctx.from.id);
    if (!stock)
      return ctx.reply(`Материал \`${code}\` не найден.`, { parse_mode: 'Markdown' });

    let text = `✅ *Списано: ${grams}г ${code}*\n\n${formatSingleStock(stock)}`;

    // Если после списания стало LOW или OUT — предупреждение
    if (stock.status === 'LOW')
      text += `\n\n⚠️ *Внимание:* материал заканчивается! Пора заказать новую катушку.`;
    else if (stock.status === 'OUT')
      text += `\n\n❌ *Материал закончился!* Следующие заказы с этим материалом нельзя принимать.`;

    return ctx.reply(text, { parse_mode: 'Markdown' });
  });

  // /adjuststock PETG 750 — установить фактический остаток (инвентаризация)
  bot.command('adjuststock', requireSpecialist(), async (ctx) => {
    const parts  = ctx.message.text.split(' ');
    const code   = parts[1]?.toUpperCase();
    const actual = parseFloat(parts[2]);

    if (!code || isNaN(actual) || actual < 0)
      return ctx.reply(
        '📝 Использование:\n`/adjuststock PETG 750` — установить фактический остаток 750г',
        { parse_mode: 'Markdown' }
      );

    const stock = await adjustStock(code, actual, ctx.from.id, 'Инвентаризация');
    if (!stock)
      return ctx.reply(`Материал \`${code}\` не найден.`, { parse_mode: 'Markdown' });

    return ctx.reply(
      `🔧 *Корректировка: ${code}*\n\n${formatSingleStock(stock)}\n\n_Разница записана в журнал._`,
      { parse_mode: 'Markdown' }
    );
  });

  // /stocklog PETG — история транзакций
  bot.command('stocklog', requireSpecialist(), async (ctx) => {
    const code = ctx.message.text.split(' ')[1]?.toUpperCase();
    if (!code)
      return ctx.reply('Использование: `/stocklog PETG`', { parse_mode: 'Markdown' });

    const history = await getTransactionHistory(code, 10);
    if (!history.length)
      return ctx.reply(`История по \`${code}\` пуста.`, { parse_mode: 'Markdown' });

    const typeLabels = {
      ADD:     '➕ Пополнение',
      USE:     '🖨 Списание',
      RESERVE: '🔒 Резерв',
      RELEASE: '🔓 Снятие резерва',
      ADJUST:  '🔧 Корректировка',
    };

    let text = `📋 *История: ${code} (последние ${history.length})*\n\n`;
    for (const t of history) {
      const date = new Date(t.created_at).toLocaleDateString('ru-RU');
      const spec = t.specialist_name || '—';
      const sign = t.type === 'USE' ? '-' : '+';
      text += `${typeLabels[t.type] || t.type}\n`;
      text += `   ${sign}${t.amount_grams}г | ${date} | ${spec}\n`;
      if (t.order_number) text += `   Заказ: \`${t.order_number}\`\n`;
      if (t.note) text += `   _${t.note}_\n`;
      text += '\n';
    }

    return ctx.reply(text, { parse_mode: 'Markdown' });
  });

  // ── Inline кнопки для быстрого ввода ────────────────────────────────────

  // Меню добавления катушки
  bot.action('stock_add_menu', requireSpecialist(), async (ctx) => {
    await ctx.answerCbQuery();
    const stocks = await getAllStock();
    // Показываем материалы которые можно пополнить
    const buttons = stocks
      .filter(s => s.status !== 'OK' || true) // все материалы
      .map(s => [{
        text: `${s.status === 'LOW' ? '⚠️' : s.status === 'OUT' ? '❌' : '📦'} ${s.material_code} (${Math.round(s.available_grams)}г)`,
        callback_data: `stock_add_${s.material_code}`,
      }]);

    return ctx.reply('Выберите материал для пополнения:', {
      reply_markup: { inline_keyboard: buttons.slice(0, 10) }
    });
  });

  // Выбрали материал для пополнения
  bot.action(/^stock_add_([A-Z_0-9]+)$/, requireSpecialist(), async (ctx) => {
    await ctx.answerCbQuery();
    const code = ctx.match[1];
    await db.setSpecialistState(ctx.from.id, { action: 'stock_add', materialCode: code });
    return ctx.reply(
      `➕ *Пополнение: ${code}*\n\nНапишите количество граммов:\n_Например: 1000 (стандартная катушка 1кг)_`,
      { parse_mode: 'Markdown' }
    );
  });

  // Меню списания — показываем только активные материалы
  bot.action('stock_use_menu', requireSpecialist(), async (ctx) => {
    await ctx.answerCbQuery();
    const stocks = await getAllStock();
    const buttons = stocks
      .filter(s => parseFloat(s.available_grams) > 0)
      .map(s => [{
        text: `🖨 ${s.material_code} (${Math.round(s.available_grams)}г)`,
        callback_data: `stock_use_${s.material_code}`,
      }]);

    return ctx.reply('Выберите материал для списания:', {
      reply_markup: { inline_keyboard: buttons.slice(0, 10) }
    });
  });

  bot.action(/^stock_use_([A-Z_0-9]+)$/, requireSpecialist(), async (ctx) => {
    await ctx.answerCbQuery();
    const code = ctx.match[1];
    await db.setSpecialistState(ctx.from.id, { action: 'stock_use', materialCode: code });
    return ctx.reply(
      `🖨 *Списание: ${code}*\n\nНапишите сколько грамм израсходовано:\n_Например: 45_\n\nИли: `+
      "`45 HVL-00012`" + ` — с привязкой к заказу`,
      { parse_mode: 'Markdown' }
    );
  });

  // Корректировка
  bot.action('stock_adjust_menu', requireSpecialist(), async (ctx) => {
    await ctx.answerCbQuery();
    const stocks = await getAllStock();
    const buttons = stocks.map(s => [{
      text: `🔧 ${s.material_code} (сейчас: ${Math.round(s.stock_grams)}г)`,
      callback_data: `stock_adj_${s.material_code}`,
    }]);
    return ctx.reply('Выберите материал для корректировки:', {
      reply_markup: { inline_keyboard: buttons.slice(0, 10) }
    });
  });

  bot.action(/^stock_adj_([A-Z_0-9]+)$/, requireSpecialist(), async (ctx) => {
    await ctx.answerCbQuery();
    const code = ctx.match[1];
    const stock = await getStockByCode(code);
    await db.setSpecialistState(ctx.from.id, { action: 'stock_adjust', materialCode: code });
    return ctx.reply(
      `🔧 *Инвентаризация: ${code}*\n\n` +
      `Сейчас в БД: *${Math.round(stock.stock_grams)}г*\n\n` +
      `Напишите фактический остаток в граммах:`,
      { parse_mode: 'Markdown' }
    );
  });

  // ── Обработка текстового ввода для stock-действий ────────────────────────
  // ВАЖНО: этот обработчик добавить В НАЧАЛО bot.on('text') в specialists.js
  // перед остальными обработчиками состояний специалиста
  // Пример интеграции — см. README

}

// ── Обработчик ввода для stock (вызывать из specialists.js) ──────────────

async function handleStockInput(ctx, state) {
  const parts  = ctx.message.text.trim().split(' ');
  const grams  = parseFloat(parts[0]);
  const code   = state.materialCode;

  if (isNaN(grams) || grams <= 0)
    return ctx.reply('Введите число. Например: `1000`', { parse_mode: 'Markdown' });

  if (state.action === 'stock_add') {
    const note  = parts.slice(1).join(' ');
    const stock = await addStock(code, grams, ctx.from.id, note);
    await db.clearSpecialistState(ctx.from.id);
    return ctx.reply(`✅ *+${grams}г ${code}*\n\n${formatSingleStock(stock)}`, { parse_mode: 'Markdown' });
  }

  if (state.action === 'stock_use') {
    const order = parts[1]?.startsWith('HVL') ? parts[1].toUpperCase() : null;
    const stock = await consumeMaterial(code, grams, order, ctx.from.id);
    await db.clearSpecialistState(ctx.from.id);
    let text = `✅ *-${grams}г ${code}*\n\n${formatSingleStock(stock)}`;
    if (stock.status === 'LOW') text += '\n\n⚠️ Материал заканчивается — пора заказать!';
    if (stock.status === 'OUT') text += '\n\n❌ Материал закончился!';
    return ctx.reply(text, { parse_mode: 'Markdown' });
  }

  if (state.action === 'stock_adjust') {
    const stock = await adjustStock(code, grams, ctx.from.id, 'Инвентаризация');
    await db.clearSpecialistState(ctx.from.id);
    return ctx.reply(`🔧 *${code}: установлено ${grams}г*\n\n${formatSingleStock(stock)}`, { parse_mode: 'Markdown' });
  }

  return null; // не наш запрос
}

// ═══════════════════════════════════════════════════════════════════════════
// ПЛАНИРОВЩИК — ежедневная проверка остатков
// Добавить вызов в scheduler.js
// ═══════════════════════════════════════════════════════════════════════════

async function checkLowStockAndNotify(bot, groupId) {
  if (!bot || !groupId) return;

  const lowItems = await getLowStockMaterials();
  if (!lowItems.length) return;

  const outItems = lowItems.filter(s => s.status === 'OUT');
  const lowOnly  = lowItems.filter(s => s.status === 'LOW');

  let text = '📦 *Ежедневный отчёт об остатках*\n\n';

  if (outItems.length) {
    text += '❌ *Закончились:*\n';
    for (const s of outItems)
      text += `  • ${s.material_code} — *0г*\n`;
    text += '\n';
  }

  if (lowOnly.length) {
    text += '⚠️ *Заканчиваются:*\n';
    for (const s of lowOnly)
      text += `  • ${s.material_code} — *${Math.round(s.available_grams)}г* (порог: ${s.min_threshold_g}г)\n`;
    text += '\n';
  }

  text += '_Пополните: /addstock КОД ГРАММЫ_';

  try {
    await bot.telegram.sendMessage(groupId, text, { parse_mode: 'Markdown' });
  } catch (err) {
    console.error('[Stock] notify error:', err.message);
  }
}

module.exports = {
  // Операции
  consumeMaterial,
  addStock,
  adjustStock,
  reserveMaterial,
  releaseMaterial,
  // Чтение
  getStockByCode,
  getAllStock,
  getLowStockMaterials,
  getTransactionHistory,
  hasEnoughStock,
  findAlternatives,
  // Для ai.js
  checkMaterialAvailability,
  // Форматирование
  formatStockTable,
  formatSingleStock,
  // Регистрация команд
  registerStockCommands,
  handleStockInput,
  // Планировщик
  checkLowStockAndNotify,
};
