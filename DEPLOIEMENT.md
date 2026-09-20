> **Pour l'application en ligne, la cible retenue est Vercel + Supabase** :
> voir **[DEPLOIEMENT-VERCEL.md](DEPLOIEMENT-VERCEL.md)**. Le présent document décrit les autres
> possibilités (application Docker/VM, copie statique sans base) ; il reste valable pour la
> **copie statique** publiée sur GitHub Pages.

# Hébergement gratuit — MonRelevé (application) et le site

Document de proposition, avec les fichiers de déploiement déjà prêts dans le dépôt.
Tout ce qui suit a été vérifié depuis cet environnement le 19/09/2026 : démarrage en mode
production, variables d'environnement, empreinte mémoire, accès réseau aux plateformes.

---

## 1. Ce que l'application exige (constat mesuré, pas une estimation)

| Élément | Valeur | Conséquence pour l'hébergeur |
|---|---|---|
| Runtime | **Node.js ≥ 20** (ESM) | toute plateforme Node récente convient |
| Mémoire | **≈ 100 Mo** au repos, 512 Mo suffisent largement | le plan gratuit 512 Mo de Render passe |
| Réponse | **8 ms** sur `/login` (serveur local) | le temps de réponse dépendra surtout de la latence réseau |
| Dépendances de production | express, better-sqlite3, pdfkit, multer, xlsx, bcryptjs, jsonwebtoken | `better-sqlite3` est **natif** (compilé ou précompilé) |
| **Écritures disque** | `DATA_DIR` = **base SQLite** + `secret.key` + `uploads/` | **c'est le point critique** : il faut un disque qui persiste |
| Taille des données | 168 Ko pour la base de démo | un volume de 0,5 à 1 Go est très large |
| Taille du code | ~1 Mo hors `node_modules` | aucun problème |
| Site statique | `site-html/` = 22 fichiers, ~1 Mo | hébergeable partout, sans serveur |

> **La règle d'or** : tout hébergeur dont le disque est **éphémère** perdra les notes saisies
> à chaque redéploiement (la base repart du seed de démonstration). C'est acceptable pour
> montrer le design, pas pour l'utiliser avec de vrais étudiants. D'où les deux familles
> ci-dessous : *plateformes avec volume persistant* et *plateformes éphémères*.

---

## 2. Comparatif — héberger l'application (offres gratuites)

| Plateforme | Serveur permanent ? | Disque persistant | Carte demandée | Remarques | Verdict |
|---|---|---|---|---|---|
| **Northflank** (plan Developer) | **oui, sans mise en veille** | **oui, 0,5 Go** | oui (vérification) | 2 services, 1 vCPU, 1 Go RAM, déploiement Git ou image Docker | **★ meilleur choix pour l'app réelle** |
| **Oracle Cloud Always Free** | oui | **oui, 200 Go de stockage bloc** | oui | VM réelle (2 OCPU / 12 Go ARM pour un compte gratuit récent ; 4/24 pour les comptes plus anciens ou en paiement à l'usage), 10 To de trafic/mois. Ouverture de compte parfois lente, capacité ARM parfois indisponible selon la région | **★ meilleur « gratuit pour toujours »**, mais c'est de l'administration système |
| **Render** (plan free) | non : **veille après 15 min**, réveil ≈ 1 min | **non** | non | 750 h/mois, 512 Mo. Base remise à zéro à chaque déploiement | **★ le plus simple pour une démo** |
| **Koyeb** (instance Eco) | non : scale-to-zero | non | oui | 1 service, réveil à la demande, pas de plafond mensuel d'heures | bon repli |
| **Railway** | oui | sur volume payant | non | plus de plan gratuit : ~1 $ de crédit/mois après l'essai | à éviter pour du permanent |
| **Fly.io** | oui | volume facturé au-delà | oui | les allocations gratuites d'origine ne sont **plus proposées aux nouveaux comptes** | non |
| **Google Cloud Run** | non : scale-to-zero | non (sans GCS) | oui | 2 M de requêtes/mois, conteneur Docker ; système de fichiers éphémère | non pour SQLite |
| **Cloudflare Workers + D1** | non (edge) | oui, mais **D1** | non | généreux et rapide, mais le code devrait être réécrit (pas d'API Node `fs`, pas de `better-sqlite3`) | sur mesure, hors périmètre |
| **Glitch** | — | — | — | **service arrêté** : ne plus le considérer | non |

**Turso** (base SQLite en ligne, plan gratuit : ~1 à 5 Go, plusieurs bases, 500 M de lignes
lues/mois) mérite une mention : en remplaçant `better-sqlite3` par `@libsql/client`, l'app
n'aurait plus besoin de disque et deviendrait déployable sur les plateformes **éphémères**
(Render/Koyeb) avec des données durables. C'est une modification de code réelle (≈ quelques
fichiers : `server/db.js` et les requêtes synchrones), que je peux faire sur demande.

---

## 3. Comparatif — héberger le site statique (`site-html/`)

| Plateforme | Gratuit | HTTPS | Mise en ligne | Remarque |
|---|---|---|---|---|
| **GitHub Pages** | oui | oui | **automatique** (le workflow fourni régénère puis publie) | URL `https://<compte>.github.io/<dépôt>/` |
| **Cloudflare Pages** | oui, bande passante illimitée | oui | glisser-déposer ou Git | meilleur choix pour un nom de domaine à soi |
| **Netlify** | oui (crédits mensuels) | oui | glisser-déposer du dossier | pratique pour une mise en ligne en 1 minute |
| **Render Static** | oui, illimité | oui | via le `render.yaml` fourni (bloc commenté) | même compte que l'application |
| **Surge.sh** | oui | oui | `npx surge site-html` | ligne de commande, très rapide |

Rappel important : le site exporté porte le bandeau **« Copie statique — consultation seule »**
(les formulaires n'ont pas de serveur derrière). C'est volontaire : il ne peut pas remplacer
l'application, il la présente.

---

## 4. Ce à quoi j'ai accès depuis cet environnement (testé maintenant)

| Ressource | Résultat |
|---|---|
| `api.github.com` · `api.netlify.com` · `api.render.com` · `api.northflank.com` · `app.koyeb.com` · `api.vercel.com` · `api.turso.tech` | **joignables** (réponses 401/403 = il ne manque que ton jeton) |
| `git`, `ssh`, `curl`, `npm`, `npx` | présents |
| `docker` | **absent** : je ne peux pas construire l'image ici, mais je peux la faire construire par la plateforme (Northflank/Render le font) |
| Démarrage en mode production | **vérifié** : `PORT=4100 DATA_DIR=/tmp/… npm start` → seed automatique, `/login` en 200, `/accueil` en 302 sans session |
| Sauvegarde de la base | **vérifiée** : `npm run backup` → `data/backups/monreleve-<horodatage>.db` (168 Ko), rotation automatique |

**En pratique, je peux donc** : pousser le dépôt sur GitHub, lancer un déploiement Render/
Northflank, publier le site sur GitHub Pages ou Cloudflare Pages, régénérer et redéployer à
chaque modification, et surveiller les journaux — **à condition que tu me fournisses un jeton
d'API** (ou que tu cliques sur les boutons, je te guide pas à pas).

⚠ Deux précautions : un jeton ne doit jamais être committé, et il ne survit pas à la
sauvegarde de l'espace de travail (les fichiers d'identifiants en sont exclus) : il faudra
me le redonner à chaque session de publication, ou mieux, le stocker dans les **variables
d'environnement du service** chez l'hébergeur.

---

## 5. Trois chemins, du plus simple au plus durable

### A. Démo publique en 5 minutes — Render (sans carte bancaire)
1. Créer le dépôt : `git init && git add -A && git commit -m "MonRelevé"`, puis pousser sur GitHub.
2. Render → **New → Blueprint** → choisir le dépôt : `render.yaml` est déjà écrit (plan gratuit,
   `npm ci`, `npm start`, contrôle de santé `/login`).
3. C'est en ligne. **Mais** : mise en veille après 15 min, et **base remise à zéro à chaque
   redéploiement** (démo uniquement).
4. Site statique : même dépôt → **New → Static Site**, ou Netlify par glisser-déposer du
   dossier `site-html/`.

### B. Application réellement utilisable — Northflank (carte pour vérifier l'identité)
1. Pousser le dépôt sur GitHub (ou envoyer l'image).
2. Northflank → **Create service** → « Combined » : build Docker (`Dockerfile` fourni),
   port **4000**, **volume persistant de 0,5 Go monté sur `/data`**, variable `DATA_DIR=/data`.
3. Aucune veille : l'app répond instantanément, la base survit aux mises à jour.
4. Sauvegarde : `npm run backup` via une tâche planifiée Northflank (cron), vers `/data/backups`.

### C. Gratuit pour toujours et maître chez soi — Oracle Cloud Always Free
1. Créer un compte Oracle (carte demandée, non débitée), créer une VM **Ampere A1 (ARM)** —
   Ubuntu 22.04/24.04, 2 OCPU / 12 Go (limite des comptes gratuits récents).
2. Ouvrir le port 80 (et 443) dans la liste de sécurité du réseau virtuel.
3. Copier le dossier du projet sur la VM, puis : `sudo bash deploy/install-vm.sh`
   → installe Node 20, crée l'utilisateur, l'application dans `/opt/monreleve`, les données
   dans `/var/lib/monreleve`, le service **systemd** (redémarrage automatique) et la
   **sauvegarde quotidienne**.
4. HTTPS avec un nom de domaine : `cd deploy && DOMAIN=notes.mon-universite.mg docker compose up -d`
   (Caddy obtient le certificat tout seul). Sans domaine : accès direct par `http://<ip>:4000`.
5. Mise à jour : recopier le code et rejouer `install-vm.sh` — la base n'est jamais touchée.

---

## 6. Fichiers prêts dans le dépôt

| Fichier | Rôle |
|---|---|
| `Dockerfile` + `.dockerignore` | image de production (Node 20, volume `/data`, contrôle de santé) |
| `render.yaml` | déploiement Render en un clic (avec le bloc disque persistant en commentaire) |
| `.github/workflows/site-statique.yml` | régénère `site-html/` et le publie sur GitHub Pages à chaque `push` |
| `deploy/docker-compose.yml` + `deploy/Caddyfile` | VM : application + HTTPS automatique |
| `deploy/install-vm.sh` | installation complète sur VM vierge (idempotent) |
| `deploy/monreleve.service` | service systemd (installation sans Docker) |
| `tools/backup.js` (`npm run backup`) | sauvegarde à chaud de SQLite + rotation |
| `DEPLOIEMENT.md` | ce document |

---

## 7. Points de vigilance

- **La base est l'unique chose précieuse** : sauvegarder `DATA_DIR` (ou au minimum
  `monreleve.db`) suffit à tout restaurer — identités, notes, annonces, emploi du temps.
- **Mots de passe de démonstration** : `admin@univ.mg / admin123` doit être changé
  (`npm run create-admin -- --email … --password …`) avant toute mise en ligne publique.
- **HTTPS** : indispensable dès qu'on saisit de vrais mots de passe. Caddy (VM) ou la
  plateforme (Render/Northflank/Pages) le fournissent gratuitement.
- **`xlsx@0.18.5`** (import Excel) est l'ancienne distribution npm : sans incidence sur
  l'hébergement, mais à mettre à jour depuis le registre SheetJS si l'import devient critique.
- **Veille des plateformes** : les plans gratuits changent souvent (Fly.io et Railway les ont
  supprimés en 2025-2026, Render les a réduits). Ce document reflète l'état de septembre 2026.
