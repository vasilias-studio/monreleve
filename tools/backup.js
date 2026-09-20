/**
 * tools/backup.js — sauvegarde à chaud de la base SQLite.
 *
 * Utilise l'API backup() de better-sqlite3 : la copie est cohérente même si
 * l'application écrit pendant l'opération (contrairement à un simple cp).
 *
 * Usage :
 *   npm run backup                      → data/backups/monreleve-<horodatage>.db
 *   node tools/backup.js --dir /var/backups --keep 30
 *   node tools/backup.js --cron         → silencieux sauf erreur (pour crontab)
 *
 * Exemple de ligne crontab (tous les jours à 3 h) :
 *   0 3 * * * cd /opt/monreleve && /usr/bin/npm run backup -- --cron
 */
import { mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import db, { DB_PATH } from '../server/db.js';

const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : def;
};
const quiet = process.argv.includes('--cron');
const keep = Number(arg('keep', 14));
const dir = arg('dir', path.join(path.dirname(DB_PATH), 'backups'));
const say = (...a) => { if (!quiet) console.log(...a); };

mkdirSync(dir, { recursive: true });
const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
const dest = path.join(dir, `monreleve-${stamp}.db`);

try {
  await db.backup(dest);                       /* copie cohérente, app en marche */
  const ko = Math.round(statSync(dest).size / 1024);
  say(`Sauvegarde écrite : ${dest} (${ko} Ko)`);
  /* rotation : on ne garde que les N plus récentes */
  const files = readdirSync(dir).filter((f) => /^monreleve-.*\.db$/.test(f)).sort();
  for (const f of files.slice(0, Math.max(0, files.length - keep))) {
    rmSync(path.join(dir, f), { force: true });
    say(`Ancienne sauvegarde supprimée : ${f}`);
  }
  say(`Sauvegardes conservées : ${Math.min(files.length, keep)} / ${keep}`);
} catch (e) {
  console.error('Échec de la sauvegarde :', e.message);
  process.exit(1);
}
