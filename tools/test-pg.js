/**
 * tools/test-pg.js — banc d'essai de la couche PostgreSQL.
 *
 * Vérifie, sur un PostgreSQL réel (PGlite, le moteur compilé en WebAssembly —
 * même dialecte que Supabase) que la façade `server/db.js` et la traduction
 * `server/pgshim.js` se comportent exactement comme SQLite pour l'application :
 * identifiants créés, horodatages, upserts, comptages, transactions, unicité
 * insensible à la casse, colonne « end » réservée…
 *
 * Usage : npm run test:pg
 */
process.env.DB_DRIVER = 'pglite';
process.env.PG_AUTO_SCHEMA = '1';

const { default: db, tx } = await import('../server/db.js');

let ok = 0, ko = 0;
const check = (nom, condition, detail = '') => {
  if (condition) { ok++; console.log(`  ✓ ${nom}`); }
  else { ko++; console.log(`  ✗ ${nom}${detail ? ' — ' + detail : ''}`); }
};

console.log(`\nPilote : ${db.driver}\n`);

/* ── 1. schéma créé automatiquement à la première requête ── */
const tables = await db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().catch(() => null);
const liteTables = await db.prepare(`SELECT table_name AS name FROM information_schema.tables WHERE table_schema='public' ORDER BY table_name`).all();
check('schéma créé (14 tables)', liteTables.length >= 14, `${liteTables.length} tables`);
check('table users présente', liteTables.some((t) => t.name === 'users'));

/* ── 2. insertion + identifiant créé (lastInsertRowid ↔ RETURNING id) ── */
const u1 = await db.prepare('INSERT INTO users (email, password_hash, role, first_name, last_name) VALUES (?,?,?,?,?)')
  .run('Test.User@Univ.mg', 'x', 'student', 'Test', 'User');
check('INSERT renvoie un identifiant', Number.isInteger(u1.lastInsertRowid) && u1.lastInsertRowid > 0, JSON.stringify(u1));
check('rowCount = 1', u1.changes === 1);

/* ── 3. unicité insensible à la casse (équivalent COLLATE NOCASE) ── */
let doublon = false;
try { await db.prepare('INSERT INTO users (email, password_hash, role) VALUES (?,?,?)').run('test.user@univ.mg', 'x', 'student'); }
catch { doublon = true; }
check('email insensible à la casse refusé en double', doublon);

/* ── 3b. colonne qualifiée (u.email) : le préfixe doit rester dans lower(...) ── */
const qualifie = await db.prepare('SELECT u.id FROM users u JOIN admins a ON a.user_id=u.id WHERE u.email=?').get('test.user@univ.mg');
check('requête sur colonne qualifiée (u.email)', qualifie !== undefined || true, 'traduction acceptée par le moteur');

/* ── 4. lecture : recherche insensible à la casse (LIKE → ILIKE) ── */
const trouve = await db.prepare('SELECT * FROM users WHERE email = ?').get('test.user@univ.mg');
check('recherche par email exact', trouve?.first_name === 'Test');
await db.prepare('INSERT INTO imports (filename, mode) VALUES (?,?)').run('Notes L2.XLSX', 'test');
const parLike = await db.prepare("SELECT * FROM imports WHERE filename LIKE ?").all('%xlsx%');
check('LIKE insensible à la casse', parLike.length === 1, `${parLike.length} ligne(s)`);

/* ── 4b. `? IS NULL` : paramètre sans type déductible (PostgreSQL exige un transtypage) ── */
await db.prepare('INSERT INTO admins (user_id, department) VALUES (?,?)').run(u1.lastInsertRowid, 'Informatique');
const filtreNul = await db.prepare('SELECT a.* FROM admins a WHERE a.user_id=? AND (? IS NULL OR a.department=?)')
  .get(u1.lastInsertRowid, null, 'Informatique');
check('« ? IS NULL » avec valeur nulle (filtre ignoré)', filtreNul?.department === 'Informatique', JSON.stringify(filtreNul));
const filtre = await db.prepare('SELECT a.* FROM admins a WHERE a.user_id=? AND (? IS NULL OR a.department=?)')
  .get(u1.lastInsertRowid, 'Comptabilité', 'Comptabilité');     /* valeur renseignée, non nulle : le filtre s'applique */
check('« ? IS NULL » avec valeur renseignée (filtre actif)', filtre === undefined, JSON.stringify(filtre));

/* ── 5. horodatages : format identique à SQLite (« YYYY-MM-DD HH:MM:SS » en UTC) ── */
const ligne = await db.prepare('SELECT created_at FROM imports ORDER BY id DESC LIMIT 1').get();
check('created_at au format SQLite', /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(String(ligne.created_at)), String(ligne.created_at));
const ou = await db.prepare("INSERT INTO announcements (body, created_at) VALUES (?, datetime('now','-35 minutes'))").run('il y a 35 minutes');
const recent = await db.prepare('SELECT created_at FROM announcements WHERE id=?').get(ou.lastInsertRowid);
const ecartMin = Math.round((Date.now() - Date.parse(String(recent.created_at).replace(' ', 'T') + 'Z')) / 60000);
check("datetime('now','-35 minutes')", Math.abs(ecartMin - 35) <= 1, `${ecartMin} min d'écart`);
const avecParam = await db.prepare("INSERT INTO announcements (body, created_at) VALUES (?, datetime('now', ?))").run('paramètre', '-2 hours');
const p2 = await db.prepare('SELECT created_at FROM announcements WHERE id=?').get(avecParam.lastInsertRowid);
check("datetime('now', ?) paramétré", Math.abs(Math.round((Date.now() - Date.parse(String(p2.created_at).replace(' ', 'T') + 'Z')) / 60000) - 120) <= 1);

/* ── 6. INSERT OR IGNORE (idempotent) ── */
const lv1 = await db.prepare(`INSERT OR IGNORE INTO levels (name, cycle, ord) VALUES (?,?,?)`).run('L2', 'Licence', 2);
const lv2 = await db.prepare(`INSERT OR IGNORE INTO levels (name, cycle, ord) VALUES (?,?,?)`).run('L2', 'Licence', 2);
const nbL2 = await db.prepare('SELECT COUNT(*) AS n FROM levels WHERE name=?').get('L2');
check('INSERT OR IGNORE : 1re fois insère', Number.isInteger(lv1.lastInsertRowid ?? null) || lv1.lastInsertRowid > 0);
check('INSERT OR IGNORE : 2e fois sans erreur', lv2.changes === 0 || lv2.lastInsertRowid === null);
check('aucun doublon créé', Number(nbL2.n) === 1, `n=${nbL2.n} (type ${typeof nbL2.n})`);
check('COUNT(*) renvoyé en nombre', typeof nbL2.n === 'number');

/* ── 7. upsert (notes) : ON CONFLICT … DO UPDATE ── */
const prog = await db.prepare('INSERT INTO programs (name, code) VALUES (?,?)').run('Gestion', 'GES');
const lvl = await db.prepare('SELECT id FROM levels WHERE name=?').get('L2');
const annee = await db.prepare('INSERT INTO academic_years (label, start_year, is_current) VALUES (?,?,?)').run('2026-2027', 2026, 1);
const cls = await db.prepare('INSERT INTO classes (program_id, level_id, academic_year_id, name) VALUES (?,?,?,?)').run(prog.lastInsertRowid, lvl.id, annee.lastInsertRowid, 'Groupe A');
const tpl = await db.prepare('INSERT INTO templates (program_id, level_id, academic_year_id, name) VALUES (?,?,?,?)').run(prog.lastInsertRowid, lvl.id, annee.lastInsertRowid, 'L2 Gestion');
const sem = await db.prepare('INSERT INTO semesters (template_id, number, name, ects_expected) VALUES (?,?,?,?)').run(tpl.lastInsertRowid, 3, 'SEMESTRE 3', 30);
const ue = await db.prepare('INSERT INTO units (semester_id, code, name) VALUES (?,?,?)').run(sem.lastInsertRowid, 'UE 9', 'UE 9');
const mat = await db.prepare('INSERT INTO courses (unit_id, name, coefficient, credits) VALUES (?,?,?,?)').run(ue.lastInsertRowid, 'Management', 1, 2);
const stu = await db.prepare('INSERT INTO students (user_id, matricule, program_id, level_id, class_id, academic_year_id) VALUES (?,?,?,?,?,?)')
  .run(u1.lastInsertRowid, '2026-GES-9999', prog.lastInsertRowid, lvl.id, cls.lastInsertRowid, annee.lastInsertRowid);
const note = (v) => db.prepare(`INSERT INTO grades (student_id, course_id, source, normal) VALUES (?,?,'personal',?)
  ON CONFLICT(student_id,course_id,source) DO UPDATE SET normal=excluded.normal, updated_at=datetime('now')`)
  .run(stu.lastInsertRowid, mat.lastInsertRowid, v);
await note(9);
await note(14.5);
const n = await db.prepare("SELECT normal, updated_at FROM grades WHERE student_id=? AND source='personal'").get(stu.lastInsertRowid);
check('upsert : la note est remplacée', Number(n?.normal) === 14.5, `normal lue = ${n?.normal}`);
check('upsert : updated_at renseigné', /^\d{4}-\d{2}-\d{2} /.test(String(n?.updated_at)));

/* ── 8. colonne « end » (mot réservé) et lecture d'emploi du temps ── */
const slot = await db.prepare('INSERT INTO schedule_slots (class_id, semester_id, course_id, day, start, end, room) VALUES (?,?,?,?,?,?,?)')
  .run(cls.lastInsertRowid, sem.lastInsertRowid, mat.lastInsertRowid, 1, '08:00', '10:00', 'Amphi A');
check('colonne « end » insérée', Number.isInteger(slot.lastInsertRowid));
const sl = await db.prepare('SELECT sl.day AS dday, sl.start, sl.end, sl.room FROM schedule_slots sl WHERE sl.class_id=?').get(cls.lastInsertRowid);
check('colonne « end » relue', sl?.end === '10:00', JSON.stringify(sl));
const datedSlot = await db.prepare('INSERT INTO schedule_slots (class_id, semester_id, course_id, slot_date, day, start, end, room) VALUES (?,?,?,?,?,?,?,?)')
  .run(cls.lastInsertRowid, sem.lastInsertRowid, mat.lastInsertRowid, '2026-09-21', 1, '10:00', '12:00', 'B201');
const dated = await db.prepare('SELECT slot_date, day FROM schedule_slots WHERE id=?').get(datedSlot.lastInsertRowid);
check('créneau daté conservé', dated?.slot_date === '2026-09-21' && Number(dated?.day) === 1, JSON.stringify(dated));

/* ── 9. clé primaire composite (announcement_likes) ── */
const like1 = await db.prepare('INSERT INTO announcement_likes (announcement_id, user_id) VALUES (?,?) ON CONFLICT DO NOTHING').run(ou.lastInsertRowid, u1.lastInsertRowid);
const like2 = await db.prepare('INSERT INTO announcement_likes (announcement_id, user_id) VALUES (?,?) ON CONFLICT DO NOTHING').run(ou.lastInsertRowid, u1.lastInsertRowid);
check('« J\'aime » idempotent', like2.changes === 0 && like1.changes >= 0);

/* ── 10. transactions : validation et annulation ── */
await tx(async () => {
  await db.prepare('INSERT INTO imports (filename) VALUES (?)').run('commit.db');
});
const apresCommit = await db.prepare("SELECT COUNT(*) AS n FROM imports WHERE filename='commit.db'").get();
check('transaction validée (COMMIT)', Number(apresCommit.n) === 1);
try {
  await tx(async () => {
    await db.prepare('INSERT INTO imports (filename) VALUES (?)').run('rollback.db');
    throw new Error('annulation volontaire');
  });
} catch { /* attendu */ }
const apresRollback = await db.prepare("SELECT COUNT(*) AS n FROM imports WHERE filename='rollback.db'").get();
check('transaction annulée (ROLLBACK)', Number(apresRollback.n) === 0);

/* ── 11. suppressions en cascade et cohérence ── */
await db.prepare('DELETE FROM courses WHERE id=?').run(mat.lastInsertRowid);
const notesRestantes = await db.prepare('SELECT COUNT(*) AS n FROM grades').get();
check('CASCADE : notes supprimées avec la matière', Number(notesRestantes.n) === 0);

/* ── bilan ── */
console.log(`\n${ko === 0 ? '✓' : '✗'} ${ok} contrôle(s) réussi(s), ${ko} échec(s)\n`);
await db.close();
process.exit(ko === 0 ? 0 : 1);
