/* =========================================================
   Service Worker для ArcadeBox
   Версия v4 — финальная доработка «Змейки»
   ========================================================= */

var CACHE_NAME = 'arcadebox-cache-v4';

// Файлы, которые всегда нужны для запуска приложения
var CORE_ASSETS = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './manifest.json'
];

/* ---------- Install: кладём основные файлы в кеш ---------- */
self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(function (cache) {
        return cache.addAll(CORE_ASSETS);
      })
      .then(function () {
        // Активируем SW сразу, не дожидаясь закрытия старой вкладки
        return self.skipWaiting();
      })
      .catch(function (err) {
        console.warn('SW install: не удалось закешировать ресурсы —', err);
      })
  );
});

/* ---------- Activate: удаляем старые кеши ---------- */
self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (names) {
      return Promise.all(
        names.filter(function (name) {
          return name !== CACHE_NAME;
        }).map(function (name) {
          return caches.delete(name);
        })
      );
    }).then(function () {
      return self.clients.claim();
    })
  );
});

/* ---------- Fetch: сначала кеш, потом сеть ---------- */
self.addEventListener('fetch', function (event) {
  var request = event.request;

  // Игнорируем не-GET запросы
  if (request.method !== 'GET') return;

  event.respondWith(
    caches.match(request)
      .then(function (cached) {
        if (cached) return cached;

        return fetch(request).catch(function () {
          // Офлайн и ресурс не в кеше
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