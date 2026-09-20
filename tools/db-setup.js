/**
 * tools/db-setup.js — prépare la base PostgreSQL de Supabase depuis votre poste.
 *
 * Pourquoi depuis votre poste : le schéma et le jeu de démonstration ne doivent être
 * exécutés qu'une fois. Sur un hébergement sans serveur, il n'y a pas de terminal pour
 * le faire ; on le fait donc ici, puis l'application ne fait que lire/écrire des données.
 *
 *   npm run pg:schema   → crée les tables (idempotent : « IF NOT EXISTS »)
 *   npm run pg:seed     → schéma puis jeu de données de démonstration (admin, L2, notes)
 *   npm run pg:check    → état de la base : tables, comptes, matières, notes
 *
 * La chaîne de connexion se lit dans DATABASE_URL (fournie par Supabase) :
 *   DATABASE_URL='postgresql://postgres.xxxx:MOTDEPASSE@aws-0-eu-west-3.pooler.supabase.com:6543/postgres'
 *
 * Conseils Supabase :
 *   · utilisez la chaîne « Session pooler » (port 5432) ou « Transaction pooler » (6543) ;
 *   · le mot de passe de la base est celui choisi à la création du projet ;
 *   · l'application se connecte en SSL : rien à configurer, c'est automatique.
 */
if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL est absente.\n'
    + 'Exemple :\n'
    + "  DATABASE_URL='postgresql://postgres.xxx:MOTDEPASSE@aws-0-eu-west-3.pooler.supabase.com:6543/postgres' npm run pg:schema");
  process.exit(1);
}
/* PostgreSQL par défaut ; DB_DRIVER=pglite permet de répéter l'opération sur le moteur
 * de test embarqué (même dialecte) sans toucher à la vraie base. */
process.env.DB_DRIVER = process.env.DB_DRIVER || 'postgres';

const { default: db, tx } = await import('../server/db.js');
void tx;

const action = (process.argv[2] || 'check').toLowerCase();

const compter = async (table) => {
  const r = await db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get();
  return Number(r?.n ?? 0);
};

console.log(`\nConnexion à PostgreSQL… (pilote ${db.driver})`);

async function ensureScheduleDateColumn() {
  try {
    await db.exec('ALTER TABLE schedule_slots ADD COLUMN slot_date TEXT');
  } catch (e) {
    if (!/duplicate column|already exists/i.test(String(e?.message || e))) throw e;
  }
  try {
    await db.exec("ALTER TABLE schedule_slots ADD COLUMN slot_type TEXT NOT NULL DEFAULT 'course'");
  } catch (e) {
    if (!/duplicate column|already exists/i.test(String(e?.message || e))) throw e;
  }
  await db.exec('CREATE INDEX IF NOT EXISTS idx_slots_date ON schedule_slots(class_id, slot_date, start)');
}

if (action === 'schema' || action === 'seed') {
  console.log('· création du schéma (tables, index, contraintes)…');
  await db.exec(db.schema.postgres);
  await ensureScheduleDateColumn();
  const tables = await db.prepare(`SELECT table_name AS nom FROM information_schema.tables WHERE table_schema='public' ORDER BY table_name`).all();
  console.log(`  ${tables.length} table(s) en place : ${tables.map((t) => t.nom).join(', ')}`);
}

if (action === 'seed') {
  const comptes = await compter('users');
  if (comptes > 0) {
    console.log(`· ${comptes} compte(s) déjà présent(s) : seed ignoré (rien n'est écrasé).`);
  } else {
    console.log('· jeu de démonstration (administrateur, filière, modèle L2 depuis l\'Excel, notes)…');
    await import('../server/seed.js');
  }
  const { ensureAnnonces } = await import('../server/annonces.js');
  const n = await ensureAnnonces();
  if (n) console.log(`· ${n} annonce(s) de démonstration publiée(s).`);
  const { ensureSchedule } = await import('../server/schedule.js');
  const fait = await ensureSchedule();
  if (fait) console.log(`· ${fait} créneaux d'emploi du temps générés.`);
}

if (['schema', 'seed', 'check'].includes(action)) {
  console.log('\nÉtat de la base :');
  for (const table of ['users', 'students', 'templates', 'semesters', 'units', 'courses', 'grades', 'schedule_slots', 'announcements', 'publications']) {
    try { console.log(`  ${table.padEnd(16)} ${await compter(table)}`); }
    catch { console.log(`  ${table.padEnd(16)} (absente)`); }
  }
  const admin = await db.prepare("SELECT email FROM users WHERE role='admin' ORDER BY id LIMIT 1").get();
  console.log(admin ? `\nCompte administrateur : ${admin.email}` : '\nAucun administrateur : lancez npm run pg:seed ou créez-en un avec npm run create-admin.');
  console.log('\nÉtapes suivantes :');
  console.log('  1. Sur Vercel → Settings → Environment Variables :');
  console.log('       DATABASE_URL    = la même chaîne de connexion');
  console.log('       SESSION_SECRET  = une chaîne aléatoire d\'au moins 16 caractères');
  console.log('  2. Redéployez. L\'application se connecte alors à cette base depuis Vercel.\n');
} else {
  console.error(`Action inconnue : ${action} (attendu : schema, seed ou check)`);
  process.exitCode = 1;
}

await db.close();
