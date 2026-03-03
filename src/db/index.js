const { Pool } = require('pg');

const pool = new Pool({
  host:     process.env.DB_HOST     || 'localhost',
  port:     parseInt(process.env.DB_PORT) || 5432,
  database: process.env.DB_NAME     || 'hevial_db',
  user:     process.env.DB_USER     || 'postgres',
  password: process.env.DB_PASSWORD,
  max: 10,
  idleTimeoutMillis: 30000,
});

pool.on('error', (err) => {
  console.error('PostgreSQL pool error:', err);
});

// ── Клиенты ───────────────────────────────────────────────────────────────

async function getOrCreateClient(telegramUser) {
  const { id, username, first_name, last_name } = telegramUser;

  const existing = await pool.query(
    'SELECT * FROM clients WHERE telegram_user_id = $1',
    [id]
  );

  if (existing.rows.length > 0) {
    await pool.query(
      'UPDATE clients SET last_seen = NOW(), username = $1 WHERE telegram_user_id = $2',
      [username || null, id]
    );
    return existing.rows[0];
  }

  const result = await pool.query(
    `INSERT INTO clients (telegram_user_id, username, first_name, last_name, last_seen)
     VALUES ($1, $2, $3, $4, NOW()) RETURNING *`,
    [id, username || null, first_name, last_name || null]
  );
  return result.rows[0];
}

async function isClientBlocked(telegramUserId) {
  const r = await pool.query(
    'SELECT is_blocked FROM clients WHERE telegram_user_id = $1',
    [telegramUserId]
  );
  return r.rows[0]?.is_blocked || false;
}

// ── Заказы ────────────────────────────────────────────────────────────────

async function createOrderDraft(clientId) {
  const r = await pool.query(
    `INSERT INTO orders (client_id, status, urgency, delivery_type, quantity, is_batch, review_sent)
     VALUES ($1, 'NEW', 'STANDARD', 'COURIER', 1, false, false)
     RETURNING *`,
    [clientId]
  );
  return r.rows[0];
}

async function updateOrder(orderNumber, fields) {
  const keys   = Object.keys(fields);
  const values = Object.values(fields);
  const set    = keys.map((k, i) => `${k} = $${i + 2}`).join(', ');

  const r = await pool.query(
    `UPDATE orders SET ${set}, updated_at = NOW() WHERE order_number = $1 RETURNING *`,
    [orderNumber, ...values]
  );
  return r.rows[0];
}

async function getOrderByNumber(orderNumber) {
  const r = await pool.query(
    'SELECT * FROM orders WHERE order_number = $1',
    [orderNumber]
  );
  return r.rows[0] || null;
}

async function getActiveOrderByTelegramId(telegramUserId) {
  const r = await pool.query(
    `SELECT o.* FROM orders o
     JOIN clients c ON c.id = o.client_id
     WHERE c.telegram_user_id = $1
       AND o.status NOT IN ('CLOSED', 'DELIVERED')
     ORDER BY o.created_at DESC LIMIT 1`,
    [telegramUserId]
  );
  return r.rows[0] || null;
}

async function confirmOrder(orderNumber) {
  const r = await pool.query(
    `UPDATE orders SET
       status = 'NEW',
       updated_at = NOW()
     WHERE order_number = $1 RETURNING *`,
    [orderNumber]
  );
  return r.rows[0];
}

async function changeOrderStatus(orderNumber, newStatus, changedBy = 'SYSTEM', note = null) {
  const order = await getOrderByNumber(orderNumber);
  if (!order) return null;

  await pool.query(
    `INSERT INTO order_status_log (order_id, order_number, old_status, new_status, changed_by, note)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [order.id, orderNumber, order.status, newStatus, changedBy, note]
  );

  const r = await pool.query(
    `UPDATE orders SET status = $1, updated_at = NOW() WHERE order_number = $2 RETURNING *`,
    [newStatus, orderNumber]
  );
  return r.rows[0];
}

async function markReviewSent(orderNumber) {
  await pool.query(
    `UPDATE orders SET review_sent = true, review_sent_at = NOW() WHERE order_number = $1`,
    [orderNumber]
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
    [text, rating || null, orderNumber]
  );
}

async function getPendingReviewOrders() {
  const r = await pool.query(
    `SELECT o.order_number, o.delivered_at, c.telegram_user_id, c.first_name
     FROM orders o JOIN clients c ON c.id = o.client_id
     WHERE o.status = 'DELIVERED' AND o.review_sent = false`
  );
  return r.rows;
}

async function getAllActiveOrders() {
  const r = await pool.query(
    `SELECT o.*, c.first_name, c.username, c.telegram_user_id
     FROM orders o JOIN clients c ON c.id = o.client_id
     WHERE o.status NOT IN ('CLOSED', 'DELIVERED')
     ORDER BY o.created_at DESC`
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
     ORDER BY m.sort_order`
  );

  // Подгружаем use_cases и exclusions для каждого материала
  const materials = r.rows;
  for (const mat of materials) {
    const uc = await pool.query(
      'SELECT use_case FROM material_use_cases WHERE material_id = $1',
      [mat.id]
    );
    const ex = await pool.query(
      'SELECT exclusion FROM material_exclusions WHERE material_id = $1',
      [mat.id]
    );
    mat.use_cases  = uc.rows.map(r => r.use_case);
    mat.exclusions = ex.rows.map(r => r.exclusion);
  }

  return materials;
}

async function getMaterialByCode(code) {
  const r = await pool.query(
    `SELECT m.*, pm.code AS method_code, pm.surface_note
     FROM material m
     JOIN print_method pm ON pm.id = m.method_id
     WHERE m.code = $1 AND m.is_active = true`,
    [code.toUpperCase()]
  );
  if (!r.rows[0]) return null;

  const mat = r.rows[0];
  const uc  = await pool.query(
    'SELECT use_case FROM material_use_cases WHERE material_id = $1', [mat.id]
  );
  const ex  = await pool.query(
    'SELECT exclusion FROM material_exclusions WHERE material_id = $1', [mat.id]
  );
  mat.use_cases  = uc.rows.map(r => r.use_case);
  mat.exclusions = ex.rows.map(r => r.exclusion);
  return mat;
}

async function getProductionTime(methodCode, maxDimension) {
  const r = await pool.query(
    `SELECT * FROM production_time
     WHERE method_id = (SELECT id FROM print_method WHERE code = $1)
       AND category != 'BATCH'
       AND (max_dimension IS NULL OR max_dimension >= $2)
     ORDER BY sort_order ASC LIMIT 1`,
    [methodCode, maxDimension]
  );
  return r.rows[0] || null;
}

async function getPricingConfig() {
  const r = await pool.query('SELECT key, value FROM pricing_config');
  const config = {};
  for (const row of r.rows) config[row.key] = parseFloat(row.value);
  return config;
}

// ── История диалога ───────────────────────────────────────────────────────

async function saveDialogMessage({ clientId, orderId, orderNumber, sessionId,
                                    role, messageType, messageText,
                                    fileId, dialogStep, telegramMsgId }) {
  await pool.query(
    `INSERT INTO dialog_message
       (client_id, order_id, order_number, session_id,
        role, message_type, message_text, file_id, dialog_step, telegram_msg_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [clientId, orderId || null, orderNumber || null, sessionId,
     role, messageType || 'TEXT', messageText || null,
     fileId || null, dialogStep || null, telegramMsgId || null]
  );
}

async function linkSessionToOrder(sessionId, orderId, orderNumber) {
  await pool.query(
    `UPDATE dialog_message
     SET order_id = $1, order_number = $2
     WHERE session_id = $3 AND order_id IS NULL`,
    [orderId, orderNumber, sessionId]
  );
}

async function getDialogByOrder(orderNumber) {
  const r = await pool.query(
    `SELECT * FROM dialog_message
     WHERE order_number = $1
     ORDER BY created_at ASC`,
    [orderNumber]
  );
  return r.rows;
}

// ── Промпты ───────────────────────────────────────────────────────────────

async function getAiPrompt(key) {
  const r = await pool.query(
    'SELECT * FROM ai_prompts WHERE key = $1 AND is_active = true',
    [key]
  );
  return r.rows[0] || null;
}

// ── Специалисты ───────────────────────────────────────────────────────────

async function getActiveSpecialists() {
  try {
    const r = await pool.query(
      'SELECT * FROM specialists WHERE is_active = true'
    );
    return r.rows;
  } catch {
    // Таблица может не существовать на старте
    return [];
  }
}

module.exports = {
  pool,
  // Клиенты
  getOrCreateClient, isClientBlocked,
  // Заказы
  createOrderDraft, updateOrder, getOrderByNumber,
  getActiveOrderByTelegramId, confirmOrder,
  changeOrderStatus, markReviewSent, saveReview,
  getPendingReviewOrders, getAllActiveOrders,
  // Материалы
  getAllMaterials, getMaterialByCode,
  getProductionTime, getPricingConfig,
  // Диалог
  saveDialogMessage, linkSessionToOrder, getDialogByOrder,
  // Промпты
  getAiPrompt,
  // Специалисты
  getActiveSpecialists,
};
