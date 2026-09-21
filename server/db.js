/**
 * db.js — faîte d'accès aux données, avec DEUX pilotes interchangeables :
 *
 *   · sqlite    (better-sqlite3) — développement local, VM Oracle/VPS : fichier unique, zéro configuration
 *   · postgres  (pg)             — Supabase, pour l'hébergement serverless (Vercel), où aucun disque ne persiste
 *   · pglite    (tests)          — PostgreSQL embarqué (WASM), pour vérifier les requêtes sans réseau
 *
 * Le choix se fait par l'environnement :
 *   DATABASE_URL=postgres://…   → postgres      (c'est ce que fournit Supabase)
 *   DB_DRIVER=pglite            → pglite        (tests)
 *   sinon                       → sqlite        (par défaut)
 *
 * L'API est ASYNCHRONE et garde la forme d'origine (`db.prepare(sql).get/all/run`),
 * ce qui n'oblige pas à réécrire les ~300 requêtes : seul un `await` est ajouté aux
 * points d'appel. Le dialecte SQLite → PostgreSQL est traduit dans pgshim.js.
 *
 * Transactions : `tx(async () => { … })`. Les requêtes exécutées à l'intérieur sont
 * automatiquement rattachées à la transaction (AsyncLocalStorage), y compris depuis
 * des fonctions appelées en profondeur.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AsyncLocalStorage } from 'node:async_hooks';
import { toPostgres, postgresSchema, installTypeParsers, TYPE_PARSERS } from './pgshim.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
/* Sur Vercel (ou tout hôte sans disque), DATA_DIR n'est pas durable : on n'écrit
 * rien d'important sur le disque (la base est sur Supabase). On évite donc de créer
 * des dossiers inutiles quand on tourne en Postgres sans besoin local. */
export const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, 'monreleve.db');
export const DRIVER = (process.env.DB_DRIVER
  || (process.env.DATABASE_URL ? 'postgres' : 'sqlite')).toLowerCase();

if (DRIVER !== 'postgres' || process.env.DATA_DIR) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(path.join(DATA_DIR, 'uploads'), { recursive: true });
}

/* ------------------------------------------------------------------ */
/* Schéma : une seule source (DDL SQLite), déclinée pour PostgreSQL     */
/* ------------------------------------------------------------------ */
export const SQLITE_DDL = `
CREATE TABLE IF NOT EXISTS institutions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  code TEXT UNIQUE,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS programs (            -- filières
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  institution_id INTEGER REFERENCES institutions(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  code TEXT,
  active INTEGER DEFAULT 1,
  UNIQUE(institution_id, name)
);

CREATE TABLE IF NOT EXISTS levels (              -- niveaux (L1, L2, L3, M1…)
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  cycle TEXT DEFAULT 'Licence',
  ord INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS academic_years (      -- années universitaires
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  label TEXT NOT NULL UNIQUE,                   -- ex: "2026-2027"
  start_year INTEGER,
  is_current INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS classes (             -- classes / groupes
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  program_id INTEGER NOT NULL REFERENCES programs(id) ON DELETE CASCADE,
  level_id INTEGER NOT NULL REFERENCES levels(id) ON DELETE CASCADE,
  academic_year_id INTEGER REFERENCES academic_years(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  UNIQUE(program_id, level_id, academic_year_id, name)
);

CREATE TABLE IF NOT EXISTS users (               -- comptes (étudiants + admins)
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('student','admin')),
  last_name TEXT, first_name TEXT,
  is_active INTEGER DEFAULT 1,
  reset_token TEXT, reset_expires TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS students (            -- profil étudiant lié à un user
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  matricule TEXT NOT NULL UNIQUE,
  program_id INTEGER REFERENCES programs(id) ON DELETE SET NULL,
  level_id INTEGER REFERENCES levels(id) ON DELETE SET NULL,
  class_id INTEGER REFERENCES classes(id) ON DELETE SET NULL,
  academic_year_id INTEGER REFERENCES academic_years(id) ON DELETE SET NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS admins (              -- profil administrateur
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  department TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS profile_photos (       -- photo personnelle de chaque compte
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  file_name TEXT,
  mime TEXT NOT NULL,
  content BLOB NOT NULL,
  size INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS templates (           -- modèles de relevé (Filière→Niveau→Année)
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  program_id INTEGER NOT NULL REFERENCES programs(id) ON DELETE CASCADE,
  level_id INTEGER NOT NULL REFERENCES levels(id) ON DELETE CASCADE,
  academic_year_id INTEGER NOT NULL REFERENCES academic_years(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  rules_json TEXT DEFAULT '{}',                  -- règles de calcul configurables (voir compute.js)
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT,
  UNIQUE(program_id, level_id, academic_year_id)
);

CREATE TABLE IF NOT EXISTS semesters (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  template_id INTEGER NOT NULL REFERENCES templates(id) ON DELETE CASCADE,
  number INTEGER NOT NULL,                       -- ex: 3 pour "Semestre 3"
  name TEXT NOT NULL,
  ects_expected REAL DEFAULT 30,                 -- crédits attendus sur le semestre
  ord INTEGER DEFAULT 0,
  UNIQUE(template_id, number)
);

CREATE TABLE IF NOT EXISTS units (               -- UE
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  semester_id INTEGER NOT NULL REFERENCES semesters(id) ON DELETE CASCADE,
  code TEXT NOT NULL,                            -- ex: "UE 9"
  name TEXT,
  ord INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS courses (             -- matières
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  unit_id INTEGER NOT NULL REFERENCES units(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  coefficient REAL DEFAULT 1,
  credits REAL DEFAULT 1,
  ord INTEGER DEFAULT 0,
  UNIQUE(unit_id, name)
);

CREATE TABLE IF NOT EXISTS grades (              -- notes : source = personnel | officiel
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  course_id INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  source TEXT NOT NULL CHECK(source IN ('personal','official')),
  normal REAL,                                   -- note normale (0-20)
  rattrapage REAL,                               -- note de rattrapage (0-20)
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(student_id, course_id, source)
);

CREATE TABLE IF NOT EXISTS publications (        -- diffusion/verrou des résultats officiels par semestre
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  semester_id INTEGER NOT NULL UNIQUE REFERENCES semesters(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK(status IN ('draft','published','locked')),
  published_by INTEGER REFERENCES users(id),
  published_at TEXT,
  snapshot_json TEXT                             -- fige les résultats calculés à la publication
);

CREATE TABLE IF NOT EXISTS schedule_slots (      -- emploi du temps : créneaux (groupe × semestre)
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  class_id INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  semester_id INTEGER NOT NULL REFERENCES semesters(id) ON DELETE CASCADE,
  course_id INTEGER REFERENCES courses(id) ON DELETE CASCADE,
  title TEXT,                                      -- intitulé libre si pas de matière (examen, TD…)
  slot_date TEXT,                                  -- date réelle YYYY-MM-DD (NULL = ancien créneau hebdomadaire)
  slot_type TEXT NOT NULL DEFAULT 'course' CHECK(slot_type IN ('course', 'exam')),
  day INTEGER NOT NULL CHECK(day BETWEEN 1 AND 6), -- 1=lundi … 6=samedi, conservé pour compatibilité
  start TEXT NOT NULL,                             -- 'HH:MM'
  end TEXT NOT NULL,
  room TEXT
);
CREATE INDEX IF NOT EXISTS idx_slots ON schedule_slots(class_id, semester_id, day, start);

CREATE TABLE IF NOT EXISTS announcements (       -- fil d'annonces de l'accueil (posts admin)
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  author_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  body TEXT NOT NULL,
  audience TEXT NOT NULL DEFAULT 'all',          -- all | program | class
  program_id INTEGER REFERENCES programs(id) ON DELETE CASCADE,
  class_id INTEGER REFERENCES classes(id) ON DELETE CASCADE,
  pinned INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_ann_created ON announcements(pinned DESC, created_at DESC);

CREATE TABLE IF NOT EXISTS announcement_images (  -- image jointe à une annonce, stockée en base
  announcement_id INTEGER PRIMARY KEY REFERENCES announcements(id) ON DELETE CASCADE,
  file_name TEXT,
  mime TEXT NOT NULL,
  content BLOB NOT NULL,
  size INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS admin_messages (     -- messages privés envoyés par les étudiants à l'administration
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sender_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'unread' CHECK(status IN ('unread', 'read')),
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_admin_messages_status ON admin_messages(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_admin_messages_sender ON admin_messages(sender_id, created_at DESC);

CREATE TABLE IF NOT EXISTS admin_message_replies ( -- réponses de l'administration dans une conversation
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sender_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'unread' CHECK(status IN ('unread', 'read')),
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_admin_message_replies_student ON admin_message_replies(student_id, created_at DESC);

CREATE TABLE IF NOT EXISTS announcement_likes (  -- « J'aime » (un par personne et par annonce)
  announcement_id INTEGER NOT NULL REFERENCES announcements(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (announcement_id, user_id)
);

CREATE TABLE IF NOT EXISTS uploads (             -- classeurs Excel importés (stockés en base : pas de disque)
  id TEXT PRIMARY KEY,                           -- identifiant public (utilisé dans les URL de l'aperçu)
  name TEXT,                                     -- nom d'origine du fichier
  content BLOB NOT NULL,                         -- contenu binaire (bytea en PostgreSQL)
  size INTEGER,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS imports (             -- journal des imports Excel
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES users(id),
  filename TEXT,
  mode TEXT,
  summary TEXT,
  rows_affected INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS archive_documents (    -- sujets d'examen/rattrapage importés par l'administration
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  uploaded_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  academic_year_id INTEGER REFERENCES academic_years(id) ON DELETE SET NULL,
  level_id INTEGER NOT NULL REFERENCES levels(id) ON DELETE CASCADE,
  subject TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('examen','rattrapage')),
  file_name TEXT NOT NULL,
  mime TEXT NOT NULL,
  content BLOB NOT NULL,
  size INTEGER NOT NULL DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_archive_documents_filters ON archive_documents(academic_year_id, level_id, kind);
`;

export const PG_SCHEMA = postgresSchema(SQLITE_DDL);

/* ------------------------------------------------------------------ */
/* Pilote 1 — SQLite (local / VM)                                       */
/* ------------------------------------------------------------------ */
async function createSqliteAdapter() {
  /* import dynamique : un déploiement Postgres n'a pas besoin du binaire natif */
  let Database;
  try {
    Database = (await import('better-sqlite3')).default;
  } catch {
    throw new Error(
      'Base de données introuvable : renseignez DATABASE_URL (PostgreSQL/Supabase) ou installez le moteur local '
      + '(npm install better-sqlite3). Sur un hébergement sans serveur, DATABASE_URL est obligatoire.');
  }
  const handle = new Database(DB_PATH);
  handle.pragma('journal_mode = WAL');
  handle.pragma('foreign_keys = ON');
  handle.exec(SQLITE_DDL);
  return {
    name: 'sqlite',
    exec: async (sql) => { handle.exec(sql); },
    /* une « requête » = une fonction async, la valeur est calculée tout de suite */
    query: async (sql, params, mode) => {
      const stmt = handle.prepare(sql);
      if (mode === 'get') { const row = stmt.get(...params); return { rows: row === undefined ? [] : [row], rowCount: 0 }; }
      if (mode === 'run' && /^\s*insert/i.test(sql)) {
        const r = stmt.run(...params);
        return { rows: [], rowCount: r.changes, lastInsertRowid: Number(r.lastInsertRowid) };
      }
      if (mode === 'all') return { rows: stmt.all(...params), rowCount: 0 };
      const r = stmt.run(...params);
      return { rows: [], rowCount: r.changes, lastInsertRowid: Number(r.lastInsertRowid) };
    },
    begin: async () => { handle.exec('BEGIN IMMEDIATE'); },
    commit: async () => { handle.exec('COMMIT'); },
    rollback: async () => { handle.exec('ROLLBACK'); },
    backup: async (dest) => { await handle.backup(dest); },
    close: async () => { handle.close(); },
  };
}

/* ------------------------------------------------------------------ */
/* Pilote 2 / 3 — PostgreSQL (Supabase) et PGlite (tests)               */
/* ------------------------------------------------------------------ */
function createPostgresAdapter(runner, name) {
  let ready = null;
  const ensureSchema = async () => {
    if (process.env.PG_AUTO_SCHEMA === '0') return;
    ready ||= (async () => { await runner.exec(PG_SCHEMA); })();
    await ready;
  };
  return {
    name,
    exec: (sql) => runner.exec(sql),
    query: async (sql, params, mode) => {
      await ensureSchema();
      const { text, insert } = toPostgres(sql);
      let r;
      try {
        r = await runner.query(text, params);
      } catch (e) {
        /* aide au diagnostic : montrer la requête traduite qui a échoué */
        console.error(`[sql] échec du pilote ${name} : ${e.message}\n  requête : ${text.replace(/\s+/g, ' ')}\n  paramètres : ${JSON.stringify(params)}`);
        throw e;
      }
      const rows = r.rows || [];
      if (insert) return { rows, rowCount: r.rowCount ?? rows.length, lastInsertRowid: rows[0]?.id ?? null };
      return { rows, rowCount: r.rowCount ?? rows.length };
    },
    begin: () => runner.begin(),
    commit: () => runner.commit(),
    rollback: () => runner.rollback(),
    close: () => runner.close(),
    unsupported: 'backup',
  };
}

async function createPgPoolAdapter() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL manquant (chaîne de connexion Supabase)');
  const pg = (await import('pg')).default;
  installTypeParsers(pg);
  const needsSsl = !/localhost|127\.0\.0\.1/.test(url) && process.env.PGSSL !== 'disable';
  const pool = new pg.Pool({
    connectionString: url,
    ssl: needsSsl ? { rejectUnauthorized: false } : undefined,
    max: Number(process.env.PG_POOL_MAX || 1),          /* serverless : une connexion par instance */
    idleTimeoutMillis: Number(process.env.PG_IDLE_MS || 10_000),
    connectionTimeoutMillis: Number(process.env.PG_CONNECT_MS || 15_000),
    allowExitOnIdle: true,
  });
  /* les lignes uniques renvoyées par RETURNING passent par le même format qu'en lecture */
  return createPostgresAdapter({
    query: (text, params) => pool.query(text, params),
    exec: async (sql) => { await pool.query(sql); },
    begin: () => pool.query('BEGIN'),
    commit: () => pool.query('COMMIT'),
    rollback: () => pool.query('ROLLBACK'),
    close: () => pool.end(),
  }, 'postgres');
}

async function createPgliteAdapter() {
  const { PGlite } = await import('@electric-sql/pglite');
  const memory = process.env.PGLITE_DIR;
  const options = { parsers: TYPE_PARSERS };      /* mêmes formats de sortie que le pilote pg */
  const lite = memory ? new PGlite(memory, options) : new PGlite(options);
  await lite.waitReady;
  const runner = {
    query: async (text, params) => {
      const r = await lite.query(text, params);
      const rows = r.rows || [];
      return { rows, rowCount: r.affectedRows ?? r.rowCount ?? rows.length };
    },
    exec: async (sql) => { await lite.exec(sql); },
    begin: () => lite.exec('BEGIN'),
    commit: () => lite.exec('COMMIT'),
    rollback: () => lite.exec('ROLLBACK'),
    close: () => lite.close(),
  };
  return createPostgresAdapter(runner, 'pglite');
}

/* ------------------------------------------------------------------ */
/* Assemblage : une seule façade `db`                                   */
/* ------------------------------------------------------------------ */
const adapter = await (async () => {
  if (DRIVER === 'postgres') return await createPgPoolAdapter();
  if (DRIVER === 'pglite') return await createPgliteAdapter();
  if (DRIVER === 'sqlite') return await createSqliteAdapter();
  throw new Error(`DB_DRIVER inconnu : ${DRIVER} (attendu : sqlite, postgres ou pglite)`);
})();

const txStorage = new AsyncLocalStorage();

const db = {
  driver: adapter.name,
  /** Requête paramétrée ; les transactions en cours sont respectées automatiquement. */
  prepare(sql) {
    return {
      get: async (...params) => (await run(sql, params, 'get')).rows[0],
      all: async (...params) => (await run(sql, params, 'all')).rows,
      /* `changes` reprend le vocabulaire de better-sqlite3 : le code de l'application l'utilise. */
      run: async (...params) => {
        const r = await run(sql, params, 'run');
        return { ...r, changes: r.rowCount ?? 0 };
      },
    };
  },
  /** Exécution directe d'un script (DDL, plusieurs instructions séparées par « ; »). */
  async exec(sql) { return adapter.exec(sql); },
  /** Sauvegarde à chaud (SQLite uniquement ; sur Supabase, la sauvegarde est gérée par le service). */
  async backup(dest) {
    if (!adapter.backup) throw new Error(`Sauvegarde non gérée par le pilote « ${adapter.name} » (utilisez les sauvegardes de la plateforme)`);
    return adapter.backup(dest);
  },
  async close() { return adapter.close(); },
  isPostgres: adapter.name === 'postgres' || adapter.name === 'pglite',
  schema: { sqlite: SQLITE_DDL, postgres: PG_SCHEMA },
};

async function run(sql, params, mode) {
  const bound = txStorage.getStore();
  if (bound) return bound.query(sql, params, mode);
  return adapter.query(sql, params, mode);
}

/** Transaction : toutes les requêtes `db` exécutées dans `fn` partagent la transaction. */
export async function tx(fn) {
  if (txStorage.getStore()) return fn();               /* déjà dans une transaction : on rejoint */
  await adapter.begin();
  try {
    const result = await txStorage.run({ query: (sql, params, mode) => adapter.query(sql, params, mode) }, fn);
    await adapter.commit();
    return result;
  } catch (e) {
    try { await adapter.rollback(); } catch { /* la connexion a pu être coupée */ }
    throw e;
  }
}

export default db;
