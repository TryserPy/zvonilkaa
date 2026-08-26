/**
 * Минимальный WebSocket-сервер (RFC 6455) без внешних зависимостей.
 *
 * Реализовано ровно столько, сколько нужно сигналингу: текстовые кадры,
 * фрагментация, ping/pong, корректное закрытие. Благодаря этому проект
 * запускается одной командой `node server.js` — без npm install.
 */

'use strict';

const crypto = require('crypto');
const { EventEmitter } = require('events');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const OP = { CONT: 0x0, TEXT: 0x1, BIN: 0x2, CLOSE: 0x8, PING: 0x9, PONG: 0xa };

class WebSocketConnection extends EventEmitter {
  constructor(socket, maxPayload) {
    super();
    this.CONNECTING = 0; this.OPEN = 1; this.CLOSING = 2; this.CLOSED = 3;
    this.readyState = this.OPEN;

    this._socket = socket;
    this._max = maxPayload;
    this._buf = Buffer.alloc(0);
    this._fragments = [];
    this._fragmentOp = null;

    socket.on('data', (chunk) => this._onData(chunk));
    socket.on('close', () => this._finish());
    socket.on('error', (err) => { this.emit('error', err); this._finish(); });
    socket.setTimeout(0);
    socket.setNoDelay(true);
  }

  /* ── приём ── */

  _onData(chunk) {
    this._buf = this._buf.length ? Buffer.concat([this._buf, chunk]) : chunk;
    if (this._buf.length > this._max * 2) return this.close(1009, 'too big');

    while (true) {
      const frame = this._readFrame();
      if (!frame) break;
      this._handleFrame(frame);
      if (this.readyState === this.CLOSED) break;
    }
  }

  _readFrame() {
    const b = this._buf;
    if (b.length < 2) return null;

    const fin = (b[0] & 0x80) !== 0;
    const opcode = b[0] & 0x0f;
    const masked = (b[1] & 0x80) !== 0;
    let len = b[1] & 0x7f;
    let offset = 2;

    if (len === 126) {
      if (b.length < offset + 2) return null;
      len = b.readUInt16BE(offset);
      offset += 2;
    } else if (len === 127) {
      if (b.length < offset + 8) return null;
      const big = b.readBigUInt64BE(offset);
      if (big > BigInt(this._max)) { this.close(1009, 'too big'); return null; }
      len = Number(big);
      offset += 8;
    }

    if (len > this._max) { this.close(1009, 'too big'); return null; }

    const maskLen = masked ? 4 : 0;
    if (b.length < offset + maskLen + len) return null;

    let payload;
    if (masked) {
      const key = b.subarray(offset, offset + 4);
      payload = Buffer.from(b.subarray(offset + 4, offset + 4 + len));
      for (let i = 0; i < payload.length; i++) payload[i] ^= key[i & 3];
    } else {
      payload = Buffer.from(b.subarray(offset, offset + len));
    }

    this._buf = b.subarray(offset + maskLen + len);
    return { fin, opcode, payload };
  }

  _handleFrame({ fin, opcode, payload }) {
    switch (opcode) {
      case OP.PING:
        this._write(OP.PONG, payload);
        break;

      case OP.PONG:
        this.emit('pong', payload);
        break;

      case OP.CLOSE:
        this.readyState = this.CLOSING;
        this._write(OP.CLOSE, Buffer.alloc(0));
        this._socket.end();
        this._finish();
        break;

      case OP.TEXT:
      case OP.BIN:
        if (fin) return this.emit('message', payload);
        this._fragmentOp = opcode;
        this._fragments = [payload];
        break;

      case OP.CONT: {
        if (this._fragmentOp === null) return;
        this._fragments.push(payload);
        const total = this._fragments.reduce((n, p) => n + p.length, 0);
        if (total > this._max) return this.close(1009, 'too big');
        if (fin) {
          const full = Buffer.concat(this._fragments);
          this._fragments = [];
          this._fragmentOp = null;
          this.emit('message', full);
        }
        break;
      }
    }
  }

  /* ── отправка ── */

  _write(opcode, payload) {
    if (this._socket.destroyed) return;
    const len = payload.length;
    let header;

    if (len < 126) {
      header = Buffer.allocUnsafe(2);
      header[1] = len;
    } else if (len < 65536) {
      header = Buffer.allocUnsafe(4);
      header[1] = 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.allocUnsafe(10);
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }
    header[0] = 0x80 | opcode; // FIN + opcode, без маски (так и должно быть у сервера)

    try { this._socket.write(Buffer.concat([header, payload])); } catch {}
  }

  send(data) {
    if (this.readyState !== this.OPEN) return;
    this._write(OP.TEXT, Buffer.from(String(data), 'utf8'));
  }

  ping() {
    if (this.readyState === this.OPEN) this._write(OP.PING, Buffer.alloc(0));
  }

  close(code = 1000, reason = '') {
    if (this.readyState === this.CLOSED || this.readyState === this.CLOSING) return;
    this.readyState = this.CLOSING;
    const body = Buffer.alloc(2 + Buffer.byteLength(reason));
    body.writeUInt16BE(code, 0);
    body.write(reason, 2);
    this._write(OP.CLOSE, body);
    this._socket.end();
    setTimeout(() => this.terminate(), 1000).unref();
  }

  terminate() {
    this._socket.destroy();
    this._finish();
  }

  _finish() {
    if (this.readyState === this.CLOSED) return;
    this.readyState = this.CLOSED;
    this.emit('close');
  }
}

class WebSocketServer extends EventEmitter {
  constructor({ server, path = '/ws', maxPayload = 128 * 1024 }) {
    super();
    this.path = path;
    this.maxPayload = maxPayload;
    this.clients = new Set();

    server.on('upgrade', (req, socket, head) => this._upgrade(req, socket, head));
  }

  _upgrade(req, socket, head) {
    const url = (req.url || '').split('?')[0];
    const key = req.headers['sec-websocket-key'];

    if (url !== this.path || String(req.headers.upgrade || '').toLowerCase() !== 'websocket' || !key) {
      socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
      return socket.destroy();
    }

    const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
    );

    const ws = new WebSocketConnection(socket, this.maxPayload);
    if (head && head.length) ws._onData(head);

    this.clients.add(ws);
    ws.on('close', () => this.clients.delete(ws));
    this.emit('connection', ws, req);
  }

  close() {
    for (const ws of this.clients) ws.terminate();
    this.clients.clear();
    this.emit('close');
  }
}

module.exports = { WebSocketServer, WebSocketConnection };
