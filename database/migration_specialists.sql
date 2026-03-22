-- migrations/migration_specialists.sql
-- Таблица специалистов с ролями

CREATE TABLE IF NOT EXISTS specialists (
  id            SERIAL PRIMARY KEY,
  telegram_id   BIGINT NOT NULL UNIQUE,
  name          VARCHAR(100) NOT NULL,
  username      VARCHAR(100),             -- telegram @username (без @)
  role          VARCHAR(20) DEFAULT 'specialist', -- 'specialist' | 'admin'
  is_active     BOOLEAN DEFAULT TRUE,
  created_at    TIMESTAMP DEFAULT NOW(),
  updated_at    TIMESTAMP DEFAULT NOW()
);

-- Добавить специалиста-администратора вручную (замени на свой telegram_id):
-- INSERT INTO specialists (telegram_id, name, role)
-- VALUES (123456789, 'Артём', 'admin')
-- ON CONFLICT DO NOTHING;

-- Назначенный специалист на заказ
ALTER TABLE orders ADD COLUMN IF NOT EXISTS
  assigned_specialist_id BIGINT REFERENCES specialists(telegram_id);

-- Назначенный специалист на заказ моделирования
ALTER TABLE modeling_orders ADD COLUMN IF NOT EXISTS
  assigned_specialist_id BIGINT REFERENCES specialists(telegram_id);

-- Индексы
CREATE INDEX IF NOT EXISTS idx_specialists_telegram ON specialists(telegram_id);
CREATE INDEX IF NOT EXISTS idx_orders_specialist    ON orders(assigned_specialist_id);

-- ══════════════════════════════════════════════════════════
-- DB helpers — добавить в src/db/index.js
-- ══════════════════════════════════════════════════════════

/*

// Получить специалиста по telegram_id
async function getSpecialistById(telegramId) {
  const res = await pool.query(
    `SELECT * FROM specialists WHERE telegram_id=$1`,
    [telegramId]
  );
  return res.rows[0] || null;
}

// Список всех специалистов
async function getAllSpecialists() {
  const res = await pool.query(
    `SELECT * FROM specialists ORDER BY created_at ASC`
  );
  return res.rows;
}

// Добавить специалиста
async function addSpecialist({ telegramId, name, username, role = 'specialist' }) {
  await pool.query(
    `INSERT INTO specialists (telegram_id, name, username, role)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (telegram_id) DO UPDATE
       SET name=$2, username=$3, role=$4, is_active=TRUE, updated_at=NOW()`,
    [telegramId, name, username || null, role]
  );
}

// Деактивировать специалиста
async function deactivateSpecialist(telegramId) {
  await pool.query(
    `UPDATE specialists SET is_active=FALSE, updated_at=NOW()
     WHERE telegram_id=$1`,
    [telegramId]
  );
}

// Активные заказы (для панели специалиста)
async function getActiveOrders(limit = 20) {
  const res = await pool.query(
    `SELECT o.*, c.first_name, c.username, c.telegram_user_id
     FROM orders o
     LEFT JOIN clients c ON o.client_id = c.id
     WHERE o.status NOT IN ('CANCELLED','CLOSED','DELIVERED')
       AND o.deleted_at IS NULL
     ORDER BY o.created_at DESC
     LIMIT $1`,
    [limit]
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
    [specialistTelegramId]
  );
  return res.rows;
}

// Назначить специалиста на заказ
async function assignSpecialistToOrder(orderNumber, specialistTelegramId) {
  await pool.query(
    `UPDATE orders SET assigned_specialist_id=$2, updated_at=NOW()
     WHERE order_number=$1 AND assigned_specialist_id IS NULL`,
    [orderNumber, specialistTelegramId]
  );
}

// Обновить статус заказа
async function updateOrderStatus(orderNumber, newStatus) {
  await pool.query(
    `UPDATE orders SET status=$2, updated_at=NOW() WHERE order_number=$1`,
    [orderNumber, newStatus]
  );
}

// Обновить статус заявки моделирования
async function updateModelingOrderStatus(orderNumber, status, specialistId, specialistUsername) {
  await pool.query(
    `UPDATE modeling_orders
     SET status=$2, specialist_telegram_id=$3, specialist_username=$4, updated_at=NOW()
     WHERE order_number=$1`,
    [orderNumber, status, specialistId, specialistUsername]
  );
}

*/
