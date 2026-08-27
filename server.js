/**
 * Звонилка — сигнальный сервер + раздача статики.
 *
 * Сервер НИКОГДА не видит и не хранит медиапоток: он только помогает
 * двум браузерам найти друг друга (SDP + ICE). Сам звонок идёт напрямую
 * peer-to-peer и шифруется DTLS-SRTP на уровне протокола WebRTC.
 */

'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const os = require('os');
const { WebSocketServer } = require('./lib/ws');
const selfsigned = require('./lib/selfsigned');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_PEERS_PER_ROOM = 2;
const MAX_MESSAGE_BYTES = 96 * 1024; // SDP редко бывает больше 30 КБ
const HEARTBEAT_MS = 25_000;

/* ------------------------------------------------------------------ *
 * ICE-серверы
 * ------------------------------------------------------------------ */

function iceServers() {
  const list = [
    { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
  ];
  // TURN нужен, если оба собеседника за «строгим» NAT (мобильный интернет,
  // корпоративная сеть). Задаётся переменными окружения — см. README.
  if (process.env.TURN_URL) {
    list.push({
      urls: process.env.TURN_URL.split(',').map((s) => s.trim()),
      username: process.env.TURN_USERNAME || undefined,
      credential: process.env.TURN_PASSWORD || undefined,
    });
  }
  return list;
}

/* ------------------------------------------------------------------ *
 * Статика: кэш в памяти + gzip/brotli
 * ------------------------------------------------------------------ */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2',
};
const COMPRESSIBLE = new Set(['.html', '.css', '.js', '.json', '.svg', '.webmanifest']);
const assetCache = new Map();

function loadAsset(filePath) {
  const cached = assetCache.get(filePath);
  const stat = fs.statSync(filePath);
  if (cached && cached.mtimeMs === stat.mtimeMs) return cached;

  const raw = fs.readFileSync(filePath);
  const ext = path.extname(filePath).toLowerCase();
  const entry = {
    mtimeMs: stat.mtimeMs,
    type: MIME[ext] || 'application/octet-stream',
    raw,
    gzip: COMPRESSIBLE.has(ext) ? zlib.gzipSync(raw, { level: 9 }) : null,
    brotli: COMPRESSIBLE.has(ext)
      ? zlib.brotliCompressSync(raw, {
          params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 },
        })
      : null,
    etag: '"' + crypto.createHash('sha1').update(raw).digest('base64url') + '"',
  };
  assetCache.set(filePath, entry);
  return entry;
}

function resolveStaticPath(urlPath) {
  let rel = decodeURIComponent(urlPath.split('?')[0]);
  if (rel === '/' || rel === '') rel = '/index.html';
  const abs = path.normalize(path.join(PUBLIC_DIR, rel));
  // Защита от path traversal
  if (!abs.startsWith(PUBLIC_DIR)) return null;
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return null;
  return abs;
}

function sendAsset(req, res, filePath) {
  let asset;
  try {
    asset = loadAsset(filePath);
  } catch {
    return sendText(res, 500, 'Internal error');
  }

  const headers = {
    'Content-Type': asset.type,
    ETag: asset.etag,
    Vary: 'Accept-Encoding',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    // Всё отдаём с обязательной проверкой свежести. Раньше скрипты и стили
    // кэшировались на сутки, и после обновления браузер собирал франкенштейна
    // из новой разметки и старого кода — приложение падало на ровном месте.
    // ETag делает проверку дешёвой: почти всегда это пустой ответ 304.
    'Cache-Control': 'no-cache',
  };

  if (req.headers['if-none-match'] === asset.etag) {
    res.writeHead(304, headers);
    return res.end();
  }

  const accept = String(req.headers['accept-encoding'] || '');
  let body = asset.raw;
  if (asset.brotli && /\bbr\b/.test(accept)) {
    body = asset.brotli;
    headers['Content-Encoding'] = 'br';
  } else if (asset.gzip && /\bgzip\b/.test(accept)) {
    body = asset.gzip;
    headers['Content-Encoding'] = 'gzip';
  }

  headers['Content-Length'] = body.length;
  res.writeHead(200, headers);
  if (req.method === 'HEAD') return res.end();
  res.end(body);
}

function sendJson(res, code, data) {
  const body = Buffer.from(JSON.stringify(data));
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function sendText(res, code, text) {
  const body = Buffer.from(text, 'utf8');
  res.writeHead(code, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': body.length,
  });
  res.end(body);
}

/* ------------------------------------------------------------------ *
 * HTTP
 * ------------------------------------------------------------------ */

const requestHandler = (req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return sendText(res, 405, 'Method Not Allowed');
  }

  const url = req.url.split('?')[0];

  if (url === '/api/config') {
    return sendJson(res, 200, { iceServers: iceServers() });
  }
  if (url === '/api/health') {
    return sendJson(res, 200, { ok: true, rooms: rooms.size, uptime: process.uptime() });
  }

  const filePath = resolveStaticPath(url);
  if (filePath) return sendAsset(req, res, filePath);

  // /abc123 — ссылка на комнату, отдаём SPA
  if (/^\/[A-Za-z0-9_-]{1,64}\/?$/.test(url)) {
    return sendAsset(req, res, path.join(PUBLIC_DIR, 'index.html'));
  }

  sendText(res, 404, 'Not Found');
};

/** Все адреса, по которым к этому компьютеру могут обратиться. */
function localHosts() {
  const hosts = ['localhost', '127.0.0.1'];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const iface of list || []) {
      if (iface.family === 'IPv4' && !iface.internal) hosts.push(iface.address);
    }
  }
  return [...new Set(hosts)];
}

/**
 * Свой сертификат, если его нет. Браузер покажет предупреждение — это
 * нормально для самоподписанного сертификата, надо один раз согласиться.
 * Файлы сохраняются, чтобы согласие не пришлось давать заново.
 */
function ensureCert(certPath, keyPath) {
  const dir = path.dirname(certPath);
  const stampPath = path.join(dir, 'hosts.json');
  const hosts = localHosts();

  if (fs.existsSync(certPath) && fs.existsSync(keyPath)) {
    let same = false;
    try {
      const saved = JSON.parse(fs.readFileSync(stampPath, 'utf8'));
      same = JSON.stringify(saved) === JSON.stringify(hosts);
    } catch {}
    if (same) return { cert: fs.readFileSync(certPath), key: fs.readFileSync(keyPath) };
    console.log('→ Адреса компьютера изменились, перевыпускаю сертификат');
  }

  console.log('→ Выпускаю самоподписанный сертификат для: ' + hosts.join(', '));
  const { cert, key } = selfsigned.generate(hosts);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(certPath, cert);
  fs.writeFileSync(keyPath, key);
  fs.writeFileSync(stampPath, JSON.stringify(hosts));
  return { cert, key };
}

function createServer() {
  const certPath = process.env.SSL_CERT || path.join(__dirname, 'certs', 'cert.pem');
  const keyPath = process.env.SSL_KEY || path.join(__dirname, 'certs', 'key.pem');
  const wantHttps =
    process.env.HTTPS === '1' ||
    process.argv.includes('--https') ||
    (fs.existsSync(certPath) && fs.existsSync(keyPath));

  if (!wantHttps) return { server: http.createServer(requestHandler), secure: false };

  try {
    const creds = ensureCert(certPath, keyPath);
    return { server: https.createServer(creds, requestHandler), secure: true };
  } catch (err) {
    console.error('→ Не удалось поднять HTTPS: ' + err.message);
    return { server: http.createServer(requestHandler), secure: false };
  }
}

const { server, secure } = createServer();

/* ------------------------------------------------------------------ *
 * Сигнальный сервер (WebSocket)
 * ------------------------------------------------------------------ */

/** @type {Map<string, Map<string, import('ws').WebSocket>>} */
const rooms = new Map();

const wss = new WebSocketServer({ server, path: '/ws', maxPayload: MAX_MESSAGE_BYTES });

const send = (ws, type, payload = {}) => {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type, ...payload }));
};

const validRoom = (id) => typeof id === 'string' && /^[A-Za-z0-9_-]{3,64}$/.test(id);

function leaveRoom(ws) {
  const { roomId, peerId } = ws;
  if (!roomId) return;
  const room = rooms.get(roomId);
  if (!room) return;
  room.delete(peerId);
  for (const peer of room.values()) send(peer, 'peer-left', { peerId });
  if (room.size === 0) rooms.delete(roomId);
  ws.roomId = null;
}

wss.on('connection', (ws) => {
  ws.peerId = crypto.randomUUID();
  ws.roomId = null;
  ws.isAlive = true;
  ws.on('pong', () => {
    ws.isAlive = true;
  });

  send(ws, 'welcome', { peerId: ws.peerId, iceServers: iceServers() });

  ws.on('message', (data) => {
    let msg;
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }
    if (!msg || typeof msg.type !== 'string') return;

    switch (msg.type) {
      case 'join': {
        if (!validRoom(msg.roomId)) return send(ws, 'error', { reason: 'bad-room' });
        leaveRoom(ws);

        const room = rooms.get(msg.roomId) || new Map();
        if (room.size >= MAX_PEERS_PER_ROOM) {
          return send(ws, 'room-full', { roomId: msg.roomId });
        }

        // Первый в комнате — «невежливый» пир: при коллизии офферов
        // его предложение выигрывает (perfect negotiation).
        const polite = room.size > 0;
        const others = [...room.keys()];

        room.set(ws.peerId, ws);
        rooms.set(msg.roomId, room);
        ws.roomId = msg.roomId;

        send(ws, 'joined', { roomId: msg.roomId, peerId: ws.peerId, polite, peers: others });
        for (const [id, peer] of room) {
          if (id !== ws.peerId) send(peer, 'peer-joined', { peerId: ws.peerId });
        }
        break;
      }

      case 'signal': {
        // Прозрачная пересылка SDP/ICE второму участнику комнаты.
        const room = rooms.get(ws.roomId);
        if (!room) return;
        for (const [id, peer] of room) {
          if (id !== ws.peerId) send(peer, 'signal', { from: ws.peerId, data: msg.data });
        }
        break;
      }

      case 'bye':
        leaveRoom(ws);
        break;

      case 'ping':
        send(ws, 'pong', { t: msg.t });
        break;
    }
  });

  ws.on('close', () => leaveRoom(ws));
  ws.on('error', () => leaveRoom(ws));
});

// Отсекаем «мёртвые» соединения (мобильный браузер ушёл в фон и не закрылся).
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, HEARTBEAT_MS);
wss.on('close', () => clearInterval(heartbeat));

/* ------------------------------------------------------------------ */

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n  Порт ${PORT} уже занят — вероятно, сервер уже запущен.`);
    console.error('  Закройте его или укажите другой порт: PORT=8080 node server.js\n');
  } else {
    console.error('\n  Ошибка сервера: ' + err.message + '\n');
  }
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  const proto = secure ? 'https' : 'http';
  console.log(`\n  Звонилка запущена → ${proto}://localhost:${PORT}\n`);

  const lan = localHosts().filter((h) => h !== 'localhost' && h !== '127.0.0.1');
  if (secure && lan.length) {
    console.log('  В своей сети: ' + lan.map((ip) => `${proto}://${ip}:${PORT}`).join('  '));
    console.log('  При первом входе браузер предупредит о сертификате — это ожидаемо.\n');
  } else if (!secure) {
    console.log('  Камера и микрофон работают только на localhost или по HTTPS.');
    console.log('  Чтобы открыть с телефона или из локальной сети, запустите');
    console.log('  с ключом --https — сертификат выпишется сам.\n');
  }
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    console.log('\nОстанавливаю…');
    clearInterval(heartbeat);
    wss.close();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  });
}
