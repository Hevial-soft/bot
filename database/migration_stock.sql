-- migration_stock.sql
-- Система учёта остатков материалов

-- ══════════════════════════════════════════════════════════
-- 1. Текущие остатки
-- ══════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS material_stock (
  id               SERIAL PRIMARY KEY,
  material_code    VARCHAR(20) NOT NULL UNIQUE REFERENCES material(code),
  stock_grams      NUMERIC(10,1) NOT NULL DEFAULT 0,  -- текущий остаток в граммах
  reserved_grams   NUMERIC(10,1) NOT NULL DEFAULT 0,  -- зарезервировано под активные заказы
  min_threshold_g  NUMERIC(10,1) NOT NULL DEFAULT 200, -- порог для уведомления
  updated_at       TIMESTAMP DEFAULT NOW()
);

-- Доступно = stock_grams - reserved_grams
-- Виртуальная колонка можно создать как view или считать в коде

-- ══════════════════════════════════════════════════════════
-- 2. Журнал транзакций
-- ══════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS stock_transactions (
  id               SERIAL PRIMARY KEY,
  material_code    VARCHAR(20) NOT NULL REFERENCES material(code),
  type             VARCHAR(20) NOT NULL,
  -- 'ADD'      — пополнение (купили катушку)
  -- 'USE'      — списание после печати (специалист отчитался)
  -- 'RESERVE'  — резерв под заказ
  -- 'RELEASE'  — снятие резерва (заказ отменён)
  -- 'ADJUST'   — ручная корректировка (инвентаризация)
  amount_grams     NUMERIC(10,1) NOT NULL,   -- всегда положительное
  order_number     VARCHAR(20),              -- ссылка на заказ (для USE/RESERVE/RELEASE)
  specialist_id    BIGINT,                   -- кто внёс запись
  note             TEXT,                     -- комментарий
  created_at       TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_stock_tx_material ON stock_transactions(material_code);
CREATE INDEX IF NOT EXISTS idx_stock_tx_order    ON stock_transactions(order_number);
CREATE INDEX IF NOT EXISTS idx_stock_tx_type     ON stock_transactions(type);

-- ══════════════════════════════════════════════════════════
-- 3. Начальные остатки (заполнить вручную при старте)
-- ══════════════════════════════════════════════════════════
-- Вставляем строки для всех активных материалов
-- stock_grams = начальный остаток в граммах
-- Например: 1 катушка 1кг = 1000г

INSERT INTO material_stock (material_code, stock_grams, min_threshold_g)
VALUES
  ('PLA',        1000, 200),
  ('PETG',       1000, 200),
  ('PLA_SILK',    500, 100),
  ('ASA',         500, 100),
  ('ABS',         500, 100),
  ('TPU',         500, 100),
  ('NYLON',       500, 100),
  ('PA_CF',       500,  50),
  ('PC',          500, 100),
  ('SBS',         250,  50),
  ('RESIN_STD',  1000, 200),
  ('RESIN_ABS',   500, 100),
  ('RESIN_FLEX',  250,  50)
ON CONFLICT (material_code) DO NOTHING;

-- ══════════════════════════════════════════════════════════
-- 4. Триггер — автоматически обновляет material_stock
--    при каждой новой транзакции
-- ══════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION apply_stock_transaction()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.type = 'ADD' OR NEW.type = 'ADJUST' THEN
    -- Пополнение: увеличиваем остаток
    UPDATE material_stock
    SET stock_grams = stock_grams + NEW.amount_grams,
        updated_at  = NOW()
    WHERE material_code = NEW.material_code;

  ELSIF NEW.type = 'USE' THEN
    -- Списание: уменьшаем остаток и резерв
    UPDATE material_stock
    SET stock_grams    = GREATEST(0, stock_grams - NEW.amount_grams),
        reserved_grams = GREATEST(0, reserved_grams - NEW.amount_grams),
        updated_at     = NOW()
    WHERE material_code = NEW.material_code;

  ELSIF NEW.type = 'RESERVE' THEN
    -- Резервирование: увеличиваем зарезервированное
    UPDATE material_stock
    SET reserved_grams = reserved_grams + NEW.amount_grams,
        updated_at     = NOW()
    WHERE material_code = NEW.material_code;

  ELSIF NEW.type = 'RELEASE' THEN
    -- Снятие резерва: уменьшаем зарезервированное
    UPDATE material_stock
    SET reserved_grams = GREATEST(0, reserved_grams - NEW.amount_grams),
        updated_at     = NOW()
    WHERE material_code = NEW.material_code;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_stock_transaction
  AFTER INSERT ON stock_transactions
  FOR EACH ROW EXECUTE FUNCTION apply_stock_transaction();

-- ══════════════════════════════════════════════════════════
-- 5. View: удобный просмотр остатков
-- ══════════════════════════════════════════════════════════

CREATE OR REPLACE VIEW v_stock AS
SELECT
  ms.material_code,
  m.display_name,
  m.type,
  ms.stock_grams,
  ms.reserved_grams,
  GREATEST(0, ms.stock_grams - ms.reserved_grams) AS available_grams,
  ms.min_threshold_g,
  CASE
    WHEN GREATEST(0, ms.stock_grams - ms.reserved_grams) <= 0 THEN 'OUT'
    WHEN GREATEST(0, ms.stock_grams - ms.reserved_grams) < ms.min_threshold_g THEN 'LOW'
    ELSE 'OK'
  END AS status,
  ms.updated_at
FROM material_stock ms
JOIN material m ON ms.material_code = m.code
ORDER BY m.type, ms.material_code;

-- Проверка:
-- SELECT * FROM v_stock;
