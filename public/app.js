/* ═══════════════════════════════════════════════════════════════════
   Звонилка — клиентская логика WebRTC
   ═══════════════════════════════════════════════════════════════════ */

'use strict';

const $ = (id) => document.getElementById(id);

/* ─────────────── Состояние ─────────────── */

const S = {
  roomId: null,
  polite: false,
  peerId: null,
  peerPresent: false,

  ws: null,
  wsRetry: 0,
  pc: null,

  localStream: null,
  screenStream: null,
  camTrack: null,
  videoSender: null,

  micOn: true,
  camOn: true,
  sharing: false,
  facing: 'user',

  iceServers: [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }],

  // perfect negotiation
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

/* Ступени качества исходящего видео (битрейт, кадры) */
const LADDER = [
  { bitrate: 2_500_000, fps: 30, label: 'Высокое' },
  { bitrate: 1_200_000, fps: 30, label: 'Хорошее' },
  { bitrate: 600_000, fps: 25, label: 'Среднее' },
  { bitrate: 250_000, fps: 18, label: 'Экономное' },
];

/* ─────────────── Мелкие утилиты ─────────────── */

let toastTimer;
function toast(text, ms = 2600) {
  const el = $('toast');
  el.textContent = text;
  el.classList.add('is-on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('is-on'), ms);
}

function setInvite(visible) {
  $('invitePanel').hidden = !visible;
  $('call').classList.toggle('is-inviting', visible);
}

function show(screenId) {
  for (const el of document.querySelectorAll('.screen')) el.classList.remove('is-active');
  $(screenId).classList.add('is-active');
}

function randomRoomId() {
  const abc = 'abcdefghijkmnpqrstuvwxyz23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(9));
  const s = [...bytes].map((b) => abc[b % abc.length]).join('');
  return `${s.slice(0, 3)}-${s.slice(3, 6)}-${s.slice(6, 9)}`;
}

const fmtKbps = (bps) =>
  bps >= 1_000_000 ? (bps / 1_000_000).toFixed(1) + ' Мбит/с' : Math.round(bps / 1000) + ' кбит/с';

/* ─────────────── Тема ─────────────── */

(function initTheme() {
  const saved = localStorage.getItem('zv-theme');
  if (saved) document.documentElement.dataset.theme = saved;
})();

$('themeToggle').addEventListener('click', () => {
  const root = document.documentElement;
  const isDark =
    root.dataset.theme === 'dark' ||
    (!root.dataset.theme && matchMedia('(prefers-color-scheme: dark)').matches);
  root.dataset.theme = isDark ? 'light' : 'dark';
  try { localStorage.setItem('zv-theme', root.dataset.theme); } catch {}
});

/* ═══════════════════════════════════════════════════════════════════
   МЕДИА
   ═══════════════════════════════════════════════════════════════════ */

const AUDIO_CONSTRAINTS = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
  channelCount: 1,
  sampleRate: 48000,
};

function videoConstraints(facing) {
  return {
    width: { ideal: 1280 },
    height: { ideal: 720 },
    frameRate: { ideal: 30, max: 30 },
    facingMode: { ideal: facing },
  };
}

async function ensureMedia() {
  if (S.localStream) return S.localStream;

  if (!navigator.mediaDevices?.getUserMedia) {
    toast('Браузер не поддерживает доступ к камере. Нужен HTTPS или localhost.', 6000);
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
      attachLocalStream(stream);
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

function attachLocalStream(stream) {
  S.localStream = stream;
  S.camTrack = stream.getVideoTracks()[0] || null;

  if (S.camTrack) {
    try { S.camTrack.contentHint = 'motion'; } catch {}
    S.camTrack.enabled = S.camOn;
  }
  const a = stream.getAudioTracks()[0];
  if (a) {
    try { a.contentHint = 'speech'; } catch {}
    a.enabled = S.micOn;
  }

  $('previewVideo').srcObject = stream;
  $('localVideo').srcObject = stream;
  refreshMediaUi();
  startMeter(stream);
  listDevices();
}

/* Индикатор громкости в лобби */
let meterCtx, meterRaf;
function startMeter(stream) {
  const track = stream.getAudioTracks()[0];
  if (!track || meterCtx) return;
  try {
    meterCtx = new (window.AudioContext || window.webkitAudioContext)();
    const src = meterCtx.createMediaStreamSource(stream);
    const analyser = meterCtx.createAnalyser();
    analyser.fftSize = 512;
    analyser.smoothingTimeConstant = 0.75;
    src.connect(analyser);
    const buf = new Uint8Array(analyser.frequencyBinCount);
    const bar = $('previewMeter').firstElementChild;

    const loop = () => {
      analyser.getByteFrequencyData(buf);
      let sum = 0;
      for (const v of buf) sum += v * v;
      const level = Math.min(100, Math.sqrt(sum / buf.length) * 2.6);
      bar.style.width = (S.micOn ? level : 0) + '%';
      meterRaf = requestAnimationFrame(loop);
    };
    loop();
  } catch {}
}

async function listDevices() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    fill($('micSelect'), devices.filter((d) => d.kind === 'audioinput'), 'Микрофон');
    fill($('camSelect'), devices.filter((d) => d.kind === 'videoinput'), 'Камера');
    $('flipBtn').hidden = devices.filter((d) => d.kind === 'videoinput').length < 2;
  } catch {}
}

function fill(select, devices, fallback) {
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

/** Смена устройства без разрыва звонка — replaceTrack. */
async function switchDevice(kind, deviceId) {
  if (!S.localStream) return;
  try {
    const constraints =
      kind === 'audio'
        ? { audio: { ...AUDIO_CONSTRAINTS, deviceId: { exact: deviceId } } }
        : { video: { ...videoConstraints(S.facing), deviceId: { exact: deviceId } } };

    const fresh = await navigator.mediaDevices.getUserMedia(constraints);
    const newTrack = fresh.getTracks()[0];
    const oldTrack = S.localStream.getTracks().find((t) => t.kind === kind);

    newTrack.enabled = kind === 'audio' ? S.micOn : S.camOn;
    try { newTrack.contentHint = kind === 'audio' ? 'speech' : 'motion'; } catch {}

    if (kind === 'video') S.camTrack = newTrack;

    if (S.pc && !(kind === 'video' && S.sharing)) {
      const sender =
        kind === 'video'
          ? S.videoSender
          : S.pc.getSenders().find((s) => s.track && s.track.kind === 'audio');
      if (sender) await sender.replaceTrack(newTrack);
    }

    if (oldTrack) { S.localStream.removeTrack(oldTrack); oldTrack.stop(); }
    S.localStream.addTrack(newTrack);

    $('previewVideo').srcObject = S.localStream;
    if (!S.sharing) $('localVideo').srcObject = S.localStream;
  } catch {
    toast('Не удалось переключить устройство');
  }
}

$('micSelect').addEventListener('change', (e) => switchDevice('audio', e.target.value));
$('camSelect').addEventListener('change', (e) => switchDevice('video', e.target.value));

$('flipBtn').addEventListener('click', async () => {
  S.facing = S.facing === 'user' ? 'environment' : 'user';
  const cams = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput');
  const cur = S.camTrack?.getSettings().deviceId;
  const next = cams.find((d) => d.deviceId !== cur);
  if (next) switchDevice('video', next.deviceId);
});

/* ─────────────── Переключатели ─────────────── */

function setMic(on) {
  S.micOn = on;
  S.localStream?.getAudioTracks().forEach((t) => (t.enabled = on));
  refreshMediaUi();
  sendState();
}

function setCam(on) {
  S.camOn = on;
  if (!S.sharing) S.localStream?.getVideoTracks().forEach((t) => (t.enabled = on));
  refreshMediaUi();
  sendState();
}

function refreshMediaUi() {
  const hasVideo = !!S.localStream?.getVideoTracks().length;
  const camVisible = (S.camOn && hasVideo) || S.sharing;

  for (const id of ['micBtn', 'prevMicBtn']) $(id).setAttribute('aria-pressed', String(S.micOn));
  for (const id of ['camBtn', 'prevCamBtn']) $(id).setAttribute('aria-pressed', String(S.camOn && hasVideo));
  $('shareScreenBtn').setAttribute('aria-pressed', String(S.sharing));

  $('localTile').classList.toggle('is-off', !camVisible);
  $('localTile').classList.toggle('is-screen', S.sharing);
  document.querySelector('.preview').classList.toggle('is-live', camVisible);
  $('previewOffText').textContent = hasVideo ? 'Камера выключена' : 'Камера недоступна';
}

$('micBtn').addEventListener('click', () => setMic(!S.micOn));
$('camBtn').addEventListener('click', () => setCam(!S.camOn));
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
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });

    S.screenStream = stream;
    S.sharing = true;
    const track = stream.getVideoTracks()[0];
    try { track.contentHint = 'detail'; } catch {}
    track.addEventListener('ended', stopShare);

    if (S.videoSender) await S.videoSender.replaceTrack(track);

    $('localVideo').srcObject = stream;
    await applySendParams();
    refreshMediaUi();
    sendState();
    toast('Вы показываете экран');
  } catch {
    /* пользователь отменил выбор окна */
  }
}

async function stopShare() {
  if (!S.sharing) return;
  S.sharing = false;
  S.screenStream?.getTracks().forEach((t) => t.stop());
  S.screenStream = null;

  if (S.videoSender) await S.videoSender.replaceTrack(S.camTrack || null);
  if (S.camTrack) S.camTrack.enabled = S.camOn;

  $('localVideo').srcObject = S.localStream;
  await applySendParams();
  refreshMediaUi();
  sendState();
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
  if (S.ws?.readyState === WebSocket.OPEN) {
    S.ws.send(JSON.stringify({ type: 'signal', data }));
  }
}

function sendState() {
  signal({
    state: {
      mic: S.micOn,
      cam: (S.camOn && !!S.localStream?.getVideoTracks().length) || S.sharing,
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
      if (m.peers.length) { S.peerPresent = true; await startPeerConnection(); }
      else { setStatus('connecting', 'Ждём собеседника'); setInvite(true); }
      break;

    case 'peer-joined':
      S.peerPresent = true;
      setInvite(false);
      beep(660);
      await startPeerConnection();
      sendState();
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

  if (data.state) return applyRemoteState(data.state);
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

function applyRemoteState(state) {
  const off = !state.cam;
  $('remoteTile').classList.toggle('is-off', off);
  $('remoteTile').classList.toggle('is-cover', !state.screen);
  $('remoteOffText').textContent = 'Камера выключена';
  $('remoteTag').hidden = state.mic !== false;
}

/* ═══════════════════════════════════════════════════════════════════
   PEER CONNECTION
   ═══════════════════════════════════════════════════════════════════ */

/** Мягкая правка SDP: включаем FEC и DTX у Opus — меньше трафика, ровнее звук. */
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

/** Некоторые браузеры отвергают правленый SDP — тогда откатываемся к исходному. */
async function setLocalSafe(desc) {
  try {
    await S.pc.setLocalDescription(desc);
  } catch {
    await S.pc.setLocalDescription();
  }
}

async function startPeerConnection() {
  if (S.pc) return S.pc;

  const pc = new RTCPeerConnection({
    iceServers: S.iceServers,
    bundlePolicy: 'max-bundle',
    rtcpMuxPolicy: 'require',
    iceCandidatePoolSize: 2,
  });
  S.pc = pc;

  // Порядок трансиверов фиксируем сразу: сначала аудио, потом видео.
  const audio = S.localStream?.getAudioTracks()[0];
  const video = S.sharing
    ? S.screenStream?.getVideoTracks()[0]
    : S.localStream?.getVideoTracks()[0];

  if (audio) pc.addTransceiver(audio, { direction: 'sendrecv', streams: [S.localStream] });
  else pc.addTransceiver('audio', { direction: 'recvonly' });

  const vt = video
    ? pc.addTransceiver(video, { direction: 'sendrecv', streams: [S.localStream] })
    : pc.addTransceiver('video', { direction: 'recvonly' });
  S.videoSender = vt.sender;

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

  pc.addEventListener('icecandidate', ({ candidate }) => {
    if (candidate) signal({ candidate });
  });

  pc.addEventListener('track', (e) => {
    const [stream] = e.streams;
    const el = $('remoteVideo');
    if (el.srcObject !== stream) el.srcObject = stream;
    $('remoteTile').classList.remove('is-off');
    el.play?.().catch(() => {});
    // Небольшой буфер приёма выравнивает звук на нестабильной сети.
    try { if ('jitterBufferTarget' in e.receiver) e.receiver.jitterBufferTarget = 60; } catch {}
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
        sendState();
        break;
      case 'connecting':
        setStatus('connecting', 'Подключение…');
        break;
      case 'disconnected':
        setStatus('bad', 'Связь нестабильна');
        break;
      case 'failed':
        setStatus('bad', 'Связь потеряна');
        break;
    }
  });

  startStats();
  return pc;
}

/** Ограничение исходящего потока — главный рычаг оптимизации. */
async function applySendParams() {
  const sender = S.videoSender;
  if (!sender || !sender.track) return;
  try {
    const p = sender.getParameters();
    if (!p.encodings || !p.encodings.length) p.encodings = [{}];

    if (S.sharing) {
      p.encodings[0].maxBitrate = 3_000_000;
      p.encodings[0].maxFramerate = 30;
      p.encodings[0].scaleResolutionDownBy = 1;
      p.degradationPreference = 'maintain-resolution'; // текст должен оставаться читаемым
    } else {
      const step = LADDER[S.quality];
      p.encodings[0].maxBitrate = step.bitrate;
      p.encodings[0].maxFramerate = step.fps;
      p.encodings[0].scaleResolutionDownBy = 1;
      p.degradationPreference = 'balanced';
    }
    await sender.setParameters(p);
  } catch {}
}

function onPeerLeft() {
  S.peerPresent = false;
  $('remoteVideo').srcObject = null;
  $('remoteTile').classList.add('is-off');
  $('remoteOffText').textContent = 'Собеседник вышел';
  $('remoteTag').hidden = true;
  setInvite(true);
  setStatus('connecting', 'Ждём собеседника');

  S.pc?.close();
  S.pc = null;
  S.videoSender = null;
  S.prev = null;
  stopStats();
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
    rtt: null, jitter: null, loss: null,
    inVideo: 0, inAudio: 0, out: 0,
    width: 0, height: 0, fps: 0,
    codec: null, route: null,
    dtls: null, srtp: null,
    localFp: null, remoteFp: null,
    packetsLost: 0, packetsRecv: 0,
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
            ? 'Через TURN-сервер'
            : local.candidateType === 'host' && remote.candidateType === 'host'
            ? 'Прямое (локальная сеть)'
            : 'Прямое P2P';
      }
    }

    if (r.type === 'remote-inbound-rtp' && acc.rtt == null && r.roundTripTime != null) {
      acc.rtt = r.roundTripTime * 1000;
    }

    if (r.type === 'inbound-rtp' && !r.isRemote) {
      acc.packetsLost += r.packetsLost || 0;
      acc.packetsRecv += r.packetsReceived || 0;
      if (r.jitter != null) acc.jitter = Math.max(acc.jitter ?? 0, r.jitter * 1000);
      if (r.kind === 'video') {
        acc.inVideo += r.bytesReceived || 0;
        acc.width = r.frameWidth || acc.width;
        acc.height = r.frameHeight || acc.height;
        acc.fps = r.framesPerSecond || acc.fps;
        const c = byId.get(r.codecId);
        if (c?.mimeType) acc.codec = c.mimeType.split('/')[1].toUpperCase();
      } else {
        acc.inAudio += r.bytesReceived || 0;
      }
    }

    if (r.type === 'outbound-rtp' && !r.isRemote) acc.out += r.bytesSent || 0;

    if (r.type === 'transport') {
      acc.dtls = r.dtlsCipher || acc.dtls;
      acc.srtp = r.srtpCipher || acc.srtp;
      const lc = byId.get(r.localCertificateId);
      const rc = byId.get(r.remoteCertificateId);
      if (lc?.fingerprint) acc.localFp = lc.fingerprint;
      if (rc?.fingerprint) acc.remoteFp = rc.fingerprint;
    }
  });

  // Скорости
  let inBps = 0, outBps = 0, lossPct = 0;
  if (S.prev) {
    const dt = (now - S.prev.t) / 1000;
    if (dt > 0.2) {
      inBps = Math.max(0, ((acc.inVideo + acc.inAudio - S.prev.in) * 8) / dt);
      outBps = Math.max(0, ((acc.out - S.prev.out) * 8) / dt);
      const dLost = acc.packetsLost - S.prev.lost;
      const dRecv = acc.packetsRecv - S.prev.recv;
      if (dLost + dRecv > 0) lossPct = (dLost / (dLost + dRecv)) * 100;
    }
  }
  S.prev = {
    t: now,
    in: acc.inVideo + acc.inAudio,
    out: acc.out,
    lost: acc.packetsLost,
    recv: acc.packetsRecv,
  };

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

/** Плавная адаптация: падаем быстро, поднимаемся осторожно. */
function adaptQuality(rtt, loss) {
  if (S.sharing || rtt == null) return;
  const bad = loss > 4 || rtt > 350;
  const good = loss < 1 && rtt < 180;

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

/** Короткий код безопасности из отпечатков сертификатов обеих сторон. */
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
  ['Потери', (d) => d.loss.toFixed(1) + ' %'],
  ['Приём', (d) => fmtKbps(d.inBps)],
  ['Отдача', (d) => fmtKbps(d.outBps)],
  ['Разрешение', (d) => (d.width ? `${d.width}×${d.height}` : '—')],
  ['Кадры', (d) => (d.fps ? Math.round(d.fps) + ' к/с' : '—')],
  ['Джиттер', (d) => (d.jitter == null ? '—' : Math.round(d.jitter) + ' мс')],
  ['Кодек', (d) => d.codec || '—'],
];

function renderStatsPanel(acc, inBps, outBps, loss) {
  if ($('statsPanel').hidden) return;
  const d = { ...acc, inBps, outBps, loss };

  const cells = STAT_ROWS.map(([label, fn]) => `<div class="stat"><span>${label}</span><b>${fn(d)}</b></div>`);
  cells.push(`<div class="stat stat--wide"><span>Маршрут</span><b>${acc.route || '—'}</b></div>`);
  cells.push(
    `<div class="stat stat--wide"><span>Шифрование</span><b>${acc.srtp || acc.dtls || 'DTLS-SRTP'}</b></div>`
  );
  $('statsGrid').innerHTML = cells.join('');

  const mode = S.sharing ? 'демонстрация экрана' : LADDER[S.quality].label.toLowerCase();
  $('statsNote').innerHTML =
    `Режим отправки: <b>${mode}</b> — качество подстраивается под канал автоматически.` +
    (S.fingerprint
      ? `<br>Код безопасности: <b>${S.fingerprint}</b> — он должен совпадать у обоих собеседников.`
      : '');
}

/* ═══════════════════════════════════════════════════════════════════
   ЭКРАНЫ И НАВИГАЦИЯ
   ═══════════════════════════════════════════════════════════════════ */

async function enterCall(roomId) {
  S.roomId = roomId;
  S.inCall = true;
  S.fingerprint = null;

  history.replaceState({ room: roomId }, '', '/' + roomId);
  document.title = `Звонок ${roomId} · Звонилка`;

  $('remoteAvatar').textContent = roomId[0].toUpperCase();
  $('inviteLink').value = location.origin + '/' + roomId;
  $('shareBtn').hidden = !navigator.share;
  setInvite(false);
  $('remoteTile').classList.add('is-off', 'is-cover');
  $('remoteOffText').textContent = 'Ожидание собеседника…';
  $('remoteTag').hidden = true;

  show('call');
  setStatus('connecting', 'Подключение…');

  await ensureMedia();
  refreshMediaUi();
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
  S.videoSender = null;
  S.screenStream?.getTracks().forEach((t) => t.stop());
  S.screenStream = null;
  S.sharing = false;
  S.prev = null;
  S.quality = 0;
  $('remoteVideo').srcObject = null;
  releaseWakeLock();

  $('endedTitle').textContent = title;
  $('endedText').textContent = text;
  show('ended');
  document.title = 'Звонилка — зашифрованные звонки в браузере';
}

function goHome() {
  history.replaceState({}, '', '/');
  $('previewVideo').srcObject = S.localStream;
  refreshMediaUi();
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

/* Статистика */
const toggleStats = () => {
  const panel = $('statsPanel');
  panel.hidden = !panel.hidden;
  $('statsBtn').setAttribute('aria-pressed', String(!panel.hidden));
};
$('statsBtn').addEventListener('click', toggleStats);
$('pingPill').addEventListener('click', toggleStats);
$('statsClose').addEventListener('click', toggleStats);

/* ─────────────── Горячие клавиши ─────────────── */

addEventListener('keydown', (e) => {
  if (!S.inCall || e.metaKey || e.ctrlKey || e.altKey) return;
  if (/^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement?.tagName)) return;
  const k = e.key.toLowerCase();
  if (k === 'm' || k === 'ь') { setMic(!S.micOn); toast(S.micOn ? 'Микрофон включён' : 'Микрофон выключен', 1200); }
  else if (k === 'v' || k === 'м') { setCam(!S.camOn); toast(S.camOn ? 'Камера включена' : 'Камера выключена', 1200); }
  else if (k === 'd' || k === 'в') { S.sharing ? stopShare() : startShare(); }
  else if (k === 's' || k === 'ы') { toggleStats(); }
  else if (k === 'e') { endCall(); }
});

/* ─────────────── Экономия ресурсов ─────────────── */

// Пока вкладка скрыта, нет смысла слать видео в полном качестве.
document.addEventListener('visibilitychange', () => {
  if (!S.pc || S.sharing) return;
  const sender = S.videoSender;
  if (!sender || !sender.track) return;
  try {
    const p = sender.getParameters();
    if (!p.encodings?.length) return;
    p.encodings[0].maxBitrate = document.hidden ? 150_000 : LADDER[S.quality].bitrate;
    p.encodings[0].maxFramerate = document.hidden ? 8 : LADDER[S.quality].fps;
    sender.setParameters(p);
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

/* Короткий сигнал при входе и выходе собеседника */
function beep(freq) {
  try {
    const ctx = meterCtx || new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = freq;
    osc.type = 'sine';
    gain.gain.setValueAtTime(0.0001, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.07, ctx.currentTime + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.25);
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.26);
  } catch {}
}

/* ─────────────── Старт ─────────────── */

(function boot() {
  const path = location.pathname.replace(/^\/|\/$/g, '');
  if (/^[A-Za-z0-9_-]{3,64}$/.test(path)) {
    $('roomInput').value = path;
    enterCall(path);
  } else {
    show('lobby');
    // Заранее просим доступ — так пользователь видит себя ещё до звонка.
    ensureMedia();
  }
})();
