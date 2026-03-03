-- ═══════════════════════════════════════════════════════════════════════════
-- HEVIAL — Полная схема базы данных
-- PostgreSQL 14+
-- Версия 2.0 — материалы + клиенты + заказы + диалог
-- ═══════════════════════════════════════════════════════════════════════════

-- ───────────────────────────────────────────────────────────────────────────
-- ОЧИСТКА (осторожно на продакшене!)
-- ───────────────────────────────────────────────────────────────────────────
DROP TABLE IF EXISTS dialog_message     CASCADE;
DROP TABLE IF EXISTS order_status_log   CASCADE;
DROP TABLE IF EXISTS orders             CASCADE;
DROP TABLE IF EXISTS clients            CASCADE;
DROP TABLE IF EXISTS material_use_cases CASCADE;
DROP TABLE IF EXISTS material_exclusions CASCADE;
DROP TABLE IF EXISTS production_time    CASCADE;
DROP TABLE IF EXISTS material           CASCADE;
DROP TABLE IF EXISTS print_method       CASCADE;
DROP TABLE IF EXISTS pricing_config     CASCADE;

DROP SEQUENCE IF EXISTS order_number_seq;
DROP FUNCTION IF EXISTS update_updated_at()    CASCADE;
DROP FUNCTION IF EXISTS generate_order_number() CASCADE;
DROP FUNCTION IF EXISTS log_order_status()      CASCADE;


-- ═══════════════════════════════════════════════════════════════════════════
-- БЛОК 1 — СПРАВОЧНИК МАТЕРИАЛОВ
-- ═══════════════════════════════════════════════════════════════════════════

-- 1.1 Методы печати
CREATE TABLE print_method (
    id                  SERIAL          PRIMARY KEY,
    code                VARCHAR(10)     NOT NULL UNIQUE,
    name                VARCHAR(100)    NOT NULL,
    max_size_x          INTEGER         NOT NULL,
    max_size_y          INTEGER         NOT NULL,
    max_size_z          INTEGER         NOT NULL,
    layer_height_min    NUMERIC(4,2)    NOT NULL,
    layer_height_max    NUMERIC(4,2)    NOT NULL,
    base_days_min       INTEGER         NOT NULL,
    base_days_max       INTEGER         NOT NULL,
    surface_note        TEXT,
    notes               TEXT,
    is_active           BOOLEAN         NOT NULL DEFAULT TRUE,
    created_at          TIMESTAMP       NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMP       NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE  print_method              IS 'Методы 3D-печати (FDM, RESIN)';
COMMENT ON COLUMN print_method.surface_note IS 'Предупреждение о поверхности для бота';

-- 1.2 Материалы
CREATE TABLE material (
    id                  SERIAL          PRIMARY KEY,
    method_id           INTEGER         NOT NULL REFERENCES print_method(id),
    code                VARCHAR(30)     NOT NULL UNIQUE,
    name                VARCHAR(50)     NOT NULL,
    display_name        VARCHAR(100),

    -- Механика (1-10)
    strength            SMALLINT        CHECK (strength            BETWEEN 1 AND 10),
    flexibility         SMALLINT        CHECK (flexibility         BETWEEN 1 AND 10),
    impact_resistance   SMALLINT        CHECK (impact_resistance   BETWEEN 1 AND 10),

    -- Температура и среда
    temp_resistance_max INTEGER,
    cold_resistance     BOOLEAN         NOT NULL DEFAULT FALSE,
    uv_resistance       BOOLEAN         NOT NULL DEFAULT FALSE,
    chemical_resistance BOOLEAN         NOT NULL DEFAULT FALSE,

    -- Визуал
    is_transparent      BOOLEAN         NOT NULL DEFAULT FALSE,
    is_glossy           BOOLEAN         NOT NULL DEFAULT FALSE,
    detail_level        SMALLINT        CHECK (detail_level        BETWEEN 1 AND 10),

    -- Безопасность
    food_safe           BOOLEAN         NOT NULL DEFAULT FALSE,
    skin_safe           BOOLEAN         NOT NULL DEFAULT FALSE,
    toxic_fumes         BOOLEAN         NOT NULL DEFAULT FALSE,

    -- Производство
    time_multiplier     NUMERIC(4,2)    NOT NULL DEFAULT 1.0,
    price_per_gram      NUMERIC(8,2),

    -- Управление
    is_active           BOOLEAN         NOT NULL DEFAULT TRUE,
    sort_order          INTEGER         NOT NULL DEFAULT 0,
    created_at          TIMESTAMP       NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMP       NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE  material                IS 'Материалы для 3D-печати';
COMMENT ON COLUMN material.time_multiplier IS 'Множитель базового времени (1.0 = норма)';
COMMENT ON COLUMN material.detail_level    IS '10 = максимум (фотополимер)';

-- 1.3 Сценарии применения
CREATE TABLE material_use_cases (
    id          SERIAL          PRIMARY KEY,
    material_id INTEGER         NOT NULL REFERENCES material(id) ON DELETE CASCADE,
    use_case    VARCHAR(100)    NOT NULL
);

-- 1.4 Исключения
CREATE TABLE material_exclusions (
    id          SERIAL          PRIMARY KEY,
    material_id INTEGER         NOT NULL REFERENCES material(id) ON DELETE CASCADE,
    exclusion   VARCHAR(100)    NOT NULL
);

-- 1.5 Сроки по размеру
CREATE TABLE production_time (
    id              SERIAL          PRIMARY KEY,
    method_id       INTEGER         NOT NULL REFERENCES print_method(id),
    category        VARCHAR(20)     NOT NULL,
    max_dimension   INTEGER,
    days_min        INTEGER,
    days_max        INTEGER,
    notes           TEXT,
    sort_order      INTEGER         NOT NULL DEFAULT 0
);

-- 1.6 Конфигурация цен
CREATE TABLE pricing_config (
    id              SERIAL          PRIMARY KEY,
    key             VARCHAR(50)     NOT NULL UNIQUE,
    value           NUMERIC(10,2)   NOT NULL,
    description     TEXT,
    updated_at      TIMESTAMP       NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE pricing_config IS 'Настройки цен — менять здесь без правки кода';


-- ═══════════════════════════════════════════════════════════════════════════
-- БЛОК 2 — КЛИЕНТЫ
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE clients (
    id                  SERIAL          PRIMARY KEY,
    telegram_user_id    BIGINT          NOT NULL UNIQUE,
    username            VARCHAR(50),
    first_name          VARCHAR(100)    NOT NULL,
    last_name           VARCHAR(100),
    phone               VARCHAR(20),
    city                VARCHAR(100),
    district_moscow     VARCHAR(100),

    -- Предпочтения
    delivery_default    VARCHAR(20)     CHECK (delivery_default IN
                            ('COURIER', 'SDEK', 'PICKUP')),

    -- Статистика
    orders_count        INTEGER         NOT NULL DEFAULT 0,
    total_spent         NUMERIC(12,2)   NOT NULL DEFAULT 0,

    -- Управление
    is_blocked          BOOLEAN         NOT NULL DEFAULT FALSE,
    block_reason        TEXT,
    created_at          TIMESTAMP       NOT NULL DEFAULT NOW(),
    last_seen           TIMESTAMP       NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMP       NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE  clients                    IS 'Клиенты Telegram-бота';
COMMENT ON COLUMN clients.telegram_user_id   IS 'Уникальный Telegram ID, не меняется';
COMMENT ON COLUMN clients.district_moscow    IS 'Район для расчёта курьерской доставки';


-- ═══════════════════════════════════════════════════════════════════════════
-- БЛОК 3 — ЗАКАЗЫ
-- ═══════════════════════════════════════════════════════════════════════════

-- Счётчик для красивой нумерации HVL-00001
CREATE SEQUENCE order_number_seq START 1;

CREATE TABLE orders (
    id                  SERIAL          PRIMARY KEY,
    order_number        VARCHAR(15)     NOT NULL UNIQUE
                            DEFAULT 'HVL-' || LPAD(
                                nextval('order_number_seq')::TEXT, 5, '0'),

    -- Клиент
    client_id           INTEGER         NOT NULL REFERENCES clients(id),

    -- Статус
    status              VARCHAR(20)     NOT NULL DEFAULT 'NEW'
                            CHECK (status IN (
                                'NEW', 'PROCESSING', 'ACCEPTED',
                                'PAID', 'IN_PROGRESS', 'READY',
                                'DELIVERED', 'CLOSED')),

    -- Производство
    method_code         VARCHAR(10)     REFERENCES print_method(code),
    material_code       VARCHAR(30)     REFERENCES material(code),
    client_material_wish VARCHAR(30),   -- что хотел клиент изначально
    material_overridden BOOLEAN         NOT NULL DEFAULT FALSE,
                                        -- TRUE если клиент выбрал вопреки рекомендации

    -- Размеры
    size_x              INTEGER,
    size_y              INTEGER,
    size_z              INTEGER,
    weight_grams        NUMERIC(8,2),

    -- Заказ
    quantity            INTEGER         NOT NULL DEFAULT 1,
    is_batch            BOOLEAN         NOT NULL DEFAULT FALSE,

    -- Файлы и описание
    file_url            TEXT,
    photo_url           TEXT,
    use_description     TEXT,           -- описание среды использования от клиента

    -- Срочность
    urgency             VARCHAR(20)     NOT NULL DEFAULT 'STANDARD'
                            CHECK (urgency IN (
                                'STANDARD', 'PLUS200', 'PLUS500', 'PLUS800')),

    -- Доставка
    delivery_type       VARCHAR(20)     NOT NULL DEFAULT 'COURIER'
                            CHECK (delivery_type IN (
                                'COURIER', 'SDEK', 'PICKUP')),
    delivery_address    TEXT,

    -- Стоимость
    base_price          NUMERIC(10,2),
    urgency_fee         NUMERIC(10,2)   NOT NULL DEFAULT 0,
    delivery_fee        NUMERIC(10,2)   NOT NULL DEFAULT 0,
    total_price         NUMERIC(10,2),

    -- Оплата (ЮКасса — заглушка)
    payment_id          VARCHAR(100),
    payment_status      VARCHAR(20)     DEFAULT 'PENDING'
                            CHECK (payment_status IN (
                                'PENDING', 'PAID', 'FAILED', 'REFUNDED')),
    paid_at             TIMESTAMP,

    -- Сроки
    ready_date          DATE,
    delivered_at        TIMESTAMP,

    -- Отзыв
    review_sent         BOOLEAN         NOT NULL DEFAULT FALSE,
    review_sent_at      TIMESTAMP,
    review_text         TEXT,
    review_rating       SMALLINT        CHECK (review_rating BETWEEN 1 AND 5),

    -- Заметки
    specialist_note     TEXT,
    cancel_reason       TEXT,

    -- Системные
    created_at          TIMESTAMP       NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMP       NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE  orders                      IS 'Заказы клиентов';
COMMENT ON COLUMN orders.order_number         IS 'Публичный номер HVL-00001';
COMMENT ON COLUMN orders.material_overridden  IS 'TRUE = клиент выбрал вопреки рекомендации ИИ';
COMMENT ON COLUMN orders.client_material_wish IS 'Что хотел клиент до рекомендации ИИ';
COMMENT ON COLUMN orders.payment_id           IS 'ID платежа ЮКасса (заглушка до интеграции)';

-- Лог изменений статуса заказа
CREATE TABLE order_status_log (
    id              SERIAL          PRIMARY KEY,
    order_id        INTEGER         NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    order_number    VARCHAR(15)     NOT NULL,
    old_status      VARCHAR(20),
    new_status      VARCHAR(20)     NOT NULL,
    changed_by      VARCHAR(50),    -- 'BOT', 'SPECIALIST', 'SYSTEM', 'YUKASSA'
    note            TEXT,
    created_at      TIMESTAMP       NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE order_status_log IS 'История смены статусов — для аудита и отладки';


-- ═══════════════════════════════════════════════════════════════════════════
-- БЛОК 4 — ИСТОРИЯ ДИАЛОГА
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE dialog_message (
    id              SERIAL          PRIMARY KEY,
    order_id        INTEGER         REFERENCES orders(id) ON DELETE SET NULL,
    order_number    VARCHAR(15),    -- дублируем для быстрого поиска
    client_id       INTEGER         NOT NULL REFERENCES clients(id),
    session_id      VARCHAR(50)     NOT NULL,   -- UUID сессии

    -- Сообщение
    role            VARCHAR(10)     NOT NULL
                        CHECK (role IN ('BOT', 'USER', 'SYSTEM')),
    message_type    VARCHAR(20)     NOT NULL DEFAULT 'TEXT'
                        CHECK (message_type IN (
                            'TEXT', 'PHOTO', 'FILE', 'BUTTON',
                            'STICKER', 'SYSTEM_EVENT')),
    message_text    TEXT,
    file_id         TEXT,           -- Telegram file_id

    -- Контекст
    dialog_step     VARCHAR(50),    -- текущий шаг диалога
    telegram_msg_id BIGINT,         -- ID сообщения в Telegram

    created_at      TIMESTAMP       NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE  dialog_message            IS 'Полная история диалога по каждому заказу';
COMMENT ON COLUMN dialog_message.session_id IS 'UUID сессии от /start до закрытия заказа';
COMMENT ON COLUMN dialog_message.order_number IS 'Дублируется для поиска без JOIN';


-- ═══════════════════════════════════════════════════════════════════════════
-- ИНДЕКСЫ
-- ═══════════════════════════════════════════════════════════════════════════

-- Материалы
CREATE INDEX idx_material_method        ON material(method_id);
CREATE INDEX idx_material_active        ON material(is_active);
CREATE INDEX idx_material_code          ON material(code);
CREATE INDEX idx_use_cases_material     ON material_use_cases(material_id);
CREATE INDEX idx_exclusions_material    ON material_exclusions(material_id);
CREATE INDEX idx_prod_time_method       ON production_time(method_id);

-- Клиенты
CREATE INDEX idx_clients_telegram_id    ON clients(telegram_user_id);
CREATE INDEX idx_clients_username       ON clients(username);

-- Заказы
CREATE INDEX idx_orders_client          ON orders(client_id);
CREATE INDEX idx_orders_status          ON orders(status);
CREATE INDEX idx_orders_number          ON orders(order_number);
CREATE INDEX idx_orders_created         ON orders(created_at DESC);
CREATE INDEX idx_orders_review_pending  ON orders(review_sent)
                                        WHERE status = 'DELIVERED'
                                          AND review_sent = FALSE;

-- Диалог
CREATE INDEX idx_dialog_order_id        ON dialog_message(order_id);
CREATE INDEX idx_dialog_order_number    ON dialog_message(order_number);
CREATE INDEX idx_dialog_client          ON dialog_message(client_id);
CREATE INDEX idx_dialog_session         ON dialog_message(session_id);
CREATE INDEX idx_dialog_created         ON dialog_message(created_at DESC);


-- ═══════════════════════════════════════════════════════════════════════════
-- ТРИГГЕРЫ
-- ═══════════════════════════════════════════════════════════════════════════

-- Автообновление updated_at
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_print_method_updated
    BEFORE UPDATE ON print_method
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER trg_material_updated
    BEFORE UPDATE ON material
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER trg_clients_updated
    BEFORE UPDATE ON clients
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER trg_orders_updated
    BEFORE UPDATE ON orders
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- Лог смены статуса заказа (автоматически)
CREATE OR REPLACE FUNCTION log_order_status()
RETURNS TRIGGER AS $$
BEGIN
    IF OLD.status IS DISTINCT FROM NEW.status THEN
        INSERT INTO order_status_log
            (order_id, order_number, old_status, new_status, changed_by)
        VALUES
            (NEW.id, NEW.order_number, OLD.status, NEW.status, 'SYSTEM');
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_order_status_log
    AFTER UPDATE ON orders
    FOR EACH ROW EXECUTE FUNCTION log_order_status();

-- Обновление статистики клиента при закрытии заказа
CREATE OR REPLACE FUNCTION update_client_stats()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.status = 'CLOSED' AND OLD.status != 'CLOSED' THEN
        UPDATE clients
        SET orders_count = orders_count + 1,
            total_spent  = total_spent + COALESCE(NEW.total_price, 0)
        WHERE id = NEW.client_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_client_stats
    AFTER UPDATE ON orders
    FOR EACH ROW EXECUTE FUNCTION update_client_stats();


-- ═══════════════════════════════════════════════════════════════════════════
-- ПРЕДСТАВЛЕНИЯ (VIEW)
-- ═══════════════════════════════════════════════════════════════════════════

-- Полная карточка материала для ИИ
CREATE OR REPLACE VIEW v_material_full AS
SELECT
    m.id,
    m.code,
    m.name,
    m.display_name,
    pm.code                     AS method_code,
    pm.name                     AS method_name,
    pm.surface_note,
    m.strength,
    m.flexibility,
    m.impact_resistance,
    m.temp_resistance_max,
    m.cold_resistance,
    m.uv_resistance,
    m.chemical_resistance,
    m.is_transparent,
    m.is_glossy,
    m.detail_level,
    m.food_safe,
    m.skin_safe,
    m.toxic_fumes,
    m.time_multiplier,
    m.price_per_gram,
    COALESCE(
        ARRAY_AGG(DISTINCT uc.use_case)
        FILTER (WHERE uc.use_case IS NOT NULL), ARRAY[]::TEXT[]
    )                           AS use_cases,
    COALESCE(
        ARRAY_AGG(DISTINCT ex.exclusion)
        FILTER (WHERE ex.exclusion IS NOT NULL), ARRAY[]::TEXT[]
    )                           AS exclusions
FROM material m
JOIN print_method pm        ON pm.id = m.method_id
LEFT JOIN material_use_cases uc ON uc.material_id = m.id
LEFT JOIN material_exclusions ex ON ex.material_id = m.id
WHERE m.is_active = TRUE AND pm.is_active = TRUE
GROUP BY m.id, pm.id, pm.code, pm.name, pm.surface_note
ORDER BY m.sort_order;

COMMENT ON VIEW v_material_full IS 'Полная карточка материала — используется ИИ';

-- Активные заказы с клиентом
CREATE OR REPLACE VIEW v_orders_active AS
SELECT
    o.order_number,
    o.status,
    c.first_name || ' ' || COALESCE(c.last_name, '') AS client_name,
    c.username,
    c.telegram_user_id,
    o.method_code,
    o.material_code,
    o.quantity,
    o.total_price,
    o.urgency,
    o.delivery_type,
    o.ready_date,
    o.created_at
FROM orders o
JOIN clients c ON c.id = o.client_id
WHERE o.status NOT IN ('CLOSED', 'DELIVERED')
ORDER BY o.created_at DESC;

COMMENT ON VIEW v_orders_active IS 'Активные заказы — для дашборда специалиста';

-- Заказы ожидающие отзыва
CREATE OR REPLACE VIEW v_orders_pending_review AS
SELECT
    o.order_number,
    o.delivered_at,
    c.telegram_user_id,
    c.first_name
FROM orders o
JOIN clients c ON c.id = o.client_id
WHERE o.status = 'DELIVERED'
  AND o.review_sent = FALSE
ORDER BY o.delivered_at;

COMMENT ON VIEW v_orders_pending_review IS 'Заказы которым ещё не отправлен запрос отзыва';

-- Полный диалог по номеру заказа
CREATE OR REPLACE VIEW v_dialog_by_order AS
SELECT
    dm.order_number,
    dm.session_id,
    dm.role,
    dm.message_type,
    dm.dialog_step,
    dm.message_text,
    dm.created_at
FROM dialog_message dm
ORDER BY dm.order_number, dm.created_at;

COMMENT ON VIEW v_dialog_by_order IS 'Полный диалог — вызов: WHERE order_number = HVL-00001';


-- ═══════════════════════════════════════════════════════════════════════════
-- ДАННЫЕ — МЕТОДЫ ПЕЧАТИ
-- ═══════════════════════════════════════════════════════════════════════════
INSERT INTO print_method
    (code, name, max_size_x, max_size_y, max_size_z,
     layer_height_min, layer_height_max,
     base_days_min, base_days_max,
     surface_note, notes)
VALUES
    ('FDM', 'Filament (FDM/FFF)',
     250, 250, 220, 0.10, 0.30, 1, 3,
     'Слои печати будут видны и ощущаться на ощупь',
     'Единичный заказ до 220×220×230 мм. Партия — через специалиста.'),

    ('RESIN', 'Фотополимер (SLA/MSLA)',
     218, 123, 260, 0.02, 0.05, 5, 5,
     'Поверхность гладкая, слои практически незаметны',
     'Anycubic Photon Mono Max. Срок всегда 5 дней.');

-- ═══════════════════════════════════════════════════════════════════════════
-- ДАННЫЕ — МАТЕРИАЛЫ
-- ═══════════════════════════════════════════════════════════════════════════
INSERT INTO material
    (method_id, code, name, display_name,
     strength, flexibility, impact_resistance,
     temp_resistance_max, cold_resistance, uv_resistance, chemical_resistance,
     is_transparent, is_glossy, detail_level,
     food_safe, skin_safe, toxic_fumes,
     time_multiplier, price_per_gram, sort_order)
VALUES
    (1,'PLA',       'PLA',        'PLA (стандартный)',
     6,3,4,  60,  FALSE,FALSE,FALSE, FALSE,FALSE,7, TRUE, TRUE, FALSE, 1.0, 2.50, 10),
    (1,'PETG',      'PETG',       'PETG (универсальный)',
     7,5,6,  80,  TRUE, TRUE, TRUE,  TRUE, FALSE,6, TRUE, TRUE, FALSE, 1.1, 3.00, 20),
    (1,'ABS',       'ABS',        'ABS (технический)',
     7,4,7,  105, TRUE, FALSE,TRUE,  FALSE,FALSE,6, FALSE,FALSE,TRUE,  1.2, 2.80, 30),
    (1,'TPU',       'TPU',        'TPU (гибкий)',
     5,10,8, 80,  TRUE, TRUE, FALSE, FALSE,FALSE,5, FALSE,TRUE, FALSE, 1.4, 4.50, 40),
    (1,'PEEK',      'PEEK',       'PEEK (инженерный)',
     10,3,8, 250, TRUE, TRUE, TRUE,  FALSE,FALSE,7, TRUE, TRUE, FALSE, 2.0,35.00, 50),
    (1,'NYLON',     'Nylon (PA)', 'Nylon (прочный)',
     8,6,9,  120, TRUE, TRUE, TRUE,  FALSE,FALSE,6, FALSE,TRUE, FALSE, 1.3, 5.00, 60),
    (1,'PC',        'PC',         'PC (поликарбонат)',
     9,4,9,  135, TRUE, TRUE, TRUE,  TRUE, FALSE,7, FALSE,TRUE, FALSE, 1.4, 6.00, 70),
    (1,'SBS',       'SBS',        'SBS (прозрачный)',
     6,6,5,  75,  TRUE, TRUE, FALSE, TRUE, FALSE,7, TRUE, TRUE, FALSE, 1.1, 3.50, 80),
    (1,'SILK',      'Silk PLA',   'Silk PLA (декоративный)',
     5,2,3,  55,  FALSE,FALSE,FALSE, FALSE,TRUE, 8, FALSE,FALSE,FALSE, 1.0, 3.00, 90),
    (2,'RESIN_STD', 'Resin Std',  'Фотополимер стандартный',
     6,2,4,  60,  FALSE,FALSE,FALSE, TRUE, TRUE, 10,FALSE,FALSE,TRUE,  1.0, 8.00,100),
    (2,'RESIN_FLEX','Resin Flex', 'Фотополимер гибкий/инженерный',
     7,7,7,  80,  TRUE, FALSE,TRUE,  FALSE,FALSE,10,FALSE,TRUE, TRUE,  1.0,10.00,110);

-- ═══════════════════════════════════════════════════════════════════════════
-- ДАННЫЕ — СЦЕНАРИИ ПРИМЕНЕНИЯ
-- ═══════════════════════════════════════════════════════════════════════════
INSERT INTO material_use_cases (material_id, use_case) VALUES
    (1,'прототипы'),(1,'декор и интерьер'),(1,'сувениры'),(1,'украшения'),
    (2,'механические детали'),(2,'ёмкости'),(2,'уличное применение'),
    (2,'контакт с едой'),(2,'контакт с кожей'),(2,'прозрачные детали'),
    (3,'технические детали'),(3,'корпуса'),(3,'автодетали'),
    (3,'высокая рабочая температура'),
    (4,'уплотнители'),(4,'чехлы'),(4,'гибкие детали'),
    (4,'виброгасители'),(4,'контакт с кожей'),
    (5,'экстремальные температуры'),(5,'химическая среда'),
    (5,'медицина'),(5,'авиация'),(5,'высоконагруженные детали'),
    (6,'шестерни'),(6,'петли и шарниры'),(6,'износостойкие детали'),
    (7,'прозрачные детали'),(7,'ударопрочные корпуса'),(7,'оптика'),
    (8,'прозрачные изделия'),(8,'контакт с едой'),(8,'контакт с кожей'),
    (9,'декор'),(9,'сувениры'),(9,'украшения и бижутерия'),(9,'арт-объекты'),
    (10,'высокая точность'),(10,'ювелирка'),(10,'миниатюры'),
    (10,'мелкие детали'),(10,'стоматология'),
    (11,'гибкие точные детали'),(11,'инженерные прототипы'),
    (11,'точные уплотнители');

-- ═══════════════════════════════════════════════════════════════════════════
-- ДАННЫЕ — ИСКЛЮЧЕНИЯ
-- ═══════════════════════════════════════════════════════════════════════════
INSERT INTO material_exclusions (material_id, exclusion) VALUES
    (1,'уличное использование'),(1,'нагрев выше 50°C'),(1,'мороз'),(1,'нагрузки'),
    (3,'контакт с едой'),(3,'контакт с кожей'),(3,'без вентиляции'),
    (4,'жёсткие несущие конструкции'),
    (5,'декор'),(5,'прототипы без нагрузки'),
    (6,'контакт с едой'),(6,'длительная влажная среда'),
    (7,'контакт с едой'),
    (9,'функциональные детали'),(9,'нагрузки'),(9,'нагрев'),
    (10,'ударные нагрузки'),(10,'гибкость'),(10,'крупные изделия'),
    (11,'крупные изделия'),(11,'декор');

-- ═══════════════════════════════════════════════════════════════════════════
-- ДАННЫЕ — СРОКИ ПРОИЗВОДСТВА
-- ═══════════════════════════════════════════════════════════════════════════
INSERT INTO production_time
    (method_id, category, max_dimension, days_min, days_max, notes, sort_order)
VALUES
    (1,'SMALL',  100, 1, 1, 'До 100 мм по любому габариту', 10),
    (1,'MEDIUM', 180, 1, 2, '100–180 мм', 20),
    (1,'LARGE',  220, 2, 3, '180–220 мм — максимум единичного заказа', 30),
    (1,'BATCH',  NULL,NULL,NULL,'Партия — через специалиста', 40),
    (2,'ANY',    218, 5, 5, 'Всегда 5 дней', 50),
    (2,'SMALL',  50,  3, 4, 'Мелкие единичные — возможно сокращение', 60),
    (2,'BATCH',  NULL,NULL,NULL,'Партия — через специалиста', 70);

-- ═══════════════════════════════════════════════════════════════════════════
-- ДАННЫЕ — КОНФИГУРАЦИЯ ЦЕН
-- ═══════════════════════════════════════════════════════════════════════════
INSERT INTO pricing_config (key, value, description) VALUES
    ('min_order_price',      600,  'Минимальная стоимость заказа (₽)'),
    ('urgency_fee_plus200',  200,  'Наценка срочность: быстрее на 1 день (₽)'),
    ('urgency_fee_plus500',  500,  'Наценка срочность: приоритет (₽)'),
    ('urgency_fee_plus800',  800,  'Наценка срочность: максимум (₽)'),
    ('delivery_courier_fee', 150,  'Себестоимость курьера Москва (заложена в заказ) (₽)'),
    ('delivery_free_from',   0,    'Сумма заказа от которой курьер бесплатен клиенту (₽)');


-- ═══════════════════════════════════════════════════════════════════════════
-- ПРОВЕРОЧНЫЕ ЗАПРОСЫ
-- ═══════════════════════════════════════════════════════════════════════════
-- Все активные материалы с характеристиками:
-- SELECT * FROM v_material_full;

-- Материалы food-safe:
-- SELECT code, name FROM material WHERE food_safe = TRUE AND is_active = TRUE;

-- Сроки FDM по размеру:
-- SELECT * FROM production_time WHERE method_id = 1 ORDER BY sort_order;

-- Все активные заказы:
-- SELECT * FROM v_orders_active;

-- Полный диалог по заказу:
-- SELECT * FROM v_dialog_by_order WHERE order_number = 'HVL-00001';

-- Заказы ожидающие отзыва:
-- SELECT * FROM v_orders_pending_review;

-- Текущие цены:
-- SELECT key, value, description FROM pricing_config ORDER BY key;
