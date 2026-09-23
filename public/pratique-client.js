"use strict";
const animateur = new URLSearchParams(location.search).get("role") === "animateur";
document.body.classList.toggle("mode-animateur", animateur);
const socket = io("/pratique", { auth: { role: animateur ? "animateur" : "joueur" } });
const $ = id => document.getElementById(id);
let etat = null, identite = null, jeton = "", sessionStockee = "", occupe = false, dernierBuzz = null;
let contexteAudio;
try {
  const sauvegarde = JSON.parse(localStorage.getItem("geh-pratique") || "{}");
  jeton = sauvegarde.jeton || ""; sessionStockee = sauvegarde.session || "";
} catch {}
$("zone-animateur").hidden = !animateur;
$("gestion-pratique").hidden = !animateur;
document.querySelectorAll(".points-equipe-commandes").forEach(zone => { zone.hidden = !animateur; });
$("titre").textContent = animateur ? "Animer une pratique" : "Participer à la pratique";
$("lien-joueurs").href = new URL("pratique.html", location.href).href;
$("lien-joueurs").textContent = $("lien-joueurs").href;
function erreur(message) { $("erreur").textContent = message || ""; }
function envoyer(type, donnees, suite) {
  if (!socket.connected || occupe) return;
  occupe = true; erreur(""); afficher();
  socket.timeout(5000).emit(type, donnees, (probleme, resultat) => {
    occupe = false;
    if (probleme) erreur("Le serveur ne répond pas. Vérifie la connexion et l’état de la séance avant de réessayer.");
    else if (!resultat?.ok) erreur(resultat?.erreur || "Action impossible.");
    else if (suite) suite(resultat);
    afficher();
  });
}
function inscrire(nom, equipe) {
  envoyer("inscrire", { nom, jeton, equipe }, resultat => {
    identite = resultat.id; jeton = resultat.jeton;
    try { localStorage.setItem("geh-pratique", JSON.stringify({ jeton, session: etat.id })); } catch {}
  });
}
socket.on("connect", () => { $("connexion").textContent = "Connecté à la pratique"; afficher(); });
socket.on("disconnect", () => { $("connexion").textContent = "Connexion interrompue — reconnexion en cours…"; identite = null; afficher(); });
socket.on("connect_error", () => { $("connexion").textContent = "Serveur inaccessible. Ouvre cette page depuis le site, et non depuis un fichier local."; });
socket.on("indisponible", message => {
  $("connexion").textContent = "Pratique indisponible";
  erreur(message.erreur);
  etat = null;
  afficher();
});
socket.on("etat", nouveau => {
  const premiereReception = !etat;
  const changement = etat && etat.id !== nouveau.id;
  etat = nouveau;
  if (changement || (premiereReception && sessionStockee && sessionStockee !== etat.id)) {
    identite = null; jeton = "";
    try { localStorage.removeItem("geh-pratique"); } catch {}
    if (changement) erreur("La pratique a été effacée. Inscris-toi à nouveau pour participer.");
  }
  if (identite && !etat.joueurs.some(j => j.id === identite)) identite = null;
  if (animateur && etat.buzz && dernierBuzz !== etat.buzz.id && !premiereReception) jouerSon();
  dernierBuzz = etat.buzz?.id;
  afficher();
  if (!animateur && !identite && jeton && !occupe) inscrire("");
});
function afficher() {
  const pret = socket.connected && etat && !occupe;
  if (!etat) {
    document.querySelectorAll("button").forEach(b => { b.disabled = true; });
    return;
  }
  $("phase").textContent = { attente: "En attente du démarrage par l’animateur", active: "Pratique en cours", terminee: "Pratique terminée — résultats conservés" }[etat.phase];
  $("question").textContent = etat.question;
  const premier = etat.joueurs.find(j => j.id === etat.buzz?.joueur);
  $("premier").textContent = premier ? premier.nom + " a la parole !" : etat.phase === "active" ? "À vos buzzers !" : "";
  const moi = etat.joueurs.find(j => j.id === identite);
  $("inscription").hidden = animateur || !!moi?.equipe || (!moi && etat.phase === "terminee");
  $("nom").readOnly = !!moi;
  if (moi) $("nom").value = moi.nom;
  $("premier").classList.toggle("actif", !!premier);
  $("replique").textContent = etat.exclus.length === 1 ? "Réplique à " + (etat.exclus[0] === "math" ? "Matique" : "Math") :
    etat.exclus.length >= 2 ? "Les deux équipes ont répondu. Passe à la question suivante." : "";
  for (const equipe of etat.equipes) {
    $("score-" + equipe.id).textContent = equipe.points;
    $("points-equipe-" + equipe.id).textContent = (equipe.pointsEquipe || 0) + " pts";
    const membres = etat.joueurs.filter(j => j.equipe === equipe.id);
    const lignes = membres.map(j => {
      const li = document.createElement("li");
      li.className = "joueur" + (j.id === premier?.id ? " a-la-parole" : "");
      const info = document.createElement("div"), nom = document.createElement("span"), statut = document.createElement("small"), points = document.createElement("strong");
      nom.className = "nom"; nom.textContent = j.nom;
      statut.textContent = j.connecte ? "● En ligne" : "Déconnecté";
      points.textContent = j.points + " pts";
      info.append(nom, statut); li.append(info, points); return li;
    });
    if (!lignes.length) { const vide = document.createElement("li"); vide.className = "vide"; vide.textContent = "En attente de joueurs…"; lignes.push(vide); }
    $("joueurs-" + equipe.id).replaceChildren(...lignes);
  }
  $("form-inscription").querySelector("button").disabled = !pret;
  $("zone-joueur").hidden = animateur || !identite;
  $("identite").textContent = moi ? moi.nom + " · " + (moi.equipe === "math" ? "Math" : moi.equipe === "matique" ? "Matique" : "Choisis ton équipe") : "";
  $("buzzer").disabled = !pret || !moi?.equipe || etat.phase !== "active" || !!etat.buzz || etat.exclus.includes(moi?.equipe);
  $("aide-buzz").textContent = etat.exclus.includes(moi?.equipe) ? "Ton équipe a déjà répondu. Attends la prochaine question." : "Clique sur le bouton, ou utilise la barre d’espace ou la touche Entrée.";
  for (const bouton of document.querySelectorAll("[data-action]")) {
    const action = bouton.dataset.action;
    bouton.disabled = !pret || (action === "demarrer" ? etat.phase === "active" :
      action === "effacer" ? false :
      action === "terminer" ? etat.phase === "terminee" :
      etat.phase !== "active" || (["points", "mauvaise"].includes(action) && !etat.buzz) || (action === "annuler" && !etat.reponses));
  }
  $("aucun").hidden = etat.joueurs.length > 0 || etat.equipes.some(e => e.pointsEquipe > 0);
  const participants = [...etat.joueurs, ...etat.equipes.map(e => ({
    nom: "Équipe " + e.nom, equipe: e.id, entiteEquipe: true,
    points: e.pointsEquipe || 0, bonnes: e.bonnesEquipe || 0
  }))];
  $("participants").replaceChildren(...participants.sort((a,b) => b.points-a.points || a.nom.localeCompare(b.nom,"fr")).map(j => {
    const ligne = document.createElement("tr");
    if (j.entiteEquipe) ligne.className = "ligne-equipe";
    for (const valeur of [j.nom, j.equipe === "math" ? "Math" : j.equipe === "matique" ? "Matique" : "À choisir", j.entiteEquipe ? "—" : j.connecte ? "En ligne" : "Déconnecté", j.bonnes, j.points]) {
      const cellule = document.createElement("td"); cellule.textContent = valeur; ligne.append(cellule);
    }
    return ligne;
  }));
}
$("form-inscription").addEventListener("submit", e => { e.preventDefault(); inscrire($("nom").value, document.querySelector('input[name="equipe"]:checked')?.value); });
$("buzzer").addEventListener("click", () => {
  if (!$("buzzer").disabled) envoyer("buzz", { question: etat.question, session: etat.id });
});
document.addEventListener("keydown", e => {
  if ((e.code !== "Space" && e.key !== "Enter") || $("zone-joueur").hidden) return;
  if (e.target !== $("buzzer") && /INPUT|TEXTAREA|BUTTON|SELECT|A/.test(e.target.tagName)) return;
  // Garder la page immobile, même si un autre joueur a buzzé ou si la touche reste enfoncée.
  e.preventDefault();
  if (!e.repeat && !$("buzzer").disabled) $("buzzer").click();
});
for (const bouton of document.querySelectorAll("[data-action]")) bouton.addEventListener("click", () => {
  const action = bouton.dataset.action;
  if (action === "effacer" && !confirm("Effacer tous les participants et tous les points de cette pratique ? Cette action est irréversible.")) return;
  if (action === "terminer" && !confirm("Terminer la pratique ? Les résultats resteront consultables.")) return;
  envoyer("action", { action, points: Number(bouton.dataset.points), equipe: bouton.dataset.equipe, revision: etat.revision, session: etat.id });
});
// Les navigateurs exigent une interaction avant de permettre le son.
function activerSon() {
  if (!animateur) return;
  try {
    if (!contexteAudio) {
      contexteAudio = new (window.AudioContext || window.webkitAudioContext)();
      contexteAudio.addEventListener("statechange", afficherStatutSon);
    }
    if (contexteAudio.state !== "running") contexteAudio.resume().catch(afficherStatutSon);
    afficherStatutSon();
  } catch {
    $("statut-son").hidden = false;
    $("statut-son").textContent = "Le son n’est pas disponible dans ce navigateur.";
  }
}
function afficherStatutSon() {
  $("statut-son").hidden = contexteAudio?.state === "running";
}
document.addEventListener("pointerdown", activerSon, { capture: true });
document.addEventListener("keydown", activerSon, { capture: true });
function jouerSon() {
  activerSon();
  if (!contexteAudio || contexteAudio.state !== "running") return;
  const oscillateur = contexteAudio.createOscillator(), gain = contexteAudio.createGain();
  const debut = contexteAudio.currentTime;
  // Buzz franc et soutenu : 0,5 seconde.
  oscillateur.type = "square";
  oscillateur.frequency.value = 220;
  gain.gain.setValueAtTime(0, debut);
  gain.gain.linearRampToValueAtTime(0.35, debut + 0.015);
  gain.gain.setValueAtTime(0.35, debut + 0.4);
  gain.gain.linearRampToValueAtTime(0, debut + 0.5);
  oscillateur.connect(gain); gain.connect(contexteAudio.destination);
  oscillateur.onended = () => { oscillateur.disconnect(); gain.disconnect(); };
  oscillateur.start(debut); oscillateur.stop(debut + 0.5);
}
