'use strict';

/*
 * Générateurs de SMS au format des modèles par défaut (parsers/default-templates.js).
 * Ces formats sont ILLUSTRATIFS : remplacez-les par de vrais SMS avant la production.
 */

const fmt = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');

const orangeCredit = ({ amount, payer, balance, txn }) =>
  `Vous avez recu un transfert de ${fmt(amount)} FCFA du ${payer}. Nouveau solde: ${fmt(balance)} FCFA. Trans ID: ${txn}`;

const orangeDebit = ({ amount, to = '75000000', fee = 0, balance, txn }) =>
  `Vous avez envoye ${fmt(amount)} FCFA au ${to}. Frais: ${fmt(fee)} FCFA. Nouveau solde: ${fmt(balance)} FCFA. Trans ID: ${txn}`;

const moovCredit = ({ amount, payer, balance, txn }) =>
  `Vous avez recu ${fmt(amount)} FCFA de ${payer}. Votre nouveau solde est de ${fmt(balance)} FCFA. Ref: ${txn}`;

const moovDebit = ({ amount, to = '61000000', fee = 0, balance, txn }) =>
  `Vous avez envoye ${fmt(amount)} FCFA a ${to}. Frais: ${fmt(fee)} FCFA. Votre nouveau solde est de ${fmt(balance)} FCFA. Ref: ${txn}`;

let counter = 0;
const txnId = (prefix = 'CI') => `${prefix}${Date.now().toString().slice(-8)}.${String(++counter).padStart(4, '0')}`;

module.exports = { orangeCredit, orangeDebit, moovCredit, moovDebit, txnId };
