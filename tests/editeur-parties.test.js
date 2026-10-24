const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const installer = require('../editeur-parties');
function fixture(t) {
  const dossierSaison = fs.mkdtempSync(path.join(os.tmpdir(), 'geh-editeur-'));
  t.after(() => fs.rmSync(dossierSaison, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dossierSaison, 'parties'));
  const réponse = { noPartie: 1, noSérie: 5, noQuestion: 1, noÉquipe: 1, noJoueur: 99, pointsSecondaires: false };
  const autre = { ...réponse, noPartie: 2 };
  const fichiers = { 'répondants.json': [réponse, autre], 'parties/répondants-1.json': [réponse], 'alignements.json': [{ noPartie: 1, noÉquipe: 1, joueurs: [5] }] };
  for (const [nom, données] of Object.entries(fichiers)) fs.writeFileSync(path.join(dossierSaison, nom), JSON.stringify(données));
  const c = { dossierSaison, saisonActive: '2026-2027', parties: [{ noPartie: 1, noÉquipeA: 1, noÉquipeB: 2 }], équipes: [], joueurs: [{ noÉquipe: 1, noJoueur: 5 }], séries: [{ noSérie: 5, questions: [{ noQuestion: 1, points: 5, pointsSecondaires: 0 }] }], étatsParties: {}, auth: req => req.auth };
  const routes = {};
  installer({ get: (url, ...fn) => { routes['GET' + url] = fn; }, put: (url, ...fn) => { routes['PUT' + url] = fn; } }, () => c);
  function appeler(method, body, auth = true) {
    const req = { params: { numero: '1' }, body, auth };
    const res = { code: 200, status(n) { this.code = n; return this; }, json(d) { this.body = d; } };
    const [middleware, handler] = routes[method + '/api/admin/resultats/:numero'];
    middleware(req, res, () => handler(req, res));
    return res;
  }
  const aperçu = appeler('GET').body;
  return { c, appeler, aperçu, autre, lire: nom => JSON.parse(fs.readFileSync(path.join(dossierSaison, nom), 'utf8')), demande: { saison: aperçu.saison, version: aperçu.version, réponses: [{ ...réponse, noJoueur: 5 }] } };
}
test('réattribue au joueur, synchronise le cumul, sauvegarde et conserve les alignements et autres parties', t => {
  const f = fixture(t);
  const avant = f.lire('alignements.json');
  const r = f.appeler('PUT', f.demande);
  assert.equal(r.code, 200);
  assert.equal(f.lire('parties/répondants-1.json')[0].noJoueur, 5);
  assert.deepEqual(f.lire('répondants.json'), [...f.demande.réponses, f.autre]);
  assert.deepEqual(f.lire('alignements.json'), avant);
  assert.equal(f.lire(`sauvegardes-corrections/${r.body.sauvegarde}/répondants-1.json`)[0].noJoueur, 99);
  assert.equal(f.appeler('PUT', f.demande).code, 409);
});
test('protège authentification, saison, partie ouverte et validation', t => {
  const f = fixture(t);
  assert.equal(f.appeler('GET', null, false).code, 401);
  assert.equal(f.appeler('PUT', { ...f.demande, saison: '2025-2026' }).code, 409);
  for (const modifier of [r => { r.noÉquipe = 3; }, r => { r.noJoueur = 8; }, r => { r.noQuestion = 2; }, r => { r.pointsSecondaires = true; }]) {
    const d = JSON.parse(JSON.stringify(f.demande)); modifier(d.réponses[0]);
    assert.equal(f.appeler('PUT', d).code, 400);
  }
  assert.equal(f.appeler('PUT', { ...f.demande, réponses: [...f.demande.réponses, ...f.demande.réponses] }).code, 400);
  f.c.étatsParties[1] = { mode: 'jeu' };
  assert.equal(f.appeler('PUT', f.demande).code, 400);
  assert.equal(f.lire('parties/répondants-1.json')[0].noJoueur, 99);
});
test('ajout et suppression de réponses synchronisés', t => {
  const f = fixture(t);
  assert.equal(f.appeler('PUT', { ...f.demande, réponses: [] }).code, 200);
  assert.deepEqual(f.lire('répondants.json'), [f.autre]);
  const version = f.appeler('GET').body.version;
  assert.equal(f.appeler('PUT', { ...f.demande, version }).code, 200);
  assert.equal(f.lire('répondants.json').length, 2);
});
