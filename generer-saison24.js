'use strict';
// Script one-shot : génère répondants.json et alignements.json
// depuis le CSV de la saison 24 (totaux par joueur par partie)

const fs   = require('fs');
const path = require('path');

const CSV      = 'C:/GIT/gehstatcan.github.io/Saison24/DonnéesCSV/tblRépondantsParJoueurs.csv';
const DATA_DIR = path.join(__dirname, 'data/saisons/2025-2026');

// ── Chargement des données ─────────────────────────────────────
const partiesData = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'parties.json'),  'utf-8'));
const sériesData  = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'séries.json'),   'utf-8'));

// Lookup noPartie → noQuestionnaire
const partiesLookup = {};
partiesData.forEach(p => { partiesLookup[p.noPartie] = p.noQuestionnaire; });

// ── Pool de questions ──────────────────────────────────────────
// On construit deux pools à partir de séries.json :
//   - individuel  : toutes les séries estÉquipe = false (séries 1-12, 14-15)
//   - collectif   : toutes les séries estÉquipe = true  (série 13)
// Le pool est la même liste pour tous les questionnaires (même structure).
// On réinitialise l'index pour chaque (noPartie, noÉquipe).

const POOL_INDIV = [];
const POOL_COLL  = [];
const POOL_5PTS  = [];  // S6-Q5-8 pointsSecondaires:true (5 pts chacune)

sériesData.forEach(s => {
  s.questions.forEach(q => {
    const entry = { noSérie: s.noSérie, noQuestion: q.noQuestion, points: q.points || 10 };
    if (s.estÉquipe) {
      POOL_COLL.push(entry);
    } else {
      POOL_INDIV.push(entry);
      // S5-Q2 à Q5 (Contrôle) : également collectifs (joueur 99)
      if (s.noSérie === 5 && q.noQuestion >= 2) {
        POOL_COLL.push(entry);
      }
    }

    // Ajouter les points secondaires (5 pts) comme entrées distinctes
    if (!s.estÉquipe && q.pointsSecondaires === 5) {
      POOL_5PTS.push({ noSérie: s.noSérie, noQuestion: q.noQuestion, points: 5, secondaire: true });
    }
  });
});

console.log(`Pool individuel : ${POOL_INDIV.length} questions, ${POOL_INDIV.reduce((s,q)=>s+q.points,0)} pts`);
console.log(`Pool collectif  : ${POOL_COLL.length}  questions, ${POOL_COLL.reduce((s,q)=>s+q.points,0)} pts`);

// ── Lecture du CSV ─────────────────────────────────────────────
const csvLines = fs.readFileSync(CSV, 'utf-8').trim().split('\n').slice(1);
const csvRows  = csvLines.map(l => {
  const p = l.trim().split(',');
  return { noPartie: +p[0], noÉquipe: +p[1], noJoueur: +p[2], points: +p[3] };
});

// Grouper par (noPartie, noÉquipe)
const groups = {};
csvRows.forEach(r => {
  const key = `${r.noPartie}-${r.noÉquipe}`;
  if (!groups[key]) groups[key] = { noPartie: r.noPartie, noÉquipe: r.noÉquipe, rows: [] };
  groups[key].rows.push(r);
});

// ── Filtre de parties (null = toutes) ──────────────────────────
const PARTIES_FILTRE = [32, 33, 34];

// ── Génération ─────────────────────────────────────────────────
const répondants  = [];
const alignements = [];
const warnings    = [];

Object.values(groups)
  .filter(g => !PARTIES_FILTRE || PARTIES_FILTRE.includes(g.noPartie))
  .sort((a, b) => a.noPartie - b.noPartie || a.noÉquipe - b.noÉquipe)
  .forEach(({ noPartie, noÉquipe, rows }) => {

  const individus = rows.filter(r => r.noJoueur !== 99)
                        .sort((a, b) => b.points - a.points);
  const collectif = rows.find(r => r.noJoueur === 99);

  // ── Alignement (tous les joueurs, même pts=0)
  alignements.push({
    noPartie,
    noÉquipe,
    joueurs: individus.map(r => r.noJoueur),
  });

  // ── Répondants individuels
  // Copie du pool par groupe : chaque question ne peut être attribuée qu'à un seul joueur.
  // On retire (splice) les questions assignées. Si q.points > restant, on passe à la suivante
  // sans la retirer — elle reste disponible pour le prochain joueur.
  const poolI  = [...POOL_INDIV];
  const pool5  = [...POOL_5PTS];  // S6 pts secondaires (5 pts), partagé dans le groupe

  individus.forEach(({ noJoueur, points }) => {
    if (points <= 0) return;
    let restant = points;
    let i = 0;

    while (restant > 0 && i < poolI.length) {
      const q = poolI[i];
      if (q.points <= restant) {
        répondants.push({ noPartie, noÉquipe, noJoueur, noSérie: q.noSérie, noQuestion: q.noQuestion, pointsSecondaires: false });
        restant -= q.points;
        poolI.splice(i, 1);
      } else {
        i++;
      }
    }

    // Reste de 5 pts : utiliser une entrée secondaire S6 (pointsSecondaires:true)
    if (restant === 5 && pool5.length > 0) {
      const q = pool5.shift();
      répondants.push({ noPartie, noÉquipe, noJoueur, noSérie: q.noSérie, noQuestion: q.noQuestion, pointsSecondaires: true });
      restant = 0;
    }

    if (restant > 0) {
      warnings.push(`P${noPartie} É${noÉquipe} J${noJoueur} : ${restant} pts non assignés (total ${points})`);
    }
  });

  // ── Répondants collectifs (joueur 99)
  if (collectif && collectif.points > 0) {
    const poolC = [...POOL_COLL];
    let restant = collectif.points;
    let i = 0;

    while (restant > 0 && i < poolC.length) {
      const q = poolC[i];
      if (q.points <= restant) {
        répondants.push({ noPartie, noÉquipe, noJoueur: 99, noSérie: q.noSérie, noQuestion: q.noQuestion, pointsSecondaires: false });
        restant -= q.points;
        poolC.splice(i, 1);
      } else {
        i++;
      }
    }

    if (restant > 0) {
      warnings.push(`P${noPartie} É${noÉquipe} J99 : ${restant} pts non assignés (total ${collectif.points})`);
    }
  }
});

// ── Validation croisée ────────────────────────────────────────
// Vérifier que la somme des répondants = CSV totals
console.log('\n── Validation ──────────────────────────────────────────────');
const sumRep = {};
répondants.forEach(r => {
  const sérieDef = sériesData.find(s => s.noSérie === r.noSérie);
  const qDef     = sérieDef?.questions.find(q => q.noQuestion === r.noQuestion);
  const pts      = r.pointsSecondaires
    ? (qDef?.pointsSecondaires || 5)
    : (qDef ? qDef.points : 10);
  const key      = `${r.noPartie}-${r.noÉquipe}-${r.noJoueur}`;
  sumRep[key]    = (sumRep[key] || 0) + pts;
});

let ok = 0, ko = 0;
csvRows.filter(r => r.points > 0).forEach(r => {
  const key = `${r.noPartie}-${r.noÉquipe}-${r.noJoueur}`;
  const got = sumRep[key] || 0;
  if (got === r.points) {
    ok++;
  } else {
    ko++;
    console.log(`  ❌ P${r.noPartie} É${r.noÉquipe} J${r.noJoueur} : attendu ${r.points}, obtenu ${got} (écart ${r.points - got})`);
  }
});
console.log(`  ✅ ${ok} joueurs corrects, ❌ ${ko} avec écart`);

// ── Écriture (fusion si filtre actif) ─────────────────────────
const fmt = arr => '[\n' + arr.map(o => '  ' + JSON.stringify(o)).join(',\n') + '\n]';

let répFinal  = répondants;
let alignFinal = alignements;

if (PARTIES_FILTRE) {
  const répExist  = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'répondants.json'),  'utf-8'));
  const alignExist = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'alignements.json'), 'utf-8'));
  répFinal  = [...répExist.filter(r => !PARTIES_FILTRE.includes(r.noPartie)),  ...répondants];
  alignFinal = [...alignExist.filter(a => !PARTIES_FILTRE.includes(a.noPartie)), ...alignements];
}

fs.writeFileSync(path.join(DATA_DIR, 'répondants.json'),  fmt(répFinal),  'utf-8');
fs.writeFileSync(path.join(DATA_DIR, 'alignements.json'), fmt(alignFinal), 'utf-8');

console.log(`\n✅ ${répondants.length}  entrées répondants écrites`);
console.log(`✅ ${alignements.length} alignements écrits`);

if (warnings.length) {
  console.log(`\n⚠️  ${warnings.length} avertissements :`);
  warnings.forEach(w => console.log('  -', w));
}
