/**
 * schedule.js — emploi du temps (timetable).
 * Les créneaux sont une donnée administrateur (Admin → Calendrier).
 * ensureSchedule() ne génère un horaire de démonstration cohérent que si la
 * table est VIDE (première fois) ; il ne touche jamais aux données saisies.
 */
import db, { tx } from './db.js';

export async function ensureSchedule() {
  if ((await db.prepare('SELECT COUNT(*) n FROM schedule_slots').get()).n > 0) return 0;
  /* Un calendrier vidé par l'administration doit rester vide après un redémarrage.
     Le remplissage de démonstration reste disponible explicitement via
     tools/seed-emploi.js, jamais au démarrage d'une instance Vercel. */
  if (process.env.SEED_DEMO_SCHEDULE !== '1') return 0;
  return await tx(async () => {
    let made = 0;
    const templates = await db.prepare(`
      SELECT t.id AS tid, c.id AS class_id FROM templates t
      JOIN classes c ON c.program_id=t.program_id AND c.level_id=t.level_id AND c.academic_year_id=t.academic_year_id`).all();
    const semsQ = await db.prepare('SELECT id FROM semesters WHERE template_id=? ORDER BY ord');
    const coursesQ = await db.prepare(`SELECT c.id FROM courses c JOIN units u ON c.unit_id=u.id WHERE u.semester_id=? ORDER BY c.id`);
    const ins = await db.prepare(`INSERT INTO schedule_slots (class_id, semester_id, course_id, day, start, end, room) VALUES (?,?,?,?,?,?,?)`);
    const ROOMS = ['A101', 'A102', 'B201', 'B202', 'C301'];
    const STARTS = ['08:00', '10:00', '12:00', '14:00', '16:00']; // 2 h par créneau
    for (const t of templates) {
      for (const sm of await semsQ.all(t.tid)) {
        const courses = await coursesQ.all(sm.id);
        let i = 0;
        for (const c of courses) {
          const st = STARTS[i % STARTS.length];
          const endH = String(+st.slice(0, 2) + 2).padStart(2, '0');
          await ins.run(t.class_id, sm.id, c.id, (i % 5) + 1, st, `${endH}:00`, ROOMS[i % ROOMS.length]);
          made++;
          i++;
        }
      }
    }
    return made;
  });
}
