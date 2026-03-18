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

// Configuration multer — stockage en mémoire (pas sur disque)
const upload = multer({ storage: multer.memoryStorage() });

app.use(express.static("public"));
app.use(express.json());

// ============================================================
// Chargement des données de la saison
// ============================================================
const saison = "2025-2026";
//const dossierSaison = path.join(__dirname, 'data', 'saisons', saison);

// Volume Railway monté sur /data
const dossierBase =
  process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(__dirname, "data");
const dossierSaison = path.join(dossierBase, "saisons", saison);

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

  // Toujours écraser — fichiers gérés via git uniquement
  // À déplacer dans fichiersAdmin quand un import admin sera ajouté
  const fichiersGit = ["équipes.json", "séries.json"];
  fichiersGit.forEach((fichier) => {
    const destination = path.join(dossierSaison, fichier);
    const source = path.join(__dirname, "data", "saisons", saison, fichier);
    fs.copyFileSync(source, destination);
    console.log(`📄 ${fichier} mis à jour sur le Volume`);
  });

  // Copier seulement si absent — fichiers pouvant être modifiés via admin
  const fichiersAdmin = ["joueurs.json", "parties.json", "thèmes.json"];
  fichiersAdmin.forEach((fichier) => {
    const destination = path.join(dossierSaison, fichier);
    const source = path.join(__dirname, "data", "saisons", saison, fichier);
    if (!fs.existsSync(destination)) {
      fs.copyFileSync(source, destination);
      console.log(`📄 ${fichier} copié sur le Volume`);
    }
  });

  // Créer répondants.json vide si inexistant
  const cheminRépondants = path.join(dossierSaison, "répondants.json");
  if (!fs.existsSync(cheminRépondants)) {
    fs.writeFileSync(cheminRépondants, "[]", "utf-8");
    console.log("📄 répondants.json initialisé sur le Volume");
  }
}

// Appeler l'initialisation au démarrage
initialiserVolume();

const équipes = JSON.parse(
  fs.readFileSync(path.join(dossierSaison, "équipes.json"), "utf-8"),
);
const joueurs = JSON.parse(
  fs.readFileSync(path.join(dossierSaison, "joueurs.json"), "utf-8"),
);
const parties = JSON.parse(
  fs.readFileSync(path.join(dossierSaison, "parties.json"), "utf-8"),
);
const séries = JSON.parse(
  fs.readFileSync(path.join(dossierSaison, "séries.json"), "utf-8"),
);
const thèmes = JSON.parse(
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
        const noQuestion = parseInt(ligne[2]);
        const texte = ligne[3] ? String(ligne[3]) : "";
        const réponse = ligne[4] ? String(ligne[4]) : "";
        if (!isNaN(noQ) && !isNaN(noS) && !isNaN(noQuestion) && texte) {
          questionsExtraites.push({ noSérie: noS, noQuestion, texte, réponse });
        }
      }
    });

    // --------------------------------------------------------
    // Mettre à jour thèmes.json
    // --------------------------------------------------------
    const cheminThèmes = path.join(dossierSaison, "thèmes.json");
    let thèmes = [];
    try {
      thèmes = JSON.parse(fs.readFileSync(cheminThèmes, "utf-8"));
    } catch (e) {
      thèmes = [];
    }

    // Retirer l'ancien questionnaire si existe
    thèmes = thèmes.filter((t) => t.noQuestionnaire !== noQuestionnaire);
    thèmes.push({ noQuestionnaire, séries: thèmesExtraits });
    thèmes.sort((a, b) => a.noQuestionnaire - b.noQuestionnaire);
    fs.writeFileSync(cheminThèmes, JSON.stringify(thèmes, null, 2));

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
    questionsExtraites.forEach((q) => {
      if (!sériesMap[q.noSérie]) sériesMap[q.noSérie] = [];
      sériesMap[q.noSérie].push({
        noQuestion: q.noQuestion,
        texte: q.texte,
        réponse: q.réponse,
      });
    });

    const sériesQuestions = Object.keys(sériesMap)
      .map((noSérie) => ({
        noSérie: parseInt(noSérie),
        questions: sériesMap[noSérie].sort(
          (a, b) => a.noQuestion - b.noQuestion,
        ),
      }))
      .sort((a, b) => a.noSérie - b.noSérie);

    // Retirer l'ancien questionnaire si existe
    questions = questions.filter((q) => q.noQuestionnaire !== noQuestionnaire);
    questions.push({ noQuestionnaire, séries: sériesQuestions });
    questions.sort((a, b) => a.noQuestionnaire - b.noQuestionnaire);
    fs.writeFileSync(cheminQuestions, JSON.stringify(questions, null, 2));

    console.log(
      `📥 Questionnaire ${noQuestionnaire} importé — ${thèmesExtraits.length} séries, ${questionsExtraites.length} questions`,
    );
    res.json({
      succès: true,
      noQuestionnaire,
      nbSéries: thèmesExtraits.length,
      nbQuestions: questionsExtraites.length,
    });
  } catch (e) {
    console.error("Erreur upload questionnaire:", e);
    res.status(500).json({ erreur: e.message });
  }
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
  console.log(`✅ Nouveau joueur sauvegardé : ${alias}`);
  res.json(nouveauJoueur);
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

// Calendrier — parties avec scores calculés
app.get("/api/stats/calendrier", (req, res) => {
  try {
    const parties = JSON.parse(
      fs.readFileSync(path.join(dossierSaison, "parties.json"), "utf-8"),
    );
    const équipes = JSON.parse(
      fs.readFileSync(path.join(dossierSaison, "équipes.json"), "utf-8"),
    );

    // Lire les répondants cumulatifs
    let répondants = [];
    try {
      const contenu = fs
        .readFileSync(path.join(dossierSaison, "répondants.json"), "utf-8")
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
        scores[r.noÉquipe] += points;
      });

      const équipeA = équipes.find((e) => e.noÉquipe === partie.noÉquipeA);
      const équipeB = équipes.find((e) => e.noÉquipe === partie.noÉquipeB);
      const scoreA = scores[partie.noÉquipeA] || null;
      const scoreB = scores[partie.noÉquipeB] || null;
      const terminée = rép.length > 0;

      return {
        noPartie: partie.noPartie,
        date: partie.date,
        nomÉquipeA: équipeA ? équipeA.nomÉquipe : "",
        nomÉquipeB: équipeB ? équipeB.nomÉquipe : "",
        scoreA,
        scoreB,
        terminée,
        lienTeams: partie.lienTeams || null,
        noQuestionnaire: partie.noQuestionnaire,
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
// Classement — G/GP/PN/PP/P
// ============================================================
app.get("/api/stats/classement", (req, res) => {
  try {
    const parties = JSON.parse(
      fs.readFileSync(path.join(dossierSaison, "parties.json"), "utf-8"),
    );
    const équipes = JSON.parse(
      fs.readFileSync(path.join(dossierSaison, "équipes.json"), "utf-8"),
    );

    let répondants = [];
    try {
      const contenu = fs
        .readFileSync(path.join(dossierSaison, "répondants.json"), "utf-8")
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

    // Calculer le % et trier
    const résultat = Object.values(classement)
      .filter((c) => c.MJ > 0)
      .map((c) => ({
        ...c,
        pct:
          c.ptsPossibles > 0 ? Math.round((c.pts / c.ptsPossibles) * 100) : 0,
      }))
      .sort((a, b) => b.pts - a.pts || b.pct - a.pct);

    res.json(résultat);
  } catch (e) {
    console.error("Erreur stats classement:", e);
    res.status(500).json({ erreur: e.message });
  }
});

// ============================================================
// Compteurs — points par équipe et par joueur
// ============================================================
app.get("/api/stats/compteurs", (req, res) => {
  try {
    const équipes = JSON.parse(
      fs.readFileSync(path.join(dossierSaison, "équipes.json"), "utf-8"),
    );
    const joueurs = JSON.parse(
      fs.readFileSync(path.join(dossierSaison, "joueurs.json"), "utf-8"),
    );

    let répondants = [];
    try {
      const contenu = fs
        .readFileSync(path.join(dossierSaison, "répondants.json"), "utf-8")
        .trim();
      répondants = contenu ? JSON.parse(contenu) : [];
    } catch (e) {
      répondants = [];
    }

    const ptsJoueur = {};
    répondants.forEach((r) => {
      const clé = `${r.noÉquipe}-${r.noJoueur}`;
      if (!ptsJoueur[clé]) ptsJoueur[clé] = 0;
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
      ptsJoueur[clé] += points;
    });

    const partiesJoueur = {};
    répondants.forEach((r) => {
      const clé = `${r.noÉquipe}-${r.noJoueur}`;
      if (!partiesJoueur[clé]) partiesJoueur[clé] = new Set();
      partiesJoueur[clé].add(r.noPartie);
    });

    const résultat = équipes
      .map((é) => {
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
    const noÉquipe = parseInt(req.params.noEquipe);
    const noJoueur = parseInt(req.params.noJoueur);
    console.log(`Stats joueur — équipe: ${noÉquipe}, joueur: ${noJoueur}`);

    const parties = JSON.parse(
      fs.readFileSync(path.join(dossierSaison, "parties.json"), "utf-8"),
    );
    const équipes = JSON.parse(
      fs.readFileSync(path.join(dossierSaison, "équipes.json"), "utf-8"),
    );

    let répondants = [];
    try {
      const contenu = fs
        .readFileSync(path.join(dossierSaison, "répondants.json"), "utf-8")
        .trim();
      répondants = contenu ? JSON.parse(contenu) : [];
    } catch (e) {
      répondants = [];
    }

    // Répondants de ce joueur seulement
    const répJoueur = répondants.filter(
      (r) => r.noÉquipe === noÉquipe && r.noJoueur === noJoueur,
    );
    console.log(`Répondants filtrés: ${répJoueur.length}`);

    // Grouper par partie avec calcul des points
    const partiesMap = {};
    répJoueur.forEach((r) => {
      if (!partiesMap[r.noPartie]) partiesMap[r.noPartie] = 0;
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
      partiesMap[r.noPartie] += points;
    });

    // Calculer les scores totaux par partie
    const scoresParPartie = {};
    répondants.forEach((r) => {
      if (!scoresParPartie[r.noPartie]) scoresParPartie[r.noPartie] = {};
      if (!scoresParPartie[r.noPartie][r.noÉquipe])
        scoresParPartie[r.noPartie][r.noÉquipe] = 0;
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

app.get('/api/stats/partie/:noPartie', (req, res) => {
    try {
        const noPartie = parseInt(req.params.noPartie);
        const cheminPartie = path.join(
            dossierSaison, 'parties', `répondants-${noPartie}.json`);
        
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
            const série = séries.find(s => s.noSérie === r.noSérie);
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
// États des parties en cours — un état par noPartie
// Chaque partie a sa propre room Socket.io : "partie-25", etc.
// ============================================================
const étatsParties = {};

function créerÉtat(noPartie) {
  return {
    mode: "initialisation",
    noPartie,
    joueursConnectés: [],
    noSérieActuelle: 1,
    noQuestionActuelle: 1,
    scores: {},
    réplique: null,
    buzzVerrou: false,
  };
}

function obtenirÉtat(noPartie) {
  if (!étatsParties[noPartie]) {
    // Vérifier si cette partie est terminée (dans alignements.json)
    let estTerminée = false;
    try {
      const cheminAlign = path.join(dossierSaison, "alignements.json");
      const alignements = JSON.parse(fs.readFileSync(cheminAlign, "utf-8"));
      estTerminée = alignements.some((a) => a.noPartie === noPartie);
      console.log(
        `obtenirÉtat(${noPartie}) — estTerminée: ${estTerminée}, alignements trouvés: ${alignements.length}`,
      );
    } catch (e) {
      estTerminée = false;
      console.log(`obtenirÉtat(${noPartie}) — erreur: ${e.message}`);
    }

    étatsParties[noPartie] = {
      noPartie,
      mode: estTerminée ? "terminée" : "initialisation",
      joueursConnectés: [],
      scores: {},
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
  io.to(room).emit("scoresMisÀJour", état.scores);
  io.to(room).emit("questionMisÀJour", questionCourante(état));
  io.to(room).emit("reset");
  console.log(
    `✅ ${points} pts → équipe ${noÉquipe} (partie ${état.noPartie})`,
  );
}

// ============================================================
// Gestion des connexions Socket.io
// Chaque socket rejoint une room selon la partie choisie
// ============================================================
io.on("connection", (socket) => {
  console.log("Connexion reçue");

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
    console.log(`Socket a rejoint la room partie-${noPartie}`);

    // Vérifier si cette partie a déjà des répondants
    const cheminPartie = path.join(
      dossierSaison,
      "parties",
      `répondants-${noPartie}.json`,
    );
    let aDesRépondants = false;
    try {
      const contenu = fs.readFileSync(cheminPartie, "utf-8").trim();
      const répondants = contenu ? JSON.parse(contenu) : [];
      aDesRépondants = répondants.length > 0;
    } catch (e) {
      aDesRépondants = false;
    }

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
    console.log(`✅ ${joueur.alias} enregistré (partie ${joueur.noPartie})`);
    io.to(`partie-${joueur.noPartie}`).emit(
      "joueursConnectés",
      état.joueursConnectés,
    );

    // Ajout pour trouver si un joueur se déconnecte et l'identifier
    état.joueursConnectés.push(joueur);
    socket.joueur = joueur; // ← stocker l'identité du joueur dans le socket

    // Envoyer l'état actuel au joueur qui vient de s'enregistrer
    // Permet de détecter si la partie est déjà en cours
    console.log("État envoyé au joueur:", état.mode);
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

          console.log("Nombre de répondants à traiter:", répondants.length);

          // Recalculer les scores à partir des répondants existants
          répondants.forEach((r) => {
            console.log(
              `Traitement: équipe ${r.noÉquipe}, série ${r.noSérie}, Q${r.noQuestion}`,
            );
            if (!état.scores[r.noÉquipe]) état.scores[r.noÉquipe] = 0;
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
            console.log(
              `Répondant: équipe ${r.noÉquipe}, série ${r.noSérie}, Q${r.noQuestion}, points calculés: ${points}`,
            );
            état.scores[r.noÉquipe] += points;
          });

          console.log("Scores après recalcul:", état.scores);

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

          console.log(`🔄 Reprise détectée — ${répondants.length} répondants`);
          console.log(
            `   Reprise à Série ${état.noSérieActuelle} Q${état.noQuestionActuelle}`,
          );
        }
      } catch (e) {
        console.error("Erreur lors de la reprise :", e);
      }
    }

    // Envoyer les scores recalculés à la room
    if (reprise) {
      io.to(`partie-${noPartie}`).emit("scoresMisÀJour", état.scores);
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

    console.log(`📋 Partie ${noPartie} sélectionnée`);
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
    io.to(`partie-${noPartie}`).emit("scoresMisÀJour", état.scores);
    console.log(`🎯 Partie ${noPartie} démarrée !`);
  });

  // --------------------------------------------------------
  // L'animateur retourne en mode initialisation
  // --------------------------------------------------------
  socket.on("réinitialiser", (noPartie) => {
    const état = obtenirÉtat(noPartie);
    état.mode = "initialisation";
    état.buzzVerrou = false;
    io.to(`partie-${noPartie}`).emit("état", état);
    console.log(`🔄 Partie ${noPartie} — retour en initialisation`);
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
    io.to(`partie-${noPartie}`).emit("scoresMisÀJour", état.scores);
    io.to(`partie-${noPartie}`).emit(
      "questionMisÀJour",
      questionCourante(état),
    );
    console.log(`🗑️ Partie ${noPartie} réinitialisée`);
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
      console.log(`🔔 ${joueur.alias} a buzzé en ${joueur.tempsRéaction}ms`);
    }

    console.log(`🔔 ${joueur.alias} a buzzé ! (partie ${joueur.noPartie})`);
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
        console.log(
          `↩️ Retrait de ${ancienPoints} pts à l'équipe ${ancienRépondant.noÉquipe}`,
        );
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
      console.log(
        `↩️ Droit de réplique → équipe ${état.réplique} (partie ${noPartie})`,
      );
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
    console.log(`⏭️ Question suivante (partie ${noPartie})`);
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
    console.log(`⏮️ Question précédente (partie ${noPartie})`);
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

        // Supprimer le répondant
        répondants.splice(idx, 1);
        fs.writeFileSync(cheminPartie, JSON.stringify(répondants, null, 2));

        console.log(
          `🗑️ Réponse annulée — Série ${état.noSérieActuelle} Q${état.noQuestionActuelle}`,
        );
      }
    } catch (e) {
      console.error("Erreur annulation:", e);
    }

    // Mettre à jour les scores et la question
    io.to(`partie-${noPartie}`).emit("scoresMisÀJour", état.scores);
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

      fs.writeFileSync(
        cheminCumulatif,
        JSON.stringify(fusionTriée, null, 2),
        "utf-8",
      );

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

      alignements.sort((a, b) => a.noPartie - b.noPartie);
      fs.writeFileSync(cheminAlignements, JSON.stringify(alignements, null, 2));
      console.log(`📋 Alignements sauvegardés pour partie ${noPartie}`);

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

      console.log(
        `✅ Partie ${noPartie} fusionnée — ${répondantsPartie.length} répondants`,
      );
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
      console.log(`👋 ${socket.joueur.alias} déconnecté`);
    } else {
      console.log("Déconnexion");
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
