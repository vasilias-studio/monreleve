/**
 * createAdmin.js — Crée le premier compte administrateur.
 *   npm run create-admin -- --email you@univ.mg --password "MotDePasse!" --name "Scolarité"
 * Variables d'environnement acceptées aussi : ADMIN_EMAIL, ADMIN_PASSWORD, ADMIN_NAME.
 */
import readline from 'node:readline';
import db, { tx } from './db.js';
import { hashPassword } from './auth.js';

const parseArgs = () => {
  const out = {};
  const a = process.argv.slice(2);
  for (let i = 0; i < a.length; i++) {
    if (a[i].startsWith('--')) out[a[i].slice(2)] = a[i + 1] && !a[i + 1].startsWith('--') ? a[++i] : true;
  }
  return out;
};

const ask = (question, def) => new Promise((resolve) => {
  if (def) { console.log(`${question} ${def}`); return resolve(def); }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.question(question + ' ', (v) => { rl.close(); resolve(v.trim()); });
});

(async () => {
  const args = parseArgs();
  const email = (args.email || process.env.ADMIN_EMAIL || await ask('E-mail admin :'))?.trim();
  const nameArg = (args.name || process.env.ADMIN_NAME || await ask('Nom complet :'))?.trim();
  const password = args.password || process.env.ADMIN_PASSWORD || await ask('Mot de passe (>= 8 caractères) :');
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { console.error('E-mail invalide'); process.exit(1); }
  if (!password || password.length < 8) { console.error('Mot de passe trop court (min. 8 caractères)'); process.exit(1); }
  const [last, first] = (nameArg || 'Administrateur Scolarité').split(/[\s,]+/);
  tx(() => {
    let uid = db.prepare('SELECT id FROM users WHERE email=?').get(email)?.id;
    if (uid) {
      db.prepare(`UPDATE users SET password_hash=?, role='admin', is_active=1 WHERE id=?`).run(hashPassword(password), uid);
      console.log(`Compte existant réactivé et promu administrateur : ${email}`);
    } else {
      uid = db.prepare(`INSERT INTO users (email, password_hash, role, last_name, first_name) VALUES (?,?,?,?,?)`)
        .run(email.toLowerCase(), hashPassword(password), 'admin', last || 'Admin', first || '').lastInsertRowid;
      db.prepare(`INSERT INTO admins (user_id, department) VALUES (?,?)`).run(uid, first || 'Administration');
    }
  });
  console.log(`✔ Administrateur prêt : ${email} — connectez-vous sur l'écran de connexion.`);
})();
