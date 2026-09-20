#!/usr/bin/env node
/* ============================================================
   tools/seed-emploi.js — remplit l'emploi du temps (schedule_slots)
   ------------------------------------------------------------
   Construit une grille hebdomadaire RÉALISTE pour chaque classe :
     · les matières viennent de la base (unités du semestre, dans l'ordre) ;
     · 3 cours par jour (lundi→vendredi) sur les créneaux 08:00, 10:00, 14:00
       — jamais deux cours sur le même horaire ;
     · un créneau libre (« examen ») le samedi matin ;
     · salles réparties de façon déterministe.
   Les semestres sans matière (ex. L1 sans unités saisies) sont signalés
   et laissés vides : on n'invente pas de cours.

   Usage : node tools/seed-emploi.js           (n'écrit rien si la grille est déjà saine)
           node tools/seed-emploi.js --force   (reconstruit la grille)
   ============================================================ */
import db, { tx } from '../server/db.js';

const FORCE = process.argv.includes('--force');
const HOURS = ['08:00', '10:00', '14:00'];       // 3 créneaux de 2 h par jour
const END_OF = { '08:00': '10:00', '10:00': '12:00', '14:00': '16:00' };
const ROOMS = ['Amphi A', 'Amphi B', 'Salle 21', 'Salle 22', 'Labo informatique'];

/** La grille est-elle saine ? (aucun chevauchement jour+horaire sur une même classe/semestre) */
async function gridIsSane(classId, semesterId) {
  const rows = await db.prepare('SELECT day, start, COUNT(*) n FROM schedule_slots WHERE class_id=? AND semester_id=? GROUP BY day, start').all(classId, semesterId);
  if (!rows.length) return false;
  return rows.every((r) => r.n === 1);
}

const classes = await db.prepare('SELECT * FROM classes ORDER BY id').all();
let filled = 0, skipped = 0;
await tx(async () => {
  for (const klass of classes) {
    const template = await db.prepare('SELECT * FROM templates WHERE program_id=? ORDER BY id LIMIT 1').get(klass.program_id);
    if (!template) continue;
    const sems = await db.prepare('SELECT * FROM semesters WHERE template_id=? ORDER BY ord, number').all(template.id);
    for (const sem of sems) {
      const courses = await db.prepare(`
        SELECT c.id, c.name, u.code AS ucode
        FROM courses c JOIN units u ON u.id = c.unit_id
        WHERE u.semester_id = ? ORDER BY u.ord, c.ord, c.id`).all(sem.id);
      if (!courses.length) {                       /* rien à planifier : on ne remplit pas au hasard */
        console.log(`  · classe ${klass.id} (${klass.name}) / ${sem.name} : aucune matière rattachée → laissé vide`);
        skipped++; continue;
      }
      const sane = await gridIsSane(klass.id, sem.id);
      if (sane && !FORCE) { console.log(`  · classe ${klass.id} / ${sem.name} : grille déjà saine (${courses.length} matières) → inchangée`); continue; }

      await db.prepare('DELETE FROM schedule_slots WHERE class_id=? AND semester_id=?').run(klass.id, sem.id);
      const ins = await db.prepare('INSERT INTO schedule_slots (class_id, semester_id, course_id, title, slot_type, day, start, end, room) VALUES (?,?,?,?,?,?,?,?,?)');
      for (let k = 0; k < courses.length; k++) {
        const c = courses[k];
        const day = Math.min(1 + Math.floor(k / HOURS.length), 5);   /* lundi→vendredi */
        const start = HOURS[k % HOURS.length];
        await ins.run(klass.id, sem.id, c.id, null, 'course', day, start, END_OF[start], ROOMS[k % ROOMS.length]);
      }
      /* créneau libre du samedi matin : cas typique d'un intitulé sans matière rattachée */
      await ins.run(klass.id, sem.id, null, 'Examen mi-parcours', 'exam', 6, '08:00', '10:00', 'Amphi A');
      filled++;
      const byDay = await db.prepare('SELECT day, COUNT(*) n FROM schedule_slots WHERE class_id=? AND semester_id=? GROUP BY day ORDER BY day').all(klass.id, sem.id);
      console.log(`  ✓ classe ${klass.id} (${klass.name}) / ${sem.name} : ${courses.length + 1} créneaux — ` +
        byDay.map((d) => `${['lun', 'mar', 'mer', 'jeu', 'ven', 'sam'][d.day - 1]}:${d.n}`).join(' '));
    }
  }
})();

const tot = (await db.prepare('SELECT COUNT(*) c FROM schedule_slots').get()).c;
console.log(`\n${filled} grille(s) remplie(s), ${skipped} laissée(s) vide(s) · ${tot} créneaux en base.`);
if (!filled && !skipped) console.log('Aucune classe en base.');
