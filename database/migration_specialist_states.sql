-- migration_specialist_states.sql
-- Таблица для хранения временного состояния специалиста
-- (ожидание ввода цены, ввода текста проблемы)

CREATE TABLE IF NOT EXISTS specialist_states (
  telegram_id  BIGINT PRIMARY KEY,
  action       VARCHAR(50) NOT NULL,   -- 'awaiting_price' | 'awaiting_issue_text'
  order_number VARCHAR(20),
  created_at   TIMESTAMP DEFAULT NOW()
);

-- DB helpers — добавить в src/db/index.js

/*

async function setSpecialistState(telegramId, state) {
  await pool.query(
    `INSERT INTO specialist_states (telegram_id, action, order_number)
     VALUES ($1, $2, $3)
     ON CONFLICT (telegram_id) DO UPDATE
       SET action=$2, order_number=$3, created_at=NOW()`,
    [telegramId, state.action, state.orderNumber || null]
  );
}

async function getSpecialistState(telegramId) {
  const res = await pool.query(
    `SELECT * FROM specialist_states WHERE telegram_id=$1`,
    [telegramId]
  );
  if (!res.rows[0]) return null;
  return {
    action:      res.rows[0].action,
    orderNumber: res.rows[0].order_number,
  };
}

async function clearSpecialistState(telegramId) {
  await pool.query(
    `DELETE FROM specialist_states WHERE telegram_id=$1`,
    [telegramId]
  );
}

*/
