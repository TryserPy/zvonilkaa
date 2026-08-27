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

  makingOffer: false,
  ignoreOffer: false,
  settingRemoteAnswer: false,

  statsTimer: null,
  prev: null,
  quality: 2,
  qualityHold: 0,
  voiceOnly: false,
  voiceOnlySince: 0,
  wakeLock: null,
  fingerprint: null,
  inCall: false,
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

const videoConstraints = (facing) => ({
  width: { ideal: 1280 },
  height: { ideal: 720 },
  frameRate: { ideal: 30, max: 30 },
  facingMode: { ideal: facing },
});

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
      const stream = await navigator.mediaDevices.getUserMedia(c);
      adoptCamStream(stream);
      if (!c.video) {
        S.camOn = false;
        toast('Камера недоступна — звонок только со звуком');
      }
      return stream;
    } catch (err) {
      if (err.name === 'NotAllowedError') {
        toast('Доступ к камере и микрофону запрещён. Разрешите его в настройках сайта.', 6000);
        return null;
      }
    }
  }
  toast('Не удалось получить доступ к устройствам', 5000);
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
  let blocked = false;
  for (const el of audioEls()) {
    if (!el.srcObject) continue;
    el.muted = !S.speakerOn;
    el.volume = 1;
    try {
      await el.play();
    } catch (err) {
      if (err?.name === 'NotAllowedError') blocked = true;
    }
  }
  S.soundBlocked = blocked;
  $('soundGate').hidden = !(blocked && S.speakerOn);
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
function reconnect(reason) {
  if (!S.pc) return toast('Соединения нет — ждём собеседника');
  S.lastRecover = performance.now();
  try {
    S.pc.restartIce();
    setStatus('connecting', 'Переподключение…');
    toast(reason || 'Переподключаю связь', 2000);
  } catch {
    toast('Не удалось переподключиться');
  }
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

  $('tiles').classList.toggle('no-mirror', !S.mirror);
  $('stageEmpty').hidden = !!S.main;
}

/* ═══════════════════════════════════════════════════════════════════
   СИГНАЛИНГ
   ═══════════════════════════════════════════════════════════════════ */

function connectSignaling() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(`${proto}//${location.host}/ws`);
  S.ws = ws;

  ws.addEventListener('open', () => {
    S.wsRetry = 0;
    ws.send(JSON.stringify({ type: 'join', roomId: S.roomId }));
  });

  let recvChain = Promise.resolve();
  ws.addEventListener('message', (e) => {
    let m;
    try { m = JSON.parse(e.data); } catch { return; }
    recvChain = recvChain.then(() => handleSignal(m)).catch((err) => console.warn('signal:', err));
  });

  ws.addEventListener('close', () => {
    if (!S.inCall) return;
    S.wsRetry++;
    setStatus('connecting', 'Переподключение…');
    setTimeout(connectSignaling, Math.min(1000 * 2 ** S.wsRetry, 10000));
  });
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
    },
  });
}

async function handleSignal(m) {
  switch (m.type) {
    case 'welcome':
      if (Array.isArray(m.iceServers) && m.iceServers.length) S.iceServers = m.iceServers;
      break;

    case 'joined':
      S.peerId = m.peerId;
      S.polite = m.polite;
      if (m.peers.length) { S.peerPresent = true; await startPeerConnection(); refreshUi(); }
      else { setStatus('connecting', 'Ждём собеседника'); setInvite(true); }
      break;

    case 'peer-joined':
      S.peerPresent = true;
      setInvite(false);
      beep(660);
      await startPeerConnection();
      sendState();
      refreshUi();
      break;

    case 'peer-left':
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

  if (data.state) {
    S.remoteState = { ...S.remoteState, ...data.state };
    S.remoteKnown = true;
    onSpeak('peer', !!data.state.speaking);
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

/** Мягкая правка SDP: включаем FEC и DTX у Opus — ровнее звук, меньше трафика. */
function tuneSdp(sdp) {
  try {
    const pt = sdp.match(/a=rtpmap:(\d+)\s+opus\/48000/i)?.[1];
    if (!pt) return sdp;
    return sdp.replace(new RegExp(`a=fmtp:${pt} (.*)`), (line, params) => {
      const set = new Map(
        params.split(';').filter(Boolean).map((p) => {
          const [k, v] = p.split('=');
          return [k.trim(), v];
        })
      );
      set.set('useinbandfec', '1');
      set.set('usedtx', '1');
      return `a=fmtp:${pt} ` + [...set].map(([k, v]) => (v === undefined ? k : `${k}=${v}`)).join(';');
    });
  } catch { return sdp; }
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
}

async function startPeerConnection() {
  if (S.pc) return S.pc;

  const pc = new RTCPeerConnection({
    iceServers: S.iceServers || [{ urls: ['stun:stun.l.google.com:19302'] }],
    bundlePolicy: 'max-bundle',
    rtcpMuxPolicy: 'require',
    iceCandidatePoolSize: 4,
  });
  S.pc = pc;

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

  // Дорожки создаёт только инициатор — первый, кто оказался в комнате.
  // По спецификации транссиверы, созданные через addTransceiver, не
  // переиспользуются при входящем оффере: если бы их создавали обе стороны,
  // получилось бы восемь потоков вместо четырёх. Второй участник подхватит
  // уже готовые в bindRoles() после того, как применит оффер.
  if (!S.polite) {
    const transceivers = ROLES.map((role) =>
      pc.addTransceiver(role === 'cam' || role === 'screen' ? 'video' : 'audio', {
        direction: 'sendrecv',
      })
    );
    ROLES.forEach((role, i) => (S.send[role] = transceivers[i].sender));
    preferScreenCodec();
    await bindRoles();
  }

  pc.addEventListener('icecandidate', ({ candidate }) => {
    if (candidate) signal({ candidate });
  });

  pc.addEventListener('track', (e) => {
    const index = pc.getTransceivers().indexOf(e.transceiver);
    const role = ROLES[index];
    if (!role) return;

    remoteTracks[role] = e.track;
    S.remote[role] = e.track;
    attachRemote();
    playRemoteAudio();
    applyLatency();
    refreshUi();
  });

  pc.addEventListener('iceconnectionstatechange', () => {
    if (pc.iceConnectionState === 'failed') {
      setStatus('bad', 'Восстановление связи…');
      try { pc.restartIce(); } catch {}
    } else if (pc.iceConnectionState === 'connected') {
      syncStatus();
    }
  });

  pc.addEventListener('connectionstatechange', () => {
    switch (pc.connectionState) {
      case 'connected':
        syncStatus();
        setInvite(false);
        applySendParams();
        applyLatency();
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

  // Голос важнее картинки: помечаем его высоким приоритетом в сети
  await tune(S.send.mic, { encoding: { priority: 'high', networkPriority: 'high' } });

  const step = LADDER[S.quality];
  await tune(S.send.cam, {
    encoding: {
      active: !S.voiceOnly,
      maxBitrate: S.voiceOnly ? 60_000 : step.bitrate,
      maxFramerate: S.voiceOnly ? 5 : step.fps,
      scaleResolutionDownBy: 1,
      networkPriority: S.sharing ? 'low' : 'medium',
    },
    degradation: 'balanced',
  });

  const preset = SHARE_PRESETS[S.shareQuality] || SHARE_PRESETS.detail;
  await tune(S.send.screen, {
    encoding: {
      maxBitrate: preset.bitrate,
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
function applyLatency() {
  if (!S.pc) return;
  // На рваной сети маленький буфер вредит больше, чем помогает,
  // поэтому режим сам отступает и возвращается
  const short = S.lowLatency && !S.latencyBackoff;
  for (const r of S.pc.getReceivers()) {
    try { if ('jitterBufferTarget' in r) r.jitterBufferTarget = short ? 0 : null; } catch {}
    try { if ('playoutDelayHint' in r) r.playoutDelayHint = short ? 0 : undefined; } catch {}
  }
}

function onPeerLeft() {
  S.peerPresent = false;
  S.remoteState = { mic: true, cam: false, screen: false };
  S.remoteKnown = false;
  for (const id of ['remote-cam', 'remote-screen']) tileVideo(id).srcObject = null;
  for (const k of Object.keys(remoteTracks)) remoteTracks[k] = null;
  onSpeak('peer', false);
  frames.cam = { at: 0, mark: -1 };
  frames.screen = { at: 0, mark: -1 };
  $('soundGate').hidden = true;

  $('stageEmptyText').textContent = 'Собеседник вышел';
  setInvite(true);
  setStatus('connecting', 'Ждём собеседника');

  S.pc?.close();
  S.pc = null;
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
    case 'connecting': setStatus('connecting', 'Подключение…'); break;
    case 'disconnected': setStatus('bad', 'Связь нестабильна'); break;
    case 'failed': setStatus('bad', 'Связь потеряна'); break;
  }
}

function startStats() {
  stopStats();
  S.statsTimer = setInterval(collectStats, 1000);
}

function stopStats() {
  clearInterval(S.statsTimer);
  S.statsTimer = null;
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
    audioIn: 0, audioOut: 0, videoInFrames: 0,
    width: 0, height: 0, fps: 0,
    codec: null, route: null, srtp: null, dtls: null,
    localAddr: null, proto: null, relayProto: null, localType: null, remoteType: null,
    localFp: null, remoteFp: null,
    packetsLost: 0, packetsRecv: 0,
    bufferDelay: 0, bufferCount: 0,
  };

  const byId = new Map();
  report.forEach((r) => byId.set(r.id, r));

  report.forEach((r) => {
    if (r.type === 'candidate-pair' && (r.nominated || r.state === 'succeeded')) {
      if (r.currentRoundTripTime != null) acc.rtt = r.currentRoundTripTime * 1000;
      const local = byId.get(r.localCandidateId);
      const remote = byId.get(r.remoteCandidateId);
      if (local && remote) {
        acc.localType = local.candidateType;
        acc.remoteType = remote.candidateType;
        acc.localAddr = local.address || local.ip || null;
        acc.proto = local.protocol || null;
        acc.relayProto = local.relayProtocol || null;
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
  if (S.prev) {
    const dt = (now - S.prev.t) / 1000;
    if (dt > 0.2) {
      inBps = Math.max(0, ((acc.inBytes - S.prev.in) * 8) / dt);
      outBps = Math.max(0, ((acc.outBytes - S.prev.out) * 8) / dt);
      audioInBps = Math.max(0, ((acc.audioIn - S.prev.aIn) * 8) / dt);
      audioOutBps = Math.max(0, ((acc.audioOut - S.prev.aOut) * 8) / dt);
      const dLost = acc.packetsLost - S.prev.lost;
      const dRecv = acc.packetsRecv - S.prev.recv;
      if (dLost + dRecv > 0) lossPct = (dLost / (dLost + dRecv)) * 100;
    }
  }
  S.prev = {
    t: now, in: acc.inBytes, out: acc.outBytes,
    aIn: acc.audioIn, aOut: acc.audioOut,
    lost: acc.packetsLost, recv: acc.packetsRecv,
  };

  renderPing(acc.rtt);
  adaptQuality(acc.rtt, lossPct);
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
function watchdog(loss) {
  if (!S.pc || S.pc.connectionState !== 'connected') return;
  const now = performance.now();
  const frozen = S.remoteState.cam && frames.cam.at > 0 && now - frames.cam.at > 6000;
  const broken = loss > 25;

  if (frozen || broken) {
    setStatus('bad', frozen ? 'Видео замерло' : 'Канал перегружен');
    if (now - S.lastRecover > 20000) reconnect(frozen ? 'Видео замерло, пересобираю связь' : 'Связь плохая, пересобираю');
  }
}

function renderPing(rtt) {
  const el = $('pingText');
  if (rtt == null) { el.textContent = '— мс'; el.className = ''; return; }
  const ms = Math.round(rtt);
  el.textContent = ms + ' мс';
  el.className = ms < 80 ? 'is-good' : ms < 200 ? 'is-mid' : 'is-bad';
}

/**
 * Вниз опускаемся сразу, вверх — только после долгой спокойной сети.
 * Когда даже нижняя ступень не спасает, жертвуем видео ради голоса:
 * лучше слышать собеседника, чем смотреть на замерший кадр.
 */
function adaptQuality(rtt, loss) {
  if (rtt == null) return;

  // Маленький буфер приёма хорош на ровной сети и вреден на рваной
  const jittery = loss > 4;
  if (jittery !== S.latencyBackoff) {
    S.latencyBackoff = jittery;
    applyLatency();
  }

  const awful = loss > 12;
  const bad = loss > 4 || rtt > 350;
  const good = loss < 1.5 && rtt < 180;

  if (S.voiceOnly) {
    // Возвращаем видео только после десяти секунд спокойной сети
    if (loss < 3) {
      if (++S.qualityHold >= 10) {
        S.voiceOnly = false;
        S.qualityHold = 0;
        applySendParams();
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
      S.qualityHold = 0;
      applySendParams();
      toast('Сеть не тянет видео — оставляю только голос', 3200);
    }
    return;
  }
  if (!awful) S.voiceOnlySince = 0;

  if (bad && S.quality < LADDER.length - 1) {
    S.quality++;
    S.qualityHold = 0;
    applySendParams();
  } else if (good && S.quality > 0) {
    if (++S.qualityHold >= 12) { S.quality--; S.qualityHold = 0; applySendParams(); }
  } else {
    S.qualityHold = 0;
  }
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
  ['Приём', (d) => fmtKbps(d.inBps)],
  ['Отдача', (d) => fmtKbps(d.outBps)],
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
  if (acc.rtt != null && acc.rtt > 150 && !out.length) {
    out.push('Высокий пинг задан маршрутом до собеседника. Помогают провод вместо Wi-Fi и отключение VPN.');
  }
  return out;
}

/* ═══════════════════════════════════════════════════════════════════
   ПАНЕЛИ И НАВИГАЦИЯ
   ═══════════════════════════════════════════════════════════════════ */

function togglePanel(id, btnId) {
  const panel = $(id);
  const other = id === 'statsPanel' ? 'settingsPanel' : 'statsPanel';
  const otherBtn = id === 'statsPanel' ? 'settingsBtn' : 'statsBtn';
  $(other).hidden = true;
  $(otherBtn).setAttribute('aria-pressed', 'false');

  panel.hidden = !panel.hidden;
  $(btnId).setAttribute('aria-pressed', String(!panel.hidden));
}

$('statsBtn').addEventListener('click', () => togglePanel('statsPanel', 'statsBtn'));
$('pingPill').addEventListener('click', () => togglePanel('statsPanel', 'statsBtn'));
$('statsClose').addEventListener('click', () => togglePanel('statsPanel', 'statsBtn'));
$('lockPill').addEventListener('click', () => togglePanel('statsPanel', 'statsBtn'));
$('settingsBtn').addEventListener('click', () => { listDevices(); togglePanel('settingsPanel', 'settingsBtn'); });
$('settingsClose').addEventListener('click', () => togglePanel('settingsPanel', 'settingsBtn'));

/* Переключатели в настройках */
function bindSwitch(id, key, onChange) {
  const el = $(id);
  el.checked = prefs.get(key, el.checked);
  S[key] = el.checked;
  el.addEventListener('change', () => {
    S[key] = el.checked;
    prefs.set(key, el.checked);
    onChange?.(el.checked);
  });
}

bindSwitch('lowLatency', 'lowLatency', (on) => {
  applyLatency();
  toast(on ? 'Низкая задержка включена' : 'Обычный буфер приёма', 1800);
});
bindSwitch('shareAudio', 'shareAudio');
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
/*
 * Отпечаток сборки берём у сервера, а не из константы: так сразу видно,
 * что именно крутится на этом адресе. Локально и на хостинге они должны
 * совпадать — если нет, значит развёрнута другая версия.
 */
$('buildStamp').textContent = 'Сборка ' + BUILD;
fetch('/api/health', { cache: 'no-store' })
  .then((r) => r.json())
  .then((info) => {
    if (info?.build) $('buildStamp').textContent = `Сборка ${BUILD} · ${info.build}`;
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

  $('remoteAvatar').textContent = roomId[0].toUpperCase();
  $('inviteLink').value = location.origin + '/' + roomId + suffix;
  $('shareBtn').hidden = !navigator.share;
  $('shareScreenBtn').hidden = !navigator.mediaDevices?.getDisplayMedia;
  $('stageEmptyText').textContent = 'Ожидание собеседника…';
  setInvite(false);

  show('call');
  setStatus('connecting', 'Подключение…');

  await ensureMedia();
  startFrameWatch();
  hintOnce();
  S.sinkId = prefs.get('sink', '');
  if (S.sinkId) setSink(S.sinkId);
  refreshUi();
  connectSignaling();
  requestWakeLock();
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
  stopFrameWatch();
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
  r: () => reconnect(),
  e: () => endCall(),
  f: () => {
    const el = tileEl(S.main);
    if (!el) return;
    document.fullscreenElement ? document.exitFullscreen() : el.requestFullscreen?.().catch(() => {});
  },
};
// Раскладка не должна мешать: те же клавиши в кириллице
const RU = { ь: 'm', м: 'v', в: 'd', ф: 'a', ы: 's', л: 'k', у: 'e', а: 'f', к: 'r' };

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
  if (!S.send.cam?.track) return;
  try {
    const p = S.send.cam.getParameters();
    if (!p.encodings?.length) return;
    p.encodings[0].maxBitrate = document.hidden ? 150_000 : LADDER[S.quality].bitrate;
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
  if (!document.hidden && S.inCall && !S.wakeLock) requestWakeLock();
});

addEventListener('beforeunload', () => {
  try { S.ws?.send(JSON.stringify({ type: 'bye' })); } catch {}
});

navigator.mediaDevices?.addEventListener?.('devicechange', listDevices);

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
window.__zvDebug = { adaptQuality, applySendParams, reconnect, diagnose, LADDER, SHARE_PRESETS };

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
