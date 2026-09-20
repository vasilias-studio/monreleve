/* Référentiels académiques partagés.
 * La base conserve la table classes pour la compatibilité des anciennes données,
 * mais l'interface ne demande plus de choisir une classe : une seule ligne est
 * automatiquement retenue pour chaque filière, niveau et année. */
import db from './db.js';

export async function resolveAcademicClass(programId, levelId, academicYearId = null) {
  const p = Number(programId);
  const l = Number(levelId);
  const y = academicYearId == null || academicYearId === '' ? null : Number(academicYearId);
  if (!Number.isFinite(p) || !Number.isFinite(l)) return null;
  if (Number.isFinite(y)) {
    return await db.prepare(`SELECT c.id, c.program_id, c.level_id, c.academic_year_id, c.name,
        l.name AS level_name, p.name AS program_name
      FROM classes c
      JOIN levels l ON l.id=c.level_id
      JOIN programs p ON p.id=c.program_id
      WHERE c.program_id=? AND c.level_id=?
        AND (c.academic_year_id=? OR c.academic_year_id IS NULL)
      ORDER BY CASE WHEN c.academic_year_id=? THEN 0 ELSE 1 END, c.id
      LIMIT 1`).get(p, l, y, y);
  }
  return await db.prepare(`SELECT c.id, c.program_id, c.level_id, c.academic_year_id, c.name,
      l.name AS level_name, p.name AS program_name
    FROM classes c
    JOIN levels l ON l.id=c.level_id
    JOIN programs p ON p.id=c.program_id
    WHERE c.program_id=? AND c.level_id=?
    ORDER BY c.id
    LIMIT 1`).get(p, l);
}

export async function resolveAcademicClassForStudent(student) {
  return await resolveAcademicClass(student?.program_id, student?.level_id, student?.academic_year_id);
}
