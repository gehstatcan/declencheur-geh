'use strict';
// Script d'initialisation du Volume Railway
// Usage : railway run node init-volume.js [--force]
//
// Sans --force : copie seulement les fichiers absents du Volume (sécuritaire)
// Avec --force : écrase TOUS les fichiers du Volume depuis git (testing / reset)
//
// Fichiers toujours mis à jour (référentiels git) :
//   équipes.json, séries.json
//
// Fichiers copiés si absents (ou forcés) :
//   joueurs.json, parties.json, thèmes.json, questions.json,
//   répondants.json, alignements.json

const fs   = require('fs');
const path = require('path');

const FORCE  = process.argv.includes('--force');
const saison = '2025-2026';

const volumePath = process.env.RAILWAY_VOLUME_MOUNT_PATH;
if (!volumePath) {
  console.error('❌ RAILWAY_VOLUME_MOUNT_PATH non défini. Ce script doit rouler sur Railway.');
  process.exit(1);
}

const src = path.join(__dirname, 'data', 'saisons', saison);
const dst = path.join(volumePath, 'saisons', saison);

// ── Créer les dossiers ────────────────────────────────────────
[dst, path.join(dst, 'parties')].forEach(d => {
  if (!fs.existsSync(d)) {
    fs.mkdirSync(d, { recursive: true });
    console.log('📁 Créé :', d);
  }
});

// ── Fichiers toujours mis à jour depuis git ───────────────────
const fichiersGit = ['équipes.json', 'séries.json'];
fichiersGit.forEach(f => {
  fs.copyFileSync(path.join(src, f), path.join(dst, f));
  console.log('✅ (git)   ', f);
});

// ── Fichiers copiés si absents (ou --force) ───────────────────
const fichiersData = [
  'joueurs.json',
  'parties.json',
  'thèmes.json',
  'questions.json',
  'répondants.json',
  'alignements.json',
];

fichiersData.forEach(f => {
  const source = path.join(src, f);
  const cible  = path.join(dst, f);
  if (!fs.existsSync(source)) {
    console.log('⏭️  (absent du repo)', f);
    return;
  }
  if (FORCE || !fs.existsSync(cible)) {
    fs.copyFileSync(source, cible);
    console.log(FORCE ? '🔄 (force)  ' : '📄 (nouveau)', f);
  } else {
    console.log('⏭️  (conservé)      ', f);
  }
});

console.log('\nTerminé.' + (FORCE ? ' (mode --force)' : ''));
