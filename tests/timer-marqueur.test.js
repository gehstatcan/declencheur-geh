const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../public/marqueur.html'), 'utf8');
function timer() {
  let maintenant = 0, identifiant = 0, sons = 0, resets = 0;
  const tâches = new Map();
  const éléments = { timerActif: { checked: true }, timerSecondes: { value: 5 }, timerAffichage: { textContent: '' } };
  const ctx = vm.createContext({ document: { getElementById: id => éléments[id] },
    setTimeout: (fn, délai) => { tâches.set(++identifiant, { fn, fin: maintenant + délai }); return identifiant; },
    clearTimeout: id => tâches.delete(id), setInterval: () => ++identifiant, clearInterval() {},
    jouerSonParId: () => sons++, socket: { emit: () => resets++ }, partieActuelle: 1 });
  const début = source.indexOf('        function toggleTimer()');
  const fin = source.indexOf('        // Navigation', début);
  vm.runInContext('let timerReset = null, timerInterval = null, timerModifié = false;\n' + source.slice(début, fin) + "\nfunction resetBuzz() { annulerTimer(); socket.emit('resetBuzz', partieActuelle); }", ctx);
  return { ctx, éléments, avancer(ms) { maintenant += ms; for (const [id, t] of [...tâches]) if (t.fin <= maintenant) { tâches.delete(id); t.fn(); } }, get sons() { return sons; }, get resets() { return resets; } };
}
test('passer de 5 à 13 secondes remplace le timer et produit un seul son', () => {
  const t = timer();
  t.ctx.démarrerTimer();
  t.éléments.timerSecondes.value = 13;
  t.ctx.modifierDélaiTimer();
  t.avancer(5000); assert.equal(t.sons, 0);
  t.avancer(8000); assert.equal(t.sons, 1); assert.equal(t.resets, 1);
  t.avancer(20000); assert.equal(t.sons, 1);
});
test('annuler ou désactiver le timer empêche le son et le reset tardifs', () => {
  for (const action of ['annulerTimer', 'toggleTimer']) {
    const t = timer(); t.ctx.démarrerTimer();
    t.éléments.timerActif.checked = false; t.ctx[action]();
    t.avancer(20000); assert.equal(t.sons, 0); assert.equal(t.resets, 0);
  }
});
