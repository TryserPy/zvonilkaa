/**
 * Выпуск самоподписанного сертификата без внешних зависимостей.
 *
 * Node умеет генерировать ключи и подписывать данные, но не умеет собирать
 * X.509 — поэтому структура сертификата кодируется здесь вручную, в DER.
 * Нужно это ради одного: браузер даёт доступ к камере и микрофону только в
 * защищённом контексте, то есть по HTTPS.
 */

'use strict';

const crypto = require('crypto');

/* ── Примитивы DER ─────────────────────────────────────────────────── */

function derLength(n) {
  if (n < 0x80) return Buffer.from([n]);
  const bytes = [];
  let x = n;
  while (x > 0) {
    bytes.unshift(x & 0xff);
    x = Math.floor(x / 256);
  }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

const tlv = (tag, body) => Buffer.concat([Buffer.from([tag]), derLength(body.length), body]);

const seq = (...parts) => tlv(0x30, Buffer.concat(parts));
const set = (...parts) => tlv(0x31, Buffer.concat(parts));
const nul = () => Buffer.from([0x05, 0x00]);
const bool = (v) => tlv(0x01, Buffer.from([v ? 0xff : 0x00]));
const octet = (body) => tlv(0x04, body);
const bitString = (body) => tlv(0x03, Buffer.concat([Buffer.from([0]), body]));
const utf8 = (s) => tlv(0x0c, Buffer.from(s, 'utf8'));
const explicit = (n, body) => tlv(0xa0 | n, body);

function integer(buf) {
  let b = Buffer.from(buf);
  let i = 0;
  while (i < b.length - 1 && b[i] === 0) i++;
  b = b.subarray(i);
  if (b[0] & 0x80) b = Buffer.concat([Buffer.from([0]), b]);
  return tlv(0x02, b);
}

const smallInt = (n) => integer(Buffer.from([n]));

function oid(dotted) {
  const parts = dotted.split('.').map(Number);
  const out = [40 * parts[0] + parts[1]];
  for (const part of parts.slice(2)) {
    const chunk = [];
    let v = part;
    do {
      chunk.unshift(v & 0x7f);
      v >>>= 7;
    } while (v > 0);
    for (let i = 0; i < chunk.length - 1; i++) chunk[i] |= 0x80;
    out.push(...chunk);
  }
  return tlv(0x06, Buffer.from(out));
}

function utcTime(date) {
  const p = (n) => String(n).padStart(2, '0');
  const s =
    p(date.getUTCFullYear() % 100) + p(date.getUTCMonth() + 1) + p(date.getUTCDate()) +
    p(date.getUTCHours()) + p(date.getUTCMinutes()) + p(date.getUTCSeconds()) + 'Z';
  return tlv(0x17, Buffer.from(s, 'ascii'));
}

/* ── Составные части сертификата ───────────────────────────────────── */

const OID = {
  sha256RSA: '1.2.840.113549.1.1.11',
  commonName: '2.5.4.3',
  basicConstraints: '2.5.29.19',
  keyUsage: '2.5.29.15',
  extKeyUsage: '2.5.29.37',
  subjectAltName: '2.5.29.17',
  serverAuth: '1.3.6.1.5.5.7.3.1',
};

const algorithm = () => seq(oid(OID.sha256RSA), nul());

const name = (cn) => seq(set(seq(oid(OID.commonName), utf8(cn))));

function extension(id, critical, value) {
  return critical
    ? seq(oid(id), bool(true), octet(value))
    : seq(oid(id), octet(value));
}

/** Список имён и адресов, для которых сертификат считается «своим». */
function subjectAltName(hosts) {
  const entries = hosts.map((host) => {
    const ip = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (ip) {
      const octets = ip.slice(1).map(Number);
      if (octets.every((n) => n <= 255)) return tlv(0x87, Buffer.from(octets)); // iPAddress
    }
    return tlv(0x82, Buffer.from(host, 'utf8')); // dNSName
  });
  return seq(...entries);
}

/**
 * @param {string[]} hosts  доменные имена и IP-адреса, например ['localhost','192.168.1.5']
 * @param {number}   days   срок действия
 * @returns {{cert: string, key: string, hosts: string[]}} PEM-строки
 */
function generate(hosts = ['localhost'], days = 825) {
  const list = [...new Set(hosts.filter(Boolean))];
  if (!list.length) list.push('localhost');

  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const spki = publicKey.export({ type: 'spki', format: 'der' });

  const now = new Date();
  const notBefore = new Date(now.getTime() - 24 * 3600 * 1000); // запас на расхождение часов
  const notAfter = new Date(now.getTime() + days * 24 * 3600 * 1000);

  const extensions = explicit(
    3,
    seq(
      extension(OID.basicConstraints, true, seq(bool(false))),
      // digitalSignature + keyEncipherment
      extension(OID.keyUsage, true, tlv(0x03, Buffer.from([0x05, 0xa0]))),
      extension(OID.extKeyUsage, false, seq(oid(OID.serverAuth))),
      extension(OID.subjectAltName, false, subjectAltName(list))
    )
  );

  const subject = name(list[0]);

  const tbs = seq(
    explicit(0, smallInt(2)), // версия v3
    integer(crypto.randomBytes(16)),
    algorithm(),
    subject, // самоподписанный: издатель совпадает с субъектом
    seq(utcTime(notBefore), utcTime(notAfter)),
    subject,
    spki,
    extensions
  );

  const signature = crypto.sign('sha256', tbs, privateKey);
  const certDer = seq(tbs, algorithm(), bitString(signature));

  return {
    cert: toPem(certDer, 'CERTIFICATE'),
    key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    hosts: list,
  };
}

function toPem(der, label) {
  const body = der.toString('base64').match(/.{1,64}/g).join('\n');
  return `-----BEGIN ${label}-----\n${body}\n-----END ${label}-----\n`;
}

module.exports = { generate };
