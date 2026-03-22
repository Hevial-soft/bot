const axios = require("axios");
const db = require("../db");
const stock = require("./stock");

const API_KEY = process.env.GEN_API_KEY;
const API_POST_URL = "https://api.gen-api.ru/api/v1/networks";
const API_GET_URL = "https://api.gen-api.ru/api/v1/request/get";

// кэш промптов из БД
let _promptCache = {};
let _cacheTime = 0;
const CACHE_TTL = 10 * 60 * 1000; // 10 минут

async function getPrompt(key) {
  const now = Date.now();
  if (_promptCache[key] && now - _cacheTime < CACHE_TTL) {
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
  console.log("[AI] Кэш промптов сброшен");
}

// основной метод – двухуровневый подбор
async function suggestMaterial(useDescription, materials) {
  // 1. ИИ выбирает лучший материал
  let suggested = await _callClaudeAPI(useDescription, materials);

  // 2. Проверяем остаток
  const availability = await stock.checkMaterialAvailability(suggested, 50);

  if (!availability.available) {
    // Материала нет — берём альтернативу если есть
    if (availability.alternativeCode) {
      console.log(
        `[AI] ${suggested} недоступен (${availability.reason}), заменяем на ${availability.alternativeCode}`,
      );
      return {
        code: availability.alternativeCode,
        stockIssue: true,
        originalCode: suggested,
        reason: availability.reason,
      };
    }
    // Альтернатив нет — возвращаем оригинал с предупреждением
    return { code: suggested, stockIssue: true, reason: availability.reason };
  }

  return { code: suggested, stockIssue: false };
}

// первые уровни – эвристика
function suggestMaterialLocal(useDescription) {
  const desc = useDescription.toLowerCase();
  const has = (...words) => words.some((w) => desc.includes(w));

  if (has("точн", "детал", "ювелир", "миниатюр", "зуб", "стомат", "мелк"))
    return { code: "RESIN_STD", confident: true };
  if (has("гибк", "эластич") && has("точн", "маленьк"))
    return { code: "RESIN_FLEX", confident: true };
  if (has("гибк", "мягк", "резин", "уплотн", "чехол", "виброгас"))
    return { code: "TPU", confident: true };
  if (has("peek", "экстрем", "авиа", "медицин", "химическ", "агрессив"))
    return { code: "PEEK", confident: true };
  if (has("шестерн", "зубчат", "износ", "удар", "петл", "шарнир", "трение"))
    return { code: "NYLON", confident: true };
  if (has("прозрач") && has("удар", "прочн"))
    return { code: "PC", confident: true };
  if (has("высок", "температур", "корпус", "автомобил"))
    return { code: "ABS", confident: true };
  if (has("улиц", "наруж", "мороз", "еда", "вода"))
    return { code: "PETG", confident: true };
  if (has("декор", "сувенир", "украшен", "блест", "подарок"))
    return { code: "SILK", confident: true };

  return { code: "PLA", confident: false };
}

async function _callClaudeAPI(useDescription, materials) {
  try {
    if (!API_KEY) {
      console.error("[AI] API_KEY не установлен в переменных окружения");
      return suggestMaterialLocal(useDescription).code;
    }

    const prompt = await getPrompt("material_suggest");
    if (!prompt) {
      console.warn("[AI] Промпт не найден в БД, fallback на эвристику");
      return suggestMaterialLocal(useDescription).code;
    }

    const validCodes = materials.map((m) => m.code).join(", ");
    const catalogText = _buildCatalog(materials);

    const systemPrompt = prompt.system_prompt.replace(
      "{{MATERIAL_CODES}}",
      validCodes,
    );

    const userMessage = prompt.user_template
      .replace("{{USE_DESCRIPTION}}", useDescription)
      .replace("{{CATALOG}}", catalogText)
      .replace("{{MATERIAL_CODES}}", validCodes);

    console.log(
      "[AI] Вызов Claude API с описанием:",
      useDescription.substring(0, 50),
    );

    let response = await axios.post(
      `${API_POST_URL}/claude`,
      {
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: `${systemPrompt}\n\n${userMessage}`,
              },
            ],
          },
        ],
      },
      {
        headers: {
          Authorization: `Bearer ${API_KEY}`,
          "Content-Type": "application/json",
        },
      },
    );

    let requestID = response.data?.request_id;
    console.log(`[AI] Claude API ответ получен, request ID: ${requestID}`);

    const getAnswer = await _waitForClaudeResult(requestID);
    console.log(
      "[AI] Ответ от Claude получен:",
      getAnswer.result[0].choices[0].message,
    );

    if (!getAnswer.result[0].choices[0].message.content) {
      console.warn("[AI] Неожиданный формат ответа от API");
      return suggestMaterialLocal(useDescription).code;
    }

    const answer = getAnswer.result[0].choices[0].message.content
      .trim()
      .toUpperCase()
      .replace(/[^A-Z0-9_]/g, "");

    console.log("[AI] Распарсенный ответ:", answer);

    const validList = materials.map((m) => m.code);
    if (validList.includes(answer)) {
      console.log(`[AI] ✅ Claude выбрал валидный код: ${answer}`);
      return answer;
    }

    console.warn(
      `[AI] Claude вернул невалидный код: "${answer}", доступные: ${validList.join(", ")}`,
    );
    return suggestMaterialLocal(useDescription).code;
  } catch (err) {
    console.error("[AI] ❌ Ошибка Claude API:", err.message);
    if (err.response?.data) {
      console.error(
        "[AI] API error response:",
        JSON.stringify(err.response.data).substring(0, 300),
      );
    }
    console.log("[AI] Fallback на эвристику");
    return suggestMaterialLocal(useDescription).code;
  }
}

async function _waitForClaudeResult(requestID) {
  while (true) {
    const res = await axios.get(`${API_GET_URL}/${requestID}`, {
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        Accept: "application/json",
      },
    });

    if (res.data.status === "success") {
      return res.data;
    }

    console.log(`[AI] Ожидание ответа от Claude...`);
    await new Promise((r) => setTimeout(r, 2000));
  }
}

function _buildCatalog(materials) {
  return materials
    .map(
      (m) =>
        `${m.code} (${m.method_code}): ` +
        `прочность=${m.strength}/10, гибкость=${m.flexibility}/10, ` +
        `темп до ${m.temp_resistance_max || "?"}°C, ` +
        `food_safe=${m.food_safe ? "да" : "нет"}, ` +
        `uv=${m.uv_resistance ? "да" : "нет"}, ` +
        `мороз=${m.cold_resistance ? "да" : "нет"}. ` +
        `Применение: ${(m.use_cases || []).slice(0, 3).join(", ")}. ` +
        `Не подходит: ${(m.exclusions || []).slice(0, 2).join(", ")}.`,
    )
    .join("\n");
}

function formatSuggestion(result, material) {
  const { code, stockIssue, originalCode, reason } = result;
  // result теперь объект а не строка

  let text = "";

  if (stockIssue && originalCode) {
    // Заменили материал из-за остатков
    text += `ℹ️ _${originalCode} сейчас временно недоступен (${reason})._\n\n`;
  }

  text += `🤖 *Рекомендация: ${material?.display_name || code}*\n\n`;
  text += `${material?.description || ""}\n\n`;

  if (stockIssue && !originalCode) {
    // Нет ни этого ни альтернатив
    text += `⚠️ _Этот материал заканчивается. Специалист уточнит наличие._\n\n`;
  }

  text += `Подходит для вашей задачи?`;

  return text;
}

function checkCompatibility(material, useDescription) {
  if (!material || !useDescription) return { compatible: true, conflicts: [] };

  const desc = useDescription.toLowerCase();
  const conflicts = material.exclusions.filter((ex) => {
    const e = ex.toLowerCase();
    return (
      desc.includes(e) ||
      (e.includes("улиц") && desc.includes("улиц")) ||
      (e.includes("мороз") && desc.includes("мороз")) ||
      (e.includes("еда") && (desc.includes("еда") || desc.includes("пищ"))) ||
      (e.includes("нагрев") &&
        (desc.includes("горяч") || desc.includes("температур")))
    );
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
