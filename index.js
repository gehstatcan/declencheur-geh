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

  // Copier les fichiers JSON statiques s'ils n'existent pas encore
  const fichiers = [
    "équipes.json",
    "joueurs.json",
    "parties.json",
    "séries.json",
    "questionnaires.json",
  ];

  fichiers.forEach((fichier) => {
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
const questionnaires = JSON.parse(
  fs.readFileSync(path.join(dossierSaison, "questionnaires.json"), "utf-8"),
);

console.log(`✅ ${équipes.length} équipes chargées`);
console.log(`✅ ${joueurs.length} joueurs chargés`);
console.log(`✅ ${parties.length} parties chargées`);
console.log(`✅ ${séries.length} séries chargées`);
console.log(`✅ ${questionnaires.length} questionnaires chargés`);

// ============================================================
// Routes API — données statiques de la saison
// ============================================================
app.get("/api/equipes", (req, res) => res.json(équipes));
app.get("/api/joueurs", (req, res) => res.json(joueurs));
app.get("/api/parties", (req, res) => res.json(parties));
app.get("/api/series", (req, res) => res.json(séries));
app.get("/api/questionnaires", (req, res) => res.json(questionnaires));
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
    console.log(`⚠️ Création nouvel état pour partie ${noPartie}`);
    étatsParties[noPartie] = créerÉtat(noPartie);
  }
  console.log(`État partie ${noPartie}: ${étatsParties[noPartie].mode}`);
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
// ============================================================
function questionCourante(état) {
  const série = séries.find((s) => s.noSérie === état.noSérieActuelle);
  if (!série) return null;
  const question = série.questions.find(
    (q) => q.noQuestion === état.noQuestionActuelle,
  );

  // Vérifier si cette question a déjà été répondue
  let répondantExistant = null;
  const cheminPartie = path.join(
    dossierSaison,
    "parties",
    `répondants-${état.noPartie}.json`,
  );
  try {
    const contenu = fs.readFileSync(cheminPartie, "utf-8").trim();
    const répondants = contenu ? JSON.parse(contenu) : [];
    répondantExistant =
      répondants.find(
        (r) =>
          r.noSérie === état.noSérieActuelle &&
          r.noQuestion === état.noQuestionActuelle,
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
  état,
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
  socket.on("attribuerPoints", ({ noPartie, noÉquipe, noJoueur, points }) => {
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

    // Vérifier doublon
    const indexDoublon = répondants.findIndex(
      (r) =>
        r.noSérie === état.noSérieActuelle &&
        r.noQuestion === état.noQuestionActuelle,
    );

    if (indexDoublon >= 0) {
      // Avertir l'animateur et demander confirmation
      socket.emit("confirmerÉcrasement", {
        noPartie,
        noÉquipe,
        noJoueur,
        points,
        ancienRépondant: répondants[indexDoublon],
      });
      return;
    }

    enregistrerRépondant(état, répondants, cheminPartie, {
      noÉquipe,
      noJoueur,
      points,
    });
  });

  // --------------------------------------------------------
  // L'animateur confirme l'écrasement d'une réponse existante
  // On retire les points de l'ancienne équipe avant d'attribuer
  // les nouveaux points à la nouvelle équipe
  // --------------------------------------------------------
  socket.on(
    "confirmerÉcrasement",
    ({ noPartie, noÉquipe, noJoueur, points }) => {
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

      // Fusionner en évitant les doublons — retirer d'abord les entrées
      // existantes pour cette partie avant d'ajouter les nouvelles
      const fusion = [
        // Garder seulement les répondants des AUTRES parties
        ...répondantsCumulatifs.filter((r) => r.noPartie !== noPartie),
        // Ajouter les répondants de la partie en cours
        ...répondantsPartie,
      ];

      // Trier par noPartie, noSérie, noQuestion pour faciliter la lecture
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

      console.log(
        `✅ Partie ${noPartie} fusionnée — ${répondantsPartie.length} répondants`,
      );

      const état = obtenirÉtat(noPartie);
      état.mode = "terminée";
      état.buzzVerrou = false;
      io.to(`partie-${noPartie}`).emit("état", état);
      io.to(`partie-${noPartie}`).emit("partieTerminée", {
        noPartie,
        scores: état.scores,
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
      console.log(`👋 ${socket.joueur.alias} déconnecté`);
    } else {
      console.log("Déconnexion");
    }
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
