"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

// Aucune lecture ni écriture dans data/saisons : la pratique est indépendante.
// Cette fonction gère les règles et la sauvegarde. installerPratique, plus bas,
// la relie aux pages web grâce aux messages Socket.IO.
function creerPratique(dossier) {
  const fichier = path.join(dossier, "session.json");
  // id identifie la séance ; revision augmente à chaque sauvegarde.
  // reponses conserve les pointages individuels et collectifs, dans l'ordre.
  // buzz désigne le joueur qui a la parole (null = personne).
  // exclus contient les équipes ayant mal répondu à la question en cours.
  const nouvelle = () => ({
    id: crypto.randomUUID(), revision: 0, phase: "attente", question: 1,
    joueurs: [], reponses: [], buzz: null, exclus: []
  });
  let etat;
  // Reprendre la séance précédente au démarrage, y compris ses résultats.
  try {
    etat = JSON.parse(fs.readFileSync(fichier, "utf8"));
    if (!etat.id || !Array.isArray(etat.joueurs) || !Array.isArray(etat.reponses) ||
        !Array.isArray(etat.exclus) || !["attente", "active", "terminee"].includes(etat.phase) ||
        !Number.isInteger(etat.revision) || !Number.isInteger(etat.question)) {
      throw new Error("Format de sauvegarde de pratique invalide.");
    }
  } catch (erreur) {
    // ENOENT signifie que le fichier n'existe pas encore. Toute autre erreur
    // est remontée pour éviter de remplacer une sauvegarde endommagée.
    if (erreur.code !== "ENOENT") throw erreur;
    etat = nouvelle();
  }
  function enregistrer(suivant) {
    suivant.revision = etat.revision + 1;
    fs.mkdirSync(dossier, { recursive: true });
    // Écrire d'abord un fichier temporaire, puis remplacer la sauvegarde.
    // Ainsi, une erreur pendant l'écriture ne tronque pas le fichier existant.
    const temporaire = fichier + ".tmp";
    fs.writeFileSync(temporaire, JSON.stringify(suivant, null, 2), "utf8");
    fs.renameSync(temporaire, fichier);
    etat = suivant; // Publier seulement après une sauvegarde réussie.
  }
  function modifier(fn) {
    // fn reçoit une copie de l'état (appelée s dans les fonctions ci-dessous).
    // Si la modification ou sa sauvegarde échoue, l'état en mémoire reste intact.
    const suivant = structuredClone(etat);
    const resultat = fn(suivant);
    enregistrer(suivant);
    return resultat;
  }
  function inscrire(nom, jeton, equipe) {
    // Le jeton privé, conservé par le navigateur, permet de retrouver son joueur
    // après une déconnexion. L'identifiant public seul ne suffit pas.
    const existant = etat.joueurs.find(j => typeof jeton === "string" && j.jeton === jeton);
    if (existant) {
      if (equipe !== undefined && !["math", "matique"].includes(equipe)) throw new Error("Choisis Math ou Matique.");
      if (existant.equipe && equipe && existant.equipe !== equipe) throw new Error("Ton équipe est conservée pour cette pratique.");
      // Compatibilité avec les anciennes séances qui n'avaient pas d'équipes.
      if (!existant.equipe && equipe) modifier(s => { s.joueurs.find(j => j.id === existant.id).equipe = equipe; });
      return { id: existant.id, jeton: existant.jeton };
    }
    if (!["math", "matique"].includes(equipe)) throw new Error("Choisis Math ou Matique.");
    if (etat.phase === "terminee") throw new Error("Cette pratique est terminée.");
    if (typeof nom !== "string") throw new Error("Indique ton nom.");
    // Uniformiser les accents et les espaces avant de vérifier les doublons.
    nom = nom.normalize("NFC").replace(/\s+/g, " ").trim();
    if (!nom || nom.length > 50 || /[\u0000-\u001f\u007f]/.test(nom)) throw new Error("Utilise un nom de 1 à 50 caractères.");
    if (etat.joueurs.some(j => j.nom.toLocaleLowerCase("fr") === nom.toLocaleLowerCase("fr"))) {
      throw new Error("Ce nom est déjà utilisé. Ajoute une initiale pour te distinguer.");
    }
    // Limite totale, toutes équipes confondues. Les entités « Équipe Math » et
    // « Équipe Matique » ne sont pas des joueurs inscrits et ne comptent pas ici.
    if (etat.joueurs.length >= 100) throw new Error("La pratique a atteint sa limite de 100 participants.");
    return modifier(s => {
      const joueur = { id: crypto.randomUUID(), jeton: crypto.randomBytes(24).toString("hex"), nom, equipe };
      s.joueurs.push(joueur);
      return { id: joueur.id, jeton: joueur.jeton };
    });
  }
  function buzzer(id, question, session) {
    // Refuser les buzz d'une ancienne séance/question, ceux d'une équipe exclue
    // ou d'un joueur non inscrit, et ceux reçus après le premier buzz accepté.
    if (session !== etat.id || question !== etat.question || etat.phase !== "active" ||
        etat.buzz || etat.exclus.includes(etat.joueurs.find(j => j.id === id)?.equipe) || !etat.joueurs.some(j => j.id === id && ["math", "matique"].includes(j.equipe))) return false;
    // Un identifiant propre à chaque buzz permet au client de détecter un nouveau
    // déclenchement, même si le même joueur reprend la parole (notamment pour le son).
    modifier(s => { s.buzz = { joueur: id, id: crypto.randomUUID() }; });
    return true;
  }
  function agir(action, revision, session, points, equipe) {
    // L'animateur envoie la version qu'il voit : refuser une commande périmée
    // évite notamment de compter deux fois des points avec le même affichage.
    if (session !== etat.id || revision !== etat.revision) throw new Error("La pratique a changé. Réessaie avec l’affichage à jour.");
    const autorisees = ["demarrer", "suivante", "liberer", "mauvaise", "points", "points-equipe", "annuler", "terminer", "effacer"];
    if (!autorisees.includes(action)) throw new Error("Action inconnue.");
    // Effacer recrée aussi l'identifiant de séance : les anciens messages sont invalidés.
    if (action === "effacer") { enregistrer(nouvelle()); return; }
    modifier(s => {
      if (action === "demarrer") {
        // Reprendre conserve les joueurs, les points et le numéro de question.
        if (s.phase === "active") throw new Error("La pratique est déjà en cours.");
        s.phase = "active"; s.buzz = null; s.exclus = []; return;
      }
      // Terminer bloque le jeu, mais conserve les résultats pour consultation.
      if (action === "terminer") { s.phase = "terminee"; s.buzz = null; s.exclus = []; return; }
      if (s.phase !== "active") throw new Error("Démarre la pratique avant de continuer.");
      if (action === "annuler") {
        // Retirer le dernier pointage, individuel ou collectif, puis revenir
        // à sa question. Les totaux seront recalculés par vue().
        const derniere = s.reponses.pop();
        if (!derniere) throw new Error("Aucune réponse à annuler.");
        s.question = derniere.question; s.buzz = null; s.exclus = []; return;
      }
      if (action === "points-equipe") {
        // Réponse collective : aucun buzzer requis ni point attribué à un joueur.
        if (!["math", "matique"].includes(equipe)) throw new Error("Équipe invalide.");
        if (![5, 10, 20].includes(points)) throw new Error("Pointage invalide.");
        s.reponses.push({ question: s.question, equipe, points });
        s.question++;
      }
      if (action === "points" || action === "mauvaise") {
        if (!s.buzz) throw new Error("Attends qu’un joueur déclenche son buzzer.");
        // Mauvaise réponse : exclure toute l'équipe et laisser la réplique à l'autre.
        // Le return conserve ces exclusions et le numéro de question actuel.
        if (action === "mauvaise") { s.exclus.push(s.joueurs.find(j => j.id === s.buzz.joueur).equipe); s.buzz = null; return; }
        if (![5, 10, 20].includes(points)) throw new Error("Pointage invalide.");
        s.reponses.push({ question: s.question, joueur: s.buzz.joueur, points });
        s.question++;
      }
      if (action === "suivante") s.question++;
      // Après un pointage ou un passage de question, tout le monde peut rebuzzer.
      // « liberer » arrive aussi ici, mais sans changer le numéro de question.
      s.buzz = null; s.exclus = [];
    });
  }
  function vue(connectes = new Set()) {
    // Construire les données publiques envoyées aux pages, sans les jetons privés.
    // Les scores viennent de l'historique : pas de second total à synchroniser.
    return {
      id: etat.id, revision: etat.revision, phase: etat.phase, question: etat.question,
      buzz: etat.buzz, exclus: [...etat.exclus], reponses: etat.reponses.length,
      equipes: ["math", "matique"].map(id => ({
        id, nom: id === "math" ? "Math" : "Matique",
        // Total de l'équipe = points collectifs + points de ses joueurs.
        points: etat.reponses.filter(r => r.equipe === id || etat.joueurs.find(j => j.id === r.joueur)?.equipe === id).reduce((n, r) => n + r.points, 0),
        // Ces deux valeurs concernent uniquement l'entité équipe.
        pointsEquipe: etat.reponses.filter(r => r.equipe === id).reduce((n, r) => n + r.points, 0),
        bonnesEquipe: etat.reponses.filter(r => r.equipe === id).length
      })),
      joueurs: etat.joueurs.map(j => ({
        // La présence dépend des connexions actuelles, pas de la sauvegarde.
        id: j.id, nom: j.nom, equipe: j.equipe || null, connecte: connectes.has(j.id),
        points: etat.reponses.filter(r => r.joueur === j.id).reduce((n, r) => n + r.points, 0),
        bonnes: etat.reponses.filter(r => r.joueur === j.id).length
      }))
    };
  }
  return { inscrire, buzzer, agir, vue };
}

function installerPratique(io, dossier) {
  // Canal Socket.IO réservé à la pratique, distinct des parties officielles.
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
  // Seules les connexions déclarées animateur ont un gestionnaire de commandes.
  // Le Set regroupe les identifiants connectés, même avec plusieurs onglets ouverts.
  const connectes = () => new Set([...espace.sockets.values()].map(s => s.data.joueur).filter(Boolean));
  const diffuser = () => espace.emit("etat", pratique.vue(connectes()));
  espace.on("connection", socket => {
    const animateur = socket.handshake.auth?.role === "animateur";
    // Envoyer immédiatement l'état actuel au navigateur qui vient de se connecter.
    socket.emit("etat", pratique.vue(connectes()));
    function traiter(fn, retour) {
      // Exécuter la demande, répondre à son auteur via retour, puis actualiser
      // tous les écrans. Une erreur est signalée sans publier de nouvel état.
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
      // Associer cette connexion au joueur reconnu grâce à son inscription/jeton.
      socket.data.joueur = inscription.id;
      return inscription;
    }, retour));
    socket.on("buzz", (donnees, retour) => traiter(() => {
      // Utiliser l'identité de la connexion, pas un identifiant choisi dans le message.
      return { accepte: pratique.buzzer(socket.data.joueur, donnees?.question, donnees?.session) };
    }, retour));
    if (animateur) socket.on("action", (donnees, retour) => traiter(() => {
      pratique.agir(donnees?.action, donnees?.revision, donnees?.session, donnees?.points, donnees?.equipe);
    }, retour));
    // Actualiser les indicateurs de présence lorsqu'un navigateur se déconnecte.
    socket.on("disconnect", diffuser);
  });
  return pratique;
}

module.exports = { creerPratique, installerPratique };
