'use strict';

const dns = require('node:dns').promises;
const net = require('node:net');

/*
 * Protection contre le SSRF : on refuse d'envoyer des webhooks vers des adresses
 * internes (localhost, réseau privé, métadonnées cloud…). Sans cela, un marchand
 * pourrait faire appeler par le serveur des services qui ne sont pas exposés sur Internet.
 */

function ipv4ToInt(ip) {
  return ip.split('.').reduce((acc, part) => (acc << 8) + Number(part), 0) >>> 0;
}

function inRange(ip, cidr) {
  const [base, bits] = cidr.split('/');
  const mask = bits === '0' ? 0 : (~0 << (32 - Number(bits))) >>> 0;
  return (ipv4ToInt(ip) & mask) === (ipv4ToInt(base) & mask);
}

const PRIVATE_V4 = [
  '0.0.0.0/8', // « ce réseau »
  '10.0.0.0/8', // privé
  '100.64.0.0/10', // NAT opérateur
  '127.0.0.0/8', // boucle locale
  '169.254.0.0/16', // lien local (dont 169.254.169.254, métadonnées cloud)
  '172.16.0.0/12', // privé
  '192.0.0.0/24',
  '192.168.0.0/16', // privé
  '198.18.0.0/15', // tests
  '224.0.0.0/4', // multicast
  '240.0.0.0/4', // réservé + broadcast
];

/** Vrai si l'adresse IP (v4 ou v6) n'est pas joignable publiquement. */
function isPrivateIp(ip) {
  const family = net.isIP(ip);
  if (family === 4) return PRIVATE_V4.some((cidr) => inRange(ip, cidr));
  if (family === 6) {
    const v6 = ip.toLowerCase();
    if (v6 === '::' || v6 === '::1') return true;
    const mapped = v6.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateIp(mapped[1]);
    const first = parseInt(v6.split(':')[0] || '0', 16);
    if ((first & 0xfe00) === 0xfc00) return true; // fc00::/7 (adresses uniques locales)
    if ((first & 0xffc0) === 0xfe80) return true; // fe80::/10 (lien local)
    if ((first & 0xff00) === 0xff00) return true; // ff00::/8 (multicast)
    return false;
  }
  return true; // pas une IP valide : on refuse par prudence
}

function stripBrackets(host) {
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
}

/** Contrôle sans réseau : nom d'hôte local ou adresse IP privée écrite en clair. */
function isObviouslyInternalHost(hostname) {
  const host = stripBrackets(String(hostname || '').toLowerCase()).replace(/\.$/, '');
  if (!host) return true;
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) return true;
  if (net.isIP(host)) return isPrivateIp(host);
  return false;
}

/**
 * Résout le nom d'hôte et vérifie qu'AUCUNE des adresses obtenues n'est interne.
 * Renvoie null si tout va bien, sinon un message d'erreur court.
 */
async function checkPublicUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return 'invalid_url';
  }
  const host = stripBrackets(parsed.hostname);
  if (isObviouslyInternalHost(host)) return 'blocked_internal_address';
  if (net.isIP(host)) return null;
  let addresses;
  try {
    addresses = await dns.lookup(host, { all: true, verbatim: true });
  } catch (err) {
    return `dns_error:${err.code || 'unknown'}`;
  }
  if (!addresses.length || addresses.some((a) => isPrivateIp(a.address))) return 'blocked_internal_address';
  return null;
}

module.exports = { isPrivateIp, isObviouslyInternalHost, checkPublicUrl };
