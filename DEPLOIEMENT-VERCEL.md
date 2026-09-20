# Mettre MonRelevé en ligne — Vercel + Supabase

Ce guide décrit exactement ce qui a été préparé dans le dépôt pour héberger l'application
sur **Vercel** (le site, les pages et l'API) avec sa base de données sur **Supabase** (PostgreSQL).

```
   Navigateur
       │
       ▼
   Vercel  ──────────  fonction Node (api/index.js)  ──────────  Supabase (PostgreSQL)
   site + API           même application Express                  base de données + sauvegardes
```

Rien n'est à réécrire : **la même application** tourne avec la base locale SQLite (pour travailler
sur votre ordinateur) ou avec PostgreSQL/Supabase (en ligne). Le choix se fait tout seul :
si `DATABASE_URL` est définie, l'application utilise PostgreSQL ; sinon elle utilise SQLite.

---

## Ce qu'il faut

| Prérequis | Détail | Carte bancaire |
|---|---|---|
| Compte **Supabase** | [supabase.com](https://supabase.com) — offre Free | non |
| Compte **Vercel** | [vercel.com](https://vercel.com) — plan Hobby (gratuit) | non |
| Compte **GitHub** | pour que Vercel lise le code (voir `CREER-LE-DEPOT.md`) | non |
| Node.js ≥ 20 | sur votre ordinateur, pour préparer la base | — |

---

## Étape 1 — Créer la base sur Supabase

1. Sur [supabase.com](https://supabase.com) → **New project**.
   Choisissez un nom (`monreleve`), un mot de passe de base de données (**notez-le**) et une région proche
   de vos utilisateurs (par exemple `eu-west-3` pour l'Europe de l'Ouest).
2. Attendez la fin de la préparation (une à deux minutes).
3. Dans **Project Settings → Database → Connection string**, copiez la chaîne **Session pooler**
   (elle ressemble à ceci) :

```
postgresql://postgres.abcdefghijkl:MOT_DE_PASSE@aws-0-eu-west-3.pooler.supabase.com:5432/postgres
```

> **Pourquoi le pooler ?** Vercel exécute plusieurs petites instances de l'application ; le pooler
> de Supabase mutualise les connexions et évite de saturer la base. L'application est déjà configurée
> pour une seule connexion par instance en mode sans serveur.

---

## Étape 2 — Créer les tables et les données de départ (depuis votre ordinateur)

Ces commandes s'exécutent **une seule fois**, depuis le dossier du projet
(`DATABASE_URL` sans guillemets autour de la chaîne, ou entre apostrophes si elle contient des caractères spéciaux) :

```bash
# 1) les tables (idempotent : peut être relancé sans risque)
DATABASE_URL='postgresql://…' npm run pg:schema

# 2) les données de départ : administrateur, filière, modèle L2 (lu depuis Relev-de-notes.xlsx), notes de démo
DATABASE_URL='postgresql://…' npm run pg:seed

# 3) vérification : nombre de lignes par table et compte administrateur
DATABASE_URL='postgresql://…' npm run pg:check
```

`pg:seed` n'écrase **jamais** une base qui contient déjà des comptes : il ne fait rien si un
utilisateur existe. Le seed crée l'administrateur `admin@univ.mg` / `admin123` et deux étudiants
de démonstration — **changez ce mot de passe après la première connexion** (Admin → Référentiels,
ou `npm run create-admin`).

### Générer la clé de session

Les jetons de connexion sont signés par une clé : elle doit être **identique sur toutes les
instances** (Vercel en démarre plusieurs). Elle se passe par la variable `SESSION_SECRET` :

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

---

## Étape 3 — Mettre le code sur GitHub

Vercel déploie à partir d'un dépôt Git. Si le dépôt n'existe pas encore :
**`CREER-LE-DEPOT.md`** décrit les trois façons de le créer (avec un jeton, depuis votre
ordinateur, ou par glisser-déposer). En résumé :

```bash
GITHUB_TOKEN=votre_jeton bash tools/github-publish.sh --name monreleve
```

---

## Étape 4 — Déployer sur Vercel

1. [vercel.com](https://vercel.com) → **Add New… → Project → Import Git Repository** → choisissez
   `monreleve`. (Autorisez Vercel à lire votre GitHub à la première fois.)
2. Vercel lit automatiquement `vercel.json`, qui contient déjà :
   * l'entrée sans serveur `api/index.js` (toute l'application Express) ;
   * l'installation des dépendances utiles (`express`, `pg`, `xlsx`, `pdfkit`…) sans le module
     natif SQLite, inutile en ligne ;
   * l'inclusion du classeur `Relev-de-notes.xlsx` et de la feuille `client/src/styles.css`
     dans la fonction.
3. Avant de cliquer sur **Deploy**, ouvrez **Environment Variables** et ajoutez :

| Nom | Valeur |
|---|---|
| `DATABASE_URL` | la chaîne de connexion Supabase de l'étape 1 |
| `SESSION_SECRET` | la chaîne aléatoire générée à l'étape 2 |

4. **Deploy**. Au bout d'une minute, Vercel donne l'adresse du site :
   `https://monreleve-xxxx.vercel.app`.

> L'application fonctionne aussi sans `DATABASE_URL` (elle créerait une base SQLite dans `/tmp`,
> perdue à chaque instance) : ne l'utilisez pas en ligne. Sans `SESSION_SECRET`, le démarrage
> s'arrête avec un message explicite plutôt que de créer des sessions qui ne survivraient pas.

---

## Étape 5 — Vérifier après la mise en ligne

1. Ouvrez l'adresse Vercel → la page de connexion s'affiche.
2. Connectez-vous avec `admin@univ.mg` / `admin123`… puis **changez ce mot de passe**.
3. Parcourez : Accueil (fil d'annonces), Relevé, Calendrier, Admin → Étudiants, Modèles,
   Référentiels, Import, Emploi du temps.
4. Créez un étudiant de test (Admin → Étudiants), connectez-vous avec son compte, saisissez une note.
5. Importez `Relev-de-notes.xlsx` (Admin → Import) : le classeur est reçu, puis relu **depuis la base**
   (aucun fichier n'est écrit sur un disque, qui n'existe pas chez Vercel).
6. Exportez un relevé PDF.

---

## Une remarque sur les dépendances

Le lecteur de classeurs Excel (`xlsx`) vient du dépôt officiel SheetJS
(`https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz`) et non du registre npm : c'est la version
maintenue, qui corrige deux avis de sécurité de la version npm. Le reste des dépendances est
ordinaire ; `npm audit --omit=dev --omit=optional` ne remonte **aucune vulnérabilité**.
`better-sqlite3` (moteur local) est *optionnel* : il n'est jamais installé en ligne, ce qui évite
toute compilation native.

---

## Essayer la configuration en ligne sans rien créer

Deux commandes suffisent pour vérifier que tout fonctionne avec la pile « Vercel + PostgreSQL »
sur votre ordinateur, sans compte Supabase :

```bash
# émulation locale de la fonction Vercel, avec un PostgreSQL embarqué (PGlite)
DB_DRIVER=pglite SESSION_SECRET=secret-local-0123456789 npm run vercel:local
# → http://localhost:4010
```

Avec une vraie base Supabase, la même commande s'utilise ainsi :

```bash
DATABASE_URL='postgresql://…' SESSION_SECRET=votre_cle npm run vercel:local
```

Et pour vérifier une instance en marche (63 contrôles : pages, API, import, PDF, permissions) :

```bash
npm run test:http                     # instance locale sur le port 4000
npm run test:http https://monreleve-xxxx.vercel.app
```

---

## Travailler en local (SQLite, inchangé)

```bash
npm install
npm run seed        # première fois : référentiels + modèle L2 + étudiants de démonstration
npm run serve       # http://localhost:4000
```

Aucune variable d'environnement n'est nécessaire : sans `DATABASE_URL`, la base est le fichier
`data/monreleve.db`. Les deux modes partagent exactement le même code d'application.

---

## Ce que la migration change concrètement

| Sujet | Local (SQLite) | En ligne (Vercel + Supabase) |
|---|---|---|
| Base de données | fichier `data/monreleve.db` | PostgreSQL chez Supabase |
| Accès aux données | `server/db.js`, façade asynchrone unique | idem — requêtes SQLite traduites automatiquement (`server/pgshim.js`) |
| Transactions | `tx(async () => …)` | idem |
| Fichiers importés | table `uploads` de la base | idem (plus aucun fichier sur disque) |
| Classeur Excel | lu depuis le dossier du projet | inclus dans la fonction (`vercel.json`) |
| Clé de session | fichier `data/secret.key` | variable `SESSION_SECRET` |
| Sauvegardes | `npm run backup` | automatiques côté Supabase (7 jours sur l'offre gratuite) |
| Écoute réseau | `server/index.js` | `api/index.js` (fonction sans serveur) |

Points de code utiles :
`server/db.js` (façade à deux pilotes) · `server/pgshim.js` (traduction SQLite → PostgreSQL) ·
`server/app.js` (application Express) · `api/index.js` (entrée Vercel) ·
`tools/db-setup.js` (préparation Supabase) · `tools/test-pg.js` (banc d'essai PostgreSQL) ·
`tools/test-http.js` (essai complet de l'application en marche).

---

## Offres gratuites : ce qu'il faut savoir

Vérifié en septembre 2026. **Aucune carte bancaire n'est demandée** pour Supabase Free ni pour
Vercel Hobby.

| | Supabase Free | Vercel Hobby |
|---|---|---|
| Prix | 0 € | 0 € |
| Base de données | 500 Mo, 2 projets actifs | — |
| Stockage de fichiers | 1 Go | 1 Go (Blob, non utilisé ici) |
| Trafic / invocations | 5 Go par mois | 100 Go, 1 million d'invocations |
| Limite notable | **projet mis en pause après 7 jours sans aucune requête** (réactivation en un clic dans le tableau de bord) | **usage personnel non commercial** ; fonction limitée à 60 s ; 4 h de processeur par mois |
| Sauvegardes | instantané de 7 jours | — |

Conséquences pratiques :

* une pause Supabase rend le site indisponible tant que le projet n'est pas réactivé ; un simple
  appel quotidien (par exemple une visite, ou un contrôle automatique de disponibilité) l'évite ;
* l'offre Hobby de Vercel est réservée aux projets **personnels, non commerciaux** — adapté à un
  usage pédagogique, mais pas à une application facturée ;
* la limite de 60 s par requête est largement suffisante : la page la plus lourde (relevé + calculs)
  répond en quelques dizaines de millisecondes, et le seed est déjà fait.

---

## Dépannage

| Message | Cause et solution |
|---|---|
| `SESSION_SECRET manquant` | La variable n'est pas définie dans Vercel → Settings → Environment Variables, puis redéployez. |
| `DATABASE_URL manquant` | Idem : vérifiez la valeur exacte copiée depuis Supabase. |
| `password authentication failed` | Mot de passe de base erroné dans la chaîne (les caractères spéciaux doivent être encodés : `@` → `%40`). |
| `getaddrinfo ENOTFOUND` / `ETIMEDOUT` | Chaîne incomplète (hôte ou port manquant) ou projet Supabase en pause. |
| `relation "users" does not exist` | Le schéma n'a pas été créé : relancez `DATABASE_URL='…' npm run pg:schema`. |
| Page figée / `504` | La fonction dépasse la limite de 60 s (rare) : vérifiez la connexion à la base, ou augmentez `maxDuration` dans `vercel.json`. |
| Le site redemande une connexion sans arrêt | `SESSION_SECRET` a changé entre deux déploiements : remettez toujours la même valeur. |
| Import Excel : « Fichier import introuvable » | Le classeur a été purgé (24 h) ou envoyé avant un redéploiement : ré-uploadez-le. |
| `403` sur `cdn.sheetjs.com` pendant l'installation | Le réseau de l'usine à déploiements bloque le domaine : remplacez la ligne `xlsx` du `package.json` par `"xlsx": "^0.18.5"` (version du registre npm, légèrement plus ancienne) le temps du déploiement. |
| `Base de données introuvable…` | Ni `DATABASE_URL` ni moteur local : sur Vercel, `DATABASE_URL` est indispensable (voir tableau). |

---

## Voir aussi

* `README.md` — prise en main de l'application, comptes, scripts.
* `CREER-LE-DEPOT.md` — créer le dépôt GitHub.
* `DEPLOIEMENT.md` — autres hébergements (Docker, VM, Render…) pour l'application ou la copie statique.
* `DEPLOIEMENT.md` § « copie statique » / `site-html/` — version sans base de données (GitHub Pages).
