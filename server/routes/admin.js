/**
 * routes/admin.js — Espace administrateur.
 * Gestion des référentiels (établissements, filières, niveaux, classes, années),
 * des étudiants, des modèles de relevés (semestres/UE/matières/coeffs/crédits/règles),
 * des notes officielles et de la publication/verrouillage des résultats.
 */
import { asyncRouter } from '../asyncrouter.js';
import bcrypt from 'bcryptjs';
import db, { tx } from '../db.js';
import { authRequired, requireRole, badRequest, notFound, forbidden, ApiError } from '../auth.js';
import { computeReleve, resolveRules } from '../compute.js';
import { findTemplateForStudent, loadTemplateTree } from './student.js';

const r = asyncRouter();
r.use(authRequired, requireRole('admin'));

const auto = (v) => {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return v;
  const s = String(v).trim();
  if (s === '') return null;
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);   // ids, ord, ects, flags…
  return s;                                            // champs texte
};
const refCrud = (table, cols, { orderBy = 'name', extra = {} } = {}) => {
  const rt = asyncRouter();
  rt.get('/', async (_req, res) => {
    const rows = await db.prepare(`SELECT * FROM ${table} ORDER BY ${orderBy}`).all();
    res.json(rows);
  });
  rt.post('/', async (req, res, next) => {
    try {
      const target = cols.filter((c) => c !== 'id');
      const info = await db.prepare(`INSERT INTO ${table} (${target.join(',')}) VALUES (${target.map(() => '?').join(',')})`)
        .run(...target.map((c) => auto(req.body[c])));
      res.status(201).json({ id: info.lastInsertRowid });
    } catch (e) { next(e); }
  });
  rt.put('/:id', async (req, res, next) => {
    try {
      const upd = cols.filter((c) => c !== 'id' && req.body[c] !== undefined);
      if (!upd.length) throw badRequest('Rien à modifier');
      await db.prepare(`UPDATE ${table} SET ${upd.map((c) => c + '=?').join(',')} WHERE id=?`)
        .run(...upd.map((c) => auto(req.body[c])), req.params.id);
      res.json({ ok: true });
    } catch (e) { next(e); }
  });
  rt.delete('/:id', async (req, res, next) => {
    try {
      if (extra.blockDelete?.(req.params.id)) throw new ApiError(409, extra.blockDelete.message);
      await db.prepare(`DELETE FROM ${table} WHERE id=?`).run(req.params.id);
      res.json({ ok: true });
    } catch (e) { next(e); }
  });
  return rt;
};

/* Numériques validés pour les endpoints de saisie (notes, ids explicites). */
const num = (v) => { if (v === null || v === undefined || v === '') return null; const n = Number(String(v).replace(',', '.')); if (!Number.isFinite(n)) throw badRequest('Nombre invalide: ' + v); return n; };
const str = (v) => (v == null ? null : String(v).trim() || null);

/* ------------------------------------------------------------------ */
/* Tableau de bord                                                      */
/* ------------------------------------------------------------------ */
r.get('/stats', async (_req, res) => {
  res.json({
    students: (await db.prepare('SELECT COUNT(*) n FROM students').get()).n,
    users: (await db.prepare('SELECT COUNT(*) n FROM users').get()).n,
    programs: (await db.prepare('SELECT COUNT(*) n FROM programs WHERE active=1').get()).n,
    levels: (await db.prepare('SELECT COUNT(*) n FROM levels').get()).n,
    templates: (await db.prepare('SELECT COUNT(*) n FROM templates').get()).n,
    published: (await db.prepare("SELECT COUNT(*) n FROM publications WHERE status IN ('published','locked')").get()).n,
    byProgram: await db.prepare(`SELECT p.name, COUNT(s.id) n FROM students s JOIN programs p ON p.id=s.program_id GROUP BY p.id ORDER BY n DESC`).all(),
    recent: await db.prepare(`SELECT s.id, u.first_name, u.last_name, u.email, s.matricule, p.name AS program, l.name AS level
      FROM students s JOIN users u ON u.id=s.user_id LEFT JOIN programs p ON p.id=s.program_id
      LEFT JOIN levels l ON l.id=s.level_id ORDER BY s.created_at DESC, s.id DESC LIMIT 5`).all(),
  });
});

/* ------------------------------------------------------------------ */
/* Référentiels (montés avec refCrud défini ci-dessus)                  */
/* ------------------------------------------------------------------ */

r.use('/institutions', refCrud('institutions', ['name', 'code']));
r.use('/programs', refCrud('programs', ['institution_id', 'name', 'code', 'active']));
r.use('/levels', refCrud('levels', ['name', 'cycle', 'ord'], { orderBy: 'ord, name' }));
r.use('/years', refCrud('academic_years', ['label', 'start_year', 'is_current'], { orderBy: 'start_year DESC' }));

r.use('/classes', refCrud('classes', ['program_id', 'level_id', 'academic_year_id', 'name']));

/* Année courante */
r.put('/years/:id/current', async (req, res, next) => {
  try {
    await tx(async () => {
      await db.prepare('UPDATE academic_years SET is_current=0').run();
      await db.prepare('UPDATE academic_years SET is_current=1 WHERE id=?').run(req.params.id);
    });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

/* ------------------------------------------------------------------ */
/* Étudiants                                                            */
/* ------------------------------------------------------------------ */
const studentSelect = `
  SELECT s.id, s.matricule, s.program_id, s.level_id, s.class_id, s.academic_year_id, s.created_at,
         u.id AS user_id, u.email, u.is_active, u.first_name, u.last_name,
         p.name AS program, l.name AS level, c.name AS class, y.label AS year
  FROM students s
  JOIN users u ON u.id = s.user_id
  LEFT JOIN programs p ON p.id = s.program_id
  LEFT JOIN levels l ON l.id = s.level_id
  LEFT JOIN classes c ON c.id = s.class_id
  LEFT JOIN academic_years y ON y.id = s.academic_year_id`;

r.get('/students', async (req, res) => {
  const q = str(req.query.q);
  let sql = studentSelect;
  const params = [];
  const filters = [];
  if (q) { filters.push(`(u.first_name LIKE ? OR u.last_name LIKE ? OR s.matricule LIKE ? OR u.email LIKE ?)`); params.push(...Array(4).fill(`%${q}%`)); }
  if (req.query.program_id) { filters.push('s.program_id=?'); params.push(req.query.program_id); }
  if (req.query.level_id) { filters.push('s.level_id=?'); params.push(req.query.level_id); }
  if (filters.length) sql += ' WHERE ' + filters.join(' AND ');
  sql += ' ORDER BY u.last_name, u.first_name LIMIT 500';
  res.json(await db.prepare(sql).all(...params));
});

r.get('/students/:id', async (req, res, next) => {
  try {
    const s = await db.prepare(studentSelect + ' WHERE s.id=?').get(req.params.id);
    if (!s) throw notFound('Étudiant introuvable');
    const template = await findTemplateForStudent(s);
    let computed = null, official = null, pubs = {};
    if (template) {
      const sems = await loadTemplateTree(template.id);
      const gmap = async (src) => {
        const ids = sems.flatMap((x) => x.units.flatMap((u) => u.courses.map((c) => c.id)));
        const m = new Map();
        if (ids.length) {
          const marks = ids.map(() => '?').join(',');
          for (const row of await db.prepare(`SELECT course_id, normal, rattrapage FROM grades WHERE student_id=? AND source=? AND course_id IN (${marks})`).all(s.id, src, ...ids)) m.set(row.course_id, row);
        }
        return m;
      };
      official = computeReleve(template, sems, await gmap('official'));
      computed = { official: official.generalAverage, credits: official.creditsEarned };
      for (const x of sems) pubs[x.id] = await db.prepare('SELECT status, published_at FROM publications WHERE semester_id=?').get(x.id) || { status: 'draft' };
    }
    res.json({ ...s, template: template ? { id: template.id, name: template.name, rules: resolveRules(template) } : null, official, computed, publications: pubs });
  } catch (e) { next(e); }
});

/** Création d'un étudiant par l'admin (avec compte). */
r.post('/students', async (req, res, next) => {
  try {
    const b = req.body || {};
    for (const f of ['first_name', 'last_name', 'email', 'matricule']) if (!str(b[f])) throw badRequest(`Champ manquant : ${f}`);
    const password = str(b.password) || 'etudiant123';
    const info = await tx(async () => {
      const ui = await db.prepare('INSERT INTO users (email, password_hash, role, first_name, last_name) VALUES (?,?,?, ?, ?)')
        .run(b.email.trim().toLowerCase(), bcrypt.hashSync(password, 10), 'student', b.first_name.trim(), b.last_name.trim());
      await db.prepare('INSERT INTO students (user_id, matricule, program_id, level_id, class_id, academic_year_id) VALUES (?,?,?,?,?,?)')
        .run(ui.lastInsertRowid, b.matricule.trim(), num(b.program_id), num(b.level_id), num(b.class_id), num(b.academic_year_id));
      return ui;
    });
    res.status(201).json({ id: info.lastInsertRowid, generated_password: str(b.password) ? null : password });
  } catch (e) { next(e); }
});

/** Mise à jour du profil / scolarité d'un étudiant. */
r.put('/students/:id', async (req, res, next) => {
  try {
    const s = await db.prepare('SELECT * FROM students WHERE id=?').get(req.params.id);
    if (!s) throw notFound('Étudiant introuvable');
    const b = req.body || {};
    await tx(async () => {
      if (b.first_name || b.last_name || b.email) {
        await db.prepare(`UPDATE users SET first_name=COALESCE(?,first_name), last_name=COALESCE(?,last_name), email=COALESCE(?,email) WHERE id=?`)
          .run(str(b.first_name), str(b.last_name), b.email ? str(b.email).toLowerCase() : null, s.user_id);
      }
      await db.prepare(`UPDATE students SET matricule=COALESCE(?,matricule), program_id=COALESCE(?,program_id), level_id=COALESCE(?,level_id),
        class_id=COALESCE(?,class_id), academic_year_id=COALESCE(?,academic_year_id) WHERE id=?`)
        .run(str(b.matricule), num(b.program_id), num(b.level_id), num(b.class_id), num(b.academic_year_id), s.id);
      if (b.reset_password) await db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(bcrypt.hashSync(String(b.reset_password), 10), s.user_id);
    });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

/** Activation / désactivation du compte. */
r.put('/students/:id/active', async (req, res, next) => {
  try {
    const s = await db.prepare('SELECT * FROM students WHERE id=?').get(req.params.id);
    if (!s) throw notFound();
    await db.prepare('UPDATE users SET is_active=? WHERE id=?').run(req.body?.is_active ? 1 : 0, s.user_id);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

/** Suppression (avec confirmation explicite côté client). */
r.delete('/students/:id', async (req, res, next) => {
  try {
    if (req.body?.confirm !== true) throw badRequest('Suppression non confirmée');
    const s = await db.prepare('SELECT * FROM students WHERE id=?').get(req.params.id);
    if (!s) throw notFound();
    await db.prepare('DELETE FROM users WHERE id=?').run(s.user_id); // cascade : étudiants, notes…
    res.json({ ok: true });
  } catch (e) { next(e); }
});

/** Correction d'une note OFFICIELLE (bloquée si le semestre est verrouillé). */
r.put('/students/:id/grades/:courseId', async (req, res, next) => {
  try {
    const s = await db.prepare('SELECT * FROM students WHERE id=?').get(req.params.id);
    if (!s) throw notFound('Étudiant introuvable');
    const course = await db.prepare(`SELECT c.id, u.semester_id FROM courses c JOIN units u ON u.id=c.unit_id WHERE c.id=?`).get(Number(req.params.courseId));
    if (!course) throw notFound('Matière inconnue');
    const pub = await db.prepare(`SELECT status FROM publications WHERE semester_id=?`).get(course.semester_id);
    if (pub?.status === 'locked') throw new ApiError(409, 'Semestre verrouillé : déverrouillez-le avant de corriger les notes officielles.');
    const sc = (v) => { const n = num(v); if (n !== null && (n < 0 || n > 20)) throw badRequest('Note hors plage 0-20'); return n; };
    await db.prepare(`INSERT INTO grades (student_id, course_id, source, normal, rattrapage, updated_at)
      VALUES (?,?,'official',?,?,datetime('now'))
      ON CONFLICT(student_id, course_id, source)
      DO UPDATE SET normal=excluded.normal, rattrapage=excluded.rattrapage, updated_at=datetime('now')`)
      .run(s.id, course.id, sc(req.body?.normal ?? null), sc(req.body?.rattrapage ?? null));
    res.json({ ok: true });
  } catch (e) { next(e); }
});

/* ------------------------------------------------------------------ */
/* Modèles de relevés                                                   */
/* ------------------------------------------------------------------ */
r.get('/templates', async (_req, res) => {
  res.json(await db.prepare(`
    SELECT t.*, p.name AS program, l.name AS level, y.label AS year,
      (SELECT COUNT(*) FROM semesters s WHERE s.template_id=t.id) AS n_semesters,
      (SELECT COUNT(*) FROM units u JOIN semesters s2 ON s2.id=u.semester_id WHERE s2.template_id=t.id) AS n_units,
      (SELECT COUNT(*) FROM courses c JOIN units u2 ON u2.id=c.unit_id JOIN semesters s3 ON s3.id=u2.semester_id WHERE s3.template_id=t.id) AS n_courses
    FROM templates t JOIN programs p ON p.id=t.program_id JOIN levels l ON l.id=t.level_id
    LEFT JOIN academic_years y ON y.id=t.academic_year_id ORDER BY l.ord, p.name, y.label`).all());
});

r.post('/templates', async (req, res, next) => {
  try {
    const b = req.body || {};
    if (!num(b.program_id) || !num(b.level_id) || !num(b.academic_year_id)) throw badRequest('program_id, level_id et academic_year_id sont requis');
    const name = str(b.name) || (async () => {
      const p = (await db.prepare('SELECT name FROM programs WHERE id=?').get(b.program_id))?.name;
      const l = (await db.prepare('SELECT name FROM levels WHERE id=?').get(b.level_id))?.name;
      return `${l} — ${p}`;
    })();
    const info = await db.prepare('INSERT INTO templates (program_id, level_id, academic_year_id, name, rules_json) VALUES (?,?,?,?,?)')
      .run(b.program_id, b.level_id, b.academic_year_id, name, JSON.stringify(b.rules || {}));
    res.status(201).json({ id: info.lastInsertRowid });
  } catch (e) { next(e); }
});

r.get('/templates/:id', async (req, res, next) => {
  const t = await db.prepare(`SELECT t.*, p.name AS program, l.name AS level, y.label AS year
    FROM templates t JOIN programs p ON p.id=t.program_id JOIN levels l ON l.id=t.level_id
    LEFT JOIN academic_years y ON y.id=t.academic_year_id WHERE t.id=?`).get(req.params.id);
  if (!t) throw notFound('Modèle introuvable');
  t.semesters = await loadTemplateTree(t.id);
  t.rules = resolveRules(t);
  for (const s of t.semesters) s.publication = await db.prepare('SELECT status, published_at FROM publications WHERE semester_id=?').get(s.id) || { status: 'draft' };
  res.json(t);
});

r.put('/templates/:id', async (req, res, next) => {
  try {
    const b = req.body || {};
    const sets = [], params = [];
    if (b.name != null) { sets.push('name=?'); params.push(str(b.name)); }
    if (b.program_id != null) { sets.push('program_id=?'); params.push(num(b.program_id)); }
    if (b.level_id != null) { sets.push('level_id=?'); params.push(num(b.level_id)); }
    if (b.academic_year_id != null) { sets.push('academic_year_id=?'); params.push(num(b.academic_year_id)); }
    if (b.rules !== undefined) { sets.push('rules_json=?'); params.push(JSON.stringify(b.rules)); }
    if (!sets.length) throw badRequest('Rien à modifier');
    params.push(req.params.id);
    await db.prepare(`UPDATE templates SET ${sets.join(',')}, updated_at=datetime('now') WHERE id=?`).run(...params);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

r.delete('/templates/:id', async (req, res, next) => {
  try {
    if (req.body?.confirm !== true) throw badRequest('Suppression non confirmée');
    await db.prepare('DELETE FROM templates WHERE id=?').run(req.params.id); // cascade semestres/UE/cours/publications
    res.json({ ok: true });
  } catch (e) { next(e); }
});

/* Semestres / UE / matières ------------------------------------------------- */
r.post('/templates/:id/semesters', async (req, res, next) => {
  try {
    const b = req.body || {};
    const number = num(b.number);
    if (number == null) throw badRequest('numéro de semestre requis');
    const ord = num(b.ord) ?? ((await db.prepare('SELECT COALESCE(MAX(ord),0)+1 o FROM semesters WHERE template_id=?').get(req.params.id)).o);
    const info = await db.prepare('INSERT INTO semesters (template_id, number, name, ects_expected, ord) VALUES (?,?,?,?,?)')
      .run(req.params.id, number, str(b.name) || `Semestre ${number}`, num(b.ects_expected) ?? 30, ord);
    res.status(201).json({ id: info.lastInsertRowid });
  } catch (e) { next(e); }
});
r.put('/semesters/:id', async (req, res, next) => {
  try {
    const b = req.body || {};
    await db.prepare('UPDATE semesters SET number=COALESCE(?,number), name=COALESCE(?,name), ects_expected=COALESCE(?,ects_expected) WHERE id=?')
      .run(num(b.number), str(b.name), num(b.ects_expected), req.params.id);
    res.json({ ok: true });
  } catch (e) { next(e); }
});
r.delete('/semesters/:id', async (req, res, next) => {
  try { await db.prepare('DELETE FROM semesters WHERE id=?').run(req.params.id); res.json({ ok: true }); } catch (e) { next(e); }
});

r.post('/semesters/:id/units', async (req, res, next) => {
  try {
    const b = req.body || {};
    if (!str(b.code)) throw badRequest('code UE requis');
    const ord = num(b.ord) ?? ((await db.prepare('SELECT COALESCE(MAX(ord),0)+1 o FROM units WHERE semester_id=?').get(req.params.id)).o);
    const info = await db.prepare('INSERT INTO units (semester_id, code, name, ord) VALUES (?,?,?,?)').run(req.params.id, b.code.trim(), str(b.name) || b.code.trim(), ord);
    res.status(201).json({ id: info.lastInsertRowid });
  } catch (e) { next(e); }
});
r.put('/units/:id', async (req, res, next) => {
  try {
    const b = req.body || {};
    await db.prepare('UPDATE units SET code=COALESCE(?,code), name=COALESCE(?,name) WHERE id=?').run(str(b.code), str(b.name), req.params.id);
    res.json({ ok: true });
  } catch (e) { next(e); }
});
r.delete('/units/:id', async (req, res, next) => {
  try { await db.prepare('DELETE FROM units WHERE id=?').run(req.params.id); res.json({ ok: true }); } catch (e) { next(e); }
});

r.post('/units/:id/courses', async (req, res, next) => {
  try {
    const b = req.body || {};
    if (!str(b.name)) throw badRequest('nom de matière requis');
    const ord = num(b.ord) ?? ((await db.prepare('SELECT COALESCE(MAX(ord),0)+1 o FROM courses WHERE unit_id=?').get(req.params.id)).o);
    const info = await db.prepare('INSERT INTO courses (unit_id, name, coefficient, credits, ord) VALUES (?,?,?,?,?)')
      .run(req.params.id, b.name.trim(), num(b.coefficient) ?? 1, num(b.credits) ?? 1, ord);
    res.status(201).json({ id: info.lastInsertRowid });
  } catch (e) { next(e); }
});
r.put('/courses/:id', async (req, res, next) => {
  try {
    const b = req.body || {};
    await db.prepare('UPDATE courses SET name=COALESCE(?,name), coefficient=COALESCE(?,coefficient), credits=COALESCE(?,credits), unit_id=COALESCE(?,unit_id) WHERE id=?')
      .run(str(b.name), num(b.coefficient), num(b.credits), num(b.unit_id), req.params.id);
    res.json({ ok: true });
  } catch (e) { next(e); }
});
r.delete('/courses/:id', async (req, res, next) => {
  try { await db.prepare('DELETE FROM courses WHERE id=?').run(req.params.id); res.json({ ok: true }); } catch (e) { next(e); }
});

/* ------------------------------------------------------------------ */
/* Publication / verrouillage des résultats officiels                   */
/* ------------------------------------------------------------------ */
/** POST /api/admin/semesters/:id/publish {action: publish|lock|unlock|draft} */
r.post('/semesters/:id/publication', async (req, res, next) => {
  try {
    const sem = await db.prepare(`SELECT s.*, t.id AS tid FROM semesters s JOIN templates t ON t.id=s.template_id WHERE s.id=?`).get(req.params.id);
    if (!sem) throw notFound('Semestre introuvable');
    const action = str(req.body?.action);
    const current = await db.prepare('SELECT * FROM publications WHERE semester_id=?').get(sem.id);
    if (action === 'draft' || action === 'unpublish') {
      await db.prepare('DELETE FROM publications WHERE semester_id=?').run(sem.id);
      return res.json({ ok: true, status: 'draft' });
    }
    if (action === 'lock') {
      if (!current) throw badRequest('Publiez d’abord les résultats avant de les verrouiller');
      await db.prepare(`UPDATE publications SET status='locked' WHERE semester_id=?`).run(sem.id);
      return res.json({ ok: true, status: 'locked' });
    }
    if (action === 'unlock') {
      if (current?.status !== 'locked') throw badRequest('Ce semestre n’est pas verrouillé');
      await db.prepare(`UPDATE publications SET status='published' WHERE semester_id=?`).run(sem.id);
      return res.json({ ok: true, status: 'published' });
    }
    // publish : calcule et fige un snapshot des résultats officiels de tous les étudiants du modèle
    const template = await db.prepare('SELECT * FROM templates WHERE id=?').get(sem.tid);
    const tree = await loadTemplateTree(template.id);
    const semTree = tree.find((s) => s.id === sem.id);
    const students = await db.prepare('SELECT id FROM students WHERE program_id=? AND level_id=?').all(template.program_id, template.level_id);
    const snapshot = {};
    for (const st of students) {
      const ids = semTree.units.flatMap((u) => u.courses.map((c) => c.id));
      const m = new Map();
      if (ids.length) {
        const marks = ids.map(() => '?').join(',');
        for (const row of await db.prepare(`SELECT course_id, normal, rattrapage FROM grades WHERE student_id=? AND source='official' AND course_id IN (${marks})`).all(st.id, ...ids)) m.set(row.course_id, row);
      }
      const fakeSem = computeReleve(template, [semTree], m);
      snapshot[st.id] = { average: fakeSem.semesters[0]?.average ?? null, creditsEarned: fakeSem.semesters[0]?.creditsEarned ?? 0 };
    }
    await tx(async () => {
      await db.prepare(`INSERT INTO publications (semester_id, status, published_by, published_at, snapshot_json)
        VALUES (?,'published',?,datetime('now'),?)
        ON CONFLICT(semester_id) DO UPDATE SET status='published', published_by=excluded.published_by,
          published_at=datetime('now'), snapshot_json=excluded.snapshot_json`).run(sem.id, req.user.id, JSON.stringify({ published: true, semester: snapshot }));
    });
    res.json({ ok: true, status: 'published', students: students.length });
  } catch (e) { next(e); }
});

/* Admin : saisir en lot les notes officielles d'un semestre {grades:{courseId:{normal,rattrapage}}} */
r.post('/students/:id/official-grades', async (req, res, next) => {
  try {
    const s = await db.prepare('SELECT * FROM students WHERE id=?').get(req.params.id);
    if (!s) throw notFound('Étudiant introuvable');
    const sc = (v) => { const n = num(v); if (n !== null && (n < 0 || n > 20)) throw badRequest('Note hors plage 0-20'); return n; };
    const entries = Object.entries(req.body?.grades || {});
    if (!entries.length) throw badRequest('Aucune saisie reçue');
    const blocked = new Set();
    await tx(async () => {
      for (const [cid, g] of entries) {
        const course = await db.prepare(`SELECT c.id, u.semester_id FROM courses c JOIN units u ON u.id=c.unit_id WHERE c.id=?`).get(Number(cid));
        if (!course) throw notFound('Matière inconnue : ' + cid);
        const pub = await db.prepare('SELECT status FROM publications WHERE semester_id=?').get(course.semester_id);
        if (pub?.status === 'locked') { blocked.add(Number(cid)); continue; }
        await db.prepare(`INSERT INTO grades (student_id, course_id, source, normal, rattrapage, updated_at)
          VALUES (?,?,'official',?,?,datetime('now'))
          ON CONFLICT(student_id, course_id, source)
          DO UPDATE SET normal=excluded.normal, rattrapage=excluded.rattrapage, updated_at=datetime('now')`)
          .run(s.id, course.id, sc(g.normal ?? null), sc(g.rattrapage ?? null));
      }
    });
    res.json({ ok: true, blocked: [...blocked] });
  } catch (e) { next(e); }
});

export default r;
