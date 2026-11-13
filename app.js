(function () {
  'use strict';

  var L = window.HazeLib;
  var LS_SETTINGS = 'haze-settings';
  var LS_MODEL = 'haze-model';
  var POLL_MS = 5 * 60 * 1000;

  var $ = function (id) { return document.getElementById(id); };
  var els = {
    updated: $('updated'), refresh: $('refresh'), banner: $('banner'),
    overall: $('overall'), regions: $('regions'),
    enabled: $('enabled'), region: $('region'), metric: $('metric'),
    threshold: $('threshold'), thresholdNum: $('threshold-num'),
    thresholdOut: $('threshold-out'), thresholdBand: $('threshold-band'),
    test: $('test'), notifStatus: $('notif-status'),
    install: $('install'), installText: $('install-text')
  };

  var model = null;
  var settings = loadSettings();
  var lastFetch = 0;
  var deferredInstall = null;

  /* ---------- helpers ---------- */

  function h(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  function loadSettings() {
    try {
      var s = JSON.parse(localStorage.getItem(LS_SETTINGS));
      if (s && typeof s === 'object') return Object.assign({}, L.DEFAULT_SETTINGS, s);
    } catch (e) {}
    return Object.assign({}, L.DEFAULT_SETTINGS);
  }

  function saveSettings() {
    try { localStorage.setItem(LS_SETTINGS, JSON.stringify(settings)); } catch (e) {}
    // mirror for the service worker (it cannot read localStorage)
    return L.store.set('settings', settings);
  }

  function loadCachedModel() {
    try { return JSON.parse(localStorage.getItem(LS_MODEL)); } catch (e) { return null; }
  }

  function fmtTime(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d)) return '';
    return d.toLocaleTimeString('en-SG', { hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Singapore' });
  }

  function notifSupported() { return 'Notification' in window; }
  function notifPermission() { return notifSupported() ? Notification.permission : 'unsupported'; }

  function isStandalone() {
    return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
  }
  function isIOS() { return /iphone|ipad|ipod/i.test(navigator.userAgent); }

  /* ---------- rendering ---------- */

  function metricEl(label, value, pm25) {
    var b = L.band(value);
    var m = h('div', 'metric');
    m.appendChild(h('span', 'label', label));
    if (!b) {
      m.classList.add('empty');
      m.appendChild(h('span', 'value', '–'));
      m.appendChild(h('span', 'desc', 'No data'));
      return m;
    }
    m.style.background = b.color;
    if (b.key === 'very' || b.key === 'hazardous') m.classList.add('light-text');
    m.appendChild(h('span', 'value', String(value)));
    m.appendChild(h('span', 'desc', b.label));
    if (pm25 !== undefined && pm25 !== null) m.title = '1-hr PM2.5: ' + pm25 + ' µg/m³';
    return m;
  }

  function regionCard(key, hero) {
    var r = model.regions[key];
    var card = hero ? els.overall : h('article', 'card region');
    card.textContent = '';
    card.appendChild(h('div', 'name', hero ? 'Singapore (highest region)' : L.regionLabel(key)));
    var m = h('div', 'metrics');
    m.appendChild(metricEl('1-hr PSI*', r.psi1, r.pm25));
    m.appendChild(metricEl('24-hr PSI', r.psi24));
    card.appendChild(m);
    return card;
  }

  function render() {
    if (!model) {
      els.overall.textContent = '';
      els.regions.textContent = '';
      return;
    }
    regionCard(L.OVERALL, true);
    els.regions.textContent = '';
    L.REGIONS.forEach(function (k) { els.regions.appendChild(regionCard(k, false)); });

    var t = fmtTime(model.updated);
    els.updated.textContent = (t ? 'Readings for ' + t + ' SGT' : 'Readings loaded') +
      (lastFetch ? ' · checked ' + fmtTime(new Date(lastFetch).toISOString()) : '');
  }

  function showBanner(msg) {
    els.banner.hidden = !msg;
    els.banner.textContent = msg || '';
  }

  function renderSettings() {
    els.enabled.checked = !!settings.enabled;
    els.region.value = settings.region;
    els.metric.value = settings.metric;
    els.threshold.value = settings.threshold;
    els.thresholdNum.value = settings.threshold;
    els.thresholdOut.textContent = settings.threshold;
    var b = L.band(settings.threshold);
    els.thresholdBand.textContent = b ? 'That is in the “' + b.label + '” range.' : '';
    renderNotifStatus();
  }

  function renderNotifStatus() {
    var p = notifPermission();
    var msg;
    if (p === 'unsupported') {
      msg = isIOS() && !isStandalone()
        ? 'On iPhone/iPad, add this app to your Home Screen first (iOS 16.4 or later), then open it from there to turn on alerts.'
        : 'This browser does not support notifications.';
      els.enabled.disabled = true;
      els.test.disabled = true;
    } else if (p === 'denied') {
      msg = 'Notifications are blocked. Allow them for this site in your browser or phone settings, then try again.';
      els.test.disabled = true;
    } else if (p === 'default') {
      msg = 'Turn the switch on to allow notifications.';
      els.test.disabled = false;
    } else {
      msg = settings.enabled
        ? 'Alerts on. Readings are checked every 5 minutes while the app is open. ' +
          (bgSyncSupported ? 'Background checks while the app is closed are also requested, but your phone decides when they run.'
                           : 'This browser cannot check in the background, so keep the app open to get alerts.')
        : 'Notifications are allowed. Switch alerts on to be notified.';
      els.test.disabled = false;
    }
    els.notifStatus.textContent = msg;
  }

  /* ---------- notifications ---------- */

  var bgSyncSupported = false;

  function showNotification(title, body) {
    var opts = {
      body: body, icon: 'icons/icon-192.png', badge: 'icons/favicon-32.png',
      tag: 'haze-alert', renotify: true, data: { url: './' }
    };
    if ('serviceWorker' in navigator) {
      return navigator.serviceWorker.ready.then(function (reg) { return reg.showNotification(title, opts); });
    }
    new Notification(title, opts);
    return Promise.resolve();
  }

  function checkAlerts() {
    if (!model || !settings.enabled || notifPermission() !== 'granted') return Promise.resolve();
    return L.store.get('prevAbove').then(function (prev) {
      var result = L.evaluateAlert(settings, model, prev ? prev.value : null);
      return L.store.set('prevAbove', { value: result.above }).then(function () {
        if (result.notify) return showNotification(result.title, result.body);
      });
    });
  }

  function updateBackgroundSync() {
    if (!('serviceWorker' in navigator)) return Promise.resolve();
    return navigator.serviceWorker.ready.then(function (reg) {
      if (!('periodicSync' in reg)) { bgSyncSupported = false; return; }
      bgSyncSupported = true;
      var want = settings.enabled && notifPermission() === 'granted';
      return (want
        ? reg.periodicSync.register('haze-check', { minInterval: 60 * 60 * 1000 })
        : reg.periodicSync.unregister('haze-check')
      ).catch(function () { bgSyncSupported = false; });
    }).catch(function () {}).then(renderNotifStatus);
  }

  /* ---------- data ---------- */

  function refresh(manual) {
    els.refresh.classList.add('spin');
    return L.fetchModel().then(function (m) {
      model = m;
      lastFetch = Date.now();
      try { localStorage.setItem(LS_MODEL, JSON.stringify(m)); } catch (e) {}
      showBanner('');
      render();
      return checkAlerts();
    }).catch(function () {
      showBanner(model
        ? 'Could not reach NEA just now. Showing the last saved readings.'
        : 'Could not load readings. Check your connection and tap ↻ to retry.');
    }).then(function () {
      els.refresh.classList.remove('spin');
    });
  }

  /* ---------- events ---------- */

  function buildRegionOptions() {
    [L.OVERALL].concat(L.REGIONS).forEach(function (k) {
      var o = document.createElement('option');
      o.value = k;
      o.textContent = L.regionLabel(k);
      els.region.appendChild(o);
    });
  }

  function settingsChanged() {
    // restart crossing detection so the new threshold/region is evaluated fresh
    return saveSettings()
      .then(function () { return L.store.set('prevAbove', { value: null }); })
      .then(checkAlerts);
  }

  function clampThreshold(v) {
    v = parseInt(v, 10);
    if (isNaN(v)) return settings.threshold;
    return Math.max(1, Math.min(500, v));
  }

  els.enabled.addEventListener('change', function () {
    if (!els.enabled.checked) {
      settings.enabled = false;
      renderSettings();
      settingsChanged().then(updateBackgroundSync);
      return;
    }
    if (!notifSupported()) { els.enabled.checked = false; renderNotifStatus(); return; }
    var ask = Notification.permission === 'default'
      ? Notification.requestPermission()
      : Promise.resolve(Notification.permission);
    Promise.resolve(ask).then(function (p) {
      if (p !== 'granted') {
        els.enabled.checked = false;
        settings.enabled = false;
        renderSettings();
        return;
      }
      settings.enabled = true;
      renderSettings();
      return settingsChanged().then(updateBackgroundSync);
    });
  });

  els.region.addEventListener('change', function () { settings.region = els.region.value; renderSettings(); settingsChanged(); });
  els.metric.addEventListener('change', function () { settings.metric = els.metric.value; renderSettings(); settingsChanged(); });

  els.threshold.addEventListener('input', function () {
    settings.threshold = clampThreshold(els.threshold.value);
    els.thresholdNum.value = settings.threshold;
    els.thresholdOut.textContent = settings.threshold;
  });
  els.threshold.addEventListener('change', function () { renderSettings(); settingsChanged(); });
  els.thresholdNum.addEventListener('change', function () {
    settings.threshold = clampThreshold(els.thresholdNum.value);
    renderSettings();
    settingsChanged();
  });

  els.test.addEventListener('click', function () {
    if (!notifSupported()) return;
    var ask = Notification.permission === 'default' ? Notification.requestPermission() : Promise.resolve(Notification.permission);
    Promise.resolve(ask).then(function (p) {
      renderNotifStatus();
      if (p === 'granted') showNotification('Haze Tracker test', 'Notifications are working. You will be alerted at PSI ' + settings.threshold + '.');
    });
  });

  els.refresh.addEventListener('click', function () { refresh(true); });

  document.addEventListener('visibilitychange', function () {
    if (!document.hidden && Date.now() - lastFetch > 2 * 60 * 1000) refresh(false);
  });
  setInterval(function () { if (!document.hidden) refresh(false); }, POLL_MS);

  /* ---------- install ---------- */

  function renderInstall() {
    if (isStandalone()) {
      els.installText.textContent = 'You are using the installed app.';
      els.install.hidden = true;
    } else if (deferredInstall) {
      els.installText.textContent = 'Install Haze Tracker for one-tap access and to receive alerts like a regular app.';
      els.install.hidden = false;
    } else if (isIOS()) {
      els.installText.textContent = 'In Safari, tap the Share button, then “Add to Home Screen”. Open the app from the Home Screen to use notifications.';
      els.install.hidden = true;
    } else {
      els.installText.textContent = 'Open your browser menu and choose “Install app” or “Add to Home screen”.';
      els.install.hidden = true;
    }
  }

  window.addEventListener('beforeinstallprompt', function (e) {
    e.preventDefault();
    deferredInstall = e;
    renderInstall();
  });
  window.addEventListener('appinstalled', function () { deferredInstall = null; renderInstall(); });
  els.install.addEventListener('click', function () {
    if (!deferredInstall) return;
    deferredInstall.prompt();
    deferredInstall.userChoice.then(function () { deferredInstall = null; renderInstall(); });
  });

  /* ---------- start ---------- */

  buildRegionOptions();
  model = loadCachedModel();
  render();
  renderSettings();
  renderInstall();
  saveSettings();

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').then(updateBackgroundSync).catch(function () {});
  }

  refresh(false);
})();
