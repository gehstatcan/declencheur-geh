'use strict';
// Convertit un CSV "Auteur" en entrée questions.json + thèmes.json
// Usage: node csv2questions.js <fichier.csv> <noQuestionnaire>

const fs   = require('fs');
const path = require('path');

const csvFile         = process.argv[2];
const noQuestionnaire = parseInt(process.argv[3]);

if (!csvFile || !noQuestionnaire) {
  console.error('Usage: node csv2questions.js <fichier.csv> <noQuestionnaire>');
  process.exit(1);
}

// ── Parseur CSV (gère les guillemets doubles) ─────────────────
function parseLine(line) {
  const cols = [];
  let field = '', inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (inQ && line[i + 1] === '"') { field += '"'; i++; }
      else inQ = !inQ;
    } else if (c === ',' && !inQ) {
      cols.push(field.trim()); field = '';
    } else {
      field += c;
    }
  }
  cols.push(field.trim());
  return cols;
}

const rows = fs.readFileSync(csvFile, 'utf-8')
  .trim().split('\n').map(parseLine);

// ── Découper les lignes par série ─────────────────────────────
const blocs = [];  // { noSérie, thèmeCSV, lignes[] }
let bloc = null;

rows.forEach(row => {
  if (row[2]?.startsWith('Série ')) {
    const noSérie  = parseInt(row[2].replace('Série ', ''));
    const thèmeCSV = row[3] || '';
    bloc = { noSérie, thèmeCSV, lignes: [] };
    blocs.push(bloc);
  } else if (bloc) {
    bloc.lignes.push(row);
  }
});

// ── Parseur générique (S1-S12, S14-S15) ──────────────────────
function parseGénérique(lignes) {
  const questions = [];
  lignes.forEach(row => {
    const noQ = parseInt(row[1]);
    if (!noQ || isNaN(noQ)) return;
    questions.push({ noQuestion: noQ, texte: row[2] || '', réponse: row[3] || '' });
  });
  return questions;
}

// ── Parseur Série 13 (associations en 2 sous-thèmes) ─────────
function parseS13(lignes) {
  const questions = [];
  let sousThème = 0;
  let assocs = {};
  let rawQs  = [];

  function résoudre() {
    rawQs.forEach(q => {
      const répTexte = q.réponseParenthèse || assocs[q.lettre] || q.lettre;
      questions.push({ noQuestion: q.noQ, texte: q.texte, réponse: répTexte });
    });
    rawQs  = [];
    assocs = {};
  }

  lignes.forEach(row => {
    const c1 = row[1] || '', c2 = row[2] || '', c3 = row[3] || '';
    if (c2.startsWith('Sous-thème')) {
      if (sousThème >= 1) résoudre();
      sousThème++;
      return;
    }
    if (/^[A-D]$/.test(c1)) { assocs[c1] = c2; return; }
    const noQ = parseInt(c1);
    if (!noQ || isNaN(noQ) || sousThème === 0) return;
    const offset = sousThème === 2 ? 4 : 0;
    const match  = c3.match(/^([A-D])\s*\((.+)\)$/);
    rawQs.push({ noQ: noQ + offset, texte: c2, lettre: c3.split(' ')[0], réponseParenthèse: match ? match[2] : null });
  });
  résoudre();
  questions.sort((a, b) => a.noQuestion - b.noQuestion);
  return questions;
}

// ── Extraction du thème et sous-thème ────────────────────────
function extraireThème(noSérie, thèmeCSV, lignes) {
  let sousThème = '';

  if (noSérie === 13) {
    // Chercher les lignes d'instructions (ex: "Associez le satellite...")
    const instructions = [];
    lignes.forEach(row => {
      const c0 = row[0] || '', c1 = row[1] || '', c2 = row[2] || '';
      if (c0 === '' && c1 === '' && c2.length > 15
          && !c2.startsWith('Sous-thème') && !c2.startsWith('Deux') && !c2.startsWith('Choix')) {
        instructions.push(c2);
      }
    });
    sousThème = instructions.join(' / ');
  } else {
    // Ligne de type (première ligne du bloc) : col3 peut contenir le sous-thème
    // ex: "Contrôle,1988" → sousThème = "1988"
    // ex: "Vis-à-vis,Nommez l'organe..." → sousThème = "Nommez..."
    if (lignes.length > 0 && lignes[0][3]) {
      sousThème = lignes[0][3];
    }
  }

  return { thème: thèmeCSV, sousThème };
}

// ── Assembler questions + thèmes par série ────────────────────
const séries      = [];
const sériesThème = [];

blocs.forEach(b => {
  const questions = b.noSérie === 13
    ? parseS13(b.lignes)
    : parseGénérique(b.lignes);
  séries.push({ noSérie: b.noSérie, questions });

  const { thème, sousThème } = extraireThème(b.noSérie, b.thèmeCSV, b.lignes);
  sériesThème.push({ noSérie: b.noSérie, thème, sousThème });
});

// ── Format compact : un objet par ligne ──────────────────────
function compact(arr) {
  return '[\n' + arr.map(o => '  ' + JSON.stringify(o)).join(',\n') + '\n]';
}

const DATA_DIR = path.join(__dirname, 'data/saisons/2025-2026');

// ── Mise à jour de questions.json ─────────────────────────────
const résultatQ   = { noQuestionnaire, séries };
const questionsFile = path.join(DATA_DIR, 'questions.json');
const questions   = JSON.parse(fs.readFileSync(questionsFile, 'utf-8'));

const idxQ = questions.findIndex(q => q.noQuestionnaire === noQuestionnaire);
if (idxQ >= 0) { questions[idxQ] = résultatQ; console.error(`⚠️  Q${noQuestionnaire} remplacé dans questions.json`); }
else           { questions.push(résultatQ); questions.sort((a, b) => a.noQuestionnaire - b.noQuestionnaire); console.error(`✅ Q${noQuestionnaire} ajouté dans questions.json`); }

fs.writeFileSync(questionsFile, compact(questions), 'utf-8');

// ── Mise à jour de thèmes.json ────────────────────────────────
const résultatT   = { noQuestionnaire, séries: sériesThème };
const thèmesFile  = path.join(DATA_DIR, 'thèmes.json');
const thèmes      = JSON.parse(fs.readFileSync(thèmesFile, 'utf-8'));

const idxT = thèmes.findIndex(t => t.noQuestionnaire === noQuestionnaire);
if (idxT >= 0) { thèmes[idxT] = résultatT; console.error(`⚠️  Q${noQuestionnaire} remplacé dans thèmes.json`); }
else           { thèmes.push(résultatT); thèmes.sort((a, b) => a.noQuestionnaire - b.noQuestionnaire); console.error(`✅ Q${noQuestionnaire} ajouté dans thèmes.json`); }

fs.writeFileSync(thèmesFile, compact(thèmes), 'utf-8');

console.error('\nThèmes extraits :');
sériesThème.forEach(s => console.error(`  S${s.noSérie}: ${s.thème}${s.sousThème ? ' — ' + s.sousThème : ''}`));
