-- migration_v2.sql
-- Персистентные сессии + ветка 3D-моделирования

-- ══════════════════════════════════════════════════════════
-- 1. Таблица сессий (была в памяти, теперь в БД)
-- ══════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS dialog_sessions (
  id                  SERIAL PRIMARY KEY,
  telegram_id         BIGINT NOT NULL,
  chat_id             BIGINT NOT NULL,
  current_step        VARCHAR(60) NOT NULL DEFAULT 'START',
  order_type          VARCHAR(20),           -- 'PRINT' | 'MODELING'

  -- Печать
  file_id             TEXT,
  file_name           TEXT,
  photo_id            TEXT,
  use_description     TEXT,
  suggested_material  VARCHAR(20),
  client_material_wish VARCHAR(20),
  confirmed_material  VARCHAR(20),
  confirmed_method    VARCHAR(10),
  material_overridden BOOLEAN DEFAULT FALSE,
  size_x              INTEGER,
  size_y              INTEGER,
  size_z              INTEGER,
  volume_cm3          NUMERIC(10,3),
  quantity            INTEGER,
  urgency             VARCHAR(20),
  delivery_type       VARCHAR(20),
  order_id            INTEGER REFERENCES orders(id),
  order_number        VARCHAR(20),

  -- Моделирование
  is_reverse          BOOLEAN DEFAULT FALSE,
  modeling_delivery   VARCHAR(20),
  modeling_urgency    VARCHAR(20),

  -- Состояние
  awaiting_specialist BOOLEAN DEFAULT FALSE,
  retry_count         INTEGER DEFAULT 0,
  updated_at          TIMESTAMP DEFAULT NOW(),
  created_at          TIMESTAMP DEFAULT NOW(),

  UNIQUE (telegram_id, chat_id)
);

CREATE INDEX IF NOT EXISTS idx_sessions_telegram_id ON dialog_sessions(telegram_id);

-- ══════════════════════════════════════════════════════════
-- 2. Таблица заказов на моделирование
-- ══════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS modeling_orders (
  id              SERIAL PRIMARY KEY,
  order_number    VARCHAR(20) UNIQUE NOT NULL,
  client_id       INTEGER REFERENCES clients(id),
  telegram_id     BIGINT NOT NULL,
  status          VARCHAR(30) DEFAULT 'NEW',

  use_description TEXT,
  size_x          INTEGER,
  size_y          INTEGER,
  size_z          INTEGER,
  is_reverse      BOOLEAN DEFAULT FALSE,
  delivery_type   VARCHAR(20),
  urgency         VARCHAR(20) DEFAULT 'STANDARD',
  photo_id        TEXT,

  -- Назначенный специалист (берёт из группы)
  specialist_telegram_id BIGINT,
  specialist_username    VARCHAR(100),

  price           NUMERIC(10,2),
  notes           TEXT,

  created_at      TIMESTAMP DEFAULT NOW(),
  updated_at      TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_modeling_telegram ON modeling_orders(telegram_id);
CREATE INDEX IF NOT EXISTS idx_modeling_status   ON modeling_orders(status);

-- Триггер обновления updated_at
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_sessions_updated_at
  BEFORE UPDATE ON dialog_sessions
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER trg_modeling_updated_at
  BEFORE UPDATE ON modeling_orders
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ══════════════════════════════════════════════════════════
-- 3. Добавить volume_cm3 в orders если нет
-- ══════════════════════════════════════════════════════════

ALTER TABLE orders ADD COLUMN IF NOT EXISTS volume_cm3 NUMERIC(10,3);

-- ══════════════════════════════════════════════════════════
-- 4. Обновить переменную окружения в .env
-- ══════════════════════════════════════════════════════════
-- Добавить в .env:
-- SPECIALIST_GROUP_ID=-1005108386100
-- (убрать SPECIALIST_CHAT_ID — больше не нужен)
