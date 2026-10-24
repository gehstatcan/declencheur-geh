const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../index.js'), 'utf8');
const start = source.indexOf('app.put("/api/admin/series",');
const end = source.indexOf('// ============================================================', start);
function contexte() {
  const séries = [{ noSérie: 5, typeSérie: 'Contrôle', estÉquipe: true, questions: [{ noQuestion: 1, points: 5 }, { noQuestion: 2, points: 10, estÉquipe: null }] }];
  let route, écrit;
  vm.runInNewContext(source.slice(start, end), {
    app: { put: (_, fn) => { route = fn; } }, séries, saisonADémarré: () => true,
    dossierSaison: '/data', path, fs: { writeFileSync: (_, data) => { écrit = data; } }
  });
  return { séries, appeler(modifier) {
    const body = JSON.parse(JSON.stringify(séries));
    modifier(body);
    const res = { code: 200, status(c) { this.code = c; return this; }, json(b) { this.body = b; } };
    route({ body }, res);
    return { ...res, écrit };
  } };
}
test('mode individuel corrige Q1 en saison sans changer Q2 ni les points', () => {
  const c = contexte();
  const r = c.appeler(s => { s[0].questions[0].estÉquipe = false; });
  assert.equal(r.code, 200);
  assert.equal(c.séries[0].questions[0].estÉquipe, false);
  assert.equal(JSON.parse(r.écrit)[0].questions[1].estÉquipe, null);
});
test('points, suppressions et mode de série restent verrouillés', () => {
  for (const modifier of [s => { s[0].questions[0].points = 20; }, s => { s[0].questions.pop(); }, s => { s[0].estÉquipe = false; }]) {
    const r = contexte().appeler(modifier);
    assert.equal(r.code, 403);
    assert.equal(r.écrit, undefined);
  }
});
test('refuse un mode invalide sans écrire', () => {
  const r = contexte().appeler(s => { s[0].questions[0].estÉquipe = 'false'; });
  assert.equal(r.code, 400);
  assert.equal(r.écrit, undefined);
});
