"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

// Aucune lecture ni écriture dans data/saisons : la pratique est indépendante.
function creerPratique(dossier) {
  const fichier = path.join(dossier, "session.json");
  const nouvelle = () => ({
    id: crypto.randomUUID(), revision: 0, phase: "attente", question: 1,
    joueurs: [], reponses: [], buzz: null, exclus: []
  });
  let etat;
  try {
    etat = JSON.parse(fs.readFileSync(fichier, "utf8"));
    if (!etat.id || !Array.isArray(etat.joueurs) || !Array.isArray(etat.reponses) ||
        !Array.isArray(etat.exclus) || !["attente", "active", "terminee"].includes(etat.phase) ||
        !Number.isInteger(etat.revision) || !Number.isInteger(etat.question)) {
      throw new Error("Format de sauvegarde de pratique invalide.");
    }
  } catch (erreur) {
    if (erreur.code !== "ENOENT") throw erreur;
    etat = nouvelle();
  }
  function enregistrer(suivant) {
    suivant.revision = etat.revision + 1;
    fs.mkdirSync(dossier, { recursive: true });
    const temporaire = fichier + ".tmp";
    fs.writeFileSync(temporaire, JSON.stringify(suivant, null, 2), "utf8");
    fs.renameSync(temporaire, fichier);
    etat = suivant; // Publier seulement après une sauvegarde réussie.
  }
  function modifier(fn) {
    const suivant = structuredClone(etat);
    const resultat = fn(suivant);
    enregistrer(suivant);
    return resultat;
  }
  function inscrire(nom, jeton, equipe) {
    const existant = etat.joueurs.find(j => typeof jeton === "string" && j.jeton === jeton);
    if (existant) {
      if (equipe !== undefined && !["math", "matique"].includes(equipe)) throw new Error("Choisis Math ou Matique.");
      if (existant.equipe && equipe && existant.equipe !== equipe) throw new Error("Ton équipe est conservée pour cette pratique.");
      if (!existant.equipe && equipe) modifier(s => { s.joueurs.find(j => j.id === existant.id).equipe = equipe; });
      return { id: existant.id, jeton: existant.jeton };
    }
    if (!["math", "matique"].includes(equipe)) throw new Error("Choisis Math ou Matique.");
    if (etat.phase === "terminee") throw new Error("Cette pratique est terminée.");
    if (typeof nom !== "string") throw new Error("Indique ton nom.");
    nom = nom.normalize("NFC").replace(/\s+/g, " ").trim();
    if (!nom || nom.length > 50 || /[\u0000-\u001f\u007f]/.test(nom)) throw new Error("Utilise un nom de 1 à 50 caractères.");
    if (etat.joueurs.some(j => j.nom.toLocaleLowerCase("fr") === nom.toLocaleLowerCase("fr"))) {
      throw new Error("Ce nom est déjà utilisé. Ajoute une initiale pour te distinguer.");
    }
    if (etat.joueurs.length >= 100) throw new Error("La pratique a atteint sa limite de 100 participants.");
    return modifier(s => {
      const joueur = { id: crypto.randomUUID(), jeton: crypto.randomBytes(24).toString("hex"), nom, equipe };
      s.joueurs.push(joueur);
      return { id: joueur.id, jeton: joueur.jeton };
    });
  }
  function buzzer(id, question, session) {
    if (session !== etat.id || question !== etat.question || etat.phase !== "active" ||
        etat.buzz || etat.exclus.includes(etat.joueurs.find(j => j.id === id)?.equipe) || !etat.joueurs.some(j => j.id === id && ["math", "matique"].includes(j.equipe))) return false;
    modifier(s => { s.buzz = { joueur: id, id: crypto.randomUUID() }; });
    return true;
  }
  function agir(action, revision, session, points, equipe) {
    if (session !== etat.id || revision !== etat.revision) throw new Error("La pratique a changé. Réessaie avec l’affichage à jour.");
    const autorisees = ["demarrer", "suivante", "liberer", "mauvaise", "points", "points-equipe", "annuler", "terminer", "effacer"];
    if (!autorisees.includes(action)) throw new Error("Action inconnue.");
    if (action === "effacer") { enregistrer(nouvelle()); return; }
    modifier(s => {
      if (action === "demarrer") {
        if (s.phase === "active") throw new Error("La pratique est déjà en cours.");
        s.phase = "active"; s.buzz = null; s.exclus = []; return;
      }
      if (action === "terminer") { s.phase = "terminee"; s.buzz = null; s.exclus = []; return; }
      if (s.phase !== "active") throw new Error("Démarre la pratique avant de continuer.");
      if (action === "annuler") {
        const derniere = s.reponses.pop();
        if (!derniere) throw new Error("Aucune réponse à annuler.");
        s.question = derniere.question; s.buzz = null; s.exclus = []; return;
      }
      if (action === "points-equipe") {
        if (!["math", "matique"].includes(equipe)) throw new Error("Équipe invalide.");
        if (![5, 10, 20].includes(points)) throw new Error("Pointage invalide.");
        s.reponses.push({ question: s.question, equipe, points });
        s.question++;
      }
      if (action === "points" || action === "mauvaise") {
        if (!s.buzz) throw new Error("Attends qu’un joueur déclenche son buzzer.");
        if (action === "mauvaise") { s.exclus.push(s.joueurs.find(j => j.id === s.buzz.joueur).equipe); s.buzz = null; return; }
        if (![5, 10, 20].includes(points)) throw new Error("Pointage invalide.");
        s.reponses.push({ question: s.question, joueur: s.buzz.joueur, points });
        s.question++;
      }
      if (action === "suivante") s.question++;
      s.buzz = null; s.exclus = [];
    });
  }
  function vue(connectes = new Set()) {
    return {
      id: etat.id, revision: etat.revision, phase: etat.phase, question: etat.question,
      buzz: etat.buzz, exclus: [...etat.exclus], reponses: etat.reponses.length,
      equipes: ["math", "matique"].map(id => ({
        id, nom: id === "math" ? "Math" : "Matique",
        points: etat.reponses.filter(r => r.equipe === id || etat.joueurs.find(j => j.id === r.joueur)?.equipe === id).reduce((n, r) => n + r.points, 0),
        pointsEquipe: etat.reponses.filter(r => r.equipe === id).reduce((n, r) => n + r.points, 0),
        bonnesEquipe: etat.reponses.filter(r => r.equipe === id).length
      })),
      joueurs: etat.joueurs.map(j => ({
        id: j.id, nom: j.nom, equipe: j.equipe || null, connecte: connectes.has(j.id),
        points: etat.reponses.filter(r => r.joueur === j.id).reduce((n, r) => n + r.points, 0),
        bonnes: etat.reponses.filter(r => r.joueur === j.id).length
      }))
    };
  }
  return { inscrire, buzzer, agir, vue };
}

function installerPratique(io, dossier) {
  const espace = io.of("/pratique");
  let pratique;
  try {
    pratique = creerPratique(dossier);
  } catch (erreur) {
    // Une erreur de pratique ne doit jamais empêcher les parties officielles.
    console.error("Chargement de la pratique impossible :", erreur);
    espace.on("connection", socket => socket.emit("indisponible", {
      erreur: "La pratique est indisponible. Demande au responsable de vérifier sa sauvegarde."
    }));
    return null;
  }
  // Comme le marqueur ordinaire, l'écran animateur est public.
  // Les connexions joueurs ne reçoivent pas les commandes du marqueur.
  const connectes = () => new Set([...espace.sockets.values()].map(s => s.data.joueur).filter(Boolean));
  const diffuser = () => espace.emit("etat", pratique.vue(connectes()));
  espace.on("connection", socket => {
    const animateur = socket.handshake.auth?.role === "animateur";
    socket.emit("etat", pratique.vue(connectes()));
    function traiter(fn, retour) {
      try {
        const valeur = fn();
        if (typeof retour === "function") retour({ ok: true, ...valeur });
        diffuser();
      } catch (erreur) {
        console.error("Pratique :", erreur.message);
        const message = erreur.code ? "Impossible de sauvegarder la pratique. Réessaie." : erreur.message;
        if (typeof retour === "function") retour({ ok: false, erreur: message });
      }
    }
    socket.on("inscrire", (donnees, retour) => traiter(() => {
      const inscription = pratique.inscrire(donnees?.nom, donnees?.jeton, donnees?.equipe);
      socket.data.joueur = inscription.id;
      return inscription;
    }, retour));
    socket.on("buzz", (donnees, retour) => traiter(() => {
      return { accepte: pratique.buzzer(socket.data.joueur, donnees?.question, donnees?.session) };
    }, retour));
    if (animateur) socket.on("action", (donnees, retour) => traiter(() => {
      pratique.agir(donnees?.action, donnees?.revision, donnees?.session, donnees?.points, donnees?.equipe);
    }, retour));
    socket.on("disconnect", diffuser);
  });
  return pratique;
}

module.exports = { creerPratique, installerPratique };
