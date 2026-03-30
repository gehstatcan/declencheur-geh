/**
 * convertir-questionnaires.js
 * Convertit les fichiers HTML de questionnaires (ancien système) en questions.json et thèmes.json.
 *
 * Usage : node convertir-questionnaires.js
 *
 * Lit  : C:\GIT\gehstatcan.github.io\Saison24\SaisonReg\Questionnaires\match*.html
 * Écrit : data/saisons/2025-2026/questions.json  (merge)
 *         data/saisons/2025-2026/thèmes.json     (merge)
 */

const fs   = require('fs');
const path = require('path');

const DOSSIER_Q    = 'C:/GIT/gehstatcan.github.io/Saison24/SaisonReg/Questionnaires';
const DOSSIER_DATA = path.join(__dirname, 'data/saisons/2025-2026');

// ─── Types de série reconnus ──────────────────────────────────────────────────
const TYPES_SERIE = new Set([
  'Individuelle', 'Collective', 'Contrôle', 'Les 4 V',
  "Choix d'associations", 'Question à indice', 'Vis-à-vis',
  'Questions Éclair', 'Question prime', 'Prime', 'Indice',
]);

// Préfixes indicateurs d'une ligne d'instructions (à ignorer)
const PREFIXES_INSTRUCTIONS = [
  'Rédiger ', 'Les 5 questions', 'Les 4 questions',
  'Les questions doivent', 'Choisir une année', 'Choisir un',
  'Dès le 1er indice', 'Il est normal', 'bonne réponse élimine',
  "Deux séries d'associations", "L'inconnue correctement",
  'Viser des questions', 'Poser une question',
  'Au moins 2 questions', 'Il ne doit y avoir',
  'Associez ', 'Décrire le', 'Nommer les', 'doit être précis',
  'sujets, formulations',
  'Toutes les questions',   // descripteur spécifique pour Les 4 V
  'La première question',   // note sur les points Contrôle
];

function estInstructions(t) {
  return PREFIXES_INSTRUCTIONS.some(p => t.startsWith(p) || t.includes(p));
}

function estSérieMark(t) {
  return /^Série \d+$/.test(t);
}

// Marqueurs indiquant un dump de base de données (stop parsing)
const MARQUEURS_STOP = new Set([
  'tblThèmes', 'tblQuestionnaires', 'tblParties', 'tblRépondants',
  'NoQuestionnaire', 'TexteQuestion', 'FichierQuestion',
]);

function estMarqueurStop(t) {
  return MARQUEURS_STOP.has(t);
}

// ─── Extraction de tous les tokens (data-sheets-value + sdval numérique) ──────
// Les cellules avec align="right" + sdval sont des numéros de questions → ignorées.
// Les cellules avec sdval sans align="right" sont des réponses numériques → incluses.
function extraireTokens(html) {
  const tokens = [];
  // Parcourir chaque <td ...> pour extraire la valeur dans l'ordre du document
  const tdRe = /<td([^>]*)>/g;
  let m;
  while ((m = tdRe.exec(html)) !== null) {
    const attrs = m[1];

    // Chercher data-sheets-value en priorité
    const dsMatch = attrs.match(/data-sheets-value="([^"]*)"/);
    if (dsMatch) {
      try {
        const dec = dsMatch[1]
          .replace(/&quot;/g, '"')
          .replace(/&amp;/g, '&')
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .replace(/&#160;/g, ' ')
          .replace(/&nbsp;/g, ' ');
        const j = JSON.parse(dec);
        if (j[2] !== undefined) {
          const val = String(j[2]).replace(/\u00a0/g, ' ').trim();
          if (val) tokens.push(val);
        }
      } catch (e) {}
      continue; // ne pas vérifier sdval si data-sheets-value existe
    }

    // Fallback sdval : ignorer les cellules align="right" dont la valeur est un
    // petit entier (1-99) → numéros de questions. Les valeurs plus grandes
    // (ex. "1984", "2001") sont des réponses numériques → conserver.
    const sdMatch = attrs.match(/sdval="([^"]*)"/);
    if (sdMatch) {
      const val = sdMatch[1].trim();
      const estNuméroQuestion = /\balign\s*=\s*["']?right["']?/i.test(attrs)
        && /^\d{1,2}$/.test(val);
      if (!estNuméroQuestion && val) tokens.push(val);
    }
  }
  return tokens;
}

// Table de correspondance fichier → noQuestionnaire (source autoritaire : parties.json)
// Permet de corriger les fichiers dont le HTML contient un mauvais numéro.
const NO_Q_PAR_FICHIER = {
  'match1.html': 1,   'match3.html': 2,   'match5.html': 3,
  'match7.html': 4,   'match9.html': 5,   'match11.html': 6,
  'match13.html': 7,  'match15.html': 8,  'match17.html': 9,
  'match19.html': 10, 'match21.html': 11, 'match23.html': 12,
  'match25.html': 13, 'match27.html': 14, 'match29 .html': 15,
  'match31.html': 16, 'match33.html': 17,
};

// ─── Numéro de questionnaire ──────────────────────────────────────────────────
function extraireNoQuestionnaire(html, nomFichier) {
  // La table de correspondance est autoritaire (évite les faux positifs HTML)
  const nomNorm = nomFichier ? nomFichier.trim() : '';
  if (NO_Q_PAR_FICHIER[nomNorm]) return NO_Q_PAR_FICHIER[nomNorm];
  if (nomFichier && NO_Q_PAR_FICHIER[nomFichier]) return NO_Q_PAR_FICHIER[nomFichier];
  // Fallback : chercher dans le HTML
  const m = html.match(/Numéro de Questionnaire[\s\S]{1,400}?sdval="(\d+)"/);
  if (m) return parseInt(m[1]);
  const m2 = html.match(/Numéro de Questionnaire[\s\S]{1,200}?&quot;2&quot;:\s*&quot;(\d+)&quot;/);
  if (m2) return parseInt(m2[1]);
  return null;
}

// ─── Parseur principal ────────────────────────────────────────────────────────
function analyserFichier(html, nomFichier) {
  const noQuestionnaire = extraireNoQuestionnaire(html, nomFichier);
  if (!noQuestionnaire) return null;

  const tokens = extraireTokens(html);

  // Repérer le début des séries (1er token "Série 1")
  let i = tokens.findIndex(t => t === 'Série 1');
  if (i < 0) return null;

  const séries = [];
  let dernierNoSérie = 0;

  while (i < tokens.length) {
    const mark = tokens[i];

    // Dump de base de données → stop
    if (estMarqueurStop(mark)) break;

    if (!estSérieMark(mark)) { i++; continue; }

    const noSérie = parseInt(mark.replace('Série ', ''));

    // Si le numéro de série régresse, on a atteint la 2e copie du questionnaire → stop
    if (noSérie <= dernierNoSérie) break;
    dernierNoSérie = noSérie;
    i++;

    // ── Lecture de l'en-tête (thème, type, sousThème) ──────────────────────
    let thème = '', typeSérie = '', sousThème = '';

    // Collecte les tokens d'en-tête jusqu'à instructions ou prochain Série
    const headerBuf = [];
    while (i < tokens.length && !estSérieMark(tokens[i]) && !estInstructions(tokens[i])) {
      headerBuf.push(tokens[i]);
      i++;
      if (headerBuf.length >= 4) break;
    }

    // Identifier le type parmi les tokens d'en-tête
    const typeIdx = headerBuf.findIndex(t => TYPES_SERIE.has(t));
    if (typeIdx >= 0) {
      typeSérie = headerBuf[typeIdx];
      const autres = headerBuf.filter((_, idx) => idx !== typeIdx);
      thème    = autres[0] || '';
      sousThème = autres[1] || '';
    } else {
      thème     = headerBuf[0] || '';
      sousThème = headerBuf[1] || '';
    }

    // Sauter les instructions globales — sauf pour Choix d'associations dont lireGroupe()
    // gère son propre parsing (évite de consommer les marqueurs Sous-thème par accident)
    if (typeSérie !== "Choix d'associations") {
      while (i < tokens.length && estInstructions(tokens[i])) i++;
    }

    // ── Collecte des questions ─────────────────────────────────────────────
    const questions = [];

    if (typeSérie === "Choix d'associations") {
      // Structure : [Sous-thème N label] → nomGroupe → instructionsGroupe
      //             → 4 paires item/valeur → clé A/B/C/D (skip) → répéter pour groupe 2

      function lireGroupe() {
        // Sauter les instructions globales et les marqueurs "Sous-thème N (doit être…)".
        // Préserver tout token contenant "Associez" : il peut être le nom du groupe,
        // même si le mot n'est pas en début de token (ex. "Choix 1: Associez…").
        while (i < tokens.length && (tokens[i].startsWith('Sous-thème') ||
               (estInstructions(tokens[i]) && !tokens[i].includes('Associez')))) i++;
        // Lire le nom du groupe : premier token restant (peut commencer par "Associez")
        let nom = null;
        if (i < tokens.length && !estSérieMark(tokens[i]) && !estMarqueurStop(tokens[i])) {
          nom = tokens[i]; i++;
        }
        // Sauter les instructions qui suivent le nom (ex. "Associez X à Y…" quand le nom est un thème)
        while (i < tokens.length && estInstructions(tokens[i])) i++;
        // Collecter max 4 paires Q/A
        // Sauter les tokens de réplique ("1 à 3", "1 ou 2") présents dans certains formats.
        const paires = [];
        while (i < tokens.length && paires.length < 4 &&
               !estSérieMark(tokens[i]) && !estMarqueurStop(tokens[i])) {
          const t = tokens[i];
          if (t.startsWith('Sous-thème')) break;
          if (estInstructions(t)) break;
          if (/^[0-3](\s*(à|ou)\s*[0-3])?$/.test(t)) { i++; continue; } // token réplique
          const texte = t; i++;
          let réponse = '';
          if (i < tokens.length && !estSérieMark(tokens[i]) && !estMarqueurStop(tokens[i]) &&
              !tokens[i].startsWith('Sous-thème') && !estInstructions(tokens[i]) &&
              !/^[0-3](\s*(à|ou)\s*[0-3])?$/.test(tokens[i])) {
            réponse = tokens[i]; i++;
          }
          paires.push({ texte, réponse });
        }
        // Sauter tout jusqu'au prochain Sous-thème ou Série :
        // clé de réponse A/B/C/D + toute ligne résiduelle (ex. récapitulatif "1B-2A-3D...")
        while (i < tokens.length && !estSérieMark(tokens[i]) && !estMarqueurStop(tokens[i]) &&
               !tokens[i].startsWith('Sous-thème')) {
          i++;
        }
        return { nom, paires };
      }

      const { nom: questionGroupe1, paires: paires1 } = lireGroupe();
      const { nom: questionGroupe2, paires: paires2 } = lireGroupe();

      // Construire les 8 questions (4+4)
      [...paires1, ...paires2].forEach((p, idx) => {
        questions.push({ noQuestion: idx + 1, texte: p.texte, réponse: p.réponse });
      });

      séries.push({ noSérie, thème, typeSérie, sousThème, questionGroupe1, questionGroupe2, questions });
      continue;
    }

    // ── Types standard : paires (question, réponse) ──────────────────────
    const DIVIDERS = new Set(['Équipe A', 'Équipe B', 'Équipes A et B']);
    let isIndice = typeSérie === 'Question à indice' || typeSérie === 'Indice';
    const rawPaires = [];

    while (i < tokens.length && !estSérieMark(tokens[i]) && !estMarqueurStop(tokens[i])) {
      const t = tokens[i];

      if (DIVIDERS.has(t))      { i++; continue; } // ignorer séparateurs
      if (estInstructions(t))   { i++; continue; } // ignorer instructions
      if (t.startsWith('Sous-thème')) { i++; continue; }
      // Comptes de répliques (ex. "1 à 3", "1 ou 2") — présents dans les fichiers Deuxième/Troisième série
      if (/^[0-3](\s*(à|ou)\s*[0-3])?$/.test(t)) { i++; continue; }

      // Pour Indice : N tokens (indices) + 1 token (réponse)
      // On accumule jusqu'à la fin de la série, puis on reconstruit
      if (i + 1 < tokens.length && !estSérieMark(tokens[i + 1]) &&
          !DIVIDERS.has(tokens[i + 1])  && !estInstructions(tokens[i + 1])) {
        rawPaires.push({ texte: t, réponse: tokens[i + 1] });
        i += 2;
      } else {
        // Token seul (ex. réponse finale d'un indice, ou question sans réponse)
        rawPaires.push({ texte: t, réponse: '' });
        i++;
      }
    }

    if (isIndice) {
      // Structure Indice : indice1, indice2, indice3, réponse (4 tokens bruts)
      // rawPaires les a appairés en (indice1,indice2) et (indice3,réponse) → il faut reconstruire
      // On aplatit rawPaires en une liste de tokens bruts, puis dernier = réponse
      const bruts = rawPaires.flatMap(p => p.réponse ? [p.texte, p.réponse] : [p.texte]);
      if (bruts.length >= 2) {
        const réponseCommune = bruts[bruts.length - 1]; // dernier token = réponse
        const indices = bruts.slice(0, -1);             // tout sauf le dernier = indices
        indices.forEach((texte, idx) => {
          questions.push({ noQuestion: idx + 1, texte, réponse: réponseCommune });
        });
      }
    } else {
      rawPaires.forEach((p, idx) => {
        questions.push({ noQuestion: idx + 1, texte: p.texte, réponse: p.réponse });
      });
    }

    séries.push({ noSérie, thème, typeSérie, sousThème, questions });
  }

  return { noQuestionnaire, séries };
}

// ─── Merge dans les JSON existants ───────────────────────────────────────────
function merge(fichier, nouvellesEntrées, clé) {
  let existant = [];
  try { existant = JSON.parse(fs.readFileSync(fichier, 'utf-8')); } catch (e) {}

  for (const entry of nouvellesEntrées) {
    const idx = existant.findIndex(e => e[clé] === entry[clé]);
    if (idx >= 0) existant[idx] = entry;
    else          existant.push(entry);
  }
  existant.sort((a, b) => a[clé] - b[clé]);
  return existant;
}

// ─── Main ─────────────────────────────────────────────────────────────────────
const fichiers = fs.readdirSync(DOSSIER_Q)
  .filter(f => f.endsWith('.html') && f.startsWith('match'))
  .sort();

const nouvellesQuestions = [];
const nouveauxThèmes    = [];
const résumé = [];

for (const fichier of fichiers) {
  const html = fs.readFileSync(path.join(DOSSIER_Q, fichier), 'utf-8');
  const résultat = analyserFichier(html, fichier);

  if (!résultat) {
    console.warn(`⚠️  ${fichier} : numéro de questionnaire introuvable, ignoré`);
    continue;
  }

  const { noQuestionnaire, séries } = résultat;

  // questions.json
  nouvellesQuestions.push({
    noQuestionnaire,
    séries: séries.map(s => {
      const obj = { noSérie: s.noSérie, questions: s.questions };
      if (s.questionGroupe1) obj.questionGroupe1 = s.questionGroupe1;
      if (s.questionGroupe2) obj.questionGroupe2 = s.questionGroupe2;
      return obj;
    }),
  });

  // thèmes.json
  nouveauxThèmes.push({
    noQuestionnaire,
    séries: séries.map(s => ({
      noSérie:    s.noSérie,
      thème:      s.thème,
      sousThème:  s.sousThème || '',
    })),
  });

  const nbQ = séries.reduce((acc, s) => acc + s.questions.length, 0);
  résumé.push(`  Q${noQuestionnaire} (${fichier.trim()}) : ${séries.length} séries, ${nbQ} questions`);
}

// Écriture
const fichierQuestions = path.join(DOSSIER_DATA, 'questions.json');
const fichierThèmes    = path.join(DOSSIER_DATA, 'thèmes.json');

const questionsFinales = merge(fichierQuestions, nouvellesQuestions, 'noQuestionnaire');
const thèmesFinaux     = merge(fichierThèmes,    nouveauxThèmes,    'noQuestionnaire');

fs.writeFileSync(fichierQuestions, JSON.stringify(questionsFinales, null, 2), 'utf-8');
fs.writeFileSync(fichierThèmes,    JSON.stringify(thèmesFinaux,    null, 2), 'utf-8');

console.log(`\n✅ ${nouvellesQuestions.length} questionnaires convertis :\n${résumé.join('\n')}`);
console.log(`\n📄 questions.json → ${questionsFinales.length} questionnaires`);
console.log(`📄 thèmes.json    → ${thèmesFinaux.length} questionnaires\n`);
