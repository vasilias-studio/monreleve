# Créer le dépôt GitHub de MonRelevé

Le dépôt est **déjà construit, committé et prêt à pousser** :

| | |
|---|---|
| Commit | `a9871fa` — « MonRelevé v2 — application de notes (site HTML serveur + console admin) » |
| Branche | `main` |
| Contenu | **78 fichiers**, 1,2 Mo (code serveur, client, outils, Dockerfile, `render.yaml`, workflow Pages, docs) |
| Exclus | `node_modules/`, la base SQLite et `secret.key`, `site-html/`, les archives (régénérés) |
| Contrôle | aucun jeton de session dans les fichiers, rien de sensible dans le commit |

> Ce qui bloque : GitHub n'accepte aucune écriture sans **ton** autorisation. Cet environnement
> n'a ni jeton, ni clé SSH, ni compte connecté — c'est volontaire (aucun identifiant n'est
> stocké). Choisis l'une des trois voies ci-dessous, la plus courte est la première.

---

## Voie 1 — Le plus rapide : tu me donnes un jeton (2 minutes)

1. Ouvre ce lien (portées déjà cochées : `repo` + `workflow`) :

   **https://github.com/settings/tokens/new?scopes=repo,workflow&description=MonReleve**

2. Clique **Generate token**, copie le jeton (`ghp_…`), colle-le moi dans la conversation.
3. Je lance : `GITHUB_TOKEN=… bash tools/github-publish.sh`
   → création du dépôt, envoi des 78 fichiers, commit réattribué à ton compte, et je te rends l'URL.
4. **Ensuite : révoque le jeton** (https://github.com/settings/tokens) — il n'est utilisé que
   pour cette opération, il n'est jamais écrit sur le disque.

Le jeton sert à : créer le dépôt (`repo`) et envoyer le fichier
`.github/workflows/site-statique.yml` qui publiera le site (`workflow`).

---

## Voie 2 — Tu lances la commande toi-même (le jeton ne quitte pas ton ordinateur)

1. Télécharge **`monreleve-depot-git.zip`** (l'archive contient le dépôt *avec son historique*),
   puis décompresse-la.
2. Dans le dossier obtenu :

   ```bash
   GITHUB_TOKEN=ghp_ton_jeton bash tools/github-publish.sh
   ```

   (options : `--name mon-releve`, `--private`, `--dry-run` pour vérifier sans rien créer)

3. Le script affiche l'URL du dépôt à la fin. Reviens me la donner : je vérifie la publication
   et j'enchaîne sur l'hébergement (Render / GitHub Pages).

---

## Voie 3 — 100 % dans le navigateur, sans ligne de commande

1. https://github.com/new → nom **monreleve** → **Public** → *Create repository*
   (ne coche ni README ni .gitignore).
2. Sur la page du dépôt vide : **uploading an existing file**.
3. Télécharge **`monreleve-site.zip`**, décompresse-le, puis **glisse les dossiers**
   (`server`, `client`, `tools`, `deploy`, `.github`) et les fichiers de la racine
   (`package.json`, `README.md`, `DEPLOIEMENT.md`, `Dockerfile`, `render.yaml`, `Relev-de-notes.xlsx`…)
   dans la zone d'envoi, puis **Commit changes**.
   Le dossier `.github` en glisser-déposer est accepté par l'interface web.
4. Reviens me donner l'URL : je vérifie que tout est bien en place.

---

## Après la création du dépôt

| Étape | Où | Détail |
|---|---|---|
| Publier le site statique | dépôt → **Settings → Pages** → Source = *GitHub Actions* | le workflow fourni régénère `site-html/` et le publie à chaque push |
| Héberger l'application | **Render → New → Blueprint** en pointant ce dépôt | `render.yaml` est déjà prêt (plan gratuit, veille 15 min, base remise à zéro) |
| Application réellement durable | **Northflank** ou **Oracle Cloud** | voir `DEPLOIEMENT.md` §5 (volume persistant / VM + HTTPS Caddy) |

Rappel avant toute mise en ligne publique : changer `admin@univ.mg / admin123`
(`npm run create-admin -- --email vous@univ.mg --password '…'`).
