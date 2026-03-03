// Аналог DialogContextStore.java + DialogContext.java
// Хранит состояние диалога каждого пользователя в памяти.
// При масштабировании заменить на Redis.

const STEPS = require('../bot/steps');

// Map: telegramUserId -> context
const store = new Map();

function generateSessionId() {
  return 'sess_' + Math.random().toString(36).substring(2, 14);
}

// Получить или создать контекст
function getOrCreate(userId, chatId) {
  if (!store.has(userId)) {
    store.set(userId, createFresh(userId, chatId));
  }
  return store.get(userId);
}

// Получить существующий
function get(userId) {
  return store.get(userId) || null;
}

// Сбросить сессию (при /start)
function reset(userId, chatId) {
  const ctx = createFresh(userId, chatId);
  store.set(userId, ctx);
  return ctx;
}

// Сохранить обновлённый контекст
function save(userId, ctx) {
  store.set(userId, ctx);
}

// Создать пустой контекст
function createFresh(userId, chatId) {
  return {
    telegramUserId: userId,
    chatId:         chatId,
    sessionId:      generateSessionId(),
    currentStep:    STEPS.START,

    // Данные заказа
    orderId:        null,
    orderNumber:    null,
    fileUrl:        null,
    photoFileId:    null,
    useDescription: null,

    // Материал
    suggestedMaterial:  null,
    clientMaterialWish: null,
    confirmedMaterial:  null,
    confirmedMethod:    null,
    materialOverridden: false,

    // Размеры
    sizeX: null,
    sizeY: null,
    sizeZ: null,

    // Заказ
    quantity:     1,
    isBatch:      false,
    urgency:      'STANDARD',
    deliveryType: 'COURIER',

    // Флаги
    awaitingSpecialist: false,
    retryCount:         0,
  };
}

// Вспомогательные методы контекста
function nextStep(ctx, step) {
  ctx.currentStep = step;
  ctx.retryCount  = 0;
}

function incrementRetry(ctx) {
  ctx.retryCount = (ctx.retryCount || 0) + 1;
}

function isRetryLimitReached(ctx) {
  return ctx.retryCount >= 3;
}

function hasDimensions(ctx) {
  return ctx.sizeX != null && ctx.sizeY != null && ctx.sizeZ != null;
}

function hasFile(ctx) {
  return ctx.fileUrl != null || ctx.photoFileId != null;
}

function getMaxDimension(ctx) {
  return Math.max(ctx.sizeX || 0, ctx.sizeY || 0, ctx.sizeZ || 0);
}

module.exports = {
  getOrCreate, get, reset, save,
  nextStep, incrementRetry, isRetryLimitReached,
  hasDimensions, hasFile, getMaxDimension,
};
