'use strict';

/**
 * Normalise un numéro de téléphone en chiffres seuls au format international
 * sans "+" (ex. "22670123456"). Renvoie null si le numéro est invalide.
 *
 *   "70 12 34 56"      -> "22670123456"
 *   "+226 70123456"    -> "22670123456"
 *   "0022670123456"    -> "22670123456"
 */
function normalizePhone(input, countryCode = '226') {
  if (input === undefined || input === null) return null;
  const s = String(input).trim();
  if (!s) return null;
  const hadPlus = s.startsWith('+');
  let d = s.replace(/\D/g, '');
  if (!d) return null;

  if (!hadPlus) {
    if (d.startsWith('00')) {
      d = d.slice(2);
    } else if (!d.startsWith(countryCode) || d.length <= 9) {
      // Numéro local : on retire un éventuel 0 de tête puis on ajoute l'indicatif.
      if (d.length <= 10) d = countryCode + d.replace(/^0/, '');
    }
  }

  if (d.length < 8 || d.length > 15) return null;
  if (countryCode === '226' && d.startsWith('226') && d.length !== 11) return null;
  return d;
}

function displayPhone(msisdn) {
  return msisdn ? `+${msisdn}` : null;
}

/**
 * Convertit un montant écrit dans un SMS en entier (FCFA).
 *   "10 000" -> 10000, "10.000" -> 10000, "25000.00" -> 25000
 */
function parseAmount(input) {
  if (input === undefined || input === null) return null;
  let s = String(input).trim().replace(/[\s  ]/g, '');
  s = s.replace(/[.,]\d{1,2}$/, ''); // centimes éventuels
  s = s.replace(/[.,]/g, ''); // séparateurs de milliers
  if (!/^\d+$/.test(s)) return null;
  const n = Number(s);
  return Number.isSafeInteger(n) ? n : null;
}

function formatAmount(n) {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}

function iso(ms) {
  return ms === null || ms === undefined ? null : new Date(ms).toISOString();
}

/** Accepte un timestamp en ms, en secondes, ou une date ISO. */
function parseTimestamp(input) {
  if (input === undefined || input === null || input === '') return null;
  if (typeof input === 'number' && Number.isFinite(input)) {
    return input < 1e12 ? Math.round(input * 1000) : Math.round(input);
  }
  if (typeof input === 'string') {
    if (/^\d+$/.test(input)) return parseTimestamp(Number(input));
    const t = Date.parse(input);
    return Number.isNaN(t) ? null : t;
  }
  return null;
}

const OPERATOR_LABELS = { orange: 'Orange Money', moov: 'Moov Money' };

function operatorLabel(op) {
  return OPERATOR_LABELS[op] || op;
}

module.exports = { normalizePhone, displayPhone, parseAmount, formatAmount, iso, parseTimestamp, operatorLabel };
