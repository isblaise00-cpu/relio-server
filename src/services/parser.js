'use strict';

const { ApiError } = require('../lib/errors');
const { normalizePhone, parseAmount } = require('../lib/format');
const defaultTemplates = require('../../parsers/default-templates');

const REQUIRED_GROUPS = {
  credit: ['amount', 'payer', 'balance', 'txn_id'],
  debit: ['amount', 'balance', 'txn_id'],
};

/** "Orange Money" et "ORANGEMONEY" désignent le même expéditeur. */
function normalizeSender(sender) {
  return String(sender || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Vérifie un modèle avant de l'enregistrer. Lève une ApiError si invalide. */
function validateTemplate(t) {
  const fail = (msg) => {
    throw new ApiError(400, 'invalid_template', msg);
  };
  if (!t || typeof t !== 'object') fail('Modèle manquant');
  if (typeof t.id !== 'string' || !/^[a-z0-9_\-]{3,64}$/.test(t.id)) fail('id invalide (a-z, 0-9, _ ou -, 3 à 64 caractères)');
  if (typeof t.operator !== 'string' || !/^[a-z0-9_]{2,32}$/.test(t.operator)) fail('operator invalide');
  if (!REQUIRED_GROUPS[t.kind]) fail('kind doit valoir "credit" ou "debit"');
  if (!Array.isArray(t.senders) || t.senders.length === 0 || t.senders.some((s) => typeof s !== 'string' || !s.trim())) {
    fail('senders doit être une liste non vide de noms d\'expéditeurs');
  }
  const flags = t.flags === undefined ? 'i' : t.flags;
  if (typeof flags !== 'string' || !/^[imsu]*$/.test(flags)) fail('flags autorisés : i, m, s, u');
  if (typeof t.pattern !== 'string' || !t.pattern.length || t.pattern.length > 2000) fail('pattern manquant ou trop long');

  let re;
  try {
    re = new RegExp(t.pattern, flags);
  } catch (err) {
    fail(`Expression régulière invalide : ${err.message}`);
  }
  for (const g of REQUIRED_GROUPS[t.kind]) {
    if (!t.pattern.includes(`(?<${g}>`)) fail(`Groupe nommé obligatoire manquant : (?<${g}>...)`);
  }
  if (t.example !== undefined && t.example !== null) {
    if (typeof t.example !== 'string') fail('example doit être une chaîne');
    const parsed = extract(re, t, t.example);
    if (!parsed) fail("L'exemple fourni n'est pas reconnu par le modèle");
  }
  return {
    id: t.id,
    operator: t.operator,
    kind: t.kind,
    senders: t.senders.map((s) => s.trim()),
    pattern: t.pattern,
    flags,
    priority: Number.isInteger(t.priority) ? t.priority : 0,
    active: t.active === false ? 0 : 1,
    example: t.example ?? null,
  };
}

async function seedDefaultTemplates(ctx) {
  const row = await ctx.db.prepare('SELECT COUNT(*) AS n FROM parser_templates').get();
  if (row.n > 0) return;
  for (const t of defaultTemplates) await upsertTemplate(ctx, t);
}

async function upsertTemplate(ctx, input) {
  const t = validateTemplate(input);
  await ctx.db
    .prepare(
      `INSERT INTO parser_templates (id, operator, kind, senders, pattern, flags, priority, active, example, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE operator=VALUES(operator), kind=VALUES(kind), senders=VALUES(senders),
         pattern=VALUES(pattern), flags=VALUES(flags), priority=VALUES(priority), active=VALUES(active),
         example=VALUES(example), updated_at=VALUES(updated_at)`,
    )
    .run(t.id, t.operator, t.kind, JSON.stringify(t.senders), t.pattern, t.flags, t.priority, t.active, t.example, Date.now());
  ctx.cache.templates = null;
  return getTemplate(ctx, t.id);
}

async function getTemplate(ctx, id) {
  const row = await ctx.db.prepare('SELECT * FROM parser_templates WHERE id = ?').get(id);
  return row ? serializeTemplate(row) : null;
}

async function deleteTemplate(ctx, id) {
  const row = await ctx.db.prepare('SELECT id FROM parser_templates WHERE id = ?').get(id);
  if (!row) throw new ApiError(404, 'template_not_found', 'Template introuvable');
  await ctx.db.prepare('DELETE FROM parser_templates WHERE id = ?').run(id);
  ctx.cache.templates = null;
}

async function listTemplates(ctx) {
  const rows = await ctx.db.prepare('SELECT * FROM parser_templates ORDER BY operator, priority DESC, id').all();
  return rows.map(serializeTemplate);
}

function serializeTemplate(row) {
  return {
    id: row.id,
    operator: row.operator,
    kind: row.kind,
    senders: JSON.parse(row.senders),
    pattern: row.pattern,
    flags: row.flags,
    priority: row.priority,
    active: row.active === 1,
    example: row.example,
    updated_at: new Date(row.updated_at).toISOString(),
  };
}

/** Modèles actifs compilés, mis en cache jusqu'à la prochaine modification. */
async function activeTemplates(ctx) {
  if (!ctx.cache.templates) {
    const rows = await ctx.db.prepare('SELECT * FROM parser_templates WHERE active = 1 ORDER BY priority DESC, id').all();
    ctx.cache.templates = rows.map((row) => {
      const senders = JSON.parse(row.senders);
      return {
        id: row.id,
        operator: row.operator,
        kind: row.kind,
        senders,
        senderKeys: new Set(senders.map(normalizeSender)),
        re: new RegExp(row.pattern, row.flags),
      };
    });
  }
  return ctx.cache.templates;
}

/** Liste des expéditeurs à transmettre : envoyée aux téléphones pour qu'ils filtrent localement. */
async function allowedSenders(ctx) {
  const set = new Set();
  for (const t of await activeTemplates(ctx)) for (const s of t.senders) set.add(s);
  return [...set];
}

async function knownOperators(ctx) {
  return [...new Set((await activeTemplates(ctx)).map((t) => t.operator))];
}

function extract(re, template, body, countryCode = '226') {
  const m = re.exec(body);
  if (!m || !m.groups) return null;
  const g = m.groups;
  const amount = parseAmount(g.amount);
  const balance = parseAmount(g.balance);
  const fee = g.fee !== undefined ? parseAmount(g.fee) : null;
  const txnId = g.txn_id ? g.txn_id.replace(/[.\-]+$/, '').toUpperCase() : null;
  const payer = g.payer !== undefined ? normalizePhone(g.payer, countryCode) : null;
  const payerName = g.payer_name !== undefined ? g.payer_name.trim() : null;

  if (!amount || amount <= 0 || balance === null || !txnId) return null;
  if (template.kind === 'credit' && !payer) return null;
  return { amount, balance, fee, txnId, payer, payerName };
}

/**
 * Analyse un SMS. Renvoie soit { error }, soit les champs extraits.
 *   error = "sender_not_allowed"   : l'expéditeur n'est pas un opérateur connu
 *   error = "unrecognized_format"  : expéditeur connu, mais message non reconnu (promo, etc.)
 */
async function parseSms(ctx, sender, body) {
  const key = normalizeSender(sender);
  const candidates = (await activeTemplates(ctx)).filter((t) => t.senderKeys.has(key));
  if (candidates.length === 0) return { error: 'sender_not_allowed' };
  for (const t of candidates) {
    const fields = extract(t.re, t, body, ctx.cfg.defaultCountryCode);
    if (fields) {
      return { templateId: t.id, operator: t.operator, kind: t.kind, ...fields };
    }
  }
  return { error: 'unrecognized_format' };
}

module.exports = {
  normalizeSender,
  validateTemplate,
  seedDefaultTemplates,
  upsertTemplate,
  deleteTemplate,
  getTemplate,
  listTemplates,
  allowedSenders,
  knownOperators,
  parseSms,
};
