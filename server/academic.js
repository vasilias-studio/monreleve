/* Référentiels académiques partagés.
 * La base conserve la table classes pour la compatibilité des anciennes données,
 * mais l'interface ne demande plus de choisir une classe : une seule ligne est
 * automatiquement retenue ou créée pour chaque filière, niveau et année.
 */
import db from './db.js';

const finiteId = (value) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
};

/**
 * Résout la structure technique d'un étudiant ou d'un emploi du temps.
 * Les anciennes lignes sont privilégiées afin de conserver leurs créneaux.
 * Si aucun rattachement n'existe encore, une ligne technique est créée sans
 * jamais être proposée à l'utilisateur comme un choix de classe ou de groupe.
 */
export async function resolveAcademicClass(programId, levelId, academicYearId = null) {
  const p = finiteId(programId);
  const l = finiteId(levelId);
  if (!p || !l) return null;

  let y = finiteId(academicYearId);
  if (!y) y = (await db.prepare('SELECT id FROM academic_years WHERE is_current=1 ORDER BY id DESC LIMIT 1').get())?.id ?? null;

  const find = async () => {
    if (y) {
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
  };

  const existing = await find();
  if (existing) return existing;

  /* Do not invent a visible label. This is only a compatibility owner for
     schedule_slots and legacy students when the referential row is missing. */
  const autoName = `__auto_${p}_${l}_${y || 'default'}__`;
  const validPair = await db.prepare(`SELECT p.id AS program_id, l.id AS level_id
    FROM programs p CROSS JOIN levels l WHERE p.id=? AND l.id=?`).get(p, l);
  if (!validPair) return null;
  try {
    await db.prepare(`INSERT INTO classes (program_id, level_id, academic_year_id, name)
      VALUES (?,?,?,?) ON CONFLICT DO NOTHING`).run(p, l, y, autoName);
  } catch (e) {
    /* A concurrent serverless request may have inserted the same owner first. */
    if (!/duplicate|unique|conflict/i.test(String(e?.message || e))) throw e;
  }
  return await find();
}

export async function resolveAcademicClassForStudent(student) {
  return await resolveAcademicClass(student?.program_id, student?.level_id, student?.academic_year_id);
}
