/**
 * STEPS - Константы состояний диалога пользователя
 * Определяют на каком этапе находится клиент в процессе оформления заказа
 */

const STEPS = {
  // ── Начальные шаги ────────────────────────────────────────────────────────
  START: 'START',                           // Первый запуск /start
  GREETING: 'GREETING',                     // Приветствие пользователя
  
  // ── Основной диалог оформления заказа ─────────────────────────────────────
  WAITING_SERVICE: 'WAITING_SERVICE',       // Ожидание выбора услуги (печать, дизайн и т.д.)
  WAITING_DESCRIPTION: 'WAITING_DESCRIPTION', // Описание заказа/модели
  WAITING_BUDGET: 'WAITING_BUDGET',         // Указание бюджета
  WAITING_DEADLINE: 'WAITING_DEADLINE',     // Сроки выполнения
  WAITING_CONTACT: 'WAITING_CONTACT',       // Контактная информация (телефон, email)
  WAITING_FILES: 'WAITING_FILES',           // Загрузка файлов (3D модели)
  
  // ── Подтверждение ────────────────────────────────────────────────────────
  CONFIRM_ORDER: 'CONFIRM_ORDER',           // Подтверждение перед отправкой
  ORDER_CREATED: 'ORDER_CREATED',           // Заказ успешно создан
  
  // ── Статусы заказа ───────────────────────────────────────────────────────
  ORDER_PROCESSING: 'ORDER_PROCESSING',     // На рассмотрении у специалиста
  PROCESSING_DETAILS: 'PROCESSING_DETAILS', // Требует уточнения деталей
  WAITING_SPECIALIST: 'WAITING_SPECIALIST', // Ожидание ответа специалиста
  IN_PROGRESS: 'IN_PROGRESS',               // Заказ в работе
  COMPLETED: 'COMPLETED',                   // Завершён и доставлен
  CANCELLED: 'CANCELLED',                   // Отменён
  
  // ── Коммуникация со специалистом ──────────────────────────────────────────
  BRIDGE_ACTIVE: 'BRIDGE_ACTIVE',           // Активный прямой диалог
  WAITING_RESPONSE: 'WAITING_RESPONSE',     // Ожидание ответа из bridge
  
  // ── Служебные ────────────────────────────────────────────────────────────
  IDLE: 'IDLE',                             // В ожидании команды
  ERROR: 'ERROR',                           // Предыдущее действие вызвало ошибку
};

/**
 * Переходы между этапами
 */
const STEP_TRANSITIONS = {
  [STEPS.START]: [STEPS.GREETING],
  [STEPS.GREETING]: [STEPS.WAITING_SERVICE],
  [STEPS.WAITING_SERVICE]: [STEPS.WAITING_DESCRIPTION],
  [STEPS.WAITING_DESCRIPTION]: [STEPS.WAITING_BUDGET],
  [STEPS.WAITING_BUDGET]: [STEPS.WAITING_DEADLINE],
  [STEPS.WAITING_DEADLINE]: [STEPS.WAITING_CONTACT],
  [STEPS.WAITING_CONTACT]: [STEPS.WAITING_FILES, STEPS.CONFIRM_ORDER],
  [STEPS.WAITING_FILES]: [STEPS.CONFIRM_ORDER],
  [STEPS.CONFIRM_ORDER]: [STEPS.ORDER_CREATED, STEPS.WAITING_SERVICE], // Вернуться или создать
  [STEPS.ORDER_CREATED]: [STEPS.ORDER_PROCESSING, STEPS.IDLE],
  [STEPS.ORDER_PROCESSING]: [STEPS.PROCESSING_DETAILS, STEPS.WAITING_SPECIALIST],
  [STEPS.PROCESSING_DETAILS]: [STEPS.CONFIRM_ORDER], // Вернуться на подтверждение
  [STEPS.WAITING_SPECIALIST]: [STEPS.IN_PROGRESS, STEPS.CANCELLED],
  [STEPS.IN_PROGRESS]: [STEPS.COMPLETED, STEPS.BRIDGE_ACTIVE],
  [STEPS.BRIDGE_ACTIVE]: [STEPS.IN_PROGRESS, STEPS.IDLE],
  [STEPS.IDLE]: [STEPS.WAITING_SERVICE, STEPS.START], // Может начать новый заказ
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
