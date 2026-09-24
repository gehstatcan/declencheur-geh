"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

// Exécuter le véritable gestionnaire sans démarrer le serveur ni modifier ses données.
const source = fs.readFileSync(path.join(__dirname, "../index.js"), "utf8");
const début = source.indexOf('app.get("/api/stats/compteurs",');
const fin = source.indexOf('\napp.get("/api/stats/joueur/', début);

test("thèmes cumulatifs : noms des archives et points des éliminatoires", () => {
  const fichiers = {
    "ancienne/joueurs.json": [{ noÉquipe: 1, noJoueur: 1, alias: "Alice", nom: "Martin" }],
    "ancienne/équipes.json": [{ noÉquipe: 1, nomÉquipe: "Math" }],
    "ancienne/parties.json": [{ noPartie: 36, noQuestionnaire: 1, phase: "eliminations" }],
    "ancienne/thèmes.json": [{ noQuestionnaire: 1, séries: [{ noSérie: 1, thème: "Actualité" }] }],
    "ancienne/séries.json": [{ noSérie: 1, questions: [{ noQuestion: 1, points: 20 }] }],
    "ancienne/répondants.json": [
      { noPartie: 36, noSérie: 1, noQuestion: 1, noÉquipe: 1, noJoueur: 1 },
      { noPartie: 36, noSérie: 1, noQuestion: 1, noÉquipe: 1, noJoueur: 99 }
    ]
  };
  let gestionnaire;
  vm.runInNewContext(source.slice(source.indexOf("app.get('/api/stats/themes',"), début), {
    app: { get: (_, fn) => { gestionnaire = fn; } }, path: path.posix,
    joueurs: [], équipes: [], SAISON_SYNTHÉTIQUE: "2025-2026", NO_PARTIE_SYNTHÉTIQUE_MAX: 35,
    lireJSON: (fichier, défaut) => fichiers[fichier] || défaut,
    listerDossiersSaisons: () => [{ nom: "2025-2026", chemin: "ancienne" }, { nom: "2026-2027", chemin: "vide" }],
    console
  });
  for (const phase of ["eliminations", "saison", undefined]) {
    let résultat;
    gestionnaire({ query: { saison: "cumulatif", phase } }, {
      json: valeur => { résultat = valeur; }, status: code => assert.fail(`Erreur HTTP ${code}`)
    });
    if (phase === "saison") { assert.equal(résultat.length, 0); continue; }
    assert.equal(résultat[0].thème, "Actualité");
    assert.equal(résultat[0].joueurs.length, 1);
    assert.equal(résultat[0].joueurs[0].alias, "Alice");
    assert.equal(résultat[0].joueurs[0].nom, "Martin");
    assert.equal(résultat[0].joueurs[0].nomÉquipe, "Math");
    assert.equal(résultat[0].joueurs[0].pts, 20);
  }
});

test("onglet thèmes : changement de saison et réponse ancienne ignorée", async () => {
  const html = fs.readFileSync(path.join(__dirname, "../public/stats-compteurs.html"), "utf8");
  const script = html.slice(html.indexOf("let saisonStats"), html.indexOf("        function navThème"));
  const éléments = new Map();
  const appels = [];
  const contexte = vm.createContext({
    URLSearchParams, window: { location: { search: "" } }, console,
    document: { getElementById: id => {
      if (!éléments.has(id)) éléments.set(id, { innerHTML: "", value: "cumulatif", classList: { contains: () => true } });
      return éléments.get(id);
    } },
    fetch: url => new Promise(resolve => appels.push({ url, resolve }))
  });
  vm.runInContext(script, contexte);
  vm.runInContext("chargerCompteurs = () => {}; phaseActive = 'eliminations'; changerSaisonStats();", contexte);
  assert.equal(appels[0].url, "/api/stats/themes?saison=cumulatif&phase=eliminations");
  éléments.get("sel-saison").value = "2026-2027";
  vm.runInContext("changerSaisonStats()", contexte);
  assert.equal(appels[1].url, "/api/stats/themes?saison=2026-2027&phase=eliminations");
  appels[1].resolve({ ok: true, json: async () => [] });
  await new Promise(resolve => setImmediate(resolve));
  assert.match(éléments.get("contenuThemes").innerHTML, /Aucune donnée/);
  appels[0].resolve({ ok: true, json: async () => [{ thème: "Ancienne réponse", joueurs: [] }] });
  await new Promise(resolve => setImmediate(resolve));
  assert.match(éléments.get("contenuThemes").innerHTML, /Aucune donnée/);
});

test("cumulatif : anciennes équipes et joueurs conservés avec une saison active vide", () => {
  const fichiers = {
    "ancienne/équipes.json": [{ noÉquipe: 1, nomÉquipe: "Math" }],
    "ancienne/joueurs.json": [
      { noÉquipe: 1, noJoueur: 1, alias: "Alice" },
      { noÉquipe: 1, noJoueur: 99, alias: "Équipe" }
    ],
    "ancienne/parties.json": [{ noPartie: 1, phase: "eliminations" }],
    "ancienne/alignements.json": [{ noPartie: 1, noÉquipe: 1 }],
    "ancienne/répondants.json": [
      { noPartie: 1, noÉquipe: 1, noJoueur: 1 },
      { noPartie: 1, noÉquipe: 1, noJoueur: 99 }
    ]
  };
  let gestionnaire;
  vm.runInNewContext(source.slice(début, fin), {
    app: { get: (_, fn) => { gestionnaire = fn; } },
    path: path.posix,
    lireJSON: (fichier, défaut) => fichiers[fichier] || défaut,
    listerDossiersSaisons: () => [
      { nom: "2025-2026", chemin: "ancienne" },
      { nom: "2026-2027", chemin: "vide" }
    ],
    console
  });
  for (const phase of [undefined, "eliminations", "saison", undefined]) {
    let résultat;
    gestionnaire({ query: { saison: "cumulatif", phase } }, {
      json: valeur => { résultat = valeur; },
      status: code => { assert.fail(`Erreur HTTP ${code}`); }
    });
    assert.equal(résultat.length, 1);
    assert.equal(résultat[0].joueurs.length, 1);
    assert.equal(résultat[0].joueurs[0].alias, "Alice");
    assert.equal(résultat[0].totalÉquipe, phase === "saison" ? 0 : 20);
    assert.equal(résultat[0].ptsÉquipeCollectif, phase === "saison" ? 0 : 10);
    assert.equal(résultat[0].pjÉquipe, phase === "saison" ? 0 : 1);
  }
});
