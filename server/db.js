/**
 * db.js — Base de données relationnelle SQLite (better-sqlite3).
 * Schéma évolutif : établissement → filière → niveau → année → modèle → semestre → UE → matière.
 * Toutes les structures pédagogiques viennent de la base (aucune donnée codée en dur).
 */
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(path.join(DATA_DIR, 'uploads'), { recursive: true });

export const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, 'monreleve.db');

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
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
  day INTEGER NOT NULL CHECK(day BETWEEN 1 AND 6), -- 1=lundi … 6=samedi
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

CREATE TABLE IF NOT EXISTS announcement_likes (  -- « J'aime » (un par personne et par annonce)
  announcement_id INTEGER NOT NULL REFERENCES announcements(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (announcement_id, user_id)
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
`);

export default db;

/** Petit helper de requêtes transactionnelles. */
export function tx(fn) {
  const t = db.transaction(fn);
  return t();
}
