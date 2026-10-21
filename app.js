/* =========================================================
   ArcadeBox v0.8 — логика приложения, настройки, звук
   + игры «Змейка» и «2048»
   ========================================================= */

(function () {
  'use strict';

  var GAMES = [
    { id: 'snake',     title: 'Змейка',            description: 'Классическая змейка. Собирай еду и расти.',        icon: '🐍', status: 'available', screenId: 'screen-snake' },
    { id: '2048',      title: '2048',               description: 'Собирай плитки и достигни 2048.',                  icon: '🔢', status: 'available', screenId: 'screen-2048' },
    { id: 'space',     title: 'Космический полёт',  description: 'Уворачивайся от астероидов в космосе.',            icon: '🚀', status: 'soon', screenId: null },
    { id: 'tictactoe', title: 'Крестики-нолики',    description: 'Сыграй партию против друга или ИИ.',               icon: '⭕', status: 'soon', screenId: null },
    { id: 'reaction',  title: 'Реакция',            description: 'Проверь скорость своей реакции.',                  icon: '⚡', status: 'soon', screenId: null }
  ];

  var currentScreenId = 'screen-home';
  var snakeGame = null;
  var game2048 = null;
  var pendingUpdate = false;
  var RELOAD_GUARD_KEY = 'arcadebox.updateReloadAt';

  /* =========================================================
     ХРАНИЛИЩЕ РЕКОРДОВ (общая система)
     ========================================================= */
  var SCORES_STORAGE_KEY = 'arcadebox.scores';

  function readAllScores() {
    try {
      var raw = localStorage.getItem(SCORES_STORAGE_KEY);
      if (!raw) return {};
      var parsed = JSON.parse(raw);
      return (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : {};
    } catch (e) { return {}; }
  }

  function writeAllScores(data) {
    try { localStorage.setItem(SCORES_STORAGE_KEY, JSON.stringify(data)); }
    catch (e) {}
  }

  function getGameBest(gameId) {
    var entry = readAllScores()[gameId];
    var n = entry ? parseInt(entry.best, 10) : NaN;
    return (isFinite(n) && n > 0) ? n : 0;
  }

  /* Полная запись рекорда (для экрана рекордов): null, если рекорда нет */
  function getGameRecord(gameId) {
    var entry = readAllScores()[gameId];
    if (!entry || typeof entry !== 'object') return null;
    var best = parseInt(entry.best, 10);
    if (!isFinite(best) || best <= 0) return null;
    var updated = parseInt(entry.updated, 10);
    return { best: best, updated: isFinite(updated) ? updated : 0 };
  }

  function saveGameBest(gameId, score) {
    var all = readAllScores();
    var entry = all[gameId] || {};
    var current = parseInt(entry.best, 10);
    if (!isFinite(current) || current < 0) current = 0;
    if (score > current) {
      all[gameId] = { best: score, updated: Date.now() };
      writeAllScores(all);
      return true;
    }
    return false;
  }

  function formatDate(ts) {
    if (!ts) return '';
    try {
      var d = new Date(ts);
      if (isNaN(d.getTime())) return '';
      return d.toLocaleDateString('ru-RU');
    } catch (e) { return ''; }
  }

  /* ---------- Экран рекордов ---------- */
  function renderRecords() {
    var list = document.getElementById('records-list');
    if (!list) return;

    var playable = [];
    for (var i = 0; i < GAMES.length; i++) {
      if (GAMES[i].status === 'available') playable.push(GAMES[i]);
    }

    var rows = '';
    var hasAny = false;

    for (var j = 0; j < playable.length; j++) {
      var g = playable[j];
      var rec = getGameRecord(g.id);
      if (rec) hasAny = true;

      var valueHtml;
      var dateHtml;
      if (rec) {
        valueHtml = '<span class="record-value">' + rec.best + '</span>';
        dateHtml = rec.updated ? '<span class="record-date">от ' + formatDate(rec.updated) + '</span>' : '';
      } else {
        valueHtml = '<span class="record-value is-empty">ещё не установлен</span>';
        dateHtml = '';
      }

      rows +=
        '<div class="record-row">' +
          '<span class="record-icon" aria-hidden="true">' + g.icon + '</span>' +
          '<span class="record-body">' +
            '<span class="record-name">' + g.title + '</span>' +
            dateHtml +
          '</span>' +
          valueHtml +
        '</div>';
    }

    if (!hasAny) {
      list.innerHTML =
        '<div class="records-empty">' +
          '<div class="records-empty-icon" aria-hidden="true">🏆</div>' +
          '<h3>Рекорды пока не установлены</h3>' +
          '<p>Сыграй партию в «Змейку» или 2048 — и лучший результат появится здесь.</p>' +
          '<button class="btn btn-primary" data-action="show-games">К играм</button>' +
        '</div>';
      return;
    }

    list.innerHTML = rows;
  }


  /* =========================================================
     ЗВУКОВАЯ СИСТЕМА (Web Audio API, без файлов и библиотек)
     ---------------------------------------------------------
     • AudioContext создаётся и «просыпается» только после жеста
       пользователя (требование мобильных браузеров).
     • Эффекты синтезируются на лету; громкость и включение берутся
       из настроек (ArcadeAudio.configure).
     • Музыка (v0.8): плейлист из трёх MP3 в ./audio/, по кругу,
       с плавным кроссфейдом между треками; отдельная шина
       громкости; короткое «приглушение» музыки на важных
       игровых звуках, чтобы эффекты не тонули.
     ========================================================= */
  var ArcadeAudio = (function () {
    var AudioCtx = window.AudioContext || window.webkitAudioContext;

    var ctx = null, sfxBus = null, musicBus = null;
    var cfg = { sfxEnabled: true, sfxVolume: 70, musicEnabled: false, musicVolume: 50 };
    var lastGestureAt = 0, gestureSeen = false, primed = false, bound = false;
    var lastPlayed = {};

    /* Плейлист фоновой музыки: порядок = порядок воспроизведения (по кругу).
       Файлы лежат в ./audio/ и обязательно перечислены в AUDIO_ASSETS в sw.js —
       иначе музыка не заработает офлайн. gain — запас для выравнивания громкости
       треков (замер: -14,2 / -13,7 / -14,6 LUFS, разница меньше 1 LU, поэтому 1). */
    var PLAYLIST = [
      { id: 'pixel-rush',  url: './audio/pixel-rush.mp3',  gain: 1 },
      { id: 'neon-pixels', url: './audio/neon-pixels.mp3', gain: 1 },
      { id: 'arcade-core', url: './audio/arcade-core.mp3', gain: 1 }
    ];
    var CROSSFADE_SEC = 4;    // длительность перехода между треками
    var MUSIC_MASTER = 0.5;   // общий запас: музыка записана громко (≈ -14 LUFS), эффекты тише
    var trackFailed = [];     // треки, которые не удалось загрузить
    var trackIndex = 0;       // текущий трек
    var slots = null;         // два <audio>-слота (создаются при первом запуске музыки)
    var activeSlot = 0, fading = false;
    var duckBus = null, musicListener = null;

    /* Перцептивная кривая: 50% ползунка ≈ 25% амплитуды */
    function volumeToGain(v) {
      v = Math.max(0, Math.min(100, v)) / 100;
      return v * v;
    }
    function sfxGainValue()   { return cfg.sfxEnabled   ? volumeToGain(cfg.sfxVolume)   : 0; }
    function musicGainValue() { return cfg.musicEnabled ? volumeToGain(cfg.musicVolume) * MUSIC_MASTER : 0; }

    function applyGains(immediate) {
      if (!ctx || !sfxBus || !musicBus) return;
      var t = ctx.currentTime;
      if (immediate) {
        sfxBus.gain.value = sfxGainValue();
        musicBus.gain.value = musicGainValue();
      } else {
        sfxBus.gain.setTargetAtTime(sfxGainValue(), t, 0.02);
        musicBus.gain.setTargetAtTime(musicGainValue(), t, 0.05);
      }
    }

    function ensureContext() {
      if (!AudioCtx) return null;
      if (ctx) return ctx;
      try { ctx = new AudioCtx(); } catch (e) { ctx = null; return null; }
      try {
        sfxBus = ctx.createGain();
        musicBus = ctx.createGain();
        var comp = ctx.createDynamicsCompressor();
        comp.threshold.value = -16; comp.knee.value = 24; comp.ratio.value = 6;
        comp.attack.value = 0.003; comp.release.value = 0.2;
        sfxBus.connect(comp);
        comp.connect(ctx.destination);
        musicBus.connect(ctx.destination);
        applyGains(true);
      } catch (e) { ctx = null; return null; }
      return ctx;
    }

    function resumeIfNeeded() {
      if (!ctx || ctx.state === 'running' || !ctx.resume) return;
      try {
        var p = ctx.resume();
        if (p && p.catch) p.catch(function () {});
      } catch (e) {}
    }

    /* ---------- Разблокировка по жесту ---------- */
    function onGesture() {
      lastGestureAt = Date.now();
      gestureSeen = true;
      var c = ensureContext();
      if (!c) return;
      resumeIfNeeded();
      if (!primed) {
        primed = true;
        try { /* тихий «прайм» для iOS Safari */
          var b = c.createBuffer(1, 1, 22050);
          var src = c.createBufferSource();
          src.buffer = b; src.connect(c.destination); src.start(0);
        } catch (e) {}
      }
      syncMusic();
    }

    function onVisibility() {
      if (!ctx) return;
      if (document.hidden) {
        stopMusic();
        try { if (ctx.state === 'running' && ctx.suspend) ctx.suspend(); } catch (e) {}
      } else {
        resumeIfNeeded();
        syncMusic();
      }
    }

    function init() {
      if (bound) return;
      bound = true;
      var evts = ['touchend', 'pointerup', 'click', 'keydown'];
      for (var i = 0; i < evts.length; i++) {
        document.addEventListener(evts[i], onGesture, { capture: true, passive: true });
      }
      document.addEventListener('visibilitychange', onVisibility);
    }

    /* ---------- Синтез ---------- */
    /* o: type, f, f2 (конечная частота), t (старт), d (длительность),
          g (пиковая громкость), a (атака), lp (срез фильтра, Гц) */
    function tone(c, dest, o) {
      var osc = c.createOscillator();
      var gain = c.createGain();
      var node = osc;
      osc.type = o.type || 'sine';
      osc.frequency.setValueAtTime(o.f, o.t);
      if (o.f2 && o.f2 !== o.f) osc.frequency.exponentialRampToValueAtTime(o.f2, o.t + o.d);
      var a = o.a || 0.006, peak = o.g || 0.15;
      gain.gain.setValueAtTime(0.0001, o.t);
      gain.gain.linearRampToValueAtTime(peak, o.t + a);
      gain.gain.exponentialRampToValueAtTime(0.0001, o.t + o.d);
      if (o.lp) {
        var f = c.createBiquadFilter();
        f.type = 'lowpass'; f.frequency.value = o.lp;
        node.connect(f); node = f;
      }
      node.connect(gain);
      gain.connect(dest);
      osc.onended = function () { try { gain.disconnect(); } catch (e) {} };
      osc.start(o.t);
      osc.stop(o.t + o.d + 0.03);
    }

    function seq(c, dest, t, notes, base) {
      /* notes: [[частота, смещение, длительность], ...] */
      for (var i = 0; i < notes.length; i++) {
        var n = notes[i];
        tone(c, dest, {
          type: base.type, f: n[0], f2: n[3], t: t + n[1], d: n[2],
          g: base.g, lp: base.lp, a: base.a
        });
      }
    }

    /* gap — минимальный интервал между повторами (мс) */
    var SOUNDS = {
      /* --- интерфейс: мягкие короткие электронные --- */
      uiTap: { gap: 35, play: function (c, d, t) {
        tone(c, d, { type: 'sine', f: 760, f2: 620, t: t, d: 0.06, g: 0.16, lp: 3200 });
      } },
      uiBack: { gap: 35, play: function (c, d, t) {
        tone(c, d, { type: 'sine', f: 520, f2: 400, t: t, d: 0.07, g: 0.15, lp: 2600 });
      } },
      uiToggleOn: { gap: 60, play: function (c, d, t) {
        seq(c, d, t, [[560, 0, 0.06], [840, 0.06, 0.1]], { type: 'sine', g: 0.15, lp: 3400 });
      } },
      uiToggleOff: { gap: 60, play: function (c, d, t) {
        seq(c, d, t, [[700, 0, 0.06], [460, 0.06, 0.1]], { type: 'sine', g: 0.14, lp: 3000 });
      } },
      uiConfirm: { gap: 120, play: function (c, d, t) {
        seq(c, d, t, [[523, 0, 0.08], [659, 0.07, 0.08], [784, 0.14, 0.14]], { type: 'sine', g: 0.14, lp: 3600 });
      } },

      /* --- игры: ретро-аркада --- */
      gameStart: { gap: 300, duck: 0.5, play: function (c, d, t) {
        seq(c, d, t, [[262, 0, 0.08], [330, 0.08, 0.08], [392, 0.16, 0.08], [523, 0.24, 0.18]],
          { type: 'square', g: 0.07, lp: 2400 });
      } },
      snakeTurn: { gap: 70, play: function (c, d, t) {
        tone(c, d, { type: 'square', f: 300, f2: 240, t: t, d: 0.03, g: 0.035, lp: 1800 });
      } },
      snakeEat: { gap: 40, play: function (c, d, t) {
        seq(c, d, t, [[520, 0, 0.07, 780], [780, 0.06, 0.09, 1040]], { type: 'square', g: 0.08, lp: 2800 });
      } },
      gameOver: { gap: 400, duck: 0.7, play: function (c, d, t) {
        seq(c, d, t, [[392, 0, 0.12], [330, 0.12, 0.12], [262, 0.24, 0.12], [196, 0.36, 0.28, 150]],
          { type: 'square', g: 0.08, lp: 2200 });
      } },
      tileMove: { gap: 60, play: function (c, d, t) {
        tone(c, d, { type: 'triangle', f: 210, f2: 300, t: t, d: 0.07, g: 0.09, lp: 1600 });
      } },
      tileMerge: { gap: 50, play: function (c, d, t, o) {
        var v = (o && o.value) || 4;
        var steps = Math.max(0, Math.min(9, Math.log(v) / Math.LN2 - 2));
        var f = 330 * Math.pow(2, steps / 6);
        seq(c, d, t, [[f, 0, 0.08], [f * 1.5, 0.05, 0.12]], { type: 'triangle', g: 0.12, lp: 3000 });
      } },
      record: { gap: 500, duck: 0.6, play: function (c, d, t) {
        seq(c, d, t, [[523, 0, 0.1], [659, 0.08, 0.1], [784, 0.16, 0.1], [1047, 0.24, 0.28]],
          { type: 'triangle', g: 0.12, lp: 4200 });
        seq(c, d, t, [[523, 0, 0.1], [659, 0.08, 0.1], [784, 0.16, 0.1], [1047, 0.24, 0.28]],
          { type: 'square', g: 0.025, lp: 2600 });
      } },
      victory: { gap: 800, duck: 1.0, play: function (c, d, t) {
        seq(c, d, t, [[523, 0, 0.1], [659, 0.1, 0.1], [784, 0.2, 0.1], [1047, 0.3, 0.14],
                      [784, 0.46, 0.1], [1047, 0.56, 0.1], [1319, 0.66, 0.36]],
          { type: 'triangle', g: 0.12, lp: 4200 });
        seq(c, d, t, [[523, 0, 0.1], [659, 0.1, 0.1], [784, 0.2, 0.1], [1047, 0.3, 0.14]],
          { type: 'square', g: 0.025, lp: 2600 });
      } }
    };

    /* Воспроизвести эффект. Ничего не делает, если эффекты выключены,
       громкость 0, контекст ещё не разблокирован жестом или звук вызван слишком часто. */
    function play(name, opts) {
      if (!cfg.sfxEnabled || cfg.sfxVolume <= 0) return false;
      var def = SOUNDS[name];
      if (!def) return false;
      var c = ensureContext();
      if (!c) return false;
      if (c.state !== 'running') {
        if (Date.now() - lastGestureAt > 1000) return false;
        resumeIfNeeded();
      }
      var now = Date.now();
      if (def.gap && lastPlayed[name] && now - lastPlayed[name] < def.gap) return false;
      lastPlayed[name] = now;
      try {
        def.play(c, sfxBus, c.currentTime + ((opts && opts.delay) || 0), opts);
      } catch (e) { return false; }
      if (def.duck) duckMusic(def.duck);
      return true;
    }

    /* ---------- Фоновая музыка: плейлист с кроссфейдом ----------
       Два <audio> («слота») по очереди играют треки по кругу. За CROSSFADE_SEC
       до конца трека следующий стартует во втором слоте, громкости перекрываются
       по равной мощности, затем старый слот останавливается: дольше окна перехода
       звучит только один трек. Оба слота идут через Web Audio (musicBus),
       поэтому громкость работает и на iOS, где audio.volume игнорируется. */
    function hasMusic() { return PLAYLIST.length > 0; }

    function registerTrack(id, url, gain) {
      if (!id || !url) return;
      PLAYLIST.push({ id: id, url: url, gain: gain || 1 });
      syncMusic();
    }

    function allFailed() {
      if (!PLAYLIST.length) return false;
      for (var i = 0; i < PLAYLIST.length; i++) { if (!trackFailed[i]) return false; }
      return true;
    }

    function notifyMusic() {
      if (musicListener) { try { musicListener(); } catch (e) {} }
    }

    function trackGainFor(i) { return (PLAYLIST[i] && PLAYLIST[i].gain) || 1; }

    /* следующий трек после from, который не помечен как неудачный (-1 — таких нет) */
    function nextPlayable(from) {
      for (var step = 1; step <= PLAYLIST.length; step++) {
        var i = (from + step) % PLAYLIST.length;
        if (!trackFailed[i]) return i;
      }
      return -1;
    }

    /* кривая равной мощности для setValueCurveAtTime */
    function fadeCurve(fadeIn, g) {
      var n = 64, arr = new Float32Array(n);
      for (var i = 0; i < n; i++) {
        var x = (i / (n - 1)) * Math.PI / 2;
        arr[i] = g * (fadeIn ? Math.sin(x) : Math.cos(x));
      }
      return arr;
    }

    function setSteady(slot, g) {
      try { slot.gain.gain.cancelScheduledValues(0); } catch (e) {}
      slot.gain.gain.value = g;
    }

    function createSlot(c) {
      var el = new Audio();
      el.preload = 'auto';
      el.loop = false;
      var slot = { el: el, node: null, gain: c.createGain(), index: -1 };
      slot.gain.gain.value = 0;
      slot.gain.connect(duckBus);
      slot.node = c.createMediaElementSource(el);
      slot.node.connect(slot.gain);
      el.addEventListener('timeupdate', function () { onTimeUpdate(slot); });
      el.addEventListener('ended',      function () { onEnded(slot); });
      el.addEventListener('error',      function () { onError(slot); });
      return slot;
    }

    function loadIntoSlot(slot, i) {
      try { slot.el.pause(); } catch (e) {}
      slot.index = i;
      slot.el.src = PLAYLIST[i].url;
    }

    function playSlot(slot) {
      try {
        var p = slot.el.play();
        if (p && p.catch) p.catch(function () { /* автозапуск запрещён — повторим при следующем жесте */ });
      } catch (e) {}
    }

    /* заранее подгрузить следующий трек в свободный слот */
    function prepareNext() {
      if (!slots || fading) return;
      var idle = slots[1 - activeSlot];
      var nxt = nextPlayable(trackIndex);
      if (nxt < 0) return;
      if (idle.index !== nxt) {
        loadIntoSlot(idle, nxt);
        setSteady(idle, 0);
      }
    }

    /* перейти к треку nxt: fadeSec > 0 — кроссфейд, 0 — мгновенно */
    function switchTo(nxt, fadeSec) {
      var out = slots[activeSlot], inc = slots[1 - activeSlot];
      if (inc.index !== nxt) loadIntoSlot(inc, nxt);
      var g = trackGainFor(nxt);
      activeSlot = 1 - activeSlot;
      trackIndex = nxt;
      try { inc.el.currentTime = 0; } catch (e) {}
      if (fadeSec > 0 && !out.el.paused) {
        var t = ctx.currentTime;
        fading = true;
        try {
          inc.gain.gain.cancelScheduledValues(t);
          inc.gain.gain.setValueCurveAtTime(fadeCurve(true, g), t, fadeSec);
          out.gain.gain.cancelScheduledValues(t);
          out.gain.gain.setValueCurveAtTime(fadeCurve(false, trackGainFor(out.index)), t, fadeSec);
        } catch (e) { setSteady(inc, g); setSteady(out, 0); }
      } else {
        setSteady(inc, g);
        setSteady(out, 0);
        try { out.el.pause(); } catch (e) {}
      }
      playSlot(inc);
      if (!fading) prepareNext();
    }

    function finishCrossfade() {
      if (!fading) return;
      fading = false;
      var out = slots[1 - activeSlot], inc = slots[activeSlot];
      try { out.el.pause(); } catch (e) {}
      setSteady(out, 0);
      setSteady(inc, trackGainFor(inc.index));
      prepareNext();
    }

    function onTimeUpdate(slot) {
      if (!slots || slot !== slots[activeSlot]) return;
      var el = slot.el;
      if (fading) {
        if (el.currentTime >= CROSSFADE_SEC + 0.25) finishCrossfade();
        return;
      }
      var d = el.duration;
      if (isFinite(d) && d > CROSSFADE_SEC * 2 && el.currentTime >= d - CROSSFADE_SEC) {
        var nxt = nextPlayable(trackIndex);
        if (nxt >= 0) switchTo(nxt, CROSSFADE_SEC);
      }
    }

    /* запасной путь: трек закончился без кроссфейда (например, не пришёл timeupdate) */
    function onEnded(slot) {
      if (!slots || slot !== slots[activeSlot] || fading) return;
      var nxt = nextPlayable(trackIndex);
      if (nxt >= 0) switchTo(nxt, 0);
    }

    /* ошибка загрузки/декодирования: трек помечается как неудачный и пропускается */
    function onError(slot) {
      if (!slots || slot.index < 0) return;
      var bad = slot.index;
      trackFailed[bad] = true;
      slot.index = -1;
      if (slot !== slots[activeSlot]) {          // подгруженный заранее или уходящий трек
        if (!fading) prepareNext();
        notifyMusic();
        return;
      }
      if (fading) finishCrossfade();             // чтобы не звучало два трека сразу
      if (allFailed()) { stopMusic(); notifyMusic(); return; }
      var nxt = nextPlayable(bad);
      if (nxt >= 0) switchTo(nxt, 0);
      notifyMusic();
    }

    function resetFailures() {
      trackFailed = [];
      trackIndex = 0;                               // после сбоя начинаем с первого трека
      if (slots) { slots[0].index = -1; slots[1].index = -1; }
      notifyMusic();
    }

    function startMusic() {
      if (!PLAYLIST.length || allFailed()) return;
      var c = ensureContext();
      if (!c) return;
      if (slots && !slots[activeSlot].el.paused) return;   // уже играет
      if (!slots) {
        try {
          duckBus = c.createGain();
          duckBus.connect(musicBus);
          slots = [createSlot(c), createSlot(c)];
        } catch (e) { slots = null; return; }
      }
      var cur = slots[activeSlot];
      if (cur.index < 0) {
        var first = trackFailed[trackIndex] ? nextPlayable(trackIndex) : trackIndex;
        if (first < 0) return;
        trackIndex = first;
        loadIntoSlot(cur, first);
        setSteady(cur, trackGainFor(first));
      }
      playSlot(cur);
      prepareNext();
    }

    function stopMusic() {
      if (!slots) return;
      if (fading) finishCrossfade();   // мгновенно завершаем переход: остаётся один слот
      var cur = slots[activeSlot];
      if (!cur.el.paused) { try { cur.el.pause(); } catch (e) {} }
    }

    function syncMusic() {
      if (!hasMusic()) return;
      var want = cfg.musicEnabled && cfg.musicVolume > 0 && gestureSeen && !document.hidden;
      if (want) startMusic(); else stopMusic();
    }

    /* Кратковременно приглушить музыку под важный игровой звук */
    function duckMusic(dur) {
      if (!ctx || !duckBus || !slots || slots[activeSlot].el.paused) return;
      var g = duckBus.gain, t = ctx.currentTime;
      try {
        g.cancelScheduledValues(t);
        g.setTargetAtTime(0.45, t, 0.03);
        g.setTargetAtTime(1, t + dur, 0.3);
      } catch (e) {}
    }

    function musicFailed() { return allFailed(); }
    function setMusicListener(fn) { musicListener = fn; }

    /* Применить настройки пользователя (вызывается при каждом изменении) */
    function configure(s) {
      if (!s) return;
      var wasMusicEnabled = cfg.musicEnabled;
      cfg.sfxEnabled   = !!s.sfxEnabled;
      cfg.sfxVolume    = s.sfxVolume;
      cfg.musicEnabled = !!s.musicEnabled;
      cfg.musicVolume  = s.musicVolume;
      /* повторное включение музыки = новая попытка загрузки, если все треки не загрузились */
      if (cfg.musicEnabled && !wasMusicEnabled && allFailed()) resetFailures();
      applyGains(false);
      syncMusic();
    }

    return {
      init: init, configure: configure, play: play,
      hasMusic: hasMusic, registerTrack: registerTrack,
      musicFailed: musicFailed, setMusicListener: setMusicListener
    };
  })();

  /* =========================================================
     НАСТРОЙКИ (отдельный ключ localStorage: arcadebox.settings)
     ========================================================= */
  var SETTINGS_STORAGE_KEY = 'arcadebox.settings';
  var SETTINGS_VERSION = 1;
  var DEFAULT_SETTINGS = {
    sfxEnabled: true,
    sfxVolume: 70,
    musicEnabled: false,
    musicVolume: 50,
    animationsEnabled: true
  };
  var SETTING_KINDS = {
    sfxEnabled: 'bool', sfxVolume: 'volume',
    musicEnabled: 'bool', musicVolume: 'volume',
    animationsEnabled: 'bool'
  };
  /* ползунок выключен, пока выключен связанный переключатель */
  var RANGE_DEPENDS = { sfxVolume: 'sfxEnabled', musicVolume: 'musicEnabled' };

  function cloneDefaults() {
    var o = {};
    for (var k in DEFAULT_SETTINGS) {
      if (DEFAULT_SETTINGS.hasOwnProperty(k)) o[k] = DEFAULT_SETTINGS[k];
    }
    return o;
  }

  function sanitizeSetting(key, value) {
    var kind = SETTING_KINDS[key];
    if (kind === 'bool') return (typeof value === 'boolean') ? value : DEFAULT_SETTINGS[key];
    if (kind === 'volume') {
      var n = parseInt(value, 10);
      if (!isFinite(n)) return DEFAULT_SETTINGS[key];
      return Math.max(0, Math.min(100, n));
    }
    return DEFAULT_SETTINGS[key];
  }

  function loadSettings() {
    var result = cloneDefaults();
    try {
      var raw = localStorage.getItem(SETTINGS_STORAGE_KEY);
      if (!raw) return result;
      var parsed = JSON.parse(raw);
      var values = parsed && typeof parsed === 'object' ? parsed.values : null;
      if (!values || typeof values !== 'object') return result;
      for (var k in SETTING_KINDS) {
        if (SETTING_KINDS.hasOwnProperty(k) && values.hasOwnProperty(k)) {
          result[k] = sanitizeSetting(k, values[k]);
        }
      }
    } catch (e) {}
    return result;
  }

  var settings = loadSettings();

  function saveSettings() {
    try {
      localStorage.setItem(SETTINGS_STORAGE_KEY,
        JSON.stringify({ version: SETTINGS_VERSION, values: settings }));
    } catch (e) {}
  }

  /* Применение без перезагрузки: анимации — атрибутом на <html>, звук — через ArcadeAudio */
  function applySettings() {
    document.documentElement.setAttribute('data-animations', settings.animationsEnabled ? 'on' : 'off');
    ArcadeAudio.configure(settings);
  }

  function setSetting(key, value) {
    if (!SETTING_KINDS.hasOwnProperty(key)) return;
    settings[key] = sanitizeSetting(key, value);
    applySettings();
    saveSettings();
    renderSettings();
  }

  function resetSettings() {
    settings = cloneDefaults();
    applySettings();
    saveSettings();
    renderSettings();
  }

  function renderSettings() {
    var i, el, key;

    var toggles = document.querySelectorAll('[data-setting]');
    for (i = 0; i < toggles.length; i++) {
      el = toggles[i];
      key = el.getAttribute('data-setting');
      if (settings.hasOwnProperty(key)) el.setAttribute('aria-checked', settings[key] ? 'true' : 'false');
    }

    var ranges = document.querySelectorAll('[data-setting-range]');
    for (i = 0; i < ranges.length; i++) {
      el = ranges[i];
      key = el.getAttribute('data-setting-range');
      if (!settings.hasOwnProperty(key)) continue;
      var v = settings[key];
      if (el.value !== String(v)) el.value = String(v);
      el.style.setProperty('--fill', v + '%');
      el.setAttribute('aria-valuetext', v + '%');
      var dep = RANGE_DEPENDS[key];
      var off = !!(dep && !settings[dep]);
      el.disabled = off;
      var row = el.closest ? el.closest('.setting-row') : null;
      if (row) {
        if (off) row.classList.add('is-off'); else row.classList.remove('is-off');
        var out = row.querySelector('.setting-value');
        if (out) out.textContent = v + '%';
      }
    }

    var note = document.getElementById('music-note');
    if (note) note.hidden = !ArcadeAudio.musicFailed();
  }

  function toggleSettingFromElement(actionEl) {
    var key = actionEl.getAttribute('data-setting');
    if (!key || !SETTING_KINDS.hasOwnProperty(key) || SETTING_KINDS[key] !== 'bool') return;
    var next = !settings[key];
    /* звук выключения эффектов проигрываем ДО выключения */
    if (key === 'sfxEnabled' && !next) ArcadeAudio.play('uiToggleOff');
    setSetting(key, next);
    if (!(key === 'sfxEnabled' && !next)) ArcadeAudio.play(next ? 'uiToggleOn' : 'uiToggleOff');
  }

  function onSettingsInput(e) {
    var el = e.target;
    if (!el || !el.getAttribute) return;
    var key = el.getAttribute('data-setting-range');
    if (key) setSetting(key, el.value);
  }

  function onSettingsChange(e) {
    var el = e.target;
    if (!el || !el.getAttribute) return;
    var key = el.getAttribute('data-setting-range');
    if (!key) return;
    saveSettings();
    if (key === 'sfxVolume') ArcadeAudio.play('uiTap'); /* слышно новую громкость */
  }

  /* ---------- Сброс рекордов ----------
     Рекорд хранится в двух местах: общий ключ arcadebox.scores и поле best
     в сохранении 2048 (arcadebox.2048). Чистим оба, иначе 2048 вернул бы
     рекорд обратно при следующем сохранении. Сама партия 2048 не трогается. */
  function resetAllRecords() {
    try { localStorage.removeItem(SCORES_STORAGE_KEY); } catch (e) {}
    try {
      var raw = localStorage.getItem('arcadebox.2048');
      if (raw) {
        var parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') {
          parsed.best = 0;
          localStorage.setItem('arcadebox.2048', JSON.stringify(parsed));
        }
      }
    } catch (e) {}
    if (game2048 && game2048.resetBest) game2048.resetBest();
  }

  /* =========================================================
     ДИАЛОГ ПОДТВЕРЖДЕНИЯ И УВЕДОМЛЕНИЕ
     ========================================================= */
  var confirmState = { onConfirm: null, lastFocus: null };
  var toastTimer = null;

  function isConfirmOpen() {
    var dlg = document.getElementById('confirm-dialog');
    return !!(dlg && !dlg.classList.contains('hidden'));
  }

  function openConfirm(opts) {
    var dlg = document.getElementById('confirm-dialog');
    var title = document.getElementById('confirm-title');
    var text = document.getElementById('confirm-text');
    var ok = document.getElementById('confirm-ok');
    var cancel = document.getElementById('confirm-cancel');
    if (!dlg || !title || !text || !ok || !cancel) return;
    title.textContent = opts.title;
    text.textContent = opts.text;
    ok.textContent = opts.okLabel || 'Подтвердить';
    confirmState.onConfirm = opts.onConfirm || null;
    confirmState.lastFocus = document.activeElement;
    dlg.classList.remove('hidden');
    dlg.setAttribute('aria-hidden', 'false');
    try { cancel.focus(); } catch (e) {}
  }

  function hideConfirm() {
    var dlg = document.getElementById('confirm-dialog');
    if (!dlg) return;
    dlg.classList.add('hidden');
    dlg.setAttribute('aria-hidden', 'true');
    var back = confirmState.lastFocus;
    confirmState.lastFocus = null;
    confirmState.onConfirm = null;
    if (back && back.focus && document.body.contains(back)) {
      try { back.focus(); } catch (e) {}
    }
  }

  function closeConfirm() {
    if (!isConfirmOpen()) return;
    hideConfirm();
  }

  function acceptConfirm() {
    if (!isConfirmOpen()) return;
    var cb = confirmState.onConfirm;
    hideConfirm();
    if (cb) cb();
  }

  function onDialogKeyDown(e) {
    if (!isConfirmOpen()) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      closeConfirm();
      return;
    }
    if (e.key === 'Tab') {
      var dlg = document.getElementById('confirm-dialog');
      var btns = dlg.querySelectorAll('button');
      if (!btns.length) return;
      var first = btns[0], last = btns[btns.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  }

  function showToast(message) {
    var el = document.getElementById('toast');
    if (!el) return;
    el.textContent = message;
    el.classList.add('is-visible');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      toastTimer = null;
      el.classList.remove('is-visible');
    }, 2200);
  }

  function askResetScores() {
    openConfirm({
      title: 'Сбросить рекорды?',
      text: 'Лучшие результаты в «Змейке» и 2048 будут удалены. Это действие нельзя отменить. Текущая партия 2048 и настройки не изменятся.',
      okLabel: 'Сбросить',
      onConfirm: function () {
        resetAllRecords();
        ArcadeAudio.play('uiConfirm');
        showToast('Рекорды сброшены');
      }
    });
  }

  function askResetSettings() {
    openConfirm({
      title: 'Сбросить настройки?',
      text: 'Звук, громкость и анимации вернутся к значениям по умолчанию. Рекорды и сохранённые игры не изменятся.',
      okLabel: 'Сбросить',
      onConfirm: function () {
        resetSettings();
        ArcadeAudio.play('uiConfirm');
        showToast('Настройки сброшены');
      }
    });
  }

  /* Настройки применяются сразу при загрузке скрипта — до первой отрисовки */
  applySettings();

  /* =========================================================
     ИГРА: ЗМЕЙКА (механика не изменялась)
     ========================================================= */
  function createSnakeGame() {
    var canvas   = document.getElementById('snake-canvas');
    var arena    = document.getElementById('snake-arena');
    var wrap     = document.getElementById('snake-arena-wrap');
    var scoreEl  = document.getElementById('snake-score');
    var bestEl   = document.getElementById('snake-best');
    var overlay  = document.getElementById('snake-overlay');
    var pauseBtn = document.getElementById('snake-pause-btn');

    if (!canvas || !arena || !wrap || !scoreEl || !bestEl || !overlay) return null;
    var ctx = canvas.getContext('2d');

    var GRID = 20, INITIAL_SPEED = 7, SPEED_STEP = 0.35, MAX_SPEED = 18;
    var MAX_ARENA = 500, SWIPE_THRESHOLD = 22, TAP_MAX_MOVE = 12;
    var TAP_MAX_TIME = 250, MAX_DIR_QUEUE = 2, MAX_DPR = 3, OVERLAY_GUARD_MS = 250;

    var VEC = { up:{x:0,y:-1}, down:{x:0,y:1}, left:{x:-1,y:0}, right:{x:1,y:0} };
    var OPPOSITE = { up:'down', down:'up', left:'right', right:'left' };

    var snake = [], food = null, direction = 'right', dirQueue = [];
    var score = 0, best = 0, speed = INITIAL_SPEED, recordBeaten = false;
    var state = 'ready', rafId = null, lastTime = 0, accumulator = 0;
    var renderSize = 300, cellSize = 15, layoutTimer = null;
    var touch = null, inputsBound = false, overlayShownAt = 0;

    function layout() {
      var availW = wrap.clientWidth, availH = wrap.clientHeight;
      if (!(availW > 0)) availW = 300;
      if (!(availH > 0)) availH = 300;
      var size = Math.floor(Math.min(availW, availH, MAX_ARENA));
      if (!(size > 0)) size = 280;
      arena.style.width = size + 'px';
      arena.style.height = size + 'px';
      var dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
      canvas.width = Math.round(size * dpr);
      canvas.height = Math.round(size * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      renderSize = size;
      cellSize = size / GRID;
      if (snake.length) render();
    }

    function onResize() { layout(); }
    function onOrientationChange() {
      layout();
      if (layoutTimer) clearTimeout(layoutTimer);
      layoutTimer = setTimeout(function () { layoutTimer = null; layout(); }, 200);
    }

    function updateHud() { scoreEl.textContent = String(score); bestEl.textContent = String(best); }

    function updatePauseButton() {
      if (!pauseBtn) return;
      var interactive = (state === 'running' || state === 'paused');
      pauseBtn.disabled = !interactive;
      if (state === 'paused') { pauseBtn.classList.add('is-paused'); pauseBtn.setAttribute('aria-label','Продолжить'); }
      else { pauseBtn.classList.remove('is-paused'); pauseBtn.setAttribute('aria-label','Пауза'); }
    }

    function showOverlay(kind) {
      var html = '';
      if (kind === 'ready') {
        html = '<div class="overlay-icon" aria-hidden="true">🐍</div><h3>Змейка</h3>' +
          '<p class="overlay-desc">Свайп по полю меняет направление. Собирай еду и не врезайся в стены и собственное тело.</p>' +
          '<button class="btn btn-primary" data-action="snake-start">Начать игру</button>';
      } else if (kind === 'paused') {
        html = '<div class="overlay-icon" aria-hidden="true">⏸</div><h3>Пауза</h3>' +
          '<p class="overlay-score">Счёт: <strong>' + score + '</strong></p>' +
          '<button class="btn btn-primary" data-action="snake-resume">Продолжить</button>';
      } else if (kind === 'over') {
        html = '<div class="overlay-icon" aria-hidden="true">💀</div><h3>Игра окончена</h3>' +
          '<p class="overlay-score">Счёт: <strong>' + score + '</strong></p>' +
          (recordBeaten ? '<p class="overlay-record">🏆 Новый рекорд!</p>' : '') +
          '<button class="btn btn-primary" data-action="snake-start">Играть снова</button>';
      } else if (kind === 'victory') {
        html = '<div class="overlay-icon" aria-hidden="true">🏆</div><h3>Победа!</h3>' +
          '<p class="overlay-score">Змейка заполнила всё поле. Счёт: <strong>' + score + '</strong></p>' +
          (recordBeaten ? '<p class="overlay-record">🏆 Новый рекорд!</p>' : '') +
          '<button class="btn btn-primary" data-action="snake-start">Играть снова</button>';
      }
      overlay.innerHTML = html;
      overlay.classList.remove('hidden');
      overlayShownAt = Date.now();
    }

    function hideOverlay() { overlay.classList.add('hidden'); }
    function overlayJustShown() { return (Date.now() - overlayShownAt) < OVERLAY_GUARD_MS; }

    function resetParty() {
      var cx = Math.floor(GRID / 2), cy = Math.floor(GRID / 2);
      snake = [{x:cx-1,y:cy},{x:cx,y:cy},{x:cx+1,y:cy}];
      direction = 'right'; dirQueue.length = 0;
      score = 0; speed = INITIAL_SPEED; recordBeaten = false;
      accumulator = 0; lastTime = 0;
      best = getGameBest('snake');
      spawnFood(); updateHud();
    }

    function spawnFood() {
      var occupied = {}, i;
      for (i = 0; i < snake.length; i++) occupied[snake[i].x+','+snake[i].y] = true;
      var free = [];
      for (var x = 0; x < GRID; x++)
        for (var y = 0; y < GRID; y++)
          if (!occupied[x+','+y]) free.push({x:x,y:y});
      if (free.length === 0) { food = null; return false; }
      food = free[Math.floor(Math.random() * free.length)];
      return true;
    }

    function queueDirection(dir) {
      if (state !== 'running') return;
      if (!VEC[dir]) return;
      var last = dirQueue.length > 0 ? dirQueue[dirQueue.length-1] : direction;
      if (dir === last) return;
      if (OPPOSITE[dir] === last) return;
      if (dirQueue.length >= MAX_DIR_QUEUE) return;
      dirQueue.push(dir);
      ArcadeAudio.play('snakeTurn');
    }

    function step() {
      if (dirQueue.length > 0) direction = dirQueue.shift();
      var head = snake[snake.length-1], v = VEC[direction];
      var nx = head.x + v.x, ny = head.y + v.y;
      if (nx < 0 || ny < 0 || nx >= GRID || ny >= GRID) { finishGame(false); return; }
      var willGrow = !!(food && food.x === nx && food.y === ny);
      var startIdx = willGrow ? 0 : 1;
      for (var i = startIdx; i < snake.length; i++) {
        if (snake[i].x === nx && snake[i].y === ny) { finishGame(false); return; }
      }
      snake.push({x:nx, y:ny});
      if (willGrow) {
        score += 1;
        var recordChime = false;
        if (score > best) {
          /* фанфара — только когда побит уже существующий рекорд, один раз за партию */
          if (!recordBeaten && best > 0) recordChime = true;
          best = score; recordBeaten = true; saveGameBest('snake', best);
        }
        speed = Math.min(MAX_SPEED, INITIAL_SPEED + score * SPEED_STEP);
        updateHud();
        if (!spawnFood()) { finishGame(true); return; }
        ArcadeAudio.play(recordChime ? 'record' : 'snakeEat');
      } else { snake.shift(); }
    }

    function finishGame(victory) {
      if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
      state = victory ? 'victory' : 'over';
      dirQueue.length = 0; touch = null;
      render(); showOverlay(state); updatePauseButton();
      ArcadeAudio.play(victory ? 'victory' : 'gameOver');
      requestReloadIfSafe();
    }

    function loop(timestamp) {
      if (state !== 'running') { rafId = null; return; }
      if (!lastTime) lastTime = timestamp;
      var delta = timestamp - lastTime;
      lastTime = timestamp;
      if (delta > 250) delta = 250;
      accumulator += delta;
      var tickMs = 1000 / speed, safety = 0;
      while (accumulator >= tickMs && state === 'running' && safety < 5) {
        step(); accumulator -= tickMs; safety++;
      }
      if (state === 'running') { render(); rafId = requestAnimationFrame(loop); }
      else { rafId = null; }
    }

    function startLoop() {
      if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
      lastTime = 0; accumulator = 0;
      rafId = requestAnimationFrame(loop);
    }

    function roundRect(c, x, y, w, h, r) {
      if (w < 2*r) r = w/2;
      if (h < 2*r) r = h/2;
      c.beginPath(); c.moveTo(x+r,y);
      c.arcTo(x+w,y,x+w,y+h,r); c.arcTo(x+w,y+h,x,y+h,r);
      c.arcTo(x,y+h,x,y,r); c.arcTo(x,y,x+w,y,r);
      c.closePath();
    }

    function render() {
      var cs = cellSize, i;
      ctx.fillStyle = '#0a0a14';
      ctx.fillRect(0, 0, renderSize, renderSize);
      ctx.strokeStyle = 'rgba(255,255,255,0.025)'; ctx.lineWidth = 1;
      for (i = 1; i < GRID; i++) {
        var p = i * cs;
        ctx.beginPath(); ctx.moveTo(p,0); ctx.lineTo(p,renderSize); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(0,p); ctx.lineTo(renderSize,p); ctx.stroke();
      }
      if (food) {
        var pulse = settings.animationsEnabled ? 1 + Math.sin(performance.now()/220)*0.08 : 1;
        var fx = food.x*cs+cs/2, fy = food.y*cs+cs/2, fr = cs*0.38*pulse;
        var glow = ctx.createRadialGradient(fx,fy,0,fx,fy,fr*1.6);
        glow.addColorStop(0,'rgba(239,68,68,0.45)'); glow.addColorStop(1,'rgba(239,68,68,0)');
        ctx.fillStyle = glow;
        ctx.beginPath(); ctx.arc(fx,fy,fr*1.6,0,Math.PI*2); ctx.fill();
        ctx.fillStyle = '#ef4444';
        ctx.beginPath(); ctx.arc(fx,fy,fr,0,Math.PI*2); ctx.fill();
        ctx.fillStyle = 'rgba(255,255,255,0.5)';
        ctx.beginPath(); ctx.arc(fx-fr*0.35,fy-fr*0.35,fr*0.28,0,Math.PI*2); ctx.fill();
      }
      for (i = 0; i < snake.length; i++) {
        var s = snake[i], isHead = (i === snake.length-1), pad = cs*0.12;
        var t = snake.length > 1 ? i/(snake.length-1) : 0;
        var cr = Math.round(167+(109-167)*t), cg = Math.round(139+(40-139)*t), cb = Math.round(250+(217-250)*t);
        ctx.fillStyle = 'rgb('+cr+','+cg+','+cb+')';
        roundRect(ctx, s.x*cs+pad, s.y*cs+pad, cs-pad*2, cs-pad*2, cs*0.28);
        ctx.fill();
        if (isHead) {
          var hx = s.x*cs+cs/2, hy = s.y*cs+cs/2, eyeR = cs*0.11;
          var ex1=0,ey1=0,ex2=0,ey2=0;
          if (direction==='right'){ex1=cs*0.26;ey1=-cs*0.22;ex2=cs*0.26;ey2=cs*0.22;}
          else if(direction==='left'){ex1=-cs*0.26;ey1=-cs*0.22;ex2=-cs*0.26;ey2=cs*0.22;}
          else if(direction==='up'){ex1=-cs*0.22;ey1=-cs*0.26;ex2=cs*0.22;ey2=-cs*0.26;}
          else{ex1=-cs*0.22;ey1=cs*0.26;ex2=cs*0.22;ey2=cs*0.26;}
          ctx.fillStyle='#0a0a14';
          ctx.beginPath();ctx.arc(hx+ex1,hy+ey1,eyeR,0,Math.PI*2);ctx.fill();
          ctx.beginPath();ctx.arc(hx+ex2,hy+ey2,eyeR,0,Math.PI*2);ctx.fill();
        }
      }
    }

    function onKeyDown(e) {
      var key = e.key, handled = true;
      switch (key) {
        case 'ArrowUp': case 'w': case 'W': case 'ц': case 'Ц': queueDirection('up'); break;
        case 'ArrowDown': case 's': case 'S': case 'ы': case 'Ы': queueDirection('down'); break;
        case 'ArrowLeft': case 'a': case 'A': case 'ф': case 'Ф': queueDirection('left'); break;
        case 'ArrowRight': case 'd': case 'D': case 'в': case 'В': queueDirection('right'); break;
        case ' ': case 'Spacebar': case 'Escape': togglePause(); break;
        case 'Enter':
          if (state==='ready'||state==='over'||state==='victory') startGame();
          else if (state==='paused') resumeGame();
          break;
        default: handled = false;
      }
      if (handled && e.cancelable) e.preventDefault();
    }

    function onTouchStart(e) {
      if (e.touches.length !== 1) { touch = null; return; }
      var t = e.touches[0];
      touch = { ax:t.clientX,ay:t.clientY,sx:t.clientX,sy:t.clientY,lx:t.clientX,ly:t.clientY,time:Date.now(),swiped:false };
    }

    function onTouchMove(e) {
      if (!touch) return;
      if (e.cancelable) e.preventDefault();
      var t = e.touches[0];
      touch.lx = t.clientX; touch.ly = t.clientY;
      if (state !== 'running') return;
      var dx = t.clientX-touch.ax, dy = t.clientY-touch.ay;
      var adx = Math.abs(dx), ady = Math.abs(dy);
      if (Math.max(adx,ady) < SWIPE_THRESHOLD) return;
      if (adx > ady) queueDirection(dx > 0 ? 'right' : 'left');
      else queueDirection(dy > 0 ? 'down' : 'up');
      touch.ax = t.clientX; touch.ay = t.clientY; touch.swiped = true;
    }

    function onTouchEnd(e) {
      if (!touch) return;
      var lastX = touch.lx, lastY = touch.ly;
      if (e.changedTouches && e.changedTouches.length > 0) {
        lastX = e.changedTouches[0].clientX; lastY = e.changedTouches[0].clientY;
      }
      var moved = Math.max(Math.abs(lastX-touch.sx), Math.abs(lastY-touch.sy));
      var elapsed = Date.now() - touch.time;
      var wasTap = !touch.swiped && moved < TAP_MAX_MOVE && elapsed < TAP_MAX_TIME;
      touch = null;
      if (wasTap && state === 'running') pauseGame();
    }

    function onTouchCancel() { touch = null; }
    function onContextMenu(e) { e.preventDefault(); }
    function onOverlayClick(e) {
      if (state === 'paused' && e.target === overlay && !overlayJustShown()) resumeGame();
    }

    function bindInputs() {
      if (inputsBound) return;
      inputsBound = true;
      window.addEventListener('keydown', onKeyDown);
      window.addEventListener('resize', onResize);
      window.addEventListener('orientationchange', onOrientationChange);
      canvas.addEventListener('touchstart', onTouchStart, {passive:true});
      canvas.addEventListener('touchmove', onTouchMove, {passive:false});
      canvas.addEventListener('touchend', onTouchEnd, {passive:true});
      canvas.addEventListener('touchcancel', onTouchCancel, {passive:true});
      arena.addEventListener('contextmenu', onContextMenu);
      overlay.addEventListener('click', onOverlayClick);
    }

    function unbindInputs() {
      if (!inputsBound) return;
      inputsBound = false;
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('resize', onResize);
      window.removeEventListener('orientationchange', onOrientationChange);
      canvas.removeEventListener('touchstart', onTouchStart);
      canvas.removeEventListener('touchmove', onTouchMove);
      canvas.removeEventListener('touchend', onTouchEnd);
      canvas.removeEventListener('touchcancel', onTouchCancel);
      arena.removeEventListener('contextmenu', onContextMenu);
      overlay.removeEventListener('click', onOverlayClick);
    }

    function startGame() {
      resetParty(); state = 'running';
      hideOverlay(); updatePauseButton(); startLoop();
      ArcadeAudio.play('gameStart');
    }

    function pauseGame() {
      if (state !== 'running') return;
      state = 'paused';
      if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
      dirQueue.length = 0; touch = null;
      showOverlay('paused'); updatePauseButton();
    }

    function resumeGame() {
      if (state !== 'paused') return;
      state = 'running'; hideOverlay(); updatePauseButton(); startLoop();
    }

    function togglePause() {
      if (state === 'running') pauseGame();
      else if (state === 'paused') resumeGame();
    }

    function enter() {
      bindInputs(); layout(); resetParty();
      state = 'ready'; showOverlay('ready'); updatePauseButton(); render();
    }

    function leave() {
      if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
      if (layoutTimer) { clearTimeout(layoutTimer); layoutTimer = null; }
      state = 'ready'; dirQueue.length = 0; touch = null;
      unbindInputs();
    }

    function autoPauseIfRunning() { if (state === 'running') pauseGame(); }

    return {
      enter: enter, leave: leave, start: startGame, pause: pauseGame,
      resume: resumeGame, togglePause: togglePause, setDirection: queueDirection,
      autoPauseIfRunning: autoPauseIfRunning, overlayJustShown: overlayJustShown,
      isRunning: function () { return state === 'running'; },
      /* партия в процессе: идёт или на паузе (при 'ready', 'over', 'victory' — нет) */
      isBusy: function () { return state === 'running' || state === 'paused'; }
    };
  }

  /* =========================================================
     ИГРА: 2048
     ========================================================= */
  function createGame2048() {
    var gridEl  = document.getElementById('grid-2048');
    var scoreEl = document.getElementById('score-2048');
    var bestEl  = document.getElementById('best-2048');
    var overlay = document.getElementById('overlay-2048');
    var undoBtn = document.getElementById('btn-2048-undo');

    if (!gridEl || !scoreEl || !bestEl || !overlay || !undoBtn) return null;

    var SIZE = 4;
    var STORAGE_KEY = 'arcadebox.2048';
    var MAX_HISTORY = 5;
    var ANIMATION_DURATION = 160;  // движение плиток
    var NEW_ANIM = 200;            // появление новой плитки
    var MERGED_ANIM = 250;         // пульсация слитой плитки

    var state = {
      grid: [],
      score: 0,
      best: 0,
      history: [],
      gameStatus: 'ready',
      hasWon: false,
      hasWonAcknowledged: false,
      nextTileId: 1
    };

    var tileElements = {};
    var inputsBound = false;
    var touchStart = null;
    var isAnimating = false;
    var recordSounded = false;   // фанфара рекорда уже была (или не нужна) в этой партии
    var gap = 10;
    var cellSize = 80;
    var innerPadding = 10;

    /* ---------- Размеры и позиционирование ---------- */

    function recalcSizes() {
      var rect = gridEl.getBoundingClientRect();
      var w = rect.width;
      if (!(w > 0)) w = 300;
      var style = window.getComputedStyle(gridEl);
      innerPadding = parseFloat(style.paddingLeft) || 10;
      var innerW = w - innerPadding * 2;
      cellSize = (innerW - (SIZE - 1) * gap) / SIZE;
      if (!(cellSize > 0)) cellSize = 60;

      var bgCells = gridEl.querySelectorAll('.grid-cell');
      for (var i = 0; i < bgCells.length; i++) {
        var r = Math.floor(i / SIZE), c = i % SIZE;
        var x = innerPadding + c * (cellSize + gap);
        var y = innerPadding + r * (cellSize + gap);
        bgCells[i].style.left = x + 'px';
        bgCells[i].style.top = y + 'px';
        bgCells[i].style.width = cellSize + 'px';
        bgCells[i].style.height = cellSize + 'px';
      }

      for (var r = 0; r < SIZE; r++) {
        for (var c = 0; c < SIZE; c++) {
          var tile = state.grid[r] && state.grid[r][c];
          if (tile && tileElements[tile.id]) {
            positionTile(tileElements[tile.id], r, c, false, tile.value);
          }
        }
      }
    }

    function tilePosition(r, c) {
      return {
        x: innerPadding + c * (cellSize + gap),
        y: innerPadding + r * (cellSize + gap)
      };
    }

    /* Позиционирование — только translate на внешнем слое.
       Анимации scale живут на внутреннем .tile-face. */
    function positionTile(el, r, c, animate, value) {
      var pos = tilePosition(r, c);
      el.style.width = cellSize + 'px';
      el.style.height = cellSize + 'px';

      var face = faceOf(el);
      if (face) face.style.fontSize = computeFontSize(value, cellSize) + 'px';

      el.style.transition = animate ? 'transform 150ms ease-out' : 'none';
      el.style.transform = 'translate(' + pos.x + 'px, ' + pos.y + 'px)';
    }

    function computeFontSize(value, size) {
      var digits = String(value).length;
      var base = size * 0.45;
      if (digits <= 2) return base;
      if (digits === 3) return base * 0.85;
      if (digits === 4) return base * 0.70;
      if (digits === 5) return base * 0.58;
      return base * 0.48;
    }

    function valueClass(value) {
      if (value <= 8192) return 'tile-' + value;
      return 'tile-super';
    }

    /* Внешний слой — позиционирование, внутренний — оформление и анимации */
    function createTileElement(tile) {
      var el = document.createElement('div');
      el.className = 'tile-2048-item';
      el.setAttribute('data-id', tile.id);

      var face = document.createElement('div');
      face.className = 'tile-face ' + valueClass(tile.value);
      face.textContent = tile.value;

      el.appendChild(face);
      return el;
    }

    function faceOf(el) {
      return el ? el.firstElementChild : null;
    }

    /* Запуск короткой анимации на внутреннем слое */
    function animateFace(el, cls, duration) {
      var face = faceOf(el);
      if (!face) return;
      face.classList.remove(cls);
      void face.offsetWidth; // форсируем перерасчёт — анимация стартует заново
      face.classList.add(cls);
      setTimeout(function () { face.classList.remove(cls); }, duration + 60);
    }

    /* ---------- Сохранение / загрузка ---------- */

    function cloneGrid(grid) {
      var newGrid = [];
      for (var r = 0; r < SIZE; r++) {
        newGrid[r] = [];
        for (var c = 0; c < SIZE; c++) {
          var t = grid[r][c];
          newGrid[r][c] = t ? { id: t.id, value: t.value } : null;
        }
      }
      return newGrid;
    }

    function saveState() {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify({
          grid: state.grid,
          score: state.score,
          best: state.best,
          gameStatus: state.gameStatus,
          hasWon: state.hasWon,
          hasWonAcknowledged: state.hasWonAcknowledged,
          nextTileId: state.nextTileId,
          history: state.history
        }));
      } catch (e) {}
      if (state.best > 0) saveGameBest('2048', state.best);
    }

    function loadState() {
      try {
        var data = localStorage.getItem(STORAGE_KEY);
        if (!data) return false;
        var parsed = JSON.parse(data);
        if (!parsed || typeof parsed !== 'object') return false;
        if (!Array.isArray(parsed.grid) || parsed.grid.length !== SIZE) return false;

        for (var r = 0; r < SIZE; r++) {
          if (!Array.isArray(parsed.grid[r]) || parsed.grid[r].length !== SIZE) return false;
          for (var c = 0; c < SIZE; c++) {
            var tile = parsed.grid[r][c];
            if (tile !== null) {
              if (!tile || typeof tile !== 'object') return false;
              if (typeof tile.id !== 'number' || tile.id < 1) return false;
              if (typeof tile.value !== 'number' || tile.value < 2) return false;
            }
          }
        }

        if (typeof parsed.score !== 'number' || parsed.score < 0) return false;
        if (typeof parsed.nextTileId !== 'number' || parsed.nextTileId < 1) return false;

        state.grid = parsed.grid;
        state.score = parsed.score;
        state.best = (typeof parsed.best === 'number' && parsed.best >= 0) ? parsed.best : 0;
        state.nextTileId = parsed.nextTileId;
        state.hasWon = !!parsed.hasWon;
        state.hasWonAcknowledged = !!parsed.hasWonAcknowledged;

        var validStatuses = ['ready', 'playing', 'over'];
        state.gameStatus = (parsed.gameStatus && validStatuses.indexOf(parsed.gameStatus) >= 0)
          ? parsed.gameStatus : 'ready';

        state.history = [];
        if (Array.isArray(parsed.history)) {
          for (var i = 0; i < parsed.history.length && state.history.length < MAX_HISTORY; i++) {
            var h = parsed.history[i];
            if (h && Array.isArray(h.grid) && h.grid.length === SIZE &&
                typeof h.score === 'number' && h.score >= 0) {
              state.history.push({
                grid: h.grid,
                score: h.score,
                hasWon: !!h.hasWon,
                hasWonAcknowledged: !!h.hasWonAcknowledged,
                nextTileId: (typeof h.nextTileId === 'number' && h.nextTileId >= 1) ? h.nextTileId : 1
              });
            }
          }
        }

        var globalBest = getGameBest('2048');
        if (globalBest > state.best) state.best = globalBest;

        return true;
      } catch (e) { return false; }
    }

    /* ---------- История и отмена ---------- */

    function pushHistory(snapshot) {
      state.history.push(snapshot);
      if (state.history.length > MAX_HISTORY) state.history.shift();
    }

    function undo() {
      if (state.history.length === 0) return false;
      if (state.gameStatus === 'ready') return false;
      if (isAnimating) return false;

      var prev = state.history.pop();
      state.grid = prev.grid;
      state.score = prev.score;
      // best НЕ откатывается — рекорд остаётся максимальным
      state.hasWon = prev.hasWon;
      state.hasWonAcknowledged = prev.hasWonAcknowledged;
      state.nextTileId = prev.nextTileId;
      state.gameStatus = 'playing';

      render();
      hideOverlay();
      saveState();
      updateUndoButton();
      return true;
    }

    function updateUndoButton() {
      var canUndo = state.history.length > 0 && state.gameStatus !== 'ready' && !isAnimating;
      undoBtn.disabled = !canUndo;
    }

    /* ---------- Логика хода ---------- */

    function getVector(direction) {
      return {
        up:    { r: -1, c: 0 },
        down:  { r:  1, c: 0 },
        left:  { r: 0,  c: -1 },
        right: { r: 0,  c: 1  }
      }[direction];
    }

    function buildTraversals(direction) {
      var r = [], c = [];
      for (var i = 0; i < SIZE; i++) { r.push(i); c.push(i); }
      if (direction === 'down')  r.reverse();
      if (direction === 'right') c.reverse();
      return { r: r, c: c };
    }

    function prepareTiles() {
      for (var r = 0; r < SIZE; r++)
        for (var c = 0; c < SIZE; c++)
          if (state.grid[r][c]) state.grid[r][c].mergedFrom = null;
    }

    function findFarthestPosition(cell, vector) {
      var previous;
      var next = { r: cell.r + vector.r, c: cell.c + vector.c };
      while (next.r >= 0 && next.r < SIZE && next.c >= 0 && next.c < SIZE &&
             !state.grid[next.r][next.c]) {
        previous = { r: next.r, c: next.c };
        next = { r: next.r + vector.r, c: next.c + vector.c };
      }
      return { farthest: previous || cell, next: next };
    }

    function addRandomTile() {
      var empty = [];
      for (var r = 0; r < SIZE; r++)
        for (var c = 0; c < SIZE; c++)
          if (state.grid[r][c] === null) empty.push({ r: r, c: c });
      if (empty.length === 0) return null;
      var cell = empty[Math.floor(Math.random() * empty.length)];
      var value = Math.random() < 0.9 ? 2 : 4;
      var tile = { id: state.nextTileId++, value: value };
      state.grid[cell.r][cell.c] = tile;
      return { tile: tile, r: cell.r, c: cell.c };
    }

    function canMove() {
      for (var r = 0; r < SIZE; r++) {
        for (var c = 0; c < SIZE; c++) {
          if (state.grid[r][c] === null) return true;
          var v = state.grid[r][c].value;
          if (c < SIZE-1 && state.grid[r][c+1] && state.grid[r][c+1].value === v) return true;
          if (r < SIZE-1 && state.grid[r+1][c] && state.grid[r+1][c].value === v) return true;
        }
      }
      return false;
    }

    /* ---------- Ход с анимацией ---------- */

    function move(direction) {
      if (state.gameStatus !== 'playing') return false;
      if (isAnimating) return false;

      // Снимок состояния ДО хода
      var snapshot = {
        grid: cloneGrid(state.grid),
        score: state.score,
        hasWon: state.hasWon,
        hasWonAcknowledged: state.hasWonAcknowledged,
        nextTileId: state.nextTileId
      };

      var vector = getVector(direction);
      var traversals = buildTraversals(direction);
      prepareTiles();

      var moved = false;
      var recordChime = false;
      var mergedMap = {};
      var newMergedTiles = [];

      traversals.r.forEach(function (r) {
        traversals.c.forEach(function (c) {
          var tile = state.grid[r][c];
          if (!tile) return;

          // Плитка, созданная слиянием в этом ходе, не обрабатывается повторно
          if (tile.mergedFrom) return;

          var positions = findFarthestPosition({ r: r, c: c }, vector);
          var nr = positions.next.r;
          var nc = positions.next.c;

          var nextTile = (nr >= 0 && nr < SIZE && nc >= 0 && nc < SIZE)
            ? state.grid[nr][nc] : null;

          if (nextTile && nextTile.value === tile.value && !nextTile.mergedFrom) {
            var merged = {
              id: state.nextTileId++,
              value: tile.value * 2,
              mergedFrom: [tile.id, nextTile.id]
            };
            state.grid[nr][nc] = merged;
            state.grid[r][c] = null;

            state.score += merged.value;
            if (state.score > state.best) {
              /* фанфара — только когда побит уже существующий рекорд, один раз за партию */
              if (!recordSounded && state.best > 0) recordChime = true;
              recordSounded = true;
              state.best = state.score;
              saveGameBest('2048', state.best);
            }

            moved = true;
            mergedMap[merged.id] = [tile.id, nextTile.id];
            newMergedTiles.push({ tile: merged, r: nr, c: nc });
          } else {
            var fr = positions.farthest.r;
            var fc = positions.farthest.c;
            if (fr !== r || fc !== c) {
              state.grid[fr][fc] = tile;
              state.grid[r][c] = null;
              moved = true;
            }
          }
        });
      });

      if (!moved) return false;

      pushHistory(snapshot);

      if (recordChime) {
        ArcadeAudio.play('record');
      } else if (newMergedTiles.length > 0) {
        var maxMerged = 0;
        for (var mi = 0; mi < newMergedTiles.length; mi++) {
          if (newMergedTiles[mi].tile.value > maxMerged) maxMerged = newMergedTiles[mi].tile.value;
        }
        ArcadeAudio.play('tileMerge', { value: maxMerged });
      } else {
        ArcadeAudio.play('tileMove');
      }

      var added = addRandomTile();

      var justWon = false;
      if (!state.hasWon) {
        for (var r = 0; r < SIZE; r++) {
          for (var c = 0; c < SIZE; c++) {
            if (state.grid[r][c] && state.grid[r][c].value >= 2048) {
              state.hasWon = true;
              justWon = true;
              break;
            }
          }
          if (state.hasWon) break;
        }
      }

      isAnimating = true;
      updateUndoButton(); // отмена сразу становится недоступной

      // 1. Перемещение существующих плиток (translate на внешнем слое)
      for (var r = 0; r < SIZE; r++) {
        for (var c = 0; c < SIZE; c++) {
          var tile = state.grid[r][c];
          if (tile && tileElements[tile.id]) {
            positionTile(tileElements[tile.id], r, c, true, tile.value);
          }
        }
      }

      // 2. Поглощённые плитки доезжают до клетки слияния
      for (var newId in mergedMap) {
        var consumedIds = mergedMap[newId];
        var mergedInfo = null;
        for (var i = 0; i < newMergedTiles.length; i++) {
          if (newMergedTiles[i].tile.id === parseInt(newId, 10)) {
            mergedInfo = newMergedTiles[i];
            break;
          }
        }
        if (!mergedInfo) continue;
        consumedIds.forEach(function (oldId) {
          var oldEl = tileElements[oldId];
          if (oldEl) positionTile(oldEl, mergedInfo.r, mergedInfo.c, true, mergedInfo.tile.value);
        });
      }

      scoreEl.textContent = state.score;
      bestEl.textContent = state.best;

      // 3. После движения: удаляем поглощённые, создаём новые с анимацией scale
      setTimeout(function () {
        for (var newId in mergedMap) {
          mergedMap[newId].forEach(function (oldId) {
            var oldEl = tileElements[oldId];
            if (oldEl) {
              if (oldEl.parentNode) oldEl.parentNode.removeChild(oldEl);
              delete tileElements[oldId];
            }
          });
        }

        newMergedTiles.forEach(function (info) {
          var el = createTileElement(info.tile);
          tileElements[info.tile.id] = el;
          gridEl.appendChild(el);
          positionTile(el, info.r, info.c, false, info.tile.value);
          animateFace(el, 'is-merged', MERGED_ANIM);
        });

        if (added) {
          var newEl = createTileElement(added.tile);
          tileElements[added.tile.id] = newEl;
          gridEl.appendChild(newEl);
          positionTile(newEl, added.r, added.c, false, added.tile.value);
          animateFace(newEl, 'is-new', NEW_ANIM);
        }

        var over = !canMove();
        if (over) state.gameStatus = 'over';

        saveState();
        isAnimating = false;
        updateUndoButton();

        if (over) { showOverlay('over'); ArcadeAudio.play('gameOver'); }
        else if (justWon && !state.hasWonAcknowledged) { showOverlay('win'); ArcadeAudio.play('victory'); }

        requestReloadIfSafe();
      }, settings.animationsEnabled ? ANIMATION_DURATION : 0);

      return true;
    }

    /* ---------- Рендер (синхронизация DOM с матрицей) ---------- */

    function render() {
      var activeIds = {};
      for (var r = 0; r < SIZE; r++) {
        for (var c = 0; c < SIZE; c++) {
          if (state.grid[r][c]) {
            activeIds[state.grid[r][c].id] = {
              r: r, c: c, value: state.grid[r][c].value
            };
          }
        }
      }

      for (var id in tileElements) {
        if (!activeIds[id]) {
          var el = tileElements[id];
          if (el.parentNode) el.parentNode.removeChild(el);
          delete tileElements[id];
        }
      }

      for (var id in activeIds) {
        var info = activeIds[id];
        var el = tileElements[id];
        if (!el) {
          el = createTileElement({ id: parseInt(id, 10), value: info.value });
          tileElements[id] = el;
          gridEl.appendChild(el);
        }
        var face = faceOf(el);
        if (face) {
          var expectedClass = 'tile-face ' + valueClass(info.value);
          if (face.className !== expectedClass) face.className = expectedClass;
          if (face.textContent !== String(info.value)) face.textContent = String(info.value);
        }
        positionTile(el, info.r, info.c, false, info.value);
      }

      scoreEl.textContent = state.score;
      bestEl.textContent = state.best;
    }

    /* ---------- Оверлей ---------- */

    function showOverlay(kind) {
      var html = '';
      if (kind === 'ready') {
        html = '<h3>2048</h3>' +
          '<p>Соединяй одинаковые плитки, двигая их в любом направлении. Цель — получить 2048!</p>' +
          '<button class="btn btn-primary" data-action="2048-start">Начать игру</button>';
      } else if (kind === 'over') {
        html = '<h3>Игра окончена</h3>' +
          '<p>Счёт: <strong>' + state.score + '</strong> · Рекорд: <strong>' + state.best + '</strong></p>' +
          '<button class="btn btn-primary" data-action="2048-new">Новая игра</button>';
      } else if (kind === 'win') {
        html = '<h3>🎉 Победа!</h3>' +
          '<p>Ты достиг 2048! Можешь продолжить и собрать ещё больше.</p>' +
          '<button class="btn btn-primary" data-action="2048-continue">Продолжить</button>';
      }
      overlay.innerHTML = html;
      overlay.classList.remove('hidden');
    }

    function hideOverlay() {
      overlay.classList.add('hidden');
      overlay.innerHTML = '';
    }

    /* ---------- Действия ---------- */

    function newGame() {
      if (state.gameStatus === 'playing' && state.score > 0) {
        if (!confirm('Начать новую игру? Текущий прогресс будет потерян.')) return;
      }

      for (var id in tileElements) {
        var el = tileElements[id];
        if (el.parentNode) el.parentNode.removeChild(el);
      }
      tileElements = {};

      initGrid();
      state.score = 0;
      state.history = [];
      state.gameStatus = 'playing';
      state.hasWon = false;
      state.hasWonAcknowledged = false;
      recordSounded = false;

      var a = addRandomTile();
      var b = addRandomTile();

      recalcSizes();
      render();

      if (a && tileElements[a.tile.id]) animateFace(tileElements[a.tile.id], 'is-new', NEW_ANIM);
      if (b && tileElements[b.tile.id]) animateFace(tileElements[b.tile.id], 'is-new', NEW_ANIM);

      saveState();
      hideOverlay();
      updateUndoButton();
      ArcadeAudio.play('gameStart');
    }

    /* Сброс рекорда из настроек: обнуляет best в памяти и на экране.
       Запись в localStorage делает resetAllRecords(). */
    function resetBest() {
      state.best = 0;
      bestEl.textContent = '0';
    }

    function continueGame() {
      state.hasWonAcknowledged = true;
      hideOverlay();
      saveState();
    }

    function initGrid() {
      state.grid = [];
      for (var r = 0; r < SIZE; r++) {
        state.grid[r] = [];
        for (var c = 0; c < SIZE; c++) state.grid[r][c] = null;
      }
    }

    /* ---------- Вход / выход ---------- */

    function enter() {
      bindInputs();
      if (loadState()) {
        /* если текущая партия уже держит рекорд — фанфара до следующей партии не нужна */
        recordSounded = state.score > 0 && state.score >= state.best;
        recalcSizes();
        render();
        updateUndoButton();
        if (state.gameStatus === 'ready') showOverlay('ready');
        else if (state.gameStatus === 'over') showOverlay('over');
        else if (state.gameStatus === 'playing' && state.hasWon && !state.hasWonAcknowledged) showOverlay('win');
      } else {
        initGrid();
        recordSounded = false;
        state.gameStatus = 'ready';
        state.best = Math.max(state.best, getGameBest('2048'));
        recalcSizes();
        render();
        showOverlay('ready');
        updateUndoButton();
      }
    }

    function leave() {
      unbindInputs();
      if (state.gameStatus === 'playing' || state.gameStatus === 'over') saveState();
    }

    /* ---------- Управление ---------- */

    function onTouchStart(e) {
      if (e.touches.length !== 1) { touchStart = null; return; }
      touchStart = { x: e.touches[0].clientX, y: e.touches[0].clientY };
    }

    function onTouchMove(e) {
      if (e.cancelable) e.preventDefault();
    }

    function onTouchEnd(e) {
      if (!touchStart || !e.changedTouches || e.changedTouches.length === 0) {
        touchStart = null; return;
      }
      var dx = e.changedTouches[0].clientX - touchStart.x;
      var dy = e.changedTouches[0].clientY - touchStart.y;
      var absDx = Math.abs(dx), absDy = Math.abs(dy);
      touchStart = null;
      if (Math.max(absDx, absDy) < 30) return;
      if (absDx > absDy) move(dx > 0 ? 'right' : 'left');
      else move(dy > 0 ? 'down' : 'up');
    }

    function onKeyDown(e) {
      if (state.gameStatus !== 'playing') return;
      var handled = true;
      switch (e.key) {
        case 'ArrowUp': move('up'); break;
        case 'ArrowDown': move('down'); break;
        case 'ArrowLeft': move('left'); break;
        case 'ArrowRight': move('right'); break;
        default: handled = false;
      }
      if (handled && e.cancelable) e.preventDefault();
    }

    function onResize() { recalcSizes(); }

    function bindInputs() {
      if (inputsBound) return;
      inputsBound = true;
      gridEl.addEventListener('touchstart', onTouchStart, { passive: true });
      gridEl.addEventListener('touchmove', onTouchMove, { passive: false });
      gridEl.addEventListener('touchend', onTouchEnd, { passive: true });
      window.addEventListener('keydown', onKeyDown);
      window.addEventListener('resize', onResize);
      window.addEventListener('orientationchange', onResize);
    }

    function unbindInputs() {
      if (!inputsBound) return;
      inputsBound = false;
      gridEl.removeEventListener('touchstart', onTouchStart);
      gridEl.removeEventListener('touchmove', onTouchMove);
      gridEl.removeEventListener('touchend', onTouchEnd);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('resize', onResize);
      window.removeEventListener('orientationchange', onResize);
    }

    return {
      enter: enter,
      leave: leave,
      newGame: newGame,
      undo: undo,
      continueGame: continueGame,
      resetBest: resetBest,
      hideOverlay: hideOverlay,
      isBusy: function () { return isAnimating; }
    };
  }

  /* =========================================================
     ОБЩАЯ НАВИГАЦИЯ
     ========================================================= */

  function init() {
    try { window.history.replaceState({ screen: 'screen-home' }, '', ''); }
    catch (e) {}
    ArcadeAudio.init();
    ArcadeAudio.setMusicListener(renderSettings);
    renderGames();
    renderSettings();
    bindGlobalEvents();
    registerServiceWorker();
  }

  /* Карточки игр рендерятся во все контейнеры .games-grid
     (главная страница и каталог). Класс-модификатор даёт
     каждой игре собственный акцент в оформлении. */
  function renderGames() {
    var grids = document.querySelectorAll('.games-grid');
    if (!grids.length) return;

    var html = '';
    var availableCount = 0;

    for (var i = 0; i < GAMES.length; i++) {
      var g = GAMES[i];
      var cls = 'game-card';
      if (g.status === 'available') { cls += ' active-game'; availableCount++; }
      else cls += ' coming-soon';
      cls += ' game-card--' + g.id;

      var badge = g.status === 'available' ? 'Играй' : 'Скоро';
      html += '<button class="' + cls + '" data-game="' + g.id + '">' +
        '<span class="card-badge">' + badge + '</span>' +
        '<span class="card-icon" aria-hidden="true">' + g.icon + '</span>' +
        '<span class="card-title">' + g.title + '</span>' +
        '<span class="card-desc">' + g.description + '</span></button>';
    }

    for (var k = 0; k < grids.length; k++) {
      grids[k].innerHTML = html;
    }

    var info = document.getElementById('collection-info');
    if (info) {
      info.textContent = 'В коллекции ' + GAMES.length + ' игр · доступно: ' +
        availableCount + ' · скоро: ' + (GAMES.length - availableCount);
    }
  }

  function showScreen(screenId, addToHistory) {
    if (addToHistory === undefined) addToHistory = true;
    if (screenId === currentScreenId) return;
    var target = document.getElementById(screenId);
    if (!target) return;
    closeConfirm();
    var previous = currentScreenId;
    var active = document.querySelector('.screen.active');
    if (active) active.classList.remove('active');
    target.classList.add('active');
    if (addToHistory) {
      try { window.history.pushState({ screen: screenId }, '', ''); }
      catch (e) {}
    }
    if (previous === 'screen-snake' && snakeGame) snakeGame.leave();
    if (previous === 'screen-2048' && game2048) game2048.leave();
    if (screenId === 'screen-snake') {
      if (!snakeGame) snakeGame = createSnakeGame();
      if (snakeGame) snakeGame.enter();
    }
    if (screenId === 'screen-2048') {
      if (!game2048) game2048 = createGame2048();
      if (game2048) game2048.enter();
    }
    if (screenId === 'screen-records') renderRecords();
    if (screenId === 'screen-settings') renderSettings();

    currentScreenId = screenId;
    requestReloadIfSafe();
  }

  function goBack() {
    if (window.history.length > 1) window.history.back();
    else showScreen('screen-home', false);
  }

  function onPopState(e) {
    closeConfirm();
    var st = e.state;
    if (st && typeof st.screen === 'string') showScreen(st.screen, false);
    else showScreen('screen-home', false);
  }

  function onVisibilityChange() {
    if (document.hidden && currentScreenId === 'screen-snake' && snakeGame) {
      snakeGame.autoPauseIfRunning();
    }
  }

  /* Действия, у которых свой звук (или он не нужен) — общий «тап» не играем */
  var OWN_SOUND_ACTIONS = {
    'snake-start': true, '2048-start': true, 'setting-toggle': true, 'dialog-confirm': true
  };

  function handleAction(target) {
    if (!target || !target.closest) return;
    if (target.id === 'confirm-dialog') { closeConfirm(); return; }   // клик по затемнению
    var actionEl = target.closest('[data-action]');
    if (actionEl) {
      var action = actionEl.getAttribute('data-action');
      if (!OWN_SOUND_ACTIONS[action]) {
        ArcadeAudio.play((action === 'go-back' || action === 'dialog-cancel') ? 'uiBack' : 'uiTap');
      }
      switch (action) {
        case 'show-games':    showScreen('screen-games');    return;
        case 'show-menu':     showScreen('screen-menu');     return;
        case 'show-records':  showScreen('screen-records');  return;
        case 'show-settings': showScreen('screen-settings'); return;
        case 'go-home':       showScreen('screen-home');     return;
        case 'go-back':       goBack();                      return;
        case 'snake-start':   if (snakeGame && !snakeGame.overlayJustShown()) snakeGame.start(); return;
        case 'snake-resume':  if (snakeGame && !snakeGame.overlayJustShown()) snakeGame.resume(); return;
        case 'snake-pause':   if (snakeGame) snakeGame.togglePause(); return;
        case '2048-new':      if (game2048) game2048.newGame(); return;
        case '2048-undo':     if (game2048) game2048.undo(); return;
        case '2048-start':    if (game2048) game2048.newGame(); return;
        case '2048-continue': if (game2048) game2048.continueGame(); return;
        case 'setting-toggle':  toggleSettingFromElement(actionEl); return;
        case 'reset-scores':    askResetScores();   return;
        case 'reset-settings':  askResetSettings(); return;
        case 'dialog-cancel':   closeConfirm();     return;
        case 'dialog-confirm':  acceptConfirm();    return;
      }
      return;
    }
    var card = target.closest('.game-card');
    if (card) {
      var gameId = card.getAttribute('data-game');
      var game = null;
      for (var i = 0; i < GAMES.length; i++) {
        if (GAMES[i].id === gameId) { game = GAMES[i]; break; }
      }
      if (game && game.status === 'available' && game.screenId) {
        ArcadeAudio.play('uiTap');
        showScreen(game.screenId);
      }
    }
  }

  function bindGlobalEvents() {
    document.addEventListener('click', function (e) { handleAction(e.target); });
    document.addEventListener('input', onSettingsInput);
    document.addEventListener('change', onSettingsChange);
    window.addEventListener('keydown', onDialogKeyDown, true);
    window.addEventListener('popstate', onPopState);
    document.addEventListener('visibilitychange', onVisibilityChange);
    document.addEventListener('selectstart', function (e) {
      if (e.target && e.target.closest && e.target.closest('button')) e.preventDefault();
    });
  }

  /* =========================================================
     ОБНОВЛЕНИЕ PWA
     Service Worker сообщает о новой версии; страница перезагружается,
     когда это безопасно — ничего не анимируется и Змейка не идёт.
     ========================================================= */
  function requestReloadIfSafe() {
    if (!pendingUpdate) return;
    var snakeBusy = snakeGame && snakeGame.isBusy();
    var g2048Busy = game2048 && game2048.isBusy && game2048.isBusy();
    if (snakeBusy || g2048Busy) return;
    /* защита от цикла: не перезагружаем страницу чаще, чем раз в 30 секунд.
       Если предохранитель сработал, pendingUpdate остаётся true —
       следующий подходящий вызов повторит попытку. */
    try {
      var last = parseInt(sessionStorage.getItem(RELOAD_GUARD_KEY), 10);
      if (isFinite(last) && Date.now() - last < 30000) return;
      sessionStorage.setItem(RELOAD_GUARD_KEY, String(Date.now()));
    } catch (e) {}
    pendingUpdate = false;
    window.location.reload();
  }

  function registerServiceWorker() {
    if (!('serviceWorker' in navigator)) return;
    if (window.location.protocol === 'file:') return;

    if (navigator.serviceWorker) {
      navigator.serviceWorker.addEventListener('message', function (event) {
        if (event.data && event.data.type === 'UPDATED') {
          pendingUpdate = true;
          requestReloadIfSafe();
        }
      });
    }

    window.addEventListener('load', function () {
      navigator.serviceWorker.register('./sw.js')
        .then(function (reg) {
          console.log('ArcadeBox: SW зарегистрирован, scope =', reg.scope);
        })
        .catch(function (err) {
          console.warn('ArcadeBox: не удалось зарегистрировать SW —', err);
        });
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();