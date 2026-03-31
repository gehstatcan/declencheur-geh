# Guide d'utilisation — Système GEH Statcan

## Gestion des fichiers

### Vue d'ensemble

Les données du système sont réparties dans `data/saisons/2025-2026/`. Le comportement de chaque fichier diffère selon qu'on est en **local** ou sur **Railway (production)**.

### Tableau des fichiers

| Fichier | Local | Railway (déploiement) | Rôle |
|---|---|---|---|
| `équipes.json` | Git | **Toujours écrasé** depuis git | Noms, couleurs, priorité d'égalité |
| `séries.json` | Git | Copié **seulement si absent** | Structure des types de séries et pointage — éditable via admin.html |
| `joueurs.json` | Git | **Toujours écrasé** depuis git | Liste des joueurs par équipe |
| `parties.json` | Ignoré par git | Copié **seulement si absent** | Calendrier, liens Teams, matchups éliminatoires |
| `thèmes.json` | Git | Copié **seulement si absent** | Thèmes et sous-thèmes par questionnaire |
| `questions.json` | Git | Copié **seulement si absent** | Textes et réponses des questions |
| `répondants.json` | Git (sauvegarde) | Copié **seulement si absent** | Qui a répondu à quoi — données accumulées en jeu |
| `alignements.json` | Git (sauvegarde) | Copié **seulement si absent** | Alignements des joueurs par partie |

> **Règle clé** : un déploiement Railway ne détruira jamais `répondants.json` ni `alignements.json` s'ils existent déjà sur le Volume. Les données de la saison sont protégées.

---

### Fichiers gérés par git (référentiels)

`équipes.json`, `séries.json`, `joueurs.json` sont les seuls fichiers **toujours remplacés** au déploiement. Pour les modifier en production, il suffit de les éditer localement et de faire un `git push`.

### Fichiers gérés via admin (calendrier et questionnaires)

`parties.json`, `thèmes.json` et `questions.json` sont importés via la page **admin.html**. Ils ne sont jamais écrasés au déploiement si déjà présents sur le Volume.

- `parties.json` est ignoré par git (calendrier peut contenir des liens privés Teams)
- `thèmes.json` et `questions.json` sont dans git comme référence locale

---

## Ajuster le volume des buzzers

Le volume des buzzers se règle directement dans **marqueur.html** via un curseur affiché dans la zone d'initialisation, avant de démarrer la partie.

- **0 %** = muet
- **100 %** = amplification par défaut (2× le volume système)
- **200 %** = amplification maximale

Deux boutons permettent de **tester le son de chaque équipe** une fois la partie sélectionnée, avant de la démarrer.

> À tester en salle — le rendu varie beaucoup selon les haut-parleurs et l'acoustique.

---

## Page d'administration (admin.html)

La page d'administration est accessible à `/admin.html`. Elle permet d'importer les deux types de fichiers qui alimentent le système.

### 📅 Importer le calendrier → `parties.json`

**Source** : fichier CSV ou Excel (colonnes requises ci-dessous)
**Effet** : remplace **entièrement** le calendrier existant sur le serveur

Colonnes requises dans le fichier :

| Colonne | Description |
|---|---|
| `NoPartie` | Numéro unique de la partie |
| `Date` | Date au format AAAA-MM-JJ |
| `Salle` | Salle ou lieu |
| `NomAnimateur` | Nom de l'animateur |
| `NoQuestionnaire` | Numéro du questionnaire utilisé |
| `NoÉquipeA` | Numéro de l'équipe A |
| `NoÉquipeB` | Numéro de l'équipe B |
| `NoÉquipeQuestionnaire` | Équipe qui a préparé le questionnaire |
| `LienReunion` | Lien Teams pour rejoindre la réunion |
| `Phase` | *(optionnel — éliminatoires seulement)* Valeur : `eliminations` |
| `Matchup` | *(optionnel — éliminatoires seulement)* Identifie le match dans le bracket : `Q1` (quart 2e vs 7e), `Q2` (quart 3e vs 6e), `Q3` (quart 4e vs 5e), `D1` (demi 1er + gagnant Q1), `D2` (demi gagnants Q2 et Q3), `F` (finale) |

---

### 📥 Importer un questionnaire → `thèmes.json` + `questions.json`

**Source** : fichier Excel avec une feuille nommée **Vers BD**
**Effet** : ajoute ou remplace le questionnaire correspondant dans les deux fichiers (par `noQuestionnaire`)

Le fichier Excel doit contenir deux tableaux :

**`tblThèmes`** — un thème par série :

| Colonne | Description |
|---|---|
| `NoQuestionnaire` | Numéro du questionnaire |
| `NoSérie` | Numéro de la série |
| `Thème` | Thème principal |
| `SousThème` | Sous-thème (optionnel) |

**`tblQuestionnaires`** — une question par ligne :

| Colonne | Description |
|---|---|
| `NoQuestionnaire` | Numéro du questionnaire |
| `NoSérie` | Numéro de la série |
| `NoQuestion` | Numéro de la question dans la série |
| `Question` | Texte de la question |
| `Réponse` | Réponse attendue |

> **Série 9 (Question à indices)** : Q1, Q2 et Q3 partagent la même réponse, mais par convention elle n'est inscrite qu'à Q3 dans le fichier Excel. Q1 et Q2 sans réponse sont donc normales — elles ne génèrent pas d'avertissement.
> **Série 13 (Choix d'associations)** : les lignes Q1 et Q2 contiennent les textes d'introduction des deux groupes (`questionGroupe1` / `questionGroupe2`). La feuille de match les affiche automatiquement comme en-têtes avant les questions 1–4 et 5–8.

### Données de jeu (répondants et alignements)

`répondants.json` et `alignements.json` sont générés en direct pendant les parties. Ils sont présents dans git comme **sauvegarde d'urgence** uniquement — la version authoritative est celle sur le Volume Railway.

> Pour récupérer les données de prod : se connecter via Railway CLI et copier les fichiers du Volume.

---

## Répondants — deux fichiers, deux rôles

### `parties/répondants-{N}.json` — fichier de travail en direct

Créé dès qu'un premier point est attribué durant la partie N. Chaque entrée représente une réponse attribuée :

```json
{ "noPartie": 36, "noSérie": 3, "noQuestion": 2, "noÉquipe": 4, "noJoueur": 2, "pointsSecondaires": false }
```

Ce fichier est mis à jour **en temps réel** tout au long de la partie :
- **Attribuer** → ajoute une entrée
- **Annuler** → supprime l'entrée (comme si la question n'avait jamais été répondue)
- **Écraser** (nouvelle réponse sur une question déjà répondue) → remplace l'entrée après confirmation du marqueur

C'est ce fichier qui alimente le score live affiché durant la partie. Il sert également à la **reprise automatique** : si le navigateur du marqueur plante ou est fermé par accident, la reconnexion recharge l'état de la partie depuis ce fichier (scores, série et question courantes).

---

### `répondants.json` — fichier cumulatif de la saison

Contient les répondants de **toutes les parties terminées**, triés par noPartie → noSérie → noQuestion.

Il est mis à jour **uniquement au moment de terminer une partie** (`terminerPartie`) :
1. Le serveur lit `répondants-{N}.json` (état final de la partie)
2. Retire toute entrée existante pour la partie N du cumulatif (évite les doublons)
3. Fusionne et trie
4. Écrase `répondants.json`

C'est ce fichier qui alimente toutes les pages de statistiques (classement, compteurs, feuille de match, profil joueur).

---

### Résumé

| | `répondants-{N}.json` | `répondants.json` |
|---|---|---|
| Mise à jour | En continu durant la partie | À la fin de la partie seulement |
| Portée | Une seule partie | Toute la saison |
| Usage | Score live, marqueur | Toutes les stats |
| Emplacement | `data/saisons/.../parties/` | `data/saisons/.../` |
| Ignoré par git | Oui (`data/saisons/*/parties/`) | Non (sauvegarde) |

---

### Réinitialisation du Volume (reset)

En cas de besoin, le script `init-volume.js` permet de réinitialiser le Volume depuis les fichiers git :

```bash
# Sans --force : copie seulement les fichiers absents (sécuritaire)
railway run node init-volume.js

# Avec --force : écrase TOUT depuis git (⚠️ détruit les données de jeu)
railway run node init-volume.js --force
```

> **Attention** : `--force` écrase `répondants.json` et `alignements.json`. À n'utiliser qu'en début de saison ou pour un reset complet.

---

## Pour développeurs

### Flux de déploiement : Local → GitHub → Railway

Chaque `git push` vers GitHub déclenche automatiquement un redéploiement sur Railway. Un redéploiement se produit à chaque push — pas besoin d'intervention manuelle.

```
LOCAL (PC)               GITHUB                    RAILWAY
─────────────────        ──────────────            ──────────────────────
c:\GIT\declencheur       gehstatcan/               gehstatcan.up
                         declencheur-geh           .railway.app

      │                        │                          │
      │  git push              │                          │
      ├───────────────────────>│                          │
      │                        │  déploiement auto        │
      │                        ├─────────────────────────>│
      │                        │    1. télécharge code    │
      │                        │    2. npm install        │
      │                        │    3. node index.js      │
      │                        │    4. initialiserVolume  │
```

### Le Volume Railway

Le Volume est un disque persistant attaché au serveur. Les données de jeu y sont conservées indépendamment des déploiements — un `git push` ne détruira jamais les données accumulées pendant la saison.

| Comportement | Fichiers |
|---|---|
| **Toujours écrasé depuis git** | `équipes.json`, `joueurs.json` |
| **Copié depuis git seulement si absent** | `séries.json`, `parties.json`, `thèmes.json` |
| **Jamais touché** | `répondants.json`, `alignements.json`, `questions.json`, `parties/répondants-*.json` |

### Cycle typique

```
1. Tu codes en local
         ↓
2. git push → GitHub
         ↓
3. Railway détecte le push → redéploie automatiquement
         ↓
4. initialiserVolume() s'exécute au démarrage :
   - équipes.json / joueurs.json  → TOUJOURS écrasés depuis git
   - séries.json / parties.json   → copiés seulement si absents du Volume
   - répondants.json              → jamais touché s'il existe déjà
```

**Résumé** : `git` = code + données de référence. `Volume` = données de jeu persistantes.

---

### Workflow séries en début de saison

`séries.json` est copié depuis git **seulement si absent** sur le Volume. Une fois la saison lancée, il est **verrouillé** dès qu'une première partie est jouée (l'éditeur dans admin.html le détecte automatiquement).

```
1. Modifier séries.json via admin.html
2. Sauvegarder (sauvegarde sur le serveur)
3. Télécharger le JSON → remplacer data/saisons/AAAA/séries.json en local
4. git push → mis à jour dans git pour la prochaine saison
```
