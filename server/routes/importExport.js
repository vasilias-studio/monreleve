/**
 * routes/importExport.js — Importation Excel (avec correspondance de colonnes et aperçu)
 * et exports (CSV étudiants, structure d'un modèle, relevé d'un étudiant en xlsx).
 *
 * Flux import :
 *  1) POST /upload  → stocke le fichier, retourne les feuilles, un aperçu brut et des correspondances suggérées
 *  2) POST /analyze → applique le mode (structure relevé | notes plates) + mapping, retourne l'APERCUS complet
 *  3) POST /commit  → réécrit uniquement après confirmation explicite (« confirm:true »), jamais en écrasant
 *                     des données existantes sans accord (conflits signalés dans l'aperçu).
 */
import { asyncRouter } from '../asyncrouter.js';
import multer from 'multer';
import db, { tx } from '../db.js';
import { authRequired, requireRole, badRequest, notFound, ApiError } from '../auth.js';
import { loadSheetCells, loadSheetValues, parseReleveStructure, parseFlatGrades, suggestMapping, readWorkbook, XLSX } from '../releveParser.js';
import { saveUpload, readUpload, dropUpload } from '../uploads.js';
import { computeReleve } from '../compute.js';
import { loadTemplateTree } from './student.js';
import { findTemplateForStudent } from '../routes/student.js';

const r = asyncRouter();
r.use(authRequired, requireRole('admin'));

/* Fichier gardé en mémoire puis rangé dans la base (server/uploads.js) : aucun disque. */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: Number(process.env.UPLOAD_MAX_MB || 12) * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ok = /\.(xlsx|xls)$/i.test(file.originalname);
    cb(ok ? null : badRequest('Format attendu : .xlsx ou .xls'), ok);
  },
});

/** Retrouve un classeur envoyé (contenu stocké en base) — voir server/uploads.js. */
const safeFile = async (fileId) => {
  const fichier = await readUpload(fileId);
  if (!fichier) throw notFound('Fichier import introuvable (ré-uploadez-le)');
  return fichier;
};

/* ------------------------------------------------------------------ */
/* Import                                                               */
/* ------------------------------------------------------------------ */
r.post('/import/upload', upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) throw badRequest('Aucun fichier reçu');
    const p = req.file.buffer;                     /* contenu en mémoire */
    const wb = readWorkbook(p, { cellFormula: true });
    const sheets = wb.SheetNames.map((name) => {
      const ws = wb.Sheets[name];
      const aoa = ws ? XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null }) : [];
      const preview = aoa.slice(0, 12);
      return { name, rows: aoa.length, preview };
    });
    const fileId = await saveUpload(req.file.originalname, req.file.buffer);
    res.json({
      fileId,
      filename: req.file.originalname,
      sheets,
      suggestions: sheets.map((s) => {
        const aoa = XLSX.utils.sheet_to_json(readWorkbook(p).Sheets[s.name], { header: 1, raw: true, defval: null });
        return { sheet: s.name, mapping: suggestMapping(aoa), flat: looksFlat(aoa) };
      }),
    });
  } catch (e) { next(e); }
});

/** Heuristique : tableau plat = en-têtes courts sur une ligne + beaucoup de lignes. */
function looksFlat(aoa) {
  if (aoa.length < 3) return false;
  const first = (aoa[0] || []).filter((v) => v != null && String(v).trim() !== '');
  return first.length >= 3;
}

const normName = (s) => String(s ?? '').trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ');

/** POST /analyze — renvoie l'aperçu complet du résultat de l'import (aucune écriture). */
r.post('/import/analyze', async (req, res, next) => {
  try {
    const { fileId, sheet, mode = 'structure', mapping, targetTemplateId, source = 'official' } = req.body || {};
    const p = (await safeFile(fileId)).content;

    if (mode === 'structure') {
      const { rows } = loadSheetCells(p, sheet);
      const parsed = parseReleveStructure(rows);
      if (!parsed.ok) throw badRequest(parsed.error);
      // Conflits : le modèle cible contient-il déjà une structure ?
      let conflicts = null;
      if (targetTemplateId) {
        const existing = (await db.prepare('SELECT COUNT(*) n FROM semesters WHERE template_id=?').get(Number(targetTemplateId))).n;
        if (existing > 0) conflicts = { replace_structure: existing, message: 'Le modèle cible contient déjà une structure : l’import la remplacera (notes conservées si les matières correspondent).' };
      }
      return res.json({
        mode, parsed, conflicts,
        target: targetTemplateId ? await db.prepare('SELECT id, name FROM templates WHERE id=?').get(Number(targetTemplateId)) : null,
        summary: `${parsed.semesters.length} semestre(s), ${parsed.semesters.reduce((a, s) => a + s.units.length, 0)} UE, ${parsed.semesters.reduce((a, s) => a + s.units.reduce((x, u) => x + u.courses.length, 0), 0)} matière(s) détectés`,
      });
    }

    if (mode === 'grades') {
      if (!targetTemplateId) throw badRequest('Choisissez le modèle de relevé cible');
      const template = await db.prepare('SELECT * FROM templates WHERE id=?').get(Number(targetTemplateId));
      if (!template) throw notFound('Modèle introuvable');
      const tree = await loadTemplateTree(template.id);
      // index matières : nom normalisé -> {course, semester, unit}
      const courseIndex = new Map();
      for (const s of tree) for (const u of s.units) for (const c of u.courses) courseIndex.set(normName(c.name), { course: c, semester: s, unit: u });

      const { aoa } = loadSheetValues(p, sheet);
      const flat = parseFlatGrades(aoa, mapping || {});
      const studentsByMatricule = new Map((await db.prepare('SELECT s.id, s.matricule, u.first_name, u.last_name FROM students s JOIN users u ON u.id=s.user_id').all()).map((s) => [normName(s.matricule), s]));
      const items = (await Promise.all(flat.rows.map(async (row) => {
        const match = courseIndex.get(normName(row.subject));
        const student = row.matricule ? studentsByMatricule.get(normName(row.matricule)) : null;
        let existing = null, conflict = null;
        if (match && student) {
          existing = await db.prepare('SELECT normal, rattrapage FROM grades WHERE student_id=? AND course_id=? AND source=?')
            .get(student.id, match.course.id, source);
          if (existing && (existing.normal != null || existing.rattrapage != null) && (row.normal != null || row.rattrapage != null)) {
            conflict = 'overwrite';
          }
        }
        return { ...row, matched: !!match, student: student ? `${student.first_name} ${student.last_name}` : null, student_id: student?.id ?? null, course_id: match?.course.id ?? null, conflict };
      })));
      const conflictsCount = items.filter((i) => i.conflict).length;
      res.json({
        mode, headerRow: flat.headerRow, items: items.slice(0, 200), total: items.length,
        matched: items.filter((i) => i.matched && i.student_id).length,
        unmatched: items.filter((i) => !i.matched || !i.student_id).length,
        conflicts: conflictsCount ? { overwrite: conflictsCount, message: `${conflictsCount} note(s) existent déjà et seront écrasées si vous confirmez.` } : null,
        target: { id: template.id, name: template.name },
      });
    }
    throw badRequest('Mode inconnu');
  } catch (e) { next(e); }
});

/** POST /commit — écrit réellement, seulement avec confirm === true. */
r.post('/import/commit', async (req, res, next) => {
  try {
    const { fileId, sheet, mode = 'structure', mapping, targetTemplateId, onConflict = 'skip', source = 'official', confirm } = req.body || {};
    if (confirm !== true) throw badRequest('Confirmation requise pour écrire dans la base');
    const p = (await safeFile(fileId)).content;
    let summary = '';

    if (mode === 'structure') {
      let templateId = Number(targetTemplateId) || null;
      if (!templateId) throw badRequest('Choisissez le modèle cible (ou créez-le d’abord dans « Modèles »)');
      const nSem = (await db.prepare('SELECT COUNT(*) n FROM semesters WHERE template_id=?').get(templateId)).n;
      if (nSem > 0 && onConflict !== 'overwrite') throw new ApiError(409, 'Le modèle contient déjà une structure : relancez avec « écraser » confirmé.');
      const { rows } = loadSheetCells(p, sheet);
      const parsed = parseReleveStructure(rows);
      if (!parsed.ok) throw badRequest(parsed.error);

      await tx(async () => {
        if (nSem > 0) await db.prepare('DELETE FROM semesters WHERE template_id=?').run(templateId); // cascade UE/cours/publications ; notes conservées (course_id orphelins supprimés par cascade)
        let sOrd = 0;
        for (const s of parsed.semesters) {
          const si = (await db.prepare('INSERT INTO semesters (template_id, number, name, ects_expected, ord) VALUES (?,?,?,?,?)')
            .run(templateId, s.number, s.name || `Semestre ${s.number}`, s.ects || 30, sOrd++)).lastInsertRowid;
          let uOrd = 0;
          for (const u of s.units) {
            const ui = (await db.prepare('INSERT INTO units (semester_id, code, name, ord) VALUES (?,?,?,?)').run(si, u.code, u.name, uOrd++)).lastInsertRowid;
            let cOrd = 0;
            for (const c of u.courses) {
              await db.prepare('INSERT INTO courses (unit_id, name, coefficient, credits, ord) VALUES (?,?,?,?,?)').run(ui, c.name, c.coefficient ?? 1, c.credits ?? 1, cOrd++);
            }
          }
        }
        await db.prepare('UPDATE templates SET updated_at=datetime(\'now\') WHERE id=?').run(templateId);
      });
      summary = `Structure importée dans le modèle #${templateId} : ${parsed.semesters.length} semestre(s)`;
    } else if (mode === 'grades') {
      const template = await db.prepare('SELECT * FROM templates WHERE id=?').get(Number(targetTemplateId));
      if (!template) throw notFound('Modèle introuvable');
      const tree = await loadTemplateTree(template.id);
      const courseIndex = new Map();
      for (const s of tree) for (const u of s.units) for (const c of u.courses) courseIndex.set(normName(c.name), { course: c, semester: s });
      const studentsByMatricule = new Map((await db.prepare('SELECT id, matricule FROM students').all()).map((s) => [normName(s.matricule), s]));
      const { aoa } = loadSheetValues(p, sheet);
      const flat = parseFlatGrades(aoa, mapping || {});
      let written = 0, skipped = 0, unmatched = 0, createdCourses = 0;
      await tx(async () => {
        for (const row of flat.rows) {
          let match = courseIndex.get(normName(row.subject));
          const student = row.matricule ? studentsByMatricule.get(normName(row.matricule)) : null;
          if (!student) { unmatched++; continue; }
          if (!match) {
            // créer la matière à la volée dans la 1re UE si on l'autorise (sinon ignorée)
            if (!req.body?.createMissingCourses) { unmatched++; continue; }
            const firstSem = tree[0]; const firstUe = firstSem?.units[0];
            if (!firstUe) { unmatched++; continue; }
            const cid = (await db.prepare('INSERT INTO courses (unit_id, name, coefficient, credits, ord) VALUES (?,?,?,?,?)')
              .run(firstUe.id, row.subject, row.coefficient ?? 1, row.credits ?? 1, 999)).lastInsertRowid;
            match = { course: { id: cid }, semester: firstSem };
            courseIndex.set(normName(row.subject), match);
            createdCourses++;
          }
          const pub = await db.prepare('SELECT status FROM publications WHERE semester_id=?').get(match.semester.id);
          if (pub?.status === 'locked') { skipped++; continue; }
          const existing = await db.prepare('SELECT normal, rattrapage FROM grades WHERE student_id=? AND course_id=? AND source=?')
            .get(student.id, match.course.id, source);
          if (existing && (existing.normal != null || existing.rattrapage != null) && onConflict !== 'overwrite') { skipped++; continue; }
          await db.prepare(`INSERT INTO grades (student_id, course_id, source, normal, rattrapage, updated_at)
            VALUES (?,?,?,?, ?, datetime('now'))
            ON CONFLICT(student_id, course_id, source)
            DO UPDATE SET normal=excluded.normal, rattrapage=excluded.rattrapage, updated_at=datetime('now')`)
            .run(student.id, match.course.id, source, row.normal, row.rattrapage);
          written++;
        }
        await db.prepare('INSERT INTO imports (user_id, filename, mode, summary, rows_affected) VALUES (?,?,?,?,?)')
          .run(req.user.id, String(fileId), 'grades', `Import ${source} : ${written} écritures, ${skipped} ignorées, ${unmatched} sans correspondance, ${createdCourses} matières créées`, written);
      });
      summary = `${written} note(s) importée(s) (${source}) · ${skipped} ignorée(s) · ${unmatched} sans correspondance · ${createdCourses} matière(s) créée(s)`;
    } else throw badRequest('Mode inconnu');

    await dropUpload(fileId);                     /* import terminé : le classeur n'a plus à rester stocké */
    res.json({ ok: true, summary });
  } catch (e) { next(e); }
});

/* Journal des imports */
r.get('/import/journal', async (_req, res) => {
  res.json(await db.prepare(`SELECT i.*, u.email AS by_email FROM imports i LEFT JOIN users u ON u.id=i.user_id ORDER BY i.id DESC LIMIT 50`).all());
});

/* ------------------------------------------------------------------ */
/* Exports                                                              */
/* ------------------------------------------------------------------ */
const csv = (rows, headers) => {
  const esc = (v) => { const s = String(v ?? ''); return /[";\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  return [headers.join(';'), ...rows.map((r) => headers.map((h) => esc(typeof h === 'string' ? r[h] : h(r))).join(';'))].join('\n');
};
const sendCsv = (res, name, content) => {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
  res.send('\uFEFF' + content);
};

r.get('/export/students.csv', async (_req, res) => {
  const rows = await db.prepare(`SELECT s.matricule, u.last_name, u.first_name, u.email, p.name AS program, l.name AS level, y.label AS year
    FROM students s JOIN users u ON u.id=s.user_id LEFT JOIN programs p ON p.id=s.program_id
    LEFT JOIN levels l ON l.id=s.level_id
    LEFT JOIN academic_years y ON y.id=s.academic_year_id ORDER BY u.last_name`).all();
  sendCsv(res, 'etudiants.csv', csv(rows, ['matricule', 'last_name', 'first_name', 'email', 'program', 'level', 'year']));
});

r.get('/export/template/:id.csv', async (req, res, next) => {
  try {
    const t = await db.prepare('SELECT * FROM templates WHERE id=?').get(req.params.id);
    if (!t) throw notFound('Modèle introuvable');
    const tree = await loadTemplateTree(t.id);
    const rows = [];
    for (const s of tree) for (const u of s.units) for (const c of u.courses) rows.push({ semestre: s.name, ue: u.code, matiere: c.name, coefficient: c.coefficient, credits: c.credits });
    sendCsv(res, `modele-${t.id}.csv`, csv(rows, ['semestre', 'ue', 'matiere', 'coefficient', 'credits']));
  } catch (e) { next(e); }
});

/** Relevé complet d'un étudiant → .xlsx (source personnelle ou officielle). */
r.get('/export/releve/:studentId.xlsx', async (req, res, next) => {
  try {
    const s = await db.prepare('SELECT * FROM students WHERE id=?').get(req.params.studentId);
    if (!s) throw notFound('Étudiant introuvable');
    const template = await findTemplateForStudent(s);
    if (!template) throw badRequest('Aucun modèle pour cet étudiant');
    const source = req.query.source === 'personal' ? 'personal' : 'official';
    const tree = await loadTemplateTree(template.id);
    const ids = tree.flatMap((x) => x.units.flatMap((u) => u.courses.map((c) => c.id)));
    const m = new Map();
    if (ids.length) {
      const marks = ids.map(() => '?').join(',');
      for (const row of await db.prepare(`SELECT course_id, normal, rattrapage FROM grades WHERE student_id=? AND source=? AND course_id IN (${marks})`).all(s.id, source, ...ids)) m.set(row.course_id, row);
    }
    const computed = computeReleve(template, tree, m);
    const aoa = [
      [`Relevé de notes (${source === 'official' ? 'Résultats officiels' : 'Notes personnelles'}) — MonRelevé`],
      [`Étudiant`, `${s.first_name ?? ''} ${s.last_name ?? ''}`.trim(), `Matricule`, s.matricule],
      [`Modèle`, template.name],
      [],
      ['Semestre', 'UE', 'Matière', 'Note normale', 'Rattrapage', 'Définitive', 'Coefficient', 'Crédit', 'Statut'],
    ];
    for (const sem of computed.semesters) {
      for (const u of sem.units) for (const c of u.courses) {
        aoa.push([sem.name, u.code, c.name, c.normal ?? '', c.rattrapage ?? '', c.definitive ?? '', c.coefficient, c.credits, c.status]);
      }
      aoa.push([sem.name, '', 'MOYENNE', sem.average ?? '', '', '', '', sem.creditsEarned + '/' + (sem.ectsExpected || ''), '']);
    }
    aoa.push([]);
    aoa.push(['MOYENNE GÉNÉRALE', computed.generalAverage ?? '', 'Crédits obtenus', computed.creditsEarned, '/', computed.creditsExpected]);
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Relevé');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="releve-${s.matricule}-${source}.xlsx"`);
    res.send(buf);
  } catch (e) { next(e); }
});

export default r;
