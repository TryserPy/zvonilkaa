/* ═══════════════════════════════════════════════════════════════════
   Звонилка — обработка изображения с камеры
   ═══════════════════════════════════════════════════════════════════

   Честно про возможности. Отделить человека от фона по контуру умеет
   только нейросеть, а тащить её в проект без зависимостей некуда. Поэтому:

   1. Если браузер умеет размывать фон сам (Windows Studio Effects,
      ChromeOS) — отдаём работу ему: качество идеальное, нагрузки нет.
   2. Иначе включается портретный режим: резким остаётся мягкий овал
      вокруг вас, всё за его границей размывается или заменяется. Овал
      сам подтягивается туда, где в кадре движение, — то есть к вам.

   Второй режим не притворяется вырезанием по контуру: он выглядит как
   осознанная виньетка и решает главную задачу — скрыть комнату.
*/

'use strict';

(function () {
  const state = {
    raw: null,        // исходная дорожка камеры
    video: null,
    out: null,        // холст с результатом
    person: null,     // слой с резким изображением
    probe: null,      // уменьшенная копия для поиска движения
    stream: null,
    timer: 0,
    mode: 'off',      // off | blur | image
    image: null,      // HTMLImageElement для замены фона
    strength: 14,
    fps: 24,
    center: { x: 0.5, y: 0.46 },
    prevProbe: null,
    running: false,
  };

  const clamp = (v, min, max) => Math.min(max, Math.max(min, v));

  /* ── Аппаратное размытие ─────────────────────────────────────────── */

  function nativeSupported() {
    try {
      return !!navigator.mediaDevices?.getSupportedConstraints?.().backgroundBlur;
    } catch {
      return false;
    }
  }

  async function applyNative(track, on) {
    if (!track || !nativeSupported()) return false;
    try {
      await track.applyConstraints({ backgroundBlur: on });
      return track.getSettings().backgroundBlur === on;
    } catch {
      return false;
    }
  }

  /* ── Портретный режим ────────────────────────────────────────────── */

  function ensureCanvases(width, height) {
    if (!state.out) {
      state.out = document.createElement('canvas');
      state.person = document.createElement('canvas');
      state.probe = document.createElement('canvas');
      state.probe.width = 48;
      state.probe.height = 27;
    }
    if (state.out.width !== width || state.out.height !== height) {
      state.out.width = state.person.width = width;
      state.out.height = state.person.height = height;
    }
  }

  /**
   * Ищет, где в кадре шевелится: сравнивает уменьшенные копии соседних
   * кадров и берёт центр тяжести изменений. Человек почти всегда
   * единственное, что двигается, поэтому овал держится за него.
   */
  function trackMotion(source) {
    const ctx = state.probe.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(source, 0, 0, state.probe.width, state.probe.height);
    const frame = ctx.getImageData(0, 0, state.probe.width, state.probe.height).data;

    if (!state.prevProbe) {
      state.prevProbe = new Uint8ClampedArray(frame);
      return;
    }

    let sumX = 0;
    let sumY = 0;
    let weight = 0;
    for (let i = 0, p = 0; i < frame.length; i += 4, p++) {
      const diff =
        Math.abs(frame[i] - state.prevProbe[i]) +
        Math.abs(frame[i + 1] - state.prevProbe[i + 1]) +
        Math.abs(frame[i + 2] - state.prevProbe[i + 2]);
      if (diff > 40) {
        sumX += (p % state.probe.width) * diff;
        sumY += Math.floor(p / state.probe.width) * diff;
        weight += diff;
      }
    }
    state.prevProbe.set(frame);
    if (weight < 2000) return; // почти статичный кадр — овал не дёргаем

    const x = sumX / weight / state.probe.width;
    const y = sumY / weight / state.probe.height;
    // Плавное следование, чтобы овал не прыгал за каждым взмахом руки
    state.center.x += (clamp(x, 0.25, 0.75) - state.center.x) * 0.05;
    state.center.y += (clamp(y, 0.3, 0.6) - state.center.y) * 0.03;
  }

  function drawMask(ctx, width, height) {
    const cx = state.center.x * width;
    const cy = state.center.y * height;
    const rx = width * 0.34;
    const ry = height * 0.62;

    ctx.save();
    ctx.globalCompositeOperation = 'destination-in';
    ctx.translate(cx, cy);
    ctx.scale(rx / ry, 1);
    const gradient = ctx.createRadialGradient(0, 0, ry * 0.55, 0, 0, ry);
    gradient.addColorStop(0, 'rgba(0,0,0,1)');
    gradient.addColorStop(0.75, 'rgba(0,0,0,0.92)');
    gradient.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = gradient;
    ctx.fillRect(-ry * 2, -ry * 2, ry * 4, ry * 4);
    ctx.restore();
  }

  function drawBackground(ctx, width, height) {
    if (state.mode === 'image' && state.image?.complete && state.image.naturalWidth) {
      // Вписываем картинку «по накрытию», чтобы не было полей
      const scale = Math.max(width / state.image.naturalWidth, height / state.image.naturalHeight);
      const w = state.image.naturalWidth * scale;
      const h = state.image.naturalHeight * scale;
      ctx.drawImage(state.image, (width - w) / 2, (height - h) / 2, w, h);
      return;
    }
    // Размытие: слегка увеличиваем кадр, иначе по краям лезет прозрачная кайма
    ctx.save();
    ctx.filter = `blur(${state.strength}px)`;
    const grow = 1 + state.strength / 90;
    const w = width * grow;
    const h = height * grow;
    ctx.drawImage(state.video, (width - w) / 2, (height - h) / 2, w, h);
    ctx.restore();
  }

  function renderFrame() {
    const video = state.video;
    if (!video || video.readyState < 2) return;

    const width = state.out.width;
    const height = state.out.height;
    const outCtx = state.out.getContext('2d');
    const personCtx = state.person.getContext('2d');

    trackMotion(video);
    drawBackground(outCtx, width, height);

    personCtx.clearRect(0, 0, width, height);
    personCtx.drawImage(video, 0, 0, width, height);
    drawMask(personCtx, width, height);

    outCtx.drawImage(state.person, 0, 0);
  }

  function loop() {
    if (!state.running) return;
    renderFrame();
    state.timer = setTimeout(() => requestAnimationFrame(loop), 1000 / state.fps);
  }

  /* ── Публичный интерфейс ─────────────────────────────────────────── */

  const Effects = {
    nativeSupported,
    applyNative,

    get active() {
      return state.running;
    },

    get mode() {
      return state.mode;
    },

    setStrength(px) {
      state.strength = clamp(Number(px) || 14, 4, 30);
    },

    setImage(img) {
      state.image = img;
    },

    setMode(mode) {
      state.mode = mode;
    },

    /**
     * Оборачивает дорожку камеры и возвращает обработанную.
     * Исходная продолжает жить: её отдадим обратно при выключении.
     */
    async start(track, mode) {
      if (!track) return null;
      state.mode = mode;

      const settings = track.getSettings();
      // На слабых устройствах считаем в меньшем разрешении — иначе видео
      // начнёт подтормаживать сильнее, чем помогает эффект
      const weak = navigator.hardwareConcurrency && navigator.hardwareConcurrency <= 4;
      const maxW = weak ? 640 : 960;
      const width = Math.min(settings.width || 1280, maxW);
      const height = Math.round(width * ((settings.height || 720) / (settings.width || 1280)));

      state.fps = weak ? 18 : 24;
      ensureCanvases(width, height);

      if (!state.video) {
        state.video = document.createElement('video');
        state.video.muted = true;
        state.video.playsInline = true;
      }
      state.raw = track;
      state.video.srcObject = new MediaStream([track]);
      await state.video.play().catch(() => {});

      state.prevProbe = null;
      state.running = true;
      loop();

      state.stream = state.out.captureStream(state.fps);
      const processed = state.stream.getVideoTracks()[0];
      try { processed.contentHint = 'motion'; } catch {}
      return processed;
    },

    /** Останавливает обработку и возвращает исходную дорожку камеры. */
    stop() {
      state.running = false;
      clearTimeout(state.timer);
      state.stream?.getTracks().forEach((t) => t.stop());
      state.stream = null;
      if (state.video) state.video.srcObject = null;
      state.mode = 'off';
      const raw = state.raw;
      state.raw = null;
      return raw;
    },
  };

  window.Effects = Effects;
})();
