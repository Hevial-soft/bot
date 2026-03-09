-- ═══════════════════════════════════════════════════════════════════════════
-- МИГРАЦИЯ: таблица ai_prompts
-- Запуск: psql -U postgres -d hevial_db -f add_ai_prompts.sql
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS ai_prompts (
    id              SERIAL      PRIMARY KEY,
    key             VARCHAR(50) NOT NULL UNIQUE,
    description     TEXT,
    system_prompt   TEXT        NOT NULL,
    user_template   TEXT        NOT NULL,
    version         INTEGER     NOT NULL DEFAULT 1,
    is_active       BOOLEAN     NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMP   NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMP   NOT NULL DEFAULT NOW()
)

CREATE TRIGGER trg_ai_prompts_updated
    BEFORE UPDATE ON ai_prompts
    FOR EACH ROW EXECUTE FUNCTION update_updated_at()

INSERT INTO ai_prompts (key, description, system_prompt, user_template, version)
VALUES (
    'material_suggest',
    'Подбор одного материала по описанию задачи клиента',
    'Ты эксперт по 3D-печати в бюро Hevial.
Твоя задача — выбрать ОДИН наиболее подходящий материал из каталога.

Правила:
1. Отвечай СТРОГО одним кодом материала из списка допустимых
2. Никакого другого текста — только код. Например: PETG
3. Не добавляй точки, запятые, скобки и пояснения
4. Учитывай: среду использования, нагрузки, температуру, контакт с едой/кожей
5. Если задача неоднозначная — выбери наиболее универсальный вариант
6. Если совсем не уверен — выбери PETG

Допустимые коды: {{MATERIAL_CODES}}',
    'Задача клиента: "{{USE_DESCRIPTION}}"

Каталог материалов:
{{CATALOG}}

Выбери один код материала:',
    1
)
ON CONFLICT (key) DO UPDATE SET
    system_prompt = EXCLUDED.system_prompt,
    user_template = EXCLUDED.user_template,
    version       = ai_prompts.version + 1,
    updated_at    = NOW()

SELECT key, version, is_active, updated_at FROM ai_prompts
