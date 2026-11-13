const test = require('node:test');
const assert = require('node:assert');
const L = require('../lib.js');

const psiJson = { code: 0, data: { items: [{
  timestamp: '2026-11-12T21:00:00+08:00', updatedTimestamp: '2026-11-12T21:01:00+08:00',
  readings: { psi_twenty_four_hourly: { north: 35, south: 37, east: 33, west: 35, central: 46 } } }] } };
const pmJson = { code: 0, data: { items: [{
  timestamp: '2026-11-13T00:00:00+08:00',
  readings: { pm25_one_hourly: { north: 28, south: 17, east: 18, west: 28, central: 20 } } }] } };

test('bands', () => {
  assert.equal(L.band(0).key, 'good');
  assert.equal(L.band(50).key, 'good');
  assert.equal(L.band(51).key, 'moderate');
  assert.equal(L.band(100).key, 'moderate');
  assert.equal(L.band(101).key, 'unhealthy');
  assert.equal(L.band(201).key, 'very');
  assert.equal(L.band(301).key, 'hazardous');
  assert.equal(L.band(null), null);
});

test('pm25 -> psi breakpoints', () => {
  assert.equal(L.pm25ToPsi(0), 0);
  assert.equal(L.pm25ToPsi(12), 50);
  assert.equal(L.pm25ToPsi(13), 51);
  assert.equal(L.pm25ToPsi(55), 100);
  assert.equal(L.pm25ToPsi(56), 101);
  assert.equal(L.pm25ToPsi(150), 200);
  assert.equal(L.pm25ToPsi(250), 300);
  assert.equal(L.pm25ToPsi(600), 500);
  assert.equal(L.pm25ToPsi(28), Math.round(51 + (28 - 13) * 49 / 42));
  assert.equal(L.pm25ToPsi(null), null);
  assert.equal(L.pm25ToPsi(-1), null);
});

test('buildModel', () => {
  const m = L.buildModel(psiJson, pmJson);
  assert.equal(m.regions.central.psi24, 46);
  assert.equal(m.regions.north.pm25, 28);
  assert.equal(m.regions.north.psi1, L.pm25ToPsi(28));
  assert.equal(m.regions.overall.psi24, 46);
  assert.equal(m.regions.overall.psi1, L.pm25ToPsi(28));
  assert.equal(m.updated, '2026-11-12T21:01:00+08:00');
});

test('buildModel survives missing pm25 feed', () => {
  const m = L.buildModel(psiJson, null);
  assert.equal(m.regions.north.psi1, null);
  assert.equal(m.regions.north.psi24, 35);
  assert.equal(m.regions.overall.psi1, null);
});

test('buildModel rejects bad payload', () => {
  assert.throws(() => L.buildModel({}, null));
});

const model = (v24, v1) => ({ regions: { west: { psi24: v24, psi1: v1 }, overall: { psi24: v24, psi1: v1 } } });
const S = (o) => Object.assign({ enabled: true, region: 'west', metric: 'psi24', threshold: 100 }, o);

test('alert fires on upward crossing only once', () => {
  let r = L.evaluateAlert(S(), model(90, 0), false);
  assert.equal(r.notify, false); assert.equal(r.above, false);
  r = L.evaluateAlert(S(), model(100, 0), r.above);        // equals threshold counts
  assert.equal(r.notify, true); assert.equal(r.above, true);
  r = L.evaluateAlert(S(), model(120, 0), r.above);        // still above: no repeat
  assert.equal(r.notify, false);
  r = L.evaluateAlert(S(), model(80, 0), r.above);         // dropped below: re-arm
  assert.equal(r.notify, false); assert.equal(r.above, false);
  r = L.evaluateAlert(S(), model(101, 0), r.above);
  assert.equal(r.notify, true);
});

test('first reading already above notifies', () => {
  assert.equal(L.evaluateAlert(S(), model(150, 0), null).notify, true);
});

test('disabled or missing value never notifies', () => {
  assert.equal(L.evaluateAlert(S({ enabled: false }), model(300, 300), null).notify, false);
  assert.equal(L.evaluateAlert(S(), model(null, null), null).notify, false);
  assert.equal(L.evaluateAlert(S({ region: 'nowhere' }), model(300, 300), null).notify, false);
});

test('metric and region selection', () => {
  assert.equal(L.evaluateAlert(S({ metric: 'psi1' }), model(10, 150), null).notify, true);
  assert.equal(L.evaluateAlert(S({ metric: 'psi24' }), model(10, 150), null).notify, false);
  const r = L.evaluateAlert(S({ region: 'overall' }), model(120, 0), null);
  assert.match(r.title, /120/); assert.match(r.title, /Unhealthy/);
});

test('fetchModel with stubbed fetch, pm25 failure tolerated', async () => {
  const f = (url) => url.endsWith('/psi')
    ? Promise.resolve({ ok: true, json: () => Promise.resolve(psiJson) })
    : Promise.resolve({ ok: false, status: 500 });
  const m = await L.fetchModel(f);
  assert.equal(m.regions.west.psi24, 35);
  assert.equal(m.regions.west.psi1, null);
  await assert.rejects(L.fetchModel(() => Promise.resolve({ ok: false, status: 429 })));
});
