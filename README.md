# MonRelevé

**Site web complet** de gestion et suivi des notes universitaires — espace étudiant + vraie console
d'administration. **v2 : l'application est désormais un site HTML rendu 100 % côté serveur**
(liens + formulaires, *zéro* JavaScript applicatif, *zéro* build front) — tout ce qui faisait
fonctionner la version mobile est conservé : vraie base relationnelle SQLite, authentification,
autorisations serveur, modèles configurables, import/export Excel, publication/verrouillage.

Le modèle **L2 — Gestion** est généré automatiquement à partir du fichier `Relevé de notes.xlsx`
fourni (semestres, UE, matières, crédits, règles de calcul).

---

## 0. Mise en ligne

**Vercel (application) + Supabase (base de données)** : configuration prête dans le dépôt —
`vercel.json`, `api/index.js` (fonction sans serveur), `server/pgshim.js` (traduction des requêtes
vers PostgreSQL) et `tools/db-setup.js` (création du schéma et des données de départ).
Procédure pas à pas, variables d'environnement et dépannage :
**[DEPLOIEMENT-VERCEL.md](DEPLOIEMENT-VERCEL.md)**.

La même application tourne **sans aucune modification** en local avec SQLite :

```bash
npm install && npm run serve          # base SQLite dans data/
npm run vercel:local                  # émulation de la fonction Vercel (PostgreSQL embarqué)
```

Autres hébergements gratuits (Docker, VM Oracle/VPS avec `deploy/install-vm.sh`, Render,
site statique sur GitHub Pages) et comparatif des offres : **[DEPLOIEMENT.md](DEPLOIEMENT.md)**.

---

## 1. Démarrage rapide

```bash
npm install            # dépendances serveur (express, JWT, bcrypt, xlsx, multer, pdfkit, pg)
npm run serve          # → http://localhost:4000  (site HTML + API, port unique)
```

`better-sqlite3` (base locale) est une dépendance *optionnelle* : elle est installée
automatiquement en local, et ignorée lors d'un déploiement PostgreSQL
(`npm install --omit=optional`), ce qui évite toute compilation native en ligne.
Le lecteur Excel (`xlsx` 0.20.3) vient du dépôt officiel SheetJS : c'est la version maintenue
(la version du registre npm porte deux avis de sécurité). `npm audit --omit=dev` : 0 vulnérabilité.

C'est tout : pas de build, pas de Vite. **Si la base est vide, le serveur la crée et la remplit
automatiquement** (référentiels + modèle L2 issu de l'Excel + comptes de démo).
Réinitialiser à la main : `npm run seed` (ou `npm run seed -- --reset` ⚠️ efface tout).

```bash
npm run dev            # idem (node server/index.js)
```

### Créer le premier compte administrateur

```bash
npm run create-admin -- --email you@univ.mg --password "MotDePasseSolide!" --name "Scolarité FEG"
```

Comptes de démonstration (créés par le seed s'ils absents) :

| Rôle      | Identifiants                          |
|-----------|---------------------------------------|
| Admin     | `admin@univ.mg` / `admin123`          |
| Étudiante | `naina.randria@example.mg` / `etudiant123` (notes perso + officiel S3 publié) |
| Étudiant  | `tojo.hanta@example.mg` / `etudiant123` (notes perso uniquement) |

> ⚠️ Changez ces mots de passe avant toute utilisation réelle.
> Sur la page de connexion, l'appairage cookie fonctionne normalement ; dans les environnements
> qui bloquent les cookies (aperçus en iframe sandboxée, certains navigateurs stricts), le
> serveur s'appuie automatiquement sur le paramètre `?t=` (jeton) ajouté à chaque lien —
> c'est transparent pour l'utilisateur.

---

### Export du relevé en PDF (une page)

`GET /mon-releve.pdf?source=personal|official` — A4 portrait, générée côté serveur (pdfkit) avec les
mêmes calculs que l'application (moteur `compute.js`) : en-tête étudiant, tableaux par semestre,
moyennes/UE/crédits, total en pied de page, date et bloc signature. La taille des lignes s'ajuste
automatiquement pour que **tout tienne sur une seule page**, quel que soit le volume du modèle.
Côté admin : `GET /admin/fichiers/releve/:id.pdf` (tous accès). Les boutons de l'interface pointent
désormais vers le PDF ; l'Excel (`/mon-releve.xlsx`) reste disponible pour la reprise de données.

## 2. Ce qui a été extrait du fichier Excel fourni

`Relevé de notes.xlsx` (feuille « Feuil2 ») → modèle **L2 — Gestion — 2026-2027** :

- **2 semestres** : S3 (UE 9→12, 15 matières, 29 crédits) · S4 (UE 13→15, 14 matières, 26 crédits)
- Les **crédits** étaient cachés dans les formules `=IF(note>=10, 2, "-")` → extraits (2 ou 1 crédit/matière)
- **Note définitive** = `MAX(Normale, Rattrapage)`, « — » sans note, rattrapage **non plafonné**
- **Moyenne d'UE** = moyenne arithmétique des notes définitives (le fichier ne contenait pas de
  coefficients → coefficient = 1 par défaut, **modifiable** matière par matière)
- **Moyenne de semestre** = moyenne des moyennes d'UE (formule `AVERAGE(C16,C20,C25,C30)`)
- **Crédits acquis** = si **NOTE NORMALE ≥ 10** (particularité des formules `=IF(C…>=10,…)` du fichier)
- **Statut matière** = basé sur la note définitive (ex. du cahier des charges : normale 8,5 +
  rattrapage 11 → **Validé**), indépendamment de la règle de crédits ci-dessus.

Chacune de ces règles est **stockée dans la base** (`templates.rules_json`) et éditable par
l'administrateur (écran *Règles de calcul* d'un modèle). Rien n'est codé en dur dans les écrans :
toute donnée ambiguë du fichier est devenue une **option configurable** (jamais une règle inventée) :

| Réglage | Valeurs | Défaut (= Excel) |
|---|---|---|
| `final_grade_rule` | max(N,R) / R remplace N / pondérée | max(N, R) |
| `rattrapage_cap` | plafond après rattrapage | aucun |
| `ue_average_method` | simple / pondérée par coefficients | simple |
| `semester_average_method` | moyenne des UE / pondérée crédits / pondérée coefficients | moyenne des UE |
| `general_average_method` | moyenne des semestres / pondérée crédits | moyenne des semestres |
| `credit_validation_basis` | note normale / note définitive | **note normale** (comme le fichier) |
| `pass_threshold` | seuil de validation | 10 |

---

## 3. Architecture (site HTML rendu serveur)

```
├── server/
│   ├── index.js             Express : site HTML + API REST + seed auto + gestion d'erreurs
│   ├── db.js                schéma SQLite (better-sqlite3, transactions, FK)
│   ├── auth.js              JWT, bcrypt, middlewares de rôle — autorisations SERVEUR
│   ├── compute.js         moteur de calcul (moyennes UE/semestre/générale, crédits, statuts)
│   ├── releveParser.js      analyse des fichiers Excel (format « relevé » ou table plate)
│   ├── seed.js              configuration initiale depuis le fichier Excel fourni
│   ├── createAdmin.js       CLI de création du premier administrateur
│   ├── html/
│   │   ├── layout.js        gabarit de page + composants (thème clair/sombre rendu côté serveur)
│   │   └── site.js          TOUTES les pages & actions HTML (formulaires GET/POST)
│   └── routes/              API REST JSON (conservée : mobile/PWA/intégrations)
│       ├── auth.js  student.js  admin.js  importExport.js
├── client/                  (héritage) ancienne PWA React — n'est plus construite ni servie ;
│                            le code source reste disponible, l'API JSON est identique
└── data/                    monreleve.db (créée au seed), uploads, secret.key
```

### Parcours du site

- **Public** : `/` → `/login`, `/register`, `/forgot`, `/reset` (liens et formulaires classiques).
- **Étudiant** : `/accueil` (tableau de bord : moyenne, crédits, statuts par semestre),
  `/saisie` (saisie par semestre, tout un tableau → un seul bouton), `/releve` (section unique :
  bascule *Mes notes* / *Résultats officiels* + tables par semestre + « Moyennes & progression » ;
  `/moyennes` y redirige), `/calendrier` (emploi du temps hebdomadaire de la classe, par semestre),
  `/profil` (identité, scolarité, mot de passe — accessible par l'avatar en haut de page),
  `/mon-releve.pdf` (relevé **PDF sur une seule page A4**, S3+S4, mise en page éditoriale, garde-fou : le source « officiel » n'existe que publié ; l'export `.xlsx` reste disponible par URL pour l'interop). Thème clair/sombre via icône SVG — choix persisté en cookie `mrt_theme` (aucun localStorage requis).
- **Admin** : `/admin` (statistiques), `/admin/etudiants` (recherche, création, fiche complète :
  scolarité, compte, réinitialisation du mot de passe, suppression avec case à cocher, notes
  officielles par semestre verrouillé, exports xlsx), `/admin/modeles` (création, structure
  semestres/UE/matières modifiable en place, coefficients et crédits, **règles de calcul**),
  publication **publier → verrouiller → déverrouiller → brouillon** par semestre,
  `/admin/import` (voir § 4), `/admin/referentiels` (années — dont « année courante » —, filières,
  niveaux, établissements, classes), exports CSV.
  `/admin/emploi` (emploi du temps par classe × semestre : ajout/suppression de créneaux).

### Base de données (relationnelle, évolutive)

`institutions → programs (filières) → levels (niveaux) → academic_years → classes`
`templates (modèles : filière+niveau+année, UNIQUE) → semesters → units (UE) → courses (coefficient, crédits)`
`users → students / admins` · `grades (source = personal | official)` · `publications (draft/published/locked + snapshot)` · `imports (journal)`

Ajouter L4, M1, une filière, une année, un établissement = **données**, pas du code (écran *Référentiels*).

### Notes personnelles vs officielles

- `grades.source='personal'` : brouillon de l'étudiant (« Mes notes »), toujours modifiable par lui seul.
- `grades.source='official'` : saisi/importé/corrigé par l'administration, **lecture seule** pour l'étudiant.
- `publications` par semestre : `draft` (invisible) → `published` (visible, corrigible) → `locked`
  (le serveur refuse toute correction, y compris admin, tant que déverrouillé non).

### Sécurité

- Mots de passe **bcrypt** ; sessions **JWT signées** (secret aléatoire dans `data/secret.key`).
- **Chaque page et chaque action HTML vérifie le rôle côté serveur** ; les routes étudiantes sont
  scopées sur `student_id` dérivé du token (impossible de lire/écrire la fiche d'un autre étudiant
  ou une matière hors de son modèle — vérifié par tests 302/401/403/409).
- Toute sortie HTML est échappée (`esc()`) ; requêtes préparées (pas d'injection SQL) ;
  validation serveur des notes (0–20, virgule acceptée).
- Anti-énumération sur « mot de passe oublié » ; jeton de reset limité à 1 h.
- Import : écriture uniquement après **case à cocher de confirmation**, conflits signalés en aperçu.

---

## 4. Import Excel (jamais d'écrasement silencieux)

Étapes, toutes en formulaires HTML sans JS :

1. **Téléverser** `.xlsx/.xls` (12 Mo max) → le classeur est rangé dans la table `uploads` de la base
   (aucun fichier sur disque : c'est ce qui permet le déploiement sans serveur, puis purgé après 24 h).
2. **Choisir** : feuille, mode — *structure de relevé* (type `Relevé de notes.xlsx`) ou
   *notes plates* —, modèle cible, et pour le mode notes, le **mapping des colonnes**
   (Matrice → matricule, Matière, Note, Rattrapage, Coefficient, Crédits ; suggestions automatiques).
3. **Analyser** → aperçu complet : nombre de semestres/UE/matières ou lignes rapprochées,
   lignes **sans correspondance**, et conflits (« le modèle contient déjà X semestres »,
   « N note(s) existent déjà ») — **aucune écriture**.
4. **Confirmer** : stratégie conflit *écraser* ou *ignorer* + case « Je confirme l'écriture en base » ;
   sans case cochée → refus. Chaque import est tracé dans le **journal** (écran, table `imports`).

## 5. Scripts

| Commande | Effet |
|---|---|
| `npm run serve` | site + API sur http://localhost:4000 (auto-seed si base vide) |
| `npm run seed` / `-- --reset` | (re)créer la structure depuis l'Excel fourni |
| `npm run create-admin -- …` | premier compte administrateur |
| `npm run backup` | sauvegarde à chaud de la base SQLite (`data/backups`, 14 conservées) |
| `npm run test:pg` | 25 contrôles de la couche PostgreSQL (moteur PostgreSQL embarqué, sans réseau) |
| `npm run test:http` | 63 contrôles de l'application en marche (pages, API, import Excel, PDF, permissions) |
| `npm run vercel:local` | émulation locale de la fonction Vercel (avec PostgreSQL embarqué) |
| `npm run pg:schema` / `pg:seed` / `pg:check` | préparation d'une base Supabase (depuis le poste) |
| `PORT=8080 npm run serve` | changer de port |
| `MAIL_DEMO=0` | désactive le renvoi du lien de reset à l'écran (brancher SMTP alors) |

Variables d'environnement : voir `.env.example` (`DATABASE_URL`, `SESSION_SECRET`, `DB_DRIVER`,
`UPLOAD_MAX_MB`…).

## 6. Vers la production

- **PostgreSQL (Supabase) : fait.** La base est choisie par `DATABASE_URL` ; le schéma est engendré
  automatiquement depuis la description SQLite (`server/pgshim.js`) et le comportement vérifié sur un
  vrai moteur PostgreSQL (`npm run test:pg`, 25 contrôles). Procédure : `DEPLOIEMENT-VERCEL.md`.
- **Sans serveur : fait.** `api/index.js` expose la même application à Vercel ; les classeurs importés
  vivent dans la base, et la clé de session passe par `SESSION_SECRET` (pas de disque partagé).
- **SMTP** : brancher l'envoi réel du lien de réinitialisation (`// MAIL HOOK` dans `server/routes/auth.js`).
- **HTTPS** derrière un reverse proxy (Caddy/Nginx) : `deploy/docker-compose.yml` fournit déjà
  l'automatisme. En ligne, le cookie httpOnly suffit ; le mode `?t=` n'est qu'une commodité d'aperçu.
- **Sécurité** : changez le mot de passe `admin123` après la mise en ligne, et définissez
  `SESSION_SECRET` avec une valeur propre à votre installation.
- La **PWA mobile** (dossier `client/`) reste utilisable : réinstaller vite/react en devDependencies,
  `npx vite build`, la même API JSON sert les deux interfaces. Capacitor inchangé (`--web-dir dist`).
