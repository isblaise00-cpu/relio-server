'use strict';

const { newId } = require('../lib/ids');
const { ApiError } = require('../lib/errors');

function parseSenders(raw) {
  try { return JSON.parse(raw || '[]'); } catch { return []; }
}

function serializeOperator(row, extra = {}) {
  return {
    id: row.id,
    object: 'operator',
    name: row.name,
    color: row.color,
    country: row.country,
    senders: parseSenders(row.senders),
    active: row.active === 1,
    created_at: new Date(row.created_at).toISOString(),
    ...extra,
  };
}

async function listOperators(ctx) {
  const rows = await ctx.db.prepare('SELECT * FROM operators ORDER BY name').all();
  const result = [];
  for (const row of rows) {
    const cnt = await ctx.db
      .prepare('SELECT COUNT(*) as c FROM parser_templates WHERE operator_id = ? AND active = 1')
      .get(row.id);
    result.push(serializeOperator(row, { template_count: cnt.c }));
  }
  return result;
}

async function getOperator(ctx, id) {
  return ctx.db.prepare('SELECT * FROM operators WHERE id = ?').get(id);
}

async function createOperator(ctx, body = {}) {
  const { name, color = '#D2D9B6', country = 'BF', senders = [] } = body;
  if (typeof name !== 'string' || !name.trim()) {
    throw new ApiError(400, 'invalid_name', 'name est obligatoire');
  }
  const id = newId('op');
  await ctx.db
    .prepare('INSERT INTO operators (id, name, color, country, senders, active, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)')
    .run(id, name.trim(), color, country, JSON.stringify(Array.isArray(senders) ? senders : []), Date.now());
  return serializeOperator(await ctx.db.prepare('SELECT * FROM operators WHERE id = ?').get(id));
}

async function updateOperator(ctx, id, body = {}) {
  const row = await ctx.db.prepare('SELECT * FROM operators WHERE id = ?').get(id);
  if (!row) throw new ApiError(404, 'operator_not_found', 'Opérateur introuvable');
  const sets = [];
  const params = [];
  if (typeof body.name === 'string' && body.name.trim()) { sets.push('name = ?'); params.push(body.name.trim()); }
  if (typeof body.color === 'string') { sets.push('color = ?'); params.push(body.color); }
  if (typeof body.country === 'string') { sets.push('country = ?'); params.push(body.country); }
  if (Array.isArray(body.senders)) { sets.push('senders = ?'); params.push(JSON.stringify(body.senders)); }
  if (typeof body.active === 'boolean') { sets.push('active = ?'); params.push(body.active ? 1 : 0); }
  if (sets.length) {
    await ctx.db.prepare(`UPDATE operators SET ${sets.join(', ')} WHERE id = ?`).run(...params, id);
  }
  return serializeOperator(await ctx.db.prepare('SELECT * FROM operators WHERE id = ?').get(id));
}

async function getMerchantOperators(ctx, merchantId) {
  const rows = await ctx.db
    .prepare(`SELECT o.*, mo.recipient_name FROM operators o
              JOIN merchant_operators mo ON o.id = mo.operator_id
              WHERE mo.merchant_id = ? ORDER BY o.name`)
    .all(merchantId);
  return rows.map((row) => serializeOperator(row, { recipient_name: row.recipient_name || null }));
}

async function setMerchantOperators(ctx, merchantId, entries = []) {
  await ctx.db.prepare('DELETE FROM merchant_operators WHERE merchant_id = ?').run(merchantId);
  for (const e of entries) {
    if (!(await ctx.db.prepare('SELECT id FROM operators WHERE id = ?').get(e.operator_id))) continue;
    await ctx.db
      .prepare('INSERT INTO merchant_operators (merchant_id, operator_id, recipient_name) VALUES (?, ?, ?)')
      .run(merchantId, e.operator_id, e.recipient_name || null);
  }
  return getMerchantOperators(ctx, merchantId);
}

/**
 * Expéditeurs dont les SMS doivent être transmis pour ce marchand :
 * ceux de ses opérateurs configurés, sinon la liste globale des modèles actifs.
 */
async function merchantSenders(ctx, merchantId) {
  const merchantOps = await getMerchantOperators(ctx, merchantId);
  if (merchantOps.length > 0) return [...new Set(merchantOps.flatMap((op) => op.senders))];
  return require('./parser').allowedSenders(ctx);
}

module.exports = {
  merchantSenders,
  serializeOperator,
  listOperators,
  getOperator,
  createOperator,
  updateOperator,
  getMerchantOperators,
  setMerchantOperators,
};
