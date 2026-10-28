'use strict';

const { newId } = require('../lib/ids');
const { ApiError } = require('../lib/errors');
const { iso, operatorLabel } = require('../lib/format');
const parser = require('./parser');

function serializePlan(row) {
  return {
    id: row.id,
    object: 'payment_plan',
    name: row.name,
    amount: row.amount,
    operator: row.operator || null,
    operator_label: row.operator ? operatorLabel(row.operator) : null,
    active: !!row.active,
    created_at: iso(row.created_at),
  };
}

async function createPlan(ctx, merchant, body = {}, now = Date.now()) {
  const { name, amount, operator } = body;

  if (typeof name !== 'string' || !name.trim() || name.length > 200) {
    throw new ApiError(400, 'invalid_name', 'name est obligatoire (200 caractères max)');
  }
  if (!Number.isSafeInteger(amount) || amount <= 0 || amount > ctx.cfg.maxAmount) {
    throw new ApiError(400, 'invalid_amount', `amount doit être un entier entre 1 et ${ctx.cfg.maxAmount} (FCFA)`);
  }

  let op = null;
  if (operator !== undefined && operator !== null && operator !== '') {
    const operators = await parser.knownOperators(ctx);
    if (!operators.includes(operator)) {
      throw new ApiError(400, 'invalid_operator', `operator doit être l'un de : ${operators.join(', ')}`);
    }
    op = operator;
  }

  // Un seul plan actif par combinaison montant + opérateur.
  const existing = await listPlans(ctx, merchant.id);
  const dup = existing.find((p) => p.active && p.amount === amount && (p.operator || null) === op);
  if (dup) throw new ApiError(409, 'duplicate_plan', 'Un plan actif avec ce montant et cet opérateur existe déjà');

  const id = newId('pln');
  await ctx.db
    .prepare('INSERT INTO payment_plans (id, merchant_id, name, amount, operator, active, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)')
    .run(id, merchant.id, name.trim(), amount, op, now);
  return serializePlan(await ctx.db.prepare('SELECT * FROM payment_plans WHERE id = ?').get(id));
}

async function listPlans(ctx, merchantId) {
  const rows = await ctx.db
    .prepare('SELECT * FROM payment_plans WHERE merchant_id = ? ORDER BY created_at DESC')
    .all(merchantId);
  return rows.map(serializePlan);
}

async function getMerchantPlan(ctx, merchantId, id) {
  const row = await ctx.db.prepare('SELECT * FROM payment_plans WHERE id = ? AND merchant_id = ?').get(id, merchantId);
  if (!row) throw new ApiError(404, 'plan_not_found', 'Plan introuvable');
  return row;
}

async function togglePlan(ctx, merchantId, id, active) {
  await getMerchantPlan(ctx, merchantId, id);
  await ctx.db.prepare('UPDATE payment_plans SET active = ? WHERE id = ?').run(active ? 1 : 0, id);
  return serializePlan(await ctx.db.prepare('SELECT * FROM payment_plans WHERE id = ?').get(id));
}

async function deletePlan(ctx, merchantId, id) {
  await getMerchantPlan(ctx, merchantId, id);
  await ctx.db.prepare('DELETE FROM payment_plans WHERE id = ?').run(id);
}

/**
 * Trouve le plan actif qui correspond à un SMS de crédit entrant.
 * Préfère un plan avec opérateur explicite sur un plan "tous opérateurs".
 */
async function findMatchingPlan(ctx, sms) {
  const row = await ctx.db
    .prepare(
      `SELECT * FROM payment_plans
       WHERE merchant_id = ? AND amount = ? AND active = 1
         AND (operator IS NULL OR operator = ?)
       ORDER BY operator DESC
       LIMIT 1`,
    )
    .get(sms.merchant_id, sms.amount, sms.operator);
  return row || null;
}

module.exports = { serializePlan, createPlan, listPlans, getMerchantPlan, togglePlan, deletePlan, findMatchingPlan };
