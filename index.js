const express = require("express");
const app = express();
const http = require("http").createServer(app);
const io = require("socket.io")(http);
const fs = require("fs");
const path = require("path");

app.use(express.static("public"));
app.use(express.json());

// Chargement des données
const saison = "2025-2026";
const dossierSaison = path.join(__dirname, "data", "saisons", saison);

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
const questionnaires = JSON.parse(
  fs.readFileSync(path.join(dossierSaison, "questionnaires.json"), "utf-8"),
);

console.log(`✅ ${équipes.length} équipes chargées`);
console.log(`✅ ${joueurs.length} joueurs chargés`);
console.log(`✅ ${parties.length} parties chargées`);
console.log(`✅ ${séries.length} séries chargées`);
console.log(`✅ ${questionnaires.length} questionnaires chargés`);

// Routes API
app.get("/api/equipes", (req, res) => res.json(équipes));
app.get("/api/joueurs", (req, res) => res.json(joueurs));
app.get("/api/parties", (req, res) => res.json(parties));
app.get("/api/series", (req, res) => res.json(séries));
app.get("/api/questionnaires", (req, res) => res.json(questionnaires));

// Sauvegarder un nouveau joueur
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

// État de la partie en cours
let état = {
  mode: "initialisation",
  noPartie: null,
  joueursConnectés: [],
  noSérieActuelle: 1,
  noQuestionActuelle: 1,
  scores: {},
  réplique: null, // noÉquipe qui a le droit de réplique, null = tout le monde
};

let buzzVerrou = false;

// Avancer à la question suivante
function avancerQuestion() {
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
// Reculer à la question précédente — utile en cas d'erreur
// ============================================================
function reculerQuestion() {
  if (état.noQuestionActuelle > 1) {
    // Reculer dans la même série
    état.noQuestionActuelle--;
  } else {
    // Reculer à la série précédente
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
// Retourne la série, la question courante et le répondant
// existant si la question a déjà été répondue
// ============================================================
function questionCourante() {
    const série = séries.find(s => s.noSérie === état.noSérieActuelle);
    if (!série) return null;
    const question = série.questions.find(q => q.noQuestion === état.noQuestionActuelle);

    // Vérifier si cette question a déjà été répondue
    let répondantExistant = null;
    const cheminPartie = path.join(dossierSaison, 'parties',
        `répondants-${état.noPartie}.json`);
    try {
        const contenu = fs.readFileSync(cheminPartie, 'utf-8').trim();
        const répondants = contenu ? JSON.parse(contenu) : [];
        répondantExistant = répondants.find(r =>
            r.noSérie === état.noSérieActuelle &&
            r.noQuestion === état.noQuestionActuelle
        ) || null;
    } catch (e) {
        répondantExistant = null;
    }

    return { série, question, répondantExistant };
}

// ============================================================
// Enregistre un répondant dans le fichier de la partie en cours
// Appelée après une bonne réponse ou une confirmation d'écrasement
// ============================================================
function enregistrerRépondant(
  répondants,
  cheminPartie,
  { noÉquipe, noJoueur, points },
) {
  if (!état.scores[noÉquipe]) état.scores[noÉquipe] = 0;
  état.scores[noÉquipe] += points;

  répondants.push({
    noPartie: état.noPartie,
    noSérie: état.noSérieActuelle,
    noQuestion: état.noQuestionActuelle,
    noJoueur,
    noÉquipe,
    pointsSecondaires: points < 10,
  });

  fs.writeFileSync(cheminPartie, JSON.stringify(répondants, null, 2), "utf-8");

  avancerQuestion();
  buzzVerrou = false;

  io.emit("scoresMisÀJour", état.scores);
  io.emit("questionMisÀJour", questionCourante());
  io.emit("reset");
  console.log(`✅ ${points} pts → équipe ${noÉquipe}`);
}

io.on("connection", (socket) => {
  console.log("Connexion reçue");
  socket.emit("état", état);

  // Un joueur s'enregistre
  socket.on("sEnregistrer", (joueur) => {
    état.joueursConnectés = état.joueursConnectés.filter(
      (j) =>
        !(j.noÉquipe === joueur.noÉquipe && j.noJoueur === joueur.noJoueur),
    );
    état.joueursConnectés.push(joueur);
    console.log(`✅ ${joueur.alias} enregistré`);
    io.emit("joueursConnectés", état.joueursConnectés);
  });

  // ============================================================
  // L'animateur choisit une partie
  // Si un fichier de répondants existe déjà, on reprend
  // là où on était (reprise après plantage)
  // ============================================================
  socket.on("choisirPartie", (noPartie) => {
    état.noPartie = noPartie;
    état.joueursConnectés = [];
    état.scores = {};
    état.noSérieActuelle = 1;
    état.noQuestionActuelle = 1;
    état.réplique = null;

    // Vérifier si un fichier de répondants existe pour cette partie
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
          // Recalculer les scores à partir des répondants
          répondants.forEach((r) => {
            if (!état.scores[r.noÉquipe]) état.scores[r.noÉquipe] = 0;
            // Recalculer les points selon la série
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
          });

          // Trouver la dernière question répondue et avancer à la suivante
          // Trier par noSérie puis noQuestion
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
          avancerQuestion(); // Avancer à la question suivante

          reprise = {
            nbRépondants: répondants.length,
            noSérie: état.noSérieActuelle,
            noQuestion: état.noQuestionActuelle,
            scores: état.scores,
          };

          console.log("Nombre de répondants à traiter:", répondants.length);

          état.scores = {};

          répondants.forEach((r) => {
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

            // Déboguer

            console.log(
              `Traitement: équipe ${r.noÉquipe}, série ${r.noSérie}, Q${r.noQuestion}`,
            );

            console.log(
              `Répondant: équipe ${r.noÉquipe}, série ${r.noSérie}, Q${r.noQuestion}, points calculés: ${points}`,
            );

            état.scores[r.noÉquipe] += points;
          });

          console.log("Scores après recalcul:", état.scores);

          console.log(`🔄 Reprise détectée — ${répondants.length} répondants`);
          console.log(
            `   Reprise à Série ${état.noSérieActuelle} Q${état.noQuestionActuelle}`,
          );
        }
      } catch (e) {
        console.error("Erreur lors de la reprise :", e);
      }
    }

    // Envoyer les scores recalculés à tout le monde
    if (reprise) {
      io.emit("scoresMisÀJour", état.scores);
      io.emit("questionMisÀJour", questionCourante());
    }

    io.emit("état", état);

    // Informer l'animateur si reprise détectée
    if (reprise) {
      socket.emit("repriseDetectée", reprise);
    }

    console.log(`📋 Partie ${noPartie} sélectionnée`);
  });

  // L'animateur démarre la partie
  socket.on("démarrerPartie", () => {
    état.mode = "jeu";
    buzzVerrou = false;

    const partie = parties.find((p) => p.noPartie === état.noPartie);
    if (partie) {
      // Initialiser les scores à 0 seulement si pas de reprise
      // En cas de reprise, les scores sont déjà recalculés
      // dans socket.on('choisirPartie') — on ne veut pas les écraser
      if (Object.keys(état.scores).length === 0) {
        état.scores[partie.noÉquipeA] = 0;
        état.scores[partie.noÉquipeB] = 0;
      }
    }

    io.emit("état", état);
    io.emit("questionMisÀJour", questionCourante());
    io.emit("scoresMisÀJour", état.scores);
    console.log("🎯 Partie démarrée !");
  });

  // L'animateur retourne en initialisation
  socket.on("réinitialiser", () => {
    état.mode = "initialisation";
    buzzVerrou = false;
    io.emit("état", état);
    console.log("🔄 Retour en initialisation");
  });

  // Buzzer — vérifier le droit de réplique
  socket.on("buzz", (joueur) => {
    if (buzzVerrou || état.mode !== "jeu") return;
    // Vérifier droit de réplique
    if (état.réplique !== null && joueur.noÉquipe !== état.réplique) return;
    buzzVerrou = true;
    console.log(`🔔 ${joueur.alias} a buzzé !`);
    io.emit("buzz", joueur);
  });

  // Bonne réponse
  // Bonne réponse
  socket.on("attribuerPoints", ({ noÉquipe, noJoueur, points }) => {
    const cheminPartie = path.join(
      dossierSaison,
      "parties",
      `répondants-${état.noPartie}.json`,
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
      // Avertir l'animateur et demander confirmation
      socket.emit("confirmerÉcrasement", {
        noÉquipe,
        noJoueur,
        points,
        ancienRépondant: répondants[indexDoublon],
      });
      return; // On n'enregistre pas encore
    }

    // Pas de doublon — enregistrer normalement
    enregistrerRépondant(répondants, cheminPartie, {
      noÉquipe,
      noJoueur,
      points,
    });
  });

// ============================================================
// L'animateur confirme l'écrasement d'une réponse existante
// On retire les points de l'ancienne équipe avant d'attribuer
// les nouveaux points à la nouvelle équipe
// ============================================================
socket.on('confirmerÉcrasement', ({ noÉquipe, noJoueur, points }) => {
    const cheminPartie = path.join(dossierSaison, 'parties',
        `répondants-${état.noPartie}.json`);

    let répondants = [];
    try {
        const contenu = fs.readFileSync(cheminPartie, 'utf-8').trim();
        répondants = contenu ? JSON.parse(contenu) : [];
    } catch (e) {
        répondants = [];
    }

    // Trouver l'ancien répondant pour retirer ses points
    const ancienRépondant = répondants.find(r =>
        r.noSérie === état.noSérieActuelle &&
        r.noQuestion === état.noQuestionActuelle
    );

    if (ancienRépondant) {
        // Recalculer les points de l'ancienne réponse
        const série = séries.find(s => s.noSérie === ancienRépondant.noSérie);
        const question = série
            ? série.questions.find(q => q.noQuestion === ancienRépondant.noQuestion)
            : null;
        const ancienPoints = ancienRépondant.pointsSecondaires
            ? (question ? question.pointsSecondaires : 5)
            : (question ? question.points : 10);

        // Soustraire les anciens points
        if (état.scores[ancienRépondant.noÉquipe]) {
            état.scores[ancienRépondant.noÉquipe] -= ancienPoints;
        }

        console.log(`↩️ Retrait de ${ancienPoints} pts à l'équipe ${ancienRépondant.noÉquipe}`);
    }

    // Retirer l'ancien répondant du fichier
    répondants = répondants.filter(r =>
        !(r.noSérie === état.noSérieActuelle &&
          r.noQuestion === état.noQuestionActuelle)
    );

    // Enregistrer le nouveau répondant avec les nouveaux points
    enregistrerRépondant(répondants, cheminPartie, { noÉquipe, noJoueur, points });
});

  // Terminer la partie — fusionner dans le fichier cumulatif
  socket.on("terminerPartie", () => {
    const cheminPartie = path.join(
      dossierSaison,
      "parties",
      `répondants-${état.noPartie}.json`,
    );
    const cheminCumulatif = path.join(dossierSaison, "répondants.json");

    try {
      // Lire les répondants de la partie
      const contenuPartie = fs.readFileSync(cheminPartie, "utf-8").trim();
      const répondantsPartie = contenuPartie ? JSON.parse(contenuPartie) : [];

      // Lire le fichier cumulatif
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

      // Fusionner et sauvegarder
      const fusion = [...répondantsCumulatifs, ...répondantsPartie];
      fs.writeFileSync(
        cheminCumulatif,
        JSON.stringify(fusion, null, 2),
        "utf-8",
      );

      console.log(
        `✅ Partie ${état.noPartie} fusionnée — ${répondantsPartie.length} répondants`,
      );

      état.mode = "initialisation";
      buzzVerrou = false;
      io.emit("état", état);
      io.emit("partieterminée", {
        noPartie: état.noPartie,
        scores: état.scores,
      });
    } catch (e) {
      console.error("Erreur lors de la fusion :", e);
    }
  });

  // Mauvaise réponse
  socket.on("mauvaiseRéponse", ({ noÉquipe }) => {
    const { série } = questionCourante();

    if (série.réplique) {
      // Droit de réplique à l'équipe adverse
      const partie = parties.find((p) => p.noPartie === état.noPartie);
      état.réplique =
        noÉquipe === partie.noÉquipeA ? partie.noÉquipeB : partie.noÉquipeA;
      buzzVerrou = false;
      io.emit("réplique", état.réplique);
      console.log(`↩️ Droit de réplique → équipe ${état.réplique}`);
    } else {
      // Pas de réplique — question suivante
      avancerQuestion();
      buzzVerrou = false;
      io.emit("questionMisÀJour", questionCourante());
      io.emit("reset");
    }
  });

  // Passer manuellement à la question suivante
  socket.on("questionSuivante", () => {
    avancerQuestion();
    buzzVerrou = false;
    io.emit("questionMisÀJour", questionCourante());
    io.emit("reset");
    console.log("⏭️ Question suivante");
  });

  // ============================================================
  // Revenir à la question précédente en cas d'erreur
  // ============================================================
  socket.on("questionPrécédente", () => {
    reculerQuestion();
    buzzVerrou = false;
    io.emit("questionMisÀJour", questionCourante());
    io.emit("reset");
    console.log("⏮️ Question précédente");
  });

  // ============================================================
  // L'animateur veut repartir de zéro pour cette partie
  // Vide le fichier de répondants et réinitialise les scores
  // ============================================================
  socket.on("réinitialiserPartie", () => {
    const cheminPartie = path.join(
      dossierSaison,
      "parties",
      `répondants-${état.noPartie}.json`,
    );

    // Remettre à zéro
    état.scores = {};
    état.noSérieActuelle = 1;
    état.noQuestionActuelle = 1;
    état.réplique = null;

    // Vider le fichier
    fs.writeFileSync(cheminPartie, "[]", "utf-8");

    io.emit("état", état);
    io.emit("scoresMisÀJour", état.scores);
    io.emit("questionMisÀJour", questionCourante());
    console.log(`🗑️ Partie ${état.noPartie} réinitialisée`);
  });

  // Reset buzzer seulement
  socket.on("reset", () => {
    buzzVerrou = false;
    état.réplique = null;
    io.emit("reset");
  });

  socket.on("disconnect", () => {
    console.log("Déconnexion");
  });
});

http.listen(3000, () => {
  console.log("Serveur démarré sur http://localhost:3000");
});
