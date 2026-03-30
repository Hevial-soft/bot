const { Pool } = require("pg");

const pool = new Pool({
  host: process.env.DB_HOST || "localhost",
  port: parseInt(process.env.DB_PORT) || 5432,
  database: process.env.DB_NAME || "hevial_db",
  user: process.env.DB_USER || "postgres",
  password: process.env.DB_PASSWORD,
  max: 10,
  idleTimeoutMillis: 30000,
});

pool.on("error", (err) => {
  console.error("PostgreSQL pool error:", err);
});

// ── Клиенты ───────────────────────────────────────────────────────────────

async function getOrCreateClient(telegramUser) {
  const { id, username, first_name, last_name } = telegramUser;

  const existing = await pool.query(
    "SELECT * FROM clients WHERE telegram_user_id = $1",
    [id],
  );

  if (existing.rows.length > 0) {
    await pool.query(
      "UPDATE clients SET last_seen = NOW(), username = $1 WHERE telegram_user_id = $2",
      [username || null, id],
    );
    return existing.rows[0];
  }

  const result = await pool.query(
    `INSERT INTO clients (telegram_user_id, username, first_name, last_name, last_seen)
     VALUES ($1, $2, $3, $4, NOW()) RETURNING *`,
    [id, username || null, first_name, last_name || null],
  );
  return result.rows[0];
}

async function isClientBlocked(telegramUserId) {
  const r = await pool.query(
    "SELECT is_blocked FROM clients WHERE telegram_user_id = $1",
    [telegramUserId],
  );
  return r.rows[0]?.is_blocked || false;
}

// ── Заказы ────────────────────────────────────────────────────────────────

async function createOrderDraft(clientId) {
  const r = await pool.query(
    `INSERT INTO orders (client_id, status, urgency, delivery_type, quantity, is_batch, review_sent)
     VALUES ($1, 'NEW', 'STANDARD', 'COURIER', 1, false, false)
     RETURNING *`,
    [clientId],
  );
  return r.rows[0];
}

async function updateOrder(orderNumber, fields) {
  const keys = Object.keys(fields);
  const values = Object.values(fields);
  const set = keys.map((k, i) => `${k} = $${i + 2}`).join(", ");

  const r = await pool.query(
    `UPDATE orders SET ${set}, updated_at = NOW() WHERE order_number = $1 RETURNING *`,
    [orderNumber, ...values],
  );
  return r.rows[0];
}

async function getOrderByNumber(orderNumber) {
  const r = await pool.query("SELECT * FROM orders WHERE order_number = $1", [
    orderNumber,
  ]);
  return r.rows[0] || null;
}

async function getActiveOrderByTelegramId(telegramUserId) {
  const r = await pool.query(
    `SELECT o.* FROM orders o
     JOIN clients c ON c.id = o.client_id
     WHERE c.telegram_user_id = $1
       AND o.status NOT IN ('CLOSED', 'DELIVERED')
     ORDER BY o.created_at DESC LIMIT 1`,
    [telegramUserId],
  );
  return r.rows[0] || null;
}

async function confirmOrder(orderNumber) {
  const r = await pool.query(
    `UPDATE orders SET
       status = 'NEW',
       updated_at = NOW()
     WHERE order_number = $1 RETURNING *`,
    [orderNumber],
  );
  return r.rows[0];
}

async function changeOrderStatus(
  orderNumber,
  newStatus,
  changedBy = "SYSTEM",
  note = null,
) {
  const order = await getOrderByNumber(orderNumber);
  if (!order) return null;

  await pool.query(
    `INSERT INTO order_status_log (order_id, order_number, old_status, new_status, changed_by, note)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [order.id, orderNumber, order.status, newStatus, changedBy, note],
  );

  const r = await pool.query(
    `UPDATE orders SET status = $1, updated_at = NOW() WHERE order_number = $2 RETURNING *`,
    [newStatus, orderNumber],
  );
  return r.rows[0];
}

async function markReviewSent(orderNumber) {
  await pool.query(
    `UPDATE orders SET review_sent = true, review_sent_at = NOW() WHERE order_number = $1`,
    [orderNumber],
  );
}

async function saveReview(orderNumber, text, rating) {
  await pool.query(
    `UPDATE orders SET
       review_text = $1,
       review_rating = $2,
       status = 'CLOSED',
       updated_at = NOW()
     WHERE order_number = $3`,
    [text, rating || null, orderNumber],
  );
}

async function getPendingReviewOrders() {
  const r = await pool.query(
    `SELECT o.order_number, o.delivered_at, c.telegram_user_id, c.first_name
     FROM orders o JOIN clients c ON c.id = o.client_id
     WHERE o.status = 'DELIVERED' AND o.review_sent = false`,
  );
  return r.rows;
}

async function getAllActiveOrders() {
  const r = await pool.query(
    `SELECT o.*, c.first_name, c.username, c.telegram_user_id
     FROM orders o JOIN clients c ON c.id = o.client_id
     WHERE o.status NOT IN ('CLOSED', 'DELIVERED')
     ORDER BY o.created_at DESC`,
  );
  return r.rows;
}

// ── Материалы ─────────────────────────────────────────────────────────────

async function getAllMaterials() {
  const r = await pool.query(
    `SELECT m.*, pm.code AS method_code, pm.surface_note,
            pm.max_size_x, pm.max_size_y, pm.max_size_z
     FROM material m
     JOIN print_method pm ON pm.id = m.method_id
     WHERE m.is_active = true AND pm.is_active = true
     ORDER BY m.sort_order`,
  );

  // Подгружаем use_cases и exclusions для каждого материала
  const materials = r.rows;
  for (const mat of materials) {
    const uc = await pool.query(
      "SELECT use_case FROM material_use_cases WHERE material_id = $1",
      [mat.id],
    );
    const ex = await pool.query(
      "SELECT exclusion FROM material_exclusions WHERE material_id = $1",
      [mat.id],
    );
    mat.use_cases = uc.rows.map((r) => r.use_case);
    mat.exclusions = ex.rows.map((r) => r.exclusion);
  }

  return materials;
}

async function getMaterialByCode(code) {
  const r = await pool.query(
    `SELECT m.*, pm.code AS method_code, pm.surface_note
     FROM material m
     JOIN print_method pm ON pm.id = m.method_id
     WHERE m.code = $1 AND m.is_active = true`,
    [code.toUpperCase()],
  );
  if (!r.rows[0]) return null;

  const mat = r.rows[0];
  const uc = await pool.query(
    "SELECT use_case FROM material_use_cases WHERE material_id = $1",
    [mat.id],
  );
  const ex = await pool.query(
    "SELECT exclusion FROM material_exclusions WHERE material_id = $1",
    [mat.id],
  );
  mat.use_cases = uc.rows.map((r) => r.use_case);
  mat.exclusions = ex.rows.map((r) => r.exclusion);
  return mat;
}

async function getProductionTime(methodCode, maxDimension) {
  const r = await pool.query(
    `SELECT * FROM production_time
     WHERE method_id = (SELECT id FROM print_method WHERE code = $1)
       AND category != 'BATCH'
       AND (max_dimension IS NULL OR max_dimension >= $2)
     ORDER BY sort_order ASC LIMIT 1`,
    [methodCode, maxDimension],
  );
  return r.rows[0] || null;
}

async function getPricingConfig() {
  const r = await pool.query("SELECT key, value FROM pricing_config");
  const config = {};
  for (const row of r.rows) config[row.key] = parseFloat(row.value);
  return config;
}

// ── История диалога ───────────────────────────────────────────────────────

async function saveDialogMessage({
  clientId,
  orderId,
  orderNumber,
  sessionId,
  role,
  messageType,
  messageText,
  fileId,
  dialogStep,
  telegramMsgId,
}) {
  await pool.query(
    `INSERT INTO dialog_message
       (client_id, order_id, order_number, session_id,
        role, message_type, message_text, file_id, dialog_step, telegram_msg_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      clientId,
      orderId || null,
      orderNumber || null,
      sessionId,
      role,
      messageType || "TEXT",
      messageText || null,
      fileId || null,
      dialogStep || null,
      telegramMsgId || null,
    ],
  );
}

async function linkSessionToOrder(sessionId, orderId, orderNumber) {
  await pool.query(
    `UPDATE dialog_message
     SET order_id = $1, order_number = $2
     WHERE session_id = $3 AND order_id IS NULL`,
    [orderId, orderNumber, sessionId],
  );
}

async function getDialogByOrder(orderNumber) {
  const r = await pool.query(
    `SELECT * FROM dialog_message
     WHERE order_number = $1
     ORDER BY created_at ASC`,
    [orderNumber],
  );
  return r.rows;
}

async function getRecentMessages(sessionId, limit = 10, orderNumber = null) {
  if (!sessionId && !orderNumber) {
    throw new Error("sessionId or orderNumber is required");
  }

  const conditions = [];
  const values = [];
  let idx = 1;

  if (sessionId) {
    conditions.push(`session_id = $${idx++}`);
    values.push(sessionId);
  }

  if (orderNumber) {
    conditions.push(`order_number = $${idx++}`);
    values.push(orderNumber);
  }

  values.push(limit);

  const r = await pool.query(
    `SELECT *
     FROM dialog_message
     WHERE ${conditions.join(" AND ")}
     ORDER BY created_at DESC
     LIMIT $${idx}`,
    values
  );

  return r.rows.reverse();
}

// ── Промпты ───────────────────────────────────────────────────────────────

async function getAiPrompt(key) {
  const r = await pool.query(
    "SELECT * FROM ai_prompts WHERE key = $1 AND is_active = true",
    [key],
  );
  return r.rows[0] || null;
}

// ── Специалисты ───────────────────────────────────────────────────────────

async function getActiveSpecialists() {
  try {
    const r = await pool.query(
      "SELECT * FROM specialists WHERE is_active = true",
    );
    return r.rows;
  } catch {
    // Таблица может не существовать на старте
    return [];
  }
}

async function createBridge({
  specialistChatId,
  clientChatId,
  orderNumber,
  specialistUsername,
}) {
  await pool.query(
    `INSERT INTO active_bridges
       (specialist_chat_id, client_chat_id, order_number, specialist_username)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (specialist_chat_id) DO UPDATE
       SET client_chat_id=$2, order_number=$3, specialist_username=$4, opened_at=NOW()`,
    [specialistChatId, clientChatId, orderNumber, specialistUsername],
  );
}

async function deleteBridge(specialistChatId) {
  await pool.query(`DELETE FROM active_bridges WHERE specialist_chat_id=$1`, [
    specialistChatId,
  ]);
}

async function getBridgeBySpecialist(specialistChatId) {
  const res = await pool.query(
    `SELECT * FROM active_bridges WHERE specialist_chat_id=$1`,
    [specialistChatId],
  );
  return res.rows[0] || null;
}

async function getBridgeByClient(clientChatId) {
  const res = await pool.query(
    `SELECT * FROM active_bridges WHERE client_chat_id=$1`,
    [clientChatId],
  );
  return res.rows[0] || null;
}

// Ищет мост с любой стороны (специалист ИЛИ клиент)
async function getBridgeByAnyParty(chatId) {
  const res = await pool.query(
    `SELECT * FROM active_bridges
     WHERE specialist_chat_id=$1 OR client_chat_id=$1
     LIMIT 1`,
    [chatId],
  );
  return res.rows[0] || null;
}

async function saveGroupMessageId(clientTelegramId, messageId, groupId) {
  await pool.query(
    `INSERT INTO group_messages (client_telegram_id, message_id, group_id)
     VALUES ($1, $2, $3)
     ON CONFLICT (client_telegram_id) DO UPDATE
       SET message_id=$2, group_id=$3, created_at=NOW()`,
    [clientTelegramId, messageId, groupId],
  );
}

async function getGroupMessageId(clientTelegramId) {
  const res = await pool.query(
    `SELECT * FROM group_messages WHERE client_telegram_id=$1`,
    [clientTelegramId],
  );
  return res.rows[0] || null;
}

async function resetSessionStep(chatId, step) {
  await pool.query(
    `UPDATE dialog_sessions SET current_step=$2, updated_at=NOW()
     WHERE chat_id=$1`,
    [chatId, step],
  );
}

// Сбросить сессию (при /start или /cancel) — устанавливает новый шаг и очищает данные заказа
async function resetSession(telegramId, chatId, step = "START") {
  await pool.query(
    `UPDATE dialog_sessions SET
       current_step = $3,
       order_id = NULL,
       order_number = NULL,
       file_id = NULL,
       file_name = NULL,
       photo_id = NULL,
       use_description = NULL,
       suggested_material = NULL,
       client_material_wish = NULL,
       confirmed_material = NULL,
       confirmed_method = NULL,
       material_overridden = FALSE,
       size_x = NULL,
       size_y = NULL,
       size_z = NULL,
       volume_cm3 = NULL,
       quantity = 1,
       urgency = 'STANDARD',
       delivery_type = 'COURIER',
       is_reverse = FALSE,
       modeling_delivery = NULL,
       modeling_urgency = NULL,
       awaiting_specialist = FALSE,
       retry_count = 0,
       updated_at = NOW()
     WHERE telegram_id = $1 AND chat_id = $2`,
    [telegramId, chatId, step],
  );
}

// Создать заявку на моделирование
async function createModelingOrder({
  clientId,
  telegramId,
  useDescription,
  sizeX,
  sizeY,
  sizeZ,
  isReverse,
  deliveryType,
  urgency,
  photoId,
}) {
  // Генерируем номер заявки
  const countRes = await pool.query(`SELECT COUNT(*) FROM modeling_orders`);
  const num = parseInt(countRes.rows[0].count) + 1;
  const orderNumber = `MOD-${String(num).padStart(5, "0")}`;

  const r = await pool.query(
    `INSERT INTO modeling_orders
       (order_number, client_id, telegram_id, status,
        use_description, size_x, size_y, size_z,
        is_reverse, delivery_type, urgency, photo_id)
     VALUES ($1,$2,$3,'NEW',$4,$5,$6,$7,$8,$9,$10,$11)
     RETURNING *`,
    [
      orderNumber,
      clientId,
      telegramId,
      useDescription || null,
      sizeX || null,
      sizeY || null,
      sizeZ || null,
      isReverse || false,
      deliveryType || "PHOTO",
      urgency || "STANDARD",
      photoId || null,
    ],
  );
  return r.rows[0];
}

// ── Персистентные сессии ──────────────────────────────────────────────────

async function getOrCreateSession(telegramId, chatId) {
  // Пытаемся найти существующую сессию
  const existing = await pool.query(
    `SELECT * FROM dialog_sessions WHERE telegram_id = $1 AND chat_id = $2`,
    [telegramId, chatId],
  );

  if (existing.rows.length > 0) {
    return _mapSession(existing.rows[0]);
  }

  // Создаём новую сессию
  const result = await pool.query(
    `INSERT INTO dialog_sessions
       (telegram_id, chat_id, current_step, quantity, urgency, delivery_type,
        material_overridden, is_reverse, awaiting_specialist, retry_count)
     VALUES ($1, $2, 'START', 1, 'STANDARD', 'COURIER', false, false, false, 0)
     RETURNING *`,
    [telegramId, chatId],
  );

  return _mapSession(result.rows[0]);
}

async function updateSession(sessionId, fields) {
  if (!fields || Object.keys(fields).length === 0) return;

  // Маппинг camelCase → snake_case для колонок БД
  const columnMap = {
    currentStep: "current_step",
    orderType: "order_type",
    fileId: "file_id",
    fileName: "file_name",
    photoId: "photo_id",
    useDescription: "use_description",
    suggestedMaterial: "suggested_material",
    clientMaterialWish: "client_material_wish",
    confirmedMaterial: "confirmed_material",
    confirmedMethod: "confirmed_method",
    materialOverridden: "material_overridden",
    sizeX: "size_x",
    sizeY: "size_y",
    sizeZ: "size_z",
    volumeCm3: "volume_cm3",
    quantity: "quantity",
    urgency: "urgency",
    deliveryType: "delivery_type",
    orderId: "order_id",
    orderNumber: "order_number",
    isReverse: "is_reverse",
    modelingDelivery: "modeling_delivery",
    modelingUrgency: "modeling_urgency",
    awaitingSpecialist: "awaiting_specialist",
    retryCount: "retry_count",
  };

  const setClauses = [];
  const values = [sessionId];
  let idx = 2;

  for (const [key, rawValue] of Object.entries(fields)) {
    let value = rawValue;
  
    if (key === "orderId") {
      // ✅ ДОПОЛНИТЕЛЬНАЯ ПРОВЕРКА
      value = 
        Number.isInteger(value) && value > 0 
          ? value 
          : null;
      
      // ✅ Если orderId указан, проверяем существует ли заказ
      if (value !== null) {
        const orderExists = await pool.query(
          "SELECT id FROM orders WHERE id = $1",
          [value]
        );
        if (orderExists.rows.length === 0) {
          console.warn(`Order ${value} does not exist, setting orderId to NULL`);
          value = null;
        }
      }
    }
    
    const col = columnMap[key] || key;
    setClauses.push(`${col} = $${idx}`);
    values.push(value);
    idx++;
  }

  await pool.query(
    `UPDATE dialog_sessions SET ${setClauses.join(", ")}, updated_at = NOW()
     WHERE id = $1`,
    values,
  );
}

// Преобразовать строку БД → объект сессии (camelCase)
function _mapSession(row) {
  return {
    id: row.id,
    telegramId: row.telegram_id,
    chatId: row.chat_id,
    currentStep: row.current_step,
    orderType: row.order_type,
    fileId: row.file_id,
    fileName: row.file_name,
    photoId: row.photo_id,
    useDescription: row.use_description,
    suggestedMaterial: row.suggested_material,
    clientMaterialWish: row.client_material_wish,
    confirmedMaterial: row.confirmed_material,
    confirmedMethod: row.confirmed_method,
    materialOverridden: row.material_overridden || false,
    sizeX: row.size_x,
    sizeY: row.size_y,
    sizeZ: row.size_z,
    volumeCm3: row.volume_cm3,
    quantity: row.quantity || 1,
    urgency: row.urgency || "STANDARD",
    deliveryType: row.delivery_type || "COURIER",
    orderId: row.order_id,
    orderNumber: row.order_number,
    isReverse: row.is_reverse || false,
    modelingDelivery: row.modeling_delivery,
    modelingUrgency: row.modeling_urgency,
    awaitingSpecialist: row.awaiting_specialist || false,
    retryCount: row.retry_count || 0,
  };
}

// Получить специалиста по telegram_id
async function getSpecialistById(telegramId) {
  const res = await pool.query(
    `SELECT * FROM specialists WHERE telegram_id=$1`,
    [telegramId],
  );
  return res.rows[0] || null;
}

// Список всех специалистов
async function getAllSpecialists() {
  const res = await pool.query(
    `SELECT * FROM specialists ORDER BY created_at ASC`,
  );
  return res.rows;
}

// Добавить специалиста
async function addSpecialist({
  telegramId,
  name,
  username,
  role = "specialist",
}) {
  await pool.query(
    `INSERT INTO specialists (telegram_id, name, username, role)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (telegram_id) DO UPDATE
       SET name=$2, username=$3, role=$4, is_active=TRUE, updated_at=NOW()`,
    [telegramId, name, username || null, role],
  );
}

// Деактивировать специалиста
async function deactivateSpecialist(telegramId) {
  await pool.query(
    `UPDATE specialists SET is_active=FALSE, updated_at=NOW()
     WHERE telegram_id=$1`,
    [telegramId],
  );
}

// Активные заказы (для панели специалиста)
async function getActiveOrders(limit = 20) {
  const res = await pool.query(
    `SELECT o.*, c.first_name, c.username, c.telegram_user_id
     FROM orders o
     LEFT JOIN clients c ON o.client_id = c.id
     WHERE o.status NOT IN ('CANCELLED','CLOSED','DELIVERED')
       AND o.delivered_at IS NULL
     ORDER BY o.created_at DESC
     LIMIT $1`,
    [limit],
  );
  return res.rows;
}

// Заказы конкретного специалиста
async function getOrdersBySpecialist(specialistTelegramId) {
  const res = await pool.query(
    `SELECT o.*, c.first_name, c.username
     FROM orders o
     LEFT JOIN clients c ON o.client_id = c.id
     WHERE o.assigned_specialist_id=$1
       AND o.status NOT IN ('CANCELLED','CLOSED','DELIVERED')
     ORDER BY o.created_at DESC`,
    [specialistTelegramId],
  );
  return res.rows;
}

// Назначить специалиста на заказ
async function assignSpecialistToOrder(orderNumber, specialistTelegramId) {
  await pool.query(
    `UPDATE orders SET assigned_specialist_id=$2, updated_at=NOW()
     WHERE order_number=$1 AND assigned_specialist_id IS NULL`,
    [orderNumber, specialistTelegramId],
  );
}

// Обновить статус заказа
async function updateOrderStatus(orderNumber, newStatus) {
  await pool.query(
    `UPDATE orders SET status=$2, updated_at=NOW() WHERE order_number=$1`,
    [orderNumber, newStatus],
  );
}

// Обновить статус заявки моделирования
async function updateModelingOrderStatus(
  orderNumber,
  status,
  specialistId,
  specialistUsername,
) {
  await pool.query(
    `UPDATE modeling_orders
     SET status=$2, specialist_telegram_id=$3, specialist_username=$4, updated_at=NOW()
     WHERE order_number=$1`,
    [orderNumber, status, specialistId, specialistUsername],
  );
}

async function setSpecialistState(telegramId, state) {
  await pool.query(
    `INSERT INTO specialist_states (telegram_id, action, order_number)
     VALUES ($1, $2, $3)
     ON CONFLICT (telegram_id) DO UPDATE
       SET action=$2, order_number=$3, created_at=NOW()`,
    [telegramId, state.action, state.orderNumber || null],
  );
}

async function getSpecialistState(telegramId) {
  const res = await pool.query(
    `SELECT * FROM specialist_states WHERE telegram_id=$1`,
    [telegramId],
  );
  if (!res.rows[0]) return null;
  return {
    action: res.rows[0].action,
    orderNumber: res.rows[0].order_number,
  };
}

async function clearSpecialistState(telegramId) {
  await pool.query(`DELETE FROM specialist_states WHERE telegram_id=$1`, [
    telegramId,
  ]);
}

module.exports = {
  pool,
  // Клиенты
  getOrCreateClient,
  isClientBlocked,
  // Заказы
  createOrderDraft,
  updateOrder,
  getOrderByNumber,
  getActiveOrderByTelegramId,
  confirmOrder,
  changeOrderStatus,
  markReviewSent,
  saveReview,
  getPendingReviewOrders,
  getAllActiveOrders,
  // Материалы
  getAllMaterials,
  getMaterialByCode,
  getProductionTime,
  getPricingConfig,
  // Диалог
  saveDialogMessage,
  linkSessionToOrder,
  getDialogByOrder,
  getRecentMessages,
  // Промпты
  getAiPrompt,
  // Специалисты
  getActiveSpecialists,
  createBridge,
  deleteBridge,
  getBridgeBySpecialist,
  getBridgeByClient,
  getBridgeByAnyParty,
  saveGroupMessageId,
  getGroupMessageId,
  resetSessionStep,
  getSpecialistById,
  getAllSpecialists,
  addSpecialist,
  deactivateSpecialist,
  getActiveOrders,
  getOrdersBySpecialist,
  assignSpecialistToOrder,
  updateOrderStatus,
  updateModelingOrderStatus,
  setSpecialistState,
  getSpecialistState,
  clearSpecialistState,
  // Персистентные сессии
  getOrCreateSession,
  updateSession,
  resetSession,
  // Заказы на моделирование
  createModelingOrder,
};
