// Charger les variables d'environnement en développement local
if (process.env.NODE_ENV !== "production") {
  require("dotenv").config();
}

// ============================================================
// Mode débogage — afficher le temps de réaction
// Mettre à false en production pour éviter les disputes !
// ============================================================
const AFFICHER_TEMPS_RÉACTION = true;

const express = require("express");
const app = express();
const http = require("http").createServer(app);
const io = require("socket.io")(http);
const fs = require("fs");
const path = require("path");

const multer = require("multer");
const XLSX = require("xlsx");
const archiver = require("archiver");

// Configuration multer — stockage en mémoire (pas sur disque)
const upload = multer({ storage: multer.memoryStorage() });

app.use(express.json());

// ============================================================
// Authentification — protection des pages animateur
// ============================================================
const crypto = require("crypto");
const sessions = new Set();
const MOT_DE_PASSE_ADMIN = process.env.MOT_DE_PASSE_ADMIN || "Fellegi";
const PAGES_PROTÉGÉES = ["/admin.html"];

function getCookie(req, name) {
  const cookies = req.headers.cookie || "";
  const match = cookies.split(";").map(c => c.trim()).find(c => c.startsWith(name + "="));
  return match ? match.slice(name.length + 1) : null;
}

app.use((req, res, next) => {
  if (!PAGES_PROTÉGÉES.includes(req.path)) return next();
  const token = getCookie(req, "geh_session");
  if (token && sessions.has(token)) return next();
  res.redirect("/login.html?redirect=" + encodeURIComponent(req.path));
});

app.post("/api/auth/login", (req, res) => {
  const { motDePasse } = req.body;
  if (motDePasse !== MOT_DE_PASSE_ADMIN)
    return res.status(401).json({ erreur: "Mot de passe incorrect" });
  const token = crypto.randomBytes(32).toString("hex");
  sessions.add(token);
  res.setHeader("Set-Cookie", `geh_session=${token}; HttpOnly; SameSite=Strict; Path=/`);
  res.json({ succès: true });
});

app.post("/api/auth/logout", (req, res) => {
  const token = getCookie(req, "geh_session");
  if (token) sessions.delete(token);
  res.setHeader("Set-Cookie", "geh_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0");
  res.json({ succès: true });
});

app.get("/api/auth/check", (req, res) => {
  const token = getCookie(req, "geh_session");
  res.json({ authentifié: token ? sessions.has(token) : false });
});

app.use(express.static("public"));

// ============================================================
// Chargement des données de la saison
// ============================================================

// Volume Railway monté sur /data
const dossierBase =
  process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(__dirname, "data");

// Saison active — lit depuis data/saison-active.txt ou variable d'environnement
function lireSaisonActive() {
  const fichier = path.join(dossierBase, "saison-active.txt");
  if (fs.existsSync(fichier)) {
    const contenu = fs.readFileSync(fichier, "utf-8").trim();
    if (/^\d{4}-\d{4}$/.test(contenu)) return contenu;
  }
  return process.env.SAISON_ACTIVE || "2025-2026";
}

let saisonActive = lireSaisonActive();
let dossierSaison = path.join(dossierBase, "saisons", saisonActive);

// ============================================================
// Initialisation du Volume — copier les données si nécessaire
// S'assure que la structure de dossiers existe sur le Volume
// ============================================================
function initialiserVolume() {
  const dossierParties = path.join(dossierSaison, "parties");

  // Créer les dossiers si inexistants
  if (!fs.existsSync(dossierSaison)) {
    fs.mkdirSync(dossierSaison, { recursive: true });
    console.log("📁 Dossier saison créé sur le Volume");
  }
  if (!fs.existsSync(dossierParties)) {
    fs.mkdirSync(dossierParties, { recursive: true });
    console.log("📁 Dossier parties créé sur le Volume");
  }

  // Copier seulement si absent — fichiers pouvant être modifiés via admin
  const fichiersAdmin = [
    "équipes.json",
    "joueurs.json",
    "parties.json",
    "séries.json",
    "questions.json",
    "thèmes.json",
  ];
  fichiersAdmin.forEach((fichier) => {
    const destination = path.join(dossierSaison, fichier);
    const source = path.join(__dirname, "data", "saisons", saisonActive, fichier);
    if (!fs.existsSync(destination) && fs.existsSync(source)) {
      fs.copyFileSync(source, destination);
      console.log(`📄 ${fichier} copié sur le Volume`);
    }
  });

  // Copier si absent — fichiers de données de jeu (ne jamais écraser)
  const fichiersJeu = [
    "répondants.json",
    "alignements.json",
  ];
  fichiersJeu.forEach((fichier) => {
    const destination = path.join(dossierSaison, fichier);
    const source = path.join(__dirname, "data", "saisons", saisonActive, fichier);
    if (!fs.existsSync(destination)) {
      if (fs.existsSync(source)) {
        fs.copyFileSync(source, destination);
        console.log(`📄 ${fichier} copié sur le Volume`);
      } else {
        fs.writeFileSync(destination, "[]", "utf-8");
        console.log(`📄 ${fichier} initialisé vide sur le Volume`);
      }
    }
  });
}

// Appeler l'initialisation seulement si un Volume Railway est monté
if (process.env.RAILWAY_VOLUME_MOUNT_PATH) {
  initialiserVolume();
}

let équipes = JSON.parse(
  fs.readFileSync(path.join(dossierSaison, "équipes.json"), "utf-8"),
);
let joueurs = JSON.parse(
  fs.readFileSync(path.join(dossierSaison, "joueurs.json"), "utf-8"),
);
let parties = JSON.parse(
  fs.readFileSync(path.join(dossierSaison, "parties.json"), "utf-8"),
);
const séries = JSON.parse(
  fs.readFileSync(path.join(dossierSaison, "séries.json"), "utf-8"),
);
let thèmes = JSON.parse(
  fs.readFileSync(path.join(dossierSaison, "thèmes.json"), "utf-8"),
);

console.log(`✅ ${équipes.length} équipes chargées`);
console.log(`✅ ${joueurs.length} joueurs chargés`);
console.log(`✅ ${parties.length} parties chargées`);
console.log(`✅ ${séries.length} séries chargées`);
console.log(`✅ ${thèmes.length} thèmes chargés`);

// ============================================================
// Routes API — données statiques de la saison
// ============================================================
app.get("/api/equipes", (req, res) => res.json(équipes));
app.get("/api/joueurs", (req, res) => res.json(joueurs));
app.get("/api/parties", (req, res) => res.json(parties));
app.get("/api/parties/jouees", (req, res) => {
  try {
    const contenu = fs.readFileSync(path.join(dossierSaison, "répondants.json"), "utf-8").trim();
    const rép = contenu ? JSON.parse(contenu) : [];
    const jouées = [...new Set(rép.map(r => r.noPartie))];
    res.json(jouées);
  } catch { res.json([]); }
});
app.get("/api/series", (req, res) => res.json(séries));
app.get("/api/themes", (req, res) => res.json(thèmes));
// ============================================================
// Téléchargement du fichier répondants.json
// Utile pour récupérer les données depuis le Volume Railway
// ============================================================
app.get("/api/telecharger/repondants", (req, res) => {
  const cheminRépondants = path.join(dossierSaison, "répondants.json");
  try {
    res.download(cheminRépondants, "répondants.json");
  } catch (e) {
    res.status(500).json({ erreur: "Fichier introuvable" });
  }
});
// ============================================================
// Téléchargement du fichier répondants de la partie en cours
// Accessible sans avoir à terminer la partie
// ============================================================
app.get("/api/telecharger/repondants-partie/:noPartie", (req, res) => {
  const noPartie = parseInt(req.params.noPartie);
  const cheminPartie = path.join(
    dossierSaison,
    "parties",
    `répondants-${noPartie}.json`,
  );
  if (fs.existsSync(cheminPartie)) {
    res.download(cheminPartie, `répondants-${noPartie}.json`);
  } else {
    res.status(404).json({ erreur: "Fichier introuvable" });
  }
});

// ============================================================
// Vérification préalable — lit le noQuestionnaire sans sauvegarder
// ============================================================
app.post("/api/upload/questionnaire/verifier", upload.single("fichier"), (req, res) => {
  try {
    const workbook = XLSX.read(req.file.buffer, { type: "buffer" });
    const feuille = workbook.Sheets["Vers BD"];
    const données = XLSX.utils.sheet_to_json(feuille, { header: 1 });
    let noQuestionnaire = null;
    for (const ligne of données) {
      if (ligne[0] === "tblThèmes") continue;
      if (ligne[0] === "NoQuestionnaire") continue;
      const noQ = parseInt(ligne[0]);
      if (!isNaN(noQ)) { noQuestionnaire = noQ; break; }
    }
    if (noQuestionnaire === null) return res.status(400).json({ erreur: "Numéro de questionnaire introuvable" });
    let questions = [];
    try {
      const contenu = fs.readFileSync(path.join(dossierSaison, "questions.json"), "utf-8").trim();
      questions = contenu ? JSON.parse(contenu) : [];
    } catch (e) { questions = []; }
    const existe = questions.some(q => q.noQuestionnaire === noQuestionnaire);
    res.json({ noQuestionnaire, existe });
  } catch (e) {
    res.status(500).json({ erreur: e.message });
  }
});

// ============================================================
// Upload questionnaire Excel — extrait thèmes et questions
// ============================================================
app.post("/api/upload/questionnaire", upload.single("fichier"), (req, res) => {
  try {
    // Lire le fichier Excel depuis la mémoire
    const workbook = XLSX.read(req.file.buffer, { type: "buffer" });
    const feuille = workbook.Sheets["Vers BD"];
    const données = XLSX.utils.sheet_to_json(feuille, { header: 1 });

    // --------------------------------------------------------
    // Extraire tblThèmes
    // --------------------------------------------------------
    let noQuestionnaire = null;
    const thèmesExtraits = [];
    const questionsExtraites = [];
    let section = null;

    données.forEach((ligne) => {
      if (ligne[0] === "tblThèmes") {
        section = "thèmes";
        return;
      }
      if (ligne[0] === "tblQuestionnaires") {
        section = "questions";
        return;
      }
      if (ligne[0] === "NoQuestionnaire") return; // entête

      if (section === "thèmes") {
        const noQ = parseInt(ligne[0]);
        const noS = parseInt(ligne[1]);
        const thème = ligne[2] && ligne[2] !== 0 ? String(ligne[2]) : "";
        const sousThème = ligne[3] && ligne[3] !== 0 ? String(ligne[3]) : "";
        if (!isNaN(noQ) && !isNaN(noS)) {
          if (noQuestionnaire === null) noQuestionnaire = noQ;
          thèmesExtraits.push({ noSérie: noS, thème, sousThème });
        }
      }

      if (section === "questions") {
        const noQ = parseInt(ligne[0]);
        const noS = parseInt(ligne[1]);
        const colQuestion = ligne[2] !== undefined ? String(ligne[2]).trim() : "";
        const texteRaw = ligne[3] ? String(ligne[3]) : "";
        const texte = texteRaw === "0" ? "" : texteRaw;
        const réponseRaw = ligne[4] ? String(ligne[4]) : "";
        const réponse = réponseRaw === "0" ? "" : réponseRaw;
        if (!isNaN(noQ) && !isNaN(noS)) {
          if (colQuestion === "Q1" || colQuestion === "Q2") {
            questionsExtraites.push({ noSérie: noS, groupe: colQuestion, texte });
          } else {
            const noQuestion = parseInt(colQuestion);
            if (!isNaN(noQuestion)) {
              questionsExtraites.push({ noSérie: noS, noQuestion, texte, réponse });
            }
          }
        }
      }
    });

    // --------------------------------------------------------
    // Mettre à jour thèmes.json
    // --------------------------------------------------------
    const cheminThèmes = path.join(dossierSaison, "thèmes.json");
    let thèmesData = [];
    try {
      thèmesData = JSON.parse(fs.readFileSync(cheminThèmes, "utf-8"));
    } catch (e) {
      thèmesData = [];
    }

    // Retirer l'ancien questionnaire si existe
    thèmesData = thèmesData.filter((t) => t.noQuestionnaire !== noQuestionnaire);
    thèmesData.push({ noQuestionnaire, séries: thèmesExtraits });
    thèmesData.sort((a, b) => a.noQuestionnaire - b.noQuestionnaire);
    fs.writeFileSync(cheminThèmes, '[\n' + thèmesData.map(q => JSON.stringify(q)).join(',\n') + '\n]');
    thèmes = thèmesData; // Recharger la variable globale en mémoire

    // --------------------------------------------------------
    // Mettre à jour questions.json
    // --------------------------------------------------------
    const cheminQuestions = path.join(dossierSaison, "questions.json");
    let questions = [];
    try {
      questions = JSON.parse(fs.readFileSync(cheminQuestions, "utf-8"));
    } catch (e) {
      questions = [];
    }

    // Grouper les questions par série
    const sériesMap = {};
    const groupesMap = {}; // Q1/Q2 par série
    questionsExtraites.forEach((q) => {
      if (q.groupe) {
        if (!groupesMap[q.noSérie]) groupesMap[q.noSérie] = {};
        groupesMap[q.noSérie][q.groupe === "Q1" ? "questionGroupe1" : "questionGroupe2"] = q.texte;
      } else {
        if (!sériesMap[q.noSérie]) sériesMap[q.noSérie] = [];
        sériesMap[q.noSérie].push({ noQuestion: q.noQuestion, texte: q.texte, réponse: q.réponse });
      }
    });

    const sériesQuestions = Object.keys(sériesMap)
      .map((noSérie) => {
        const entrée = { noSérie: parseInt(noSérie) };
        if (groupesMap[noSérie]) Object.assign(entrée, groupesMap[noSérie]);
        entrée.questions = sériesMap[noSérie].sort((a, b) => a.noQuestion - b.noQuestion);
        return entrée;
      })
      .sort((a, b) => a.noSérie - b.noSérie);

    // Retirer l'ancien questionnaire si existe
    questions = questions.filter((q) => q.noQuestionnaire !== noQuestionnaire);
    questions.push({ noQuestionnaire, séries: sériesQuestions });
    questions.sort((a, b) => a.noQuestionnaire - b.noQuestionnaire);
    fs.writeFileSync(cheminQuestions, '[\n' + questions.map(q => JSON.stringify(q)).join(',\n') + '\n]');

    // Analyse des thèmes — thème vide ou "-- Choisir un thème --" considéré manquant
    const thèmesSansValeur = thèmesExtraits.filter(t =>
      !t.thème || t.thème === "-- Choisir un thème --"
    ).map(t => t.noSérie);
    const nbAvecSousThème = thèmesExtraits.filter(t => t.sousThème).length;

    // Analyse des questions — séries avec texte ou réponse vides
    // Exclure les entrées de type groupe (Q1/Q2 pour série 13) qui n'ont pas de réponse par définition
    const sériesMap2 = {};
    questionsExtraites.filter(q => !q.groupe).forEach(q => {
      if (!sériesMap2[q.noSérie]) sériesMap2[q.noSérie] = { total: 0, textesVides: 0, réponsesVides: 0 };
      sériesMap2[q.noSérie].total++;
      if (!q.texte) sériesMap2[q.noSérie].textesVides++;
      if (!q.réponse) sériesMap2[q.noSérie].réponsesVides++;
    });
    const sériesIncomplètes = Object.entries(sériesMap2)
      .filter(([, v]) => v.textesVides > 0 || v.réponsesVides > 0)
      .map(([noSérie, v]) => ({ noSérie: parseInt(noSérie), total: v.total, textesVides: v.textesVides, réponsesVides: v.réponsesVides }))
      .sort((a, b) => a.noSérie - b.noSérie);

    res.json({
      succès: true,
      noQuestionnaire,
      nbSéries: thèmesExtraits.length,
      nbQuestions: questionsExtraites.length,
      thèmesSansValeur,
      nbAvecSousThème,
      sériesIncomplètes,
    });
  } catch (e) {
    console.error("Erreur upload questionnaire:", e);
    res.status(500).json({ erreur: e.message });
  }
});

// ============================================================
// Upload parties CSV — remplace parties.json
// ============================================================
app.post("/api/upload/parties", upload.single("fichier"), (req, res) => {
  try {
    // Lire en UTF-8 avec raw:true pour éviter la conversion des dates en numéros Excel
    const wb = XLSX.read(req.file.buffer.toString("utf-8"), { type: "string", raw: true });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const lignes = XLSX.utils.sheet_to_json(ws, { raw: true, defval: "" });

    const parseÉquipe = v => (!v || String(v).trim() === "" || String(v).trim() === "NA") ? null : parseInt(v);

    const nouvellesParties = lignes.map(l => ({
      noPartie:               parseInt(l["NoPartie"]),
      date:                   String(l["Date"] || ""),
      salle:                  String(l["Salle"] || ""),
      animateur:              String(l["NomAnimateur"] || ""),
      noQuestionnaire:        parseInt(l["NoQuestionnaire"]),
      noÉquipeA:              parseÉquipe(l["NoÉquipeA"]),
      noÉquipeB:              parseÉquipe(l["NoÉquipeB"]),
      noÉquipeQuestionnaire:  parseÉquipe(l["NoÉquipeQuestionnaire"]),
      lienRéunion:            String(l["LienReunion"] || ""),
      phase:                  String(l["Phase"] || "saison"),
      matchup:                l["Matchup"] ? String(l["Matchup"]) : null,
    })).filter(p => !isNaN(p.noPartie));

    nouvellesParties.sort((a, b) => a.noPartie - b.noPartie);

    // Validation
    const noÉquipesValides = new Set(équipes.map(e => e.noÉquipe));
    const erreurs = [];
    const nosParties = new Set();
    const dateRegex = /^\d{4}-\d{2}-\d{2}$/;

    nouvellesParties.forEach(p => {
      const id = `Partie ${p.noPartie}`;
      if (nosParties.has(p.noPartie)) erreurs.push({ partie: id, message: `noPartie ${p.noPartie} en double` });
      nosParties.add(p.noPartie);
      if (!p.date || !dateRegex.test(p.date)) erreurs.push({ partie: id, message: `Date invalide : "${p.date}"` });
      if (isNaN(p.noQuestionnaire) || p.noQuestionnaire <= 0) erreurs.push({ partie: id, message: `noQuestionnaire invalide` });
      if (p.noÉquipeA !== null && !noÉquipesValides.has(p.noÉquipeA)) erreurs.push({ partie: id, message: `noÉquipeA (${p.noÉquipeA}) introuvable` });
      if (p.noÉquipeB !== null && !noÉquipesValides.has(p.noÉquipeB)) erreurs.push({ partie: id, message: `noÉquipeB (${p.noÉquipeB}) introuvable` });
      if (p.noÉquipeA !== null && p.noÉquipeB !== null && p.noÉquipeA === p.noÉquipeB) erreurs.push({ partie: id, message: `noÉquipeA et noÉquipeB identiques` });
      if (p.noÉquipeQuestionnaire !== null) {
        if (!noÉquipesValides.has(p.noÉquipeQuestionnaire)) erreurs.push({ partie: id, message: `noÉquipeQuestionnaire (${p.noÉquipeQuestionnaire}) introuvable` });
        if (p.noÉquipeQuestionnaire === p.noÉquipeA || p.noÉquipeQuestionnaire === p.noÉquipeB)
          erreurs.push({ partie: id, message: `noÉquipeQuestionnaire ne peut pas être équipe A ou B` });
      }
    });

    if (erreurs.length > 0) return res.json({ succès: false, erreurs });

    const cheminParties = path.join(dossierSaison, "parties.json");
    const contenuParties = '[\n' + nouvellesParties.map(p => '  ' + JSON.stringify(p)).join(',\n') + '\n]';
    fs.writeFileSync(cheminParties, contenuParties, "utf-8");

    // Recharger en mémoire
    parties = nouvellesParties;

    res.json({ succès: true, nbParties: nouvellesParties.length });
  } catch (e) {
    console.error("Erreur upload parties:", e);
    res.status(500).json({ erreur: e.message });
  }
});

// ============================================================
// Sauvegarder la structure des séries (admin)
// Verrouillé dès qu'au moins une partie a été jouée
// ============================================================
function saisonADémarré() {
  const dossierParties = path.join(dossierSaison, "parties");
  if (!fs.existsSync(dossierParties)) return false;
  return fs.readdirSync(dossierParties).some(
    (f) => f.startsWith("répondants-") && f.endsWith(".json")
  );
}

app.get("/api/admin/series/statut", (_req, res) => {
  const verrouillé = saisonADémarré();
  let nbParties = 0;
  if (verrouillé) {
    try {
      const contenu = fs.readFileSync(path.join(dossierSaison, "répondants.json"), "utf-8").trim();
      const rép = JSON.parse(contenu || "[]");
      const partiesJouées = new Set(rép.filter((r) => r.noPartie).map((r) => r.noPartie));
      nbParties = partiesJouées.size;
    } catch (_) {}
  }
  res.json({ verrouillé, nbParties });
});

app.put("/api/admin/series", (req, res) => {
  if (saisonADémarré())
    return res.status(403).json({ erreur: "Modification impossible — des parties ont déjà été jouées cette saison." });
  const nouvelles = req.body;
  if (!Array.isArray(nouvelles) || nouvelles.length === 0)
    return res.status(400).json({ erreur: "Format invalide — tableau attendu" });
  for (const s of nouvelles) {
    if (!s.noSérie || !s.typeSérie || !Array.isArray(s.questions) || s.questions.length === 0)
      return res.status(400).json({ erreur: `Série ${s.noSérie || "?"} : données incomplètes` });
  }
  const chemin = path.join(dossierSaison, "séries.json");
  fs.writeFileSync(chemin, JSON.stringify(nouvelles, null, 2), "utf-8");
  séries.splice(0, séries.length, ...nouvelles);
  res.json({ succès: true, nbSéries: nouvelles.length });
});

// ============================================================
// Admin équipes & joueurs
// ============================================================
app.get("/api/admin/equipes", (_req, res) => {
  res.json(équipes);
});

app.get("/api/admin/joueurs", (_req, res) => {
  res.json(joueurs.filter((j) => !j.estÉquipe));
});

app.put("/api/admin/equipes-joueurs", (req, res) => {
  const { équipesData, joueursData } = req.body;
  if (!Array.isArray(équipesData) || !Array.isArray(joueursData))
    return res.status(400).json({ erreur: "Format invalide" });
  for (const e of équipesData) {
    if (!e.noÉquipe || !e.nomÉquipe)
      return res
        .status(400)
        .json({ erreur: `Équipe ${e.noÉquipe || "?"} : données incomplètes` });
  }
  // Reconstruire joueurs.json : joueurs réels + entrées estÉquipe:true auto
  const tousJoueurs = [...joueursData];
  for (const eq of équipesData) {
    tousJoueurs.push({
      noÉquipe: eq.noÉquipe,
      noJoueur: 99,
      alias: eq.nomÉquipe,
      estÉquipe: true,
    });
  }
  tousJoueurs.sort((a, b) => a.noÉquipe - b.noÉquipe || a.noJoueur - b.noJoueur);
  const jsonLignes = (arr) => "[\n" + arr.map((o) => "  " + JSON.stringify(o)).join(",\n") + "\n]";
  fs.writeFileSync(path.join(dossierSaison, "équipes.json"), jsonLignes(équipesData), "utf-8");
  fs.writeFileSync(path.join(dossierSaison, "joueurs.json"), jsonLignes(tousJoueurs), "utf-8");
  équipes.splice(0, équipes.length, ...équipesData);
  joueurs.splice(0, joueurs.length, ...tousJoueurs);
  res.json({
    succès: true,
    nbÉquipes: équipesData.length,
    nbJoueurs: joueursData.length,
  });
});

// ============================================================
// Sauvegarder un nouveau joueur dans joueurs.json
// ============================================================
app.post("/api/joueurs/nouveau", (req, res) => {
  const { noÉquipe, alias, prénom, nom } = req.body;
  const joueursÉquipe = joueurs.filter(
    (j) => j.noÉquipe === noÉquipe && !j.estÉquipe,
  );
  const maxNo = joueursÉquipe.reduce((max, j) => Math.max(max, j.noJoueur), 0);
  const noJoueur = maxNo + 1;
  const nouveauJoueur = { noÉquipe, noJoueur, alias, nom, prénom };
  joueurs.push(nouveauJoueur);
  fs.writeFileSync(
    path.join(dossierSaison, "joueurs.json"),
    JSON.stringify(joueurs, null, 2),
    "utf-8",
  );
  res.json(nouveauJoueur);
});

// ============================================================
// Routes API — Gestion des saisons
// ============================================================
app.get("/api/saisons", (_req, res) => {
  try {
    const dossierSaisons = path.join(dossierBase, "saisons");
    if (!fs.existsSync(dossierSaisons)) return res.json([]);
    const saisons = fs.readdirSync(dossierSaisons)
      .filter(f => /^\d{4}-\d{4}$/.test(f) && fs.statSync(path.join(dossierSaisons, f)).isDirectory())
      .sort()
      .reverse();
    res.json(saisons);
  } catch (e) {
    res.status(500).json({ erreur: e.message });
  }
});

app.get("/api/saison-active", (_req, res) => {
  res.json({ saison: saisonActive });
});

app.post("/api/admin/saison-active", (req, res) => {
  const token = getCookie(req, "geh_session");
  if (!token || !sessions.has(token)) return res.status(401).json({ erreur: "Non authentifié" });
  const { saison } = req.body;
  if (!saison || !/^\d{4}-\d{4}$/.test(saison))
    return res.status(400).json({ erreur: "Format de saison invalide (ex: 2026-2027)" });
  const dossierCible = path.join(dossierBase, "saisons", saison);
  if (!fs.existsSync(dossierCible))
    return res.status(404).json({ erreur: `Saison ${saison} introuvable` });
  saisonActive = saison;
  dossierSaison = dossierCible;
  fs.writeFileSync(path.join(dossierBase, "saison-active.txt"), saison, "utf-8");
  // Recharger les données en mémoire
  try {
    équipes.splice(0, équipes.length, ...JSON.parse(fs.readFileSync(path.join(dossierSaison, "équipes.json"), "utf-8")));
    joueurs.splice(0, joueurs.length, ...JSON.parse(fs.readFileSync(path.join(dossierSaison, "joueurs.json"), "utf-8")));
    parties.splice(0, parties.length, ...JSON.parse(fs.readFileSync(path.join(dossierSaison, "parties.json"), "utf-8")));
    séries.splice(0, séries.length, ...JSON.parse(fs.readFileSync(path.join(dossierSaison, "séries.json"), "utf-8")));
    thèmes.splice(0, thèmes.length, ...JSON.parse(fs.readFileSync(path.join(dossierSaison, "thèmes.json"), "utf-8")));
  } catch (e) {
    console.error("Erreur rechargement données saison:", e);
  }
  res.json({ succès: true, saison });
});

app.post("/api/admin/nouvelle-saison", (req, res) => {
  const token = getCookie(req, "geh_session");
  if (!token || !sessions.has(token)) return res.status(401).json({ erreur: "Non authentifié" });
  const { saison } = req.body;
  if (!saison || !/^\d{4}-\d{4}$/.test(saison))
    return res.status(400).json({ erreur: "Format invalide (ex: 2026-2027)" });
  const dossierNouveau = path.join(dossierBase, "saisons", saison);
  if (fs.existsSync(dossierNouveau))
    return res.status(409).json({ erreur: `La saison ${saison} existe déjà` });
  fs.mkdirSync(path.join(dossierNouveau, "parties"), { recursive: true });
  const fichiersVides = {
    "équipes.json": "[]",
    "joueurs.json": "[]",
    "parties.json": "[]",
    "séries.json": "[]",
    "thèmes.json": "[]",
    "questions.json": "[]",
    "répondants.json": "[]",
    "alignements.json": "[]",
  };
  for (const [nom, contenu] of Object.entries(fichiersVides)) {
    fs.writeFileSync(path.join(dossierNouveau, nom), contenu, "utf-8");
  }
  res.json({ succès: true, saison });
});

// ============================================================
// Export ZIP — sauvegarde de tous les fichiers JSON de la saison active
// ============================================================
function exporterZip(res) {
  const date = new Date().toISOString().slice(0, 10);
  const nomFichier = `geh-sauvegarde-${saisonActive}-${date}.zip`;

  res.setHeader("Content-Type", "application/zip");
  res.setHeader("Content-Disposition", `attachment; filename="${nomFichier}"`);

  const archive = archiver("zip", { zlib: { level: 6 } });
  archive.on("error", (err) => { throw err; });
  archive.pipe(res);

  const fichiersRacine = [
    "équipes.json", "joueurs.json", "questions.json", "thèmes.json",
    "parties.json", "séries.json", "répondants.json", "alignements.json",
  ];
  fichiersRacine.forEach((fichier) => {
    const chemin = path.join(dossierSaison, fichier);
    if (fs.existsSync(chemin)) archive.file(chemin, { name: fichier });
  });

  const dossierParties = path.join(dossierSaison, "parties");
  if (fs.existsSync(dossierParties)) archive.directory(dossierParties, "parties");

  archive.finalize();
}

// Accessible aux admins connectés (via admin.html)
app.get("/api/admin/export-zip", (req, res) => {
  const token = getCookie(req, "geh_session");
  if (!token || !sessions.has(token)) return res.status(401).json({ erreur: "Non authentifié" });
  exporterZip(res);
});

// Accessible sans authentification (via marqueur.html — animateurs sans mot de passe admin)
app.get("/api/sauvegarde-zip", (_req, res) => {
  exporterZip(res);
});

app.get("/api/alignements", (req, res) => {
  try {
    const cheminAlignements = path.join(dossierSaison, "alignements.json");
    let alignements = [];
    try {
      const contenu = fs.readFileSync(cheminAlignements, "utf-8").trim();
      alignements = contenu ? JSON.parse(contenu) : [];
    } catch (e) {
      alignements = [];
    }
    res.json(alignements);
  } catch (e) {
    res.status(500).json({ erreur: e.message });
  }
});

// ============================================================
// Routes API — Statistiques
// ============================================================

// Parties synthétiques — exclues des stats de thèmes et détail de questions
const SAISON_SYNTHÉTIQUE = '2025-2026';
const NO_PARTIE_SYNTHÉTIQUE_MAX = 35;

// Helper — dossier à utiliser pour les routes stats (respecte ?saison= si valide)
function getDossierStats(req) {
  const s = req.query && req.query.saison;
  if (s && /^\d{4}-\d{4}$/.test(s)) {
    return path.join(dossierBase, "saisons", s);
  }
  return dossierSaison;
}

function getSériesStats(dossier) {
  if (dossier === dossierSaison) return séries;
  try {
    return JSON.parse(fs.readFileSync(path.join(dossier, "séries.json"), "utf-8"));
  } catch { return séries; }
}

// Helper — lit un fichier JSON ou retourne la valeur par défaut
function lireJSON(filePath, défaut) {
  try {
    const c = fs.readFileSync(filePath, "utf-8").trim();
    return c ? JSON.parse(c) : défaut;
  } catch { return défaut; }
}

// Helper — liste tous les dossiers de saisons
function listerDossiersSaisons() {
  const dossierSaisons = path.join(dossierBase, "saisons");
  if (!fs.existsSync(dossierSaisons)) return [];
  return fs.readdirSync(dossierSaisons)
    .filter(f => /^\d{4}-\d{4}$/.test(f) && fs.statSync(path.join(dossierSaisons, f)).isDirectory())
    .sort()
    .map(f => ({ nom: f, chemin: path.join(dossierSaisons, f) }));
}

// Calendrier — parties avec scores calculés
app.get("/api/stats/calendrier", (req, res) => {
  try {
    const ds = getDossierStats(req);
    const sr = getSériesStats(ds);
    const parties = JSON.parse(
      fs.readFileSync(path.join(ds, "parties.json"), "utf-8"),
    );
    const équipes = JSON.parse(
      fs.readFileSync(path.join(ds, "équipes.json"), "utf-8"),
    );

    // Lire les répondants cumulatifs
    let répondants = [];
    try {
      const contenu = fs
        .readFileSync(path.join(ds, "répondants.json"), "utf-8")
        .trim();
      répondants = contenu ? JSON.parse(contenu) : [];
    } catch (e) {
      répondants = [];
    }

    // Calculer les scores par partie
    const résultats = parties.map((partie) => {
      const rép = répondants.filter((r) => r.noPartie === partie.noPartie);

      // Calculer les points de chaque équipe
      const scores = {};
      rép.forEach((r) => {
        if (!scores[r.noÉquipe]) scores[r.noÉquipe] = 0;
        const série = sr.find((s) => s.noSérie === r.noSérie);
        const question = série
          ? série.questions.find((q) => q.noQuestion === r.noQuestion)
          : null;
        const points = r.pointsSecondaires
          ? question
            ? question.pointsSecondaires
            : 5
          : question
            ? question.points
            : 10;
        scores[r.noÉquipe] += points;
      });

      const équipeA = équipes.find((e) => e.noÉquipe === partie.noÉquipeA);
      const équipeB = équipes.find((e) => e.noÉquipe === partie.noÉquipeB);
      const équipeQ = partie.noÉquipeQuestionnaire
        ? équipes.find((e) => e.noÉquipe === partie.noÉquipeQuestionnaire)
        : null;
      const scoreA = scores[partie.noÉquipeA] || null;
      const scoreB = scores[partie.noÉquipeB] || null;
      const terminée = rép.length > 0;

      return {
        noPartie: partie.noPartie,
        date: partie.date,
        noÉquipeA: partie.noÉquipeA,
        noÉquipeB: partie.noÉquipeB,
        nomÉquipeA: équipeA ? équipeA.nomÉquipe : "",
        nomÉquipeB: équipeB ? équipeB.nomÉquipe : "",
        nomÉquipeQuestionnaire: équipeQ ? équipeQ.nomÉquipe : null,
        scoreA,
        scoreB,
        terminée,
        lienTeams: partie.lienRéunion || null,
        noQuestionnaire: partie.noQuestionnaire,
        phase: partie.phase || 'saison',
        matchup: partie.matchup || null,
      };
    });

    // Trier par date
    résultats.sort((a, b) => a.date.localeCompare(b.date));
    res.json(résultats);
  } catch (e) {
    console.error("Erreur stats calendrier:", e);
    res.status(500).json({ erreur: e.message });
  }
});

// ============================================================
// Joueurs d'une partie — alignement + points de la partie
// ============================================================
app.get("/api/stats/partie/:noPartie/joueurs", (req, res) => {
  try {
    const ds = getDossierStats(req);
    const sr = getSériesStats(ds);
    const noPartie = parseInt(req.params.noPartie);
    const partie = parties.find(p => p.noPartie === noPartie);
    if (!partie) return res.status(404).json({ erreur: 'Partie introuvable' });

    const alignements = JSON.parse(fs.readFileSync(path.join(ds, 'alignements.json'), 'utf-8'));
    const joueurs = JSON.parse(fs.readFileSync(path.join(ds, 'joueurs.json'), 'utf-8'));

    let répondants = [];
    try {
      const tous = JSON.parse(fs.readFileSync(path.join(ds, 'répondants.json'), 'utf-8').trim() || '[]');
      répondants = tous.filter(r => r.noPartie === noPartie);
    } catch (e) {}

    const pointsJoueur = (noÉquipe, noJoueur) => {
      return répondants
        .filter(r => r.noÉquipe === noÉquipe && r.noJoueur === noJoueur)
        .reduce((sum, r) => {
          const sérieInfo = sr.find(s => s.noSérie === r.noSérie);
          const qInfo = sérieInfo?.questions.find(q => q.noQuestion === r.noQuestion);
          return sum + (r.pointsSecondaires ? (qInfo?.pointsSecondaires ?? 0) : (qInfo?.points ?? 0));
        }, 0);
    };

    const résultat = [partie.noÉquipeA, partie.noÉquipeB].map(noÉquipe => {
      const align = alignements.find(a => a.noPartie === noPartie && a.noÉquipe === noÉquipe);
      const noJoueurs = align ? align.joueurs : [];
      const joueursPartie = noJoueurs.map(noJ => {
        const j = joueurs.find(j => j.noÉquipe === noÉquipe && j.noJoueur === noJ);
        return { noJoueur: noJ, alias: j?.alias || `Joueur ${noJ}`, nom: j?.nom || '', points: pointsJoueur(noÉquipe, noJ) };
      });
      return { noÉquipe, pointsCollectifs: pointsJoueur(noÉquipe, 99), joueurs: joueursPartie };
    });

    res.json(résultat);
  } catch (e) {
    res.status(500).json({ erreur: e.message });
  }
});

// ============================================================
// Classement — G/GP/PN/PP/P
// ============================================================
app.get("/api/stats/classement", (req, res) => {
  try {
    const ds = getDossierStats(req);
    const sr = getSériesStats(ds);
    const parties = JSON.parse(
      fs.readFileSync(path.join(ds, "parties.json"), "utf-8"),
    );
    const équipes = JSON.parse(
      fs.readFileSync(path.join(ds, "équipes.json"), "utf-8"),
    );

    let répondants = [];
    try {
      const contenu = fs
        .readFileSync(path.join(ds, "répondants.json"), "utf-8")
        .trim();
      répondants = contenu ? JSON.parse(contenu) : [];
    } catch (e) {
      répondants = [];
    }

    // Initialiser le classement pour chaque équipe
    const classement = {};
    équipes.forEach((é) => {
      classement[é.noÉquipe] = {
        noÉquipe: é.noÉquipe,
        nomÉquipe: é.nomÉquipe,
        prioritéÉgalité: é.prioritéÉgalité ?? null,
        MJ: 0, // Matchs joués
        G: 0,
        GP: 0,
        PN: 0,
        PP: 0,
        P: 0,
        pts: 0, // Points au classement
        ptsMarqués: 0,
        ptsSubis: 0,
        ptsPossibles: 0,
      };
    });

    // Calculer les scores par partie
    const partiesTerminées = parties.filter((p) =>
      répondants.some((r) => r.noPartie === p.noPartie),
    );

    partiesTerminées.forEach((partie) => {
      const rép = répondants.filter((r) => r.noPartie === partie.noPartie);
      const scores = {};
      rép.forEach((r) => {
        if (!scores[r.noÉquipe]) scores[r.noÉquipe] = 0;
        const série = sr.find((s) => s.noSérie === r.noSérie);
        const question = série
          ? série.questions.find((q) => q.noQuestion === r.noQuestion)
          : null;
        const points = r.pointsSecondaires
          ? question
            ? question.pointsSecondaires
            : 5
          : question
            ? question.points
            : 10;
        scores[r.noÉquipe] += points;
      });

      const sA = scores[partie.noÉquipeA] || 0;
      const sB = scores[partie.noÉquipeB] || 0;
      const écart = Math.abs(sA - sB);
      const gagnant =
        sA > sB ? partie.noÉquipeA : sB > sA ? partie.noÉquipeB : null;

      [partie.noÉquipeA, partie.noÉquipeB].forEach((noÉquipe) => {
        if (!classement[noÉquipe]) return;
        const c = classement[noÉquipe];
        const monScore = scores[noÉquipe] || 0;
        const scoreAdv = noÉquipe === partie.noÉquipeA ? sB : sA;

        c.MJ++;
        c.ptsMarqués += monScore;
        c.ptsSubis += scoreAdv;
        c.ptsPossibles += 4;

        if (gagnant === null) {
          // Nulle
          c.PN++;
          c.pts += 2;
        } else if (gagnant === noÉquipe) {
          // Victoire
          if (écart > 40) {
            c.G++;
            c.pts += 4;
          } else {
            c.GP++;
            c.pts += 3;
          }
        } else {
          // Défaite
          if (écart > 40) {
            c.P++;
          } else {
            c.PP++;
            c.pts += 1;
          }
        }
      });
    });

    // Calculer le % et trier: % desc → prioritéÉgalité asc (null en dernier) → diff desc
    const résultat = Object.values(classement)
      .filter((c) => c.MJ > 0)
      .map((c) => ({
        ...c,
        pct:
          c.ptsPossibles > 0 ? Math.round((c.pts / c.ptsPossibles) * 100) : 0,
        diff: c.ptsMarqués - c.ptsSubis,
      }))
      .sort((a, b) => {
        if (b.pct !== a.pct) return b.pct - a.pct;
        const pa = a.prioritéÉgalité ?? Infinity;
        const pb = b.prioritéÉgalité ?? Infinity;
        if (pa !== pb) return pa - pb;
        return b.diff - a.diff;
      });

    res.json(résultat);
  } catch (e) {
    console.error("Erreur stats classement:", e);
    res.status(500).json({ erreur: e.message });
  }
});

// ============================================================
// Phase courante — saison ou eliminations
// ============================================================
app.get('/api/stats/phase', (req, res) => {
  try {
    const ds = getDossierStats(req);
    const parties = JSON.parse(fs.readFileSync(path.join(ds, 'parties.json'), 'utf-8'));
    const enEliminations = parties.some(p => p.phase === 'eliminations');
    res.json({ phase: enEliminations ? 'eliminations' : 'saison' });
  } catch (e) {
    res.status(500).json({ erreur: e.message });
  }
});

// ============================================================
// Bracket éliminatoires
// ============================================================
app.get('/api/stats/eliminations', (req, res) => {
  try {
    const ds = getDossierStats(req);
    const sr = getSériesStats(ds);
    const parties = JSON.parse(fs.readFileSync(path.join(ds, 'parties.json'), 'utf-8'));
    const équipes = JSON.parse(fs.readFileSync(path.join(ds, 'équipes.json'), 'utf-8'));
    const nomÉquipe = (no) => no ? (équipes.find(e => e.noÉquipe === no)?.nomÉquipe || `Équipe ${no}`) : null;

    let répondants = [];
    try {
      const contenu = fs.readFileSync(path.join(ds, 'répondants.json'), 'utf-8').trim();
      répondants = contenu ? JSON.parse(contenu) : [];
    } catch (e) { répondants = []; }

    const calcScore = (noPartie, noÉquipe) =>
      répondants.filter(r => r.noPartie === noPartie && r.noÉquipe === noÉquipe).reduce((total, r) => {
        const série = sr.find(s => s.noSérie === r.noSérie);
        const question = série ? série.questions.find(q => q.noQuestion === r.noQuestion) : null;
        const pts = r.pointsSecondaires ? (question?.pointsSecondaires ?? 5) : (question?.points ?? 10);
        return total + pts;
      }, 0);

    const partiesElim = parties.filter(p => p.phase === 'eliminations' && p.matchup);
    const résultats = {};
    partiesElim.forEach(partie => {
      const terminée = répondants.some(r => r.noPartie === partie.noPartie);
      const scoreA = terminée ? calcScore(partie.noPartie, partie.noÉquipeA) : null;
      const scoreB = terminée ? calcScore(partie.noPartie, partie.noÉquipeB) : null;
      const gagnant = terminée
        ? (scoreA > scoreB ? partie.noÉquipeA : scoreB > scoreA ? partie.noÉquipeB : null)
        : null;
      résultats[partie.matchup] = {
        matchup: partie.matchup,
        noPartie: partie.noPartie,
        noÉquipeA: partie.noÉquipeA,
        nomÉquipeA: nomÉquipe(partie.noÉquipeA),
        noÉquipeB: partie.noÉquipeB,
        nomÉquipeB: nomÉquipe(partie.noÉquipeB),
        scoreA, scoreB, terminée, gagnant,
        nomGagnant: nomÉquipe(gagnant),
        date: partie.date || null,
        lienRéunion: partie.lienRéunion || null,
        nomÉquipeQuestionnaire: nomÉquipe(partie.noÉquipeQuestionnaire) || null,
        animateur: partie.animateur || null,
      };
    });

    res.json(résultats);
  } catch (e) {
    res.status(500).json({ erreur: e.message });
  }
});

// ============================================================
// Stats par thème
app.get('/api/stats/themes', (req, res) => {
  try {
    if (req.query.saison === 'cumulatif') {
      const saisons = listerDossiersSaisons();
      const statsParThème = {};
      const phase = req.query.phase;

      for (const { nom, chemin } of saisons) {
        let rép = lireJSON(path.join(chemin, 'répondants.json'), []);
        const sér = lireJSON(path.join(chemin, 'séries.json'), []);
        const thèmesD = lireJSON(path.join(chemin, 'thèmes.json'), []);
        const partiesD = lireJSON(path.join(chemin, 'parties.json'), []);

        // Exclure parties synthétiques
        if (nom === SAISON_SYNTHÉTIQUE)
          rép = rép.filter(r => r.noPartie > NO_PARTIE_SYNTHÉTIQUE_MAX);

        // Filtrer par phase
        if (phase && phase !== 'tous') {
          const noPartiesFiltées = new Set(
            partiesD.filter(p => (p.phase || 'saison') === phase).map(p => p.noPartie)
          );
          rép = rép.filter(r => noPartiesFiltées.has(r.noPartie));
        }

        const questParPartie = {};
        partiesD.forEach(p => { questParPartie[p.noPartie] = p.noQuestionnaire; });
        const thèmeLookup = {};
        thèmesD.forEach(t => {
          thèmeLookup[t.noQuestionnaire] = {};
          t.séries.forEach(s => { thèmeLookup[t.noQuestionnaire][s.noSérie] = s.thème; });
        });

        rép.forEach(r => {
          if (r.noJoueur === 99) return;
          const noQ = questParPartie[r.noPartie];
          if (!noQ) return;
          const thème = thèmeLookup[noQ]?.[r.noSérie];
          if (!thème) return;
          if (!statsParThème[thème]) statsParThème[thème] = {};
          const joueurClé = `${r.noÉquipe}-${r.noJoueur}`;
          if (!statsParThème[thème][joueurClé]) statsParThème[thème][joueurClé] = { noÉquipe: r.noÉquipe, noJoueur: r.noJoueur, pts: 0 };
          const série = sér.find(s => s.noSérie === r.noSérie);
          const q = série?.questions.find(q => q.noQuestion === r.noQuestion);
          const pts = r.pointsSecondaires ? (q?.pointsSecondaires ?? 5) : (q?.points ?? 10);
          statsParThème[thème][joueurClé].pts += pts;
        });
      }

      const résultat = Object.entries(statsParThème).map(([thème, joueursMap]) => {
        const joueursList = Object.values(joueursMap).map(j => {
          const joueur = joueurs.find(jj => jj.noÉquipe === j.noÉquipe && jj.noJoueur === j.noJoueur);
          const équipe = équipes.find(e => e.noÉquipe === j.noÉquipe);
          return { noJoueur: j.noJoueur, alias: joueur?.alias || `J${j.noJoueur}`, nom: joueur?.nom || '', nomÉquipe: équipe?.nomÉquipe || '', noÉquipe: j.noÉquipe, pts: j.pts };
        }).sort((a, b) => b.pts - a.pts);
        return { thème, joueurs: joueursList };
      }).sort((a, b) => a.thème.localeCompare(b.thème, 'fr'));
      return res.json(résultat);
    }

    const ds = getDossierStats(req);
    const sr = getSériesStats(ds);
    const partiesDs = ds === dossierSaison ? parties : JSON.parse(fs.readFileSync(path.join(ds, 'parties.json'), 'utf-8'));
    const thèmesDs = ds === dossierSaison ? thèmes : JSON.parse(fs.readFileSync(path.join(ds, 'thèmes.json'), 'utf-8'));
    const joueursDs = ds === dossierSaison ? joueurs : JSON.parse(fs.readFileSync(path.join(ds, 'joueurs.json'), 'utf-8'));
    const équipesDs = ds === dossierSaison ? équipes : JSON.parse(fs.readFileSync(path.join(ds, 'équipes.json'), 'utf-8'));
    let répondants = [];
    try {
      const contenu = fs.readFileSync(path.join(ds, 'répondants.json'), 'utf-8').trim();
      répondants = contenu ? JSON.parse(contenu) : [];
    } catch (e) { répondants = []; }

    const phase = req.query.phase;
    if (phase && phase !== 'tous') {
      const noPartiesFiltées = new Set(
        partiesDs.filter(p => (p.phase || 'saison') === phase).map(p => p.noPartie)
      );
      répondants = répondants.filter(r => noPartiesFiltées.has(r.noPartie));
    }

    // Exclure parties synthétiques
    if (req.query.saison === SAISON_SYNTHÉTIQUE || ds === dossierSaison && saisonActive === SAISON_SYNTHÉTIQUE)
      répondants = répondants.filter(r => r.noPartie > NO_PARTIE_SYNTHÉTIQUE_MAX);

    // Lookup noPartie → noQuestionnaire
    const questParPartie = {};
    partiesDs.forEach(p => { questParPartie[p.noPartie] = p.noQuestionnaire; });

    // Lookup noQuestionnaire → noSérie → { thème, sousThème }
    const thèmeLookup = {};
    thèmesDs.forEach(t => {
      thèmeLookup[t.noQuestionnaire] = {};
      t.séries.forEach(s => { thèmeLookup[t.noQuestionnaire][s.noSérie] = { thème: s.thème, sousThème: s.sousThème }; });
    });

    // Accumuler pts par joueur par thème (excl. collectif)
    const statsParThème = {};
    répondants.forEach(r => {
      if (r.noJoueur === 99) return;
      const noQ = questParPartie[r.noPartie];
      if (!noQ) return;
      const thèmeInfo = thèmeLookup[noQ]?.[r.noSérie];
      if (!thèmeInfo) return;
      const clé = thèmeInfo.thème;
      if (!statsParThème[clé]) statsParThème[clé] = {};
      const joueurClé = `${r.noÉquipe}-${r.noJoueur}`;
      if (!statsParThème[clé][joueurClé]) statsParThème[clé][joueurClé] = { noÉquipe: r.noÉquipe, noJoueur: r.noJoueur, pts: 0 };
      const série = sr.find(s => s.noSérie === r.noSérie);
      const q = série?.questions.find(q => q.noQuestion === r.noQuestion);
      const pts = r.pointsSecondaires ? (q?.pointsSecondaires ?? 5) : (q?.points ?? 10);
      statsParThème[clé][joueurClé].pts += pts;
    });

    const résultat = Object.entries(statsParThème).map(([thème, joueursMap]) => {
      const joueursList = Object.values(joueursMap).map(j => {
        const joueur = joueursDs.find(jj => jj.noÉquipe === j.noÉquipe && jj.noJoueur === j.noJoueur);
        const équipe = équipesDs.find(e => e.noÉquipe === j.noÉquipe);
        return { noJoueur: j.noJoueur, alias: joueur?.alias || `J${j.noJoueur}`, nom: joueur?.nom || '', nomÉquipe: équipe?.nomÉquipe || '', noÉquipe: j.noÉquipe, pts: j.pts };
      }).sort((a, b) => b.pts - a.pts);
      return { thème, joueurs: joueursList };
    }).sort((a, b) => a.thème.localeCompare(b.thème, 'fr'));

    res.json(résultat);
  } catch (e) {
    res.status(500).json({ erreur: e.message });
  }
});

// Compteurs — points par équipe et par joueur
// ============================================================
app.get("/api/stats/compteurs", (req, res) => {
  try {
    if (req.query.saison === 'cumulatif') {
      const saisons = listerDossiersSaisons();
      const ptsJoueur = {};
      const partiesJoueurSet = {};
      const pjParÉquipe = {};
      const phase = req.query.phase;

      for (const { nom, chemin } of saisons) {
        let rép = lireJSON(path.join(chemin, 'répondants.json'), []);
        const sér = lireJSON(path.join(chemin, 'séries.json'), []);
        let alig = lireJSON(path.join(chemin, 'alignements.json'), []);
        const partiesD = lireJSON(path.join(chemin, 'parties.json'), []);

        if (phase && phase !== 'tous') {
          const noPartiesFiltées = new Set(
            partiesD.filter(p => (p.phase || 'saison') === phase).map(p => p.noPartie)
          );
          rép = rép.filter(r => noPartiesFiltées.has(r.noPartie));
          alig = alig.filter(a => noPartiesFiltées.has(a.noPartie));
        }

        rép.forEach(r => {
          const clé = `${r.noÉquipe}-${r.noJoueur}`;
          if (!ptsJoueur[clé]) ptsJoueur[clé] = 0;
          const série = sér.find(s => s.noSérie === r.noSérie);
          const q = série?.questions.find(q => q.noQuestion === r.noQuestion);
          const pts = r.pointsSecondaires ? (q?.pointsSecondaires ?? 5) : (q?.points ?? 10);
          ptsJoueur[clé] += pts;
          if (!partiesJoueurSet[clé]) partiesJoueurSet[clé] = new Set();
          partiesJoueurSet[clé].add(`${nom}-${r.noPartie}`);
        });

        alig.forEach(a => {
          if (!pjParÉquipe[a.noÉquipe]) pjParÉquipe[a.noÉquipe] = new Set();
          pjParÉquipe[a.noÉquipe].add(`${nom}-${a.noPartie}`);
        });
      }

      const résultat = équipes.map(é => {
        const pjÉquipe = pjParÉquipe[é.noÉquipe]?.size || 0;
        const membresÉquipe = joueurs.filter(j => j.noÉquipe === é.noÉquipe && !j.estÉquipe);
        const joueursStats = membresÉquipe.map(j => {
          const clé = `${j.noÉquipe}-${j.noJoueur}`;
          const pts = ptsJoueur[clé] || 0;
          const pj = partiesJoueurSet[clé]?.size || 0;
          return { noJoueur: j.noJoueur, noÉquipe: j.noÉquipe, alias: j.alias, prénom: j.prénom, nom: j.nom, points: pts, pj, ptsPJ: pj > 0 ? Math.round(pts / pj * 100) / 100 : 0 };
        }).sort((a, b) => b.points - a.points);
        const ptsÉquipe = ptsJoueur[`${é.noÉquipe}-99`] || 0;
        const totalÉquipe = joueursStats.reduce((s, j) => s + j.points, 0) + ptsÉquipe;
        return { noÉquipe: é.noÉquipe, nomÉquipe: é.nomÉquipe, totalÉquipe, pjÉquipe, ptsPJÉquipe: pjÉquipe > 0 ? Math.round(totalÉquipe / pjÉquipe * 100) / 100 : 0, ptsÉquipeCollectif: ptsÉquipe, joueurs: joueursStats };
      }).sort((a, b) => b.totalÉquipe - a.totalÉquipe);
      return res.json(résultat);
    }

    const ds = getDossierStats(req);
    const sr = getSériesStats(ds);
    const équipes = JSON.parse(
      fs.readFileSync(path.join(ds, "équipes.json"), "utf-8"),
    );
    const joueurs = JSON.parse(
      fs.readFileSync(path.join(ds, "joueurs.json"), "utf-8"),
    );
    const partiesData = JSON.parse(
      fs.readFileSync(path.join(ds, "parties.json"), "utf-8"),
    );

    let répondants = [];
    try {
      const contenu = fs
        .readFileSync(path.join(ds, "répondants.json"), "utf-8")
        .trim();
      répondants = contenu ? JSON.parse(contenu) : [];
    } catch (e) {
      répondants = [];
    }

    // Filtrer par phase si demandé
    const phase = req.query.phase;
    if (phase && phase !== 'tous') {
      const noPartiesFiltées = new Set(
        partiesData.filter(p => (p.phase || 'saison') === phase).map(p => p.noPartie)
      );
      répondants = répondants.filter(r => noPartiesFiltées.has(r.noPartie));
    }

    const ptsJoueur = {};
    répondants.forEach((r) => {
      const clé = `${r.noÉquipe}-${r.noJoueur}`;
      if (!ptsJoueur[clé]) ptsJoueur[clé] = 0;
      const série = sr.find((s) => s.noSérie === r.noSérie);
      const question = série
        ? série.questions.find((q) => q.noQuestion === r.noQuestion)
        : null;
      const points = r.pointsSecondaires
        ? question
          ? question.pointsSecondaires
          : 5
        : question
          ? question.points
          : 10;
      ptsJoueur[clé] += points;
    });

    const partiesJoueur = {};
    répondants.forEach((r) => {
      const clé = `${r.noÉquipe}-${r.noJoueur}`;
      if (!partiesJoueur[clé]) partiesJoueur[clé] = new Set();
      partiesJoueur[clé].add(r.noPartie);
    });

    let alignements = [];
    try {
      const contenu = fs.readFileSync(path.join(ds, "alignements.json"), "utf-8").trim();
      alignements = contenu ? JSON.parse(contenu) : [];
    } catch (e) { alignements = []; }

    if (phase && phase !== 'tous') {
      const noPartiesFiltées = new Set(
        partiesData.filter(p => (p.phase || 'saison') === phase).map(p => p.noPartie)
      );
      alignements = alignements.filter(a => noPartiesFiltées.has(a.noPartie));
    }

    const résultat = équipes
      .map((é) => {
        const pjÉquipe = new Set(alignements.filter(a => a.noÉquipe === é.noÉquipe).map(a => a.noPartie)).size;
        const membresÉquipe = joueurs.filter((j) => j.noÉquipe === é.noÉquipe);
        const joueursStats = membresÉquipe
          .map((j) => {
            const clé = `${j.noÉquipe}-${j.noJoueur}`;
            const pts = ptsJoueur[clé] || 0;
            const pj = partiesJoueur[clé] ? partiesJoueur[clé].size : 0;
            return {
              noJoueur: j.noJoueur,
              noÉquipe: j.noÉquipe,
              alias: j.alias,
              prénom: j.prénom,
              nom: j.nom,
              points: pts,
              pj,
              ptsPJ: pj > 0 ? Math.round((pts / pj) * 100) / 100 : 0,
            };
          })
          .sort((a, b) => b.points - a.points);

        const ptsÉquipe = ptsJoueur[`${é.noÉquipe}-99`] || 0;
        const totalÉquipe =
          joueursStats.reduce((sum, j) => sum + j.points, 0) + ptsÉquipe;

        return {
          noÉquipe: é.noÉquipe,
          nomÉquipe: é.nomÉquipe,
          totalÉquipe,
          pjÉquipe,
          ptsPJÉquipe: pjÉquipe > 0 ? Math.round((totalÉquipe / pjÉquipe) * 100) / 100 : 0,
          ptsÉquipeCollectif: ptsÉquipe,
          joueurs: joueursStats,
        };
      })
      .sort((a, b) => b.totalÉquipe - a.totalÉquipe);

    res.json(résultat);
  } catch (e) {
    console.error("Erreur stats compteurs:", e);
    res.status(500).json({ erreur: e.message });
  }
});

// ============================================================
// Détail par joueur — parties jouées et points
// ============================================================
app.get("/api/stats/joueur/:noEquipe/:noJoueur", (req, res) => {
  try {
    const ds = getDossierStats(req);
    const sr = getSériesStats(ds);
    const noÉquipe = parseInt(req.params.noEquipe);
    const noJoueur = parseInt(req.params.noJoueur);
    const parties = JSON.parse(
      fs.readFileSync(path.join(ds, "parties.json"), "utf-8"),
    );
    const équipes = JSON.parse(
      fs.readFileSync(path.join(ds, "équipes.json"), "utf-8"),
    );

    let répondants = [];
    try {
      const contenu = fs
        .readFileSync(path.join(ds, "répondants.json"), "utf-8")
        .trim();
      répondants = contenu ? JSON.parse(contenu) : [];
    } catch (e) {
      répondants = [];
    }

    // Répondants de ce joueur seulement
    const répJoueur = répondants.filter(
      (r) => r.noÉquipe === noÉquipe && r.noJoueur === noJoueur,
    );
    // Grouper par partie avec calcul des points
    const partiesMap = {};
    répJoueur.forEach((r) => {
      if (!partiesMap[r.noPartie]) partiesMap[r.noPartie] = 0;
      const série = sr.find((s) => s.noSérie === r.noSérie);
      const question = série
        ? série.questions.find((q) => q.noQuestion === r.noQuestion)
        : null;
      const points = r.pointsSecondaires
        ? question
          ? question.pointsSecondaires
          : 5
        : question
          ? question.points
          : 10;
      partiesMap[r.noPartie] += points;
    });

    // Calculer les scores totaux par partie
    const scoresParPartie = {};
    répondants.forEach((r) => {
      if (!scoresParPartie[r.noPartie]) scoresParPartie[r.noPartie] = {};
      if (!scoresParPartie[r.noPartie][r.noÉquipe])
        scoresParPartie[r.noPartie][r.noÉquipe] = 0;
      const série = sr.find((s) => s.noSérie === r.noSérie);
      const question = série
        ? série.questions.find((q) => q.noQuestion === r.noQuestion)
        : null;
      const points = r.pointsSecondaires
        ? question
          ? question.pointsSecondaires
          : 5
        : question
          ? question.points
          : 10;
      scoresParPartie[r.noPartie][r.noÉquipe] += points;
    });

    // Enrichir avec infos de partie
    const résultat = Object.entries(partiesMap)
      .map(([noPartie, ptsJoueur]) => {
        const p = parties.find((p) => p.noPartie === parseInt(noPartie));
        const équipeA = équipes.find((e) => e.noÉquipe === p?.noÉquipeA);
        const équipeB = équipes.find((e) => e.noÉquipe === p?.noÉquipeB);
        const scores = scoresParPartie[parseInt(noPartie)] || {};
        const scoreA = scores[p?.noÉquipeA] || 0;
        const scoreB = scores[p?.noÉquipeB] || 0;
        const ptsTotal = scoreA + scoreB;

        return {
          noPartie: parseInt(noPartie),
          date: p?.date || "",
          nomÉquipeA: équipeA?.nomÉquipe || "",
          nomÉquipeB: équipeB?.nomÉquipe || "",
          scoreA,
          scoreB,
          ptsJoueur,
          ptsTotal,
          pctJoueur:
            ptsTotal > 0 ? Math.round((ptsJoueur / ptsTotal) * 10000) / 100 : 0,
        };
      })
      .sort((a, b) => a.date.localeCompare(b.date));

    res.json(résultat);
  } catch (e) {
    console.error("Erreur stats joueur:", e);
    res.status(500).json({ erreur: e.message });
  }
});

// ============================================================
// Profil joueur — infos, parties, stats par thème
// ============================================================
app.get('/api/stats/joueur-profil/:noEquipe/:noJoueur', (req, res) => {
  try {
    const ds = getDossierStats(req);
    const sr = getSériesStats(ds);
    const joueursDs = ds === dossierSaison ? joueurs : JSON.parse(fs.readFileSync(path.join(ds, 'joueurs.json'), 'utf-8'));
    const équipesDs = ds === dossierSaison ? équipes : JSON.parse(fs.readFileSync(path.join(ds, 'équipes.json'), 'utf-8'));
    const partiesDs = ds === dossierSaison ? parties : JSON.parse(fs.readFileSync(path.join(ds, 'parties.json'), 'utf-8'));
    const thèmesDs = ds === dossierSaison ? thèmes : JSON.parse(fs.readFileSync(path.join(ds, 'thèmes.json'), 'utf-8'));
    const noÉquipe = parseInt(req.params.noEquipe);
    const noJoueur = parseInt(req.params.noJoueur);

    const joueur = joueursDs.find(j => j.noÉquipe === noÉquipe && j.noJoueur === noJoueur);
    if (!joueur) return res.status(404).json({ erreur: 'Joueur introuvable' });

    const équipe = équipesDs.find(e => e.noÉquipe === noÉquipe);

    let répondants = [];
    try {
      const contenu = fs.readFileSync(path.join(ds, 'répondants.json'), 'utf-8').trim();
      répondants = contenu ? JSON.parse(contenu) : [];
    } catch (e) { répondants = []; }

    let alignements = [];
    try {
      const contenu = fs.readFileSync(path.join(ds, 'alignements.json'), 'utf-8').trim();
      alignements = contenu ? JSON.parse(contenu) : [];
    } catch (e) { alignements = []; }

    // Filtrer par phase si demandé
    const phase = req.query.phase;
    let répFiltrés = répondants;
    let alignFiltés = alignements;
    if (phase && phase !== 'tous') {
      const noPartiesFiltées = new Set(
        partiesDs.filter(p => (p.phase || 'saison') === phase).map(p => p.noPartie)
      );
      répFiltrés = répondants.filter(r => noPartiesFiltées.has(r.noPartie));
      alignFiltés = alignements.filter(a => noPartiesFiltées.has(a.noPartie));
    }

    const répJoueur = répFiltrés.filter(r => r.noÉquipe === noÉquipe && r.noJoueur === noJoueur);

    // PJ depuis alignements
    const pj = alignFiltés.filter(a => a.noÉquipe === noÉquipe && (a.joueurs || []).includes(noJoueur)).length;

    // Pts par partie
    const ptsParPartie = {};
    répJoueur.forEach(r => {
      if (!ptsParPartie[r.noPartie]) ptsParPartie[r.noPartie] = 0;
      const série = sr.find(s => s.noSérie === r.noSérie);
      const question = série ? série.questions.find(q => q.noQuestion === r.noQuestion) : null;
      const pts = r.pointsSecondaires ? (question ? question.pointsSecondaires : 5) : (question ? question.points : 10);
      ptsParPartie[r.noPartie] += pts;
    });

    const totalPts = Object.values(ptsParPartie).reduce((s, v) => s + v, 0);

    // Scores totaux par partie
    const scoresParPartie = {};
    répFiltrés.forEach(r => {
      if (!scoresParPartie[r.noPartie]) scoresParPartie[r.noPartie] = {};
      if (!scoresParPartie[r.noPartie][r.noÉquipe]) scoresParPartie[r.noPartie][r.noÉquipe] = 0;
      const série = sr.find(s => s.noSérie === r.noSérie);
      const question = série ? série.questions.find(q => q.noQuestion === r.noQuestion) : null;
      const pts = r.pointsSecondaires ? (question ? question.pointsSecondaires : 5) : (question ? question.points : 10);
      scoresParPartie[r.noPartie][r.noÉquipe] += pts;
    });

    // Liste des parties
    const partiesJoueur = Object.entries(ptsParPartie).map(([noPartieStr, ptsJoueur]) => {
      const noPartie = parseInt(noPartieStr);
      const p = partiesDs.find(p => p.noPartie === noPartie);
      const noAdv = p?.noÉquipeA === noÉquipe ? p?.noÉquipeB : p?.noÉquipeA;
      const équipeAdv = équipesDs.find(e => e.noÉquipe === noAdv);
      const scores = scoresParPartie[noPartie] || {};
      const scoreÉquipe = scores[noÉquipe] || 0;
      const scoreAdv = scores[noAdv] || 0;
      const ptsTotal = scoreÉquipe + scoreAdv;
      const résultat = scoreÉquipe > scoreAdv ? 'V' : scoreÉquipe < scoreAdv ? 'D' : 'N';
      return {
        noPartie,
        date: p?.date || '',
        noAdversaire: noAdv,
        nomAdversaire: équipeAdv?.nomÉquipe || '',
        résultat,
        scoreÉquipe,
        scoreAdv,
        ptsJoueur,
        ptsTotal,
        pctJoueur: ptsTotal > 0 ? Math.round(ptsJoueur / ptsTotal * 10000) / 100 : 0,
      };
    }).sort((a, b) => a.date.localeCompare(b.date));

    // Questionnaires protégés : au moins une partie non jouée avec ce questionnaire
    const partiesJouées = new Set(répondants.map(r => r.noPartie));
    const partiesParQuestionnaire = {};
    partiesDs.forEach(p => {
      if (!partiesParQuestionnaire[p.noQuestionnaire]) partiesParQuestionnaire[p.noQuestionnaire] = [];
      partiesParQuestionnaire[p.noQuestionnaire].push(p.noPartie);
    });
    const questionnairesProtégés = new Set();
    Object.entries(partiesParQuestionnaire).forEach(([noQ, noParties]) => {
      if (noParties.some(noP => !partiesJouées.has(noP))) questionnairesProtégés.add(parseInt(noQ));
    });

    // Lookup questions (texte + réponse)
    let questionsData = [];
    try {
      const contenu = fs.readFileSync(path.join(ds, 'questions.json'), 'utf-8').trim();
      questionsData = contenu ? JSON.parse(contenu) : [];
    } catch (e) { questionsData = []; }
    const questionsLookup = {};
    questionsData.forEach(q => {
      questionsLookup[q.noQuestionnaire] = {};
      q.séries.forEach(s => {
        questionsLookup[q.noQuestionnaire][s.noSérie] = {};
        s.questions.forEach(qq => { questionsLookup[q.noQuestionnaire][s.noSérie][qq.noQuestion] = qq; });
      });
    });

    // Stats par thème
    const questParPartie = {};
    partiesDs.forEach(p => { questParPartie[p.noPartie] = p.noQuestionnaire; });
    const thèmeLookup = {};
    thèmesDs.forEach(t => {
      thèmeLookup[t.noQuestionnaire] = {};
      t.séries.forEach(s => { thèmeLookup[t.noQuestionnaire][s.noSérie] = s.thème; });
    });
    const ptsParThème = {};
    répJoueur.forEach(r => {
      const noQ = questParPartie[r.noPartie];
      const thème = noQ && thèmeLookup[noQ] ? thèmeLookup[noQ][r.noSérie] : null;
      if (!thème) return;
      const série = sr.find(s => s.noSérie === r.noSérie);
      const question = série ? série.questions.find(q => q.noQuestion === r.noQuestion) : null;
      const pts = r.pointsSecondaires ? (question ? question.pointsSecondaires : 5) : (question ? question.points : 10);
      ptsParThème[thème] = (ptsParThème[thème] || 0) + pts;
    });
    const themesResult = Object.entries(ptsParThème)
      .map(([theme, pts]) => ({ theme, pts }))
      .sort((a, b) => b.pts - a.pts);

    res.json({
      joueur: {
        alias: joueur.alias,
        nom: joueur.nom || '',
        noÉquipe,
        nomÉquipe: équipe?.nomÉquipe || '',
        pj,
        pts: totalPts,
        ptsPJ: pj > 0 ? Math.round(totalPts / pj * 100) / 100 : 0,
      },
      parties: partiesJoueur,
      themes: themesResult,
      questions: répJoueur.map(r => {
        const noQ = questParPartie[r.noPartie];
        const thème = noQ && thèmeLookup[noQ] ? thèmeLookup[noQ][r.noSérie] : null;
        const série = sr.find(s => s.noSérie === r.noSérie);
        const qSérie = série ? série.questions.find(q => q.noQuestion === r.noQuestion) : null;
        const pts = r.pointsSecondaires ? (qSérie ? qSérie.pointsSecondaires : 5) : (qSérie ? qSérie.points : 10);
        const protégé = noQ ? questionnairesProtégés.has(noQ) : false;
        const qTexte = !protégé && noQ ? questionsLookup[noQ]?.[r.noSérie]?.[r.noQuestion] : null;
        const p = partiesDs.find(p => p.noPartie === r.noPartie);
        const noAdv = p?.noÉquipeA === noÉquipe ? p?.noÉquipeB : p?.noÉquipeA;
        const équipeAdv = équipesDs.find(e => e.noÉquipe === noAdv);
        return {
          noPartie: r.noPartie,
          date: p?.date || '',
          noAdversaire: noAdv,
          nomAdversaire: équipeAdv?.nomÉquipe || '',
          noSérie: r.noSérie,
          thème: thème || '',
          texte: protégé ? '' : (qTexte?.texte || ''),
          réponse: protégé ? '' : (qTexte?.réponse || ''),
          pts,
          estSecondaire: !!r.pointsSecondaires,
        };
      }).sort((a, b) => a.date.localeCompare(b.date) || a.noPartie - b.noPartie),
    });
  } catch (e) {
    console.error('Erreur profil joueur:', e);
    res.status(500).json({ erreur: e.message });
  }
});

app.get('/api/stats/equipe/:noEquipe', (req, res) => {
  try {
    const ds = getDossierStats(req);
    const sr = getSériesStats(ds);
    const équipesDs = ds === dossierSaison ? équipes : JSON.parse(fs.readFileSync(path.join(ds, 'équipes.json'), 'utf-8'));
    const joueursDs = ds === dossierSaison ? joueurs : JSON.parse(fs.readFileSync(path.join(ds, 'joueurs.json'), 'utf-8'));
    const partiesDs = ds === dossierSaison ? parties : JSON.parse(fs.readFileSync(path.join(ds, 'parties.json'), 'utf-8'));
    const noÉquipe = parseInt(req.params.noEquipe);
    const équipe = équipesDs.find(e => e.noÉquipe === noÉquipe);
    if (!équipe) return res.status(404).json({ erreur: 'Équipe introuvable' });

    let répondants = [];
    try {
      const contenu = fs.readFileSync(path.join(ds, 'répondants.json'), 'utf-8').trim();
      répondants = contenu ? JSON.parse(contenu) : [];
    } catch (e) { répondants = []; }

    let alignements = [];
    try {
      const contenu = fs.readFileSync(path.join(ds, 'alignements.json'), 'utf-8').trim();
      alignements = contenu ? JSON.parse(contenu) : [];
    } catch (e) { alignements = []; }

    const membresÉquipe = joueursDs.filter(j => j.noÉquipe === noÉquipe);

    // Calcul des points par partie et par joueur
    const calcPts = (r) => {
      const série = sr.find(s => s.noSérie === r.noSérie);
      const q = série?.questions.find(q => q.noQuestion === r.noQuestion);
      return r.pointsSecondaires ? (q?.pointsSecondaires ?? 5) : (q?.points ?? 10);
    };

    // Scores totaux par partie (toutes équipes)
    const scoresParPartie = {};
    répondants.forEach(r => {
      if (!scoresParPartie[r.noPartie]) scoresParPartie[r.noPartie] = {};
      if (!scoresParPartie[r.noPartie][r.noÉquipe]) scoresParPartie[r.noPartie][r.noÉquipe] = 0;
      scoresParPartie[r.noPartie][r.noÉquipe] += calcPts(r);
    });

    // Parties jouées par cette équipe (via alignements)
    const noPartiesÉquipe = [...new Set(alignements.filter(a => a.noÉquipe === noÉquipe).map(a => a.noPartie))];

    const partiesÉquipe = noPartiesÉquipe.map(noPartie => {
      const p = partiesDs.find(p => p.noPartie === noPartie);
      if (!p) return null;
      const noAdv = p.noÉquipeA === noÉquipe ? p.noÉquipeB : p.noÉquipeA;
      const adversaire = équipesDs.find(e => e.noÉquipe === noAdv);
      const scores = scoresParPartie[noPartie] || {};
      const scoreÉquipe = scores[noÉquipe] || 0;
      const scoreAdv = scores[noAdv] || 0;
      const résultat = scoreÉquipe > scoreAdv ? 'V' : scoreÉquipe < scoreAdv ? 'D' : 'N';

      // Contribution par joueur dans cette partie
      const répPartie = répondants.filter(r => r.noPartie === noPartie && r.noÉquipe === noÉquipe);
      const ptsParJoueur = {};
      répPartie.forEach(r => {
        const clé = r.noJoueur;
        if (!ptsParJoueur[clé]) ptsParJoueur[clé] = 0;
        ptsParJoueur[clé] += calcPts(r);
      });

      // Tous les joueurs alignés, même ceux à 0 pts
      const alignPartie = alignements.find(a => a.noPartie === noPartie && a.noÉquipe === noÉquipe);
      const tousNoJoueurs = [...new Set([
        ...Object.keys(ptsParJoueur).map(Number),
        ...(alignPartie?.joueurs || [])
      ])];

      const joueursPartie = tousNoJoueurs.map(nJ => {
        if (nJ === 99) return { alias: 'Collectif', pts: ptsParJoueur[99] || 0, estCollectif: true };
        const j = membresÉquipe.find(j => j.noJoueur === nJ);
        return { alias: j?.alias || `Joueur ${nJ}`, pts: ptsParJoueur[nJ] || 0, estCollectif: false };
      }).sort((a, b) => b.pts - a.pts);

      return { noPartie, date: p.date, noAdversaire: noAdv, nomAdversaire: adversaire?.nomÉquipe || `Équipe ${noAdv}`, scoreÉquipe, scoreAdv, résultat, joueurs: joueursPartie };
    }).filter(Boolean).sort((a, b) => a.date.localeCompare(b.date));

    // Compteurs joueurs (tous les membres, même 0 pts)
    const ptsParJoueurTotal = {};
    const partiesParJoueur = {};
    répondants.filter(r => r.noÉquipe === noÉquipe).forEach(r => {
      if (!ptsParJoueurTotal[r.noJoueur]) ptsParJoueurTotal[r.noJoueur] = 0;
      if (!partiesParJoueur[r.noJoueur]) partiesParJoueur[r.noJoueur] = new Set();
      ptsParJoueurTotal[r.noJoueur] += calcPts(r);
      partiesParJoueur[r.noJoueur].add(r.noPartie);
    });

    // PJ par joueur depuis alignements (inclut les joueurs à 0 pts)
    const pjParJoueur = {};
    alignements.filter(a => a.noÉquipe === noÉquipe).forEach(a => {
      a.joueurs.forEach(noJ => {
        if (!pjParJoueur[noJ]) pjParJoueur[noJ] = new Set();
        pjParJoueur[noJ].add(a.noPartie);
      });
    });

    // PJ pour joueur 99 (collectif) = toutes les parties jouées par l'équipe
    pjParJoueur[99] = new Set(
      alignements.filter(a => a.noÉquipe === noÉquipe).map(a => a.noPartie)
    );

    const joueursStats = membresÉquipe.map(j => {
      const pts = ptsParJoueurTotal[j.noJoueur] || 0;
      const pj = pjParJoueur[j.noJoueur]?.size || 0;
      return { noJoueur: j.noJoueur, alias: j.alias, prénom: j.prénom, nom: j.nom, pts, pj, ptsPJ: pj > 0 ? Math.round(pts / pj * 100) / 100 : 0 };
    }).sort((a, b) => b.pts - a.pts);

    res.json({ équipe, parties: partiesÉquipe, joueurs: joueursStats });
  } catch (e) {
    console.error('Erreur stats équipe:', e);
    res.status(500).json({ erreur: e.message });
  }
});

app.get('/api/stats/partie/:noPartie', (req, res) => {
    try {
        const ds = getDossierStats(req);
        const sr = getSériesStats(ds);
        const noPartie = parseInt(req.params.noPartie);
        const cheminPartie = path.join(
            ds, 'parties', `répondants-${noPartie}.json`);

        let répondants = [];
        try {
            const contenu = fs.readFileSync(cheminPartie, 'utf-8').trim();
            répondants = contenu ? JSON.parse(contenu) : [];
        } catch (e) { répondants = []; }

        // Calculer points par joueur pour cette partie
        const ptsJoueur = {};
        répondants.forEach(r => {
            const clé = `${r.noÉquipe}-${r.noJoueur}`;
            if (!ptsJoueur[clé]) ptsJoueur[clé] = { noÉquipe: r.noÉquipe, noJoueur: r.noJoueur, points: 0 };
            const série = sr.find(s => s.noSérie === r.noSérie);
            const question = série
                ? série.questions.find(q => q.noQuestion === r.noQuestion)
                : null;
            const pts = r.pointsSecondaires
                ? question?.pointsSecondaires ?? 0
                : question?.points ?? 0;
            ptsJoueur[clé].points += pts;
        });

        res.json(Object.values(ptsJoueur));
    } catch (e) {
        res.status(500).json({ erreur: e.message });
    }
});

// ============================================================
// Feuille de match — questions + répondants d'une partie
// ============================================================
app.get('/api/stats/match/:noPartie', (req, res) => {
  try {
    const ds = getDossierStats(req);
    const sr = getSériesStats(ds);
    const partiesDs = ds === dossierSaison ? parties : JSON.parse(fs.readFileSync(path.join(ds, 'parties.json'), 'utf-8'));
    const équipesDs = ds === dossierSaison ? équipes : JSON.parse(fs.readFileSync(path.join(ds, 'équipes.json'), 'utf-8'));
    const joueursDs = ds === dossierSaison ? joueurs : JSON.parse(fs.readFileSync(path.join(ds, 'joueurs.json'), 'utf-8'));
    const thèmesDs = ds === dossierSaison ? thèmes : JSON.parse(fs.readFileSync(path.join(ds, 'thèmes.json'), 'utf-8'));
    const noPartie = parseInt(req.params.noPartie);
    const partie = partiesDs.find(p => p.noPartie === noPartie);
    if (!partie) return res.status(404).json({ erreur: 'Partie introuvable' });

    // Protection : bloquer si une autre partie avec le même questionnaire n'a pas encore de répondants
    const autresPartiesMêmeQ = partiesDs.filter(p =>
      p.noPartie !== noPartie && p.noQuestionnaire === partie.noQuestionnaire
    );
    const aDesRépondants = (noP) => {
      try {
        const tous = JSON.parse(fs.readFileSync(path.join(ds, 'répondants.json'), 'utf-8').trim() || '[]');
        return tous.some(r => r.noPartie === noP);
      } catch (e) { return false; }
    };
    const partieNonJouée = autresPartiesMêmeQ.find(p => !aDesRépondants(p.noPartie));
    if (partieNonJouée) {
      const équipeQ = équipesDs.find(e => e.noÉquipe === partieNonJouée.noÉquipeQuestionnaire);
      const nomÉquipeQ = équipeQ ? équipeQ.nomÉquipe : partieNonJouée.noÉquipeQuestionnaire ? `Équipe ${partieNonJouée.noÉquipeQuestionnaire}` : null;
      return res.status(403).json({
        erreur: 'protégé',
        noPartieBloquante: partieNonJouée.noPartie,
        datePartieBloquante: partieNonJouée.date,
        noQuestionnaire: partie.noQuestionnaire,
        équipeQuestionnaire: nomÉquipeQ
      });
    }

    // Répondants de la partie — depuis répondants.json, sinon fallback sur répondants-{N}.json
    let répondants = [];
    try {
      const contenu = fs.readFileSync(path.join(ds, 'répondants.json'), 'utf-8').trim();
      const tous = contenu ? JSON.parse(contenu) : [];
      répondants = tous.filter(r => r.noPartie === noPartie);
    } catch (e) { répondants = []; }
    if (répondants.length === 0) {
      try {
        const contenu = fs.readFileSync(path.join(ds, 'parties', `répondants-${noPartie}.json`), 'utf-8').trim();
        répondants = contenu ? JSON.parse(contenu) : [];
      } catch (e) { répondants = []; }
    }

    // Questions
    const cheminQuestions = path.join(ds, 'questions.json');
    let questionsData = [];
    try {
      const contenu = fs.readFileSync(cheminQuestions, 'utf-8').trim();
      questionsData = contenu ? JSON.parse(contenu) : [];
    } catch (e) { questionsData = []; }

    const questionnaireQ = questionsData.find(q => q.noQuestionnaire === partie.noQuestionnaire);
    const questionnaireT = thèmesDs.find(t => t.noQuestionnaire === partie.noQuestionnaire);

    const équipeA = équipesDs.find(e => e.noÉquipe === partie.noÉquipeA);
    const équipeB = équipesDs.find(e => e.noÉquipe === partie.noÉquipeB);
    const équipeQ = équipesDs.find(e => e.noÉquipe === partie.noÉquipeQuestionnaire);

    // Scores
    const scores = {};
    répondants.forEach(r => {
      if (!scores[r.noÉquipe]) scores[r.noÉquipe] = 0;
      const sérieInfo = sr.find(s => s.noSérie === r.noSérie);
      const qInfo = sérieInfo?.questions.find(q => q.noQuestion === r.noQuestion);
      const pts = r.pointsSecondaires ? (qInfo?.pointsSecondaires ?? 0) : (qInfo?.points ?? 0);
      scores[r.noÉquipe] += pts;
    });

    // Séries avec questions et répondants
    const sériesMatch = (questionnaireQ?.séries || []).map(sérieQ => {
      const sérieInfo = sr.find(s => s.noSérie === sérieQ.noSérie);
      const thèmeSérie = questionnaireT?.séries.find(t => t.noSérie === sérieQ.noSérie);

      const questions = sérieQ.questions.map(q => {
        const répondant = répondants.find(r => r.noSérie === sérieQ.noSérie && r.noQuestion === q.noQuestion);
        const qInfo = sérieInfo?.questions.find(sq => sq.noQuestion === q.noQuestion);

        let répondantInfo = null;
        if (répondant) {
          const nomÉq = équipesDs.find(e => e.noÉquipe === répondant.noÉquipe)?.nomÉquipe || `Équipe ${répondant.noÉquipe}`;
          const alias = répondant.noJoueur === 99
            ? '👥 ' + nomÉq
            : joueursDs.find(j => j.noÉquipe === répondant.noÉquipe && j.noJoueur === répondant.noJoueur)?.alias || `Joueur ${répondant.noJoueur}`;
          const pts = répondant.pointsSecondaires ? (qInfo?.pointsSecondaires ?? 0) : (qInfo?.points ?? 0);
          répondantInfo = { noÉquipe: répondant.noÉquipe, alias, nomÉquipe: nomÉq, points: pts, estSecondaire: répondant.pointsSecondaires };
        }

        return {
          noQuestion: q.noQuestion,
          texte: q.texte,
          réponse: q.réponse,
          points: qInfo?.points ?? 10,
          pointsSecondaires: qInfo?.pointsSecondaires ?? 0,
          répondant: répondantInfo
        };
      });

      return {
        noSérie: sérieQ.noSérie,
        typeSérie: sérieInfo?.typeSérie || '',
        estÉquipe: sérieInfo?.estÉquipe || false,
        thème: thèmeSérie?.thème || '',
        sousThème: thèmeSérie?.sousThème || '',
        questionGroupe1: sérieQ.questionGroupe1 || null,
        questionGroupe2: sérieQ.questionGroupe2 || null,
        questions
      };
    });

    const saisonRequête = (req.query.saison && /^\d{4}-\d{4}$/.test(req.query.saison)) ? req.query.saison : saisonActive;
    const donnéesSynthétiques = saisonRequête === '2025-2026' && noPartie <= 35;

    res.json({
      noPartie,
      date: partie.date,
      animateur: partie.animateur,
      noQuestionnaire: partie.noQuestionnaire,
      noÉquipeA: partie.noÉquipeA,
      noÉquipeB: partie.noÉquipeB,
      nomÉquipeA: équipeA?.nomÉquipe || '',
      nomÉquipeB: équipeB?.nomÉquipe || '',
      nomÉquipeQuestionnaire: équipeQ?.nomÉquipe || null,
      scoreA: scores[partie.noÉquipeA] || 0,
      scoreB: scores[partie.noÉquipeB] || 0,
      donnéesSynthétiques,
      séries: sériesMatch
    });
  } catch (e) {
    res.status(500).json({ erreur: e.message });
  }
});

// ============================================================
// États des parties en cours — un état par noPartie
// Chaque partie a sa propre room Socket.io : "partie-25", etc.
// ============================================================
const étatsParties = {};

function obtenirÉtat(noPartie) {
  if (!étatsParties[noPartie]) {
    // Vérifier si cette partie est terminée (dans alignements.json)
    let estTerminée = false;
    try {
      const cheminAlign = path.join(dossierSaison, "alignements.json");
      const alignements = JSON.parse(fs.readFileSync(cheminAlign, "utf-8"));
      estTerminée = alignements.some((a) => a.noPartie === noPartie);
    } catch (e) {
      estTerminée = false;
    }

    étatsParties[noPartie] = {
      noPartie,
      mode: estTerminée ? "terminée" : "initialisation",
      joueursConnectés: [],
      scores: {},
      scoresJoueurs: {},
      noSérieActuelle: 1,
      noQuestionActuelle: 1,
      réplique: null,
      buzzVerrou: false,
      overrideÉquipe: null,
    };
  }

  return étatsParties[noPartie];
}

// ============================================================
// Reculer à la question précédente — utile en cas d'erreur
// ============================================================
function reculerQuestion(état) {
  if (état.noQuestionActuelle > 1) {
    état.noQuestionActuelle--;
  } else {
    const indexActuel = séries.findIndex(
      (s) => s.noSérie === état.noSérieActuelle,
    );
    if (indexActuel > 0) {
      const sériePrécédente = séries[indexActuel - 1];
      état.noSérieActuelle = sériePrécédente.noSérie;
      état.noQuestionActuelle = sériePrécédente.questions.length;
    }
  }
  état.réplique = null;
}

// ============================================================
// Avancer à la question suivante
// ============================================================
function avancerQuestion(état) {
  const sérieActuelle = séries.find((s) => s.noSérie === état.noSérieActuelle);
  const maxQuestions = sérieActuelle ? sérieActuelle.questions.length : 1;

  if (état.noQuestionActuelle < maxQuestions) {
    état.noQuestionActuelle++;
  } else {
    const indexActuel = séries.findIndex(
      (s) => s.noSérie === état.noSérieActuelle,
    );
    if (indexActuel < séries.length - 1) {
      état.noSérieActuelle = séries[indexActuel + 1].noSérie;
      état.noQuestionActuelle = 1;
    }
  }
  état.réplique = null;
}

// ============================================================
// Retourne la série et la question courante
// Inclut le répondant existant si la question a déjà été répondue
// Calcule estÉquipe dynamiquement pour la série 5
// ============================================================
function questionCourante(état) {
  const série = séries.find((s) => s.noSérie === état.noSérieActuelle);
  if (!série) return null;
  const question = série.questions.find(
    (q) => q.noQuestion === état.noQuestionActuelle,
  );

  // Vérifier si cette question a déjà été répondue
  let répondantExistant = null;
  let répondants = [];
  const cheminPartie = path.join(
    dossierSaison,
    "parties",
    `répondants-${état.noPartie}.json`,
  );
  try {
    const contenu = fs.readFileSync(cheminPartie, "utf-8").trim();
    répondants = contenu ? JSON.parse(contenu) : [];
    répondantExistant =
      répondants.find(
        (r) =>
          r.noSérie === état.noSérieActuelle &&
          r.noQuestion === état.noQuestionActuelle,
      ) || null;
  } catch (e) {
    répondantExistant = null;
    répondants = [];
  }

  // Calculer estÉquipe pour cette question
  // Série 5 — estÉquipe null = dépend de Q1
  // Si Q1 non répondue → équipe, sinon individuel
  // L'animateur peut overrider via état.overrideÉquipe
  let estÉquipe = série.estÉquipe; // valeur par défaut de la série

  if (question && question.estÉquipe !== undefined) {
    if (question.estÉquipe === null) {
      // Série 5 Q2-5 — vérifier si Q1 a été répondue
      const q1Répondue = répondants.some(
        (r) => r.noSérie === état.noSérieActuelle && r.noQuestion === 1,
      );
      // Override manuel de l'animateur prioritaire
      if (état.overrideÉquipe !== undefined && état.overrideÉquipe !== null) {
        estÉquipe = état.overrideÉquipe;
      } else {
        estÉquipe = q1Répondue; // équipe si Q1 répondue
      }
    } else {
      estÉquipe = question.estÉquipe; // valeur explicite (Q1 = false)
    }
  }

  return { série, question, répondantExistant, estÉquipe };
}

// ============================================================
// Enregistre un répondant dans le fichier de la partie en cours
// Appelée après une bonne réponse ou une confirmation d'écrasement
// ============================================================
function enregistrerRépondant(
  état,
  répondants,
  cheminPartie,
  { noÉquipe, noJoueur, points, estSecondaire },
) {
  if (!état.scores[noÉquipe]) état.scores[noÉquipe] = 0;
  état.scores[noÉquipe] += points;
  const clefJoueur = `${noÉquipe}_${noJoueur}`;
  if (!état.scoresJoueurs[clefJoueur]) état.scoresJoueurs[clefJoueur] = 0;
  état.scoresJoueurs[clefJoueur] += points;

  répondants.push({
    noPartie: état.noPartie,
    noSérie: état.noSérieActuelle,
    noQuestion: état.noQuestionActuelle,
    noJoueur,
    noÉquipe,
    pointsSecondaires: estSecondaire,
  });

  répondants.sort((a, b) => {
    if (a.noPartie !== b.noPartie) return a.noPartie - b.noPartie;
    if (a.noSérie !== b.noSérie) return a.noSérie - b.noSérie;
    return a.noQuestion - b.noQuestion;
  });
  fs.writeFileSync(cheminPartie, JSON.stringify(répondants, null, 2), "utf-8");

  avancerQuestion(état);
  état.buzzVerrou = false;

  // Diffuser à tous les membres de la room de cette partie
  const room = `partie-${état.noPartie}`;
  io.to(room).emit("scoresMisÀJour", { scores: état.scores, scoresJoueurs: état.scoresJoueurs });
  io.to(room).emit("questionMisÀJour", questionCourante(état));
  io.to(room).emit("reset");
}

// ============================================================
// Gestion des connexions Socket.io
// Chaque socket rejoint une room selon la partie choisie
// ============================================================
io.on("connection", (socket) => {
  // --------------------------------------------------------
  // Un animateur ou joueur choisit sa partie
  // Il rejoint la room correspondante
  // --------------------------------------------------------
  socket.on("rejoindrePartie", (noPartie) => {
    // Quitter les autres rooms si déjà dans une
    if (socket.noPartie) {
      socket.leave(`partie-${socket.noPartie}`);
    }
    socket.noPartie = noPartie;
    socket.join(`partie-${noPartie}`);

    // Envoyer l'état actuel de cette partie
    const état = obtenirÉtat(noPartie);
    socket.emit("état", état);
  });

  // --------------------------------------------------------
  // Un joueur s'enregistre dans sa partie
  // --------------------------------------------------------
  socket.on("sEnregistrer", (joueur) => {
    const état = obtenirÉtat(joueur.noPartie);
    // Retirer si déjà présent (reconnexion)
    état.joueursConnectés = état.joueursConnectés.filter(
      (j) =>
        !(j.noÉquipe === joueur.noÉquipe && j.noJoueur === joueur.noJoueur),
    );
    état.joueursConnectés.push(joueur);
    io.to(`partie-${joueur.noPartie}`).emit(
      "joueursConnectés",
      état.joueursConnectés,
    );

    // Ajout pour trouver si un joueur se déconnecte et l'identifier
    état.joueursConnectés.push(joueur);
    socket.joueur = joueur; // ← stocker l'identité du joueur dans le socket

    // Envoyer l'état actuel au joueur qui vient de s'enregistrer
    // Permet de détecter si la partie est déjà en cours
    socket.emit("état", état);
  });

  // --------------------------------------------------------
  // L'animateur choisit la partie et vérifie la reprise
  // --------------------------------------------------------
  socket.on("choisirPartie", (noPartie) => {
    const état = obtenirÉtat(noPartie);
    état.noPartie = noPartie;
    état.joueursConnectés = [];
    état.scores = {};
    état.noSérieActuelle = 1;
    état.noQuestionActuelle = 1;
    état.réplique = null;
    état.buzzVerrou = false;

    // Vérifier si un fichier de répondants existe (reprise)
    const cheminPartie = path.join(
      dossierSaison,
      "parties",
      `répondants-${noPartie}.json`,
    );

    let reprise = null;

    if (fs.existsSync(cheminPartie)) {
      try {
        const contenu = fs.readFileSync(cheminPartie, "utf-8").trim();
        const répondants = contenu ? JSON.parse(contenu) : [];

        if (répondants.length > 0) {
          // Remettre les scores à zéro avant de recalculer
          état.scores = {};

          // Recalculer les scores à partir des répondants existants
          répondants.forEach((r) => {
            if (!état.scores[r.noÉquipe]) état.scores[r.noÉquipe] = 0;
            const clefJoueurR = `${r.noÉquipe}_${r.noJoueur}`;
            if (!état.scoresJoueurs[clefJoueurR]) état.scoresJoueurs[clefJoueurR] = 0;
            const série = séries.find((s) => s.noSérie === r.noSérie);
            const question = série
              ? série.questions.find((q) => q.noQuestion === r.noQuestion)
              : null;
            const points = r.pointsSecondaires
              ? question
                ? question.pointsSecondaires
                : 5
              : question
                ? question.points
                : 10;
            état.scores[r.noÉquipe] += points;
            état.scoresJoueurs[clefJoueurR] += points;
          });

          // Trouver la dernière question répondue et avancer
          const dernier = répondants
            .slice()
            .sort((a, b) =>
              a.noSérie !== b.noSérie
                ? a.noSérie - b.noSérie
                : a.noQuestion - b.noQuestion,
            )
            .pop();

          état.noSérieActuelle = dernier.noSérie;
          état.noQuestionActuelle = dernier.noQuestion;
          avancerQuestion(état);

          reprise = {
            nbRépondants: répondants.length,
            noSérie: état.noSérieActuelle,
            noQuestion: état.noQuestionActuelle,
            scores: état.scores,
          };

        }
      } catch (e) {
        console.error("Erreur lors de la reprise :", e);
      }
    }

    // Envoyer les scores recalculés à la room
    if (reprise) {
      io.to(`partie-${noPartie}`).emit("scoresMisÀJour", { scores: état.scores, scoresJoueurs: état.scoresJoueurs });
      io.to(`partie-${noPartie}`).emit(
        "questionMisÀJour",
        questionCourante(état),
      );
    }

    io.to(`partie-${noPartie}`).emit("état", état);

    // Informer l'animateur si reprise détectée
    if (reprise) {
      socket.emit("repriseDetectée", reprise);
    }

    // Demander aux joueurs déjà connectés de se réenregistrer
    // et réactiver les buzzers pour tous les joueurs.
    // Utile en cas de crash de "marqueur"
    io.to(`partie-${noPartie}`).emit("réenregistrer");
    io.to(`partie-${noPartie}`).emit("reset");

  });

  // --------------------------------------------------------
  // L'animateur démarre la partie
  // --------------------------------------------------------
  socket.on("démarrerPartie", (noPartie) => {
    const état = obtenirÉtat(noPartie);
    état.mode = "jeu";
    état.buzzVerrou = false;

    const partie = parties.find((p) => p.noPartie === noPartie);
    if (partie) {
      // Initialiser les scores à 0 seulement si pas de reprise
      // En cas de reprise, les scores sont déjà recalculés
      // dans choisirPartie — on ne veut pas les écraser
      if (Object.keys(état.scores).length === 0) {
        état.scores[partie.noÉquipeA] = 0;
        état.scores[partie.noÉquipeB] = 0;
      }
    }

    io.to(`partie-${noPartie}`).emit("état", état);
    io.to(`partie-${noPartie}`).emit(
      "questionMisÀJour",
      questionCourante(état),
    );
    io.to(`partie-${noPartie}`).emit("scoresMisÀJour", { scores: état.scores, scoresJoueurs: état.scoresJoueurs });
  });

  // --------------------------------------------------------
  // L'animateur retourne en mode initialisation
  // --------------------------------------------------------
  socket.on("réinitialiser", (noPartie) => {
    const état = obtenirÉtat(noPartie);
    état.mode = "initialisation";
    état.buzzVerrou = false;
    io.to(`partie-${noPartie}`).emit("état", état);
  });

  // --------------------------------------------------------
  // L'animateur veut repartir de zéro pour cette partie
  // --------------------------------------------------------
  socket.on("réinitialiserPartie", (noPartie) => {
    const état = obtenirÉtat(noPartie);
    const cheminPartie = path.join(
      dossierSaison,
      "parties",
      `répondants-${noPartie}.json`,
    );

    état.scores = {};
    état.noSérieActuelle = 1;
    état.noQuestionActuelle = 1;
    état.réplique = null;
    état.buzzVerrou = false;

    // Vider le fichier de répondants
    fs.writeFileSync(cheminPartie, "[]", "utf-8");

    io.to(`partie-${noPartie}`).emit("état", état);
    io.to(`partie-${noPartie}`).emit("scoresMisÀJour", { scores: état.scores, scoresJoueurs: état.scoresJoueurs });
    io.to(`partie-${noPartie}`).emit(
      "questionMisÀJour",
      questionCourante(état),
    );
  });

  // --------------------------------------------------------
  // Buzzer — vérifier le verrou et le droit de réplique
  // --------------------------------------------------------
  socket.on("buzz", (joueur) => {
    const état = obtenirÉtat(joueur.noPartie);
    if (état.buzzVerrou || état.mode !== "jeu") return;
    // Vérifier droit de réplique
    if (état.réplique !== null && joueur.noÉquipe !== état.réplique) return;
    état.buzzVerrou = true;

    // Calculer le temps de réaction si mode débogage activé
    if (AFFICHER_TEMPS_RÉACTION && joueur.tempsClic) {
      joueur.tempsRéaction = Date.now() - joueur.tempsClic;
    }

    io.to(`partie-${joueur.noPartie}`).emit("buzz", joueur);
  });

  // --------------------------------------------------------
  // Bonne réponse — attribuer les points
  // --------------------------------------------------------
  socket.on("attribuerPoints", ({ noPartie, noÉquipe, noJoueur, points, estSecondaire }) => {
    const état = obtenirÉtat(noPartie);

    // Si mode équipe, les points vont à noJoueur = 99
    const info = questionCourante(état);
    const noJoueurFinal = info && info.estÉquipe ? 99 : noJoueur;

    const cheminPartie = path.join(
      dossierSaison,
      "parties",
      `répondants-${noPartie}.json`,
    );

    let répondants = [];
    try {
      const contenu = fs.readFileSync(cheminPartie, "utf-8").trim();
      répondants = contenu ? JSON.parse(contenu) : [];
    } catch (e) {
      répondants = [];
    }

    // Vérifier doublon
    const indexDoublon = répondants.findIndex(
      (r) =>
        r.noSérie === état.noSérieActuelle &&
        r.noQuestion === état.noQuestionActuelle,
    );

    if (indexDoublon >= 0) {
      socket.emit("confirmerÉcrasement", {
        noPartie,
        noÉquipe,
        noJoueur: noJoueurFinal, // ← utiliser noJoueurFinal
        points,
        ancienRépondant: répondants[indexDoublon],
      });
      return;
    }

    enregistrerRépondant(état, répondants, cheminPartie, {
      noÉquipe,
      noJoueur: noJoueurFinal,
      points,
      estSecondaire: estSecondaire || false,
    });
  });

  // --------------------------------------------------------
  // L'animateur confirme l'écrasement d'une réponse existante
  // On retire les points de l'ancienne équipe avant d'attribuer
  // les nouveaux points à la nouvelle équipe
  // --------------------------------------------------------
  socket.on(
    "confirmerÉcrasement",
    ({ noPartie, noÉquipe, noJoueur, points, estSecondaire }) => {
      const état = obtenirÉtat(noPartie);
      const cheminPartie = path.join(
        dossierSaison,
        "parties",
        `répondants-${noPartie}.json`,
      );

      let répondants = [];
      try {
        const contenu = fs.readFileSync(cheminPartie, "utf-8").trim();
        répondants = contenu ? JSON.parse(contenu) : [];
      } catch (e) {
        répondants = [];
      }

      // Trouver l'ancien répondant pour retirer ses points
      const ancienRépondant = répondants.find(
        (r) =>
          r.noSérie === état.noSérieActuelle &&
          r.noQuestion === état.noQuestionActuelle,
      );

      if (ancienRépondant) {
        const série = séries.find((s) => s.noSérie === ancienRépondant.noSérie);
        const question = série
          ? série.questions.find(
              (q) => q.noQuestion === ancienRépondant.noQuestion,
            )
          : null;
        const ancienPoints = ancienRépondant.pointsSecondaires
          ? question
            ? question.pointsSecondaires
            : 5
          : question
            ? question.points
            : 10;

        // Soustraire les anciens points
        if (état.scores[ancienRépondant.noÉquipe]) {
          état.scores[ancienRépondant.noÉquipe] -= ancienPoints;
        }
        const clefAncien = `${ancienRépondant.noÉquipe}_${ancienRépondant.noJoueur}`;
        if (état.scoresJoueurs[clefAncien]) {
          état.scoresJoueurs[clefAncien] -= ancienPoints;
        }
      }

      // Retirer l'ancien répondant
      répondants = répondants.filter(
        (r) =>
          !(
            r.noSérie === état.noSérieActuelle &&
            r.noQuestion === état.noQuestionActuelle
          ),
      );

      enregistrerRépondant(état, répondants, cheminPartie, {
        noÉquipe,
        noJoueur,
        points,
        estSecondaire: estSecondaire || false,
      });
    },
  );

  // --------------------------------------------------------
  // Mauvaise réponse — droit de réplique ou question suivante
  // --------------------------------------------------------
  socket.on("mauvaiseRéponse", ({ noPartie, noÉquipe }) => {
    const état = obtenirÉtat(noPartie);
    const { série } = questionCourante(état);

    if (série.réplique) {
      // Droit de réplique à l'équipe adverse
      const partie = parties.find((p) => p.noPartie === noPartie);
      état.réplique =
        noÉquipe === partie.noÉquipeA ? partie.noÉquipeB : partie.noÉquipeA;
      état.buzzVerrou = false;
      io.to(`partie-${noPartie}`).emit("réplique", état.réplique);
    } else {
      // Pas de réplique — question suivante
      avancerQuestion(état);
      état.buzzVerrou = false;
      io.to(`partie-${noPartie}`).emit(
        "questionMisÀJour",
        questionCourante(état),
      );
      io.to(`partie-${noPartie}`).emit("reset");
    }
  });

  // --------------------------------------------------------
  // Passer manuellement à la question suivante
  // --------------------------------------------------------
  socket.on("questionSuivante", (noPartie) => {
    const état = obtenirÉtat(noPartie);
    avancerQuestion(état);
    état.buzzVerrou = false;
    io.to(`partie-${noPartie}`).emit(
      "questionMisÀJour",
      questionCourante(état),
    );
    io.to(`partie-${noPartie}`).emit("reset");
  });

  // --------------------------------------------------------
  // Revenir à la question précédente en cas d'erreur
  // --------------------------------------------------------
  socket.on("questionPrécédente", (noPartie) => {
    const état = obtenirÉtat(noPartie);
    reculerQuestion(état);
    état.buzzVerrou = false;
    io.to(`partie-${noPartie}`).emit(
      "questionMisÀJour",
      questionCourante(état),
    );
    io.to(`partie-${noPartie}`).emit("reset");
  });

  socket.on("sériePrécédente", (noPartie) => {
    const état = obtenirÉtat(noPartie);
    // Reculer à la série précédente, question 1
    if (état.noSérieActuelle > 1) {
      état.noSérieActuelle--;
      état.noQuestionActuelle = 1;
      état.buzzVerrou = false;
      const info = questionCourante(état);
      io.to(`partie-${noPartie}`).emit("questionMisÀJour", info);
      io.to(`partie-${noPartie}`).emit("reset");
    }
  });

  socket.on("sérieSuivante", (noPartie) => {
    const état = obtenirÉtat(noPartie);
    // Avancer à la série suivante, question 1
    if (état.noSérieActuelle < séries.length) {
      état.noSérieActuelle++;
      état.noQuestionActuelle = 1;
      état.buzzVerrou = false;
      const info = questionCourante(état);
      io.to(`partie-${noPartie}`).emit("questionMisÀJour", info);
      io.to(`partie-${noPartie}`).emit("reset");
    }
  });

  socket.on("annulerRéponse", (noPartie) => {
    const état = obtenirÉtat(noPartie);
    const cheminPartie = path.join(
      dossierSaison,
      "parties",
      `répondants-${noPartie}.json`,
    );

    try {
      const contenu = fs.readFileSync(cheminPartie, "utf-8").trim();
      let répondants = contenu ? JSON.parse(contenu) : [];

      // Trouver le répondant à supprimer
      const idx = répondants.findIndex(
        (r) =>
          r.noSérie === état.noSérieActuelle &&
          r.noQuestion === état.noQuestionActuelle,
      );

      if (idx !== -1) {
        const répondant = répondants[idx];

        // Retirer les points de l'équipe
        const série = séries.find((s) => s.noSérie === répondant.noSérie);
        const question = série
          ? série.questions.find((q) => q.noQuestion === répondant.noQuestion)
          : null;
        const points = répondant.pointsSecondaires
          ? question
            ? question.pointsSecondaires
            : 5
          : question
            ? question.points
            : 10;

        if (état.scores[répondant.noÉquipe]) {
          état.scores[répondant.noÉquipe] -= points;
        }
        const clefJoueurAnn = `${répondant.noÉquipe}_${répondant.noJoueur}`;
        if (état.scoresJoueurs[clefJoueurAnn]) {
          état.scoresJoueurs[clefJoueurAnn] -= points;
        }

        // Supprimer le répondant
        répondants.splice(idx, 1);
        fs.writeFileSync(cheminPartie, JSON.stringify(répondants, null, 2));

      }
    } catch (e) {
      console.error("Erreur annulation:", e);
    }

    // Mettre à jour les scores et la question
    io.to(`partie-${noPartie}`).emit("scoresMisÀJour", { scores: état.scores, scoresJoueurs: état.scoresJoueurs });
    const info = questionCourante(état);
    io.to(`partie-${noPartie}`).emit("questionMisÀJour", info);
  });

  // --------------------------------------------------------
  // Reset buzzer seulement
  // --------------------------------------------------------
  socket.on("reset", (noPartie) => {
    const état = obtenirÉtat(noPartie);
    état.buzzVerrou = false;
    état.réplique = null;
    io.to(`partie-${noPartie}`).emit("reset");
  });

  // --------------------------------------------------------
  // Terminer la partie — fusionner dans le fichier cumulatif
  // --------------------------------------------------------
  socket.on("terminerPartie", (noPartie) => {
    const cheminPartie = path.join(
      dossierSaison,
      "parties",
      `répondants-${noPartie}.json`,
    );
    const cheminCumulatif = path.join(dossierSaison, "répondants.json");
    const cheminAlignements = path.join(dossierSaison, "alignements.json");

    try {
      const contenuPartie = fs.readFileSync(cheminPartie, "utf-8").trim();
      const répondantsPartie = contenuPartie ? JSON.parse(contenuPartie) : [];

      let répondantsCumulatifs = [];
      try {
        const contenuCumulatif = fs
          .readFileSync(cheminCumulatif, "utf-8")
          .trim();
        répondantsCumulatifs = contenuCumulatif
          ? JSON.parse(contenuCumulatif)
          : [];
      } catch (e) {
        répondantsCumulatifs = [];
      }

      // Fusionner en évitant les doublons
      const fusion = [
        ...répondantsCumulatifs.filter((r) => r.noPartie !== noPartie),
        ...répondantsPartie,
      ];

      const fusionTriée = fusion.sort((a, b) => {
        if (a.noPartie !== b.noPartie) return a.noPartie - b.noPartie;
        if (a.noSérie !== b.noSérie) return a.noSérie - b.noSérie;
        return a.noQuestion - b.noQuestion;
      });

      const contenuFusion = '[\n' + fusionTriée.map(r => '  ' + JSON.stringify(r)).join(',\n') + '\n]';
      fs.writeFileSync(cheminCumulatif, contenuFusion, "utf-8");

      // ============================================================
      // Sauvegarder les alignements
      // ============================================================
      const état = obtenirÉtat(noPartie);
      let alignements = [];
      try {
        const contenuAlign = fs.readFileSync(cheminAlignements, "utf-8").trim();
        alignements = contenuAlign ? JSON.parse(contenuAlign) : [];
      } catch (e) {
        alignements = [];
      }

      alignements = alignements.filter((a) => a.noPartie !== noPartie);

      const joueursParÉquipe = {};
      état.joueursConnectés.forEach((j) => {
        if (!joueursParÉquipe[j.noÉquipe])
          joueursParÉquipe[j.noÉquipe] = new Set();
        joueursParÉquipe[j.noÉquipe].add(j.noJoueur);
      });

      répondantsPartie.forEach((r) => {
        if (r.noJoueur === 99) return;
        if (!joueursParÉquipe[r.noÉquipe])
          joueursParÉquipe[r.noÉquipe] = new Set();
        joueursParÉquipe[r.noÉquipe].add(r.noJoueur);
      });

      Object.entries(joueursParÉquipe).forEach(([noÉquipe, joueursSet]) => {
        alignements.push({
          noPartie,
          noÉquipe: parseInt(noÉquipe),
          joueurs: [...joueursSet].sort((a, b) => a - b),
        });
      });

      alignements.sort((a, b) => a.noPartie !== b.noPartie ? a.noPartie - b.noPartie : a.noÉquipe - b.noÉquipe);
      const contenuAlign = '[\n' + alignements.map(a => '  ' + JSON.stringify(a)).join(',\n') + '\n]';
      fs.writeFileSync(cheminAlignements, contenuAlign, 'utf-8');

      // ============================================================
      // Construire le résumé avec noms d'équipes et joueurs
      // ============================================================
      const équipes = JSON.parse(
        fs.readFileSync(path.join(dossierSaison, "équipes.json"), "utf-8"),
      );
      const tousJoueurs = JSON.parse(
        fs.readFileSync(path.join(dossierSaison, "joueurs.json"), "utf-8"),
      );

      const résumé = Object.entries(joueursParÉquipe).map(
        ([noÉquipe, joueursSet]) => {
          const noÉq = parseInt(noÉquipe);
          const équipe = équipes.find((e) => e.noÉquipe === noÉq);
          const joueursÉquipe = [...joueursSet]
            .filter((nj) => nj !== 99)
            .map((nj) => {
              const j = tousJoueurs.find(
                (j) => j.noÉquipe === noÉq && j.noJoueur === nj,
              );
              // Calculer les points de ce joueur dans cette partie
              const ptsJoueur = répondantsPartie
                .filter((r) => r.noÉquipe === noÉq && r.noJoueur === nj)
                .reduce((sum, r) => {
                  const série = séries.find((s) => s.noSérie === r.noSérie);
                  const question = série
                    ? série.questions.find((q) => q.noQuestion === r.noQuestion)
                    : null;
                  const pts = r.pointsSecondaires
                    ? (question?.pointsSecondaires ?? 0)
                    : (question?.points ?? 0);
                  return sum + pts;
                }, 0);
              return {
                alias: j ? j.alias : `Joueur ${nj}`,
                points: ptsJoueur,
              };
            })
            .sort((a, b) => b.points - a.points);

          // Ajouter les points collectifs si > 0
          const ptsCollectif = répondantsPartie
            .filter((r) => r.noÉquipe === noÉq && r.noJoueur === 99)
            .reduce((sum, r) => {
              const série = séries.find((s) => s.noSérie === r.noSérie);
              const question = série
                ? série.questions.find((q) => q.noQuestion === r.noQuestion)
                : null;
              const pts = r.pointsSecondaires
                ? (question?.pointsSecondaires ?? 0)
                : (question?.points ?? 0);
              return sum + pts;
            }, 0);

          if (ptsCollectif > 0) {
            joueursÉquipe.push({
              alias: équipe ? équipe.nomÉquipe : `Équipe ${noÉq}`,
              points: ptsCollectif,
              estCollectif: true,
            });
          }

          return {
            noÉquipe: noÉq,
            nomÉquipe: équipe ? équipe.nomÉquipe : `Équipe ${noÉq}`,
            score: état.scores[noÉq] || 0,
            joueurs: joueursÉquipe,
          };
        },
      );

      état.mode = "terminée";
      état.buzzVerrou = false;
      io.to(`partie-${noPartie}`).emit("état", état);
      io.to(`partie-${noPartie}`).emit("partieTerminée", {
        noPartie,
        scores: état.scores,
        résumé,
      });

    } catch (e) {
      console.error("Erreur lors de la fusion :", e);
    }
  });

  socket.on("disconnect", () => {
    // Retirer le joueur déconnecté — repassera en gris chez le marqueur
    if (socket.noPartie && socket.joueur) {
      const état = obtenirÉtat(socket.noPartie);
      état.joueursConnectés = état.joueursConnectés.filter(
        (j) =>
          !(
            j.noÉquipe === socket.joueur.noÉquipe &&
            j.noJoueur === socket.joueur.noJoueur
          ),
      );
      io.to(`partie-${socket.noPartie}`).emit(
        "joueursConnectés",
        état.joueursConnectés,
      );
    }
  });

  socket.on("toggleÉquipe", (noPartie) => {
    const état = obtenirÉtat(noPartie);
    // Inverser l'override
    const info = questionCourante(état);
    état.overrideÉquipe = !info.estÉquipe;
    const nouvelleInfo = questionCourante(état);
    io.to(`partie-${noPartie}`).emit("questionMisÀJour", nouvelleInfo);
  });
});

// ============================================================
// Démarrage du serveur
// ============================================================

// Serveur local
/* http.listen(3000, () => {
    console.log('Serveur démarré sur http://localhost:3000');
}); */

// Utiliser le port de Railway en production, 3000 en local
const PORT = process.env.PORT || 3000;
http.listen(PORT, () => {
  console.log(`Serveur démarré sur le port ${PORT}`);
});
