/* ═══════════════════════════════════════════════════════════════════
   Звонилка — клиентская логика WebRTC
   ═══════════════════════════════════════════════════════════════════ */

'use strict';

const $ = (id) => document.getElementById(id);

/** Видно в настройках: помогает понять, не подсунул ли браузер старую версию. */
const BUILD = '2026-08-27';

/**
 * Порядок трансиверов фиксирован и одинаков на обеих сторонах, поэтому
 * входящую дорожку можно опознать по её месту: 0 — микрофон, 1 — камера,
 * 2 — экран, 3 — звук экрана. Это позволяет вести камеру и демонстрацию
 * одновременно и включать их без переговоров о соединении.
 */
const ROLES = ['mic', 'cam', 'screen', 'screenAudio'];

/**
 * Кто мы и на чём. Влияет на выбор кодека: у телефонов аппаратный H.264,
 * и картинка через него не рассыпается при нагреве, а на настольных
 * машинах выгоднее VP9 — та же чёткость при меньшем битрейте.
 */
const PLATFORM = (() => {
  const ua = navigator.userAgent || '';
  const iPadOS = navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1;
  const ios = /iPad|iPhone|iPod/.test(ua) || iPadOS;
  const android = /Android/.test(ua);
  const safari = /Safari/.test(ua) && !/Chrome|Chromium|Edg|OPR/.test(ua);
  return {
    ios, android, safari,
    mobile: ios || android,
    name: ios ? 'iOS' : android ? 'Android' : /Windows/.test(ua) ? 'Windows'
        : /Mac OS X/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : 'ПК',
  };
})();

/** Порядок кодеков камеры. Решает связка платформ, а не одна наша. */
function camCodecOrder(peerMobile) {
  return PLATFORM.mobile || peerMobile
    ? ['H264', 'VP8', 'VP9', 'AV1']   // аппаратный декодер телефона
    : ['VP9', 'VP8', 'H264', 'AV1'];  // качество на том же битрейте
}

/** Порядок плиток в ленте миниатюр. */
const TILE_ORDER = ['remote-screen', 'remote-cam', 'local-screen', 'local-cam'];

const S = {
  roomId: null,
  roomKey: null,      // текстовый вид, идёт в ссылку
  key: null,          // импортированный CryptoKey
  keyWarned: false,
  fatal: null,
  polite: false,
  peerId: null,
  peerPresent: false,

  ws: null,
  wsRetry: 0,
  pc: null,

  camStream: null,      // микрофон + камера
  screenStream: null,   // экран + его звук
  local: { mic: null, cam: null, screen: null, screenAudio: null },
  send: { mic: null, cam: null, screen: null, screenAudio: null },
  remote: { mic: null, cam: null, screen: null, screenAudio: null },

  micOn: true,
  camOn: true,
  sharing: false,
  speakerOn: true,
  facing: 'user',

  main: null,
  mainLocked: false,
  remoteState: { mic: true, cam: false, screen: false },
  remoteKnown: false,

  name: '',
  peerName: '',
  chat: null,        // канал данных
  chatOpen: false,
  unread: 0,

  lowLatency: true,
  latencyBackoff: false,
  shareQuality: 'detail',
  shareAudio: true,
  mirror: true,
  noiseSuppress: true,
  echoCancel: true,
  autoGain: true,
  sinkId: '',
  soundBlocked: false,
  audioProcFixed: false,
  outPeak: 0,
  inPeak: 0,
  micPeak: 0,
  speakingSelf: false,
  tick: 0,
  lastRecover: 0,
  logErrors: 0,
  restarting: false,
  serverBuild: '',
  lastRoute: '',
  rtts: [],
  rttWin: [],        // окно для медианы — показания не должны прыгать
  rttEma: null,
  rttVar: 0,         // средний разброс пинга — он и есть «стабильность»
  lossEma: 0,
  jitterMs: 0,
  restarts: 0,

  dcRtt: null,       // задержка, померенная своим пингом по каналу данных
  dcSentAt: 0,
  keepTimer: null,
  keepMisses: 0,
  disconnectedAt: 0,
  relayTried: false,
  statsSlow: false,
  shakySince: 0,

  peerPlatform: '',
  peerMobile: false,
  codecTuned: false,
  forceRelay: false,
  iceTries: 0,
  connectDeadline: 0,
  badSince: 0,
  netWatch: null,
  handshakeTimer: null,
  rottenSince: 0,
  bufferMs: undefined,

  makingOffer: false,
  ignoreOffer: false,
  settingRemoteAnswer: false,

  statsTimer: null,
  prev: null,
  quality: 2,
  qualityHold: 0,
  qualityAt: 0,
  voiceOnly: false,
  voiceOnlySince: 0,
  wakeLock: null,
  fingerprint: null,
  inCall: false,
  // Оценка канала: сколько браузер реально готов отдать в сеть
  bwe: null,
  bweAt: 0,
  bweSeen: 0,
  outBps: 0,
  videoInBps: 0,
  // Замершая картинка: сколько секунд подряд не прибавляются кадры
  frameStall: 0,
  kfAskedAt: 0,
  wsTimer: null,
  offerAsked: 0,
  leaveTimer: null,
  // Ретранслятор: работает ли он на самом деле, а не просто вписан в список
  relayOk: null,
  relayProbe: null,
  relaySince: 0,
  candsAll: 0,
  candsRelay: 0,
};

/** Как снимать и кодировать экран под разные задачи. */
const SHARE_PRESETS = {
  detail: {
    label: 'чёткость',
    hint: 'text',
    fps: 30,
    bitrate: 5_000_000,
    degradation: 'maintain-resolution', // текст не должен мылиться
    codecs: ['VP9', 'AV1', 'VP8'],
  },
  motion: {
    label: 'плавность',
    hint: 'motion',
    fps: 60,
    bitrate: 8_000_000,
    degradation: 'maintain-framerate',
    codecs: ['VP9', 'VP8'],
  },
};

/**
 * Потолок для картинки, посчитанный от измеренного канала.
 *
 * Браузер всё время меряет пропускную способность сам (transport-cc), и
 * величина эта лежит в availableOutgoingBitrate. Соблазн велик — взять её
 * и ограничить ею кодер. Так делать нельзя: вверх канал прощупывается
 * ровно до заданного потолка, и потолок «сколько есть прямо сейчас»
 * запирает звонок на этом значении навсегда. Поэтому потолок ставим с
 * запасом НАД оценкой: перегрузить канал он всё равно не даст — за этим
 * следит собственный регулятор браузера, который никогда не отдаёт
 * больше, чем канал вывозит.
 *
 * А вот выбирать по этой величине ступень качества — разрешение и
 * частоту кадров — можно и нужно. Раньше ступень выбиралась постфактум,
 * по потерям и пингу, то есть уже после того, как канал захлебнулся.
 * Теперь мы знаем ширину канала заранее и просим у кодера ровно то, что
 * в него влезает. Именно переполненная очередь в роутере и даёт «пинг
 * скачет от 100 до 250» и обрывы на VPN.
 *
 * Safari и Firefox эту величину не заполняют — там возвращаем null и
 * работаем по старой схеме, от потерь.
 */
const BWE_STALE_MS = 4000;
function videoBudget() {
  if (S.bwe == null || performance.now() - S.bweAt > BWE_STALE_MS) return null;
  return Math.max(300_000, S.bwe * 1.25);
}

/** Самая высокая ступень лестницы, которая помещается в такой канал. */
function rungForBudget(bits) {
  for (let i = 0; i < LADDER.length; i++) if (LADDER[i].bitrate <= bits) return i;
  return LADDER.length - 1;
}

const LADDER = [
  { bitrate: 4_000_000, fps: 30, label: 'максимальное' },
  { bitrate: 2_500_000, fps: 30, label: 'высокое' },
  { bitrate: 1_200_000, fps: 30, label: 'хорошее' },
  { bitrate: 600_000, fps: 25, label: 'среднее' },
  { bitrate: 250_000, fps: 18, label: 'экономное' },
];

/* ─────────────── Мелкие утилиты ─────────────── */

let toastTimer;
function toast(text, ms = 2400) {
  const el = $('toast');
  el.textContent = text;
  el.classList.add('is-on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('is-on'), ms);
}

function show(screenId) {
  for (const el of document.querySelectorAll('.screen')) el.classList.remove('is-active');
  $(screenId).classList.add('is-active');
}

function setInvite(visible) {
  $('invitePanel').hidden = !visible;
}

function randomRoomId() {
  const abc = 'abcdefghijkmnpqrstuvwxyz23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  const s = [...bytes].map((b) => abc[b % abc.length]).join('');
  return `${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8, 12)}`;
}

const fmtKbps = (bps) =>
  bps >= 1_000_000 ? (bps / 1_000_000).toFixed(1) + ' Мбит/с' : Math.round(bps / 1000) + ' кбит/с';

/* ═══════════════════════════════════════════════════════════════════
   КЛЮЧ КОМНАТЫ
   ═══════════════════════════════════════════════════════════════════ */

/*
 * Ключ живёт в якоре ссылки (после #) и по правилам HTTP на сервер не
 * отправляется. Им шифруется весь сигналинг: сервер видит только шифротекст
 * и не может ни прочитать SDP, ни подменить отпечатки сертификатов, то есть
 * встать посередине звонка у него не выйдет даже теоретически.
 */

const b64 = {
  encode(bytes) {
    let str = '';
    for (const b of bytes) str += String.fromCharCode(b);
    return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  },
  decode(text) {
    const padded = text.replace(/-/g, '+').replace(/_/g, '/');
    const raw = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
    return Uint8Array.from(raw, (c) => c.charCodeAt(0));
  },
};

const newRoomKey = () => b64.encode(crypto.getRandomValues(new Uint8Array(32)));

async function importRoomKey(text) {
  if (!text || !crypto.subtle) return null;
  try {
    const raw = b64.decode(text);
    if (raw.length !== 32) return null;
    return await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
  } catch {
    return null;
  }
}

async function seal(key, value) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const body = new TextEncoder().encode(JSON.stringify(value));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, body));
  const joined = new Uint8Array(iv.length + ct.length);
  joined.set(iv);
  joined.set(ct, iv.length);
  return { e: b64.encode(joined) };
}

async function unseal(key, payload) {
  const joined = b64.decode(payload.e);
  const iv = joined.subarray(0, 12);
  const ct = joined.subarray(12);
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
  return JSON.parse(new TextDecoder().decode(plain));
}

/** Достаёт код комнаты и ключ из ссылки или из того, что вставили в поле. */
function parseRoomLink(text) {
  const raw = String(text || '').trim();
  const hash = raw.match(/#k=([A-Za-z0-9_-]{40,64})/);
  const withoutHash = raw.split('#')[0];
  const id = (withoutHash.split(/[/?]/).filter(Boolean).pop() || '')
    .replace(/[^A-Za-z0-9_-]/g, '');
  return { id, key: hash ? hash[1] : null };
}

/* Настройки, которые стоит помнить между звонками */
const prefs = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem('zv-' + key);
      return v === null ? fallback : JSON.parse(v);
    } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem('zv-' + key, JSON.stringify(value)); } catch {}
  },
};

/* ═══════════════════════════════════════════════════════════════════
   ЖУРНАЛ
   ═══════════════════════════════════════════════════════════════════ */

/*
 * Кольцевой буфер событий: состояния соединения, отказы, выбранные сетевые
 * пути. Нужен, чтобы разбирать жалобы вида «связь пропала» по фактам, а не
 * по памяти. Наружу ничего не уходит — только по кнопке «Скопировать».
 */
const LOG = [];
const LOG_LIMIT = 400;

function logEvent(kind, text) {
  const entry = { t: Date.now(), kind, text: String(text).slice(0, 400) };
  LOG.push(entry);
  if (LOG.length > LOG_LIMIT) LOG.shift();

  if (kind === 'error') {
    S.logErrors++;
    renderLogBadge();
  }
  if (!$('logView').hidden) renderLog();
}

const logTime = (t) => new Date(t).toTimeString().slice(0, 8);

function renderLog() {
  const list = $('logList');
  if (!LOG.length) {
    list.innerHTML = '<p class="log__empty">Пока пусто. Здесь появятся события соединения и ошибки.</p>';
    return;
  }
  list.innerHTML = '';
  for (const entry of LOG) {
    const row = document.createElement('div');
    row.className = 'log__row' + (entry.kind === 'plain' ? '' : ' is-' + entry.kind);
    const time = document.createElement('span');
    time.className = 'log__t';
    time.textContent = logTime(entry.t);
    const text = document.createElement('span');
    text.className = 'log__text';
    text.textContent = entry.text;
    row.append(time, text);
    list.append(row);
  }
  list.scrollTop = list.scrollHeight;
}

function renderLogBadge() {
  const badge = $('logBadge');
  badge.hidden = S.logErrors === 0 || !$('logView').hidden;
  badge.textContent = S.logErrors > 9 ? '9+' : String(S.logErrors);
}

function logReport() {
  const head = [
    'Звонилка, отчёт',
    'Сборка: ' + BUILD + ' · ' + (S.serverBuild || '?'),
    'Браузер: ' + navigator.userAgent,
    'Комната: ' + (S.roomId || '—') + (S.key ? ' (с ключом)' : ' (без ключа)'),
    'Состояние: ' + (S.pc ? S.pc.connectionState + ' / ' + S.pc.iceConnectionState : 'нет соединения'),
    'Маршрут: ' + (S.lastRoute || '—'),
    'Пинг: ' + (S.rtts.length ? summarizeRtt() : '—'),
    'Разброс пинга: ' + (S.rttEma == null ? '—' : '±' + Math.round(S.rttVar) + ' мс'),
    'Потери: ' + (S.lossEma || 0).toFixed(1) + ' %',
    'Ретранслятор: ' + (
      S.forceRelay ? 'принудительно'
      : S.relayOk === true ? 'отвечает'
      : S.relayOk === false ? 'не отвечает'
      : hasRelay() ? 'задан, ещё не проверен'
      : 'не задан'),
    'Пересборок: ' + S.restarts,
    '',
  ].join('\n');
  return head + LOG.map((e) => logTime(e.t) + '  ' + e.text).join('\n');
}

$('logCopy').addEventListener('click', async () => {
  const text = logReport();
  try {
    await navigator.clipboard.writeText(text);
    toast('Отчёт скопирован — вставьте его в переписку');
  } catch {
    toast('Не удалось скопировать. Выделите текст журнала вручную.', 4000);
  }
});

addEventListener('error', (e) => logEvent('error', 'Ошибка: ' + (e.message || e.type)));
addEventListener('unhandledrejection', (e) =>
  logEvent('error', 'Необработанный сбой: ' + (e.reason?.message || e.reason))
);

/* ─────────────── Тема ─────────────── */

(function initTheme() {
  const saved = prefs.get('theme', null);
  if (saved) document.documentElement.dataset.theme = saved;
})();

$('themeToggle').addEventListener('click', () => {
  const root = document.documentElement;
  const isDark =
    root.dataset.theme === 'dark' ||
    (!root.dataset.theme && matchMedia('(prefers-color-scheme: dark)').matches);
  root.dataset.theme = isDark ? 'light' : 'dark';
  prefs.set('theme', root.dataset.theme);
});

/* ═══════════════════════════════════════════════════════════════════
   МЕДИА
   ═══════════════════════════════════════════════════════════════════ */

const audioConstraints = () => ({
  echoCancellation: S.echoCancel,
  noiseSuppression: S.noiseSuppress,
  autoGainControl: S.autoGain,
  channelCount: 1,
});

/*
 * Телефон и компьютер снимают по-разному нарочно. 1080p на iPhone или
 * Android — это лишний нагрев, троттлинг через десять минут и севшая
 * батарея, а разница на собеседниковом экране почти не видна: мобильная
 * камера всё равно отдаёт мягкую картинку. На настольной машине запас
 * есть, и там честные 1080p заметно чище.
 */
const videoConstraints = (facing) =>
  PLATFORM.mobile
    ? {
        width: { ideal: 1280 },
        height: { ideal: 720 },
        frameRate: { ideal: 30, max: 30 },
        facingMode: { ideal: facing },
      }
    : {
        width: { ideal: 1920, max: 1920 },
        height: { ideal: 1080, max: 1080 },
        frameRate: { ideal: 30, max: 30 },
        facingMode: { ideal: facing },
      };

async function ensureMedia() {
  if (S.camStream) return S.camStream;

  if (!navigator.mediaDevices?.getUserMedia) {
    toast('Браузер не даёт доступ к камере. Нужен HTTPS или localhost.', 6000);
    return null;
  }

  const attempts = [
    { audio: audioConstraints(), video: videoConstraints(S.facing) },
    { audio: audioConstraints(), video: true },
    { audio: audioConstraints(), video: false },
  ];

  for (const c of attempts) {
    try {
      // Занятая другой программой камера умеет не отвечать вовсе,
      // поэтому ждём её ограниченное время и идём дальше
      const stream = await Promise.race([
        navigator.mediaDevices.getUserMedia(c),
        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 12000)),
      ]);
      adoptCamStream(stream);
      if (!c.video) {
        S.camOn = false;
        toast('Камера недоступна — звонок только со звуком');
      }
      return stream;
    } catch (err) {
      logEvent(err?.message === 'timeout' ? 'error' : 'warn', 'Устройства: ' + (err?.name || err?.message));
      if (err?.name === 'NotAllowedError') {
        toast('Доступ к камере и микрофону запрещён. Разрешите его в настройках сайта.', 6000);
        return null;
      }
      if (err?.message === 'timeout' && c.video) {
        toast('Камера не отвечает — возможно, занята другой программой. Пробую только звук.', 6000);
      }
    }
  }
  toast('Не удалось получить доступ к устройствам. Звонок продолжится без них.', 6000);
  return null;
}

function adoptCamStream(stream) {
  S.camStream = stream;
  S.local.mic = stream.getAudioTracks()[0] || null;
  S.local.cam = stream.getVideoTracks()[0] || null;

  if (S.local.mic) {
    try { S.local.mic.contentHint = 'speech'; } catch {}
    S.local.mic.enabled = S.micOn;
  }
  if (S.local.cam) {
    try { S.local.cam.contentHint = 'motion'; } catch {}
    S.local.cam.enabled = S.camOn;
  }

  $('previewVideo').srcObject = stream;
  tileVideo('local-cam').srcObject = stream;

  watchLevel('self', stream);
  listDevices();
  refreshUi();
  if (S.pc) bindRoles();   // соединение уже могло подняться без нас
}

const tileEl = (id) => document.querySelector(`.tile[data-src="${id}"]`);
const tileVideo = (id) => tileEl(id).querySelector('video');

/* ─────────────── Устройства ─────────────── */

async function listDevices() {
  let devices = [];
  try {
    devices = await navigator.mediaDevices.enumerateDevices();
  } catch {
    return;
  }

  fillSelect($('micSelect'), devices.filter((d) => d.kind === 'audioinput'), 'Микрофон');
  const cams = devices.filter((d) => d.kind === 'videoinput');
  fillSelect($('camSelect'), cams, 'Камера');
  renderOutputs(devices.filter((d) => d.kind === 'audiooutput'));

  // Кнопка смены камеры нужна, только когда камер и правда несколько
  $('flipBtn').hidden = cams.length < 2;

  // Текущие устройства отмечаем в списках
  const micId = S.local.mic?.getSettings().deviceId;
  const camId = S.local.cam?.getSettings().deviceId;
  if (micId) $('micSelect').value = micId;
  if (camId) $('camSelect').value = camId;
}

const canSetSink = () =>
  typeof HTMLMediaElement !== 'undefined' && 'setSinkId' in HTMLMediaElement.prototype;

/**
 * Список динамиков ведёт себя по-разному: Chrome отдаёт его сразу после
 * разрешения на микрофон, Firefox — только по явному запросу, Safari не
 * умеет переключать вывод вовсе. Раньше поле просто исчезало и выглядело
 * как пропавшая функция; теперь всегда объясняем, что происходит.
 */
function renderOutputs(outputs) {
  const field = $('spkField');
  const select = $('spkSelect');
  const ask = $('spkAskBtn');
  const note = $('spkNote');

  field.hidden = false;
  select.hidden = true;
  ask.hidden = true;
  note.hidden = true;
  note.className = 'field__note';

  if (!canSetSink()) {
    note.hidden = false;
    note.className = 'field__note is-warn';
    note.textContent = 'Этот браузер не умеет переключать вывод звука. Смените устройство по умолчанию в настройках системы.';
    return;
  }

  if (outputs.length) {
    fillSelect(select, outputs, 'Устройство');
    if (S.sinkId && outputs.some((d) => d.deviceId === S.sinkId)) select.value = S.sinkId;
    select.hidden = false;
    return;
  }

  if (typeof navigator.mediaDevices?.selectAudioOutput === 'function') {
    ask.hidden = false;
    note.hidden = false;
    note.textContent = 'Браузер показывает список динамиков только по запросу.';
    return;
  }

  note.hidden = false;
  note.className = 'field__note is-warn';
  note.textContent = 'Устройства вывода не найдены. Обычно список появляется после разрешения на микрофон — проверьте, что наушники подключены, и обновите страницу.';
}

$('spkAskBtn').addEventListener('click', async () => {
  try {
    const device = await navigator.mediaDevices.selectAudioOutput();
    if (device?.deviceId) await setSink(device.deviceId);
    listDevices();
  } catch {
    /* пользователь закрыл выбор */
  }
});

function fillSelect(select, devices, fallback) {
  const current = select.value;
  select.innerHTML = '';
  devices.forEach((d, i) => {
    const o = document.createElement('option');
    o.value = d.deviceId;
    o.textContent = d.label || `${fallback} ${i + 1}`;
    select.append(o);
  });
  if (devices.some((d) => d.deviceId === current)) select.value = current;
}

/** Смена микрофона или камеры без разрыва звонка. */
async function switchDevice(kind, deviceId) {
  if (!S.camStream) return;

  try {
    const constraints =
      kind === 'audio'
        ? { audio: { ...audioConstraints(), deviceId: { exact: deviceId } } }
        : { video: { ...videoConstraints(S.facing), deviceId: { exact: deviceId } } };

    const fresh = await navigator.mediaDevices.getUserMedia(constraints);
    const track = fresh.getTracks()[0];
    const role = kind === 'audio' ? 'mic' : 'cam';
    const old = S.local[role];

    track.enabled = kind === 'audio' ? S.micOn : S.camOn;
    try { track.contentHint = kind === 'audio' ? 'speech' : 'motion'; } catch {}

    if (S.send[role]) await S.send[role].replaceTrack(track);

    if (old) { S.camStream.removeTrack(old); old.stop(); }
    S.camStream.addTrack(track);
    S.local[role] = track;

    $('previewVideo').srcObject = S.camStream;
    tileVideo('local-cam').srcObject = S.camStream;
    if (kind === 'audio') watchLevel('self', S.camStream, true);

    toast(kind === 'audio' ? 'Микрофон переключён' : 'Камера переключена', 1600);
  } catch {
    toast('Не удалось переключить устройство');
  }
}

$('micSelect').addEventListener('change', (e) => switchDevice('audio', e.target.value));
$('camSelect').addEventListener('change', (e) => switchDevice('video', e.target.value));
$('spkSelect').addEventListener('change', (e) => setSink(e.target.value));

/** Фронтальная или основная — на телефоне это самая нужная кнопка. */
$('flipBtn').addEventListener('click', async () => {
  const cams = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput');
  if (cams.length < 2) return;

  const current = S.local.cam?.getSettings().deviceId;
  const index = cams.findIndex((d) => d.deviceId === current);
  const next = cams[(index + 1) % cams.length];

  S.facing = S.facing === 'user' ? 'environment' : 'user';
  await switchDevice('video', next.deviceId);
});

async function setSink(deviceId) {
  S.sinkId = deviceId;
  prefs.set('sink', deviceId);
  for (const el of audioEls()) {
    try { await el.setSinkId(deviceId); } catch {}
  }
  toast('Звук выводится на выбранное устройство', 1600);
}

/* ─────────────── Воспроизведение звука ─────────────── */

/*
 * Звук собеседника воспроизводится тем же элементом, что и его видео.
 * Отдельный <audio> выглядел аккуратнее, но Safari на iOS через него
 * молчит — это была причина «меня никто не слышит».
 */
const audioEls = () => [tileVideo('remote-cam'), tileVideo('remote-screen')];

const remoteTracks = { mic: null, cam: null, screen: null, screenAudio: null };

/** Пересобирает потоки удалённых плиток из пришедших дорожек. */
function attachRemote() {
  const pairs = [
    ['remote-cam', remoteTracks.cam, remoteTracks.mic],
    ['remote-screen', remoteTracks.screen, remoteTracks.screenAudio],
  ];

  for (const [id, video, audio] of pairs) {
    const el = tileVideo(id);
    const tracks = [video, audio].filter(Boolean);
    if (!tracks.length) continue;

    const current = el.srcObject ? el.srcObject.getTracks() : [];
    const same = current.length === tracks.length && tracks.every((t) => current.includes(t));
    if (!same) el.srcObject = new MediaStream(tracks);

    el.muted = !S.speakerOn;
    el.playsInline = true;
    if (S.sinkId && el.setSinkId) el.setSinkId(S.sinkId).catch(() => {});
  }
}

/**
 * Браузер не даёт запустить звук, пока по странице не кликнули. Раньше
 * звук ехал вместе с видео и проблема не проявлялась; теперь дорожки
 * разные, поэтому запускаем воспроизведение вручную и, если заблокировано,
 * показываем кнопку.
 */
async function playRemoteAudio() {
  /*
   * Тонкость, которая стоила кнопке работоспособности.
   *
   * play() у элемента, в который ещё не пришло ни одного кадра, не
   * отклоняется и не выполняется — он просто ждёт начала воспроизведения.
   * Плитка демонстрации существует всегда, а показывают экран далеко не
   * всегда: дорожки в ней есть, данных в них нет. Обещание висит вечно.
   *
   * Раньше элементы обходились по очереди с await на каждом. Первый же
   * такой элемент останавливал всю функцию: до строчки, которая прячет
   * кнопку, дело не доходило никогда. Со стороны это выглядело ровно так,
   * как человек и описал: «зелёная кнопка не жмётся» — звук при этом
   * честно включался, просто кнопка оставалась висеть.
   *
   * Поэтому: все элементы разом, и у каждого своё терпение.
   */
  const tries = audioEls().map(async (el) => {
    if (!el.srcObject) return false;
    el.muted = !S.speakerOn;
    el.volume = 1;
    try {
      await Promise.race([
        el.play(),
        new Promise((resolve) => setTimeout(resolve, 1200)),
      ]);
      return false;
    } catch (err) {
      return err?.name === 'NotAllowedError';
    }
  });

  const blocked = (await Promise.all(tries)).some(Boolean);
  S.soundBlocked = blocked;
  $('soundGate').hidden = !(blocked && S.speakerOn);
  return !blocked;
}

$('soundGate').addEventListener('click', async () => {
  try { await audioCtx?.resume(); } catch {}
  await playRemoteAudio();
  if (!S.soundBlocked) toast('Звук включён');
});

/* ─────────────── Обработка микрофона ─────────────── */

/**
 * Шумоподавление и эхоподавление живут в самом треке. Chrome умеет менять
 * их на лету, остальные — только пересозданием дорожки.
 */
async function applyAudioProcessing(announce) {
  const track = S.local.mic;
  if (!track) return;
  const wanted = {
    echoCancellation: S.echoCancel,
    noiseSuppression: S.noiseSuppress,
    autoGainControl: S.autoGain,
  };

  const reflects = (t) => {
    const got = t.getSettings();
    // Часть устройств просто не сообщает эти поля — считаем, что применилось
    if (got.noiseSuppression === undefined) return true;
    return got.noiseSuppression === S.noiseSuppress;
  };

  let failed = false;
  try {
    await track.applyConstraints(wanted);
  } catch {
    failed = true;
  }

  if (!failed && reflects(track)) {
    if (announce) toast(S.noiseSuppress ? 'Шумоподавление включено' : 'Шумоподавление выключено', 1600);
    return;
  }

  // Пересоздаём дорожку только если это вообще помогает: некоторые
  // устройства не поддерживают обработку и всегда рапортуют своё,
  // и тогда бесконечно пересоздавать микрофон бессмысленно.
  if (S.audioProcFixed) {
    if (announce) toast('Устройство не поддерживает эту настройку', 2200);
    return;
  }

  try {
    const deviceId = track.getSettings().deviceId;
    const fresh = await navigator.mediaDevices.getUserMedia({
      audio: deviceId
        ? { ...wanted, channelCount: 1, deviceId: { exact: deviceId } }
        : { ...wanted, channelCount: 1 },
    });
    const next = fresh.getAudioTracks()[0];
    next.enabled = S.micOn;
    try { next.contentHint = 'speech'; } catch {}

    if (S.send.mic) await S.send.mic.replaceTrack(next);
    S.camStream.removeTrack(track);
    track.stop();
    S.camStream.addTrack(next);
    S.local.mic = next;
    watchLevel('self', S.camStream, true);

    if (!reflects(next)) S.audioProcFixed = true;
    if (announce) toast('Настройки микрофона применены', 1600);
  } catch {
    if (announce) toast('Не удалось изменить настройки микрофона');
  }
}

/* ─────────────── Индикатор речи ─────────────── */

let audioCtx = null;
const meters = {};

function watchLevel(who, stream, restart = false) {
  if (!stream || !stream.getAudioTracks().length) return;
  if (meters[who] && !restart) return;
  if (meters[who]) { meters[who].stop(); delete meters[who]; }

  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const source = audioCtx.createMediaStreamSource(stream);
    const analyser = audioCtx.createAnalyser();
    analyser.fftSize = 512;
    analyser.smoothingTimeConstant = 0.6;
    source.connect(analyser);

    const buf = new Uint8Array(analyser.frequencyBinCount);
    let raf = 0;
    let speaking = false;
    let quietSince = 0;

    const loop = () => {
      analyser.getByteFrequencyData(buf);
      let sum = 0;
      for (const v of buf) sum += v * v;
      const level = Math.min(1, Math.sqrt(sum / buf.length) / 48);

      const gated = who === 'self' && !S.micOn ? 0 : level;
      onLevel(who, gated);

      // Небольшая задержка на затухание, чтобы рамка не мигала между словами
      const now = performance.now();
      if (gated > 0.12) { quietSince = 0; if (!speaking) { speaking = true; onSpeak(who, true); } }
      else if (speaking) {
        if (!quietSince) quietSince = now;
        else if (now - quietSince > 450) { speaking = false; onSpeak(who, false); }
      }

      raf = requestAnimationFrame(loop);
    };
    loop();

    meters[who] = {
      stop() {
        cancelAnimationFrame(raf);
        try { source.disconnect(); } catch {}
        onSpeak(who, false);
        onLevel(who, 0);
      },
    };
  } catch {}
}

function onLevel(who, level) {
  if (who !== 'self') return;
  const pct = Math.round(level * 100);
  $('previewMeter').firstElementChild.style.width = pct + '%';
  $('probeMic').style.width = pct + '%';
  $('micBtn').style.setProperty('--lvl', level.toFixed(2));
  $('micBtn').style.setProperty('--lvlop', level > 0.04 ? '1' : '0');
  S.micPeak = Math.max(level, S.micPeak * 0.93);
}

function onSpeak(who, on) {
  const id = who === 'self' ? 'local-cam' : 'remote-cam';
  tileEl(id)?.classList.toggle('is-speaking', on);
  if (who === 'self') {
    S.speakingSelf = on;
    sendState(); // собеседник узнаёт о речи от нас, а не разбирая наш звук
  }
}

/* ─────────────── Переключатели ─────────────── */

function setMic(on) {
  S.micOn = on;
  if (S.local.mic) S.local.mic.enabled = on;
  refreshUi();
  sendState();
}

function setCam(on) {
  S.camOn = on;
  if (S.local.cam) S.local.cam.enabled = on;
  refreshUi();
  sendState();
}

function setSpeaker(on) {
  S.speakerOn = on;
  for (const el of audioEls()) el.muted = !on;
  if (on) playRemoteAudio();
  else $('soundGate').hidden = true;
  refreshUi();
}

$('micBtn').addEventListener('click', () => setMic(!S.micOn));
$('camBtn').addEventListener('click', () => setCam(!S.camOn));
$('speakerBtn').addEventListener('click', () => {
  setSpeaker(!S.speakerOn);
  toast(S.speakerOn ? 'Звук включён' : 'Звук выключен', 1400);
});
$('prevMicBtn').addEventListener('click', () => setMic(!S.micOn));
$('prevCamBtn').addEventListener('click', () => setCam(!S.camOn));

/* ─────────────── Демонстрация экрана ─────────────── */

$('shareScreenBtn').addEventListener('click', () => (S.sharing ? stopShare() : startShare()));

function hideShareButton(reason) {
  $('shareScreenBtn').hidden = true;
  if (reason) toast(reason, 4000);
}

async function startShare() {
  if (!navigator.mediaDevices?.getDisplayMedia) {
    return hideShareButton('Демонстрация экрана недоступна в мобильных браузерах');
  }

  const preset = SHARE_PRESETS[S.shareQuality] || SHARE_PRESETS.detail;

  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: {
        frameRate: { ideal: preset.fps, max: preset.fps },
        width: { ideal: 1920 },
        height: { ideal: 1080 },
      },
      audio: S.shareAudio
        ? { echoCancellation: false, noiseSuppression: false, autoGainControl: false }
        : false,
    });

    S.screenStream = stream;
    S.sharing = true;

    const video = stream.getVideoTracks()[0];
    const audio = stream.getAudioTracks()[0] || null;
    // Подсказка кодеку, что важнее: резкость мелкого текста или плавность
    try { video.contentHint = preset.hint; } catch {}
    video.addEventListener('ended', stopShare);

    S.local.screen = video;
    S.local.screenAudio = audio;

    if (S.send.screen) await S.send.screen.replaceTrack(video);
    if (audio && S.send.screenAudio) await S.send.screenAudio.replaceTrack(audio);

    tileVideo('local-screen').srcObject = stream;
    preferScreenCodec();
    await applySendParams();
    S.mainLocked = false;
    refreshUi();
    sendState();

    const size = video.getSettings();
    toast(
      `Показываете экран: ${preset.label}` +
        (size.width ? `, ${size.width}×${size.height}` : '') +
        (size.frameRate ? `, ${Math.round(size.frameRate)} к/с` : '') +
        (audio ? ', со звуком' : '')
    );
  } catch (err) {
    // Отказ пользователя — нормально, а вот «не поддерживается» стоит
    // показать один раз и убрать кнопку, чтобы не обманывала
    if (err?.name === 'NotSupportedError' || err?.name === 'TypeError') {
      hideShareButton('Демонстрация экрана недоступна в мобильных браузерах');
    }
  }
}

/**
 * VP9 заметно лучше VP8 держит мелкий текст на том же битрейте, а AV1 ещё
 * экономнее, но тяжелее для процессора. Ставим их вперёд только для дорожки
 * экрана — камере это ни к чему.
 */
function preferScreenCodec() {
  const transceiver = S.pc?.getTransceivers?.()[2];
  if (!transceiver || typeof transceiver.setCodecPreferences !== 'function') return;

  try {
    const supported = RTCRtpSender.getCapabilities?.('video')?.codecs;
    if (!supported) return;

    const wanted = (SHARE_PRESETS[S.shareQuality] || SHARE_PRESETS.detail).codecs;
    const rank = (codec) => {
      const name = codec.mimeType.split('/')[1].toUpperCase();
      const i = wanted.indexOf(name);
      return i === -1 ? wanted.length : i;
    };
    const ordered = [...supported].sort((a, b) => rank(a) - rank(b));
    transceiver.setCodecPreferences(ordered);
  } catch {
    /* браузер не даёт выбирать кодек — работаем с тем, что есть */
  }
}

async function stopShare() {
  if (!S.sharing) return;
  S.sharing = false;

  if (S.send.screen) await S.send.screen.replaceTrack(null);
  if (S.send.screenAudio) await S.send.screenAudio.replaceTrack(null);

  S.screenStream?.getTracks().forEach((t) => t.stop());
  S.screenStream = null;
  S.local.screen = null;
  S.local.screenAudio = null;
  tileVideo('local-screen').srcObject = null;

  await applySendParams();
  S.mainLocked = false;
  refreshUi();
  sendState();
}

/* ═══════════════════════════════════════════════════════════════════
   ЖИВОСТЬ ВИДЕО
   ═══════════════════════════════════════════════════════════════════ */

/*
 * Раньше картинка собеседника показывалась только по служебному сообщению
 * о состоянии. Если оно терялось, живое видео пряталось под заглушкой и
 * выглядело как зависание. Теперь ориентируемся на настоящие кадры.
 */
const frames = { cam: { at: 0, mark: -1 }, screen: { at: 0, mark: -1 } };
let framesTimer = null;

/**
 * Счётчик декодированных кадров. Именно он показывает, идёт ли картинка:
 * currentTime у медиапотока тикает по часам элемента даже когда кадров нет.
 */
function frameCount(video) {
  try {
    if (typeof video.getVideoPlaybackQuality === 'function') {
      return video.getVideoPlaybackQuality().totalVideoFrames;
    }
  } catch {}
  if (typeof video.webkitDecodedFrameCount === 'number') return video.webkitDecodedFrameCount;
  return null;
}

function pollFrames() {
  let changed = false;
  for (const role of ['cam', 'screen']) {
    const v = tileVideo(role === 'cam' ? 'remote-cam' : 'remote-screen');
    const w = frames[role];
    const was = isLive(role);

    const n = frameCount(v);
    if (n === null) {
      // Браузер не умеет считать кадры — довольствуемся размером картинки
      if (v.srcObject && v.videoWidth > 0 && !v.paused) w.at = performance.now();
    } else if (w.mark < 0) {
      w.mark = n; // первая проба: запоминаем, но живым ещё не считаем
    } else if (n > w.mark) {
      w.mark = n;
      w.at = performance.now();
    }

    if (isLive(role) !== was) changed = true;
  }
  if (changed) refreshUi();
}

const isLive = (role) => frames[role].at > 0 && performance.now() - frames[role].at < 2500;

function startFrameWatch() {
  stopFrameWatch();
  framesTimer = setInterval(pollFrames, 500);
}
function stopFrameWatch() {
  clearInterval(framesTimer);
  framesTimer = null;
  frames.cam = { at: 0, mark: -1 };
  frames.screen = { at: 0, mark: -1 };
}

/** Пересобрать соединение, если картинка замерла или связь развалилась. */
/**
 * Мягкое лечение: просим браузер заново перебрать сетевые пути. Если это
 * не помогло дважды подряд, дальше повторять бессмысленно — собираем
 * соединение с нуля у обоих.
 */
function reconnect(reason) {
  if (!S.pc) return toast('Соединения нет — ждём собеседника');
  S.lastRecover = performance.now();

  if (++S.iceTries > 2) {
    S.iceTries = 0;
    hardRestart(true, reason || 'переподключение не помогло');
    return;
  }

  try {
    S.pc.restartIce();
    setStatus('connecting', 'Переподключение…');
    toast(reason || 'Переподключаю связь', 2000);
    S.connectDeadline = performance.now() + 9000;
    watchHandshake();
  } catch {
    toast('Не удалось переподключиться');
  }
}

/**
 * Лестница восстановления. Раньше на любую беду отвечали одним и тем же
 * ICE-рестартом, а когда он не помогал — ждали, пока браузер сам решит,
 * что всё плохо. Теперь шаги идут по возрастанию цены.
 *
 *   1. Перебрать пути заново — секунда, разговор даже не прерывается.
 *   2. Уйти на ретранслятор принудительно. Дороже по задержке, зато
 *      работает там, где прямой путь не строится в принципе: у одного
 *      VPN, у другого мобильный интернет с симметричным NAT.
 *   3. Собрать соединение с нуля у обоих. Несколько секунд тишины,
 *      но вытаскивает даже наглухо развалившийся транспорт.
 *
 * Между шагами держим паузу: сеть должна успеть показать результат
 * предыдущего, иначе лестница проскакивается за две секунды впустую.
 */
function recoverStep(reason) {
  if (!S.inCall || !S.pc || S.restarting) return;
  const now = performance.now();
  // Та же оговорка про ноль: обрыв на пятой секунде звонка обязан
  // лечиться, а не ждать, пока истекут двенадцать от начала времён.
  if (S.lastRecover && now - S.lastRecover < 12000) return;
  S.lastRecover = now;

  if (!S.relayTried && S.iceTries >= 1 && hasRelay() && !S.forceRelay && S.relayOk !== false) {
    S.relayTried = true;
    setRelayOnly(true, false);
    S.iceTries = 0;
    logEvent('warn', `${reason}: перевожу связь на ретранслятор`);
    toast('Прямой путь не держится — иду через ретранслятор', 3200);
    hardRestart(true, 'переход на ретранслятор');
    return;
  }

  reconnect(reason);
}

/* ═══════════════════════════════════════════════════════════════════
   РАСКЛАДКА
   ═══════════════════════════════════════════════════════════════════ */

const TILE_LIVE = {
  'local-cam': () => !!S.camStream,
  'local-screen': () => S.sharing,
  'remote-cam': () => S.peerPresent,
  'remote-screen': () => S.peerPresent && (S.remoteState.screen || isLive('screen')),
};

// Что показывать крупно, если пользователь ещё не выбрал сам
const AUTO_PRIORITY = ['remote-screen', 'remote-cam', 'local-screen', 'local-cam'];

function setMain(id, byUser = false) {
  if (!id || S.main === id) return;
  S.main = id;
  if (byUser) S.mainLocked = true;
  refreshUi();
}

for (const id of TILE_ORDER) {
  tileEl(id).addEventListener('click', function () {
    if (this.classList.contains('is-thumb')) setMain(id, true);
  });
}

function refreshUi() {
  const hasCamVideo = !!S.local.cam;
  const camLive = S.camOn && hasCamVideo;

  // Кнопки
  $('micBtn').setAttribute('aria-pressed', String(S.micOn));
  $('camBtn').setAttribute('aria-pressed', String(camLive));
  $('speakerBtn').setAttribute('aria-pressed', String(S.speakerOn));
  $('shareScreenBtn').setAttribute('aria-pressed', String(S.sharing));
  $('prevMicBtn').setAttribute('aria-pressed', String(S.micOn));
  $('prevCamBtn').setAttribute('aria-pressed', String(camLive));
  $('previewOffText').textContent = hasCamVideo ? 'Камера выключена' : 'Камера недоступна';
  $('preview').classList.toggle('is-live', camLive);

  // Какие плитки живы
  const visible = TILE_ORDER.filter((id) => TILE_LIVE[id]());

  if (!visible.includes(S.main)) { S.main = null; S.mainLocked = false; }
  if (!S.main || !S.mainLocked) {
    const auto = AUTO_PRIORITY.find((id) => visible.includes(id));
    if (auto) S.main = auto;
  }

  let thumbIndex = 0;
  for (const id of TILE_ORDER) {
    const el = tileEl(id);
    const live = visible.includes(id);
    el.hidden = !live;
    if (!live) continue;

    const isMain = id === S.main;
    el.classList.toggle('is-main', isMain);
    el.classList.toggle('is-thumb', !isMain);
    if (!isMain) el.style.setProperty('--i', thumbIndex++);

    // Экран показываем целиком, лицо — кадрируем
    el.style.setProperty('--fit', id.endsWith('screen') ? 'contain' : 'cover');

    // Затемнение, когда видео нет
    const dark =
      (id === 'local-cam' && !camLive) ||
      (id === 'remote-cam' && !(S.remoteKnown ? S.remoteState.cam : isLive('cam')));
    el.classList.toggle('is-dark', dark);
  }

  // Значки выключенного микрофона
  tileEl('local-cam').querySelector('.ic-badge--mic').hidden = S.micOn;
  tileEl('remote-cam').querySelector('.ic-badge--mic').hidden = S.remoteState.mic !== false;

  // Имена вместо безликих «Вы» и «Собеседник»
  const me = S.name || 'Вы';
  const peer = S.peerName || 'Собеседник';
  tileEl('local-cam').querySelector('.tile__label span').textContent = me;
  tileEl('remote-cam').querySelector('.tile__label span').textContent = peer;
  tileEl('local-screen').querySelector('.tile__label span').textContent = 'Ваш экран';
  tileEl('remote-screen').querySelector('.tile__label span').textContent =
    S.peerName ? `Экран: ${S.peerName}` : 'Экран собеседника';
  tileEl('local-cam').querySelector('.avatar').textContent = initials(me);
  $('remoteAvatar').textContent = initials(peer);

  $('tiles').classList.toggle('no-mirror', !S.mirror);
  $('stageEmpty').hidden = !!S.main;
}

/** Одна-две буквы для кружка вместо аватарки. */
function initials(name) {
  const parts = String(name).trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '·';
  const first = [...parts[0]][0] || '';
  const second = parts[1] ? [...parts[1]][0] : '';
  return (first + second).toUpperCase();
}

/* ═══════════════════════════════════════════════════════════════════
   СИГНАЛИНГ
   ═══════════════════════════════════════════════════════════════════ */

/*
 * Опознавательный знак вкладки. Живёт, пока живёт вкладка, и переживает
 * любое переподключение сигналинга. Нужен серверу, чтобы отличить
 * «вернулся тот же самый» от «пришёл второй участник».
 */
const CLIENT_ID = (() => {
  try {
    let id = sessionStorage.getItem('zv-client');
    if (!id) {
      id = crypto.randomUUID();
      sessionStorage.setItem('zv-client', id);
    }
    return id;
  } catch {
    return crypto.randomUUID();
  }
})();

/*
 * Сигнальный канал. Ровно один на вкладку — это здесь главное правило.
 *
 * Раньше каждое закрытие сокета заводило свой таймер переподключения, а
 * старый сокет никто не закрывал и не глушил. На рваной сети таймеров
 * набиралось несколько, и они открывали по сокету каждый. Для сервера это
 * разные участники: второе подключение того же браузера занимало место в
 * комнате, роль менялась с ведущей на ведомую, «собеседник» в журнале
 * оказывался собственной второй вкладкой — а настоящий человек упирался в
 * «комната занята». Соединение при этом честно пыталось построиться само с
 * собой и, разумеется, оставалось в состоянии new.
 *
 * Поэтому: перед открытием нового сокета старый закрывается явно, все
 * обработчики сверяются с текущим сокетом и молчат, если они от прошлого,
 * а таймер переподключения всегда один.
 */
function connectSignaling() {
  clearTimeout(S.wsTimer);
  S.wsTimer = null;

  const prev = S.ws;
  if (prev && prev.readyState <= WebSocket.OPEN) {
    S.ws = null;                       // чтобы его close не завёл ещё один таймер
    try { prev.close(1000, 'reconnect'); } catch {}
  }

  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(`${proto}//${location.host}/ws`);
  S.ws = ws;

  /** Этот сокет всё ещё актуален? */
  const mine = () => S.ws === ws;

  const retry = (why) => {
    if (!mine() || !S.inCall) return;
    S.ws = null;
    logEvent('warn', why);
    S.wsRetry++;
    setStatus('connecting', 'Переподключение…');
    // Разброс в задержке нужен, чтобы две стороны не ломились на сервер
    // в одну и ту же миллисекунду после общего обрыва.
    const wait = Math.min(800 * 2 ** S.wsRetry, 8000) + Math.random() * 400;
    clearTimeout(S.wsTimer);
    S.wsTimer = setTimeout(connectSignaling, wait);
  };

  ws.addEventListener('open', () => {
    if (!mine()) { try { ws.close(); } catch {} return; }
    S.wsRetry = 0;
    logEvent('good', 'Сигнальный канал открыт');
    setStatus('connecting', 'Вхожу в комнату…');
    ws.send(JSON.stringify({ type: 'join', roomId: S.roomId, clientId: CLIENT_ID }));
  });

  let recvChain = Promise.resolve();
  ws.addEventListener('message', (e) => {
    if (!mine()) return;
    let m;
    try { m = JSON.parse(e.data); } catch { return; }
    recvChain = recvChain.then(() => handleSignal(m)).catch((err) => console.warn('signal:', err));
  });

  ws.addEventListener('close', () => retry('Сигнальный канал закрылся, переподключаюсь'));
  ws.addEventListener('error', () => { if (mine()) try { ws.close(); } catch {} });
}

// Шифрование асинхронное, поэтому сообщения выстраиваем в очередь:
// перепутанный порядок SDP и кандидатов ломает соединение.
let sendChain = Promise.resolve();

function signal(data) {
  sendChain = sendChain
    .then(async () => {
      const payload = S.key ? await seal(S.key, data) : data;
      if (S.ws?.readyState === WebSocket.OPEN) {
        S.ws.send(JSON.stringify({ type: 'signal', data: payload }));
      }
    })
    .catch((err) => console.warn('signal:', err));
}

function sendState() {
  signal({
    state: {
      mic: S.micOn && !!S.local.mic,
      cam: (S.camOn && !!S.local.cam) || false,
      screen: S.sharing,
      speaking: !!S.speakingSelf && S.micOn,
      name: S.name || '',
      plat: PLATFORM.name,
      mobile: PLATFORM.mobile,
    },
  });
}

async function handleSignal(m) {
  switch (m.type) {
    case 'welcome':
      if (Array.isArray(m.iceServers) && m.iceServers.length) S.iceServers = m.iceServers;
      // Проверку ретранслятора запускаем сразу и в фоне: она занимает до
      // шести секунд, и ждать их в тот момент, когда связь уже не строится,
      // — непозволительная роскошь. К моменту решения ответ будет готов.
      if (hasRelay()) relayUsable();
      break;

    case 'joined':
      logEvent('good', `Вошли в комнату, собеседников: ${m.peers.length}, роль: ${m.polite ? 'ведомая' : 'ведущая'}`);
      S.peerId = m.peerId;
      S.polite = m.polite;
      if (m.peers.length) {
        S.peerPresent = true;
        // Живое соединение переживает переподключение сигналинга: служебный
        // канал моргнул, а разговор шёл и идёт. Тревожить собеседника в
        // этом случае нечем — пересобирать нужно только по-настоящему
        // свежему участнику.
        const hadLive = S.pc && S.pc.connectionState === 'connected';
        await startPeerConnection();
        /*
         * Мы входим в уже идущий разговор — значит, наше соединение
         * построено с нуля, а у собеседника осталось прежнее: с адресами
         * и ключами той вкладки, которой больше нет. Его ICE об этом не
         * знает и продолжает стучаться в пустоту, а переговоры поверх
         * мёртвого транспорта не помогают. Поэтому сразу говорим: собери
         * заново. Себя пересобирать не нужно — мы и так свежие.
         */
        if (!hadLive) signal({ ctl: 'restart', fresh: true });
        refreshUi();
      }
      else { setStatus('connecting', 'Ждём собеседника'); setInvite(true); }
      break;

    case 'peer-joined': {
      // Вернулся ли он после моргнувшего сигналинга — или пришёл заново
      const returning = !!S.leaveTimer;
      clearTimeout(S.leaveTimer);
      S.leaveTimer = null;

      // Сервер пересчитывает роли при каждом изменении состава комнаты.
      // Без этого после переподключения обе стороны могли оказаться
      // ведомыми — и вежливо ждать друг друга до конца времён.
      if (typeof m.polite === 'boolean' && m.polite !== S.polite) {
        S.polite = m.polite;
        logEvent('plain', `Роль сменилась на ${m.polite ? 'ведомую' : 'ведущую'}`);
      }

      if (returning && S.pc?.connectionState === 'connected') {
        logEvent('good', 'Собеседник вернулся, связь не рвалась');
        S.peerPresent = true;
        setInvite(false);
        sendState();
        refreshUi();
        break;
      }

      logEvent('good', 'Собеседник вошёл');
      S.peerPresent = true;
      setInvite(false);
      beep(660);
      addSystemMessage('Собеседник присоединился');

      await startPeerConnection();
      sendState();
      refreshUi();
      break;
    }

    case 'peer-left':
      // Сообщение об уходе приходит и тогда, когда у собеседника всего лишь
      // моргнул сигнальный канал. Сами разговор при этом идёт: медиапоток
      // живёт своей жизнью и сигналинга не спрашивает. Рвать целое
      // соединение из-за секундного разрыва служебного канала — значит
      // устраивать обрыв там, где его не было.
      if (S.pc?.connectionState === 'connected') {
        logEvent('warn', 'Собеседник отключился от сигналинга — связь жива, жду');
        clearTimeout(S.leaveTimer);
        S.leaveTimer = setTimeout(() => {
          S.leaveTimer = null;
          logEvent('warn', 'Собеседник не вернулся');
          beep(380);
          onPeerLeft();
        }, 8000);
        break;
      }
      logEvent('warn', 'Собеседник вышел');
      beep(380);
      onPeerLeft();
      break;

    case 'room-full':
      endCall('В этой комнате уже идёт разговор', 'Звонилка рассчитана на двоих.');
      break;

    case 'signal':
      await onRemoteSignal(m.data);
      break;
  }
}

function keyMismatch() {
  if (S.keyWarned) return;
  logEvent('error', 'Ключи комнаты не совпали');
  S.keyWarned = true;
  S.fatal = 'Ссылки не совпадают';
  setStatus('bad', S.fatal);
  toast('У вас и у собеседника разные ссылки на комнату. Откройте ту, что была отправлена целиком, вместе с частью после решётки.', 8000);
}

async function onRemoteSignal(payload) {
  if (!payload) return;

  let data = payload;
  if (payload.e) {
    if (!S.key) return keyMismatch();
    try {
      data = await unseal(S.key, payload);
    } catch {
      return keyMismatch();
    }
  } else if (S.key) {
    // Мы в защищённой комнате, а собеседник прислал открытый текст
    return keyMismatch();
  }

  // Собеседник ждёт предложения, а мы его не отправили. Так бывает после
  // пересборки, когда обе стороны оказались «ведомыми» и вежливо ждут
  // друг друга: соединение при этом навсегда остаётся в состоянии new.
  if (data.ctl === 'needOffer') {
    logEvent('warn', 'Собеседник ждёт предложения — отправляю');
    await sendOffer('по просьбе собеседника');
    return;
  }

  if (data.ctl === 'restart') {
    if (data.fresh) {
      logEvent('warn', 'Собеседник вошёл заново — пересобираю соединение');
      await hardRestart(false, 'собеседник вошёл заново');
    } else {
      logEvent('warn', 'Собеседник попросил пересобрать соединение');
      await hardRestart(false, 'по просьбе собеседника');
    }
    return;
  }

  if (data.state) {
    S.remoteState = { ...S.remoteState, ...data.state };
    S.remoteKnown = true;
    S.peerName = String(data.state.name || '').slice(0, 24);
    onSpeak('peer', !!data.state.speaking);

    // Узнали, с чего смотрит собеседник — подбираем кодек под пару.
    // Один раз за звонок: смена кодека стоит круга переговоров.
    if (data.state.plat && data.state.plat !== S.peerPlatform) {
      S.peerPlatform = String(data.state.plat).slice(0, 16);
      S.peerMobile = !!data.state.mobile;
      logEvent('plain', 'Собеседник на ' + S.peerPlatform);
      if (!S.codecTuned && !S.polite && S.pc) {
        S.codecTuned = true;
        const order = camCodecOrder(S.peerMobile);
        preferCamCodec();
        logEvent('plain', 'Кодек видео: ' + order[0]);
      }
    }

    refreshUi();
    return;
  }

  if (!S.pc) await startPeerConnection();
  const pc = S.pc;

  try {
    if (data.description) {
      const desc = data.description;
      const ready = !S.makingOffer && (pc.signalingState === 'stable' || S.settingRemoteAnswer);
      const collision = desc.type === 'offer' && !ready;

      S.ignoreOffer = !S.polite && collision;
      if (S.ignoreOffer) return;

      S.settingRemoteAnswer = desc.type === 'answer';
      await pc.setRemoteDescription(desc);
      S.settingRemoteAnswer = false;
      await bindRoles();

      if (desc.type === 'offer') {
        const answer = await pc.createAnswer();
        answer.sdp = tuneSdp(answer.sdp);
        await setLocalSafe(answer);
        signal({ description: pc.localDescription });
      }
    } else if (data.candidate) {
      try { await pc.addIceCandidate(data.candidate); }
      catch (err) { if (!S.ignoreOffer) console.warn('ICE:', err); }
    }
  } catch (err) {
    console.warn('signal:', err);
  }
}

/* ═══════════════════════════════════════════════════════════════════
   PEER CONNECTION
   ═══════════════════════════════════════════════════════════════════ */

/**
 * Правка SDP — то немногое, что решает судьбу звука на рваной сети.
 *
 * useinbandfec  — Opus подмешивает в каждый пакет упрощённую копию
 *                 предыдущего, и одиночная потеря просто не слышна.
 * usedtx=0      — передача не замолкает в паузах. DTX экономит трафик,
 *                 но съедает первый слог после тишины; на голосовом
 *                 звонке это заметнее, чем лишние килобиты.
 * maxaveragebitrate — потолок 64 кбит/с: полноценный звук, а не
 *                 телефонное качество. Реальный поток всё равно
 *                 подстраивается под сеть отдельным ограничением.
 * ptime=20      — кадры по 20 мс: меньше — лишние заголовки,
 *                 больше — заметная задержка.
 */
function tuneSdp(sdp) {
  try {
    let out = sdp;
    const pt = out.match(/a=rtpmap:(\d+)\s+opus\/48000/i)?.[1];
    if (pt) {
      const wanted = {
        useinbandfec: '1',
        usedtx: '0',
        stereo: '0',
        maxaveragebitrate: '64000',
        maxplaybackrate: '48000',
        minptime: '10',
      };
      const line = new RegExp(`a=fmtp:${pt} (.*)`);
      if (line.test(out)) {
        out = out.replace(line, (_, params) => {
          const set = new Map(
            params.split(';').filter(Boolean).map((piece) => {
              const [k, v] = piece.split('=');
              return [k.trim(), v];
            })
          );
          for (const [k, v] of Object.entries(wanted)) set.set(k, v);
          return `a=fmtp:${pt} ` + [...set].map(([k, v]) => (v === undefined ? k : `${k}=${v}`)).join(';');
        });
      } else {
        const map = new RegExp(`(a=rtpmap:${pt}\\s+opus/48000[^\\r\\n]*)`);
        out = out.replace(map, `$1\r\na=fmtp:${pt} ` +
          Object.entries(wanted).map(([k, v]) => `${k}=${v}`).join(';'));
      }
      if (!new RegExp(`a=ptime:`).test(out)) {
        out = out.replace(new RegExp(`(a=rtpmap:${pt}\\s+opus/48000[^\\r\\n]*)`), '$1\r\na=ptime:20');
      }
    }
    return out;
  } catch { return sdp; }
}

/**
 * Порядок кодеков звука. Если браузер умеет RED (audio/red), ставим его
 * первым: он шлёт каждый кадр дважды с разным запаздыванием, и голос
 * переживает даже пачку подряд потерянных пакетов. Стоит это пару
 * десятков килобит — на фоне видео цена незаметная.
 */
function preferAudioCodec() {
  const t = S.pc?.getTransceivers?.()[0];
  if (!t || typeof t.setCodecPreferences !== 'function') return;
  try {
    const supported = RTCRtpSender.getCapabilities?.('audio')?.codecs;
    if (!supported || !supported.length) return;
    const rank = (c) => {
      const name = c.mimeType.split('/')[1].toLowerCase();
      if (name === 'red') return 0;
      if (name === 'opus') return 1;
      return 2;
    };
    const ordered = [...supported].sort((a, b) => rank(a) - rank(b));
    if (rank(ordered[0]) === 0) t.setCodecPreferences(ordered);
  } catch {}
}

/**
 * Кодек камеры выбираем под пару платформ, а не под свою. iPhone и
 * Android декодируют H.264 железом: меньше нагрев, меньше пропущенных
 * кадров, дольше держит батарея. Между настольными машинами выгоднее
 * VP9 — та же картинка при меньшем потоке.
 */
function preferCamCodec() {
  const t = S.pc?.getTransceivers?.()[1];
  if (!t || typeof t.setCodecPreferences !== 'function') return;
  try {
    const supported = RTCRtpSender.getCapabilities?.('video')?.codecs;
    if (!supported || !supported.length) return;
    const wanted = camCodecOrder(S.peerMobile);
    const rank = (c) => {
      const i = wanted.indexOf(c.mimeType.split('/')[1].toUpperCase());
      return i === -1 ? wanted.length : i;
    };
    t.setCodecPreferences([...supported].sort((a, b) => rank(a) - rank(b)));
  } catch {}
}

async function setLocalSafe(desc) {
  try { await S.pc.setLocalDescription(desc); }
  catch { await S.pc.setLocalDescription(); }
}

/**
 * Сопоставляет дорожки соединения с ролями и подключает к ним локальные
 * треки. Вызывается после каждого применения удалённого описания —
 * повторные вызовы безвредны.
 */
async function bindRoles() {
  const pc = S.pc;
  if (!pc) return;
  const list = pc.getTransceivers();
  if (list.length < ROLES.length) return;

  for (let i = 0; i < ROLES.length; i++) {
    const role = ROLES[i];
    const t = list[i];
    S.send[role] = t.sender;

    // Отвечающая сторона получает дорожки в режиме «только приём» —
    // разрешаем и отправку, иначе её камеру никто не увидит.
    if (t.direction !== 'sendrecv' && !t.stopped) {
      try { t.direction = 'sendrecv'; } catch {}
    }
    const track = S.local[role] || null;
    if (t.sender.track !== track) {
      try { await t.sender.replaceTrack(track); } catch {}
    }
  }
  preferScreenCodec();
  preferAudioCodec();
}

/**
 * Список серверов ICE. Свой TURN, вбитый в настройках, добавляется к тем,
 * что прислал сервер: без ретранслятора некоторые пары — например, когда
 * у одного VPN, а у другого нет — не соединяются вообще никак.
 */
function iceConfig() {
  const list = [...(S.iceServers || [{ urls: ['stun:stun.l.google.com:19302'] }])];
  const url = prefs.get('turnUrl', '').trim();
  if (url) {
    list.push({
      urls: url.split(',').map((u) => u.trim()).filter(Boolean),
      username: prefs.get('turnUser', '') || undefined,
      credential: prefs.get('turnPass', '') || undefined,
    });
  }
  return list;
}

/**
 * Переключить режим ретранслятора. Автоматическое включение отражаем в
 * настройках, но не запоминаем: следующий звонок снова начнёт с попытки
 * прямого пути — он быстрее, и в другой сети может отлично работать.
 */
function setRelayOnly(on, remember) {
  S.forceRelay = on;
  const box = $('relayOnly');
  if (box) box.checked = on;
  if (remember) prefs.set('forceRelay', on);
}

/**
 * Ретранслятор, вписанный в список, и ретранслятор, который работает, —
 * это разные вещи. Публичные бесплатные TURN живут недолго, чужой сервер
 * может не пустить по учётным данным, а фаервол — не пустить до сервера.
 *
 * Проверяем честно: поднимаем пустое соединение в режиме «только
 * ретранслятор» и смотрим, появится ли хоть один адрес типа relay.
 * Появился — ретранслятором можно пользоваться. Не появился за шесть
 * секунд или сбор адресов закончился ни с чем — нельзя, и переключаться
 * на него нельзя тем более: это не запасной путь, а гарантированный тупик.
 *
 * Цена ошибки здесь высокая. Режим «только ретранслятор» отключает прямой
 * путь целиком; если ретранслятор при этом мёртв, кандидатов не остаётся
 * вообще никаких, ICE даже не начинает работу, и соединение навсегда
 * замирает в состоянии new — ровно то, что видно в отчёте как «new / new»
 * и пустой маршрут.
 */
function probeRelay() {
  const servers = iceConfig().filter((srv) =>
    [].concat(srv.urls || []).some((u) => /^turns?:/i.test(u))
  );
  if (!servers.length) return Promise.resolve(false);

  return new Promise((resolve) => {
    let pc;
    let timer;
    const done = (ok) => {
      clearTimeout(timer);
      try { pc?.close(); } catch {}
      resolve(ok);
    };
    try {
      pc = new RTCPeerConnection({ iceServers: servers, iceTransportPolicy: 'relay' });
    } catch {
      return resolve(false);
    }
    timer = setTimeout(() => done(false), 6000);
    pc.addEventListener('icecandidate', (e) => {
      if (!e.candidate) return done(false);          // сбор кончился, relay не нашёлся
      if (/ typ relay/.test(e.candidate.candidate || '')) done(true);
    });
    try {
      pc.createDataChannel('probe');
      pc.createOffer().then((o) => pc.setLocalDescription(o)).catch(() => done(false));
    } catch {
      done(false);
    }
  });
}

/** Тот же вопрос, но с ответом наготове: проверяем один раз за звонок. */
function relayUsable() {
  if (S.relayOk !== null) return Promise.resolve(S.relayOk);
  if (!S.relayProbe) {
    S.relayProbe = probeRelay().then((ok) => {
      S.relayOk = ok;
      logEvent(ok ? 'good' : 'error',
        ok ? 'Ретранслятор отвечает' : 'Ретранслятор не отвечает — отступать некуда');
      return ok;
    });
  }
  return S.relayProbe;
}

/** Есть ли куда отступать, если прямой путь не строится. */
function hasRelay() {
  return iceConfig().some((srv) =>
    [].concat(srv.urls || []).some((u) => /^turns?:/i.test(u))
  );
}

/**
 * Вернуться с ретранслятора на прямой путь.
 *
 * Переход на ретранслятор — шаг в один конец только на словах: если он не
 * помог, оставаться в нём хуже, чем не переходить вовсе. Прямой путь при
 * этом выключен, и звонок теряет последний шанс.
 */
function dropRelay(why) {
  if (!S.forceRelay) return;
  S.relayOk = false;
  setRelayOnly(false, false);
  logEvent('warn', `Ретранслятор не сработал (${why}) — возвращаюсь к прямому пути`);
  toast('Ретранслятор не отвечает — пробую напрямую', 3200);
  hardRestart(true, 'откат с ретранслятора');
  noWayOut();
}

/**
 * Прямой путь не строится, ретранслятора нет. Дальше пробовать нечего —
 * честнее сказать это и подсказать, что делать, чем крутить попытки по
 * кругу до конца времён.
 */
function noWayOut() {
  if (S.noWayShown) return;
  S.noWayShown = true;
  logEvent('error', 'Ни прямого пути, ни ретранслятора: нужен свой TURN-сервер');
  toast('Сети не дают соединиться напрямую, а рабочего ретранслятора нет. Впишите свой TURN-сервер в настройках — раздел «Связь».', 9000);
}

async function startPeerConnection() {
  if (S.pc) return S.pc;

  const pc = new RTCPeerConnection({
    iceServers: iceConfig(),
    bundlePolicy: 'max-bundle',
    rtcpMuxPolicy: 'require',
    // Кандидатов собираем заранее — первый оффер уходит уже с адресами,
    // и рукопожатие не ждёт лишний круг
    iceCandidatePoolSize: 6,
    // Аварийный режим: прямой путь не построился, идём только через
    // ретранслятор. Дороже по задержке, зато соединяется всегда
    iceTransportPolicy: S.forceRelay ? 'relay' : 'all',
  });
  S.pc = pc;
  S.connectDeadline = performance.now() + 9000;
  S.candsAll = 0;
  S.candsRelay = 0;
  S.iceTries = 0;
  S.badSince = 0;
  S.offerAsked = 0;
  watchHandshake();
  watchNegotiation();

  // Слушатель вешаем до создания дорожек: событие о необходимости
  // переговоров прилетает почти сразу и не должно уйти в пустоту.
  pc.addEventListener('negotiationneeded', async () => {
    try {
      S.makingOffer = true;
      const offer = await pc.createOffer();
      offer.sdp = tuneSdp(offer.sdp);
      await setLocalSafe(offer);
      signal({ description: pc.localDescription });
    } catch (err) {
      console.warn('negotiation:', err);
    } finally {
      S.makingOffer = false;
    }
  });

  // Канал для чата. Создаёт его тоже инициатор, до первого оффера, —
  // тогда он попадает в то же согласование и не требует отдельного круга
  // переговоров. Второй участник получает готовый канал событием.
  pc.addEventListener('datachannel', (e) => bindChat(e.channel));

  // Дорожки создаёт только инициатор — первый, кто оказался в комнате.
  // По спецификации транссиверы, созданные через addTransceiver, не
  // переиспользуются при входящем оффере: если бы их создавали обе стороны,
  // получилось бы восемь потоков вместо четырёх. Второй участник подхватит
  // уже готовые в bindRoles() после того, как применит оффер.
  if (!S.polite) {
    bindChat(pc.createDataChannel('chat', { ordered: true }));

    const transceivers = ROLES.map((role) =>
      pc.addTransceiver(role === 'cam' || role === 'screen' ? 'video' : 'audio', {
        direction: 'sendrecv',
      })
    );
    ROLES.forEach((role, i) => (S.send[role] = transceivers[i].sender));

    // Порядок кодеков задаём синхронно, до первого await: событие о
    // переговорах уже стоит в очереди, и любая пауза здесь означает, что
    // оффер уйдёт со старым порядком.
    preferScreenCodec();
    preferAudioCodec();
    preferCamCodec();

    await bindRoles();
  }

  pc.addEventListener('icecandidate', ({ candidate }) => {
    if (!candidate) return;
    S.candsAll++;
    if (/ typ relay/.test(candidate.candidate || '')) {
      if (!S.candsRelay) logEvent('good', 'Нашёлся адрес ретранслятора');
      S.candsRelay++;
    }
    signal({ candidate });
  });

  // Сбор адресов закончился. Если их не набралось ни одного, соединяться
  // не с чем — и это надо сказать вслух, а не молча висеть в new.
  pc.addEventListener('icegatheringstatechange', () => {
    if (pc.iceGatheringState !== 'complete' || pc !== S.pc) return;
    if (!S.candsAll) {
      logEvent('error', 'Ни одного сетевого адреса не собрано');
      if (S.forceRelay) dropRelay('ретранслятор не дал ни одного адреса');
      return;
    }
    if (S.forceRelay && !S.candsRelay) {
      dropRelay('в режиме ретранслятора адресов не нашлось');
    }
  });

  pc.addEventListener('track', (e) => {
    const index = pc.getTransceivers().indexOf(e.transceiver);
    const role = ROLES[index];
    if (!role) return;

    remoteTracks[role] = e.track;
    S.remote[role] = e.track;

    // Браузер помечает дорожку «mute», когда по ней перестали приходить
    // пакеты. Для человека это выглядит как замерший экран или пропавший
    // голос, и раньше мы узнавали об этом только через сторожа кадров —
    // то есть с задержкой в несколько секунд. Теперь узнаём сразу.
    e.track.addEventListener('mute', () => {
      if (!S.inCall) return;
      logEvent('warn', `Поток «${role}» замолчал`);
      if (role === 'mic') setStatus('bad', 'Звук пропал');
      clearTimeout(S.muteTimer);
      S.muteTimer = setTimeout(() => {
        if (remoteTracks[role]?.muted && S.pc?.connectionState === 'connected') {
          recoverStep(`поток «${role}» не вернулся`);
        }
      }, 5000);
    });
    e.track.addEventListener('unmute', () => {
      clearTimeout(S.muteTimer);
      logEvent('good', `Поток «${role}» вернулся`);
      syncStatus();
      refreshUi();
    });

    attachRemote();
    playRemoteAudio();
    applyLatency(true);
    refreshUi();
  });

  pc.addEventListener('icecandidateerror', (e) => {
    // 701 — обычное дело при переборе адресов, шумит зря
    if (e.errorCode && e.errorCode !== 701) {
      logEvent('warn', `ICE ${e.errorCode}: ${e.errorText || ''} (${e.url || ''})`);
    }
  });

  pc.addEventListener('iceconnectionstatechange', () => {
    logEvent(
      pc.iceConnectionState === 'failed' ? 'error' : 'plain',
      'ICE: ' + pc.iceConnectionState
    );
    if (pc.iceConnectionState === 'failed') {
      setStatus('bad', 'Восстановление связи…');
      try { pc.restartIce(); } catch {}
    } else if (pc.iceConnectionState === 'connected') {
      syncStatus();
    }
  });

  pc.addEventListener('connectionstatechange', () => {
    const state = pc.connectionState;
    logEvent(state === 'failed' ? 'error' : state === 'connected' ? 'good' : 'plain', 'Соединение: ' + state);

    // Отвалившееся насмерть соединение чинится только полной пересборкой:
    // restartIce уже не помогает, если транспорт закрыт
    if (state === 'failed') scheduleRebuild('Связь оборвалась');

    // «disconnected» — это ещё не обрыв, но уже тишина в канале. Браузер
    // сам объявит failed через полминуты и больше; ждать так долго нельзя,
    // человек за это время успевает решить, что связь умерла. Даём сети
    // четыре секунды на самоизлечение и беремся за неё сами.
    if (state === 'disconnected') {
      S.disconnectedAt = performance.now();
      clearTimeout(S.limpTimer);
      S.limpTimer = setTimeout(() => {
        if (S.pc && S.pc.connectionState === 'disconnected') {
          recoverStep('связь замолчала');
        }
      }, 4000);
    } else {
      clearTimeout(S.limpTimer);
    }

    switch (state) {
      case 'connected':
        clearTimeout(S.handshakeTimer);
        clearTimeout(S.negWatch);
        clearTimeout(S.relayWatch);
        clearTimeout(S.netWatch);
        S.iceTries = 0;
        S.disconnectedAt = 0;
        syncStatus();
        setInvite(false);
        applySendParams();
        applyLatency(true);
        applyAudioProcessing();
        playRemoteAudio();
        sendState();
        break;
      default: syncStatus();
    }
  });

  startStats();
  return pc;
}

/** Ограничение исходящего потока — главный рычаг оптимизации. */
async function applySendParams() {
  const tune = async (sender, opts) => {
    if (!sender || !sender.track) return;
    try {
      const p = sender.getParameters();
      if (!p.encodings || !p.encodings.length) p.encodings = [{}];
      Object.assign(p.encodings[0], opts.encoding);
      if (opts.degradation) p.degradationPreference = opts.degradation;
      await sender.setParameters(p);
    } catch {}
  };

  // Голос важнее картинки: высокий приоритет в сети и запас по битрейту,
  // которого хватает и мобильному интернету. На плохой сети опускаемся —
  // Opus с коррекцией ошибок разборчив и на двадцати килобитах.
  // Верхняя планка поднята: 64 кбит/с Opus — это уже не «телефонный»
  // голос, а полноценный звук с воздухом. Стоит он копейки на фоне видео,
  // а разборчивость и усталость от разговора меняет заметно.
  const voiceBits =
    S.lossEma > 6 ? 24_000
    : S.lossEma > 2 ? 32_000
    : (S.rttVar || 0) > 60 ? 40_000
    : 64_000;
  await tune(S.send.mic, {
    encoding: { priority: 'high', networkPriority: 'high', maxBitrate: voiceBits },
  });

  const step = LADDER[S.quality];
  // На телефоне поток сверх трёх мегабит не улучшает картинку, зато греет
  // кодировщик и первым же делом ломает стабильность. iPhone упирается
  // ещё раньше: его кодер начинает пропускать кадры и греться примерно
  // с двух с половиной мегабит.
  const platformCap = PLATFORM.ios ? 2_500_000 : PLATFORM.mobile ? 3_000_000 : Infinity;

  // Измеренный канал делим между двумя картинками. Когда идёт
  // демонстрация, смотрят прежде всего на неё — ей и большая доля;
  // лицо в углу переживёт и четверть.
  const budget = videoBudget();
  const bothVideo = S.sharing && S.camOn && S.send.cam?.track;
  const camBudget = budget == null ? Infinity : bothVideo ? budget * 0.3 : budget;
  const screenBudget = budget == null ? Infinity : bothVideo ? budget * 0.7 : budget;

  const camCap = Math.round(Math.min(step.bitrate, platformCap, camBudget));
  // Ниже трёх ступеней уменьшаем не только поток, но и само разрешение:
  // кодировать 720p в четверть мегабита — значит получить кашу вместо лица
  const scale = S.quality >= 4 ? 3 : S.quality === 3 ? 2 : 1;
  await tune(S.send.cam, {
    encoding: {
      active: !S.voiceOnly,
      maxBitrate: S.voiceOnly ? 60_000 : camCap,
      maxFramerate: S.voiceOnly ? 5 : step.fps,
      scaleResolutionDownBy: S.voiceOnly ? 4 : scale,
      networkPriority: S.sharing ? 'low' : 'medium',
    },
    // Лицо лучше терять в чёткости, чем в плавности: рваное видео
    // собеседника раздражает сильнее, чем мягкая картинка. На телефоне
    // выбираем «баланс»: аппаратный кодер там роняет разрешение дешевле,
    // чем частоту, и жёсткое требование к плавности только заставляет
    // его греться и терять кадры пачками.
    degradation: PLATFORM.mobile ? 'balanced' : 'maintain-framerate',
  });

  const preset = SHARE_PRESETS[S.shareQuality] || SHARE_PRESETS.detail;
  await tune(S.send.screen, {
    encoding: {
      maxBitrate: Math.round(Math.min(preset.bitrate, screenBudget)),
      maxFramerate: preset.fps,
      scaleResolutionDownBy: 1,
      networkPriority: 'high',
    },
    degradation: preset.degradation,
  });
}

/**
 * Буфер приёма — самая управляемая часть задержки. По умолчанию браузер
 * держит его побольше ради плавности; в режиме низкой задержки убираем.
 */
/**
 * Сколько миллисекунд держать в буфере приёма. Раньше это был выключатель
 * «ноль или как решит браузер», и на дрожащей сети звук рвался на каждом
 * скачке. Теперь буфер считается из измеренного дрожания: пакеты приходят
 * ровно — буфер почти нулевой и разговор живой; сеть заходила — буфер
 * подрастает и сглаживает рывки, вместо того чтобы щёлкать.
 */
function targetBuffer() {
  if (!S.lowLatency) return null;              // пусть решает браузер
  const jitter = S.jitterMs || 0;
  const loss = S.lossEma || 0;
  // Трёх дрожаний хватает, чтобы перекрыть почти любой всплеск.
  // Прыгающий пинг — та же неровность, только видна не в джиттере
  // пакетов, а в задержке пути: её тоже надо перекрывать буфером,
  // иначе звук щёлкает ровно в моменты скачков.
  let ms = jitter * 3 + Math.min(120, (S.rttVar || 0) * 1.5)
         + (loss > 3 ? 60 : loss > 1 ? 25 : 0);
  return Math.max(0, Math.min(320, Math.round(ms)));
}

function applyLatency(force) {
  if (!S.pc) return;
  const ms = targetBuffer();
  // Пересчитывается каждую секунду, но трогать приёмники есть смысл
  // только когда цифра действительно поменялась
  if (!force && ms === S.bufferMs) return;
  S.bufferMs = ms;
  for (const r of S.pc.getReceivers()) {
    try { if ('jitterBufferTarget' in r) r.jitterBufferTarget = ms; } catch {}
    // playoutDelayHint измеряется в секундах
    try { if ('playoutDelayHint' in r) r.playoutDelayHint = ms == null ? undefined : ms / 1000; } catch {}
  }
}

/**
 * Сторож рукопожатия. Прямой путь между двумя NAT строится за секунды;
 * если за девять его нет, дальше ждать бессмысленно — либо один из
 * участников за «строгим» NAT, либо VPN не пропускает UDP. Тогда
 * пересобираем соединение через ретранслятор, если он настроен.
 */
/** Отправить предложение вручную, минуя negotiationneeded. */
async function sendOffer(why) {
  const pc = S.pc;
  if (!pc || pc.signalingState !== 'stable') return false;
  try {
    S.makingOffer = true;
    const offer = await pc.createOffer();
    offer.sdp = tuneSdp(offer.sdp);
    await setLocalSafe(offer);
    signal({ description: pc.localDescription });
    logEvent('plain', 'Отправлено предложение (' + (why || 'вручную') + ')');
    return true;
  } catch (err) {
    logEvent('error', 'Не вышло отправить предложение: ' + (err?.message || err));
    return false;
  } finally {
    S.makingOffer = false;
  }
}

/*
 * Сторож немого согласования.
 *
 * Соединение, застрявшее в состоянии new при живом собеседнике, — это не
 * плохая сеть, а несостоявшийся обмен предложениями: никто не начал.
 * Так получается, если обе стороны считают себя ведомыми — например,
 * после пересборки, пришедшей вслед за переподключением сигналинга.
 * Ждать тут нечего: ICE даже не начинал работать, и таймауты рукопожатия
 * не сработают никогда.
 *
 * Ведущая сторона просто отправляет предложение сама. Ведомая просит об
 * этом собеседника — и если через пять секунд ответа нет, предлагает
 * сама: лучше коллизия предложений, которую разрулит perfect negotiation,
 * чем вечная тишина.
 */
function watchNegotiation() {
  clearTimeout(S.negWatch);
  S.negWatch = setTimeout(async () => {
    const pc = S.pc;
    if (!pc || !S.inCall || !S.peerPresent) return;
    if (pc.connectionState !== 'new' || pc.signalingState !== 'stable') return;

    const now = performance.now();
    if (!S.polite) {
      await sendOffer('никто не начал согласование');
    } else if (!S.offerAsked || now - S.offerAsked > 5000) {
      S.offerAsked = now;
      logEvent('warn', 'Согласование не началось — прошу собеседника предложить');
      signal({ ctl: 'needOffer' });
      // Второй заход: если и он промолчал, начинаем сами
      setTimeout(() => {
        if (S.pc === pc && pc.connectionState === 'new' && pc.signalingState === 'stable') {
          sendOffer('собеседник не ответил');
        }
      }, 5000);
    }
    watchNegotiation();
  }, 4000);
}

function watchHandshake() {
  clearTimeout(S.handshakeTimer);
  S.handshakeTimer = setTimeout(async () => {
    const pc = S.pc;
    if (!pc || pc.connectionState === 'connected' || pc.connectionState === 'closed') return;

    if (!S.forceRelay && hasRelay() && S.relayOk !== false) {
      // Сначала убеждаемся, что ретранслятор живой. Уйти на мёртвый —
      // значит отключить прямой путь и не получить взамен ничего.
      const ok = await relayUsable();
      if (!S.pc || S.pc !== pc) return;
      if (!ok) {
        noWayOut();
        logEvent('warn', 'Рукопожатие затянулось — пробую заново');
        try { pc.restartIce(); } catch {}
        S.connectDeadline = performance.now() + 9000;
        watchHandshake();
        return;
      }
      setRelayOnly(true, false);
      S.relaySince = performance.now();
      logEvent('warn', 'Прямой путь не построился — иду через ретранслятор');
      toast('Прямое соединение не вышло — пробую через ретранслятор', 3200);
      await hardRestart(true, 'переход на ретранслятор');
      // Не помог за двенадцать секунд — возвращаемся, пока не поздно
      clearTimeout(S.relayWatch);
      S.relayWatch = setTimeout(() => {
        if (S.forceRelay && S.pc && S.pc.connectionState !== 'connected') {
          dropRelay('связь через него так и не поднялась');
        }
      }, 12000);
      return;
    }

    logEvent('warn', 'Рукопожатие затянулось — пробую заново');
    try { pc.restartIce(); } catch {}
    S.connectDeadline = performance.now() + 9000;
    watchHandshake();
  }, 9000);
}

/**
 * Смена сети — самая частая причина обрыва: телефон уходит с Wi-Fi на
 * мобильный интернет, кто-то включает или выключает VPN. Браузер сам
 * заметит это через десятки секунд; мы пересобираем маршрут сразу.
 */
function watchNetwork() {
  const kick = (why) => {
    if (!S.inCall || !S.pc) return;
    logEvent('warn', why);
    reconnect(why);
    // Если через шесть секунд путь так и не собрался — пересобираем целиком
    clearTimeout(S.netWatch);
    S.netWatch = setTimeout(() => {
      if (S.pc && S.pc.connectionState !== 'connected') hardRestart(true, 'смена сети');
    }, 6000);
  };

  addEventListener('online', () => kick('Сеть вернулась'));
  addEventListener('offline', () => {
    if (S.inCall) { logEvent('error', 'Сеть пропала'); setStatus('bad', 'Нет сети'); }
  });

  const conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
  if (conn && typeof conn.addEventListener === 'function') {
    let last = conn.type || conn.effectiveType || '';
    conn.addEventListener('change', () => {
      const now = conn.type || conn.effectiveType || '';
      if (now && now !== last) {
        last = now;
        kick('Сеть сменилась на ' + now);
      }
    });
  }
}

/*
 * Пересборка соединения с нуля. Нужна там, где restartIce уже бессилен:
 * когда транспорт закрылся, когда телефон уходил в сон, когда сеть
 * сменилась целиком. Обе стороны делают это одновременно, иначе одна
 * будет ждать оффер, которого никто не пришлёт.
 */
async function hardRestart(notify, reason) {
  if (S.restarting) return;

  /*
   * Защита от взаимной пересборки.
   *
   * Пересборка у себя всегда просит пересобраться и собеседника. Если у
   * него в этот момент срабатывает собственный сторож, он присылает
   * встречную просьбу — и обе стороны бесконечно сбрасывают друг другу
   * едва начатое согласование. В журнале это выглядит как чередование
   * «отправлено предложение» и «собеседник попросил пересобрать»: каждое
   * предложение умирает раньше, чем на него успевают ответить.
   *
   * Поэтому просьбы, пришедшие сразу после своей же пересборки, мы
   * пропускаем, а собственные автоматические — придерживаем. Ручная
   * кнопка проходит всегда: её нажал человек, и он вправе настоять.
   */
  const now = performance.now();
  const manual = reason === 'кнопка' || reason === 'собеседник вошёл заново';

  /*
   * Пауза защищает идущее согласование — значит, защищать надо только то,
   * что ещё живо. Когда соединения нет вовсе или оно уже объявлено
   * мёртвым, пересборка — единственный путь назад, и придерживать её
   * нельзя. Именно так однажды и вышло: откат с неработающего
   * ретранслятора попал в паузу, следом в неё же попала пересборка по
   * оборванной связи, и звонок остался лежать без единой попытки встать.
   */
  const dead = !S.pc || S.pc.connectionState === 'failed' || S.pc.connectionState === 'closed';
  const quiet = manual || dead ? 0 : notify ? 6000 : 9000;
  if (quiet && S.lastRestart && now - S.lastRestart < quiet) {
    logEvent('plain', `Пересборка (${reason || 'по команде'}) пропущена — только что пересобирались`);
    return;
  }
  S.lastRestart = now;

  S.restarting = true;
  S.restarts++;
  logEvent('warn', `Пересобираю соединение (${reason || 'по команде'})`);

  if (notify) signal({ ctl: 'restart' });

  try { S.pc?.close(); } catch {}
  S.pc = null;
  S.chat = null;
  S.send = { mic: null, cam: null, screen: null, screenAudio: null };
  for (const k of Object.keys(remoteTracks)) remoteTracks[k] = null;
  S.makingOffer = false;
  S.ignoreOffer = false;
  S.settingRemoteAnswer = false;
  S.prev = null;
  S.lastRoute = '';
  S.rttEma = null;
  S.rttVar = 0;
  S.shakySince = 0;
  S.lossEma = 0;
  S.jitterMs = 0;
  S.rttWin = [];
  stopKeepalive();
  clearTimeout(S.limpTimer);
  clearTimeout(S.muteTimer);
  S.rottenSince = 0;
  S.codecTuned = false;
  S.bufferMs = undefined;
  clearTimeout(S.handshakeTimer);
  clearTimeout(S.negWatch);
  clearTimeout(S.netWatch);
  updateChatAvailability();
  setStatus('connecting', 'Пересобираю соединение…');

  // Небольшая пауза, чтобы обе стороны успели закрыть старое
  await new Promise((r) => setTimeout(r, 400));
  if (S.peerPresent && S.inCall) await startPeerConnection();
  S.restarting = false;
  watchStall();
}

let rebuildTimer = null;
function scheduleRebuild(reason) {
  if (rebuildTimer || !S.inCall) return;
  rebuildTimer = setTimeout(() => {
    rebuildTimer = null;
    if (S.inCall && S.peerPresent && S.pc?.connectionState !== 'connected') {
      hardRestart(true, reason);
    }
  }, 2500);
}

function onPeerLeft() {
  clearTimeout(S.leaveTimer);
  S.leaveTimer = null;
  S.peerPresent = false;
  S.remoteState = { mic: true, cam: false, screen: false };
  S.remoteKnown = false;
  for (const id of ['remote-cam', 'remote-screen']) tileVideo(id).srcObject = null;
  for (const k of Object.keys(remoteTracks)) remoteTracks[k] = null;
  onSpeak('peer', false);
  frames.cam = { at: 0, mark: -1 };
  frames.screen = { at: 0, mark: -1 };
  $('soundGate').hidden = true;

  $('stageEmptyText').textContent = S.peerName ? `${S.peerName} вышел` : 'Собеседник вышел';
  addSystemMessage(S.peerName ? `${S.peerName} вышел из звонка` : 'Собеседник вышел из звонка');
  S.peerName = '';
  setInvite(true);
  setStatus('connecting', 'Ждём собеседника');

  S.pc?.close();
  S.pc = null;
  S.chat = null;
  updateChatAvailability();
  S.send = { mic: null, cam: null, screen: null, screenAudio: null };
  S.prev = null;
  stopStats();
  refreshUi();
}

/* ═══════════════════════════════════════════════════════════════════
   СТАТИСТИКА, ПИНГ, ШИФРОВАНИЕ
   ═══════════════════════════════════════════════════════════════════ */

function setStatus(kind, text) {
  $('statusDot').className = 'dot is-' + kind;
  $('statusText').textContent = text;
}

/**
 * Статус вычисляется из состояния соединения, а не выставляется вручную:
 * иначе после переподключения надпись «Переподключение…» висела вечно,
 * потому что connectionState не менялся и событие не приходило.
 */
function syncStatus() {
  // Несовпадение ключей чинится только новой ссылкой — не затираем сообщение
  if (S.fatal) return setStatus('bad', S.fatal);

  const pc = S.pc;
  if (!pc) return;
  if (!S.peerPresent) return setStatus('connecting', 'Ждём собеседника');

  switch (pc.connectionState) {
    case 'connected': setStatus('live', 'На связи'); break;
    case 'new':
    case 'connecting': setStatus('connecting', 'Устанавливаю соединение…'); break;
    case 'disconnected': setStatus('bad', 'Связь нестабильна'); break;
    case 'failed': setStatus('bad', 'Связь потеряна'); break;
  }
}

function startStats(slow) {
  clearInterval(S.statsTimer);
  S.statsSlow = !!slow;
  S.statsTimer = setInterval(collectStats, slow ? 4000 : 1000);
}

/**
 * В свёрнутой вкладке разбор статистики раз в секунду — чистая трата
 * батареи: на телефоне это заметный нагрев за полчаса разговора. Сам
 * разговор при этом не страдает, адаптацией качества занимается тот, кто
 * отдаёт поток, а мы в фоне только принимаем.
 */
function pacePolling() {
  if (!S.statsTimer) return;
  const slow = document.hidden;
  if (slow !== S.statsSlow) startStats(slow);
}

function stopStats() {
  clearInterval(S.statsTimer);
  S.statsTimer = null;
  S.statsSlow = false;
  $('pingText').textContent = '— мс';
  $('pingText').className = '';
}

async function collectStats() {
  const pc = S.pc;
  if (!pc || pc.connectionState === 'closed') return;

  let report;
  try { report = await pc.getStats(); } catch { return; }

  const now = performance.now();
  const acc = {
    rtt: null, jitter: null, buffer: null,
    inBytes: 0, outBytes: 0,
    audioIn: 0, audioOut: 0, videoIn: 0, videoInFrames: 0,
    bwe: null,
    width: 0, height: 0, fps: 0,
    codec: null, route: null, srtp: null, dtls: null,
    localAddr: null, proto: null, relayProto: null, localType: null, remoteType: null,
    localFp: null, remoteFp: null,
    packetsLost: 0, packetsRecv: 0,
    bufferDelay: 0, bufferCount: 0,
  };

  const byId = new Map();
  report.forEach((r) => byId.set(r.id, r));

  /*
   * Успешных пар адресов бывает несколько — ICE держит запасные наготове.
   * Работает при этом ровно одна, и именно её надо показывать. Раньше
   * бралась последняя попавшаяся, и журнал каждую секунду сообщал о
   * «смене сетевого пути» между двумя парами, которые никуда не менялись.
   * Браузер сам говорит, какая пара выбрана: у транспорта есть ссылка на
   * неё, а в Firefox у самой пары стоит признак selected.
   */
  let chosenPair = null;
  report.forEach((r) => {
    if (r.type === 'transport' && r.selectedCandidatePairId) chosenPair = r.selectedCandidatePairId;
    if (r.type === 'candidate-pair' && r.selected) chosenPair = chosenPair || r.id;
  });

  report.forEach((r) => {
    if (r.type === 'candidate-pair' &&
        (chosenPair ? r.id === chosenPair : (r.nominated || r.state === 'succeeded'))) {
      if (r.currentRoundTripTime != null) acc.rtt = r.currentRoundTripTime * 1000;
      // Оценка пропускной способности. Есть в Chrome и всех, кто на нём
      // построен; в Safari и Firefox поля просто нет.
      if (r.availableOutgoingBitrate != null) acc.bwe = r.availableOutgoingBitrate;
      const local = byId.get(r.localCandidateId);
      const remote = byId.get(r.remoteCandidateId);
      if (local && remote) {
        acc.localType = local.candidateType;
        acc.remoteType = remote.candidateType;
        acc.localAddr = local.address || local.ip || null;
        acc.proto = local.protocol || null;
        acc.relayProto = local.relayProtocol || null;
        const routeText = `${local.candidateType}/${remote.candidateType} ${local.protocol || ''} ${acc.localAddr || ''}`.trim();
        if (routeText !== S.lastRoute) {
          if (S.lastRoute) logEvent('warn', 'Сетевой путь сменился: ' + routeText);
          else logEvent('good', 'Сетевой путь: ' + routeText);
          S.lastRoute = routeText;
        }
        acc.route =
          local.candidateType === 'relay' || remote.candidateType === 'relay'
            ? 'через TURN-сервер'
            : local.candidateType === 'host' && remote.candidateType === 'host'
            ? 'прямое, локальная сеть'
            : 'прямое P2P';
      }
    }

    if (r.type === 'remote-inbound-rtp' && acc.rtt == null && r.roundTripTime != null) {
      acc.rtt = r.roundTripTime * 1000;
    }

    // Safari на iPhone часто не заполняет ни то, ни другое — тогда берём
    // собственный замер по каналу данных. Он чуть выше настоящего сетевого
    // (считается вместе с обработкой на той стороне), но показывает ровно
    // ту же динамику: скачки видны, и адаптация работает.
    if (acc.rtt == null && S.dcRtt != null) acc.rtt = S.dcRtt;

    if (r.type === 'inbound-rtp' && !r.isRemote) {
      acc.packetsLost += r.packetsLost || 0;
      acc.packetsRecv += r.packetsReceived || 0;
      acc.inBytes += r.bytesReceived || 0;
      if (r.kind === 'audio') acc.audioIn += r.bytesReceived || 0;
      if (r.jitter != null) acc.jitter = Math.max(acc.jitter ?? 0, r.jitter * 1000);

      if (r.kind === 'audio' && r.jitterBufferDelay != null && r.jitterBufferEmittedCount) {
        acc.bufferDelay += r.jitterBufferDelay;
        acc.bufferCount += r.jitterBufferEmittedCount;
      }
      if (r.kind === 'video') {
        acc.videoIn += r.bytesReceived || 0;
        acc.videoInFrames += r.framesDecoded || 0;
      }
      if (r.kind === 'video' && r.frameWidth) {
        acc.width = r.frameWidth;
        acc.height = r.frameHeight;
        acc.fps = r.framesPerSecond || acc.fps;
        const c = byId.get(r.codecId);
        if (c?.mimeType) acc.codec = c.mimeType.split('/')[1].toUpperCase();
      }
    }

    if (r.type === 'outbound-rtp' && !r.isRemote) {
      acc.outBytes += r.bytesSent || 0;
      if (r.kind === 'audio') acc.audioOut += r.bytesSent || 0;
    }

    if (r.type === 'transport') {
      acc.dtls = r.dtlsCipher || acc.dtls;
      acc.srtp = r.srtpCipher || acc.srtp;
      const lc = byId.get(r.localCertificateId);
      const rc = byId.get(r.remoteCertificateId);
      if (lc?.fingerprint) acc.localFp = lc.fingerprint;
      if (rc?.fingerprint) acc.remoteFp = rc.fingerprint;
    }
  });

  if (acc.bufferCount) acc.buffer = (acc.bufferDelay / acc.bufferCount) * 1000;

  let inBps = 0, outBps = 0, lossPct = 0, audioInBps = 0, audioOutBps = 0;
  let videoInBps = 0, dFrames = 0;
  if (S.prev) {
    const dt = (now - S.prev.t) / 1000;
    if (dt > 0.2) {
      inBps = Math.max(0, ((acc.inBytes - S.prev.in) * 8) / dt);
      outBps = Math.max(0, ((acc.outBytes - S.prev.out) * 8) / dt);
      audioInBps = Math.max(0, ((acc.audioIn - S.prev.aIn) * 8) / dt);
      audioOutBps = Math.max(0, ((acc.audioOut - S.prev.aOut) * 8) / dt);
      videoInBps = Math.max(0, ((acc.videoIn - S.prev.vIn) * 8) / dt);
      dFrames = acc.videoInFrames - S.prev.frames;
      const dLost = acc.packetsLost - S.prev.lost;
      const dRecv = acc.packetsRecv - S.prev.recv;
      if (dLost + dRecv > 0) lossPct = (dLost / (dLost + dRecv)) * 100;
    }
  }
  S.prev = {
    t: now, in: acc.inBytes, out: acc.outBytes,
    aIn: acc.audioIn, aOut: acc.audioOut,
    vIn: acc.videoIn, frames: acc.videoInFrames,
    lost: acc.packetsLost, recv: acc.packetsRecv,
  };
  S.outBps = outBps;
  S.videoInBps = videoInBps;

  // Оценку канала сглаживаем — она заметно дёргается от секунды к секунде,
  // а решения по ней принимаются каждую секунду.
  if (acc.bwe != null) {
    const before = S.bwe;
    S.bwe = before == null ? acc.bwe : before * 0.7 + acc.bwe * 0.3;
    S.bweAt = now;
    S.bweSeen = Math.max(S.bweSeen, S.bwe);
    // Обвал канала вдвое — это почти всегда переключение сети или
    // проснувшийся VPN. В журнале это видно куда лучше, чем в цифрах.
    if (before != null && S.bwe < before * 0.5 && before > 600_000) {
      logEvent('warn', `Канал просел: ${Math.round(before / 1000)} → ${Math.round(S.bwe / 1000)} кбит/с`);
    }
  }

  if (acc.jitter != null) S.jitterMs = S.jitterMs * 0.7 + acc.jitter * 0.3;

  renderPing(acc.rtt);
  adaptQuality(acc.rtt, lossPct);
  watchFrames(dFrames, videoInBps);
  await renderSecurity(acc);
  renderStatsPanel(acc, inBps, outBps, lossPct);
  renderProbe(audioInBps, audioOutBps);
  syncStatus();
  watchdog(lossPct);

  // Состояние собеседника пересылаем регулярно: одно потерянное сообщение
  // раньше означало чёрный квадрат вместо живого видео.
  if (++S.tick % 3 === 0) sendState();
}

/**
 * Что реально происходит со звуком — понятным языком.
 *
 * Считать мгновенный битрейт нельзя: Opus с включённым DTX в тишине почти
 * ничего не передаёт, и честно молчащий микрофон выглядел бы как поломка.
 * Поэтому смотрим на затухающий пик за последние секунды.
 */
function renderProbe(inBps, outBps) {
  S.outPeak = Math.max(outBps, S.outPeak * 0.9);
  S.inPeak = Math.max(inBps, S.inPeak * 0.9);
  if ($('settingsPanel').hidden) return;

  const speaking = S.micPeak > 0.08;
  const outOk = S.outPeak > 2500;
  const inOk = S.inPeak > 2500;

  const out = $('probeOut');
  if (!S.micOn) {
    out.textContent = 'микрофон выключен';
    out.className = 'is-bad';
  } else if (outOk) {
    out.textContent = Math.round(Math.max(outBps, S.outPeak) / 1000) + ' кбит/с';
    out.className = 'is-good';
  } else if (!speaking) {
    out.textContent = 'тишина';
    out.className = '';
  } else {
    out.textContent = 'нет сигнала';
    out.className = 'is-bad';
  }

  const inc = $('probeIn');
  if (!S.peerPresent) {
    inc.textContent = 'нет собеседника';
    inc.className = '';
  } else if (inOk) {
    inc.textContent = Math.round(Math.max(inBps, S.inPeak) / 1000) + ' кбит/с';
    inc.className = 'is-good';
  } else {
    inc.textContent = 'тишина';
    inc.className = '';
  }

  const hint = $('probeHint');
  let text = 'Скажите что-нибудь: полоска должна двигаться.';
  let bad = false;

  if (!S.micOn) {
    text = 'Микрофон выключен — включите его кнопкой в панели.';
    bad = true;
  } else if (speaking && !outOk) {
    text = 'Вы говорите, но голос не уходит. Проверьте, тот ли микрофон выбран выше и не заглушён ли он в системе.';
    bad = true;
  } else if (S.soundBlocked) {
    text = 'Звук собеседника заблокирован браузером — нажмите кнопку вверху экрана.';
    bad = true;
  } else if (outOk && inOk) {
    text = 'Звук идёт в обе стороны.';
  } else if (outOk) {
    text = 'Ваш голос уходит. Собеседник сейчас молчит.';
  }

  hint.textContent = text;
  hint.className = bad ? 'probe__hint is-bad' : 'probe__hint';
}

/**
 * Замершая картинка и рассыпающийся канал выглядят одинаково — как «всё
 * висит». Ловим это и пробуем пересобрать соединение, но не чаще раза в
 * 20 секунд, чтобы не устроить бесконечный цикл переподключений.
 */
/**
 * Присмотр за живым соединением. Кроме замершего видео и потерь ловим
 * ещё и затянувшуюся деградацию маршрута: если полминуты подряд пинг
 * за полсекунды или потери выше десяти процентов, разговаривать всё
 * равно невозможно — проще пересобрать путь, пока связь не оборвалась
 * сама. Между попытками выдерживаем паузу, иначе лечение станет хуже
 * болезни.
 */
function watchdog(loss) {
  if (!S.pc || S.pc.connectionState !== 'connected') return;
  const now = performance.now();
  const frozen = S.remoteState.cam && frames.cam.at > 0 && now - frames.cam.at > 6000;
  const broken = loss > 25;
  const rotten = (S.rttEma || 0) > 500 || S.lossEma > 10;

  if (rotten) {
    if (!S.rottenSince) S.rottenSince = now;
  } else {
    S.rottenSince = 0;
  }
  const sustained = S.rottenSince && now - S.rottenSince > 30000;

  if (frozen || broken || sustained) {
    setStatus('bad', frozen ? 'Видео замерло' : 'Канал перегружен');
    if (now - S.lastRecover > 20000) {
      S.rottenSince = 0;
      reconnect(
        frozen ? 'Видео замерло, пересобираю связь'
        : sustained ? 'Маршрут давно плохой, ищу другой'
        : 'Связь плохая, пересобираю'
      );
    }
  }
}

function summarizeRtt() {
  if (!S.rtts.length) return '—';
  const min = Math.round(Math.min(...S.rtts));
  const max = Math.round(Math.max(...S.rtts));
  const avg = Math.round(S.rtts.reduce((a, b) => a + b, 0) / S.rtts.length);
  return `${min}–${max}, в среднем ${avg} мс`;
}

/**
 * Мгновенное число врёт: пинг может прыгать вдвое между секундами, и по
 * нему не понять, стабильный канал или рваный. График за минуту показывает
 * именно разброс.
 */
function renderSpark() {
  const line = $('sparkLine');
  if (S.rtts.length < 2) { line.setAttribute('points', ''); return; }

  const max = Math.max(...S.rtts, 60);
  const step = 240 / (S.rtts.length - 1);
  const points = S.rtts
    .map((v, i) => `${(i * step).toFixed(1)},${(44 - (v / max) * 42).toFixed(1)}`)
    .join(' ');
  line.setAttribute('points', points);

  const avg = S.rtts.reduce((a, b) => a + b, 0) / S.rtts.length;
  line.className.baseVal = avg < 80 ? '' : avg < 200 ? 'is-mid' : 'is-bad';
  $('sparkSummary').textContent = summarizeRtt();
}

/**
 * Показываем медиану последних пяти замеров, а не сырое число. Мгновенный
 * пинг скачет вдвое между соседними секундами даже на хорошей сети — от
 * этого создаётся ощущение, что связь рвётся, хотя разговор идёт ровно.
 * График рядом рисуется по сырым значениям: разброс там видно честно.
 */
function renderPing(rtt) {
  const el = $('pingText');
  if (rtt == null) { el.textContent = '— мс'; el.className = ''; return; }

  S.rttWin.push(rtt);
  if (S.rttWin.length > 5) S.rttWin.shift();
  const sorted = [...S.rttWin].sort((a, b) => a - b);
  const ms = Math.round(sorted[Math.floor(sorted.length / 2)]);

  el.textContent = ms + ' мс';
  el.className = ms < 80 ? 'is-good' : ms < 200 ? 'is-mid' : 'is-bad';

  S.rtts.push(rtt);
  if (S.rtts.length > 60) S.rtts.shift();
  if (!$('statsPanel').hidden && !$('qualityView').hidden) renderSpark();
}

/**
 * Подстройка качества.
 *
 * Главная беда прошлой версии — дёрганье: одна секунда с потерями роняла
 * ступень, следующая спокойная поднимала обратно, и картинка пульсировала.
 * Теперь решение принимается по сглаженным величинам (экспоненциальное
 * среднее), вниз — после двух подряд плохих секунд, вверх — после
 * пятнадцати спокойных, и между переключениями держится пауза.
 * Вниз всё равно быстрее, чем вверх: лучше секунду посидеть на низком
 * качестве, чем десять смотреть на рассыпающийся кадр.
 */
function adaptQuality(rtt, loss) {
  if (rtt == null) return;

  const now = performance.now();
  // Первые значения принимаем как есть, дальше — сглаживаем
  const prev = S.rttEma;
  S.rttEma = prev == null ? rtt : prev * 0.7 + rtt * 0.3;
  S.lossEma = S.lossEma * 0.7 + loss * 0.3;

  // Разброс пинга. Средний пинг 150 мс — это нормальный разговор;
  // пинг, скачущий 100→250, звучит рвано при том же среднем. Меряем
  // именно отклонение от собственного среднего.
  if (prev != null) {
    S.rttVar = S.rttVar * 0.8 + Math.abs(rtt - prev) * 0.2;
  }

  const r = S.rttEma;
  const l = S.lossEma;
  const v = S.rttVar;

  // Буфер приёма пересчитываем постоянно — он и держит ровность звука
  applyLatency();

  // Скачущий пинг почти всегда означает переполненную очередь на
  // исходящем канале: мы шлём больше, чем канал вывозит, пакеты копятся
  // в буфере роутера и задержка гуляет. Лечится это не буфером приёма,
  // а тем, что мы сами отдаём меньше — поэтому разброс считается
  // признаком плохой сети наравне с потерями.
  const shaky = v > 45;
  if (shaky) {
    if (!S.shakySince) S.shakySince = now;
  } else {
    S.shakySince = 0;
  }
  const shakyLong = S.shakySince && now - S.shakySince > 5000;

  const awful = l > 12;
  const bad = l > 4 || r > 400 || shakyLong;
  const good = l < 1.2 && r < 200 && v < 25;

  // Канал измерен — верим ему больше, чем косвенным признакам.
  // Вниз по нему идём почти сразу: смысл всей затеи в том, чтобы
  // перестать переполнять канал до того, как это станет слышно.
  const budget = videoBudget();
  if (budget != null && !S.voiceOnly) {
    const fit = rungForBudget(budget);
    if (fit > S.quality && now - (S.qualityAt || 0) > 1500) {
      S.quality = fit;
      S.badSince = 0;
      S.qualityHold = 0;
      S.qualityAt = now;
      applySendParams();
      logEvent(
        'plain',
        `Канал ${Math.round(budget / 1000)} кбит/с — качество «${LADDER[S.quality].label}»`
      );
      return;
    }
    // Канал шире, чем мы шлём, и сеть спокойна — поднимаемся, не выжидая
    // полминуты. Раньше подъём почти никогда не набирался, и звонок так
    // и доживал до конца на заниженной картинке.
    // Для подъёма по измеренному каналу не требуем низкого пинга:
    // большая задержка сама по себе не мешает толстому потоку, а вот
    // требование rtt < 200 намертво запирало на «экономном» всех, кто
    // сидит через VPN или на другом континенте.
    const steady = l < 2 && v < 30;
    if (fit < S.quality && steady && now - (S.qualityAt || 0) > 3000) {
      S.quality--;
      S.badSince = 0;
      S.qualityHold = 0;
      S.qualityAt = now;
      applySendParams();
      logEvent('good', `Канал свободен — качество «${LADDER[S.quality].label}»`);
      return;
    }
  }

  if (S.voiceOnly) {
    if (l < 3) {
      if (++S.qualityHold >= 10) {
        S.voiceOnly = false;
        S.qualityHold = 0;
        applySendParams();
        logEvent('good', 'Сеть выправилась — видео вернулось');
        toast('Сеть выправилась — видео снова включено', 2600);
      }
    } else {
      S.qualityHold = 0;
    }
    return;
  }

  if (awful && S.quality >= LADDER.length - 1) {
    if (++S.voiceOnlySince >= 3) {
      S.voiceOnly = true;
      S.voiceOnlySince = 0;
      logEvent('warn', 'Потери слишком велики — оставляю только голос');
      S.qualityHold = 0;
      applySendParams();
      toast('Сеть не тянет видео — оставляю только голос', 3200);
    }
    return;
  }
  if (!awful) S.voiceOnlySince = 0;

  // Пауза между переключениями: без неё качество ходит туда-сюда
  const settled = now - (S.qualityAt || 0) > 4000;

  if (bad && S.quality < LADDER.length - 1) {
    if (++S.badSince >= 2 && settled) {
      S.quality++;
      S.badSince = 0;
      S.qualityHold = 0;
      S.qualityAt = now;
      S.shakySince = 0;
      applySendParams();
      logEvent(
        'plain',
        `Качество снижено до «${LADDER[S.quality].label}»` +
          (shakyLong ? ` (пинг гуляет на ${Math.round(v)} мс)` : '')
      );
    }
  } else if (good && S.quality > 0) {
    S.badSince = 0;
    // Раньше подъём требовал пятнадцати спокойных секунд подряд — на
    // живой сети это почти никогда не набиралось, и звонок так и шёл на
    // заниженном качестве до самого конца. Если пинг ровный, десяти хватает.
    const need = v < 15 ? 8 : 14;
    if (++S.qualityHold >= need && settled) {
      S.quality--;
      S.qualityHold = 0;
      S.qualityAt = now;
      applySendParams();
      logEvent('good', `Качество поднято до «${LADDER[S.quality].label}»`);
    }
  } else {
    S.badSince = 0;
    S.qualityHold = 0;
  }
}

/**
 * Замершая картинка при живом соединении.
 *
 * Самый неприятный вид поломки: пакеты идут, пинг в порядке, статус
 * зелёный — а на экране застывший кадр. Обычно это потерянный опорный
 * кадр: декодер ждёт следующего, а кодер на той стороне считает, что всё
 * отправил, и шлёт только разницу от кадра, которого у нас нет.
 * Браузер должен запросить новый сам (PLI), но по дырявому каналу этот
 * запрос теряется вместе со всем остальным.
 *
 * Поэтому просим напрямую, по каналу данных: видео идёт, а кадры не
 * прибавляются три секунды подряд — значит, декодер стоит.
 */
function watchFrames(dFrames, videoInBps) {
  const live = S.pc?.connectionState === 'connected';
  const expecting = videoInBps > 20_000;   // картинка действительно передаётся
  if (!live || !expecting || dFrames > 0) {
    if (S.frameStall) S.frameStall = 0;
    return;
  }
  if (++S.frameStall < 3) return;

  const now = performance.now();
  // Ноль означает «ещё ни разу не просили», а не «просили в нулевую
  // миллисекунду»: без этой оговорки первые секунды жизни страницы
  // просьба глохла сама собой.
  if (S.kfAskedAt && now - S.kfAskedAt < 5000) return;
  S.kfAskedAt = now;
  logEvent('warn', 'Картинка замерла — прошу опорный кадр');
  if (!chatSendRaw({ t: 'kf' })) {
    // Канал данных тоже мёртв — чинить надо соединение целиком
    recoverStep('картинка замерла, канал данных молчит');
  }
}

/**
 * Пересобрать кодер, чтобы он выдал опорный кадр. Прямого способа
 * попросить его в WebRTC нет, но выключенная и тут же включённая
 * дорожка заставляет кодировщик начать с нуля — а это ровно опорный кадр.
 */
async function forceKeyframe() {
  const senders = [S.send.screen];
  if (!S.voiceOnly) senders.push(S.send.cam);   // в голосовом режиме камера выключена намеренно
  let done = 0;
  for (const sender of senders) {
    if (!sender?.track) continue;
    try {
      const off = sender.getParameters();
      if (!off.encodings?.length) continue;
      off.encodings[0].active = false;
      await sender.setParameters(off);
      const on = sender.getParameters();
      on.encodings[0].active = true;
      await sender.setParameters(on);
      done++;
    } catch {}
  }
  if (done) logEvent('plain', 'Собеседник попросил опорный кадр — кодер пересобран');
}

async function renderSecurity(acc) {
  if (acc.dtls) $('lockText').textContent = S.key ? 'Защищено ключом' : 'Зашифровано';
  if (S.fingerprint || !acc.localFp || !acc.remoteFp || !crypto.subtle) return;
  try {
    const joined = [acc.localFp, acc.remoteFp].sort().join('|');
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(joined));
    const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
    S.fingerprint = (hex.slice(0, 4) + ' ' + hex.slice(4, 8)).toUpperCase();
  } catch {}
}

const STAT_ROWS = [
  ['Пинг', (d) => (d.rtt == null ? '—' : Math.round(d.rtt) + ' мс')],
  ['Буфер приёма', (d) => (d.buffer == null ? '—' : Math.round(d.buffer) + ' мс')],
  ['Потери', (d) => d.loss.toFixed(1) + ' %'],
  ['Джиттер', (d) => (d.jitter == null ? '—' : Math.round(d.jitter) + ' мс')],
  ['Разброс пинга', () => (S.rttEma == null ? '—' : '±' + Math.round(S.rttVar) + ' мс')],
  ['Приём', (d) => fmtKbps(d.inBps)],
  ['Отдача', (d) => fmtKbps(d.outBps)],
  ['Канал', () => (S.bwe == null ? '—' : fmtKbps(S.bwe))],
  ['Разрешение', (d) => (d.width ? `${d.width}×${d.height}` : '—')],
  ['Кадры', (d) => (d.fps ? Math.round(d.fps) + ' к/с' : '—')],
];

function renderStatsPanel(acc, inBps, outBps, loss) {
  if ($('statsPanel').hidden) return;
  const d = { ...acc, inBps, outBps, loss };

  const cells = STAT_ROWS.map(([label, fn]) => `<div class="stat"><span>${label}</span><b>${fn(d)}</b></div>`);

  // Ощущаемая задержка: полпути по сети плюс буфер приёма
  const mouthToEar = acc.rtt != null && acc.buffer != null ? Math.round(acc.rtt / 2 + acc.buffer) : null;
  cells.push(`<div class="stat stat--wide"><span>Задержка звука</span><b>${mouthToEar == null ? '—' : mouthToEar + ' мс'}</b></div>`);
  const path = [acc.route || '—', acc.proto ? acc.proto.toUpperCase() : null, acc.relayProto ? 'через ' + acc.relayProto.toUpperCase() : null]
    .filter(Boolean)
    .join(', ');
  cells.push(`<div class="stat stat--wide"><span>Маршрут</span><b>${path}</b></div>`);
  cells.push(`<div class="stat stat--wide"><span>Ваш адрес в соединении</span><b>${acc.localAddr || '—'}</b></div>`);
  cells.push(`<div class="stat stat--wide"><span>Шифрование</span><b>${acc.srtp || acc.dtls || 'DTLS-SRTP'}</b></div>`);
  $('statsGrid').innerHTML = cells.join('');

  const parts = [`Отправка: <b>${LADDER[S.quality].label}</b>, подстраивается автоматически.`];
  if (acc.codec) parts.push(`Кодек: <b>${acc.codec}</b>.`);
  if (S.fingerprint) parts.push(`Код безопасности: <b>${S.fingerprint}</b> — должен совпадать у обоих.`);
  if (S.rtts.length > 8) {
    const spread = Math.max(...S.rtts) - Math.min(...S.rtts);
    if (spread > 90) {
      parts.push(
        `<b>Пинг скачет на ${Math.round(spread)} мс</b> — канал рваный. ` +
          'Так ведут себя мобильный интернет, Wi-Fi на пределе дальности и VPN.'
      );
    }
  }
  if (S.key) parts.push('Сигналинг зашифрован ключом из ссылки — сервер видит только шифротекст.');
  if (S.voiceOnly) parts.push('<b>Сеть не тянет видео</b> — временно оставлен только голос.');

  for (const line of diagnose(acc)) parts.push(line);
  $('statsNote').innerHTML = parts.join('<br>');
}

/**
 * Понятным языком о том, что видно в статистике. Отдельно про VPN: сам факт
 * туннеля браузеру не виден, но его выдают косвенные признаки — соединение
 * по TCP, ретранслятор и адрес из служебных диапазонов.
 */
function diagnose(acc) {
  const out = [];
  const addr = acc.localAddr || '';
  const vpnish =
    /^(25|26)\./.test(addr) ||                       // Hamachi, Radmin VPN
    /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(addr) || // CGNAT и Tailscale
    /^198\.1[89]\./.test(addr) ||
    /^fd/i.test(addr);

  if (acc.proto === 'tcp' || acc.relayProto === 'tcp') {
    out.push('Соединение идёт по <b>TCP</b>. Обычно это значит, что UDP режет VPN или фаервол — задержка и рывки от этого заметно хуже.');
  }
  if (acc.route === 'через TURN-сервер') {
    out.push('Трафик идёт через ретранслятор, а не напрямую — это всегда дороже по задержке.');
  }
  if (vpnish) {
    out.push(`Адрес <b>${addr}</b> похож на VPN или виртуальную сеть. Если звонок не через неё, отключите VPN — станет заметно лучше.`);
  }
  // Пока разговор идёт, отсутствие ретранслятора никого не касается:
  // говорить о запасном пути имеет смысл только когда основной подвёл.
  if (S.relayOk === false && S.pc?.connectionState !== 'connected') {
    out.push('Рабочего ретранслятора нет: публичный не отвечает, свой не задан. Если прямой путь между вами не строится, соединиться будет нечем — впишите свой TURN-сервер в настройках.');
  }
  if (S.bwe != null && S.bwe < 500_000) {
    out.push(`Канал сейчас <b>${Math.round(S.bwe / 1000)} кбит/с</b> — этого хватает на голос и небольшую картинку. Качество уже опущено под него автоматически.`);
  }
  if (acc.rtt != null && acc.rtt > 150 && !out.length) {
    out.push('Высокий пинг задан маршрутом до собеседника. Помогают провод вместо Wi-Fi и отключение VPN.');
  }
  return out;
}

/* ═══════════════════════════════════════════════════════════════════
   ПАНЕЛИ И НАВИГАЦИЯ
   ═══════════════════════════════════════════════════════════════════ */

const PANELS = [
  ['statsPanel', 'statsBtn'],
  ['settingsPanel', 'settingsBtn'],
  ['chatPanel', 'chatBtn'],
];

/** Панели существуют по очереди: на телефоне двум сразу просто негде. */
function togglePanel(id, btnId) {
  const panel = $(id);
  const opening = panel.hidden;

  for (const [otherId, otherBtn] of PANELS) {
    if (otherId === id) continue;
    $(otherId).hidden = true;
    $(otherBtn).setAttribute('aria-pressed', 'false');
  }

  panel.hidden = !opening;
  $(btnId).setAttribute('aria-pressed', String(opening));

  if (id === 'chatPanel') {
    S.chatOpen = opening;
    if (opening) {
      S.unread = 0;
      renderUnread();
      setTimeout(() => $('chatInput').focus({ preventScroll: true }), 60);
      scrollChat();
    }
  }
}

function showTab(which) {
  const quality = which === 'quality';
  $('qualityView').hidden = !quality;
  $('logView').hidden = quality;
  $('tabQuality').classList.toggle('is-on', quality);
  $('tabLog').classList.toggle('is-on', !quality);
  $('tabQuality').setAttribute('aria-selected', String(quality));
  $('tabLog').setAttribute('aria-selected', String(!quality));
  if (!quality) { S.logErrors = 0; renderLog(); }
  renderLogBadge();
}

$('tabQuality').addEventListener('click', () => showTab('quality'));
$('tabLog').addEventListener('click', () => showTab('log'));

$('statsBtn').addEventListener('click', () => togglePanel('statsPanel', 'statsBtn'));
$('pingPill').addEventListener('click', () => togglePanel('statsPanel', 'statsBtn'));
$('statsClose').addEventListener('click', () => togglePanel('statsPanel', 'statsBtn'));
$('lockPill').addEventListener('click', () => togglePanel('statsPanel', 'statsBtn'));
$('settingsBtn').addEventListener('click', () => { listDevices(); togglePanel('settingsPanel', 'settingsBtn'); });
$('settingsClose').addEventListener('click', () => togglePanel('settingsPanel', 'settingsBtn'));
$('chatBtn').addEventListener('click', () => togglePanel('chatPanel', 'chatBtn'));
$('chatClose').addEventListener('click', () => togglePanel('chatPanel', 'chatBtn'));

/* ═══════════════════════════════════════════════════════════════════
   ЧАТ
   ═══════════════════════════════════════════════════════════════════ */

/*
 * Сообщения идут по каналу данных WebRTC — то есть напрямую собеседнику
 * и под тем же шифрованием DTLS, что и видео. Сервер их не видит вовсе,
 * история нигде не сохраняется и исчезает вместе со звонком.
 */

function bindChat(channel) {
  S.chat = channel;
  channel.addEventListener('open', () => {
    updateChatAvailability();
    addSystemMessage('Чат подключён');
    startKeepalive();
  });
  channel.addEventListener('close', () => { stopKeepalive(); updateChatAvailability(); });
  channel.addEventListener('error', updateChatAvailability);
  channel.addEventListener('message', (e) => {
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }

    // Служебные пакеты идут тем же каналом и в переписке не показываются
    if (msg?.t === 'ping') { chatSendRaw({ t: 'pong', at: msg.at }); return; }
    if (msg?.t === 'kf') { forceKeyframe(); return; }
    if (msg?.t === 'pong') { onPong(msg.at); return; }

    if (typeof msg?.text !== 'string') return;
    addMessage({
      text: msg.text.slice(0, 2000),
      who: String(msg.name || '').slice(0, 24) || S.peerName || 'Собеседник',
      own: false,
    });
  });
  updateChatAvailability();
}

function chatSendRaw(obj) {
  if (S.chat?.readyState !== 'open') return false;
  try { S.chat.send(JSON.stringify(obj)); return true; } catch { return false; }
}

/**
 * Свой пульс поверх канала данных. Делает сразу три вещи.
 *
 * Первое — держит открытыми отображения NAT. Домашний роутер закрывает
 * тихий UDP-канал за полминуты, мобильный оператор бывает и за пятнадцать
 * секунд, VPN — почти всегда быстрее всех. Тишина в разговоре не значит
 * тишину в сети, но для роутера значит именно это: он выкидывает запись,
 * и звонок умирает молча, без единой ошибки.
 *
 * Второе — меряет задержку там, где браузер её не отдаёт. Safari на
 * iPhone часто не заполняет currentRoundTripTime, и пинг у половины
 * звонков оставался прочерком.
 *
 * Третье — замечает смерть канала раньше, чем это сделает ICE: три
 * пропущенных ответа подряд означают, что путь уже не работает, хотя
 * состояние соединения ещё бодро показывает connected.
 */
function startKeepalive() {
  stopKeepalive();
  S.keepMisses = 0;
  S.keepTimer = setInterval(() => {
    if (!S.inCall || S.chat?.readyState !== 'open') return;
    if (S.dcSentAt) {
      // На предыдущий пинг ответа не было
      if (++S.keepMisses === 3) {
        logEvent('warn', 'Канал данных молчит — проверяю маршрут');
        recoverStep('канал данных молчит');
      }
    }
    S.dcSentAt = performance.now();
    if (!chatSendRaw({ t: 'ping', at: S.dcSentAt })) S.dcSentAt = 0;
  }, 2000);
}

function stopKeepalive() {
  clearInterval(S.keepTimer);
  S.keepTimer = null;
  S.dcSentAt = 0;
  S.dcRtt = null;
  S.keepMisses = 0;
}

function onPong(at) {
  if (!at) return;
  const rtt = performance.now() - at;
  S.dcRtt = S.dcRtt == null ? rtt : S.dcRtt * 0.6 + rtt * 0.4;
  S.dcSentAt = 0;
  S.keepMisses = 0;
}

function updateChatAvailability() {
  const ready = S.chat?.readyState === 'open';
  $('chatInput').disabled = !ready;
  $('chatSend').disabled = !ready;
  $('chatInput').placeholder = ready ? 'Сообщение' : 'Ждём собеседника…';
}

function addMessage({ text, who, own }) {
  $('chatEmpty').hidden = true;

  const wrap = document.createElement('div');
  wrap.className = 'msg' + (own ? ' msg--own' : '');

  const label = document.createElement('p');
  label.className = 'msg__who';
  label.textContent = own ? (S.name || 'Вы') : who;

  const body = document.createElement('div');
  body.className = 'msg__body';
  body.textContent = text; // именно textContent: разметка из чата не исполняется

  wrap.append(label, body);
  $('chatLog').append(wrap);
  scrollChat();

  if (!own && !S.chatOpen) {
    S.unread++;
    renderUnread();
    beep(760);
  }
}

function addSystemMessage(text) {
  const wrap = document.createElement('div');
  wrap.className = 'msg msg--sys';
  const body = document.createElement('div');
  body.className = 'msg__body';
  body.textContent = text;
  wrap.append(body);
  $('chatLog').append(wrap);
  scrollChat();
}

function scrollChat() {
  const log = $('chatLog');
  log.scrollTop = log.scrollHeight;
}

function renderUnread() {
  const badge = $('chatBadge');
  badge.hidden = S.unread === 0;
  badge.textContent = S.unread > 9 ? '9+' : String(S.unread);
}

function clearChat() {
  $('chatLog').querySelectorAll('.msg').forEach((el) => el.remove());
  $('chatEmpty').hidden = false;
  S.unread = 0;
  renderUnread();
}

$('chatForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = $('chatInput');
  const text = input.value.trim();
  if (!text || S.chat?.readyState !== 'open') return;

  try {
    S.chat.send(JSON.stringify({ text, name: S.name || '' }));
    addMessage({ text, who: S.name || 'Вы', own: true });
    input.value = '';
  } catch {
    toast('Сообщение не ушло — связь прервалась');
  }
});

/* ═══════════════════════════════════════════════════════════════════
   ИМЯ
   ═══════════════════════════════════════════════════════════════════ */

let nameTimer;
function setName(value, from) {
  S.name = String(value || '').slice(0, 24);
  prefs.set('name', S.name);
  for (const id of ['nameInput', 'nameSetting']) {
    if (id !== from) $(id).value = S.name;
  }
  refreshUi();
  clearTimeout(nameTimer);
  nameTimer = setTimeout(sendState, 400);
}

for (const id of ['nameInput', 'nameSetting']) {
  $(id).addEventListener('input', (e) => setName(e.target.value, id));
}

S.name = prefs.get('name', '');
$('nameInput').value = S.name;
$('nameSetting').value = S.name;

/* ═══════════════════════════════════════════════════════════════════
   НАСТРОЙКИ
   ═══════════════════════════════════════════════════════════════════ */

/*
 * Переключатель в настройках. Отсутствующий элемент здесь не должен
 * ронять всё приложение: разметка и скрипт живут в разных файлах и
 * обновляются порознь, а одна лишняя строка исключения на этапе
 * первоначальной привязки не даёт навесить обработчик даже на кнопку
 * «Создать звонок» — со стороны это выглядит как «сайт умер целиком».
 * Лучше потерять один выключатель и записать это в журнал.
 */
function bindSwitch(id, key, onChange) {
  const el = $(id);
  if (!el) {
    logEvent('error', `Не найден переключатель «${id}» — разметка старше скрипта`);
    S[key] = prefs.get(key, false);
    return;
  }
  el.checked = prefs.get(key, el.checked);
  S[key] = el.checked;
  el.addEventListener('change', () => {
    S[key] = el.checked;
    prefs.set(key, el.checked);
    onChange?.(el.checked);
  });
}

bindSwitch('lowLatency', 'lowLatency', (on) => {
  applyLatency(true);
  toast(on ? 'Низкая задержка включена' : 'Обычный буфер приёма', 1800);
});
bindSwitch('shareAudio', 'shareAudio');
bindSwitch('relayOnly', 'forceRelay', (on) => {
  logEvent('plain', on ? 'Включён режим «только через ретранслятор»' : 'Ретранслятор больше не обязателен');
  if (S.inCall && S.peerPresent) hardRestart(true, on ? 'включён ретранслятор' : 'выключен ретранслятор');
  else toast(on ? 'Применится при следующем звонке' : 'Прямой путь снова разрешён', 2200);
});
bindSwitch('mirrorSelf', 'mirror', refreshUi);
bindSwitch('noiseSuppress', 'noiseSuppress', () => applyAudioProcessing(true));
bindSwitch('echoCancel', 'echoCancel', () => applyAudioProcessing(true));
bindSwitch('autoGain', 'autoGain', () => applyAudioProcessing(true));

$('shareQuality').value = prefs.get('shareQuality', 'detail');
S.shareQuality = $('shareQuality').value;
$('shareQuality').addEventListener('change', async (e) => {
  S.shareQuality = e.target.value;
  prefs.set('shareQuality', S.shareQuality);
  if (!S.sharing) return toast('Применится при следующей демонстрации', 2000);

  // На лету меняем частоту кадров и подсказку кодеку, не пересоздавая захват
  const preset = SHARE_PRESETS[S.shareQuality];
  try { S.local.screen.contentHint = preset.hint; } catch {}
  try { await S.local.screen.applyConstraints({ frameRate: { ideal: preset.fps, max: preset.fps } }); } catch {}
  preferScreenCodec();
  await applySendParams();
  toast(`Демонстрация: ${preset.label}`, 2000);
});

$('reconnectBtn').addEventListener('click', () => reconnect());
$('restartBothBtn').addEventListener('click', () => {
  if (!S.peerPresent) return toast('Собеседника нет — перезапускать нечего');
  hardRestart(true, 'кнопка');
  toast('Перезапускаю звонок у обоих', 2500);
});

for (const id of ['turnUrl', 'turnUser', 'turnPass']) {
  $(id).value = prefs.get(id, '');
  $(id).addEventListener('change', (e) => {
    prefs.set(id, e.target.value.trim());
    logEvent('plain', 'Настройки TURN изменены');
    // Введённые данные — новые, прошлый вердикт к ним отношения не имеет
    S.relayOk = null;
    S.relayProbe = null;
  });
}

/*
 * Проверка TURN по нажатию. Узнать, работает ли ретранслятор, иначе можно
 * только в бою — когда связь уже не строится и разбираться некогда.
 * Здесь же ответ приходит за несколько секунд и словами.
 */
$('turnCheck').addEventListener('click', async () => {
  const note = $('turnResult');
  const btn = $('turnCheck');
  if (!hasRelay()) {
    note.textContent = 'Адрес не задан: впишите его в поле выше — он начинается с turn: или turns:';
    note.classList.add('is-warn');
    return;
  }
  btn.disabled = true;
  note.classList.remove('is-warn');
  note.textContent = 'Проверяю…';
  S.relayOk = null;
  S.relayProbe = null;
  const ok = await relayUsable();
  btn.disabled = false;
  note.classList.toggle('is-warn', !ok);
  note.textContent = ok
    ? 'Ретранслятор отвечает. Теперь связь построится даже там, где прямой путь не складывается.'
    : 'Ретранслятор не ответил. Проверьте адрес, логин и пароль; если сервер требует TLS — адрес должен начинаться с turns: и обычно оканчиваться на :443 или :5349.';
});

/*
 * Отпечаток сборки берём у сервера, а не из константы: так сразу видно,
 * что именно крутится на этом адресе.
 */
$('buildStamp').textContent = 'Сборка ' + BUILD;
fetch('/api/health', { cache: 'no-store' })
  .then((r) => r.json())
  .then((info) => {
    if (info?.build) {
      S.serverBuild = info.build;
      $('buildStamp').textContent = `Сборка ${BUILD} · ${info.build}`;
    }
  })
  .catch(() => {});

/* ─────────────── Экраны ─────────────── */

async function enterCall(roomId, roomKey = null) {
  S.roomId = roomId;
  S.roomKey = roomKey;
  S.key = await importRoomKey(roomKey);
  S.keyWarned = false;
  S.fatal = null;
  S.inCall = true;
  S.fingerprint = null;

  const suffix = S.key ? '#k=' + roomKey : '';
  history.replaceState({ room: roomId }, '', '/' + roomId + suffix);
  document.title = `Звонок ${roomId} · Звонилка`;

  $('lockText').textContent = S.key ? 'Защищено ключом' : 'Шифруется';
  $('lockPill').title = S.key
    ? 'Сигналинг зашифрован ключом из ссылки, сервер видит только шифротекст'
    : 'Медиапоток зашифрован, но ключа комнаты в ссылке нет';

  $('inviteLink').value = location.origin + '/' + roomId + suffix;
  $('shareBtn').hidden = !navigator.share;
  $('shareScreenBtn').hidden = !navigator.mediaDevices?.getDisplayMedia;
  $('stageEmptyText').textContent = 'Ожидание собеседника…';
  setInvite(false);

  show('call');
  setStatus('connecting', 'Соединяюсь с сервером…');

  // К серверу идём сразу, не дожидаясь камеры. Раньше было наоборот, и
  // если getUserMedia подвисал — а он подвисает, когда камеру держит другая
  // программа, — звонок навсегда застревал на «Подключение…».
  startFrameWatch();
  hintOnce();
  updateChatAvailability();
  refreshUi();
  connectSignaling();
  requestWakeLock();
  watchStall();

  setStatus('connecting', 'Спрашиваю доступ к камере и микрофону…');
  await ensureMedia();
  syncStatus();

  // Дорожки приехали позже соединения — прикрепляем их сейчас
  if (S.pc) await bindRoles();

  S.sinkId = prefs.get('sink', '');
  if (S.sinkId) setSink(S.sinkId);
  refreshUi();
}

/**
 * Если соединение не поднимается слишком долго, человек должен узнать об
 * этом словами, а не смотреть на вечное «Подключение…».
 */
let stallTimer = null;
function watchStall() {
  clearInterval(stallTimer);
  const since = performance.now();
  let step = 0;

  stallTimer = setInterval(() => {
    if (!S.inCall) return clearInterval(stallTimer);
    if (S.pc?.connectionState === 'connected') { clearInterval(stallTimer); return; }
    if (!S.peerPresent) return;              // ждать собеседника — это нормально

    const waiting = (performance.now() - since) / 1000;

    // Первый шаг — просто перебрать пути заново
    if (waiting > 12 && step === 0) {
      step = 1;
      reconnect('Соединение затянулось, пробую заново');
      return;
    }

    // Второй — уйти на ретранслятор. Именно здесь чинится пара
    // «один под VPN, другой без»: прямой путь между ними не строится,
    // сколько ни перебирай, а через ретранслятор соединяются оба.
    if (waiting > 22 && step === 1) {
      step = 2;
      if (hasRelay() && !S.forceRelay) {
        setRelayOnly(true, false);
        logEvent('warn', 'Прямой путь не построился — иду через ретранслятор');
        toast('Прямой путь не строится — пробую через ретранслятор', 3500);
        hardRestart(true, 'переход на ретранслятор');
      } else {
        hardRestart(true, 'соединение не поднимается');
      }
      return;
    }

    if (waiting > 40) {
      clearInterval(stallTimer);
      S.fatal = 'Не удалось соединиться';
      syncStatus();
      toast(
        'Соединение не установилось даже через ретранслятор. Обычно это очень строгий ' +
          'фаервол или VPN, режущий UDP: попробуйте выключить VPN с одной стороны ' +
          'или раздать интернет с телефона.',
        9000
      );
    }
  }, 1000);
}

/** Одна подсказка за всё время: как переключать окна. Дальше молчим. */
function hintOnce() {
  if (prefs.get('hintTiles', false)) return;
  const touch = matchMedia('(pointer: coarse)').matches;
  setTimeout(() => {
    if (!S.inCall || !S.peerPresent) return;
    prefs.set('hintTiles', true);
    toast(touch ? 'Нажмите на маленькое окно, чтобы развернуть его' : 'Клик по миниатюре разворачивает её на весь экран', 5000);
  }, 6000);
}

function endCall(title = 'Звонок завершён', text = 'Спасибо за разговор.') {
  S.inCall = false;
  stopStats();
  try { S.ws?.send(JSON.stringify({ type: 'bye' })); } catch {}
  S.ws?.close();
  S.ws = null;
  S.pc?.close();
  S.pc = null;
  S.send = { mic: null, cam: null, screen: null, screenAudio: null };
  S.screenStream?.getTracks().forEach((t) => t.stop());
  S.screenStream = null;
  S.sharing = false;
  S.peerPresent = false;
  S.prev = null;
  S.quality = 2;
  S.voiceOnly = false;
  S.voiceOnlySince = 0;
  S.main = null;
  S.mainLocked = false;
  S.chat = null;
  S.peerName = '';
  clearInterval(stallTimer);
  clearTimeout(rebuildTimer);
  rebuildTimer = null;
  S.rtts = [];
  clearChat();
  updateChatAvailability();
  stopFrameWatch();
  stopKeepalive();
  clearTimeout(S.limpTimer);
  clearTimeout(S.muteTimer);
  $('soundGate').hidden = true;
  for (const id of ['remote-cam', 'remote-screen', 'local-screen']) tileVideo(id).srcObject = null;
  for (const k of Object.keys(remoteTracks)) remoteTracks[k] = null;
  onSpeak('peer', false);
  releaseWakeLock();

  $('endedTitle').textContent = title;
  $('endedText').textContent = text;
  show('ended');
  document.title = 'Звонилка — зашифрованные звонки в браузере';
}

function goHome() {
  history.replaceState({}, '', '/');
  $('previewVideo').srcObject = S.camStream;
  refreshUi();
  show('lobby');
}

$('createBtn').addEventListener('click', () => enterCall(randomRoomId(), newRoomKey()));

$('joinForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const { id, key } = parseRoomLink($('roomInput').value);
  if (id.length < 3) return toast('Введите код комнаты или ссылку');
  if (!key) toast('В ссылке нет ключа комнаты — собеседник должен открыть такую же ссылку', 5000);
  enterCall(id, key);
});

$('hangupBtn').addEventListener('click', () => endCall());
$('rejoinBtn').addEventListener('click', () =>
  enterCall(S.roomId || randomRoomId(), S.roomKey || newRoomKey()));
$('homeBtn').addEventListener('click', goHome);

$('copyBtn').addEventListener('click', async () => {
  const link = $('inviteLink').value;
  try {
    await navigator.clipboard.writeText(link);
    toast('Ссылка скопирована');
  } catch {
    $('inviteLink').select();
    document.execCommand?.('copy');
    toast('Ссылка скопирована');
  }
});

$('shareBtn').addEventListener('click', () => {
  navigator.share?.({ title: 'Звонок в Звонилке', url: $('inviteLink').value }).catch(() => {});
});

/* ─────────────── Горячие клавиши ─────────────── */

const KEYS = {
  m: () => { setMic(!S.micOn); toast(S.micOn ? 'Микрофон включён' : 'Микрофон выключен', 1200); },
  v: () => { setCam(!S.camOn); toast(S.camOn ? 'Камера включена' : 'Камера выключена', 1200); },
  d: () => (S.sharing ? stopShare() : startShare()),
  a: () => { setSpeaker(!S.speakerOn); toast(S.speakerOn ? 'Звук включён' : 'Звук выключен', 1200); },
  s: () => togglePanel('statsPanel', 'statsBtn'),
  k: () => { listDevices(); togglePanel('settingsPanel', 'settingsBtn'); },
  c: () => togglePanel('chatPanel', 'chatBtn'),
  r: () => reconnect(),
  e: () => endCall(),
  f: () => {
    const el = tileEl(S.main);
    if (!el) return;
    document.fullscreenElement ? document.exitFullscreen() : el.requestFullscreen?.().catch(() => {});
  },
};
// Раскладка не должна мешать: те же клавиши в кириллице
const RU = { ь: 'm', м: 'v', в: 'd', ф: 'a', ы: 's', л: 'k', у: 'e', а: 'f', к: 'r', с: 'c' };

addEventListener('keydown', (e) => {
  if (!S.inCall || e.metaKey || e.ctrlKey || e.altKey) return;
  if (/^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement?.tagName)) return;
  const raw = e.key.toLowerCase();
  const key = KEYS[raw] ? raw : RU[raw];
  if (key && KEYS[key]) { e.preventDefault(); KEYS[key](); }
  // Цифрами выбираем, что показать крупно
  if (/^[1-4]$/.test(raw)) {
    const visible = TILE_ORDER.filter((id) => TILE_LIVE[id]());
    const pick = visible[Number(raw) - 1];
    if (pick) setMain(pick, true);
  }
});

/* ─────────────── Экономия ресурсов ─────────────── */

document.addEventListener('visibilitychange', () => {
  pacePolling();
  if (!S.send.cam?.track) return;
  try {
    const p = S.send.cam.getParameters();
    if (!p.encodings?.length) return;
    p.encodings[0].maxBitrate = document.hidden
      ? 150_000
      : PLATFORM.mobile ? Math.min(LADDER[S.quality].bitrate, 3_000_000) : LADDER[S.quality].bitrate;
    p.encodings[0].maxFramerate = document.hidden ? 8 : LADDER[S.quality].fps;
    S.send.cam.setParameters(p);
  } catch {}
});

async function requestWakeLock() {
  try { S.wakeLock = await navigator.wakeLock?.request('screen'); } catch {}
}
function releaseWakeLock() {
  try { S.wakeLock?.release(); } catch {}
  S.wakeLock = null;
}
document.addEventListener('visibilitychange', () => {
  if (document.hidden || !S.inCall) return;
  if (!S.wakeLock) requestWakeLock();

  // iOS выгружает медиа, когда экран гаснет: вернулись — проверяем, живо ли
  const state = S.pc?.connectionState;
  if (S.peerPresent && state && state !== 'connected' && state !== 'connecting') {
    logEvent('warn', 'Вернулись в приложение, соединение в состоянии ' + state);
    hardRestart(true, 'возврат из фона');
  } else if (state === 'connected') {
    // Соединение формально живо, но пока телефон спал, роутер мог закрыть
    // отображение. Пинг по каналу данных покажет это за пару секунд —
    // и сбросит счётчик пропусков, если всё в порядке.
    S.dcSentAt = 0;
    S.keepMisses = 0;
    const muted = Object.values(remoteTracks).some((t) => t && t.muted);
    if (muted) {
      logEvent('warn', 'После сна дорожки молчат — проверяю маршрут');
      S.lastRecover = 0;
      recoverStep('возврат из сна');
    }
  }
  playRemoteAudio();
});

// Мобильный Safari умеет возвращать страницу из кэша, минуя обычные события
addEventListener('pageshow', (e) => {
  if (e.persisted && S.inCall && S.peerPresent) {
    logEvent('warn', 'Страница восстановлена из кэша');
    hardRestart(true, 'восстановление страницы');
  }
});

addEventListener('beforeunload', () => {
  try { S.ws?.send(JSON.stringify({ type: 'bye' })); } catch {}
});

navigator.mediaDevices?.addEventListener?.('devicechange', listDevices);

watchNetwork();

// Браузер держит звук на паузе до первого действия пользователя — будим его,
// иначе индикатор речи и сигналы будут молчать при входе по прямой ссылке.
for (const ev of ['pointerdown', 'keydown']) {
  addEventListener(ev, () => {
    if (audioCtx?.state === 'suspended') audioCtx.resume().catch(() => {});
    if (S.soundBlocked) playRemoteAudio();
  }, { passive: true });
}

function beep(freq) {
  try {
    const ctx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    audioCtx = ctx;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = freq;
    osc.type = 'sine';
    gain.gain.setValueAtTime(0.0001, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.06, ctx.currentTime + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.25);
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.26);
  } catch {}
}

/* Точка для отладки из консоли браузера и для автотестов */
window.__zv = S;
window.__zvDebug = {
  adaptQuality, applySendParams, reconnect, diagnose, tuneSdp,
  preferCamCodec, preferAudioCodec, camCodecOrder, hasRelay, targetBuffer,
  logReport, recoverStep, setRelayOnly, pacePolling, sendOffer, watchNegotiation,
  probeRelay, relayUsable, dropRelay, hardRestart, noWayOut,
  videoBudget, rungForBudget, watchFrames, forceKeyframe,
  LADDER, SHARE_PRESETS, PLATFORM,
  log: () => LOG.slice(),
};

/* ─────────────── Старт ─────────────── */

(function boot() {
  const path = location.pathname.replace(/^\/|\/$/g, '');
  const key = (location.hash.match(/^#k=([A-Za-z0-9_-]{40,64})$/) || [])[1] || null;
  if (/^[A-Za-z0-9_-]{3,64}$/.test(path)) {
    $('roomInput').value = path;
    enterCall(path, key);
  } else {
    show('lobby');
    ensureMedia();
  }
})();
