const Anthropic = require('@anthropic-ai/sdk');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── Эвристика по ключевым словам (быстро, без API) ───────────────────────

function suggestMaterialLocal(useDescription) {
  const desc = useDescription.toLowerCase();

  const has = (...words) => words.some(w => desc.includes(w));

  if (has('точн', 'детал', 'ювелир', 'миниатюр', 'зуб', 'стомат', 'мелк'))
    return 'RESIN_STD';
  if (has('гибк', 'эластич') && has('точн', 'маленьк'))
    return 'RESIN_FLEX';
  if (has('гибк', 'мягк', 'резин', 'уплотн', 'чехол', 'виброгас'))
    return 'TPU';
  if (has('peek', 'экстрем', 'авиа', 'медицин', 'химическ', 'агрессив'))
    return 'PEEK';
  if (has('шестерн', 'зубчат', 'износ', 'удар', 'петл', 'шарнир', 'трение'))
    return 'NYLON';
  if (has('прозрач') && has('удар', 'прочн'))
    return 'PC';
  if (has('высок', 'температур', 'корпус', 'автомобил'))
    return 'ABS';
  if (has('улиц', 'наруж', 'мороз', 'еда', 'вода', 'прозрач'))
    return 'PETG';
  if (has('декор', 'сувенир', 'украшен', 'блест', 'подарок'))
    return 'SILK';

  return 'PLA'; // дефолт
}

// ── Вызов Claude API для умного подбора ──────────────────────────────────

async function suggestMaterialAI(useDescription, materials) {
  try {
    // Формируем краткое описание каталога для промпта
    const catalog = materials.map(m =>
      `${m.code} (${m.method_code}): прочность=${m.strength}, гибкость=${m.flexibility}, ` +
      `темп до ${m.temp_resistance_max}°C, ` +
      `food_safe=${m.food_safe}, uv=${m.uv_resistance}, cold=${m.cold_resistance}. ` +
      `Применение: ${m.use_cases.slice(0, 3).join(', ')}. ` +
      `Не подходит: ${m.exclusions.slice(0, 2).join(', ')}.`
    ).join('\n');

    const response = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 300,
      system: `Ты эксперт по 3D-печати в бюро Hevial. 
Твоя задача — выбрать ОДИН лучший материал из каталога для задачи клиента.
Отвечай ТОЛЬКО кодом материала, без пояснений. Например: PETG`,
      messages: [{
        role: 'user',
        content: `Задача клиента: "${useDescription}"\n\nКаталог материалов:\n${catalog}`
      }]
    });

    const suggested = response.content[0].text.trim().toUpperCase();
    // Проверяем что вернул реальный код
    const valid = materials.map(m => m.code);
    return valid.includes(suggested) ? suggested : suggestMaterialLocal(useDescription);

  } catch (err) {
    console.error('AI suggest error, fallback to local:', err.message);
    return suggestMaterialLocal(useDescription);
  }
}

// ── Форматировать объяснение для клиента ─────────────────────────────────

function formatSuggestion(materialCode, material) {
  const explanations = {
    RESIN_STD:  'максимальная точность и детализация поверхности',
    RESIN_FLEX: 'гибкость + высокая точность фотополимера',
    TPU:        'единственный по-настоящему гибкий материал, морозостойкий',
    PEEK:       'максимальная прочность и термостойкость до 250°C',
    NYLON:      'лучшая ударостойкость и износостойкость среди FDM',
    PC:         'прозрачный + ударопрочный + высокая температура',
    ABS:        'хорошая термостойкость для технических деталей',
    PETG:       'универсальный: стойкий к улице, прозрачный, food-safe',
    SILK:       'красивый шелковистый блеск, отлично для декора',
    PLA:        'хороший баланс цены и качества для большинства задач',
    SBS:        'прозрачный и безопасный для контакта с едой и кожей',
  };

  const displayName = material?.display_name || materialCode;
  const method      = materialCode.startsWith('RESIN') ? 'фотополимер' : 'FDM';
  const explanation = explanations[materialCode] || 'подходит для вашей задачи';

  return `🤖 *Рекомендация:* ${displayName} (${method})\n\nПодходит потому что: ${explanation}\n\nЧто думаете?`;
}

// ── Проверка совместимости материала со средой ───────────────────────────

function checkCompatibility(material, useDescription) {
  if (!material || !useDescription) return { compatible: true, conflicts: [] };

  const desc = useDescription.toLowerCase();
  const conflicts = material.exclusions.filter(ex => {
    const e = ex.toLowerCase();
    return desc.includes(e) ||
      (e.includes('улиц') && desc.includes('улиц')) ||
      (e.includes('мороз') && desc.includes('мороз')) ||
      (e.includes('еда')   && (desc.includes('еда') || desc.includes('пищ'))) ||
      (e.includes('нагрев') && (desc.includes('горяч') || desc.includes('температур')));
  });

  return { compatible: conflicts.length === 0, conflicts };
}

module.exports = { suggestMaterialLocal, suggestMaterialAI, formatSuggestion, checkCompatibility };
