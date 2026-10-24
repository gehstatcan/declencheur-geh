let resultatEdition = null;
let resultatChargement = 0;
const nomJoueurResultats = joueur => [joueur?.prénom, joueur?.nom].filter(v => typeof v === 'string' && v.trim()).map(v => v.trim()).join(' ') || joueur?.alias || `Joueur ${joueur?.noJoueur ?? '?'}`;
const texteResultats = valeur => String(valeur ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
async function requeteResultats(url, options) {
    const r = await fetch(url, options);
    const d = await r.json();
    if (!r.ok) throw new Error(d.erreur || 'Chargement impossible');
    return d;
}
async function listerResultats() {
    try {
        const d = await requeteResultats('/api/admin/resultats');
        document.getElementById('partie-resultats').innerHTML = '<option value="">Choisir une partie</option>' + d.parties.map(p => {
            const nom = n => d.équipes.find(e => e.noÉquipe === n)?.nomÉquipe || n;
            return `<option value="${p.noPartie}">P${p.noPartie} — ${texteResultats(p.date)} — ${texteResultats(nom(p.noÉquipeA))} / ${texteResultats(nom(p.noÉquipeB))}</option>`;
        }).join('');
        await chargerResultats();
    } catch (e) { document.getElementById('message-resultats').textContent = e.message; }
}
async function chargerResultats() {
    const génération = ++resultatChargement;
    resultatEdition = null;
    document.getElementById('sauver-resultats').style.display = 'none';
    document.getElementById('editeur-resultats').innerHTML = '';
    const numero = document.getElementById('partie-resultats').value;
    if (!numero) return;
    try {
        const d = await requeteResultats(`/api/admin/resultats/${numero}`);
        if (génération !== resultatChargement) return;
        resultatEdition = d;
        const options = ['<option value="">Non répondue</option>'];
        for (const n of [d.partie.noÉquipeA, d.partie.noÉquipeB]) {
            const nom = d.équipes.find(e => e.noÉquipe === n)?.nomÉquipe || n;
            options.push(`<option value="${n}:99">${texteResultats(nom)} — Équipe</option>`);
            for (const j of d.joueurs.filter(j => j.noÉquipe === n && j.noJoueur !== 99 && !j.estÉquipe)) {
                options.push(`<option value="${n}:${j.noJoueur}">${texteResultats(nom)} — ${texteResultats(nomJoueurResultats(j))}</option>`);
            }
        }
        document.getElementById('editeur-resultats').innerHTML = d.séries.map(s => `<details><summary>Série ${s.noSérie} — ${texteResultats(s.typeSérie)}</summary><table class="questions-table"><thead><tr><th>Question</th><th>Répondant</th><th>Points</th></tr></thead><tbody>${s.questions.map(q => {
            const r = d.réponses.find(r => r.noSérie === s.noSérie && r.noQuestion === q.noQuestion);
            const clé = `${s.noSérie}-${q.noQuestion}`;
            return `<tr><td>Q${q.noQuestion}</td><td><select class="champ reponse-resultat" data-serie="${s.noSérie}" data-question="${q.noQuestion}" id="reponse-${clé}">${options.join('')}</select></td><td><select class="champ" id="points-${clé}"><option value="false">${q.points} points</option>${q.pointsSecondaires > 0 ? `<option value="true">${q.pointsSecondaires} points (secondaires)</option>` : ''}</select></td></tr>`;
        }).join('')}</tbody></table></details>`).join('');
        for (const r of d.réponses) {
            const clé = `${r.noSérie}-${r.noQuestion}`;
            const champ = document.getElementById(`reponse-${clé}`);
            if (!champ) throw new Error('Une réponse utilise une question absente de la structure. Sauvegarde désactivée.');
            champ.value = `${r.noÉquipe}:${r.noJoueur}`;
            if (!champ.value) throw new Error('Un répondant est absent de la liste des joueurs. Sauvegarde désactivée.');
            document.getElementById(`points-${clé}`).value = String(r.pointsSecondaires);
            if (!document.getElementById(`points-${clé}`).value) throw new Error('Un pointage enregistré ne correspond plus à la structure. Sauvegarde désactivée.');
        }
        document.getElementById('message-resultats').textContent = `Saison ${d.saison} — P${d.partie.noPartie}. Ouvrez une série pour corriger ses réponses.`;
        document.getElementById('sauver-resultats').style.display = 'inline-block';
    } catch (e) { if (génération === resultatChargement) document.getElementById('message-resultats').textContent = e.message; }
}
async function sauverResultats() {
    if (!resultatEdition) return;
    const d = resultatEdition;
    const réponses = [...document.querySelectorAll('.reponse-resultat')].filter(el => el.value).map(el => {
        const [noÉquipe, noJoueur] = el.value.split(':').map(Number);
        return { noPartie: d.partie.noPartie, noSérie: Number(el.dataset.serie), noQuestion: Number(el.dataset.question), noÉquipe, noJoueur, pointsSecondaires: document.getElementById(`points-${el.dataset.serie}-${el.dataset.question}`).value === 'true' };
    });
    const différence = [];
    for (const s of d.séries) for (const q of s.questions) {
        const même = r => r.noSérie === s.noSérie && r.noQuestion === q.noQuestion;
        const avant = d.réponses.find(même), après = réponses.find(même);
        const résumé = r => !r ? 'Non répondue' : `${r.noJoueur === 99 ? 'Équipe' : nomJoueurResultats(d.joueurs.find(j => j.noÉquipe === r.noÉquipe && j.noJoueur === r.noJoueur) || { noJoueur: r.noJoueur })} (${d.équipes.find(e => e.noÉquipe === r.noÉquipe)?.nomÉquipe}), ${r.pointsSecondaires ? q.pointsSecondaires : q.points} pts`;
        if (résumé(avant) !== résumé(après)) différence.push(`S${s.noSérie}-Q${q.noQuestion} : ${résumé(avant)} → ${résumé(après)}`);
    }
    if (!différence.length) { document.getElementById('message-resultats').textContent = 'Aucune modification.'; return; }
    if (!confirm(`Sauvegarder les corrections de P${d.partie.noPartie} (${d.saison}) ?\n\n${différence.join('\n')}\n\nUne sauvegarde des résultats précédents sera conservée.`)) return;
    const bouton = document.getElementById('sauver-resultats');
    bouton.disabled = true;
    document.getElementById('partie-resultats').disabled = true;
    try {
        const r = await requeteResultats(`/api/admin/resultats/${d.partie.noPartie}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ saison: d.saison, version: d.version, réponses }) });
        await chargerResultats();
        document.getElementById('message-resultats').textContent = `Corrections sauvegardées. Statistiques mises à jour. Sauvegarde : ${r.sauvegarde}.`;
    } catch (e) { document.getElementById('message-resultats').textContent = e.message; }
    finally { bouton.disabled = false; document.getElementById('partie-resultats').disabled = false; }
}
