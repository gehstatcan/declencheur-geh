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
