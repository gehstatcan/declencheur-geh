"use strict";
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const source = fs.readFileSync(path.join(__dirname, '../index.js'), 'utf8');
const début = source.indexOf('app.post("/api/admin/importer-equipes",');
const fin = source.indexOf('app.put("/api/admin/equipes-joueurs",', début);

function contexte(structureSeule = false) {
  const fichiers = {
    '/data/saisons/2025-2026/équipes.json': JSON.stringify([{ noÉquipe: 3, nomÉquipe: 'Génies', son: 'gong', prioritéÉgalité: 2, points: 500 }]),
    '/data/saisons/2025-2026/joueurs.json': JSON.stringify([{ noÉquipe: 3, noJoueur: 7, alias: 'Alice', position: 2, points: 200 }, { noÉquipe: 3, noJoueur: 99, estÉquipe: true }]),
    '/data/saisons/2026-2027/équipes.json': '[]',
    '/data/saisons/2026-2027/joueurs.json': '[]',
    '/data/saisons/2026-2027/séries.json': '[]',
    '/data/saisons/2025-2026/séries.json': JSON.stringify([{ noSérie: 1, typeSérie: 'Collective', réplique: true, questions: [{ noQuestion: 1, points: 10 }] }]),
    '/data/saisons/2026-2027/parties.json': '[{"noPartie":1}]'
  };
  let route;
  const équipes = [], joueurs = [], séries = [];
  const code = structureSeule ? source.slice(source.indexOf('app.post("/api/admin/importer-structure",'), source.indexOf('app.put("/api/admin/series",')) : source.slice(début, fin);
  vm.runInNewContext(code, {
    app: { post: (_, fn) => { route = fn; } },
    getCookie: req => req.token, sessions: new Set(['ok']), crypto, path: path.posix,
    saisonActive: '2026-2027', dossierBase: '/data', dossierSaison: '/data/saisons/2026-2027', équipes, joueurs, séries, saisonADémarré: () => false,
    fs: {
      existsSync: p => p in fichiers || Object.keys(fichiers).some(f => f.startsWith(p + '/')),
      readFileSync: p => { if (!(p in fichiers)) throw Error('Absent'); return fichiers[p]; },
      writeFileSync: (p, contenu) => { fichiers[p] = contenu; },
      renameSync: (a, b) => { fichiers[b] = fichiers[a]; delete fichiers[a]; }
    }, console: { error() {} }
  });
  const appeler = (body = {}, token = 'ok') => {
    const réponse = { code: 200, status(code) { this.code = code; return this; }, json(body) { this.body = body; } };
    route({ body: { source: '2025-2026', destination: '2026-2027', ...body }, token }, réponse);
    return réponse;
  };
  return { fichiers, équipes, joueurs, séries, appeler };
}

test('structure seule : indépendante des équipes, aperçu sans écriture et aucun autre fichier modifié', () => {
  const c = contexte(true);
  c.équipes.push({ noÉquipe: 1 });
  c.joueurs.push({ noÉquipe: 1, noJoueur: 1 });
  const avant = { ...c.fichiers };
  const aperçu = c.appeler();
  assert.equal(aperçu.body.nbSéries, 1);
  assert.equal(aperçu.body.nbQuestions, 1);
  assert.deepEqual(c.fichiers, avant);
  assert.equal(c.appeler({ confirmation: aperçu.body.empreinte }).body.succès, true);
  assert.equal(c.séries.length, 1);
  for (const p of Object.keys(avant).filter(p => p !== '/data/saisons/2026-2027/séries.json')) assert.equal(c.fichiers[p], avant[p]);
  assert.equal(c.appeler().code, 409);
});

test('structure seule : protège la destination modifiée après aperçu et contrôle la session', () => {
  const c = contexte(true);
  assert.equal(c.appeler({}, 'invalide').code, 401);
  assert.equal(c.appeler({ destination: '2027-2028' }).code, 409);
  assert.equal(c.appeler({ source: '../pratique' }).code, 400);
  const aperçu = c.appeler();
  assert.equal(c.appeler({ confirmation: 'périmée' }).code, 409);
  c.fichiers['/data/saisons/2026-2027/séries.json'] = '[{"noSérie":99}]';
  const avant = { ...c.fichiers };
  assert.equal(c.appeler({ confirmation: aperçu.body.empreinte }).code, 409);
  assert.deepEqual(c.fichiers, avant);
});

test('copie optionnelle de la structure et mise à jour en mémoire', () => {
  const c = contexte();
  const aperçu = c.appeler({ inclureStructure: true });
  assert.equal(aperçu.body.nbSéries, 1);
  assert.equal(c.fichiers['/data/saisons/2026-2027/séries.json'], '[]');
  assert.equal(c.appeler({ inclureStructure: true, confirmation: aperçu.body.empreinte }).body.succès, true);
  assert.equal(c.séries[0].questions[0].points, 10);
  assert.deepEqual(JSON.parse(c.fichiers['/data/saisons/2026-2027/séries.json']), JSON.parse(c.fichiers['/data/saisons/2025-2026/séries.json']));
});

test('structure existante protégée, y compris après aperçu; équipes seules permises', () => {
  const c = contexte();
  const aperçu = c.appeler({ inclureStructure: true });
  const chemin = '/data/saisons/2026-2027/séries.json';
  const structureProduction = '[{"noSérie":1,"typeSérie":"Modifiée","questions":[{"noQuestion":1,"points":30}]}]';
  c.fichiers[chemin] = structureProduction;
  const avant = { ...c.fichiers };
  assert.equal(c.appeler({ inclureStructure: true }).code, 409);
  assert.equal(c.appeler({ inclureStructure: true, confirmation: aperçu.body.empreinte }).code, 409);
  assert.deepEqual(c.fichiers, avant);
  const équipesSeules = c.appeler();
  assert.equal(c.appeler({ confirmation: équipesSeules.body.empreinte }).body.succès, true);
  assert.equal(c.fichiers[chemin], structureProduction);
});

test('aperçu sans écriture, copie des identités et refus du second import', () => {
  const c = contexte();
  const avant = { ...c.fichiers };
  const aperçu = c.appeler();
  assert.equal(aperçu.body.nbÉquipes, 1);
  assert.equal(aperçu.body.nbJoueurs, 1);
  assert.deepEqual(c.fichiers, avant);
  assert.equal(c.appeler({ confirmation: aperçu.body.empreinte }).body.succès, true);
  assert.equal(c.équipes[0].prioritéÉgalité, null);
  assert.equal(c.équipes[0].son, 'gong');
  assert.equal(c.joueurs[0].noJoueur, 7);
  assert.equal(c.joueurs[0].position, 2);
  assert.equal(c.joueurs[0].points, undefined);
  assert.equal(c.joueurs[1].estÉquipe, true);
  for (const p of Object.keys(avant).filter(p => !p.endsWith('2026-2027/équipes.json') && !p.endsWith('2026-2027/joueurs.json'))) {
    assert.equal(c.fichiers[p], avant[p]);
  }
  assert.equal(c.appeler({ confirmation: aperçu.body.empreinte }).code, 409);
});

test('authentification, destination, source et confirmation invalides : aucune écriture', () => {
  const c = contexte();
  const avant = { ...c.fichiers };
  assert.equal(c.appeler({}, 'invalide').code, 401);
  assert.equal(c.appeler({ destination: '2027-2028' }).code, 409);
  assert.equal(c.appeler({ source: '../pratique' }).code, 400);
  assert.equal(c.appeler({ source: '2026-2027' }).code, 400);
  assert.equal(c.appeler({ source: '2027-2028' }).code, 400);
  assert.equal(c.appeler({ source: '2024-2025' }).code, 404);
  assert.equal(c.appeler({ confirmation: 'périmée' }).code, 409);
  assert.deepEqual(c.fichiers, avant);
});

test('une composition source modifiée exige un nouvel aperçu', () => {
  const c = contexte();
  const aperçu = c.appeler();
  c.fichiers['/data/saisons/2025-2026/joueurs.json'] = '[]';
  assert.equal(c.appeler({ confirmation: aperçu.body.empreinte }).code, 409);
  assert.equal(c.équipes.length, 0);
});

test('scripts de la page admin syntaxiquement valides', () => {
  const html = fs.readFileSync(path.join(__dirname, '../public/admin.html'), 'utf8');
  for (const script of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)) new vm.Script(script[1]);
});

test('interface : import désactivé pour une saison occupée ou sans source', () => {
  const html = fs.readFileSync(path.join(__dirname, '../public/admin.html'), 'utf8');
  const début = html.indexOf('function actualiserImportÉquipes()');
  const fin = html.indexOf('async function importerÉquipes()', début);
  const éléments = { 'source-equipes': { value: '2025-2026' }, 'btn-importer-equipes': {}, 'statut-importer-equipes': {} };
  const ctx = vm.createContext({ actualiserBlocImport() {}, document: { getElementById: id => éléments[id] }, équipesData: [{}], joueursData: [], équipesChargées: true, saisonÉquipes: '2026-2027' });
  vm.runInContext(html.slice(début, fin), ctx);
  vm.runInContext('actualiserImportÉquipes()', ctx);
  assert.equal(éléments['btn-importer-equipes'].disabled, true);
  ctx.équipesData = [];
  vm.runInContext('actualiserImportÉquipes()', ctx);
  assert.equal(éléments['btn-importer-equipes'].disabled, false);
  éléments['source-equipes'].value = '';
  vm.runInContext('actualiserImportÉquipes()', ctx);
  assert.equal(éléments['btn-importer-equipes'].disabled, true);
});
