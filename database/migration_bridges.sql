-- migration_bridges.sql
-- Таблица мостов специалист ↔ клиент (вместо Map в памяти)

CREATE TABLE IF NOT EXISTS active_bridges (
  id                   SERIAL PRIMARY KEY,
  specialist_chat_id   BIGINT NOT NULL UNIQUE,  -- один специалист = один мост
  client_chat_id       BIGINT NOT NULL,
  order_number         VARCHAR(20),
  specialist_username  VARCHAR(100),
  opened_at            TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_bridges_client ON active_bridges(client_chat_id);
CREATE INDEX IF NOT EXISTS idx_bridges_spec   ON active_bridges(specialist_chat_id);

-- Таблица для хранения message_id карточек в группе
-- (чтобы обновлять "Взял @username")
CREATE TABLE IF NOT EXISTS group_messages (
  id               SERIAL PRIMARY KEY,
  client_telegram_id BIGINT NOT NULL UNIQUE,
  message_id       INTEGER NOT NULL,
  group_id         BIGINT NOT NULL,
  created_at       TIMESTAMP DEFAULT NOW()
);

-- ── DB helpers для bridges — добавить в src/db/index.js ──────────────────

/*

async function createBridge({ specialistChatId, clientChatId, orderNumber, specialistUsername }) {
  await pool.query(
    `INSERT INTO active_bridges
       (specialist_chat_id, client_chat_id, order_number, specialist_username)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (specialist_chat_id) DO UPDATE
       SET client_chat_id=$2, order_number=$3, specialist_username=$4, opened_at=NOW()`,
    [specialistChatId, clientChatId, orderNumber, specialistUsername]
  );
}

async function deleteBridge(specialistChatId) {
  await pool.query(
    `DELETE FROM active_bridges WHERE specialist_chat_id=$1`,
    [specialistChatId]
  );
}

async function getBridgeBySpecialist(specialistChatId) {
  const res = await pool.query(
    `SELECT * FROM active_bridges WHERE specialist_chat_id=$1`,
    [specialistChatId]
  );
  return res.rows[0] || null;
}

async function getBridgeByClient(clientChatId) {
  const res = await pool.query(
    `SELECT * FROM active_bridges WHERE client_chat_id=$1`,
    [clientChatId]
  );
  return res.rows[0] || null;
}

// Ищет мост с любой стороны (специалист ИЛИ клиент)
async function getBridgeByAnyParty(chatId) {
  const res = await pool.query(
    `SELECT * FROM active_bridges
     WHERE specialist_chat_id=$1 OR client_chat_id=$1
     LIMIT 1`,
    [chatId]
  );
  return res.rows[0] || null;
}

async function saveGroupMessageId(clientTelegramId, messageId, groupId) {
  await pool.query(
    `INSERT INTO group_messages (client_telegram_id, message_id, group_id)
     VALUES ($1, $2, $3)
     ON CONFLICT (client_telegram_id) DO UPDATE
       SET message_id=$2, group_id=$3, created_at=NOW()`,
    [clientTelegramId, messageId, groupId]
  );
}

async function getGroupMessageId(clientTelegramId) {
  const res = await pool.query(
    `SELECT * FROM group_messages WHERE client_telegram_id=$1`,
    [clientTelegramId]
  );
  return res.rows[0] || null;
}

async function resetSessionStep(chatId, step) {
  await pool.query(
    `UPDATE dialog_sessions SET current_step=$2, updated_at=NOW()
     WHERE chat_id=$1`,
    [chatId, step]
  );
}

*/
