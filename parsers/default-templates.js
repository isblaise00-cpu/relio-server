'use strict';

/*
 * MODÈLES DE SMS PAR DÉFAUT
 * =========================
 *
 * ⚠️  IMPORTANT : les formats ci-dessous sont des EXEMPLES ILLUSTRATIFS.
 * Ils ne reproduisent pas forcément au caractère près les SMS réellement envoyés
 * par Orange Money Burkina et Moov Money Burkina. Avant toute mise en production :
 *   1. collectez de vrais SMS de réception et d'envoi (en masquant les numéros) ;
 *   2. adaptez les expressions régulières et les noms d'expéditeurs ;
 *   3. mettez-les à jour via l'API admin (PUT /admin/parsers/:id) — aucune mise
 *      à jour de l'application mobile n'est nécessaire.
 *
 * Groupes nommés attendus :
 *   - crédit (argent reçu) : amount, payer, balance, txn_id
 *   - débit  (argent sorti) : amount, balance, txn_id, et fee (optionnel)
 *
 * Ces modèles ne sont insérés qu'au premier démarrage (table vide).
 */

module.exports = [
  {
    id: 'orange_bf_credit_v1',
    operator: 'orange',
    kind: 'credit',
    senders: ['OrangeMoney', 'Orange Money', 'OM'],
    flags: 'i',
    priority: 10,
    pattern: String.raw`re[cç]u\s+(?:un\s+transfert\s+)?(?:de\s+)?(?<amount>\d[\d\s.,]*?)\s*F(?:CFA)?\b[\s\S]*?\b(?:du|de)\s+(?:num[eé]ro\s+)?(?<payer>\+?\d[\d\s]{6,15}\d)[\s\S]*?solde\s*(?:est\s+de|:)?\s*(?<balance>\d[\d\s.,]*?)\s*F(?:CFA)?\b[\s\S]*?(?:trans(?:action)?\s*id|id\s*trans(?:action)?|r[eé]f(?:[eé]rence)?)\s*:?\s*(?<txn_id>[A-Z0-9][A-Z0-9.\-]{4,})`,
    example:
      'Vous avez recu un transfert de 10 000 FCFA du 70123456. Nouveau solde: 35 000 FCFA. Trans ID: CI261017.1530.A12345',
  },
  {
    id: 'orange_bf_debit_v1',
    operator: 'orange',
    kind: 'debit',
    senders: ['OrangeMoney', 'Orange Money', 'OM'],
    flags: 'i',
    priority: 5,
    pattern: String.raw`(?:envoy[eé]|transf[eé]r[eé]|retrait|pay[eé]|achat)\D{0,40}?(?<amount>\d[\d\s.,]*?)\s*F(?:CFA)?\b[\s\S]*?(?:frais\s*:?\s*(?<fee>\d[\d\s.,]*?)\s*F(?:CFA)?\b[\s\S]*?)?solde\s*(?:est\s+de|:)?\s*(?<balance>\d[\d\s.,]*?)\s*F(?:CFA)?\b[\s\S]*?(?:trans(?:action)?\s*id|id\s*trans(?:action)?|r[eé]f(?:[eé]rence)?)\s*:?\s*(?<txn_id>[A-Z0-9][A-Z0-9.\-]{4,})`,
    example:
      'Vous avez envoye 2 000 FCFA au 75000000. Frais: 50 FCFA. Nouveau solde: 32 950 FCFA. Trans ID: CO261017.1600.B54321',
  },
  {
    id: 'moov_bf_credit_v1',
    operator: 'moov',
    kind: 'credit',
    senders: ['MoovMoney', 'Moov Money', 'MOOV'],
    flags: 'i',
    priority: 10,
    pattern: String.raw`re[cç]u\s+(?<amount>\d[\d\s.,]*?)\s*F(?:CFA)?\b[\s\S]*?\bde\s+(?:la\s+part\s+de\s+)?(?<payer>\+?\d[\d\s]{6,15}\d)[\s\S]*?solde\s*(?:est\s+de|:)?\s*(?<balance>\d[\d\s.,]*?)\s*F(?:CFA)?\b[\s\S]*?(?:r[eé]f(?:[eé]rence)?|trans(?:action)?\s*id)\s*:?\s*(?<txn_id>[A-Z0-9][A-Z0-9.\-]{4,})`,
    example:
      'Vous avez recu 5 000 FCFA de 60123456. Votre nouveau solde est de 20 000 FCFA. Ref: MV261017123456',
  },
  {
    id: 'moov_bf_debit_v1',
    operator: 'moov',
    kind: 'debit',
    senders: ['MoovMoney', 'Moov Money', 'MOOV'],
    flags: 'i',
    priority: 5,
    pattern: String.raw`(?:envoy[eé]|transf[eé]r[eé]|retrait|pay[eé]|achat)\D{0,40}?(?<amount>\d[\d\s.,]*?)\s*F(?:CFA)?\b[\s\S]*?(?:frais\s*:?\s*(?<fee>\d[\d\s.,]*?)\s*F(?:CFA)?\b[\s\S]*?)?solde\s*(?:est\s+de|:)?\s*(?<balance>\d[\d\s.,]*?)\s*F(?:CFA)?\b[\s\S]*?(?:r[eé]f(?:[eé]rence)?|trans(?:action)?\s*id)\s*:?\s*(?<txn_id>[A-Z0-9][A-Z0-9.\-]{4,})`,
    example:
      'Vous avez envoye 1 000 FCFA a 61000000. Frais: 25 FCFA. Votre nouveau solde est de 18 975 FCFA. Ref: MV261017999999',
  },
];
