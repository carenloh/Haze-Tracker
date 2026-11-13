/* Haze Tracker service worker: offline shell, background checks, notification clicks. */
importScripts('lib.js');

var SHELL_CACHE = 'haze-shell-v1';
var SHELL = [
  './',
  'index.html',
  'styles.css',
  'app.js',
  'lib.js',
  'manifest.webmanifest',
  'icons/icon.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/apple-touch-icon.png',
  'icons/favicon-32.png'
];

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(SHELL_CACHE).then(function (c) { return c.addAll(SHELL); })
      .then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (k) {
        // keep the current shell cache and the settings/state cache
        if (k !== SHELL_CACHE && k !== 'haze-state-v1') return caches.delete(k);
      }));
    }).then(function () { return self.clients.claim(); })
  );
});

// Same-origin GETs: network first, fall back to cache so the app opens offline.
// API calls go straight to the network (the page keeps its own last-known data).
self.addEventListener('fetch', function (event) {
  var req = event.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  event.respondWith(
    fetch(req).then(function (res) {
      var copy = res.clone();
      caches.open(SHELL_CACHE).then(function (c) { c.put(req, copy); });
      return res;
    }).catch(function () {
      return caches.match(req).then(function (hit) { return hit || caches.match('index.html'); });
    })
  );
});

// Check readings and notify. Used by background sync and by the page's "check now".
function checkAndNotify() {
  return Promise.all([HazeLib.store.get('settings'), HazeLib.store.get('prevAbove')])
    .then(function (r) {
      var settings = r[0];
      var prev = r[1] ? r[1].value : null;
      if (!settings || !settings.enabled) return;
      return HazeLib.fetchModel(self.fetch.bind(self)).then(function (model) {
        var result = HazeLib.evaluateAlert(settings, model, prev);
        return HazeLib.store.set('prevAbove', { value: result.above })
          .then(function () {
            if (!result.notify) return;
            return self.registration.showNotification(result.title, {
              body: result.body,
              icon: 'icons/icon-192.png',
              badge: 'icons/favicon-32.png',
              tag: 'haze-alert',
              renotify: true,
              data: { url: './' }
            });
          });
      });
    }).catch(function () { /* offline or API hiccup: try again next time */ });
}

// Chrome on Android fires this for installed PWAs (at most about once an hour or less).
self.addEventListener('periodicsync', function (event) {
  if (event.tag === 'haze-check') event.waitUntil(checkAndNotify());
});

self.addEventListener('notificationclick', function (event) {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (list) {
      for (var i = 0; i < list.length; i++) {
        if ('focus' in list[i]) return list[i].focus();
      }
      return self.clients.openWindow('./');
    })
  );
});
