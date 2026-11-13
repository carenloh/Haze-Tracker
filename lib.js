/*
 * Shared logic for the page and the service worker (no DOM access here).
 * Loaded with <script> in the page, importScripts() in the service worker,
 * and require() in the Node tests.
 */
(function (root) {
  'use strict';

  var API_BASE = 'https://api-open.data.gov.sg/v2/real-time/api';
  var REGIONS = ['north', 'south', 'east', 'west', 'central'];
  var OVERALL = 'overall'; // highest of the five regions (how NEA reports the national PSI)

  // NEA PSI descriptors
  var BANDS = [
    { max: 50,  key: 'good',      label: 'Good',           color: '#4caf7d' },
    { max: 100, key: 'moderate',  label: 'Moderate',       color: '#e6c229' },
    { max: 200, key: 'unhealthy', label: 'Unhealthy',      color: '#f08a3c' },
    { max: 300, key: 'very',      label: 'Very unhealthy', color: '#e0463f' },
    { max: Infinity, key: 'hazardous', label: 'Hazardous', color: '#9b2f8f' }
  ];

  function band(psi) {
    if (typeof psi !== 'number' || isNaN(psi)) return null;
    for (var i = 0; i < BANDS.length; i++) if (psi <= BANDS[i].max) return BANDS[i];
    return BANDS[BANDS.length - 1];
  }

  // NEA publishes the 24-hr PSI and the 1-hr PM2.5 concentration, but no hourly PSI.
  // We estimate a 1-hr PSI by applying NEA's PM2.5 sub-index breakpoints to the 1-hr reading.
  var PM25_BREAKS = [
    // [conc low, conc high, index low, index high]
    [0,   12,  0,   50],
    [13,  55,  51,  100],
    [56,  150, 101, 200],
    [151, 250, 201, 300],
    [251, 350, 301, 400],
    [351, 500, 401, 500]
  ];

  function pm25ToPsi(c) {
    if (typeof c !== 'number' || isNaN(c) || c < 0) return null;
    c = Math.round(c);
    if (c > 500) return 500;
    for (var i = 0; i < PM25_BREAKS.length; i++) {
      var b = PM25_BREAKS[i];
      if (c >= b[0] && c <= b[1]) {
        return Math.round(b[2] + (c - b[0]) * (b[3] - b[2]) / (b[1] - b[0]));
      }
    }
    return null;
  }

  function maxOf(map) {
    var m = null;
    REGIONS.forEach(function (r) {
      var v = map && map[r];
      if (typeof v === 'number' && (m === null || v > m)) m = v;
    });
    return m;
  }

  /**
   * Turn the two API payloads into a flat model:
   * { updated: ISO string, regions: { north: {psi24, pm25, psi1}, ..., overall: {...} } }
   */
  function buildModel(psiJson, pm25Json) {
    var psiItem = psiJson && psiJson.data && psiJson.data.items && psiJson.data.items[0];
    var pmItem = pm25Json && pm25Json.data && pm25Json.data.items && pm25Json.data.items[0];
    if (!psiItem || !psiItem.readings) throw new Error('Unexpected PSI response');
    var psi24 = psiItem.readings.psi_twenty_four_hourly || {};
    var pm1 = (pmItem && pmItem.readings && pmItem.readings.pm25_one_hourly) || {};

    var regions = {};
    REGIONS.forEach(function (r) {
      regions[r] = {
        psi24: typeof psi24[r] === 'number' ? psi24[r] : null,
        pm25: typeof pm1[r] === 'number' ? pm1[r] : null,
        psi1: pm25ToPsi(pm1[r])
      };
    });
    var overall = { psi24: null, pm25: null, psi1: null };
    REGIONS.forEach(function (r) {
      ['psi24', 'pm25', 'psi1'].forEach(function (k) {
        var v = regions[r][k];
        if (v !== null && (overall[k] === null || v > overall[k])) overall[k] = v;
      });
    });
    regions[OVERALL] = overall;

    return {
      updated: psiItem.updatedTimestamp || psiItem.timestamp || null,
      pmUpdated: (pmItem && (pmItem.updatedTimestamp || pmItem.timestamp)) || null,
      regions: regions
    };
  }

  function fetchJson(url, fetchImpl) {
    return fetchImpl(url, { cache: 'no-store' }).then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    });
  }

  function fetchModel(fetchImpl) {
    fetchImpl = fetchImpl || root.fetch.bind(root);
    var psiP = fetchJson(API_BASE + '/psi', fetchImpl);
    // A PM2.5 failure should not take the 24-hr PSI down with it.
    var pmP = fetchJson(API_BASE + '/pm25', fetchImpl).catch(function () { return null; });
    return Promise.all([psiP, pmP]).then(function (r) { return buildModel(r[0], r[1]); });
  }

  var DEFAULT_SETTINGS = {
    enabled: false,
    region: OVERALL,
    metric: 'psi1',   // 'psi1' | 'psi24'
    threshold: 100
  };

  function metricLabel(m) { return m === 'psi24' ? '24-hr PSI' : '1-hr PSI'; }
  function regionLabel(r) { return r === OVERALL ? 'Singapore (highest region)' : r.charAt(0).toUpperCase() + r.slice(1); }

  /**
   * Decide whether to notify.
   * prevAbove: true / false / null (null = no earlier reading, first run)
   * An alert fires when the reading is at or above the threshold and wasn't before.
   */
  function evaluateAlert(settings, model, prevAbove) {
    var s = settings || DEFAULT_SETTINGS;
    var reg = model && model.regions && model.regions[s.region];
    var value = reg ? reg[s.metric] : null;
    if (!s.enabled || value === null || value === undefined) {
      return { value: null, above: prevAbove, notify: false };
    }
    var above = value >= s.threshold;
    var notify = above && prevAbove !== true;
    var b = band(value);
    return {
      value: value,
      above: above,
      notify: notify,
      title: 'Haze alert: PSI ' + value + (b ? ' (' + b.label + ')' : ''),
      body: regionLabel(s.region) + ' ' + metricLabel(s.metric) + ' is ' + value +
            ', at or above your threshold of ' + s.threshold + '.'
    };
  }

  // Tiny key/value store on the Cache API. Works from both the page and the service worker.
  var STATE_CACHE = 'haze-state-v1';
  var store = {
    get: function (key) {
      return caches.open(STATE_CACHE)
        .then(function (c) { return c.match('/__state/' + key); })
        .then(function (res) { return res ? res.json() : null; })
        .catch(function () { return null; });
    },
    set: function (key, value) {
      return caches.open(STATE_CACHE).then(function (c) {
        return c.put('/__state/' + key, new Response(JSON.stringify(value), {
          headers: { 'Content-Type': 'application/json' }
        }));
      }).catch(function () {});
    }
  };

  var api = {
    API_BASE: API_BASE, REGIONS: REGIONS, OVERALL: OVERALL, BANDS: BANDS,
    DEFAULT_SETTINGS: DEFAULT_SETTINGS,
    band: band, pm25ToPsi: pm25ToPsi, maxOf: maxOf, buildModel: buildModel,
    fetchModel: fetchModel, evaluateAlert: evaluateAlert,
    metricLabel: metricLabel, regionLabel: regionLabel, store: store
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.HazeLib = api;
})(typeof self !== 'undefined' ? self : this);
