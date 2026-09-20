/**
 * routes/auth.js — Inscription, connexion, mot de passe oublié, profil.
 * Les tokens de réinitialisation sont renvoyés en clair en mode démo (pas de SMTP configuré) :
 * en production, brancher un sendmail sur le bloc marqué // MAIL HOOK.
 */
import { Router } from 'express';
import bcrypt from 'bcryptjs';
import db from '../db.js';
import { signToken, hashPassword, verifyPassword, authRequired, ApiError, badRequest, notFound, newResetToken } from '../auth.js';

const r = Router();
const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const asNum = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };

function publicUser(u, extra = {}) {
  return { id: u.id, email: u.email, role: u.role, last_name: u.last_name, first_name: u.first_name, ...extra };
}

function studentPayload(student) {
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(student.user_id);
  const names = (sql, id) => (id ? db.prepare(sql).get(id)?.name ?? null : null);
  return {
    ...publicUser(u),
    student: {
      id: student.id,
      matricule: student.matricule,
      program: names('SELECT name FROM programs WHERE id=?', student.program_id),
      program_id: student.program_id,
      level: names('SELECT name FROM levels WHERE id=?', student.level_id),
      level_id: student.level_id,
      class: names('SELECT name FROM classes WHERE id=?', student.class_id),
      class_id: student.class_id,
      year: names('SELECT label FROM academic_years WHERE id=?', student.academic_year_id),
      academic_year_id: student.academic_year_id,
    },
  };
}

/** POST /api/auth/register — création de compte étudiant. */
r.post('/register', (req, res, next) => {
  try {
    const b = req.body || {};
    for (const f of ['first_name', 'last_name', 'email', 'password', 'matricule']) {
      if (!b[f] || !String(b[f]).trim()) throw badRequest(`Champ manquant : ${f}`);
    }
    if (!emailRe.test(b.email)) throw badRequest('Adresse e-mail invalide');
    if (String(b.password).length < 6) throw badRequest('Mot de passe : 6 caractères minimum');
    if (db.prepare('SELECT id FROM users WHERE email=?').get(b.email.trim())) throw badRequest('Un compte existe déjà avec cet e-mail');
    if (db.prepare('SELECT id FROM students WHERE matricule=?').get(String(b.matricule).trim())) throw badRequest('Ce matricule est déjà utilisé');
    const programId = asNum(b.program_id), levelId = asNum(b.level_id), classId = asNum(b.class_id);
    let yearId = asNum(b.academic_year_id);
    if (!yearId) yearId = db.prepare('SELECT id FROM academic_years WHERE is_current=1').get()?.id ?? null;
    if (programId && !db.prepare('SELECT id FROM programs WHERE id=? AND active=1').get(programId)) throw badRequest('Filière inconnue');
    if (levelId && !db.prepare('SELECT id FROM levels WHERE id=?').get(levelId)) throw badRequest('Niveau inconnu');

    const created = db.transaction(() => {
      const ui = db.prepare('INSERT INTO users (email, password_hash, role, last_name, first_name) VALUES (?,?,?,?,?)')
        .run(b.email.trim().toLowerCase(), hashPassword(b.password), 'student', b.last_name.trim(), b.first_name.trim());
      const si = db.prepare('INSERT INTO students (user_id, matricule, program_id, level_id, class_id, academic_year_id) VALUES (?,?,?,?,?,?)')
        .run(ui.lastInsertRowid, String(b.matricule).trim(), programId, levelId, classId, yearId);
      return { userId: ui.lastInsertRowid, studentId: si.lastInsertRowid };
    })();
    const user = db.prepare('SELECT * FROM users WHERE id=?').get(created.userId);
    const student = db.prepare('SELECT * FROM students WHERE id=?').get(created.studentId);
    res.status(201).json({ token: signToken(user), ...studentPayload(student) });
  } catch (e) { next(e); }
});

/** POST /api/auth/login — étudiants et administrateurs. */
r.post('/login', (req, res, next) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) throw badRequest('E-mail et mot de passe requis');
    const user = db.prepare('SELECT * FROM users WHERE email=?').get(String(email).trim().toLowerCase());
    if (process.env.DEBUG_LOGIN) console.log('[dbg-login] user:', !!user, '| hash len:', user?.password_hash?.length, '| hash head:', String(user?.password_hash).slice(0, 10), '| hash tail:', String(user?.password_hash).slice(-6), '| pwd len:', String(password).length, '| pwd codes:', [...String(password)].map((c) => c.charCodeAt(0)).join(','));
    if (!user || !bcrypt.compareSync(String(password), user.password_hash)) {
      throw new ApiError(401, 'Identifiants incorrects');
    }
    if (!user.is_active) throw new ApiError(403, 'Compte désactivé');
    const base = { token: signToken(user), ...publicUser(user) };
    if (user.role === 'student') {
      const student = db.prepare('SELECT * FROM students WHERE user_id=?').get(user.id);
      base.student = studentPayload(student).student;
    }
    res.json(base);
  } catch (e) { next(e); }
});

/** GET /api/auth/me — session courante (refresh au démarrage de l'app). */
r.get('/me', authRequired, (req, res, next) => {
  try {
    if (req.user.role === 'student') {
      const student = db.prepare('SELECT * FROM students WHERE user_id=?').get(req.user.id);
      if (!student) throw notFound('Profil étudiant introuvable');
      return res.json(studentPayload(student));
    }
    res.json(publicUser(req.user));
  } catch (e) { next(e); }
});

/** PUT /api/auth/me — modification du profil (nom, prénom, mot de passe avec confirmation). */
r.put('/me', authRequired, (req, res, next) => {
  try {
    const b = req.body || {};
    const updates = {}, params = [];
    for (const f of ['last_name', 'first_name']) {
      if (b[f] != null) { updates[f] = `=?`; params.push(String(b[f]).trim()); }
    }
    if (b.password) {
      if (!b.old_password || !verifyPassword(String(b.old_password), req.user.password_hash)) throw badRequest('Mot de passe actuel incorrect');
      if (String(b.password).length < 6) throw badRequest('Nouveau mot de passe : 6 caractères minimum');
      updates['password_hash'] = '=?'; params.push(bcrypt.hashSync(String(b.password), 10));
    }
    if (!params.length) throw badRequest('Rien à modifier');
    params.push(req.user.id);
    db.prepare(`UPDATE users SET ${Object.keys(updates).map((k) => k + updates[k]).join(',')} WHERE id=?`).run(...params);
    res.json(publicUser(db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id)));
  } catch (e) { next(e); }
});

/** POST /api/auth/forgot — génère un lien de réinitialisation. */
r.post('/forgot', (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const user = db.prepare('SELECT * FROM users WHERE email=?').get(email);
  // Réponse identique que le compte existe ou non (anti-énumération).
  const generic = { ok: true, message: 'Si un compte existe, un e-mail de réinitialisation a été envoyé.' };
  if (!user) return res.json(generic);
  const token = newResetToken();
  db.prepare(`UPDATE users SET reset_token=?, reset_expires=datetime('now','+1 hour') WHERE id=?`).run(token, user.id);
  // // MAIL HOOK : envoyer ici `https://<hote>/reset?token=…` via votre service e-mail.
  const demo = process.env.MAIL_DEMO !== '0';
  res.json(demo ? { ...generic, demo_token: token, message: 'Mode démo : le lien de réinitialisation est renvoyé directement (aucun SMTP configuré).' } : generic);
});

/** POST /api/auth/reset — consomme le token, définit un nouveau mot de passe. */
r.post('/reset', (req, res, next) => {
  try {
    const { token, password } = req.body || {};
    if (!token || !password) throw badRequest('Token et mot de passe requis');
    if (String(password).length < 6) throw badRequest('Mot de passe : 6 caractères minimum');
    const user = db.prepare(`SELECT * FROM users WHERE reset_token=? AND reset_expires > datetime('now')`).get(String(token));
    if (!user) throw badRequest('Lien invalide ou expiré');
    db.prepare(`UPDATE users SET password_hash=?, reset_token=NULL, reset_expires=NULL WHERE id=?`).run(bcrypt.hashSync(String(password), 10), user.id);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

/** GET /api/auth/options — données publiques pour les formulaires d'inscription. */
r.get('/options', (_req, res) => {
  res.json({
    programs: db.prepare('SELECT id, name, code FROM programs WHERE active=1 ORDER BY name').all(),
    levels: db.prepare('SELECT id, name, cycle FROM levels ORDER BY ord, name').all(),
    years: db.prepare('SELECT id, label, is_current FROM academic_years ORDER BY start_year DESC').all(),
    classes: db.prepare(`SELECT c.id, c.name, c.program_id, c.level_id, p.name AS program, l.name AS level, y.label AS year
      FROM classes c JOIN programs p ON p.id=c.program_id JOIN levels l ON l.id=c.level_id
      LEFT JOIN academic_years y ON y.id=c.academic_year_id ORDER BY c.name`).all(),
  });
});

export default r;
