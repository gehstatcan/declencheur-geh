"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { Server } = require("socket.io");
const client = require("../node_modules/socket.io/client-dist/socket.io.js");
const { creerPratique, installerPratique } = require("../pratique-serveur");

function dossierTest(t) {
  const racine = fs.mkdtempSync(path.join(os.tmpdir(), "geh-pratique-test-"));
  t.after(() => {
    const cible = path.resolve(racine);
    assert.equal(path.dirname(cible), path.resolve(os.tmpdir()));
    assert(path.basename(cible).startsWith("geh-pratique-test-"));
    fs.rmSync(cible, { recursive: true, force: true });
  });
  return racine;
}
function commande(p, action, points, equipe) {
  const e = p.vue();
  p.agir(action, e.revision, e.id, points, equipe);
}
test("points collectifs : cumul, annulation, sauvegarde et validation", t => {
  const dir = dossierTest(t), p = creerPratique(dir);
  assert.throws(() => commande(p, "points-equipe", 10, "math"));
  const alice = p.inscrire("Alice", undefined, "math");
  commande(p, "demarrer");
  const avant = p.vue();
  for (const [points, equipe] of [[10, "autre"], [10, undefined], [999, "math"], ["10", "math"]]) {
    assert.throws(() => commande(p, "points-equipe", points, equipe));
    assert.deepEqual(p.vue(), avant);
  }
  commande(p, "points-equipe", 10, "math");
  assert.throws(() => p.agir("points-equipe", avant.revision, avant.id, 10, "math"));
  assert.equal(p.vue().question, 2);
  assert.equal(p.vue().joueurs[0].points, 0);
  assert.equal(p.vue().joueurs[0].bonnes, 0);
  assert.equal(p.vue().equipes[0].pointsEquipe, 10);
  assert(p.buzzer(alice.id, 2, p.vue().id));
  commande(p, "points", 5);
  assert.equal(p.vue().equipes[0].points, 15);
  assert.equal(p.vue().equipes[0].pointsEquipe, 10);
  assert(p.buzzer(alice.id, 3, p.vue().id));
  commande(p, "mauvaise");
  commande(p, "points-equipe", 20, "matique");
  assert.equal(p.vue().question, 4);
  assert.equal(p.vue().buzz, null);
  assert.deepEqual(p.vue().exclus, []);
  assert.equal(p.vue().equipes[1].points, 20);
  assert.equal(p.vue().equipes[1].bonnesEquipe, 1);
  const reprise = creerPratique(dir);
  assert.deepEqual(reprise.vue(), p.vue());
  commande(reprise, "annuler");
  assert.equal(reprise.vue().question, 3);
  assert.equal(reprise.vue().equipes[1].pointsEquipe, 0);
  assert.equal(reprise.vue().equipes[0].points, 15);
  commande(reprise, "annuler");
  assert.equal(reprise.vue().joueurs[0].points, 0);
  assert.equal(reprise.vue().equipes[0].points, 10);
  commande(reprise, "terminer");
  assert.throws(() => commande(reprise, "points-equipe", 5, "math"));
  assert.equal(creerPratique(dir).vue().equipes[0].pointsEquipe, 10);
  commande(reprise, "effacer");
  assert(reprise.vue().equipes.every(e => e.points === 0 && e.pointsEquipe === 0 && e.bonnesEquipe === 0));
});
test("points individuels, premier buzz, réplique et annulation", t => {
  const p = creerPratique(dossierTest(t));
  const alice = p.inscrire("Alice", undefined, "math"), bob = p.inscrire("Bob", undefined, "matique");
  assert.equal(p.buzzer(alice.id, 1, p.vue().id), false);
  commande(p, "demarrer");
  assert(p.buzzer(alice.id, 1, p.vue().id));
  assert.equal(p.buzzer(bob.id, 1, p.vue().id), false);
  commande(p, "mauvaise");
  assert.equal(p.buzzer(alice.id, 1, p.vue().id), false);
  assert(p.buzzer(bob.id, 1, p.vue().id));
  commande(p, "points", 10);
  assert.equal(p.vue().question, 2);
  assert.equal(p.vue().joueurs.find(j => j.id === bob.id).points, 10);
  assert.equal(p.buzzer(alice.id, 1, p.vue().id), false);
  commande(p, "annuler");
  assert.equal(p.vue().question, 1);
  assert.equal(p.vue().joueurs.find(j => j.id === bob.id).points, 0);
  assert(p.buzzer(alice.id, 1, p.vue().id));
  commande(p, "liberer");
  assert.equal(p.vue().buzz, null);
  assert(p.buzzer(alice.id, 1, p.vue().id));
  commande(p, "points", 20);
  assert.equal(p.vue().joueurs.find(j => j.id === alice.id).points, 20);
});
test("actions périmées, doubles points et valeurs invalides refusés", t => {
  const p = creerPratique(dossierTest(t)), a = p.inscrire("Alice", undefined, "math");
  commande(p, "demarrer"); p.buzzer(a.id, 1, p.vue().id);
  const e = p.vue();
  assert.throws(() => commande(p, "points", 999));
  assert.equal(p.vue().revision, e.revision);
  p.agir("points", e.revision, e.id, 5);
  assert.throws(() => p.agir("points", e.revision, e.id, 5));
  assert.throws(() => commande(p, "points", 10));
  assert.throws(() => commande(p, "inconnu"));
  assert.equal(p.vue().joueurs[0].points, 5);
});
test("reprise après redémarrage, fin conservée et effacement complet", t => {
  const dir = dossierTest(t);
  let p = creerPratique(dir);
  const a = p.inscrire("Alice", undefined, "math");
  commande(p, "demarrer"); p.buzzer(a.id, 1, p.vue().id); commande(p, "points", 10);
  commande(p, "terminer");
  p = creerPratique(dir);
  assert.equal(p.vue().phase, "terminee");
  assert.equal(p.vue().joueurs[0].points, 10);
  assert.deepEqual(p.inscrire("", a.jeton), a);
  assert.throws(() => p.inscrire("Bob", undefined, "matique"));
  assert.equal(p.buzzer(a.id, p.vue().question, p.vue().id), false);
  commande(p, "demarrer");
  const ancien = p.vue();
  commande(p, "effacer");
  assert.notEqual(p.vue().id, ancien.id);
  assert.equal(p.vue().joueurs.length, 0);
  assert.equal(p.vue().reponses, 0);
  assert.equal(creerPratique(dir).vue().phase, "attente");
  assert.equal(p.buzzer(a.id, 1, ancien.id), false);
});
test("identités validées, jetons privés et aucun changement aux saisons", t => {
  const racine = dossierTest(t);
  fs.mkdirSync(path.join(racine, "saisons"));
  const fichierOfficiel = path.join(racine, "saisons", "repondants.json");
  const original = '[{"points":123}]';
  fs.writeFileSync(fichierOfficiel, original);
  const p = creerPratique(path.join(racine, "pratique"));
  const a = p.inscrire("  Alice   Martin ", undefined, "math");
  assert.throws(() => p.inscrire("alice martin", undefined, "matique"));
  assert.throws(() => p.inscrire(" ", undefined, "math"));
  assert.throws(() => p.inscrire("A".repeat(51), undefined, "math"));
  assert.throws(() => p.inscrire({ nom: "Bob", equipe: "matique" }, undefined, "math"));
  assert.equal(p.vue().joueurs[0].nom, "Alice Martin");
  assert(!JSON.stringify(p.vue()).includes(a.jeton));
  assert.deepEqual(p.inscrire("autre nom", a.jeton), a);
  commande(p, "demarrer"); p.buzzer(a.id, 1, p.vue().id); commande(p, "points", 10);
  commande(p, "terminer"); commande(p, "effacer");
  assert.equal(fs.readFileSync(fichierOfficiel, "utf8"), original);
  assert.deepEqual(fs.readdirSync(racine).sort(), ["pratique", "saisons"]);
});
test("échec de sauvegarde : aucun point ni état publié en mémoire", t => {
  const dir = dossierTest(t), p = creerPratique(dir), a = p.inscrire("Alice", undefined, "math");
  commande(p, "demarrer"); p.buzzer(a.id, 1, p.vue().id);
  const avant = p.vue();
  fs.mkdirSync(path.join(dir, "session.json.tmp"));
  assert.throws(() => commande(p, "points", 10));
  assert.deepEqual(p.vue(), avant);
});
test("une sauvegarde corrompue n’est pas écrasée silencieusement", t => {
  const dir = dossierTest(t);
  fs.writeFileSync(path.join(dir, "session.json"), "invalide");
  assert.throws(() => creerPratique(dir));
  assert.equal(fs.readFileSync(path.join(dir, "session.json"), "utf8"), "invalide");
});
test("Socket.IO : équipes de pratique, buzz simultanés, reconnexion et droits des connexions", { timeout: 10000 }, async t => {
  const dir = dossierTest(t);
  const serveur = http.createServer();
  const io = new Server(serveur);
  const p = installerPratique(io, dir);
  const connexions = [];
  t.after(async () => {
    connexions.forEach(s => s.disconnect());
    await new Promise(resolve => io.close(resolve));
  });
  await new Promise(resolve => serveur.listen(0, "127.0.0.1", resolve));
  async function connecter(role) {
    const s = client("http://127.0.0.1:" + serveur.address().port + "/pratique",
      { auth: { role }, transports: ["websocket"], reconnection: false, forceNew: true });
    connexions.push(s);
    await new Promise((resolve, reject) => { s.once("etat", resolve); s.once("connect_error", reject); });
    return s;
  }
  const appel = (s, nom, args) => new Promise((resolve,reject) => s.timeout(1500).emit(nom,args,(err,res) => err ? reject(err) : resolve(res)));
  const host = await connecter("animateur"), alice = await connecter("joueur"), bob = await connecter("joueur");
  const a = await appel(alice, "inscrire", { nom: "Alice", equipe: "math" });
  const b = await appel(bob, "inscrire", { nom: "Bob", equipe: "matique" });
  assert(a.ok && b.ok);
  let e = p.vue();
  assert((await appel(host,"action",{action:"demarrer",revision:e.revision,session:e.id})).ok);
  e = p.vue();
  const buzz = await Promise.all([appel(alice,"buzz",{question:e.question,session:e.id}),appel(bob,"buzz",{question:e.question,session:e.id})]);
  assert.equal(buzz.filter(r=>r.accepte).length,1);
  const gagnant = p.vue().buzz.joueur;
  e = p.vue();
  assert((await appel(host,"action",{action:"points",points:10,revision:e.revision,session:e.id})).ok);
  assert.equal(p.vue().joueurs.find(j=>j.id===gagnant).points,10);
  e = p.vue();
  assert((await appel(host,"action",{action:"points-equipe",equipe:"math",points:20,revision:e.revision,session:e.id})).ok);
  assert.equal(p.vue().equipes[0].pointsEquipe,20);
  assert.equal(p.vue().joueurs.find(j=>j.id===gagnant).points,10);
  const avantRefus = p.vue();
  await new Promise(resolve => alice.timeout(100).emit("action",{action:"points-equipe",equipe:"math",points:20,revision:avantRefus.revision,session:e.id},err=>{ assert(err); resolve(); }));
  assert.deepEqual(p.vue(),avantRefus);
  await new Promise(resolve => alice.timeout(100).emit("action",{action:"effacer",revision:p.vue().revision,session:e.id},err=>{ assert(err); resolve(); }));
  assert.equal(p.vue().joueurs.length,2);
  alice.disconnect();
  const reprise = await connecter("joueur");
  const resultat = await appel(reprise,"inscrire",{jeton:a.jeton});
  assert.equal(resultat.id,a.id);
  assert.equal(p.vue().joueurs.length,2);
});

test("equipes : choix obligatoire, replique collective, scores et reprise", t => {
 const dir=dossierTest(t), p=creerPratique(dir);
 assert.throws(()=>p.inscrire("Sans equipe"));
 assert.throws(()=>p.inscrire("Invalide",undefined,"autre"));
 const a=p.inscrire("Alice",undefined,"math"), b=p.inscrire("Bob",undefined,"math"), c=p.inscrire("Claude",undefined,"matique");
 commande(p,"demarrer");p.buzzer(a.id,1,p.vue().id);commande(p,"mauvaise");
 assert.equal(p.buzzer(b.id,1,p.vue().id),false);
 const tardif=p.inscrire("Denis",undefined,"math");
 assert.equal(p.buzzer(tardif.id,1,p.vue().id),false);
 assert(p.buzzer(c.id,1,p.vue().id));commande(p,"points",10);
 assert.equal(p.vue().equipes.find(e=>e.id==="matique").points,10);
 assert.equal(p.vue().equipes.find(e=>e.id==="math").points,0);
 assert.throws(()=>p.inscrire("",c.jeton,"math"));
 const reprise=creerPratique(dir);
 assert.equal(reprise.vue().joueurs.find(j=>j.id===c.id).equipe,"matique");
 assert.equal(reprise.vue().equipes.find(e=>e.id==="matique").points,10);
 commande(reprise,"annuler");
 assert.equal(reprise.vue().equipes.find(e=>e.id==="matique").points,0);
});
test("ancienne pratique : choix d'equipe sans perte de points ni d'identite", t => {
 const dir=dossierTest(t);
 const ancienne={id:"ancienne",revision:1,phase:"active",question:2,joueurs:[{id:"a",nom:"Alice",jeton:"secret"}],reponses:[{question:1,joueur:"a",points:10}],buzz:null,exclus:[]};
 fs.writeFileSync(path.join(dir,"session.json"),JSON.stringify(ancienne));
 const p=creerPratique(dir);
 assert.equal(p.vue().joueurs[0].points,10);
 assert.equal(p.buzzer("a",2,"ancienne"),false);
 assert.equal(p.inscrire("", "secret").id,"a");
 p.inscrire("", "secret","math");
 assert.equal(p.vue().equipes[0].points,10);
 assert.equal(creerPratique(dir).vue().joueurs[0].equipe,"math");
 assert(p.buzzer("a",2,"ancienne"));
});
