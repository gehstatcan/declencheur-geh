"use strict";
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

module.exports = function installerEditeur(app, contexte) {
  const empreinte = données => crypto.createHash('sha256').update(JSON.stringify(données)).digest('hex');
  function lire(noPartie) {
    const c = contexte();
    const lireJSON = nom => JSON.parse(fs.readFileSync(path.join(c.dossierSaison, nom), 'utf8'));
    const partie = c.parties.find(p => p.noPartie === noPartie);
    if (!partie) throw new Error('Partie introuvable.');
    const alignements = lireJSON('alignements.json');
    if (!alignements.some(a => a.noPartie === noPartie)) throw new Error('Cette partie n’est pas terminée.');
    if (c.étatsParties[noPartie] && c.étatsParties[noPartie].mode !== 'terminée') throw new Error('Cette partie est ouverte dans le marqueur. Fermez-la avant de corriger ses résultats.');
    const cumul = lireJSON('répondants.json');
    const nom = path.join('parties', `répondants-${noPartie}.json`);
    const fichierExiste = fs.existsSync(path.join(c.dossierSaison, nom));
    const réponses = fichierExiste ? lireJSON(nom) : cumul.filter(r => r.noPartie === noPartie);
    return { ...c, partie, alignements, cumul, nom, fichierExiste, réponses, version: empreinte([c.saisonActive, partie, c.séries, c.joueurs, alignements, cumul, réponses]) };
  }
  function auth(req, res, next) {
    if (!contexte().auth(req)) return res.status(401).json({ erreur: 'Non authentifié' });
    next();
  }
  app.get('/api/admin/resultats', auth, (req, res) => {
    try {
      const c = contexte();
      const alignements = JSON.parse(fs.readFileSync(path.join(c.dossierSaison, 'alignements.json'), 'utf8'));
      res.json({ saison: c.saisonActive, parties: c.parties.filter(p => alignements.some(a => a.noPartie === p.noPartie)), équipes: c.équipes });
    } catch (e) { res.status(400).json({ erreur: e.message }); }
  });
  app.get('/api/admin/resultats/:numero', auth, (req, res) => {
    try {
      const c = lire(Number(req.params.numero));
      res.json({ saison: c.saisonActive, version: c.version, partie: c.partie, réponses: c.réponses, séries: c.séries, joueurs: c.joueurs, équipes: c.équipes });
    } catch (e) { res.status(400).json({ erreur: e.message }); }
  });
  app.put('/api/admin/resultats/:numero', auth, (req, res) => {
    let c;
    try {
      c = lire(Number(req.params.numero));
      if (req.body.saison !== c.saisonActive || req.body.version !== c.version)
        return res.status(409).json({ erreur: 'Les données ont changé. Rechargez la partie avant de recommencer.' });
      const réponses = req.body.réponses;
      if (!Array.isArray(réponses)) throw new Error('Liste de réponses invalide.');
      const clés = new Set();
      for (const r of réponses) {
        const q = c.séries.find(s => s.noSérie === r.noSérie)?.questions.find(q => q.noQuestion === r.noQuestion);
        const clé = `${r.noSérie}/${r.noQuestion}`;
        if (!q || r.noPartie !== c.partie.noPartie || clés.has(clé)) throw new Error('Question invalide ou en double.');
        clés.add(clé);
        if (![c.partie.noÉquipeA, c.partie.noÉquipeB].includes(r.noÉquipe)) throw new Error('Équipe étrangère à cette partie.');
        if (r.noJoueur !== 99 && !c.joueurs.some(j => j.noÉquipe === r.noÉquipe && j.noJoueur === r.noJoueur && !j.estÉquipe)) throw new Error('Joueur introuvable dans cette équipe.');
        if (typeof r.pointsSecondaires !== 'boolean' || (r.pointsSecondaires && !(q.pointsSecondaires > 0))) throw new Error('Pointage secondaire invalide.');
        if (Object.keys(r).some(k => !['noPartie', 'noSérie', 'noQuestion', 'noÉquipe', 'noJoueur', 'pointsSecondaires'].includes(k))) throw new Error('Champ de réponse inconnu.');
      }
      réponses.sort((a, b) => a.noSérie - b.noSérie || a.noQuestion - b.noQuestion);
      const fusion = [...c.cumul.filter(r => r.noPartie !== c.partie.noPartie), ...réponses].sort((a, b) => a.noPartie - b.noPartie || a.noSérie - b.noSérie || a.noQuestion - b.noQuestion);
      const sauvegarde = path.join(c.dossierSaison, 'sauvegardes-corrections', `${Date.now()}-${crypto.randomUUID()}`);
      fs.mkdirSync(sauvegarde, { recursive: true });
      const cheminPartie = path.join(c.dossierSaison, c.nom);
      const cheminCumul = path.join(c.dossierSaison, 'répondants.json');
      const originalCumul = fs.readFileSync(cheminCumul);
      const originalPartie = c.fichierExiste ? fs.readFileSync(cheminPartie) : null;
      fs.writeFileSync(path.join(sauvegarde, 'répondants.json'), originalCumul);
      if (originalPartie) fs.writeFileSync(path.join(sauvegarde, `répondants-${c.partie.noPartie}.json`), originalPartie);
      fs.writeFileSync(path.join(sauvegarde, 'correction.json'), JSON.stringify({ saison: c.saisonActive, noPartie: c.partie.noPartie, date: new Date().toISOString(), avant: c.réponses, après: réponses }, null, 2));
      try {
        fs.writeFileSync(cheminPartie + '.tmp', JSON.stringify(réponses, null, 2));
        fs.writeFileSync(cheminCumul + '.tmp', JSON.stringify(fusion, null, 2));
        fs.renameSync(cheminPartie + '.tmp', cheminPartie);
        fs.renameSync(cheminCumul + '.tmp', cheminCumul);
      } catch (e) {
        fs.writeFileSync(cheminCumul, originalCumul);
        if (originalPartie) fs.writeFileSync(cheminPartie, originalPartie);
        else if (fs.existsSync(cheminPartie)) fs.unlinkSync(cheminPartie);
        throw e;
      }
      delete c.étatsParties[c.partie.noPartie];
      res.json({ succès: true, sauvegarde: path.basename(sauvegarde) });
    } catch (e) { res.status(400).json({ erreur: e.message }); }
  });
};
