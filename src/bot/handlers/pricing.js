const db = require('../../db');

let _config = null;

async function getConfig() {
  if (!_config) _config = await db.getPricingConfig();
  return _config;
}

// Сбросить кэш (при изменении цен)
function resetCache() { _config = null; }

// Наценка за срочность
async function getUrgencyFee(urgency) {
  const cfg = await getConfig();
  const map = {
    PLUS200: cfg.urgency_fee_plus200 || 200,
    PLUS500: cfg.urgency_fee_plus500 || 500,
    PLUS800: cfg.urgency_fee_plus800 || 800,
  };
  return map[urgency] || 0;
}

// Минимальная стоимость
async function getMinPrice() {
  const cfg = await getConfig();
  return cfg.min_order_price || 600;
}

// Базовый расчёт по весу
async function calcBasePrice(order, material) {
  const minPrice = await getMinPrice();
  const cfg      = await getConfig();

  if (!material || !material.price_per_gram || !order.weight_grams) {
    return minPrice;
  }

  const base = parseFloat(order.weight_grams)
    * parseFloat(material.price_per_gram)
    * parseFloat(material.time_multiplier || 1)
    * parseInt(order.quantity || 1);

  // Себестоимость курьера закладываем в цену
  const courierCost = order.delivery_type === 'COURIER'
    ? (cfg.delivery_courier_fee || 150)
    : 0;

  return Math.max(base + courierCost, minPrice);
}

// Дата готовности
async function calcReadyDate(order) {
  const method   = order.method_code;
  const maxDim   = Math.max(order.size_x || 0, order.size_y || 0, order.size_z || 0);
  const urgency  = order.urgency || 'STANDARD';

  let baseDays;

  if (method === 'RESIN') {
    baseDays = 5;
  } else {
    // FDM — по размеру
    const pt = await db.getProductionTime('FDM', maxDim || 100);
    baseDays  = pt?.days_max || 2;
  }

  // Сокращение за срочность
  const urgencyDays = { PLUS200: 1, PLUS500: 2, PLUS800: 3 }[urgency] || 0;
  const finalDays   = Math.max(1, baseDays - urgencyDays);

  const date = new Date();
  date.setDate(date.getDate() + finalDays);
  return date.toISOString().split('T')[0]; // YYYY-MM-DD
}

// Форматировать итоговую стоимость
async function calcTotal(order, material) {
  const base       = await calcBasePrice(order, material);
  const urgencyFee = await getUrgencyFee(order.urgency);
  const total      = base + urgencyFee;
  return { base, urgencyFee, total };
}

module.exports = { getUrgencyFee, getMinPrice, calcBasePrice, calcReadyDate, calcTotal, resetCache };
