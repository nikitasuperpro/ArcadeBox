/* =========================================================
   ArcadeBox — логика приложения + игра «Змейка»
   ========================================================= */

(function () {
  'use strict';

  /* ---------- Реестр игр ----------
     Чтобы добавить новую игру, достаточно дописать объект сюда
     и создать соответствующий <section> в index.html. */
  var GAMES = [
    {
      id: 'snake',
      title: 'Змейка',
      description: 'Классическая змейка. Собирай еду и расти.',
      icon: '🐍',
      status: 'available',
      screenId: 'screen-snake'
    },
    {
      id: 'space',
      title: 'Космический полёт',
      description: 'Уворачивайся от астероидов в космосе.',
      icon: '🚀',
      status: 'soon',
      screenId: null
    },
    {
      id: 'tictactoe',
      title: 'Крестики-нолики',
      description: 'Сыграй партию против друга или ИИ.',
      icon: '⭕',
      status: 'soon',
      screenId: null
    },
    {
      id: 'reaction',
      title: 'Реакция',
      description: 'Проверь скорость своей реакции.',
      icon: '⚡',
      status: 'soon',
      screenId: null
    }
  ];

  var currentScreenId = 'screen-home';
  var snakeGame = null;   // Экземпляр игры, создаётся один раз

  /* =========================================================
     ХРАНИЛИЩЕ РЕКОРДОВ
     Изолированный интерфейс: в будущем сюда можно подключить
     общую систему статистики ArcadeBox без переписывания игр.
     ========================================================= */
  var SCORES_STORAGE_KEY = 'arcadebox.scores';

  function readAllScores() {
    try {
      var raw = localStorage.getItem(SCORES_STORAGE_KEY);
      if (!raw) return {};
      var parsed = JSON.parse(raw);
      return (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : {};
    } catch (e) {
      return {};
    }
  }

  function writeAllScores(data) {
    try {
      localStorage.setItem(SCORES_STORAGE_KEY, JSON.stringify(data));
    } catch (e) {
      // localStorage недоступен или переполнен — игра продолжает работать
    }
  }

  function getGameBest(gameId) {
    var all = readAllScores();
    var entry = all[gameId];
    var n = entry ? parseInt(entry.best, 10) : NaN;
    return (isFinite(n) && n > 0) ? n : 0;
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

  /* =========================================================
     ИГРА: ЗМЕЙКА
     Самодостаточный модуль. Знает только свои DOM-элементы
     и функции рекордов, не связан с навигацией приложения.
     ========================================================= */
  function createSnakeGame() {

    /* ----- Элементы ----- */
    var canvas   = document.getElementById('snake-canvas');
    var arena    = document.getElementById('snake-arena');
    var wrap     = document.getElementById('snake-arena-wrap');
    var scoreEl  = document.getElementById('snake-score');
    var bestEl   = document.getElementById('snake-best');
    var overlay  = document.getElementById('snake-overlay');
    var pauseBtn = document.getElementById('snake-pause-btn');

    if (!canvas || !arena || !wrap || !scoreEl || !bestEl || !overlay) {
      return null;
    }
    var ctx = canvas.getContext('2d');

    /* ----- Параметры ----- */
    var GRID            = 20;    // клеток по стороне
    var INITIAL_SPEED   = 7;     // клеток в секунду на старте
    var SPEED_STEP      = 0.35;  // прирост скорости за каждое очко
    var MAX_SPEED       = 18;
    var MAX_ARENA       = 500;   // совпадает с --arena-max в CSS
    var SWIPE_THRESHOLD = 22;    // px для срабатывания поворота
    var TAP_MAX_MOVE    = 12;    // px: меньше — считаем тапом
    var TAP_MAX_TIME    = 250;   // ms
    var MAX_DIR_QUEUE   = 2;     // буфер направлений
    var MAX_DPR         = 3;

    // Окно защиты от «фантомного» клика сразу после показа оверлея
    var OVERLAY_GUARD_MS = 250;

    var VEC = {
      up:    { x: 0,  y: -1 },
      down:  { x: 0,  y: 1  },
      left:  { x: -1, y: 0  },
      right: { x: 1,  y: 0  }
    };
    var OPPOSITE = { up: 'down', down: 'up', left: 'right', right: 'left' };

    /* ----- Состояние ----- */
    var snake = [];
    var food = null;
    var direction = 'right';
    var dirQueue = [];        // очередь поворотов (защита от 180° и быстрых свайпов)
    var score = 0;
    var best = 0;
    var speed = INITIAL_SPEED;
    var recordBeaten = false;
    var state = 'ready';      // 'ready' | 'running' | 'paused' | 'over' | 'victory'
    var rafId = null;
    var lastTime = 0;
    var accumulator = 0;
    var renderSize = 300;
    var cellSize = 15;
    var layoutTimer = null;
    var touch = null;
    var inputsBound = false;
    var overlayShownAt = 0;   // когда последний раз был показан оверлей

    /* =========================================================
       РАЗМЕТКА И РАЗМЕР ПОЛЯ
       ========================================================= */
    function layout() {
      var availW = wrap.clientWidth;
      var availH = wrap.clientHeight;

      // Если размеры ещё не определились — берём запасное значение
      if (!(availW > 0)) availW = 300;
      if (!(availH > 0)) availH = 300;

      var size = Math.floor(Math.min(availW, availH, MAX_ARENA));
      if (!(size > 0)) size = 280;

      arena.style.width  = size + 'px';
      arena.style.height = size + 'px';

      // Чёткая картинка на экранах с высокой плотностью пикселей
      var dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
      canvas.width  = Math.round(size * dpr);
      canvas.height = Math.round(size * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      renderSize = size;
      cellSize = size / GRID;

      if (snake.length) render();
    }

    function onResize() {
      layout();
    }

    function onOrientationChange() {
      layout();
      // Android меняет размеры не мгновенно — повторяем расчёт чуть позже
      if (layoutTimer) clearTimeout(layoutTimer);
      layoutTimer = setTimeout(function () {
        layoutTimer = null;
        layout();
      }, 200);
    }

    /* =========================================================
       HUD И ОВЕРЛЕЙ
       ========================================================= */
    function updateHud() {
      scoreEl.textContent = String(score);
      bestEl.textContent = String(best);
    }

    function updatePauseButton() {
      if (!pauseBtn) return;
      var interactive = (state === 'running' || state === 'paused');
      pauseBtn.disabled = !interactive;
      if (state === 'paused') {
        pauseBtn.classList.add('is-paused');
        pauseBtn.setAttribute('aria-label', 'Продолжить');
      } else {
        pauseBtn.classList.remove('is-paused');
        pauseBtn.setAttribute('aria-label', 'Пауза');
      }
    }

    function showOverlay(kind) {
      var html = '';
      if (kind === 'ready') {
        html =
          '<div class="overlay-icon" aria-hidden="true">🐍</div>' +
          '<h3>Змейка</h3>' +
          '<p class="overlay-desc">Свайп по полю меняет направление. Собирай еду и не врезайся в стены и собственное тело.</p>' +
          '<button class="btn btn-primary" data-action="snake-start">Начать игру</button>';
      } else if (kind === 'paused') {
        html =
          '<div class="overlay-icon" aria-hidden="true">⏸</div>' +
          '<h3>Пауза</h3>' +
          '<p class="overlay-score">Счёт: <strong>' + score + '</strong></p>' +
          '<button class="btn btn-primary" data-action="snake-resume">Продолжить</button>';
      } else if (kind === 'over') {
        html =
          '<div class="overlay-icon" aria-hidden="true">💀</div>' +
          '<h3>Игра окончена</h3>' +
          '<p class="overlay-score">Счёт: <strong>' + score + '</strong></p>' +
          (recordBeaten ? '<p class="overlay-record">🏆 Новый рекорд!</p>' : '') +
          '<button class="btn btn-primary" data-action="snake-start">Играть снова</button>';
      } else if (kind === 'victory') {
        html =
          '<div class="overlay-icon" aria-hidden="true">🏆</div>' +
          '<h3>Победа!</h3>' +
          '<p class="overlay-score">Змейка заполнила всё поле. Счёт: <strong>' + score + '</strong></p>' +
          (recordBeaten ? '<p class="overlay-record">🏆 Новый рекорд!</p>' : '') +
          '<button class="btn btn-primary" data-action="snake-start">Играть снова</button>';
      }
      overlay.innerHTML = html;
      overlay.classList.remove('hidden');
      overlayShownAt = Date.now();
    }

    function hideOverlay() {
      overlay.classList.add('hidden');
    }

    /* Возвращает true, если оверлей показан меньше OVERLAY_GUARD_MS назад.
       Браузер может послать событие click по координатам тапа УЖЕ ПОСЛЕ того,
       как мы показали оверлей, — такой «фантомный» клик способен мгновенно
       отменить только что выполненное действие (например, снять паузу,
       которую пользователь поставил этим же тапом). */
    function overlayJustShown() {
      return (Date.now() - overlayShownAt) < OVERLAY_GUARD_MS;
    }

    /* =========================================================
       ЛОГИКА ПАРТИИ
       ========================================================= */
    function resetParty() {
      var cx = Math.floor(GRID / 2);
      var cy = Math.floor(GRID / 2);
      // Массив: [0] — хвост, [length-1] — голова
      snake = [
        { x: cx - 1, y: cy },
        { x: cx,     y: cy },
        { x: cx + 1, y: cy }
      ];
      direction = 'right';
      dirQueue.length = 0;
      score = 0;
      speed = INITIAL_SPEED;
      recordBeaten = false;
      accumulator = 0;
      lastTime = 0;
      best = getGameBest('snake');
      spawnFood();
      updateHud();
    }

    /* Еда появляется только в свободной клетке.
       Возвращает false, если свободных клеток не осталось. */
    function spawnFood() {
      var occupied = {};
      var i;
      for (i = 0; i < snake.length; i++) {
        occupied[snake[i].x + ',' + snake[i].y] = true;
      }
      var free = [];
      for (var x = 0; x < GRID; x++) {
        for (var y = 0; y < GRID; y++) {
          if (!occupied[x + ',' + y]) free.push({ x: x, y: y });
        }
      }
      if (free.length === 0) {
        food = null;
        return false;
      }
      food = free[Math.floor(Math.random() * free.length)];
      return true;
    }

    /* Очередь направлений.
       Сравнение идёт с ПОСЛЕДНИМ запланированным направлением, а не только
       с текущим, поэтому быстрые последовательные свайпы не могут дать
       разворот на 180°. */
    function queueDirection(dir) {
      if (state !== 'running') return;
      if (!VEC[dir]) return;

      var last = dirQueue.length > 0 ? dirQueue[dirQueue.length - 1] : direction;
      if (dir === last) return;            // уже движемся туда
      if (OPPOSITE[dir] === last) return;  // разворот на себя — запрещён
      if (dirQueue.length >= MAX_DIR_QUEUE) return; // буфер полон — игнорируем

      dirQueue.push(dir);
    }

    /* Один шаг игры.
       Порядок: направление → новая голова → стена → самопересечение → рост/сдвиг.
       Клетка хвоста НЕ считается препятствием, если в этом шаге змейка не растёт,
       потому что хвост её освободит. При поедании еды хвост проверяется. */
    function step() {
      if (dirQueue.length > 0) {
        direction = dirQueue.shift();
      }

      var head = snake[snake.length - 1];
      var v = VEC[direction];
      var nx = head.x + v.x;
      var ny = head.y + v.y;

      // Столкновение со стеной
      if (nx < 0 || ny < 0 || nx >= GRID || ny >= GRID) {
        finishGame(false);
        return;
      }

      var willGrow = !!(food && food.x === nx && food.y === ny);

      // Столкновение с собой.
      // Если змейка не растёт, хвост (индекс 0) на этом шаге уйдёт — его не проверяем.
      var startIdx = willGrow ? 0 : 1;
      for (var i = startIdx; i < snake.length; i++) {
        if (snake[i].x === nx && snake[i].y === ny) {
          finishGame(false);
          return;
        }
      }

      snake.push({ x: nx, y: ny });

      if (willGrow) {
        score += 1;
        if (score > best) {
          best = score;
          recordBeaten = true;
          saveGameBest('snake', best);
        }
        speed = Math.min(MAX_SPEED, INITIAL_SPEED + score * SPEED_STEP);
        updateHud();

        if (!spawnFood()) {
          // Свободных клеток не осталось — победа
          finishGame(true);
          return;
        }
      } else {
        snake.shift();
      }
    }

    function finishGame(victory) {
      if (rafId) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }
      state = victory ? 'victory' : 'over';
      dirQueue.length = 0;
      touch = null;
      render();          // финальный кадр под оверлеем
      showOverlay(state);
      updatePauseButton();
    }

    /* =========================================================
       ИГРОВОЙ ЦИКЛ
       ========================================================= */
    function loop(timestamp) {
      if (state !== 'running') {
        rafId = null;
        return;
      }

      if (!lastTime) lastTime = timestamp;
      var delta = timestamp - lastTime;
      lastTime = timestamp;

      // Защита от огромного перерыва между кадрами (сильные подтормаживания).
      // Ограничиваем дельту вместо обнуления: змейка не «телепортируется»
      // (лимит в 5 шагов за кадр не даст наверстать слишком много),
      // но и не замирает полностью после одного длинного кадра.
      if (delta > 250) delta = 250;
      accumulator += delta;

      var tickMs = 1000 / speed;
      var safety = 0;
      while (accumulator >= tickMs && state === 'running' && safety < 5) {
        step();
        accumulator -= tickMs;
        safety++;
      }

      if (state === 'running') {
        render();
        rafId = requestAnimationFrame(loop);
      } else {
        rafId = null;
      }
    }

    function startLoop() {
      if (rafId) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }
      lastTime = 0;
      accumulator = 0;
      rafId = requestAnimationFrame(loop);
    }

    /* =========================================================
       ОТРИСОВКА
       ========================================================= */
    function roundRect(c, x, y, w, h, r) {
      if (w < 2 * r) r = w / 2;
      if (h < 2 * r) r = h / 2;
      c.beginPath();
      c.moveTo(x + r, y);
      c.arcTo(x + w, y,     x + w, y + h, r);
      c.arcTo(x + w, y + h, x,     y + h, r);
      c.arcTo(x,     y + h, x,     y,     r);
      c.arcTo(x,     y,     x + w, y,     r);
      c.closePath();
    }

    function render() {
      var cs = cellSize;
      var i;

      // Фон
      ctx.fillStyle = '#0a0a14';
      ctx.fillRect(0, 0, renderSize, renderSize);

      // Тонкая сетка
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.025)';
      ctx.lineWidth = 1;
      for (i = 1; i < GRID; i++) {
        var p = i * cs;
        ctx.beginPath();
        ctx.moveTo(p, 0);
        ctx.lineTo(p, renderSize);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(0, p);
        ctx.lineTo(renderSize, p);
        ctx.stroke();
      }

      // Еда
      if (food) {
        var pulse = 1 + Math.sin(performance.now() / 220) * 0.08;
        var fx = food.x * cs + cs / 2;
        var fy = food.y * cs + cs / 2;
        var fr = cs * 0.38 * pulse;

        var glow = ctx.createRadialGradient(fx, fy, 0, fx, fy, fr * 1.6);
        glow.addColorStop(0, 'rgba(239, 68, 68, 0.45)');
        glow.addColorStop(1, 'rgba(239, 68, 68, 0)');
        ctx.fillStyle = glow;
        ctx.beginPath();
        ctx.arc(fx, fy, fr * 1.6, 0, Math.PI * 2);
        ctx.fill();

        ctx.fillStyle = '#ef4444';
        ctx.beginPath();
        ctx.arc(fx, fy, fr, 0, Math.PI * 2);
        ctx.fill();

        ctx.fillStyle = 'rgba(255, 255, 255, 0.5)';
        ctx.beginPath();
        ctx.arc(fx - fr * 0.35, fy - fr * 0.35, fr * 0.28, 0, Math.PI * 2);
        ctx.fill();
      }

      // Змейка: от хвоста к голове
      for (i = 0; i < snake.length; i++) {
        var s = snake[i];
        var isHead = (i === snake.length - 1);
        var pad = cs * 0.12;

        var t = snake.length > 1 ? i / (snake.length - 1) : 0;
        var cr = Math.round(167 + (109 - 167) * t);
        var cg = Math.round(139 + (40  - 139) * t);
        var cb = Math.round(250 + (217 - 250) * t);
        ctx.fillStyle = 'rgb(' + cr + ',' + cg + ',' + cb + ')';

        roundRect(ctx, s.x * cs + pad, s.y * cs + pad, cs - pad * 2, cs - pad * 2, cs * 0.28);
        ctx.fill();

        if (isHead) {
          var hx = s.x * cs + cs / 2;
          var hy = s.y * cs + cs / 2;
          var eyeR = cs * 0.11;
          var ex1 = 0, ey1 = 0, ex2 = 0, ey2 = 0;
          if (direction === 'right') {
            ex1 =  cs * 0.26; ey1 = -cs * 0.22;
            ex2 =  cs * 0.26; ey2 =  cs * 0.22;
          } else if (direction === 'left') {
            ex1 = -cs * 0.26; ey1 = -cs * 0.22;
            ex2 = -cs * 0.26; ey2 =  cs * 0.22;
          } else if (direction === 'up') {
            ex1 = -cs * 0.22; ey1 = -cs * 0.26;
            ex2 =  cs * 0.22; ey2 = -cs * 0.26;
          } else {
            ex1 = -cs * 0.22; ey1 =  cs * 0.26;
            ex2 =  cs * 0.22; ey2 =  cs * 0.26;
          }
          ctx.fillStyle = '#0a0a14';
          ctx.beginPath();
          ctx.arc(hx + ex1, hy + ey1, eyeR, 0, Math.PI * 2);
          ctx.fill();
          ctx.beginPath();
          ctx.arc(hx + ex2, hy + ey2, eyeR, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }

    /* =========================================================
       УПРАВЛЕНИЕ
       ========================================================= */

    /* ----- Клавиатура (компьютер) ----- */
    function onKeyDown(e) {
      var key = e.key;
      var handled = true;

      switch (key) {
        case 'ArrowUp':    case 'w': case 'W': case 'ц': case 'Ц':
          queueDirection('up'); break;
        case 'ArrowDown':  case 's': case 'S': case 'ы': case 'Ы':
          queueDirection('down'); break;
        case 'ArrowLeft':  case 'a': case 'A': case 'ф': case 'Ф':
          queueDirection('left'); break;
        case 'ArrowRight': case 'd': case 'D': case 'в': case 'В':
          queueDirection('right'); break;
        case ' ': case 'Spacebar': case 'Escape':
          togglePause(); break;
        case 'Enter':
          if (state === 'ready' || state === 'over' || state === 'victory') startGame();
          else if (state === 'paused') resumeGame();
          break;
        default:
          handled = false;
      }

      if (handled && e.cancelable) e.preventDefault();
    }

    /* ----- Сенсор: свайпы и тапы ----- */
    function onTouchStart(e) {
      if (e.touches.length !== 1) { touch = null; return; }
      var t = e.touches[0];
      touch = {
        ax: t.clientX, ay: t.clientY,       // якорь для определения свайпа
        sx: t.clientX, sy: t.clientY,       // точка начала жеста (для тапа)
        lx: t.clientX, ly: t.clientY,       // последняя точка
        time: Date.now(),
        swiped: false
      };
    }

    function onTouchMove(e) {
      if (!touch) return;
      // Поле не должно прокручивать страницу
      if (e.cancelable) e.preventDefault();

      var t = e.touches[0];
      touch.lx = t.clientX;
      touch.ly = t.clientY;

      if (state !== 'running') return;

      var dx = t.clientX - touch.ax;
      var dy = t.clientY - touch.ay;
      var adx = Math.abs(dx);
      var ady = Math.abs(dy);

      if (Math.max(adx, ady) < SWIPE_THRESHOLD) return;

      if (adx > ady) queueDirection(dx > 0 ? 'right' : 'left');
      else           queueDirection(dy > 0 ? 'down'  : 'up');

      // Переставляем якорь: один непрерывный жест может задать
      // несколько последовательных поворотов
      touch.ax = t.clientX;
      touch.ay = t.clientY;
      touch.swiped = true;
    }

    function onTouchEnd(e) {
      if (!touch) return;

      var lastX = touch.lx;
      var lastY = touch.ly;
      if (e.changedTouches && e.changedTouches.length > 0) {
        lastX = e.changedTouches[0].clientX;
        lastY = e.changedTouches[0].clientY;
      }

      var moved = Math.max(Math.abs(lastX - touch.sx), Math.abs(lastY - touch.sy));
      var elapsed = Date.now() - touch.time;
      var wasTap = !touch.swiped && moved < TAP_MAX_MOVE && elapsed < TAP_MAX_TIME;

      touch = null;

      // Тап по полю ставит паузу только во время игры.
      // В остальных состояниях поле закрыто оверлеем, и касания
      // до canvas не доходят: пауза снимается тапом по фону
      // оверлея (см. onOverlayClick) или кнопкой «Продолжить».
      if (wasTap && state === 'running') {
        pauseGame();
      }
    }

    function onTouchCancel() {
      touch = null;
    }

    function onContextMenu(e) {
      // Убираем меню долгого нажатия на игровом поле
      e.preventDefault();
    }

    /* Тап по фону оверлея во время паузы — продолжить игру.
       Пока оверлей показан, само поле недоступно для касаний,
       поэтому обработчик тапа по canvas сюда не доходит. */
    function onOverlayClick(e) {
      if (state === 'paused' && e.target === overlay && !overlayJustShown()) {
        resumeGame();
      }
    }

    /* ----- Привязка / отвязка обработчиков ----- */
    function bindInputs() {
      if (inputsBound) return;
      inputsBound = true;

      window.addEventListener('keydown', onKeyDown);
      window.addEventListener('resize', onResize);
      window.addEventListener('orientationchange', onOrientationChange);

      canvas.addEventListener('touchstart',  onTouchStart,  { passive: true });
      canvas.addEventListener('touchmove',   onTouchMove,   { passive: false });
      canvas.addEventListener('touchend',    onTouchEnd,    { passive: true });
      canvas.addEventListener('touchcancel', onTouchCancel, { passive: true });

      arena.addEventListener('contextmenu', onContextMenu);
      overlay.addEventListener('click', onOverlayClick);
    }

    function unbindInputs() {
      if (!inputsBound) return;
      inputsBound = false;

      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('resize', onResize);
      window.removeEventListener('orientationchange', onOrientationChange);

      canvas.removeEventListener('touchstart',  onTouchStart);
      canvas.removeEventListener('touchmove',   onTouchMove);
      canvas.removeEventListener('touchend',    onTouchEnd);
      canvas.removeEventListener('touchcancel', onTouchCancel);

      arena.removeEventListener('contextmenu', onContextMenu);
      overlay.removeEventListener('click', onOverlayClick);
    }

    /* =========================================================
       ПУБЛИЧНОЕ ПОВЕДЕНИЕ
       ========================================================= */
    function startGame() {
      // Идемпотентно: даже при двойном срабатывании цикла не будет два
      resetParty();
      state = 'running';
      hideOverlay();
      updatePauseButton();
      startLoop();
    }

    function pauseGame() {
      if (state !== 'running') return;
      state = 'paused';
      if (rafId) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }
      dirQueue.length = 0;
      touch = null;
      showOverlay('paused');
      updatePauseButton();
    }

    function resumeGame() {
      if (state !== 'paused') return;
      state = 'running';
      hideOverlay();
      updatePauseButton();
      startLoop();
    }

    function togglePause() {
      if (state === 'running') pauseGame();
      else if (state === 'paused') resumeGame();
    }

    /* Вход на экран игры */
    function enter() {
      bindInputs();
      layout();
      resetParty();
      state = 'ready';
      showOverlay('ready');
      updatePauseButton();
      render();
    }

    /* Уход с экрана игры: полностью останавливаем цикл и снимаем слушатели */
    function leave() {
      if (rafId) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }
      if (layoutTimer) {
        clearTimeout(layoutTimer);
        layoutTimer = null;
      }
      state = 'ready';
      dirQueue.length = 0;
      touch = null;
      unbindInputs();
    }

    /* Автопауза при сворачивании приложения / блокировке экрана */
    function autoPauseIfRunning() {
      if (state === 'running') pauseGame();
    }

    return {
      enter: enter,
      leave: leave,
      start: startGame,
      pause: pauseGame,
      resume: resumeGame,
      togglePause: togglePause,
      setDirection: queueDirection,
      autoPauseIfRunning: autoPauseIfRunning,
      overlayJustShown: overlayJustShown,
      isRunning: function () { return state === 'running'; }
    };
  }

  /* =========================================================
     ОБЩАЯ НАВИГАЦИЯ
     ========================================================= */

  function init() {
    try {
      window.history.replaceState({ screen: 'screen-home' }, '', '');
    } catch (e) {
      // В file:// окружении history может быть недоступен
    }

    renderGames();
    bindGlobalEvents();
    registerServiceWorker();
  }

  function renderGames() {
    var grid = document.getElementById('games-grid');
    if (!grid) return;

    var html = '';
    for (var i = 0; i < GAMES.length; i++) {
      var g = GAMES[i];
      var cls = 'game-card';
      if (g.status === 'available') cls += ' active-game';
      else cls += ' coming-soon';

      var badge = g.status === 'available' ? 'Играй' : 'Скоро';

      html +=
        '<button class="' + cls + '" data-game="' + g.id + '">' +
          '<span class="card-badge">' + badge + '</span>' +
          '<span class="card-icon" aria-hidden="true">' + g.icon + '</span>' +
          '<span class="card-title">' + g.title + '</span>' +
          '<span class="card-desc">' + g.description + '</span>' +
        '</button>';
    }
    grid.innerHTML = html;
  }

  function showScreen(screenId, addToHistory) {
    if (addToHistory === undefined) addToHistory = true;
    if (screenId === currentScreenId) return;

    var target = document.getElementById(screenId);
    if (!target) return;

    var previous = currentScreenId;

    var active = document.querySelector('.screen.active');
    if (active) active.classList.remove('active');

    target.classList.add('active');

    if (addToHistory) {
      try {
        window.history.pushState({ screen: screenId }, '', '');
      } catch (e) {}
    }

    // Уход с экрана Змейки — игра полностью останавливается
    if (previous === 'screen-snake' && snakeGame) {
      snakeGame.leave();
    }

    // Вход на экран Змейки — игра инициализируется заново
    if (screenId === 'screen-snake') {
      if (!snakeGame) snakeGame = createSnakeGame();
      if (snakeGame) snakeGame.enter();
    }

    currentScreenId = screenId;
  }

  function goBack() {
    if (window.history.length > 1) {
      window.history.back();
    } else {
      showScreen('screen-home', false);
    }
  }

  function onPopState(e) {
    var st = e.state;
    if (st && typeof st.screen === 'string') {
      showScreen(st.screen, false);
    } else {
      showScreen('screen-home', false);
    }
  }

  /* Автопауза при потере видимости страницы */
  function onVisibilityChange() {
    if (document.hidden && currentScreenId === 'screen-snake' && snakeGame) {
      snakeGame.autoPauseIfRunning();
    }
  }

  /* Единый обработчик кликов (делегирование, навешивается один раз) */
  function handleAction(target) {
    if (!target || !target.closest) return;

    var actionEl = target.closest('[data-action]');
    if (actionEl) {
      var action = actionEl.getAttribute('data-action');
      switch (action) {
        case 'show-games':    showScreen('screen-games');    return;
        case 'show-menu':     showScreen('screen-menu');     return;
        case 'show-records':  showScreen('screen-records');  return;
        case 'show-settings': showScreen('screen-settings'); return;
        case 'go-home':       showScreen('screen-home');     return;
        case 'go-back':       goBack();                      return;
        case 'snake-start':
          // Защита от «фантомного» клика сразу после показа оверлея
          if (snakeGame && !snakeGame.overlayJustShown()) snakeGame.start();
          return;
        case 'snake-resume':
          if (snakeGame && !snakeGame.overlayJustShown()) snakeGame.resume();
          return;
        case 'snake-pause':
          if (snakeGame) snakeGame.togglePause();
          return;
      }
      return;
    }

    // Карточка игры в списке
    var card = target.closest('.game-card');
    if (card) {
      var gameId = card.getAttribute('data-game');
      var game = null;
      for (var i = 0; i < GAMES.length; i++) {
        if (GAMES[i].id === gameId) { game = GAMES[i]; break; }
      }
      if (game && game.status === 'available' && game.screenId) {
        showScreen(game.screenId);
      }
      // Игры со статусом 'soon' намеренно не открываются
    }
  }

  function bindGlobalEvents() {
    document.addEventListener('click', function (e) {
      handleAction(e.target);
    });

    window.addEventListener('popstate', onPopState);
    document.addEventListener('visibilitychange', onVisibilityChange);

    // Не даём выделять текст при быстром тапе по кнопкам
    document.addEventListener('selectstart', function (e) {
      if (e.target && e.target.closest && e.target.closest('button')) {
        e.preventDefault();
      }
    });
  }

  /* =========================================================
     SERVICE WORKER
     ========================================================= */
  function registerServiceWorker() {
    if (!('serviceWorker' in navigator)) return;
    // SW не работает с file:// — просто пропускаем регистрацию
    if (window.location.protocol === 'file:') return;

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

  /* ----- Старт ----- */
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();