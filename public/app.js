/* ═══════════════════════════════════════════════════════════════════
   Звонилка — клиентская логика WebRTC
   ═══════════════════════════════════════════════════════════════════ */

'use strict';

const $ = (id) => document.getElementById(id);

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

  lowLatency: false,
  shareAudio: true,
  mirror: true,
  sinkId: '',

  makingOffer: false,
  ignoreOffer: false,
  settingRemoteAnswer: false,

  statsTimer: null,
  prev: null,
  quality: 0,
  qualityHold: 0,
  wakeLock: null,
  fingerprint: null,
  inCall: false,
};

const LADDER = [
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
  const bytes = crypto.getRandomValues(new Uint8Array(9));
  const s = [...bytes].map((b) => abc[b % abc.length]).join('');
  return `${s.slice(0, 3)}-${s.slice(3, 6)}-${s.slice(6, 9)}`;
}

const fmtKbps = (bps) =>
  bps >= 1_000_000 ? (bps / 1_000_000).toFixed(1) + ' Мбит/с' : Math.round(bps / 1000) + ' кбит/с';

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

const AUDIO_CONSTRAINTS = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
  channelCount: 1,
};

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
    { audio: AUDIO_CONSTRAINTS, video: videoConstraints(S.facing) },
    { audio: AUDIO_CONSTRAINTS, video: true },
    { audio: AUDIO_CONSTRAINTS, video: false },
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
  try { devices = await navigator.mediaDevices.enumerateDevices(); } catch { return; }

  fillSelect($('micSelect'), devices.filter((d) => d.kind === 'audioinput'), 'Микрофон');
  fillSelect($('camSelect'), devices.filter((d) => d.kind === 'videoinput'), 'Камера');

  const outputs = devices.filter((d) => d.kind === 'audiooutput');
  const canPick = typeof $('remoteAudio').setSinkId === 'function' && outputs.length > 0;
  $('spkField').hidden = !canPick;
  if (canPick) fillSelect($('spkSelect'), outputs, 'Устройство');

  // Текущие устройства отмечаем в списках
  const micId = S.local.mic?.getSettings().deviceId;
  const camId = S.local.cam?.getSettings().deviceId;
  if (micId) $('micSelect').value = micId;
  if (camId) $('camSelect').value = camId;
}

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
        ? { audio: { ...AUDIO_CONSTRAINTS, deviceId: { exact: deviceId } } }
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

async function setSink(deviceId) {
  S.sinkId = deviceId;
  prefs.set('sink', deviceId);
  for (const el of [$('remoteAudio'), $('remoteScreenAudio')]) {
    try { await el.setSinkId(deviceId); } catch {}
  }
  toast('Звук выводится на выбранное устройство', 1600);
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
  $('micBtn').style.setProperty('--lvl', level.toFixed(2));
  $('micBtn').style.setProperty('--lvlop', level > 0.04 ? '1' : '0');
}

function onSpeak(who, on) {
  const id = who === 'self' ? 'local-cam' : 'remote-cam';
  tileEl(id)?.classList.toggle('is-speaking', on);
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
  for (const el of [$('remoteAudio'), $('remoteScreenAudio')]) el.muted = !on;
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

async function startShare() {
  if (!navigator.mediaDevices?.getDisplayMedia) {
    return toast('Демонстрация экрана не поддерживается этим браузером');
  }
  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: 30, max: 30 } },
      audio: S.shareAudio
        ? { echoCancellation: false, noiseSuppression: false, autoGainControl: false }
        : false,
    });

    S.screenStream = stream;
    S.sharing = true;

    const video = stream.getVideoTracks()[0];
    const audio = stream.getAudioTracks()[0] || null;
    try { video.contentHint = 'detail'; } catch {}
    video.addEventListener('ended', stopShare);

    S.local.screen = video;
    S.local.screenAudio = audio;

    if (S.send.screen) await S.send.screen.replaceTrack(video);
    if (audio && S.send.screenAudio) await S.send.screenAudio.replaceTrack(audio);

    tileVideo('local-screen').srcObject = stream;
    await applySendParams();
    S.mainLocked = false;
    refreshUi();
    sendState();
    toast(audio ? 'Показываете экран со звуком' : 'Показываете экран');
  } catch {
    /* пользователь закрыл выбор окна */
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
   РАСКЛАДКА
   ═══════════════════════════════════════════════════════════════════ */

const TILE_LIVE = {
  'local-cam': () => !!S.camStream,
  'local-screen': () => S.sharing,
  'remote-cam': () => S.peerPresent,
  'remote-screen': () => S.peerPresent && S.remoteState.screen,
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
      (id === 'remote-cam' && !S.remoteState.cam);
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

  ws.addEventListener('message', (e) => {
    let m;
    try { m = JSON.parse(e.data); } catch { return; }
    handleSignal(m);
  });

  ws.addEventListener('close', () => {
    if (!S.inCall) return;
    S.wsRetry++;
    setStatus('connecting', 'Переподключение…');
    setTimeout(connectSignaling, Math.min(1000 * 2 ** S.wsRetry, 10000));
  });
}

function signal(data) {
  if (S.ws?.readyState === WebSocket.OPEN) S.ws.send(JSON.stringify({ type: 'signal', data }));
}

function sendState() {
  signal({
    state: {
      mic: S.micOn && !!S.local.mic,
      cam: (S.camOn && !!S.local.cam) || false,
      screen: S.sharing,
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

async function onRemoteSignal(data) {
  if (!data) return;

  if (data.state) {
    S.remoteState = { ...S.remoteState, ...data.state };
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
    await bindRoles();
  }

  pc.addEventListener('icecandidate', ({ candidate }) => {
    if (candidate) signal({ candidate });
  });

  pc.addEventListener('track', (e) => {
    const index = pc.getTransceivers().indexOf(e.transceiver);
    const role = ROLES[index];
    if (!role) return;

    const stream = new MediaStream([e.track]);
    S.remote[role] = stream;

    if (role === 'mic') {
      $('remoteAudio').srcObject = stream;
      $('remoteAudio').muted = !S.speakerOn;
      if (S.sinkId) $('remoteAudio').setSinkId?.(S.sinkId).catch(() => {});
      watchLevel('peer', stream, true);
    } else if (role === 'screenAudio') {
      $('remoteScreenAudio').srcObject = stream;
      $('remoteScreenAudio').muted = !S.speakerOn;
      if (S.sinkId) $('remoteScreenAudio').setSinkId?.(S.sinkId).catch(() => {});
    } else {
      const video = tileVideo(role === 'cam' ? 'remote-cam' : 'remote-screen');
      video.muted = true;
      video.srcObject = stream;
      video.play?.().catch(() => {});
    }

    applyLatency();
    refreshUi();
  });

  pc.addEventListener('iceconnectionstatechange', () => {
    if (pc.iceConnectionState === 'failed') {
      setStatus('bad', 'Восстановление связи…');
      try { pc.restartIce(); } catch {}
    }
  });

  pc.addEventListener('connectionstatechange', () => {
    switch (pc.connectionState) {
      case 'connected':
        setStatus('live', 'Соединение установлено');
        setInvite(false);
        applySendParams();
        applyLatency();
        sendState();
        break;
      case 'connecting': setStatus('connecting', 'Подключение…'); break;
      case 'disconnected': setStatus('bad', 'Связь нестабильна'); break;
      case 'failed': setStatus('bad', 'Связь потеряна'); break;
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
      maxBitrate: step.bitrate,
      maxFramerate: step.fps,
      scaleResolutionDownBy: 1,
      networkPriority: S.sharing ? 'low' : 'medium',
    },
    degradation: 'balanced',
  });

  await tune(S.send.screen, {
    encoding: { maxBitrate: 3_000_000, maxFramerate: 30, scaleResolutionDownBy: 1, networkPriority: 'high' },
    degradation: 'maintain-resolution', // текст должен оставаться читаемым
  });
}

/**
 * Буфер приёма — самая управляемая часть задержки. По умолчанию браузер
 * держит его побольше ради плавности; в режиме низкой задержки убираем.
 */
function applyLatency() {
  if (!S.pc) return;
  for (const r of S.pc.getReceivers()) {
    try { if ('jitterBufferTarget' in r) r.jitterBufferTarget = S.lowLatency ? 0 : null; } catch {}
    try { if ('playoutDelayHint' in r) r.playoutDelayHint = S.lowLatency ? 0 : undefined; } catch {}
  }
}

function onPeerLeft() {
  S.peerPresent = false;
  S.remoteState = { mic: true, cam: false, screen: false };
  for (const id of ['remote-cam', 'remote-screen']) tileVideo(id).srcObject = null;
  $('remoteAudio').srcObject = null;
  $('remoteScreenAudio').srcObject = null;
  meters.peer?.stop();
  delete meters.peer;

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
    width: 0, height: 0, fps: 0,
    codec: null, route: null, srtp: null, dtls: null,
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

    if (r.type === 'outbound-rtp' && !r.isRemote) acc.outBytes += r.bytesSent || 0;

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

  let inBps = 0, outBps = 0, lossPct = 0;
  if (S.prev) {
    const dt = (now - S.prev.t) / 1000;
    if (dt > 0.2) {
      inBps = Math.max(0, ((acc.inBytes - S.prev.in) * 8) / dt);
      outBps = Math.max(0, ((acc.outBytes - S.prev.out) * 8) / dt);
      const dLost = acc.packetsLost - S.prev.lost;
      const dRecv = acc.packetsRecv - S.prev.recv;
      if (dLost + dRecv > 0) lossPct = (dLost / (dLost + dRecv)) * 100;
    }
  }
  S.prev = { t: now, in: acc.inBytes, out: acc.outBytes, lost: acc.packetsLost, recv: acc.packetsRecv };

  renderPing(acc.rtt);
  adaptQuality(acc.rtt, lossPct);
  await renderSecurity(acc);
  renderStatsPanel(acc, inBps, outBps, lossPct);
}

function renderPing(rtt) {
  const el = $('pingText');
  if (rtt == null) { el.textContent = '— мс'; el.className = ''; return; }
  const ms = Math.round(rtt);
  el.textContent = ms + ' мс';
  el.className = ms < 80 ? 'is-good' : ms < 200 ? 'is-mid' : 'is-bad';
}

function adaptQuality(rtt, loss) {
  if (rtt == null) return;
  const bad = loss > 4 || rtt > 350;
  const good = loss < 1 && rtt < 180;

  if (bad && S.quality < LADDER.length - 1) {
    S.quality++; S.qualityHold = 0; applySendParams();
  } else if (good && S.quality > 0) {
    if (++S.qualityHold >= 12) { S.quality--; S.qualityHold = 0; applySendParams(); }
  } else {
    S.qualityHold = 0;
  }
}

async function renderSecurity(acc) {
  if (acc.dtls) $('lockText').textContent = 'Зашифровано';
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
  cells.push(`<div class="stat stat--wide"><span>Маршрут</span><b>${acc.route || '—'}</b></div>`);
  cells.push(`<div class="stat stat--wide"><span>Шифрование</span><b>${acc.srtp || acc.dtls || 'DTLS-SRTP'}</b></div>`);
  $('statsGrid').innerHTML = cells.join('');

  const parts = [`Отправка: <b>${LADDER[S.quality].label}</b>, подстраивается автоматически.`];
  if (acc.codec) parts.push(`Кодек: <b>${acc.codec}</b>.`);
  if (S.fingerprint) parts.push(`Код безопасности: <b>${S.fingerprint}</b> — должен совпадать у обоих.`);
  if (acc.rtt != null && acc.rtt > 150) {
    parts.push(
      acc.route === 'через TURN-сервер'
        ? 'Высокий пинг из-за ретранслятора: трафик идёт через TURN, а не напрямую.'
        : 'Высокий пинг задан маршрутом до собеседника. Помогают провод вместо Wi-Fi и отключение VPN.'
    );
  }
  $('statsNote').innerHTML = parts.join('<br>');
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
  toast(on ? 'Режим низкой задержки включён' : 'Обычный режим приёма', 1800);
});
bindSwitch('shareAudio', 'shareAudio');
bindSwitch('mirrorSelf', 'mirror', refreshUi);

/* ─────────────── Экраны ─────────────── */

async function enterCall(roomId) {
  S.roomId = roomId;
  S.inCall = true;
  S.fingerprint = null;

  history.replaceState({ room: roomId }, '', '/' + roomId);
  document.title = `Звонок ${roomId} · Звонилка`;

  $('remoteAvatar').textContent = roomId[0].toUpperCase();
  $('inviteLink').value = location.origin + '/' + roomId;
  $('shareBtn').hidden = !navigator.share;
  $('stageEmptyText').textContent = 'Ожидание собеседника…';
  setInvite(false);

  show('call');
  setStatus('connecting', 'Подключение…');

  await ensureMedia();
  S.sinkId = prefs.get('sink', '');
  if (S.sinkId) setSink(S.sinkId);
  refreshUi();
  connectSignaling();
  requestWakeLock();
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
  S.quality = 0;
  S.main = null;
  S.mainLocked = false;
  meters.peer?.stop();
  delete meters.peer;
  for (const id of ['remote-cam', 'remote-screen', 'local-screen']) tileVideo(id).srcObject = null;
  $('remoteAudio').srcObject = null;
  $('remoteScreenAudio').srcObject = null;
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

$('createBtn').addEventListener('click', () => enterCall(randomRoomId()));

$('joinForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const raw = $('roomInput').value.trim();
  const id = (raw.split('/').pop() || '').replace(/[^A-Za-z0-9_-]/g, '');
  if (id.length < 3) return toast('Введите код комнаты или ссылку');
  enterCall(id);
});

$('hangupBtn').addEventListener('click', () => endCall());
$('rejoinBtn').addEventListener('click', () => enterCall(S.roomId || randomRoomId()));
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
  e: () => endCall(),
  f: () => {
    const el = tileEl(S.main);
    if (!el) return;
    document.fullscreenElement ? document.exitFullscreen() : el.requestFullscreen?.().catch(() => {});
  },
};
// Раскладка не должна мешать: те же клавиши в кириллице
const RU = { ь: 'm', м: 'v', в: 'd', ф: 'a', ы: 's', л: 'k', у: 'e', а: 'f' };

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
  addEventListener(ev, () => { if (audioCtx?.state === 'suspended') audioCtx.resume().catch(() => {}); }, { passive: true });
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

/* Точка для отладки из консоли браузера */
window.__zv = S;

/* ─────────────── Старт ─────────────── */

(function boot() {
  const path = location.pathname.replace(/^\/|\/$/g, '');
  if (/^[A-Za-z0-9_-]{3,64}$/.test(path)) {
    $('roomInput').value = path;
    enterCall(path);
  } else {
    show('lobby');
    ensureMedia();
  }
})();
