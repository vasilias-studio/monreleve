/**
 * seed.js — Configuration initiale à partir du fichier Excel fourni.
 *
 *   node server/seed.js            → crée les référentiels + le modèle L2 Gestion
 *                                     (semestres/UE/matières/crédits/règles) extrait de
 *                                     « Relevé de notes.xlsx », + comptes de démonstration.
 *   node server/seed.js --reset    → repart d'une base vierge.
 *   node server/seed.js --no-demo  → sans comptes de démonstration.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import db, { tx } from './db.js';
import { hashPassword } from './auth.js';
import { loadSheetCells, parseReleveStructure } from './releveParser.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const candidates = ['Relevé de notes.xlsx', 'Relev-de-notes.xlsx', 'Relevé de notes L2.xlsx']
  .map((f) => path.join(__dirname, '..', f))
  .concat(process.env.XLSX_PATH ? [process.env.XLSX_PATH] : []);
const XLSX_PATH = candidates.find((p) => fs.existsSync(p)) || candidates[0];
const args = process.argv.slice(2);
const RESET = args.includes('--reset');
const DEMO = !args.includes('--no-demo');

if (RESET) {
  console.log('[seed] Réinitialisation de la base…');
  await db.exec(`DELETE FROM grades; DELETE FROM publications; DELETE FROM imports; DELETE FROM courses; DELETE FROM units;
    DELETE FROM semesters; DELETE FROM templates; DELETE FROM students; DELETE FROM admins; DELETE FROM users;
    DELETE FROM classes; DELETE FROM academic_years; DELETE FROM levels; DELETE FROM programs; DELETE FROM institutions;
    DELETE FROM sqlite_sequence;`);
}

const getOne = async (sql, ...p) => await db.prepare(sql).get(...p);
const insert = async (sql, ...p) => (await db.prepare(sql).run(...p)).lastInsertRowid;

/* -------- Référentiels (uniquement s'ils manquent) -------------------- */
const institutionId = (await getOne(`SELECT id FROM institutions WHERE name=?`, 'Université — Faculté Économie & Gestion'))?.id
  ?? await insert(`INSERT INTO institutions (name, code) VALUES (?, ?)`, 'Université — Faculté Économie & Gestion', 'FEG');
const programId = (await getOne(`SELECT id FROM programs WHERE name=? AND institution_id=?`, 'Gestion', institutionId))?.id
  ?? await insert(`INSERT INTO programs (institution_id, name, code) VALUES (?,?,?)`, institutionId, 'Gestion', 'GES');
await insert(`INSERT OR IGNORE INTO programs (institution_id, name, code) VALUES (?,?,?)`, institutionId, 'Économie', 'ECO');
await insert(`INSERT OR IGNORE INTO programs (institution_id, name, code) VALUES (?,?,?)`, institutionId, 'Marketing', 'MKT');

for (const [name, cycle, ord] of [['L1', 'Licence', 1], ['L2', 'Licence', 2], ['L3', 'Licence', 3], ['M1', 'Master', 4]]) {
  await insert(`INSERT OR IGNORE INTO levels (name, cycle, ord) VALUES (?,?,?)`, name, cycle, ord);
}
const level2Id = (await getOne(`SELECT id FROM levels WHERE name='L2'`)).id;
const level1Id = (await getOne(`SELECT id FROM levels WHERE name='L1'`)).id;

const YEAR = '2026-2027';
const yearId = (await getOne(`SELECT id FROM academic_years WHERE label=?`, YEAR))?.id
  ?? await insert(`INSERT INTO academic_years (label, start_year, is_current) VALUES (?,?,1)`, YEAR, 2026);

const classId = (await getOne(`SELECT id FROM classes WHERE name=? AND program_id=? AND level_id=?`, 'Groupe A', programId, level2Id))?.id
  ?? await insert(`INSERT INTO classes (program_id, level_id, academic_year_id, name) VALUES (?,?,?,?)`, programId, level2Id, yearId, 'Groupe A');
await insert(`INSERT OR IGNORE INTO classes (program_id, level_id, academic_year_id, name) VALUES (?,?,?,?)`, programId, level1Id, yearId, 'Groupe A');

/* -------- Règles de calcul reproduisant la logique de l'Excel -------- */
const RULES = {
  final_grade_rule: 'max_normal_rattrapage',   // Définitive = MAX(Normale, Rattrapage)
  rattrapage_cap: null,                         // pas de plafond (comme dans le fichier)
  rattrapage_weight: 0.5,
  ue_average_method: 'simple',                  // moyenne arithmétique des matières (pas de coef dans l'Excel)
  semester_average_method: 'ue_simple_mean',    // AVERAGE(moyennes des UE)
  general_average_method: 'semester_mean',      // moyenne des moyennes de semestre
  credit_validation_basis: 'normal',            // crédits si NOTE NORMALE >= seuil (formule =IF(C12>=10,2,"-"))
  pass_threshold: 10,
};

let templateId = (await getOne(`SELECT id FROM templates WHERE program_id=? AND level_id=? AND academic_year_id=?`, programId, level2Id, yearId))?.id;

/* -------- Construction du modèle depuis le fichier Excel -------------- */
if (!templateId && fs.existsSync(XLSX_PATH)) {
  console.log('[seed] Parsing de', XLSX_PATH);
  const { rows } = loadSheetCells(XLSX_PATH);
  const parsed = parseReleveStructure(rows);
  if (!parsed.ok) { console.error('[seed] Échec du parsing :', parsed.error); process.exit(1); }
  for (const w of parsed.warnings || []) console.log('[seed] attention :', w);
  await tx(async () => {
    templateId = await insert(`INSERT INTO templates (program_id, level_id, academic_year_id, name, rules_json) VALUES (?,?,?,?,?)`,
      programId, level2Id, yearId, `L2 — Gestion — ${YEAR}`, JSON.stringify(RULES));
    let sOrd = 0;
    for (const s of parsed.semesters) {
      const si = await insert(`INSERT INTO semesters (template_id, number, name, ects_expected, ord) VALUES (?,?,?,?,?)`,
        templateId, s.number, s.name || `Semestre ${s.number}`, s.ects || 30, sOrd++);
      let uOrd = 0;
      for (const u of s.units) {
        const ui = await insert(`INSERT INTO units (semester_id, code, name, ord) VALUES (?,?,?,?)`, si, u.code, u.name, uOrd++);
        let cOrd = 0;
        for (const c of u.courses) {
          await insert(`INSERT INTO courses (unit_id, name, coefficient, credits, ord) VALUES (?,?,?,?,?)`,
            ui, c.name, c.coefficient ?? 1, c.credits ?? 1, cOrd++);
        }
      }
    }
  });
  const nSem = parsed.semesters.length;
  const nU = parsed.semesters.reduce((a, s) => a + s.units.length, 0);
  const nC = parsed.semesters.reduce((a, s) => a + s.units.reduce((x, u) => x + u.courses.length, 0), 0);
  console.log(`[seed] Modèle créé depuis Excel : ${nSem} semestres, ${nU} UE, ${nC} matières`);
} else if (!templateId) {
  console.warn('[seed] Fichier Excel introuvable — aucun modèle L2 créé. Utilisez l’import admin ou placez « Relevé de notes.xlsx » à la racine.');
}

/* Modèles L1/L3 vides pour montrer l'évolutivité (crédités 30 par semestre). */
if (templateId) {
  const hasL1 = await getOne(`SELECT id FROM templates WHERE program_id=? AND level_id=?`, programId, level1Id);
  if (!hasL1) {
    const l1 = await insert(`INSERT INTO templates (program_id, level_id, academic_year_id, name, rules_json) VALUES (?,?,?,?,?)`,
      programId, level1Id, yearId, `L1 — Gestion — ${YEAR}`, JSON.stringify(RULES));
    for (const n of [1, 2]) await insert(`INSERT INTO semesters (template_id, number, name, ects_expected, ord) VALUES (?,?,?,?,?)`, l1, n, `Semestre ${n}`, 30, n);
  }
}

/* -------- Comptes ------------------------------------------------------ */
const admin = await getOne(`SELECT u.id FROM users u JOIN admins a ON a.user_id=u.id WHERE u.email=?`, process.env.ADMIN_EMAIL || 'admin@univ.mg');
if (!admin && DEMO) {
  const uid = await insert(`INSERT INTO users (email, password_hash, role, first_name, last_name) VALUES (?,?, 'admin', ?, ?)`,
    'admin@univ.mg', hashPassword('admin123'), 'Cellule', 'Scolarité');
  await insert(`INSERT INTO admins (user_id, department) VALUES (?, ?)`, uid, 'Scolarité / FEG');
  console.log('[seed] Admin démo : admin@univ.mg / admin123');
}

if (DEMO && templateId) {
  const demoStudents = [
    { email: 'naina.randria@example.mg', first: 'Naina', last: 'Randria', mat: '2026-GES-0142', pw: 'etudiant123' },
    { email: 'tojo.hanta@example.mg', first: 'Tojo', last: 'Hanta', mat: '2026-GES-0143', pw: 'etudiant123' },
  ];
  const courses = await db.prepare(`SELECT c.id, s.number AS sem, u.code AS ue FROM courses c JOIN units u ON u.id=c.unit_id JOIN semesters s ON s.id=u.semester_id WHERE s.template_id=? ORDER BY s.ord, u.ord, c.ord`).all(templateId);
  for (const d of demoStudents) {
    if (await getOne(`SELECT id FROM users WHERE email=?`, d.email)) continue;
    await tx(async () => {
      const uid = await insert(`INSERT INTO users (email, password_hash, role, first_name, last_name) VALUES (?,?,?,?,?)`,
        d.email, hashPassword(d.pw), 'student', d.last, d.first);
      const sid = await insert(`INSERT INTO students (user_id, matricule, program_id, level_id, class_id, academic_year_id) VALUES (?,?,?,?,?,?)`,
        uid, d.mat, programId, level2Id, classId, yearId);
      // Notes personnelles plausibles pour la démo ; pour Naina : notes officielles + S3 publié.
      const rnd = (min, max) => Math.round((min + Math.random() * (max - min)) * 2) / 2;
      /* boucle séquentielle : `forEach` n'attend pas, une erreur passerait inaperçue */
      for (const c of courses) {
        const normal = rnd(6, 18);
        const rattr = normal < 10 ? rnd(8, 16) : null;
        await insert(`INSERT INTO grades (student_id, course_id, source, normal, rattrapage) VALUES (?,?,'personal',?,?)`, sid, c.id, normal, rattr);
        if (d.first === 'Naina') {
          await insert(`INSERT INTO grades (student_id, course_id, source, normal, rattrapage) VALUES (?,?,'official',?,?)`, sid, c.id, normal, rattr);
        }
      }
      if (d.first === 'Naina') {
        const s3row = await getOne(`SELECT id FROM semesters WHERE template_id=? AND number=3`, templateId);
        if (s3row) {
          await db.prepare(`INSERT INTO publications (semester_id, status, published_by, published_at)
            VALUES (?,'published',(SELECT id FROM users WHERE role='admin' LIMIT 1),datetime('now'))`)
            .run(s3row.id);
        }
      }
    });
    console.log(`[seed] Étudiant démo : ${d.email} / ${d.pw} (matricule ${d.mat})`);
  }
}

console.log('[seed] Terminé ✔  (admin: admin@univ.mg / admin123 — à changer en production, ou créez le vôtre avec: npm run create-admin)');
