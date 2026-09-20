/**
 * routes/student.js — Espace étudiant.
 * Toutes les requêtes sont scopées sur req.student issu du TOKEN (jamais d'id client) :
 * un étudiant ne peut ni lire ni écrire les données d'un autre étudiant.
 *
 *  - « Mes notes »       : source=personal, toujours modifiables par l'étudiant.
 *  - « Résultats officiels » : source=official, en lecture seule, visibles selon publication.
 */
import { Router } from 'express';
import db from '../db.js';
import { authRequired, attachStudent, badRequest, notFound, forbidden } from '../auth.js';
import { computeReleve, resolveRules, round2 } from '../compute.js';

const r = Router();
r.use(authRequired, attachStudent);

const score = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(String(v).replace(',', '.'));
  if (!Number.isFinite(n) || n < 0 || n > 20) throw badRequest('Note invalide : attendu un nombre entre 0 et 20');
  return Math.round(n * 100) / 100;
};

/** Trouve le modèle correspondant : Filière → Niveau → Année universitaire. */
export function findTemplateForStudent(student) {
  if (!student.program_id || !student.level_id) return null;
  const yearId = student.academic_year_id ?? db.prepare('SELECT id FROM academic_years WHERE is_current=1').get()?.id ?? null;
  const t = db.prepare(`SELECT t.*, p.name AS program_name, l.name AS level_name, y.label AS year_label
    FROM templates t JOIN programs p ON p.id=t.program_id JOIN levels l ON l.id=t.level_id
    LEFT JOIN academic_years y ON y.id=t.academic_year_id
    WHERE t.program_id=? AND t.level_id=? AND (? IS NULL OR t.academic_year_id=?)
    ORDER BY (t.academic_year_id = ?) DESC, t.updated_at DESC LIMIT 1`)
    .get(student.program_id, student.level_id, yearId, yearId, yearId);
  return t || null;
}

/** Charge la structure complète d'un modèle (semestres → UE → matières). */
export function loadTemplateTree(templateId) {
  const sems = db.prepare('SELECT * FROM semesters WHERE template_id=? ORDER BY ord, number').all(templateId);
  const units = db.prepare('SELECT * FROM units WHERE semester_id=? ORDER BY ord, id');
  const courses = db.prepare('SELECT * FROM courses WHERE unit_id=? ORDER BY ord, id');
  for (const s of sems) {
    s.units = units.all(s.id);
    for (const u of s.units) u.courses = courses.all(u.id);
  }
  return sems;
}

/** Charge les notes d'un étudiant pour un modèle et une source. */
function loadGrades(studentId, semesters, source) {
  const ids = semesters.flatMap((s) => s.units.flatMap((u) => u.courses.map((c) => c.id)));
  const map = new Map();
  if (!ids.length) return map;
  const marks = ids.map(() => '?').join(',');
  const rows = db.prepare(`SELECT course_id, normal, rattrapage FROM grades WHERE student_id=? AND source=? AND course_id IN (${marks})`)
    .all(studentId, source, ...ids);
  for (const row of rows) map.set(row.course_id, row);
  return map;
}

function publicationMap(semesters) {
  const out = {};
  for (const s of semesters) {
    out[s.id] = db.prepare('SELECT status, published_at FROM publications WHERE semester_id=?').get(s.id) || { status: 'draft', published_at: null };
  }
  return out;
}

/** GET /api/student/overview — tout pour le tableau de bord + relevés. */
r.get('/overview', (req, res, next) => {
  try {
    const template = findTemplateForStudent(req.student);
    if (!template) return res.json({ template: null });
    const semesters = loadTemplateTree(template.id);
    const personal = computeReleve(template, semesters, loadGrades(req.student.id, semesters, 'personal'));
    const official = computeReleve(template, semesters, loadGrades(req.student.id, semesters, 'official'));
    const pubs = publicationMap(semesters);
    // Un semestre officiel n'est visible que si publié ou verrouillé
    official.semesters = official.semesters.filter((s) => pubs[s.id]?.status !== 'draft');
    res.json({
      template: {
        id: template.id, name: template.name, program: template.program_name,
        level: template.level_name, year: template.year_label, rules: resolveRules(template),
      },
      publications: pubs,
      personal: { ...personal, semesters: semesters.map((s, i) => ({ ...personal.semesters[i], source: 'personal' })) },
      official,
    });
  } catch (e) { next(e); }
});

/** GET /api/student/releve?source=personal|official — relevé détaillé (structure + notes). */
r.get('/releve', (req, res, next) => {
  try {
    const source = req.query.source === 'official' ? 'official' : 'personal';
    const template = findTemplateForStudent(req.student);
    if (!template) throw notFound('Aucun modèle de relevé n’est associé à votre filière/niveau. Contactez l’administration.');
    const semesters = loadTemplateTree(template.id);
    const grades = loadGrades(req.student.id, semesters, source);
    const computed = computeReleve(template, semesters, grades);
    const pubs = publicationMap(semesters);
    const semById = Object.fromEntries(computed.semesters.map((s) => [s.id, s]));
    for (const s of semesters) {
      const cs = semById[s.id];
      s.average = cs?.average ?? null;
      s.creditsEarned = cs?.creditsEarned ?? 0;
      s.publication = pubs[s.id]?.status ?? 'draft';
      for (const u of s.units) {
        const cu = cs?.units.find((x) => x.id === u.id);
        u.average = cu?.average ?? null;
        for (const c of u.courses) {
          const cc = cu?.courses.find((x) => x.id === c.id);
          Object.assign(c, { normal: cc?.normal, rattrapage: cc?.rattrapage, definitive: cc?.definitive, status: cc?.status });
        }
      }
    }
    if (source === 'official') {
      // Totaux officiels = uniquement sur les semestres publiés/verrouillés
      const visibleTree = semesters.filter((s) => pubs[s.id]?.status !== 'draft');
      const officialTotals = computeReleve(template, visibleTree, loadGrades(req.student.id, visibleTree, 'official'));
      const visible = semesters.filter((s) => pubs[s.id]?.status !== 'draft');
      const byId = Object.fromEntries(officialTotals.semesters.map((x) => [x.id, x]));
      for (const v of visible) { v.average = byId[v.id]?.average ?? null; v.creditsEarned = byId[v.id]?.creditsEarned ?? 0; for (const u of v.units) u.average = byId[v.id]?.units.find((x) => x.id === u.id)?.average ?? null; }
      return res.json({ template, rules: computed.rules, semesters: visible, empty: !visible.length, totals: { generalAverage: officialTotals.generalAverage, creditsEarned: officialTotals.creditsEarned, creditsExpected: officialTotals.creditsExpected, creditsRemaining: officialTotals.creditsRemaining, counts: officialTotals.counts } });
    }
    const totals = { generalAverage: computed.generalAverage, creditsEarned: computed.creditsEarned, creditsExpected: computed.creditsExpected, creditsRemaining: computed.creditsRemaining, counts: computed.counts };
    res.json({ template, rules: computed.rules, semesters, totals });
  } catch (e) { next(e); }
});

/** PUT /api/student/grades/:courseId — saisie/mise à jour d'UNE note personnelle. */
r.put('/grades/:courseId', (req, res, next) => {
  try {
    const courseId = Number(req.params.courseId);
    const course = db.prepare(`SELECT c.*, u.semester_id, s2.number AS sem_number
      FROM courses c JOIN units u ON u.id=c.unit_id JOIN semesters s2 ON s2.id=u.semester_id
      WHERE c.id=?`).get(courseId);
    if (!course) throw notFound('Matière inconnue');
    // La matière doit appartenir au modèle de l'étudiant : vérification serveur.
    const template = findTemplateForStudent(req.student);
    if (!template) throw forbidden('Aucun modèle associé à votre compte');
    const inTemplate = db.prepare('SELECT 1 FROM semesters WHERE template_id=? AND id=?').get(template.id, course.semester_id);
    if (!inTemplate) throw forbidden('Cette matière ne fait pas partie de votre relevé');

    const normal = score(req.body?.normal ?? null);
    const rattrapage = score(req.body?.rattrapage ?? null);
    db.prepare(`INSERT INTO grades (student_id, course_id, source, normal, rattrapage, updated_at)
      VALUES (?,?,'personal',?,?,datetime('now'))
      ON CONFLICT(student_id, course_id, source)
      DO UPDATE SET normal=excluded.normal, rattrapage=excluded.rattrapage, updated_at=datetime('now')`)
      .run(req.student.id, courseId, normal, rattrapage);

    const semesters = loadTemplateTree(template.id);
    const computed = computeReleve(template, semesters, loadGrades(req.student.id, semesters, 'personal'));
    res.json({ ok: true, course_id: courseId, normal, rattrapage, computed });
  } catch (e) { next(e); }
});

/** PUT /api/student/grades — saisie en lots {grades:{courseId:{normal,rattrapage}}}. */
r.put('/grades', (req, res, next) => {
  try {
    const template = findTemplateForStudent(req.student);
    if (!template) throw forbidden('Aucun modèle associé à votre compte');
    const allowed = new Set(loadTemplateTree(template.id).flatMap((s) => s.units.flatMap((u) => u.courses.map((c) => c.id))));
    const entries = Object.entries(req.body?.grades || {});
    if (!entries.length) throw badRequest('Aucune saisie reçue');
    db.transaction(() => {
      for (const [cid, g] of entries) {
        const courseId = Number(cid);
        if (!allowed.has(courseId)) throw forbidden('Matière hors de votre relevé');
        const normal = score(g.normal ?? null), rattrapage = score(g.rattrapage ?? null);
        db.prepare(`INSERT INTO grades (student_id, course_id, source, normal, rattrapage, updated_at)
          VALUES (?,?,'personal',?,?,datetime('now'))
          ON CONFLICT(student_id, course_id, source)
          DO UPDATE SET normal=excluded.normal, rattrapage=excluded.rattrapage, updated_at=datetime('now')`)
          .run(req.student.id, courseId, normal, rattrapage);
      }
    })();
    const semesters = loadTemplateTree(template.id);
    const computed = computeReleve(template, semesters, loadGrades(req.student.id, semesters, 'personal'));
    res.json({ ok: true, computed });
  } catch (e) { next(e); }
});

/** PUT /api/student/enrollment — l'étudiant ajuste filière/niveau/classe/année (son propre profil). */
r.put('/enrollment', (req, res, next) => {
  try {
    const b = req.body || {};
    const pick = (f) => (b[f] !== undefined ? (b[f] === null ? null : Number(b[f])) : null);
    const fields = { program_id: pick('program_id'), level_id: pick('level_id'), class_id: pick('class_id'), academic_year_id: pick('academic_year_id') };
    for (const [k, v] of Object.entries(fields)) {
      if (v === null) delete fields[k];
      else if (!Number.isFinite(v) || v <= 0) throw badRequest(`Valeur invalide : ${k}`);
    }
    if (!Object.keys(fields).length) throw badRequest('Rien à modifier');
    const keys = Object.keys(fields);
    db.prepare(`UPDATE students SET ${keys.map((k) => k + '=?').join(',')} WHERE id=?`)
      .run(...keys.map((k) => fields[k]), req.student.id);
    const s = db.prepare('SELECT * FROM students WHERE id=?').get(req.student.id);
    const j = db.prepare(`SELECT p.name AS program, l.name AS level, c.name AS class, y.label AS year
      FROM students s2 LEFT JOIN programs p ON p.id=s2.program_id LEFT JOIN levels l ON l.id=s2.level_id
      LEFT JOIN classes c ON c.id=s2.class_id LEFT JOIN academic_years y ON y.id=s2.academic_year_id WHERE s2.id=?`).get(s.id);
    res.json({ ok: true, enrollment: { ...s, ...j } });
  } catch (e) { next(e); }
});

/** GET /api/student/stats — chiffres pour l'écran « Moyennes » (perso + officiel). */
r.get('/stats', (req, res, next) => {
  try {
    const template = findTemplateForStudent(req.student);
    if (!template) throw notFound('Aucun modèle disponible');
    const semesters = loadTemplateTree(template.id);
    const mk = (src) => {
      const c = computeReleve(template, semesters, loadGrades(req.student.id, semesters, src));
      return {
        generalAverage: c.generalAverage,
        creditsEarned: c.creditsEarned, creditsExpected: c.creditsExpected,
        counts: c.counts,
        semesters: c.semesters.map((s) => ({
          id: s.id, number: s.number, name: s.name, average: s.average,
          creditsEarned: s.creditsEarned, ectsExpected: s.ectsExpected,
          units: s.units.map((u) => ({ id: u.id, code: u.code, name: u.name, average: u.average })),
        })),
      };
    };
    res.json({ personal: mk('personal'), official: mk('official') });
  } catch (e) { next(e); }
});

export default r;
