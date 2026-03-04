/**
 * STEPS - Константы состояний диалога пользователя
 * Определяют на каком этапе находится клиент в процессе оформления заказа
 */

const STEPS = {
  // ── Начальные шаги ────────────────────────────────────────────────────────
  START: 'START',                           // Первый запуск /start
  AWAITING_FILE: 'AWAITING_FILE',           // Ожидание файла/ссылки/описания
  AWAITING_LINK: 'AWAITING_LINK',           // Ожидание ссылки на модель
  AWAITING_USE_CASE: 'AWAITING_USE_CASE',   // Ожидание описания использования
  
  // ── Подбор материала ──────────────────────────────────────────────────────
  MATERIAL_SUGGESTION: 'MATERIAL_SUGGESTION', // Показана рекомендация AI
  MATERIAL_CLIENT_CHOICE: 'MATERIAL_CLIENT_CHOICE', // Клиент выбирает материал
  MATERIAL_CHECK: 'MATERIAL_CHECK',         // Проверка совместимости материала
  MATERIAL_CONFLICT_RESOLVE: 'MATERIAL_CONFLICT_RESOLVE', // Разрешение конфликта
  
  // ── Метод печати и размеры ────────────────────────────────────────────────
  METHOD_WARNING: 'METHOD_WARNING',         // Информация о методе печати
  AWAITING_SIZE: 'AWAITING_SIZE',           // Ожидание размеров детали
  AWAITING_QUANTITY: 'AWAITING_QUANTITY',   // Ожидание количества
  AWAITING_URGENCY: 'AWAITING_URGENCY',     // Выбор срочности
  AWAITING_DELIVERY: 'AWAITING_DELIVERY',   // Выбор способа доставки
  
  // ── Подтверждение и отзыв ─────────────────────────────────────────────────
  ORDER_SUMMARY: 'ORDER_SUMMARY',           // Итоговое подтверждение заказа
  ORDER_CONFIRMED: 'ORDER_CONFIRMED',       // Заказ подтвержден
  AWAITING_REVIEW: 'AWAITING_REVIEW',       // Ожидание отзыва
  
  // ── Коммуникация со специалистом ──────────────────────────────────────────
  WAITING_SPECIALIST: 'WAITING_SPECIALIST', // Ожидание ответа специалиста
  
  // ── Служебные ────────────────────────────────────────────────────────────
  CANCELLED: 'CANCELLED',                   // Отменён
};

/**
 * Переходы между этапами
 */
const STEP_TRANSITIONS = {
  [STEPS.START]: [STEPS.AWAITING_FILE],
  [STEPS.AWAITING_FILE]: [STEPS.AWAITING_LINK, STEPS.AWAITING_USE_CASE, STEPS.WAITING_SPECIALIST],
  [STEPS.AWAITING_LINK]: [STEPS.AWAITING_USE_CASE],
  [STEPS.AWAITING_USE_CASE]: [STEPS.MATERIAL_SUGGESTION, STEPS.MATERIAL_CLIENT_CHOICE],
  [STEPS.MATERIAL_SUGGESTION]: [STEPS.MATERIAL_CLIENT_CHOICE, STEPS.METHOD_WARNING],
  [STEPS.MATERIAL_CLIENT_CHOICE]: [STEPS.MATERIAL_CHECK],
  [STEPS.MATERIAL_CHECK]: [STEPS.MATERIAL_CONFLICT_RESOLVE, STEPS.METHOD_WARNING],
  [STEPS.MATERIAL_CONFLICT_RESOLVE]: [STEPS.METHOD_WARNING],
  [STEPS.METHOD_WARNING]: [STEPS.AWAITING_SIZE],
  [STEPS.AWAITING_SIZE]: [STEPS.AWAITING_QUANTITY],
  [STEPS.AWAITING_QUANTITY]: [STEPS.AWAITING_URGENCY, STEPS.WAITING_SPECIALIST],
  [STEPS.AWAITING_URGENCY]: [STEPS.AWAITING_DELIVERY],
  [STEPS.AWAITING_DELIVERY]: [STEPS.ORDER_SUMMARY],
  [STEPS.ORDER_SUMMARY]: [STEPS.ORDER_CONFIRMED, STEPS.AWAITING_USE_CASE, STEPS.CANCELLED],
  [STEPS.ORDER_CONFIRMED]: [STEPS.AWAITING_REVIEW],
  [STEPS.AWAITING_REVIEW]: [STEPS.CANCELLED],
  [STEPS.WAITING_SPECIALIST]: [STEPS.CANCELLED, STEPS.AWAITING_REVIEW],
  [STEPS.CANCELLED]: [STEPS.START],
};

/**
 * Получить допустимые следующие шаги
 * @param {string} currentStep - Текущий шаг
 * @returns {array} Массив допустимых следующих шагов
 */
function getNextSteps(currentStep) {
  return STEP_TRANSITIONS[currentStep] || [];
}

/**
 * Проверить, может ли произойти переход
 * @param {string} fromStep - Текущий шаг
 * @param {string} toStep - Целевой шаг
 * @returns {boolean}
 */
function canTransition(fromStep, toStep) {
  const allowed = getNextSteps(fromStep);
  return allowed.includes(toStep);
}

module.exports = STEPS;
module.exports.STEP_TRANSITIONS = STEP_TRANSITIONS;
module.exports.getNextSteps = getNextSteps;
module.exports.canTransition = canTransition;
