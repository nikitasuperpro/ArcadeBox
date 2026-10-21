/* =========================================================
   Service Worker для ArcadeBox
   Версия v12 — фоновая музыка (ArcadeBox 0.8)
   Пути относительные — корректно работают в подпапке
   (GitHub Pages: https://user.github.io/repo/)

   ВАЖНО: при любом изменении app.js, style.css, index.html
   и других файлов приложения увеличивай номер в CACHE_NAME,
   иначе стратегия «сначала кеш» будет отдавать старые файлы.
   Новые файлы приложения (скрипты, шрифты) нужно добавлять
   в CORE_ASSETS, иначе они не будут доступны без сети.

   Музыка (audio/*.mp3) живёт в отдельном кеше AUDIO_CACHE:
   тяжёлые файлы не перекачиваются при каждом обновлении кода.
   Если ЗАМЕНИШЬ или ДОБАВИШЬ mp3 — обнови AUDIO_ASSETS и
   увеличь номер в AUDIO_CACHE (v1 -> v2), иначе пользователи
   продолжат слышать старые файлы.
   ========================================================= */

var CACHE_PREFIX = 'arcadebox-cache';
var CACHE_NAME = CACHE_PREFIX + '-v12';

var AUDIO_CACHE_PREFIX = 'arcadebox-audio';
var AUDIO_CACHE = AUDIO_CACHE_PREFIX + '-v1';

/* Фоновая музыка. Кешируется «по возможности»: если файл не скачался,
   установка Service Worker не ломается, а трек доберётся при первом
   воспроизведении (см. serveAudio). Пути должны совпадать с PLAYLIST в app.js */
var AUDIO_ASSETS = [
  './audio/pixel-rush.mp3',
  './audio/neon-pixels.mp3',
  './audio/arcade-core.mp3'
];

/* Обязательные файлы: если хотя бы один не загрузился,
   установка завершается неудачно и старая версия продолжает работать */
var CORE_ASSETS = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './manifest.json'
];

/* Необязательные файлы (иконки): кешируются «по возможности».
   Если файла нет на сервере, установка Service Worker не ломается */
var OPTIONAL_ASSETS = [
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png'
];

/* Запрос в обход HTTP-кеша браузера: иначе в новый кеш могла бы
   попасть устаревшая копия файла (например, с GitHub Pages) */
function fetchFresh(url) {
  return fetch(new Request(url, { cache: 'reload' })).then(function (response) {
    if (!response || !response.ok) {
      throw new Error('ArcadeBox SW: не удалось загрузить ' + url);
    }
    return response;
  });
}

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE_NAME).then(function (cache) {
      var core = CORE_ASSETS.map(function (url) {
        // Ошибка НЕ подавляется: обязательные файлы должны быть в кеше
        return fetchFresh(url).then(function (response) {
          return cache.put(url, response);
        });
      });
      var optional = OPTIONAL_ASSETS.map(function (url) {
        return fetchFresh(url).then(function (response) {
          return cache.put(url, response);
        }).catch(function () { /* необязательный файл — пропускаем */ });
      });
      return Promise.all(core.concat(optional));
    }).then(function () {
      return caches.open(AUDIO_CACHE).then(function (audioCache) {
        return Promise.all(AUDIO_ASSETS.map(function (url) {
          return audioCache.match(url).then(function (hit) {
            if (hit) return;                       // уже есть — не качаем снова
            return fetchFresh(url).then(function (response) {
              return audioCache.put(url, response);
            }).catch(function () { /* докачается при первом воспроизведении */ });
          });
        }));
      }).catch(function () { /* аудио не должно ломать установку */ });
    }).then(function () {
      return self.skipWaiting();
    })
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (names) {
      // Только собственные кеши ArcadeBox
      var own = names.filter(function (name) {
        return name.indexOf(CACHE_PREFIX) === 0;
      });
      var stale = own.filter(function (name) { return name !== CACHE_NAME; });
      var staleAudio = names.filter(function (name) {
        return name.indexOf(AUDIO_CACHE_PREFIX) === 0 && name !== AUDIO_CACHE;
      });

      return Promise.all(stale.concat(staleAudio).map(function (name) {
        return caches.delete(name);
      })).then(function () {
        return self.clients.claim();
      }).then(function () {
        // UPDATED отправляем только при настоящем обновлении (был старый кеш).
        // При первой установке перезагрузка страницы не нужна.
        if (stale.length === 0) return;
        return self.clients.matchAll({ type: 'window' }).then(function (clients) {
          clients.forEach(function (client) {
            client.postMessage({ type: 'UPDATED' });
          });
        });
      });
    })
  );
});

self.addEventListener('message', function (event) {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', function (event) {
  var request = event.request;
  if (request.method !== 'GET') return;
  // Чужие домены не трогаем
  var reqUrl = new URL(request.url);
  if (reqUrl.origin !== self.location.origin) return;

  // Музыка: отдельный кеш + поддержка Range-запросов (нужна <audio>, особенно Safari)
  if (/\/audio\/[^/]+\.mp3$/i.test(reqUrl.pathname)) {
    event.respondWith(serveAudio(request));
    return;
  }

  event.respondWith(
    caches.match(request, { ignoreSearch: request.mode === 'navigate' })
      .then(function (cached) {
        if (cached) return cached;
        return fetch(request).catch(function () {
          if (request.mode === 'navigate') {
            return caches.match('./index.html');
          }
          return new Response('ArcadeBox: нет соединения.', {
            status: 503,
            statusText: 'Offline',
            headers: { 'Content-Type': 'text/plain; charset=utf-8' }
          });
        });
      })
  );
});

/* ---------- Музыка ---------- */

/* Из полного ответа (200) делает частичный (206), если браузер просил Range */
function withRange(request, response) {
  var header = request.headers.get('range');
  if (!header || !response || response.status !== 200) return response;
  var m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === '' && m[2] === '')) return response;
  var type = response.headers.get('Content-Type') || 'audio/mpeg';
  return response.arrayBuffer().then(function (buf) {
    var size = buf.byteLength, start, end;
    if (m[1] === '') {                       // bytes=-N : последние N байт
      start = Math.max(0, size - Number(m[2]));
      end = size - 1;
    } else {
      start = Number(m[1]);
      end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
    }
    if (start >= size || start > end) {
      return new Response('', {
        status: 416, statusText: 'Range Not Satisfiable',
        headers: { 'Content-Range': 'bytes */' + size }
      });
    }
    return new Response(buf.slice(start, end + 1), {
      status: 206, statusText: 'Partial Content',
      headers: {
        'Content-Type': type,
        'Content-Length': String(end - start + 1),
        'Content-Range': 'bytes ' + start + '-' + end + '/' + size,
        'Accept-Ranges': 'bytes'
      }
    });
  });
}

/* Сначала кеш музыки; если трека там нет — загружаем целиком и кладём в кеш */
function serveAudio(request) {
  var url = request.url;
  return caches.open(AUDIO_CACHE).then(function (cache) {
    return cache.match(url).then(function (hit) {
      if (hit) return hit;
      return fetch(url).then(function (response) {
        if (response && response.status === 200) {
          cache.put(url, response.clone()).catch(function () {});
        }
        return response;
      });
    });
  }).then(function (response) {
    return withRange(request, response);
  }).catch(function () {
    return new Response('ArcadeBox: музыка недоступна без соединения.', {
      status: 503,
      statusText: 'Offline',
      headers: { 'Content-Type': 'text/plain; charset=utf-8' }
    });
  });
}
