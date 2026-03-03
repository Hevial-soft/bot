const Anthropic = require('@anthropic-ai/sdk');
const db = require('../db');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// кэш промптов из БД
let _promptCache = {};
let _cacheTime   = 0;
const CACHE_TTL = 10 * 60 * 1000; // 10 минут

async function getPrompt(key) {
  const now = Date.now();
  if (_promptCache[key] && (now - _cacheTime) < CACHE_TTL) {
    return _promptCache[key];
  }
  const prompt = await db.getAiPrompt(key);
  if (prompt) {
    _promptCache[key] = prompt;
    _cacheTime = now;
  }
  return prompt;
}

function clearPromptCache() {
  _promptCache = {};
  _cacheTime = 0;
  console.log('[AI] Кэш промптов сброшен');
}

// основной метод – двухуровневый подбор
async function suggestMaterial(useDescription, materials) {
  const local = suggestMaterialLocal(useDescription);
  if (local.confident) {
    console.log(`[AI] Эвристика: ${local.code} (API не вызывался)`);
    return local.code;
  }
  console.log(`[AI] Эвристика не уверена, вызываем Claude API...`);
  return await _callClaudeAPI(useDescription, materials);
}

// первые уровни – эвристика
function suggestMaterialLocal(useDescription) {
  const desc = useDescription.toLowerCase();
  const has = (...words) => words.some(w => desc.includes(w));

  if (has('точн', 'детал', 'ювелир', 'миниатюр', 'зуб', 'стомат', 'мелк'))
    return { code: 'RESIN_STD', confident: true };
  if (has('гибк', 'эластич') && has('точн', 'маленьк'))
    return { code: 'RESIN_FLEX', confident: true };
  if (has('гибк', 'мягк', 'резин', 'уплотн', 'чехол', 'виброгас'))
    return { code: 'TPU', confident: true };
  if (has('peek', 'экстрем', 'авиа', 'медицин', 'химическ', 'агрессив'))
    return { code: 'PEEK', confident: true };
  if (has('шестерн', 'зубчат', 'износ', 'удар', 'петл', 'шарнир', 'трение'))
    return { code: 'NYLON', confident: true };
  if (has('прозрач') && has('удар', 'прочн'))
    return { code: 'PC', confident: true };
  if (has('высок', 'температур', 'корпус', 'автомобил'))
    return { code: 'ABS', confident: true };
  if (has('улиц', 'наруж', 'мороз', 'еда', 'вода'))
    return { code: 'PETG', confident: true };
  if (has('декор', 'сувенир', 'украшен', 'блест', 'подарок'))
    return { code: 'SILK', confident: true };

  return { code: 'PLA', confident: false };
}

async function _callClaudeAPI(useDescription, materials) {
  try {
    const prompt = await getPrompt('material_suggest');
    if (!prompt) {
      console.warn('[AI] Промпт не найден в БД, fallback на эвристику');
      return suggestMaterialLocal(useDescription).code;
    }

    const validCodes = materials.map(m => m.code).join(', ');
    const catalogText = _buildCatalog(materials);

    const systemPrompt = prompt.system_prompt
      .replace('{{MATERIAL_CODES}}', validCodes);

    const userMessage = prompt.user_template
      .replace('{{USE_DESCRIPTION}}', useDescription)
      .replace('{{CATALOG}}', catalogText)
      .replace('{{MATERIAL_CODES}}', validCodes);

    const response = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 20,
      system: systemPrompt,
      messages: [{ role: 'user', content: userMessage }],
    });

    const answer = response.content[0].text
      .trim()
      .toUpperCase()
      .replace(/[^A-Z0-9_]/g, '');

    const validList = materials.map(m => m.code);
    if (validList.includes(answer)) {
      console.log(`[AI] Claude выбрал: ${answer}`);
      return answer;
    }

    console.warn(`[AI] Claude вернул невалидный код: "${answer}", fallback`);
    return suggestMaterialLocal(useDescription).code;

  } catch (err) {
    console.error('[AI] Ошибка Claude API, fallback на эвристику:', err.message);
    return suggestMaterialLocal(useDescription).code;
  }
}

function _buildCatalog(materials) {
  return materials.map(m =>
    `${m.code} (${m.method_code}): ` +
    `прочность=${m.strength}/10, гибкость=${m.flexibility}/10, ` +
    `темп до ${m.temp_resistance_max || '?'}°C, ` +
    `food_safe=${m.food_safe ? 'да' : 'нет'}, ` +
    `uv=${m.uv_resistance ? 'да' : 'нет'}, ` +
    `мороз=${m.cold_resistance ? 'да' : 'нет'}. ` +
    `Применение: ${(m.use_cases || []).slice(0, 3).join(', ')}. ` +
    `Не подходит: ${(m.exclusions || []).slice(0, 2).join(', ')}.`
  ).join('\n');
}

function formatSuggestion(materialCode, material) {
  const explanations = {
    RESIN_STD: 'максимальная точность и детализация поверхности',
    RESIN_FLEX: 'гибкость + высокая точность фотополимера',
    TPU: 'единственный по-настоящему гибкий материал, морозостойкий',
    PEEK: 'максимальная прочность и термостойкость до 250°C',
    NYLON: 'лучшая ударостойкость и износостойкость среди FDM',
    PC: 'прозрачный + ударопрочный + высокая температура',
    ABS: 'хорошая термостойкость для технических деталей',
    PETG: 'универсальный: стойкий к улице, прозрачный, food-safe',
    SILK: 'красивый шелковистый блеск, отлично для декора',
    PLA: 'хороший баланс цены и качества для большинства задач',
    SBS: 'прозрачный и безопасный для контакта с едой и кожей',
  };

  const displayName = material?.display_name || materialCode;
  const method = materialCode.startsWith('RESIN') ? 'фотополимер' : 'FDM';
  const explanation = explanations[materialCode] || 'подходит для вашей задачи';

  return `🤖 *Рекомендация:* ${displayName} (${method})\n\nПодходит потому что: ${explanation}\n\nЧто думаете?`;
}

function checkCompatibility(material, useDescription) {
  if (!material || !useDescription) return { compatible: true, conflicts: [] };

  const desc = useDescription.toLowerCase();
  const conflicts = material.exclusions.filter(ex => {
    const e = ex.toLowerCase();
    return desc.includes(e) ||
      (e.includes('улиц') && desc.includes('улиц')) ||
      (e.includes('мороз') && desc.includes('мороз')) ||
      (e.includes('еда') && (desc.includes('еда') || desc.includes('пищ'))) ||
      (e.includes('нагрев') && (desc.includes('горяч') || desc.includes('температур')));
  });

  return { compatible: conflicts.length === 0, conflicts };
}

module.exports = {
  suggestMaterial,
  suggestMaterialLocal,
  suggestMaterialAI: suggestMaterial, // backward compatibility
  formatSuggestion,
  checkCompatibility,
  clearPromptCache,
};
