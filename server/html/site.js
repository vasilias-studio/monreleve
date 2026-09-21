/**
 * site.js — Interface web 100 % HTML (rendu serveur, zéro JavaScript applicatif).
 * Toutes les données viennent de la base (SQLite en local, PostgreSQL/Supabase en ligne) ;
 * toutes les autorisations sont vérifiées ici,
 * côté serveur (un étudiant ne voit/jamais écrit que ses propres lignes, un admin a tout).
 * L'API REST JSON (/api/*) reste en place (mobile/PWA) et partage la même base.
 */
import express from 'express';
import PDFDocument from 'pdfkit';
import { asyncRouter } from '../asyncrouter.js';
import multer from 'multer';
import db, { tx } from '../db.js';
import { signToken, readToken, hashPassword, verifyPassword, newResetToken, ApiError, badRequest, notFound } from '../auth.js';
import { computeReleve, resolveRules } from '../compute.js';
import { findTemplateForStudent, loadTemplateTree } from '../routes/student.js';
import { loadSheetCells, loadSheetValues, parseReleveStructure, parseFlatGrades, suggestMapping, readWorkbook, XLSX } from '../releveParser.js';
import { page, esc, fmt, url, hiddenT, chip, statusChip, pubChip } from './layout.js';
import { liveCalcScript } from './engine.js';
import { buildRelevePdf } from '../pdfReleve.js';
import { feed, likedIds, toggleLike, audienceLabel, relTime } from '../annonces.js';
import { saveUpload, readUpload, dropUpload, TAILLE_MAX } from '../uploads.js';
import { resolveAcademicClass } from '../academic.js';

/* ---- calcul en direct (aperçu Excel) : config sérialisée pour le moteur inliné ---- */
const liveTree = (semesters) => semesters.map((s) => ({
  id: s.id, number: s.number, name: s.name, ects_expected: s.ects_expected,
  units: s.units.map((u) => ({ id: u.id, code: u.code, name: u.name, courses: u.courses.map((c) => ({ id: c.id, name: c.name, coefficient: c.coefficient, credits: c.credits })) })),
}));
const liveScores = (computed) => {
  const m = {};
  for (const s of computed.semesters) for (const u of s.units) for (const c of u.courses) m[c.id] = { normal: c.normal ?? null, rattrapage: c.rattrapage ?? null };
  return m;
};

const r = asyncRouter();
r.use(express.urlencoded({ extended: true }));

/* Le classeur importé est gardé EN MÉMOIRE le temps de la requête puis rangé dans la
 * base (voir server/uploads.js) : aucun disque requis, donc c'est compatible avec un
 * hébergement sans serveur (Vercel) comme avec un serveur classique. */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: TAILLE_MAX },            /* UPLOAD_MAX_MB, 12 Mo par défaut */
  fileFilter: (_q, f, cb) => {
    const ok = /\.(xlsx|xls)$/i.test(f.originalname);
    cb(ok ? null : new ApiError(400, 'Format attendu : .xlsx ou .xls'), ok);
  },
});
const ANNOUNCEMENT_IMAGE_MAX = Number(process.env.ANNOUNCEMENT_IMAGE_MAX_MB || 8) * 1024 * 1024;
const announcementUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: ANNOUNCEMENT_IMAGE_MAX },
  fileFilter: (_q, f, cb) => {
    const ok = /\.(jpe?g|png|webp)$/i.test(f.originalname) && /^image\/(jpeg|png|webp)$/i.test(f.mimetype || '');
    cb(ok ? null : new ApiError(400, 'Image attendue : .jpg, .png ou .webp'), ok);
  },
});
const PROFILE_IMAGE_MAX = Number(process.env.PROFILE_IMAGE_MAX_MB || 5) * 1024 * 1024;
const profileUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: PROFILE_IMAGE_MAX },
  fileFilter: (_q, f, cb) => {
    const ok = /\.(jpe?g|png|webp)$/i.test(f.originalname) && /^image\/(jpeg|png|webp)$/i.test(f.mimetype || '');
    cb(ok ? null : new ApiError(400, 'Photo attendue : .jpg, .png ou .webp'), ok);
  },
});
const ARCHIVE_FILE_MAX = 3 * 1024 * 1024;
const archiveUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: ARCHIVE_FILE_MAX },
  fileFilter: (_q, f, cb) => {
    const ok = /\.(pdf|jpe?g|png)$/i.test(f.originalname) && /^(application\/pdf|image\/(jpeg|png))$/i.test(f.mimetype || '');
    cb(ok ? null : new ApiError(400, 'Format attendu : .pdf, .jpg ou .png'), ok);
  },
});

/* ------------------------------------------------------------------ */
/* Utilitaires                                                          */
/* ------------------------------------------------------------------ */
const getCookie = (req, name) => (req.headers.cookie || '').split(';').map((c) => c.trim().split('=')).find(([k]) => k === name)?.[1] || null;
const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const asNum = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
const score = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(String(v).replace(',', '.'));
  if (!Number.isFinite(n) || n < 0 || n > 20) throw badRequest('Note invalide : attendu un nombre entre 0 et 20');
  return Math.round(n * 100) / 100;
};
const normName = (s) => String(s ?? '').trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ');

/** Enveloppe : gère erreurs page d'erreur avec retour. */
const H = (fn) => async (req, res, next) => {
  try { await fn(req, res); } catch (e) { next(e); }
};

/* Courant : utilisateur par cookie httpOnly + thème + messages flash.
 * Important : un paramètre t éventuellement présent dans une ancienne URL est
 * volontairement ignoré. Une URL copiée ou partagée ne doit jamais ouvrir une session. */
r.use(async (req, res, next) => {
  const q = req.query;
  const token = getCookie(req, 'mrt');
  const user = await readToken(token);
  const profilePhoto = user ? await db.prepare('SELECT id FROM profile_photos WHERE user_id=?').get(user.id) : null;
  const viewUser = user ? { ...user, has_profile_photo: Boolean(profilePhoto) } : null;
  /* le choix de thème est persisté en cookie : les liens sans ?th= le conservent */
  if (q.th === 'dark' || q.th === 'light') res.setHeader('Set-Cookie', `mrt_theme=${q.th}; Path=/; Max-Age=31536000; SameSite=Lax`);
  else if (q.th === 'auto') res.setHeader('Set-Cookie', 'mrt_theme=; Path=/; Max-Age=0; SameSite=Lax');
  const ctx = { t: null, th: ['dark', 'light'].includes(q.th) ? String(q.th) : getCookie(req, 'mrt_theme'), pathname: req.path.replace(/\/$/, '') || '/', user: viewUser, flash: q.ok ? esc(q.ok) : null, error: q.err ? esc(q.err) : null };
  req.ctx = ctx;
  req.user = viewUser;
  next();
});
const need = (role) => (req, res, next) => {
  if (!req.user) { res.redirect(303, '/login?err=' + encodeURIComponent('Session requise — connectez-vous.')); return; }
  if (role && req.user.role !== role) { res.redirect(303, req.user.role === 'admin' ? url('/admin', req.ctx) : url('/accueil', req.ctx)); return; }
  next();
};
const student = async (req) => await db.prepare('SELECT * FROM students WHERE user_id=?').get(req.user.id);

/** Calcule relevé perso + officiel pour un étudiant (données de toutes les pages étudiant). */
async function studentData(stud) {
  const template = await findTemplateForStudent(stud);
  if (!template) return { template: null };
  const semesters = await loadTemplateTree(template.id);
  const loadGrades = async (source) => {
    const ids = semesters.flatMap((s) => s.units.flatMap((u) => u.courses.map((c) => c.id)));
    const map = new Map();
    if (ids.length) {
      const marks = ids.map(() => '?').join(',');
      for (const row of await db.prepare(`SELECT course_id, normal, rattrapage FROM grades WHERE student_id=? AND source=? AND course_id IN (${marks})`).all(stud.id, source, ...ids)) map.set(row.course_id, row);
    }
    return map;
  };
  const personal = computeReleve(template, semesters, await loadGrades('personal'));
  const official = computeReleve(template, semesters, await loadGrades('official'));
  const pubs = {};
  for (const s of semesters) pubs[s.id] = await db.prepare('SELECT status, published_at FROM publications WHERE semester_id=?').get(s.id) || { status: 'draft' };
  const officialVisible = official.semesters.filter((s) => pubs[s.id]?.status !== 'draft');
  return { template, semesters, personal, official, officialVisible, pubs };
}

const opts = async () => ({
  programs: await db.prepare('SELECT id, name FROM programs WHERE active=1 ORDER BY name').all(),
  levels: await db.prepare('SELECT id, name FROM levels ORDER BY ord, name').all(),
  years: await db.prepare('SELECT id, label FROM academic_years ORDER BY start_year DESC').all(),
  templates: await db.prepare('SELECT t.id, t.name FROM templates t ORDER BY t.id DESC').all(),
});
const select = (name, rows, sel, extra = '') => `<select name="${name}" class="input" ${extra}>${rows.map((o) => `<option value="${o.id}" ${String(sel) === String(o.id) ? 'selected' : ''}>${esc(o.name ?? o.label ?? o.p + ' · ' + o.l)}</option>`).join('')}</select>`;

/* CSV / XLSX (mêmes formats que l'API) */
const csv = (rows, headers) => {
  const escv = (v) => { const s = String(v ?? ''); return /[";\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  return [headers.join(';'), ...rows.map((row) => headers.map((h) => escv(typeof h === 'function' ? h(row) : row[h])).join(';'))].join('\n');
};
const sendCsv = (res, name, content) => { res.setHeader('Content-Type', 'text/csv; charset=utf-8'); res.setHeader('Content-Disposition', `attachment; filename="${name}"`); res.send('\uFEFF' + content); };
async function sendReleveXlsx(res, stud, source) {
  const template = await findTemplateForStudent(stud);
  if (!template) throw badRequest('Aucun modèle pour cet étudiant');
  const tree = await loadTemplateTree(template.id);
  const ids = tree.flatMap((x) => x.units.flatMap((u) => u.courses.map((c) => c.id)));
  const m = new Map();
  if (ids.length) { const marks = ids.map(() => '?').join(','); for (const row of await db.prepare(`SELECT course_id, normal, rattrapage FROM grades WHERE student_id=? AND source=? AND course_id IN (${marks})`).all(stud.id, source, ...ids)) m.set(row.course_id, row); }
  const computed = computeReleve(template, tree, m);
  const u = await db.prepare('SELECT first_name,last_name FROM users WHERE id=?').get(stud.user_id);
  const aoa = [
    [`Relevé de notes (${source === 'official' ? 'Résultats officiels' : 'Notes personnelles'}) — MonRelevé`],
    ['Étudiant', `${u.first_name} ${u.last_name}`.trim(), 'Matricule', stud.matricule],
    ['Modèle', template.name], [],
    ['Semestre', 'UE', 'Matière', 'Note normale', 'Rattrapage', 'Définitive', 'Coefficient', 'Crédit', 'Statut'],
  ];
  for (const sem of computed.semesters) {
    for (const ue of sem.units) for (const c of ue.courses) aoa.push([sem.name, ue.code, c.name, c.normal ?? '', c.rattrapage ?? '', c.definitive ?? '', c.coefficient, c.credits, c.status]);
    aoa.push([sem.name, '', 'MOYENNE', sem.average ?? '', '', '', '', sem.creditsEarned + '/' + (sem.ectsExpected || ''), '']);
  }
  aoa.push([], ['MOYENNE GÉNÉRALE', computed.generalAverage ?? '', 'Crédits obtenus', computed.creditsEarned, '/', computed.creditsExpected]);
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Relevé');
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="releve-${stud.matricule}-${source}.xlsx"`);
  res.send(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));
}

/* ------------------------------------------------------------------ */
/* Pages publiques                                                      */
/* ------------------------------------------------------------------ */
r.get('/', H((req, res) => {
  if (!req.user) return res.redirect(303, url('/login', req.ctx));
  res.redirect(303, url(req.user.role === 'admin' ? '/admin' : '/accueil', req.ctx));
}));

const authShell = (req, title, body) => page(req.ctx, { title, body, bare: true });

r.get('/login', H((req, res) => {
  const body = `<div class="auth-wrap">
    <div class="auth-hero">
      <div class="logo-dot" style="width:58px;height:58px;border-radius:19px;font-size:24px">MR</div>
      <h1>Bon retour </h1>
      <p class="muted small" style="margin:4px 0 0">Connectez-vous pour retrouver votre relevé de notes</p>
    </div>
    <form class="auth-card" method="post" action="${url('/login', req.ctx)}" novalidate>
      <div class="field"><label>Adresse e-mail</label><input class="input" type="email" name="email" autocomplete="email" placeholder="prenom.nom@univ.mg" required/></div>
      <div class="field"><label>Mot de passe</label><input class="input" type="password" name="password" autocomplete="current-password" placeholder="••••••••" required/></div>
      <div class="row spread" style="margin:14px 0 4px"><a class="link-btn small" href="${url('/forgot', req.ctx)}">Mot de passe oublié&nbsp;?</a></div>
      <button class="btn">Se connecter</button>
      <p class="small muted" style="text-align:center;margin:14px 0 0">Pas encore de compte&nbsp;? <a class="link-btn" href="${url('/register', req.ctx)}">Créer un compte</a></p>
    </form>
    <p class="tiny muted" style="text-align:center;margin-top:14px">Démo — étudiant : naina.randria@example.mg / etudiant123 · admin : admin@univ.mg / admin123</p>
  </div>`;
  res.send(authShell(req, 'Connexion', body));
}));

r.post('/login', H(async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const user = await db.prepare('SELECT * FROM users WHERE email=?').get(email);
  if (!user || !verifyPassword(String(req.body.password || ''), user.password_hash)) {
    return res.redirect(303, '/login?err=' + encodeURIComponent('Identifiants incorrects.'));
  }
  if (!user.is_active) return res.redirect(303, '/login?err=' + encodeURIComponent('Compte désactivé — contactez l’administration.'));
  const t = signToken(user, 'html');
  res.cookie('mrt', t, { httpOnly: true, sameSite: 'lax', maxAge: 30 * 864e5 });
  // Après un POST, 303 impose une nouvelle requête GET (Vercel peut conserver POST avec 307).
  res.redirect(303, url(user.role === 'admin' ? '/admin' : '/accueil', { t, th: req.ctx.th }));
}));

r.get('/deconnexion', H((req, res) => { res.clearCookie('mrt'); res.redirect(303, url('/login', { th: req.ctx.th })); }));

r.get('/register', H(async (req, res) => {
  const o = await opts();
  const body = `<div class="auth-wrap">
    <div class="auth-hero"><div class="logo-dot" style="width:58px;height:58px;border-radius:19px;font-size:24px">＋</div>
      <h1>Créer mon compte</h1><p class="muted small" style="margin:4px 0 0">Étudiants uniquement — vos notes resteront privées.</p></div>
    <form class="auth-card" method="post" action="${url('/register', req.ctx)}">
      <div class="grid" style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
        <div class="field"><label>Nom</label><input class="input" name="last_name" required/></div>
        <div class="field"><label>Prénom</label><input class="input" name="first_name" required/></div>
      </div>
      <div class="field"><label>Adresse e-mail</label><input class="input" type="email" name="email" required/></div>
      <div class="field"><label>Matricule</label><input class="input" name="matricule" required/></div>
      <div class="grid" style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
        <div class="field"><label>Filière</label>${select('program_id', o.programs, '', 'required')}</div>
        <div class="field"><label>Niveau</label>${select('level_id', o.levels, '', 'required')}</div>
      </div>
      <div class="field"><label>Année universitaire</label>${select('academic_year_id', o.years.map((y) => ({ ...y, name: y.label })), '', '')}</div>
      <div class="field"><label>Mot de passe (6 caractères min.)</label><input class="input" type="password" name="password" minlength="6" required/></div>
      <button class="btn">Créer mon compte</button>
      <p class="small muted" style="text-align:center;margin:14px 0 0">Déjà inscrit&nbsp;? <a class="link-btn" href="${url('/login', req.ctx)}">Se connecter</a></p>
    </form>
  </div>`;
  res.send(authShell(req, 'Inscription', body));
}));

r.post('/register', H(async (req, res) => {
  const b = req.body;
  const fail = (m) => res.redirect(303, url('/register', { ...req.ctx, err: m }));
  for (const f of ['first_name', 'last_name', 'email', 'password', 'matricule']) if (!String(b[f] || '').trim()) return fail(`Champ manquant : ${f === 'first_name' ? 'prénom' : f === 'last_name' ? 'nom' : f}`);
  if (!emailRe.test(b.email)) return fail('Adresse e-mail invalide');
  if (String(b.password).length < 6) return fail('Mot de passe : 6 caractères minimum');
  if (await db.prepare('SELECT id FROM users WHERE email=?').get(b.email.trim().toLowerCase())) return fail('Un compte existe déjà avec cet e-mail — connectez-vous.');
  if (await db.prepare('SELECT id FROM students WHERE matricule=?').get(String(b.matricule).trim())) return fail('Ce matricule est déjà utilisé.');
  const ui = await db.prepare('INSERT INTO users (email,password_hash,role,last_name,first_name) VALUES (?,?,?,?,?)')
    .run(b.email.trim().toLowerCase(), hashPassword(b.password), 'student', b.last_name.trim(), b.first_name.trim());
  let yearId = asNum(b.academic_year_id); if (!yearId) yearId = (await db.prepare('SELECT id FROM academic_years WHERE is_current=1').get())?.id ?? null;
  await db.prepare('INSERT INTO students (user_id,matricule,program_id,level_id,academic_year_id) VALUES (?,?,?,?,?)')
    .run(ui.lastInsertRowid, String(b.matricule).trim(), asNum(b.program_id), asNum(b.level_id), yearId);
  const t = signToken(await db.prepare('SELECT * FROM users WHERE id=?').get(ui.lastInsertRowid), 'html');
  res.cookie('mrt', t, { httpOnly: true, sameSite: 'lax', maxAge: 30 * 864e5 });
  // Après un POST, 303 évite que le navigateur renvoie le formulaire sur /accueil.
  res.redirect(303, url('/accueil', { t, th: req.ctx.th }));
}));

r.get('/forgot', H((req, res) => {
  const body = `<div class="auth-wrap"><div class="auth-hero"><h1>Mot de passe oublié</h1>
    <p class="muted small">Saisissez votre e-mail : un lien de réinitialisation vous sera envoyé.</p></div>
    <form class="auth-card" method="post" action="${url('/forgot', req.ctx)}">
      <div class="field"><label>Adresse e-mail</label><input class="input" type="email" name="email" required/></div>
      <button class="btn">Envoyer le lien</button>
      <p class="small muted" style="text-align:center;margin:14px 0 0"><a class="link-btn" href="${url('/login', req.ctx)}">Retour à la connexion</a></p>
    </form></div>`;
  res.send(authShell(req, 'Mot de passe oublié', body));
}));
r.post('/forgot', H(async (req, res) => {
  const user = await db.prepare('SELECT * FROM users WHERE email=?').get(String(req.body.email || '').trim().toLowerCase());
  if (user) {
    const token = newResetToken();
    await db.prepare(`UPDATE users SET reset_token=?, reset_expires=datetime('now','+1 hour') WHERE id=?`).run(token, user.id);
    // Mode démo (aucun SMTP) : on affiche directement le lien, comme pour l'API.
    return res.redirect(303, url('/reset', { th: req.ctx.th, token }));
  }
  res.redirect(303, '/forgot?ok=' + encodeURIComponent('Si un compte existe, un lien de réinitialisation vient d’être envoyé.'));
}));
r.get('/reset', H((req, res) => {
  const token = String(req.query.token || '');
  const body = `<div class="auth-wrap"><div class="auth-hero"><h1>Nouveau mot de passe</h1></div>
    <form class="auth-card" method="post" action="${url('/reset', { th: req.ctx.th })}">
      <input type="hidden" name="token" value="${esc(token)}"/>
      <div class="field"><label>Nouveau mot de passe (6 caractères min.)</label><input class="input" type="password" name="password" minlength="6" required/></div>
      <button class="btn">Enregistrer</button>
    </form></div>`;
  res.send(authShell(req, 'Réinitialisation', body));
}));
r.post('/reset', H(async (req, res) => {
  const user = await db.prepare(`SELECT * FROM users WHERE reset_token=? AND reset_expires > datetime('now')`).get(String(req.body.token || ''));
  if (!user) return res.redirect(303, '/forgot?err=' + encodeURIComponent('Lien invalide ou expiré.'));
  if (String(req.body.password || '').length < 6) return res.redirect(303, url('/reset', { th: req.ctx.th, token: req.body.token, err: 'Mot de passe : 6 caractères minimum' }));
  await db.prepare(`UPDATE users SET password_hash=?, reset_token=NULL, reset_expires=NULL WHERE id=?`).run(hashPassword(req.body.password), user.id);
  res.redirect(303, url('/login', { th: req.ctx.th, ok: 'Mot de passe mis à jour — connectez-vous.' }));
}));

/* ------------------------------------------------------------------ */
/* Espace étudiant                                                      */
/* ------------------------------------------------------------------ */
const STU_TABS = [
  ['/accueil', 'home', 'Accueil', '/accueil'],
  ['/saisie', 'pencil', 'Saisie', '/saisie'],
  ['/messages', 'send', 'Envoyer un message à l’administration', '/messages'],
  ['/archives', 'list', 'Archives', '/archives'],
  ['/calendrier', 'calendar', 'Calendrier', '/calendrier'],
];
const stuPage = (req, title, body, opts = {}) => page(req.ctx, { title, body, tabs: STU_TABS, ...opts });

/* ------------------------------------------------------------------ */
/* Accueil = fil d'annonces (« publications ») de l'administration        */
/* ------------------------------------------------------------------ */
/** Icône pleine utilisée par les cartes d'annonces, comme dans la maquette mobile. */
const ANNOUNCEMENT_USER_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="7.5" r="4.5"/><path d="M3.2 20.4c.7-4.2 4-6.8 8.8-6.8s8.1 2.6 8.8 6.8c.1.6-.4 1.1-1 1.1H4.2c-.6 0-1.1-.5-1-1.1Z"/></svg>';

/** Carte d'une annonce : une vraie ligne BDD, ouvrable vers son détail. */
async function annonceCard(a, { ctx, liked = false, admin = false, featured = false }) {
  const estAdmin = a.author_role === 'admin';
  const who = `${a.first_name || ''} ${a.last_name || ''}`.trim() || (estAdmin ? 'Administration' : 'MonRelevé');
  const sub = relTime(a.created_at);
  const body = esc(a.body).replace(/\n{2,}/g, '</p><p>').replace(/\n/g, '<br/>');
  const href = url(`/accueil/annonces/${a.id}`, ctx);
  const imageUrl = a.has_image ? url(`/accueil/annonces/${a.id}/image`, ctx) : '';
  const imageStyle = imageUrl ? ` style="background-image:url('${esc(imageUrl)}')"` : '';
  const inlineImage = !featured && imageUrl
    ? `<div class="post-image-wrap"><img class="post-image" src="${esc(imageUrl)}" alt="Photo de la publication de ${esc(who)}" loading="lazy" decoding="async"/></div>`
    : '';
  const authorPhoto = a.author_has_photo && a.author_id
    ? `<img class="announcement-author-photo" src="${esc(url(`/profil/photo/${a.author_id}`, ctx))}" alt="" />`
    : ANNOUNCEMENT_USER_ICON;
  const author = `<span class="home-avatar" title="${esc(who)}">${authorPhoto}</span><span class="who"><b>${esc(who)}</b><span class="tiny muted">${esc(sub)}</span></span>`;
  const likeBtn = `<form method="post" action="${url(`/accueil/annonces/${a.id}/aime`, ctx)}" style="margin:0">
      <input type="hidden" name="th" value="${esc(ctx.th || '')}" />
      <button class="likebtn${liked ? ' on' : ''}" type="submit" aria-pressed="${liked}">
        <svg viewBox="0 0 24 24" width="15" height="15" fill="${liked ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20.3 4.6 13a4.6 4.6 0 0 1 6.5-6.5l.9.9.9-.9A4.6 4.6 0 1 1 19.4 13Z"/></svg>
        <span>J'aime</span>${a.likes ? `<b>${a.likes}</b>` : ''}
      </button></form>`;
  const mod = admin ? `<form method="post" action="${url(`/accueil/annonces/${a.id}/epingler`, ctx)}" style="margin:0"><input type="hidden" name="th" value="${esc(ctx.th || '')}" /><button class="chip gray" type="submit" style="cursor:pointer">${a.pinned ? 'Désépingler' : 'Épingler'}</button></form>
      <form method="post" action="${url(`/accueil/annonces/${a.id}/supprimer`, ctx)}" style="margin:0" onsubmit="return confirm('Supprimer cette annonce ?')"><input type="hidden" name="th" value="${esc(ctx.th || '')}" /><button class="chip bad" type="submit" style="cursor:pointer">Supprimer</button></form>` : '';
  if (featured) return `<article class="post post-featured${a.pinned ? ' pinned' : ''}">
    <a class="post-featured-open" href="${href}" aria-label="Ouvrir l’annonce">
      <div class="post-featured-image${a.has_image ? ' has-image' : ' no-image'}"${imageStyle}>
        <div class="post-featured-overlay">
          <p>${body}</p>
          <div class="post-featured-meta"><span class="home-avatar">${authorPhoto}</span><b>${esc(who)}</b><span>${esc(relTime(a.created_at))}</span></div>
        </div>
      </div>
    </a>
  </article>`;
  return `<article class="post${a.pinned ? ' pinned' : ''}">
    <a class="post-main" href="${href}" aria-label="Ouvrir l’annonce">
      <header class="post-head">${author}${admin ? `<span class="chip gray" title="Destinataires">${esc(await audienceLabel(a))}</span>` : ''}</header>
      <div class="post-body"><p>${body}</p></div>
      ${inlineImage}
    </a>
    <footer class="post-foot">${likeBtn}${a.pinned ? chip('Épinglée', 'violet') : ''}${mod}</footer>
  </article>`;
}

/** Composeur d'annonce (administration) : texte + cible (tous / filière) + épinglage. */
async function composer(req) {
  const o = await opts();
  const prog = o.programs.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join('');
  const h = hiddenT(req.ctx.t, { th: req.ctx.th });
  return `<form class="composer" method="post" action="${url('/accueil/annonces', req.ctx)}" enctype="multipart/form-data">${h}
    <textarea class="input" name="body" rows="3" maxlength="2000" placeholder="Quoi de neuf ? Écrivez une annonce pour les étudiants…" required></textarea>
    <div class="composer-row">
      <select class="input" name="audience" id="ann-audience" onchange="document.getElementById('ann-prog').hidden = this.value !== 'program';">
        <option value="all">Tous les étudiants</option>
        <option value="program">Une filière</option>
      </select>
      <select class="input" name="program_id" id="ann-prog" hidden>${prog}</select>
      <label class="tiny muted ann-image-field">Photo (facultative, obligatoire si épinglée) <input type="file" name="image" accept=".jpg,.jpeg,.png,.webp,image/jpeg,image/png,image/webp" /></label>
      <label class="tiny muted" style="display:flex;align-items:center;gap:6px"><input type="checkbox" name="pinned" value="1" /> Épingler en haut</label>
      <button class="btn sm" style="width:auto">Publier</button>
    </div>
  </form>`;
}

/* Le fil est public dans l'app : étudiant et administration le voient (l'admin y écrit). */
r.get('/accueil', (req, res, next) => {
  if (!req.user) { res.redirect(303, '/login?err=' + encodeURIComponent('Session requise — connectez-vous.')); return; }
  next();
}, H(async (req, res) => {
  const admin = req.user.role === 'admin';
  const stud = admin ? null : await student(req);
  const viewer = admin ? req.user : stud;
  const posts = await feed(viewer);
  const liked = await likedIds(req.user.id, posts.map((p) => p.id));
  const pinnedWithImages = admin ? [] : posts.filter((a) => a.pinned && a.has_image);
  const carouselSlides = await Promise.all(pinnedWithImages.map((a) => annonceCard(a, {
    ctx: req.ctx, liked: liked.has(a.id), admin: false, featured: true,
  })));
  const carouselDots = pinnedWithImages.map((a, i) => `<button type="button" class="announcement-carousel-dot${i === 0 ? ' on' : ''}" data-carousel-to="${i}" aria-label="Annonce épinglée ${i + 1}"${i === 0 ? ' aria-current="true"' : ''}></button>`).join('');
  const carousel = carouselSlides.length ? `<section class="announcement-carousel" data-announcement-carousel data-count="${carouselSlides.length}" aria-label="Annonces épinglées">
      <div class="announcement-carousel-track">${carouselSlides.join('')}</div>
      <div class="announcement-carousel-dots" role="tablist">${carouselDots}</div>
    </section>
    <script>
      (function () {
        var root = document.querySelector('[data-announcement-carousel]');
        if (!root) return;
        var track = root.querySelector('.announcement-carousel-track');
        var dots = Array.prototype.slice.call(root.querySelectorAll('[data-carousel-to]'));
        var count = dots.length, index = 0, timer = null;
        function go(next) {
          index = (next + count) % count;
          track.style.transform = 'translate3d(-' + (index * 100) + '%,0,0)';
          dots.forEach(function (dot, i) { dot.classList.toggle('on', i === index); dot.setAttribute('aria-current', i === index ? 'true' : 'false'); });
        }
        function stop() { if (timer) { clearInterval(timer); timer = null; } }
        function start() { stop(); if (count > 1) timer = setInterval(function () { go(index + 1); }, 3000); }
        dots.forEach(function (dot) { dot.addEventListener('click', function () { go(Number(dot.dataset.carouselTo)); start(); }); });
        root.addEventListener('mouseenter', stop); root.addEventListener('mouseleave', start);
        root.addEventListener('focusin', stop); root.addEventListener('focusout', start);
        start();
      }());
    </script>` : '';
  const remaining = posts.filter((a) => !pinnedWithImages.some((p) => p.id === a.id));
  const cards = (await Promise.all(remaining.map(async (a) => await annonceCard(a, {
    ctx: req.ctx, liked: liked.has(a.id), admin,
  })))).join('');
  const body = `${admin ? '<h1 style="font-size:18px;margin:4px 2px 12px">Annonces</h1>' : ''}
    ${req.ctx.flash ? `<div class="banner ok">${req.ctx.flash}</div>` : ''}
    ${req.ctx.error ? `<div class="banner warn">${req.ctx.error}</div>` : ''}
    ${admin ? await composer(req) : ''}
    <div class="feed">${carousel}${cards || (!carousel ? '<div class="empty">Aucune annonce pour le moment.</div>' : '')}</div>
    ${admin ? `<p class="tiny muted" style="margin:14px 2px">Vous publiez en tant qu’administration — les annonces ciblées n’apparaissent qu’aux étudiants concernés.</p>`
            : ''}`;
  res.send(admin
    ? page(req.ctx, { title: 'Annonces', body, adminTab: '/accueil' })
    : stuPage(req, 'Annonces', body, { bodyClass: 'student-home-page' }));
}));

/* Image jointe : elle est lue depuis la BDD et protégée par la même visibilité que l'annonce. */
r.get('/accueil/annonces/:id/image', H(async (req, res) => {
  if (!req.user) return res.status(404).end();
  const viewer = req.user.role === 'admin' ? req.user : await student(req);
  const visible = await feed(viewer, { limit: 100 });
  if (!visible.some((a) => String(a.id) === String(req.params.id))) return res.status(404).end();
  const image = await db.prepare('SELECT mime, content FROM announcement_images WHERE announcement_id=?').get(Number(req.params.id));
  if (!image?.content) return res.status(404).end();
  const content = Buffer.isBuffer(image.content) ? image.content : Buffer.from(image.content);
  res.setHeader('Content-Type', image.mime || 'application/octet-stream');
  res.setHeader('Content-Length', content.length);
  res.setHeader('Cache-Control', 'private, max-age=300');
  res.end(content);
}));

/* Détail d'une annonce : vue immersive ouverte par un appui sur la carte. */
r.get('/accueil/annonces/:id', (req, res, next) => {
  if (!req.user) { res.redirect(303, '/login?err=' + encodeURIComponent('Session requise — connectez-vous.')); return; }
  next();
}, H(async (req, res) => {
  const viewer = req.user.role === 'admin' ? req.user : await student(req);
  const visible = await feed(viewer, { limit: 100 });
  const annonce = visible.find((a) => String(a.id) === String(req.params.id));
  if (!annonce) throw notFound('Annonce introuvable');
  const liked = (await likedIds(req.user.id, [annonce.id])).has(annonce.id);
  const who = `${annonce.first_name || ''} ${annonce.last_name || ''}`.trim() || (annonce.author_role === 'admin' ? 'Administration' : 'MonRelevé');
  const authorPhoto = annonce.author_has_photo && annonce.author_id
    ? `<img class="announcement-author-photo" src="${esc(url(`/profil/photo/${annonce.author_id}`, req.ctx))}" alt="" />`
    : ANNOUNCEMENT_USER_ICON;
  const content = esc(annonce.body).replace(/\n{2,}/g, '</p><p>').replace(/\n/g, '<br/>');
  const detailImage = annonce.has_image ? url(`/accueil/annonces/${annonce.id}/image`, req.ctx) : '';
  const detailImageStyle = detailImage ? ` style="background-image:url('${esc(detailImage)}')"` : '';
  const like = `<form method="post" action="${url(`/accueil/annonces/${annonce.id}/aime`, req.ctx)}" class="detail-like">
    <input type="hidden" name="th" value="${esc(req.ctx.th || '')}"/>
    <button class="likebtn${liked ? ' on' : ''}" type="submit" aria-pressed="${liked}"><svg viewBox="0 0 24 24" width="17" height="17" fill="${liked ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20.3 4.6 13a4.6 4.6 0 0 1 6.5-6.5l.9.9.9-.9A4.6 4.6 0 1 1 19.4 13Z"/></svg><span>J’aime</span>${annonce.likes ? `<b>${annonce.likes}</b>` : ''}</button>
  </form>`;
  const body = `<article class="announcement-detail">
    <div class="announcement-detail-media${annonce.has_image ? ' has-image' : ' no-image'}"${detailImageStyle}>
      <a class="announcement-back" href="${url('/accueil', req.ctx)}" aria-label="Retour aux annonces" title="Retour aux annonces"><svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6"/></svg></a>
    </div>
    <section class="announcement-detail-sheet">
      <header class="announcement-detail-author"><span class="home-avatar">${authorPhoto}</span><div><b>${esc(who)}</b><span>${esc(relTime(annonce.created_at))}</span></div></header>
      <div class="announcement-detail-copy"><p>${content}</p></div>
      ${like}
    </section>
  </article>`;
  res.send(page(req.ctx, { title: 'Annonce', body, minimal: true, bodyClass: 'announcement-detail-page' }));
}));

/* Publication d'une annonce (administration). La pièce jointe est persistée dans la BDD. */
r.post('/accueil/annonces', need('admin'), announcementUpload.single('image'), H(async (req, res) => {
  const fail = (m) => res.redirect(303, url('/accueil', { ...req.ctx, err: m }));
  const text = String(req.body.body || '').trim();
  if (!text) return fail('Annonce vide : écrivez un texte.');
  const audience = ['all', 'program'].includes(req.body.audience) ? req.body.audience : 'all';
  const pinned = req.body.pinned ? 1 : 0;
  if (pinned && !req.file) return fail('Une publication épinglée doit avoir une image jointe.');
  let programId = null;
  if (audience === 'program') {
    programId = asNum(req.body.program_id);
    if (!programId || !await db.prepare('SELECT id FROM programs WHERE id=?').get(programId)) return fail('Choisissez une filière valide.');
  }
  await tx(async () => {
    const inserted = await db.prepare('INSERT INTO announcements (author_id, body, audience, program_id, class_id, pinned) VALUES (?,?,?,?,?,?)')
      .run(req.user.id, text.slice(0, 2000), audience, programId, null, pinned);
    if (req.file) {
      await db.prepare(`INSERT INTO announcement_images
        (announcement_id, file_name, mime, content, size) VALUES (?,?,?,?,?)`)
        .run(inserted.lastInsertRowid, String(req.file.originalname || 'annonce-image').slice(0, 200), req.file.mimetype, req.file.buffer, req.file.size);
    }
  });
  res.redirect(303, url('/accueil', { ...req.ctx, ok: 'Annonce publiée.' }));
}));

/* « J'aime » (bascule, une fois par personne). */
r.post('/accueil/annonces/:id/aime', (req, res, next) => {
  if (!req.user) { res.redirect(303, '/login?err=' + encodeURIComponent('Session requise — connectez-vous.')); return; }
  next();
}, H(async (req, res) => {
  const id = Number(req.params.id);
  if (!await db.prepare('SELECT id FROM announcements WHERE id=?').get(id)) throw notFound('Annonce introuvable');
  await toggleLike(id, req.user.id);
  res.redirect(303, url('/accueil', req.ctx));
}));

/* Modération : épingler / désépingler. */
r.post('/accueil/annonces/:id/epingler', need('admin'), H(async (req, res) => {
  const id = Number(req.params.id);
  const a = await db.prepare(`SELECT pinned,
    CASE WHEN ai.announcement_id IS NULL THEN 0 ELSE 1 END AS has_image
    FROM announcements a LEFT JOIN announcement_images ai ON ai.announcement_id=a.id WHERE a.id=?`).get(id);
  if (!a) throw notFound('Annonce introuvable');
  if (!a.pinned && !a.has_image) {
    res.redirect(303, url('/accueil', { ...req.ctx, err: 'Ajoutez une image avant d’épingler cette publication.' }));
    return;
  }
  await db.prepare('UPDATE announcements SET pinned=? WHERE id=?').run(a.pinned ? 0 : 1, id);
  res.redirect(303, url('/accueil', { ...req.ctx, ok: a.pinned ? 'Annonce désépinglée.' : 'Annonce épinglée.' }));
}));

/* Modération : supprimer (les « J'aime » suivent en cascade). */
r.post('/accueil/annonces/:id/supprimer', need('admin'), H(async (req, res) => {
  await db.prepare('DELETE FROM announcements WHERE id=?').run(Number(req.params.id));
  res.redirect(303, url('/accueil', { ...req.ctx, ok: 'Annonce supprimée.' }));
}));

r.get('/saisie', need('student'), H(async (req, res) => {
  const d = await studentData(await student(req));
  if (!d.template) return res.redirect(303, url('/accueil', { ...req.ctx, err: 'Aucun modèle disponible.' }));
  const cur = d.personal.semesters.find((s) => String(s.id) === String(req.query.sem)) || d.personal.semesters[0];
  const tabsHtml = `<div class="row" style="gap:6px;flex-wrap:wrap;margin-bottom:10px">${d.personal.semesters.map((s) =>
    `<a class="chip ${s.id === cur.id ? 'violet' : 'gray'}" id="tab${s.id}" style="text-decoration:none" href="${url('/saisie', { ...req.ctx, sem: s.id })}">S${s.number}${s.average != null ? ' · ' + fmt(s.average) : ''}</a>`).join('')}</div>`;
  const rows = cur.units.map((u) => {
    const cu = d.personal.semesters.find((x) => x.id === cur.id)?.units.find((x) => x.id === u.id);
    return `<tr class="ue-head"><td colspan="6">${esc(u.code)} — ${esc(u.name)} <span style="float:right">moyenne UE : <b id="ue${u.id}">${fmt(cu?.average)}</b>/20</span></td></tr>` +
      (cu?.courses.map((c) => `<tr>
        <td>${esc(c.name)}</td><td class="n">${fmt(c.coefficient, 0)}</td><td class="n">${fmt(c.credits, 0)}</td>
        <td class="note-cell n"><input class="gin" type="number" step="0.01" min="0" max="20" name="n_${c.id}" value="${c.normal ?? ''}" placeholder="—"/></td>
        <td class="note-cell n"><input class="gin" type="number" step="0.01" min="0" max="20" name="r_${c.id}" value="${c.rattrapage ?? ''}" placeholder="—"/></td>
        <td class="n"><b id="def${c.id}">${fmt(c.definitive)}</b> <span id="st${c.id}">${statusChip(c.status)}</span></td></tr>`).join('') || '');
  }).join('');
  const semestres34 = [3, 4].map((number) => d.personal.semesters.find((s) => Number(s.number) === number)).filter(Boolean);
  const topAverages = semestres34.length ? `<section class="saisie-top-averages card" aria-labelledby="saisie-top-averages-title">
      <div class="section-title" style="margin-bottom:10px"><h2 id="saisie-top-averages-title" style="font-size:16px;margin:0">Moyennes des semestres</h2><span class="tiny muted">S3 et S4</span></div>
      <div class="cards2">${semestres34.map((s) => `<div class="stat"><div class="v"><span id="topsa${s.id}">${fmt(s.average)}</span><span class="tiny muted">/20</span></div><div class="k">Moyenne S${s.number}</div></div>`).join('')}</div>
      <div class="saisie-top-download"><a class="btn sm" style="text-decoration:none;text-align:center;width:100%" href="${url('/mon-releve.pdf', { ...req.ctx, source: 'personal' })}">Télécharger mon relevé en PDF</a></div>
    </section>` : '';
  const body = topAverages + `<div class="section-title"><h1 style="font-size:18px;margin:0">Saisie de notes — S${cur.number} <span id="dirty" class="tiny" style="display:none;color:var(--warn)">· modifié, pensez à enregistrer</span></h1></div>
    <div class="cards2" style="margin-bottom:10px">
      <div class="stat"><div class="v"><span id="ga">${fmt(d.personal.generalAverage)}</span><span class="tiny muted">/20</span></div><div class="k">Moyenne générale (en direct)</div></div>
    </div>
    ${tabsHtml}
    <div class="card" style="padding:6px 10px;overflow-x:auto">
      <form method="post" action="${url('/saisie/' + cur.id, req.ctx)}">
        ${hiddenT(req.ctx.t, { th: req.ctx.th })}
        <table class="tbl"><thead><tr><th>Matière</th><th class="n">Coef</th><th class="n">Créd.</th><th class="n">Normale</th><th class="n">Rattr.</th><th class="n">Définitive</th></tr></thead>
        <tbody>${rows}</tbody></table>
        <div style="margin-top:10px"><button class="btn">Enregistrer le semestre</button></div>
      </form>
    </div>` + liveCalcScript({ rules: d.personal.rules, tree: liveTree(d.semesters), source: liveScores(d.personal) });
  res.send(stuPage(req, 'Saisie', body));
}));

r.post('/saisie/:semId', need('student'), H(async (req, res) => {
  const stud = await student(req);
  const d = await studentData(stud);
  if (!d.template) throw badRequest('Aucun modèle');
  const sem = d.semesters.find((s) => String(s.id) === String(req.params.semId));
  if (!sem) throw notFound('Semestre inconnu');
  const ids = sem.units.flatMap((u) => u.courses.map((c) => c.id));
  const stmt = await db.prepare(`INSERT INTO grades (student_id,course_id,source,normal,rattrapage,updated_at) VALUES (?,?,'personal',?,?,datetime('now'))
    ON CONFLICT(student_id,course_id,source) DO UPDATE SET normal=excluded.normal, rattrapage=excluded.rattrapage, updated_at=datetime('now')`);
  await tx(async () => { for (const cid of ids) await stmt.run(stud.id, cid, score(req.body['n_' + cid] ?? ''), score(req.body['r_' + cid] ?? '')); });
  res.redirect(303, url('/saisie', { ...req.ctx, sem: sem.id, ok: 'Notes enregistrées · moyennes recalculées.' }));
}));

/* ------------------------------------------------------------------ */
/* Archives : sujets de révision protégés par la session étudiante       */
/* Tous les modèles, niveaux et filières alimentent le même catalogue.  */
/* ------------------------------------------------------------------ */
const fileSlug = (value) => String(value || 'sujet').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase().slice(0, 70) || 'sujet';
const normalizeArchiveSearch = (value) => String(value || '').toLocaleLowerCase('fr-FR').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
const ARCHIVE_KINDS = {
  examen: { label: 'Examen', pdfLabel: 'SUJET D’EXAMEN' },
  rattrapage: { label: 'Rattrapage', pdfLabel: 'SUJET DE RATTRAPAGE' },
};

/** Catalogue commun : un étudiant peut consulter les sujets de tous les modèles. */
async function loadArchiveCatalog() {
  const templates = await db.prepare(`SELECT t.*, p.name AS program_name, l.name AS level_name, y.label AS year_label
    FROM templates t JOIN programs p ON p.id=t.program_id JOIN levels l ON l.id=t.level_id
    LEFT JOIN academic_years y ON y.id=t.academic_year_id
    ORDER BY y.start_year DESC, l.ord, p.name, t.name`).all();
  const documents = [];
  const semesters = [];
  for (const template of templates) {
    const tree = await loadTemplateTree(template.id);
    for (const semester of tree) {
      semesters.push({ template, semester });
      for (const unit of semester.units || []) for (const course of unit.courses || []) {
        for (const kind of Object.keys(ARCHIVE_KINDS)) documents.push({ source: 'generated', template, semester, unit, course, kind });
      }
    }
  }
  const imported = await db.prepare(`SELECT ad.id, ad.subject, ad.kind, ad.file_name, ad.mime, ad.size,
      y.label AS year_label, l.name AS level_name
    FROM archive_documents ad
    LEFT JOIN academic_years y ON y.id=ad.academic_year_id
    JOIN levels l ON l.id=ad.level_id
    ORDER BY ad.created_at DESC, ad.id DESC`).all();
  for (const row of imported) documents.push({
    source: 'uploaded', id: row.id, kind: row.kind, file_name: row.file_name, mime: row.mime, size: row.size,
    template: { id: null, name: 'Document importé', program_name: 'Toutes les filières', level_name: row.level_name, year_label: row.year_label },
    semester: { number: null, name: 'Archive' }, unit: { code: 'ARCHIVE', name: 'Sujet importé' }, course: { id: row.id, name: row.subject, code: null },
  });
  return { templates, documents, semesters };
}

const archiveDocumentText = (doc) => [
  doc.semester.number ? `S${doc.semester.number}` : 'Archive', doc.semester.name, doc.unit.code, doc.unit.name, doc.course.code, doc.course.name,
  doc.template.program_name, doc.template.level_name, doc.template.year_label, ARCHIVE_KINDS[doc.kind]?.label,
].filter(Boolean).join(' ');
const optionList = (values, selected) => `<option value="">Tous</option>${values.map((value) => `<option value="${esc(value)}"${String(value) === String(selected) ? ' selected' : ''}>${esc(value)}</option>`).join('')}`;

/** Génère à la demande un sujet PDF pour une matière et un modèle du catalogue. */
async function buildRevisionSubjectPdf({ template, semester, unit, course, kind = 'examen' }) {
  const kindMeta = ARCHIVE_KINDS[kind] || ARCHIVE_KINDS.examen;
  const doc = new PDFDocument({ size: 'A4', margin: 48, info: { Title: `${kindMeta.label} — ${course.name}`, Author: 'MonRelevé' } });
  const chunks = [];
  return new Promise((resolve, reject) => {
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    const ink = '#161513';
    const copper = '#BF814B';
    const paper = '#F2E9D8';
    doc.rect(0, 0, 595.28, 841.89).fill(paper);
    doc.fillColor(copper).roundedRect(48, 46, 18, 18, 4).fill();
    doc.fillColor(ink).font('Helvetica-Bold').fontSize(10).text('MONRELEVÉ', 74, 50);
    doc.fillColor('#8A857C').font('Helvetica').fontSize(8).text(`ARCHIVES · ${kindMeta.pdfLabel}`, 48, 88);
    doc.fillColor(ink).font('Helvetica-Bold').fontSize(25).text(course.name, 48, 112, { width: 495 });
    doc.fillColor('#8A857C').font('Helvetica').fontSize(10).text(`${course.code || 'Matière'}  ·  S${semester.number} — ${semester.name}  ·  ${unit.code} — ${unit.name}`, 48, 170, { width: 495 });
    doc.fillColor('#8A857C').font('Helvetica').fontSize(9).text(`${template.program_name || 'Filière'}  ·  ${template.level_name || 'Niveau'}  ·  ${template.year_label || 'Année universitaire'}`, 48, 188, { width: 495 });
    doc.moveTo(48, 211).lineTo(547, 211).lineWidth(1).strokeColor(copper).stroke();
    doc.fillColor(ink).font('Helvetica-Bold').fontSize(13).text('Consignes', 48, 233);
    doc.fillColor(ink).font('Helvetica').fontSize(10).text(kind === 'rattrapage'
      ? 'Durée conseillée : 1 h 30 · Sujet de rattrapage à utiliser comme entraînement. Justifiez vos méthodes et présentez vos réponses avec précision.'
      : 'Durée conseillée : 1 h 30 · Sujet d’examen d’entraînement. Répondez de façon structurée et justifiez vos méthodes.', 48, 258, { width: 495, lineGap: 4 });
    const prompts = [
      `1. Présentez les notions fondamentales étudiées en ${course.name} et expliquez leur utilité.`,
      '2. Définissez précisément deux concepts clés du cours et illustrez chacun par un exemple.',
      '3. Résolvez un exercice ou un cas d’application en détaillant toutes les étapes du raisonnement.',
      '4. Comparez deux méthodes, résultats ou approches vus pendant le semestre.',
      '5. Rédigez une synthèse courte : quelles connaissances devez-vous encore consolider avant l’épreuve ?',
    ];
    let y = 339;
    doc.fillColor(ink).font('Helvetica-Bold').fontSize(13).text('Sujet', 48, y); y += 28;
    for (const prompt of prompts) {
      doc.fillColor(ink).font('Helvetica').fontSize(10).text(prompt, 48, y, { width: 495, lineGap: 3 });
      y += 45;
      doc.moveTo(48, y).lineTo(547, y).lineWidth(.45).strokeColor('#C8BBAA').stroke();
      y += 20;
    }
    doc.fillColor('#8A857C').font('Helvetica').fontSize(8).text(`Modèle de formation : ${template.name} · Document de travail personnel`, 48, 785, { width: 495, align: 'center' });
    doc.end();
  });
}

const renderArchivesPage = async (req, res) => {
  const catalog = await loadArchiveCatalog();
  /* /releve reste servi comme alias de compatibilité, mais adopte l'URL active pour la navigation. */
  if (req.path === '/releve') req.ctx = { ...req.ctx, pathname: '/archives' };

  const searchQuery = String(req.query.q || '').trim();
  const normalizedQuery = normalizeArchiveSearch(searchQuery);
  const selectedYear = String(req.query.year || '');
  const selectedLevel = String(req.query.level || '');
  const selectedProgram = String(req.query.program || '');
  const selectedType = Object.hasOwn(ARCHIVE_KINDS, String(req.query.type || '')) ? String(req.query.type) : '';
  const matches = (doc) => (!normalizedQuery || normalizeArchiveSearch(archiveDocumentText(doc)).includes(normalizedQuery))
    && (!selectedYear || String(doc.template.year_label || '') === selectedYear)
    && (!selectedLevel || String(doc.template.level_name || '') === selectedLevel)
    && (!selectedProgram || doc.template.program_name === 'Toutes les filières' || String(doc.template.program_name || '') === selectedProgram)
    && (!selectedType || doc.kind === selectedType);
  const matchingDocuments = catalog.documents.filter(matches);
  const years = [...new Set(catalog.documents.map((d) => d.template.year_label).filter(Boolean))].sort().reverse();
  const levels = [...new Set(catalog.documents.map((d) => d.template.level_name).filter(Boolean))].sort();
  const programs = [...new Set(catalog.templates.map((t) => t.program_name).filter(Boolean))].sort();
  const subjectsHtml = catalog.documents.length ? catalog.documents.map((doc) => {
    const kindMeta = ARCHIVE_KINDS[doc.kind];
    const searchText = archiveDocumentText(doc);
    const initiallyVisible = matches(doc);
    const semesterLabel = doc.semester.number ? `S${doc.semester.number} · ${esc(doc.unit.code)}` : 'Document importé';
    const downloadPath = doc.source === 'uploaded'
      ? `/archives/fichiers/${encodeURIComponent(doc.id)}`
      : `/archives/sujets/${encodeURIComponent(doc.template.id)}/${encodeURIComponent(doc.course.id)}/${doc.kind}.pdf`;
    return `<article class="archive-subject card" data-archive-search="${esc(searchText)}" data-archive-year="${esc(doc.template.year_label || '')}" data-archive-level="${esc(doc.template.level_name || '')}" data-archive-program="${esc(doc.template.program_name === 'Toutes les filières' ? '' : doc.template.program_name || '')}" data-archive-type="${esc(doc.kind)}"${initiallyVisible ? '' : ' style="display:none"'}>
      <div class="row spread" style="gap:8px;align-items:flex-start"><span class="chip gray">${semesterLabel}</span><span class="chip ${doc.kind === 'rattrapage' ? 'warn' : 'info'}">${kindMeta.label}</span></div>
      <h3>${esc(doc.course.name)}</h3>
      <p class="small muted">${esc(doc.unit.name)}${doc.course.code ? ` · ${esc(doc.course.code)}` : ''}</p>
      <div class="archive-subject-details"><span>Filière ${esc(doc.template.program_name || '—')}</span><span>Niveau ${esc(doc.template.level_name || '—')}</span><span>Année ${esc(doc.template.year_label || '—')}</span></div>
      <a class="btn sm" style="width:100%;text-decoration:none;text-align:center" href="${url(downloadPath, req.ctx)}">Télécharger le sujet</a>
    </article>`;
  }).join('') : '<div class="empty">Aucun sujet de révision disponible.</div>';
  const semestersHtml = catalog.semesters.map(({ template, semester }) => `<div class="archive-semester card">
      <div class="row spread"><b>S${semester.number} — ${esc(semester.name)}</b><span class="chip gray">${esc(template.level_name || '—')}</span></div>
      <div class="small muted" style="margin-top:6px">${esc(template.program_name || '—')} · ${esc(template.year_label || '—')} · ${semester.units.reduce((n, u) => n + u.courses.length, 0)} matières</div>
    </div>`).join('');
  const body = `<div class="archive-intro">
      <h1>Archives</h1>
      <form class="archive-search" id="archive-search-form" method="get" action="/archives" role="search" autocomplete="off">
        <label class="sr-only" for="archive-search-input">Rechercher dans les archives</label>
        <div class="archive-search-row">
          <input class="input" id="archive-search-input" name="q" value="${esc(searchQuery)}" type="search" placeholder="Rechercher une matière, une UE ou un semestre" aria-controls="archive-subjects-list"/>
          <button class="icon-btn archive-filter-button" id="archive-search-filter" type="button" title="Ouvrir les filtres" aria-label="Ouvrir les filtres" aria-expanded="false" aria-controls="archive-filter-menu"><svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 5h16l-6 7v5l-4 2v-7L4 5Z"/></svg></button>
        </div>
        <div class="archive-filter-menu" id="archive-filter-menu" hidden>
          <div class="archive-filter-grid">
            <label>Année<select class="input" id="archive-filter-year" name="year">${optionList(years, selectedYear)}</select></label>
            <label>Niveau<select class="input" id="archive-filter-level" name="level">${optionList(levels, selectedLevel)}</select></label>
            <label>Filière<select class="input" id="archive-filter-program" name="program">${optionList(programs, selectedProgram)}</select></label>
            <label>Type de sujet<select class="input" id="archive-filter-type" name="type"><option value="">Tous</option><option value="examen"${selectedType === 'examen' ? ' selected' : ''}>Examen</option><option value="rattrapage"${selectedType === 'rattrapage' ? ' selected' : ''}>Rattrapage</option></select></label>
          </div>
          <div class="archive-filter-actions"><button class="btn sm" type="submit">Appliquer les filtres</button><button class="btn sm ghost" id="archive-filter-reset" type="button">Réinitialiser</button></div>
        </div>
        <div class="tiny muted" id="archive-search-status" aria-live="polite">${matchingDocuments.length} document${matchingDocuments.length > 1 ? 's' : ''}</div>
      </form>
    </div>
    <section class="archive-section" aria-labelledby="archive-subjects-title">
      <div class="section-title"><h2 id="archive-subjects-title">Sujets de révision</h2><span class="tiny muted">${catalog.documents.length} document${catalog.documents.length > 1 ? 's' : ''}</span></div>
      <div class="archive-subject-grid" id="archive-subjects-list">${subjectsHtml}</div>
      <div class="empty" id="archive-search-empty"${matchingDocuments.length || !searchQuery && !selectedYear && !selectedLevel && !selectedProgram && !selectedType ? ' hidden' : ''}>Aucun sujet ne correspond à vos filtres.</div>
    </section>
    <section class="archive-section" aria-labelledby="archive-semesters-title">
      <div class="section-title"><h2 id="archive-semesters-title">Semestres archivés</h2><span class="tiny muted">Tous les niveaux et filières</span></div>
      <div class="archive-semester-grid">${semestersHtml}</div>
    </section>
    <script>
      (function () {
        var form = document.getElementById('archive-search-form');
        var input = document.getElementById('archive-search-input');
        var filterButton = document.getElementById('archive-search-filter');
        var filterMenu = document.getElementById('archive-filter-menu');
        var resetButton = document.getElementById('archive-filter-reset');
        var year = document.getElementById('archive-filter-year');
        var level = document.getElementById('archive-filter-level');
        var program = document.getElementById('archive-filter-program');
        var type = document.getElementById('archive-filter-type');
        var status = document.getElementById('archive-search-status');
        var empty = document.getElementById('archive-search-empty');
        var cards = Array.prototype.slice.call(document.querySelectorAll('[data-archive-search]'));
        if (!form || !input || !filterButton || !filterMenu) return;
        var normalize = function (value) {
          return String(value || '').toLocaleLowerCase('fr-FR').normalize('NFD').replace(/[\\u0300-\\u036f]/g, '');
        };
        var filter = function () {
          var term = normalize(input.value.trim());
          var visible = 0;
          cards.forEach(function (card) {
            var match = (!term || normalize(card.getAttribute('data-archive-search')).indexOf(term) !== -1)
              && (!year.value || card.getAttribute('data-archive-year') === year.value)
              && (!level.value || card.getAttribute('data-archive-level') === level.value)
              && (!program.value || !card.getAttribute('data-archive-program') || card.getAttribute('data-archive-program') === program.value)
              && (!type.value || card.getAttribute('data-archive-type') === type.value);
            card.hidden = !match;
            card.classList.toggle('is-filtered', !match);
            card.style.display = match ? '' : 'none';
            if (match) visible += 1;
          });
          empty.hidden = visible !== 0 || cards.length === 0;
          empty.style.display = visible === 0 && cards.length > 0 ? '' : 'none';
          status.textContent = visible + ' document' + (visible > 1 ? 's' : '');
        };
        filterButton.addEventListener('click', function () {
          filterMenu.hidden = !filterMenu.hidden;
          filterButton.setAttribute('aria-expanded', String(!filterMenu.hidden));
        });
        [input, year, level, program, type].forEach(function (field) { field.addEventListener('input', filter); field.addEventListener('change', filter); });
        form.addEventListener('submit', function (event) { event.preventDefault(); filter(); });
        resetButton.addEventListener('click', function () { input.value = ''; year.value = ''; level.value = ''; program.value = ''; type.value = ''; filter(); });
        filter();
      })();
    </script>`;
  res.send(stuPage(req, 'Archives', body));
};

r.get(['/archives', '/releve'], need('student'), H(renderArchivesPage));

const sendArchiveSubject = async (req, res, { legacy = false } = {}) => {
  const catalog = await loadArchiveCatalog();
  const templateId = legacy ? null : String(req.params.templateId);
  const courseId = String(req.params.courseId || req.params.legacyCourseId).replace(/\.pdf$/i, '');
  const kind = legacy ? 'examen' : String(req.params.kind || '').replace(/\.pdf$/i, '');
  const doc = catalog.documents.find((item) => (!templateId || String(item.template.id) === templateId) && String(item.course.id) === courseId && item.kind === kind);
  if (!doc) throw notFound('Sujet introuvable');
  const pdf = await buildRevisionSubjectPdf(doc);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="sujet-${fileSlug(doc.kind)}-${fileSlug(doc.course.name)}-${fileSlug(doc.template.level_name)}.pdf"`);
  res.setHeader('Cache-Control', 'private, no-store');
  res.send(pdf);
};

r.get('/archives/sujets/:templateId/:courseId/:kind.pdf', need('student'), H((req, res) => sendArchiveSubject(req, res)));
r.get('/archives/sujets/:legacyCourseId.pdf', need('student'), H((req, res) => sendArchiveSubject(req, res, { legacy: true })));
r.get('/archives/fichiers/:id', need('student'), H(async (req, res) => {
  const row = await db.prepare('SELECT file_name, mime, content FROM archive_documents WHERE id=?').get(Number(req.params.id));
  if (!row) throw notFound('Sujet introuvable');
  res.setHeader('Content-Type', row.mime || 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename="${archiveDownloadName(row.file_name)}"`);
  res.setHeader('Cache-Control', 'private, no-store');
  res.send(Buffer.isBuffer(row.content) ? row.content : Buffer.from(row.content));
}));

/* ──── relevé PDF (une page A4) : mêmes données et garde-fous que le relevé fusionné ──── */
async function sendRelevePdf(res, stud, source, { allAccess = false } = {}) {
  const d = await studentData(stud);
  if (!d.template) throw badRequest('Aucun modèle pour cet étudiant');
  const official = source === 'official';
  const sems = official ? (allAccess ? d.official.semesters : d.officialVisible) : d.personal.semesters;
  if (official && !allAccess && !sems.length) throw badRequest('Aucun résultat officiel publié pour l’instant');
  const tot = official ? d.official : d.personal;
  const u = await db.prepare('SELECT first_name, last_name, email FROM users WHERE id=?').get(stud.user_id);
  const pdf = await buildRelevePdf({
    student: stud, user: u, template: d.template,
    sems, tot, source: official ? 'official' : 'personal', pubs: d.pubs,
  });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="releve-${stud.matricule}-${official ? 'officiel' : 'perso'}.pdf"`);
  res.send(pdf);
}

r.get('/mon-releve.pdf', need('student'), H(async (req, res) => {
  await sendRelevePdf(res, await student(req), req.query.source === 'official' ? 'official' : 'personal');
}));

r.get('/mon-releve.xlsx', need('student'), H(async (req, res) => {
  await sendReleveXlsx(res, await student(req), req.query.source === 'official' ? 'official' : 'personal');
}));

r.get('/moyennes', need('student'), H((req, res) => res.redirect(303, url('/saisie', req.ctx))));


/* ════════════════ EMPLOI DU TEMPS (calendrier) ════════════════ */
const DAY_NAMES = ['Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi'];

r.get('/calendrier', need('student'), H(async (req, res) => {
  const stud = await student(req);
  const d = await studentData(stud);
  const classId = stud.class_id; /* la classe porte l'emploi du temps */
  const sems = d.template ? d.personal.semesters : [];
  if (!sems.length) { res.send(stuPage(req, 'Calendrier', '<div class="empty">Aucun semestre défini pour votre filière.</div>')); return; }
  const cur = sems.find((x) => String(x.id) === String(req.query.sem)) || sems[0];
  const slots = classId ? await db.prepare(`
      SELECT sl.day AS dday, sl.slot_date, sl.start, sl.end, sl.room, sl.title, sl.slot_type,
             c.name AS cname, un.code AS ucode
      FROM schedule_slots sl
      LEFT JOIN courses c ON c.id = sl.course_id
      LEFT JOIN units un ON un.id = c.unit_id
      WHERE sl.class_id = ? AND sl.semester_id = ?
      ORDER BY sl.day, sl.start`).all(classId, cur.id) : [];
  const byDay = {};
  for (const sl of slots) (byDay[sl.dday] ||= []).push(sl);

  /* Jour sélectionné : ?d=AAAA-MM-JJ (défaut aujourd'hui). */
  const iso = (x) => `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
  const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
  let sel = /^\d{4}-\d{2}-\d{2}$/.test(req.query.d || '') ? new Date(req.query.d + 'T12:00:00') : new Date();
  if (Number.isNaN(sel.getTime())) sel = new Date();
  const selIso = iso(sel);
  const wd = (sel.getDay() + 6) % 7; /* 0 = lundi … 6 = dimanche */
  const WD = ['Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam', 'Dim'];
  const todayIso = iso(new Date());
  const link = (params) => url('/calendrier', { ...req.ctx, sem: cur.id, ...params });
  const dayIso = (dir) => { const n = new Date(sel); n.setDate(sel.getDate() + dir); return iso(n); };

  /* Semaines rendues dans la page :
     · 1 par défaut — l'app navigue par de vraies URL datées, chaque flèche = un jour ;
     · ?weeks=N (copie statique) — N semaines consécutives pré-rendues, pour avancer
       et reculer sans serveur, d'un jour à la fois, semaines comprises. */
  const nW = Math.min(15, Math.max(1, Number(req.query.weeks) || 1));
  const centre = Math.floor((nW - 1) / 2);            /* index de la semaine de la date demandée */
  const monday = new Date(sel); monday.setDate(monday.getDate() - wd);

  const weeks = [];
  for (let k = 0; k < nW; k++) {
    const mon = new Date(monday); mon.setDate(monday.getDate() + (k - centre) * 7);
    const days = WD.map((label, i) => {
      const dd = new Date(mon); dd.setDate(mon.getDate() + i);
      const list = i === 6 ? [] : (byDay[i + 1] || []).filter((sl) => !sl.slot_date || sl.slot_date === iso(dd));   /* anciens créneaux = hebdomadaires ; nouveaux = date réelle */
      const cards = list.map((sl) => {
        const exam = sl.slot_type === 'exam';
        const meta = sl.room ? 'Salle ' + sl.room : '';
        return `<div class="calcard${exam ? ' exam' : ''}"><div class="t">${esc(sl.start)}–${esc(sl.end)}${exam ? ' <b>| Examen</b>' : ''}</div><div class="n">${esc(sl.cname || sl.title || (exam ? 'Examen' : 'Cours'))}</div>${meta ? `<div class="m">${esc(meta)}</div>` : ''}</div>`;
      }).join('') || `<div class="calcard empty"><div class="n">Aucun cours ${esc(dd.toLocaleDateString('fr-FR', { weekday: 'long' }))}${i === 6 ? ' (repos dominical)' : ''}.</div></div>`;
      return {
        i, label, num: dd.getDate(), iso: iso(dd), cards,
        titre: cap(dd.toLocaleDateString('fr-FR', { weekday: 'long' })) + ' ' + String(dd.getDate()).padStart(2, '0') + '/' + String(dd.getMonth() + 1).padStart(2, '0'),
        mois: cap(dd.toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' })),
      };
    });
    weeks.push({ k, days });
  }

  const bands = weeks.map((w) => `<nav class="calstrip" data-w="${w.k}"${w.k === centre ? '' : ' hidden'} aria-label="Choisir un jour">` + w.days.map((x) => {
    const on = x.iso === selIso;
    return `<a class="cald${on ? ' on' : ''}${x.iso === todayIso && !on ? ' today' : ''}" data-today="${x.iso === todayIso ? '1' : '0'}" href="${link({ d: x.iso })}" aria-label="${esc(x.titre)}"${on ? ' aria-current="date"' : ''}><span>${x.label}</span><b>${x.num}</b></a>`;
  }).join('') + '</nav>').join('');

  const boxes = weeks.map((w) => `<div class="calweek" data-w="${w.k}"${w.k === centre ? '' : ' hidden'}>` + w.days.map((x) => `<div class="calpanel" data-i="${x.i}" data-title="${esc(x.titre)}" data-month="${esc(x.mois)}"${x.iso === selIso ? '' : ' hidden'}><div class="callist">${x.cards}</div></div>`).join('') + '</div>').join('');

  const jourSel = weeks[centre].days[wd];
  const next = link({ d: dayIso(1) }), prev = link({ d: dayIso(-1) });

  const body = `<div class="caltop"><div class="caltop-in">
    <div class="caltop-head"><h1 class="calmonth">${esc(jourSel.mois)}</h1></div>
    <div class="calbands">${bands}</div>
  </div></div>
  <section class="calsheet" data-suiv="${next}" data-prec="${prev}" data-jour="${wd}" data-semaine="${centre}" data-semaines="${nW}">
    <div class="calsheet-head"><h2 class="caldatet">${esc(jourSel.titre)}</h2><div class="carrows">
      <a class="carrow prec" href="${prev}" title="Jour précédent" aria-label="Jour précédent"><svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M14.5 5.5 8 12l6.5 6.5"/></svg></a>
      <a class="carrow suiv" href="${next}" title="Jour suivant" aria-label="Jour suivant"><svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M9.5 5.5 16 12l-6.5 6.5"/></svg></a>
    </div></div>
    <div class="calweeks">${boxes}</div>
    ${nW > 1 ? '<p class="tiny muted calborne" hidden>Borne de la copie statique — l’application permet d’aller au-delà.</p>' : ''}
  </section>
  <script>/* Navigation jour par jour, semaines comprises.
     App : chaque flèche charge une vraie page datée (URL partageable) ; ← → au clavier aussi.
     Copie statique (html[data-static]) : les N semaines rendues sont dans la page, on se déplace sans recharger. */
  (function () {
    var sheet = document.querySelector('.calsheet'); if (!sheet) return;
    var bands = [].slice.call(document.querySelectorAll('.calstrip'));
    var boxes = [].slice.call(document.querySelectorAll('.calweek'));
    var titre = document.querySelector('.caldatet'), mois = document.querySelector('.calmonth');
    var suiv = document.querySelector('.carrow.suiv'), prec = document.querySelector('.carrow.prec');
    var STATIC = document.documentElement.getAttribute('data-static') === '1';
    var W = bands.length;
    var w = parseInt(sheet.getAttribute('data-semaine'), 10) || 0;
    var i = parseInt(sheet.getAttribute('data-jour'), 10) || 0;

    function draw() {
      bands.forEach(function (b, k) { b.hidden = k !== w; });
      boxes.forEach(function (b, k) { b.hidden = k !== w; });
      boxes[w].querySelectorAll('.calpanel').forEach(function (p, j) { p.hidden = j !== i; });
      bands[w].querySelectorAll('.cald').forEach(function (a, j) {
        a.classList.toggle('on', j === i);
        a.classList.toggle('today', j !== i && a.getAttribute('data-today') === '1');
      });
      var p = boxes[w].querySelector('.calpanel[data-i="' + i + '"]');
      if (p) { if (titre) titre.textContent = p.getAttribute('data-title'); if (mois) mois.textContent = p.getAttribute('data-month'); }
      var borne = (w === W - 1 && i === 6) || (w === 0 && i === 0);
      if (suiv) suiv.setAttribute('aria-disabled', String(w === W - 1 && i === 6));
      if (prec) prec.setAttribute('aria-disabled', String(w === 0 && i === 0));
      var note = document.querySelector('.calborne'); if (note) note.hidden = !borne;
    }
    function go(nw, nj) { if (nw < 0 || nw >= W) return; w = nw; i = ((nj % 7) + 7) % 7; draw(); }
    function pas(d) {                       /* un jour à la fois, y compris en changeant de semaine */
      var j = i + d;
      if (j < 0) { if (w > 0) go(w - 1, 6); }
      else if (j > 6) { if (w < W - 1) go(w + 1, 0); }
      else go(w, j);
    }
    if (STATIC) {
      bands.forEach(function (b, k) {
        b.querySelectorAll('.cald').forEach(function (a, j) {
          a.addEventListener('click', function (e) { e.preventDefault(); go(k, j); });
        });
      });
      if (suiv) suiv.addEventListener('click', function (e) { e.preventDefault(); pas(1); });
      if (prec) prec.addEventListener('click', function (e) { e.preventDefault(); pas(-1); });
    }
    addEventListener('keydown', function (e) {
      if (e.target.closest && e.target.closest('input, select, textarea')) return;
      if (e.key === 'ArrowRight') { if (STATIC) { e.preventDefault(); pas(1); } else if (sheet.dataset.suiv) location.href = sheet.dataset.suiv; }
      else if (e.key === 'ArrowLeft') { if (STATIC) { e.preventDefault(); pas(-1); } else if (sheet.dataset.prec) location.href = sheet.dataset.prec; }
    });
  })();</script>`;
  res.send(stuPage(req, 'Calendrier', body));
}));

/* ------------------------------------------------------------------ */
/* Messagerie privée : liste de contacts puis conversation, style Messenger */
/* ------------------------------------------------------------------ */
const messageDisplayName = (u, fallback = 'Administration') =>
  u?.role === 'admin'
    ? 'Admin'
    : `${u?.first_name || ''} ${u?.last_name || ''}`.trim() || fallback;
const messageAvatar = (u, ctx, extra = '') => {
  const id = Number(u?.id ?? u?.user_id);
  const hasPhoto = Boolean(u?.has_profile_photo);
  const media = hasPhoto && Number.isInteger(id) && id > 0
    ? `<img src="${url('/profil/photo/' + id, ctx)}" alt=""/>`
    : `<svg viewBox="0 0 24 34" aria-hidden="true"><circle cx="12" cy="8" r="8"/><path d="M0 32.7C.8 24.7 5.1 20 12 20s11.2 4.7 12 12.7c.1.7-.4 1.3-1.1 1.3H1.1C.4 34-.1 33.4 0 32.7Z"/></svg>`;
  return `<span class="messenger-avatar${extra ? ` ${extra}` : ''}">${media}</span>`;
};
const sortMessages = (rows) => rows.slice().sort((a, b) => {
  const d = String(a.created_at || '').localeCompare(String(b.created_at || ''));
  return d || Number(a.id || 0) - Number(b.id || 0);
});
const previewMessage = (rows, empty = 'Aucun message pour le moment') => {
  const last = sortMessages(rows).at(-1);
  return last ? String(last.body || '').replace(/\s+/g, ' ').trim() : empty;
};
async function loadConversationMessages(studentUserId) {
  const sent = await db.prepare(`SELECT id, sender_id, subject, body, status, created_at
    FROM admin_messages WHERE sender_id=? ORDER BY created_at, id`).all(studentUserId);
  const replies = await db.prepare(`SELECT id, student_id, sender_id, body, status, created_at
    FROM admin_message_replies WHERE student_id=? ORDER BY created_at, id`).all(studentUserId);
  return sortMessages([
    ...sent.map((m) => ({ ...m, kind: 'student' })),
    ...replies.map((m) => ({ ...m, kind: 'admin', subject: '' })),
  ]);
}
const messageBubble = (m, viewer) => {
  const outgoing = viewer === 'student' ? m.kind === 'student' : m.kind === 'admin';
  const subject = m.subject && m.subject !== 'Conversation'
    ? `<span class="messenger-subject">${esc(m.subject)}</span>` : '';
  const body = esc(m.body).replace(/\r?\n/g, '<br/>');
  return `<div class="messenger-message-row ${outgoing ? 'is-outgoing' : 'is-incoming'}">
    <div class="messenger-bubble">${subject}<p>${body}</p><time>${esc(relTime(m.created_at))}</time></div>
  </div>`;
};
const messengerThread = (rows, viewer, empty) => rows.length
  ? rows.map((m) => messageBubble(m, viewer)).join('')
  : `<div class="messenger-thread-empty"><span>◌</span><p>${empty}</p></div>`;
const messengerComposer = (action, ctx, placeholder = 'Écrire un message…') => `<form class="messenger-composer" method="post" action="${action}">
  ${hiddenT(ctx.t, { th: ctx.th })}
  <input type="hidden" name="subject" value="Conversation"/>
  <textarea name="body" rows="1" maxlength="4000" placeholder="${placeholder}" required></textarea>
  <button type="submit" aria-label="Envoyer" title="Envoyer"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m4 4 17 8-17 8 3-8-3-8Z"/><path d="M7 12h14"/></svg></button>
</form>`;
const messengerContact = ({ href, avatar, name, subtitle, preview, time, unread = 0, active = false }) => `<a class="messenger-contact${active ? ' is-active' : ''}" href="${href}">
  ${avatar}<span class="messenger-contact-copy"><b>${esc(name)}</b><span>${esc(subtitle || '')}</span><em>${esc(preview || '')}</em></span>
  <span class="messenger-contact-meta">${time ? `<time>${esc(relTime(time))}</time>` : ''}${unread ? `<i>${unread > 9 ? '9+' : unread}</i>` : ''}</span>
</a>`;
const messengerPageHeading = (title) => `<div class="messenger-heading"><h1>${title}</h1></div>`;
const messengerSearch = (action, value = '') => `<form class="messenger-search" method="get" action="${action}"><input name="q" value="${esc(value)}" placeholder="Recherche" aria-label="Rechercher"/></form>`;

r.get('/messages', need('student'), H(async (req, res) => {
  const adminContact = await db.prepare(`SELECT u.id, u.role, u.first_name, u.last_name, u.email, a.department,
      CASE WHEN pp.user_id IS NULL THEN 0 ELSE 1 END AS has_profile_photo
    FROM users u JOIN admins a ON a.user_id=u.id
    LEFT JOIN profile_photos pp ON pp.user_id=u.id
    WHERE u.is_active=1 ORDER BY u.id LIMIT 1`).get()
    || { id: null, role: 'admin', first_name: 'Administration', last_name: '', department: 'Service scolarité', has_profile_photo: false };
  const search = String(req.query.q || '').trim().slice(0, 80);
  const selected = String(req.query.conversation || '').toLowerCase() === 'admin';
  if (selected) {
    await db.prepare("UPDATE admin_message_replies SET status='read' WHERE student_id=? AND status='unread'").run(req.user.id);
  }
  const rows = await loadConversationMessages(req.user.id);
  const name = messageDisplayName(adminContact, 'Administration');
  const subtitle = adminContact.email || 'Administrateur';
  const avatar = messageAvatar(adminContact, req.ctx, 'messenger-avatar-large');
  const last = sortMessages(rows).at(-1);
  const unread = rows.filter((m) => m.kind === 'admin' && m.status === 'unread').length;
  const searchableAdmin = [name, subtitle, adminContact.department, 'administration'].join(' ').toLowerCase();
  const list = !search || searchableAdmin.includes(search.toLowerCase())
    ? messengerContact({
      href: url('/messages', { ...req.ctx, conversation: 'admin' }), avatar, name,
      subtitle, preview: previewMessage(rows, 'Extrait du dernier message'),
      time: last?.created_at, unread,
      active: selected,
    })
    : '<div class="messenger-search-empty">Aucun contact trouvé.</div>';

  const body = selected
    ? `<section class="messenger-shell messenger-conversation-page">
        <header class="messenger-chat-header"><a class="messenger-back" href="${url('/messages', req.ctx)}" title="Retour" aria-label="Retour aux messages"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6"/></svg><span>Messages</span></a>${avatar}<div><b>${esc(name)}</b><span>${esc(subtitle)}</span></div></header>
        <div class="messenger-thread" data-message-thread>${messengerThread(rows, 'student', 'Votre conversation avec l’administration apparaîtra ici.')}</div>
        ${messengerComposer(url('/messages', req.ctx), req.ctx, 'Message')}
      </section>
      <script>(function(){var t=document.querySelector('[data-message-thread]');if(t)t.scrollTop=t.scrollHeight;})();</script>`
    : `<section class="messenger-shell messenger-inbox-page">
        ${messengerPageHeading('Message')}
        ${messengerSearch(url('/messages', req.ctx), search)}
        <div class="messenger-contact-list">${list}</div>
        <form class="messenger-compat-fields" aria-hidden="true"><span class="pb-send">Envoyer un message</span><input type="hidden" name="subject" value="Conversation"/><input type="hidden" name="body" value=""/></form>
      </section>`;
  res.send(stuPage(req, 'Messages', body, {
    bodyClass: selected ? 'messenger-conversation' : 'messenger-inbox',
    minimal: selected,
    tabs: selected ? null : STU_TABS,
  }));
}));

r.post('/messages', need('student'), H(async (req, res) => {
  const subject = String(req.body.subject || '').trim().slice(0, 120) || 'Conversation';
  const message = String(req.body.body || '').trim().slice(0, 4000);
  if (!message) throw badRequest('Écrivez un message avant de l’envoyer.');
  await db.prepare(`INSERT INTO admin_messages (sender_id, subject, body, status) VALUES (?,?,?,'unread')`)
    .run(req.user.id, subject, message);
  res.redirect(303, url('/messages', { ...req.ctx, conversation: 'admin', ok: 'Message envoyé.' }));
}));

r.get('/profil/photo', need(), H(async (req, res) => {
  const photo = await db.prepare('SELECT file_name, mime, content FROM profile_photos WHERE user_id=?').get(req.user.id);
  if (!photo?.content) return res.status(404).end();
  const content = Buffer.isBuffer(photo.content) ? photo.content : Buffer.from(photo.content);
  res.setHeader('Content-Type', photo.mime || 'application/octet-stream');
  res.setHeader('Content-Length', content.length);
  res.setHeader('Content-Disposition', `inline; filename="${String(photo.file_name || 'photo-profil').replace(/["\\r\\n]/g, '')}"`);
  res.setHeader('Cache-Control', 'private, max-age=300');
  res.end(content);
}));

/* Photo publique dans l’espace connecté : elle sert l’auteur réel d’une publication. */
r.get('/profil/photo/:id', need(), H(async (req, res) => {
  const photo = await db.prepare(`SELECT p.file_name, p.mime, p.content
    FROM profile_photos p JOIN users u ON u.id=p.user_id
    WHERE p.user_id=? AND u.is_active=1`).get(Number(req.params.id));
  if (!photo?.content) return res.status(404).end();
  const content = Buffer.isBuffer(photo.content) ? photo.content : Buffer.from(photo.content);
  res.setHeader('Content-Type', photo.mime || 'application/octet-stream');
  res.setHeader('Content-Length', content.length);
  res.setHeader('Content-Disposition', `inline; filename="${String(photo.file_name || 'photo-profil').replace(/["\\r\\n]/g, '')}"`);
  res.setHeader('Cache-Control', 'private, max-age=300');
  res.end(content);
}));

r.post('/profil/photo', need(), profileUpload.single('photo'), H(async (req, res) => {
  const fail = (m) => res.redirect(303, url('/profil', { ...req.ctx, err: m }));
  if (!req.file) return fail('Choisissez une photo de profil.');
  await db.prepare(`INSERT INTO profile_photos (user_id, file_name, mime, content, size, updated_at)
    VALUES (?,?,?,?,?,datetime('now'))
    ON CONFLICT(user_id) DO UPDATE SET file_name=excluded.file_name, mime=excluded.mime,
      content=excluded.content, size=excluded.size, updated_at=datetime('now')`)
    .run(req.user.id, String(req.file.originalname || 'photo-profil').slice(0, 200), req.file.mimetype, req.file.buffer, req.file.size);
  res.redirect(303, url('/profil', { ...req.ctx, ok: 'Photo de profil enregistrée.' }));
}));

r.post('/profil/photo/delete', need(), H(async (req, res) => {
  await db.prepare('DELETE FROM profile_photos WHERE user_id=?').run(req.user.id);
  res.redirect(303, url('/profil', { ...req.ctx, ok: 'Photo de profil supprimée.' }));
}));

r.get('/profil', need(), H(async (req, res) => {
  const u = req.user;
  const s = u.role === 'student' ? await student(req) : null;
  const o = u.role === 'student' ? await opts() : null;
  const adminInfo = u.role === 'admin' ? await db.prepare('SELECT department FROM admins WHERE user_id=?').get(u.id) : null;
  const initials = `${(u.first_name || u.last_name || '?').slice(0, 1)}${(u.last_name || '').slice(0, 1)}`.toUpperCase();
  const photoPreview = u.has_profile_photo
    ? `<img class="profile-photo-preview" src="${url('/profil/photo', req.ctx)}" alt="Photo de profil de ${esc(u.first_name || u.last_name || 'l’utilisateur')}"/>`
    : `<span class="profile-photo-placeholder">${esc(initials)}</span>`;
  const photoCard = `<section class="card profile-photo-card">
      <div class="profile-photo-head"><div class="profile-photo-frame">${photoPreview}</div><div><b>Photo de profil</b><p class="tiny muted" style="margin:4px 0 0">JPG, PNG ou WEBP · 5 Mo maximum</p></div></div>
      <form class="profile-photo-form" method="post" action="${url('/profil/photo', req.ctx)}" enctype="multipart/form-data">
        ${hiddenT(req.ctx.t, { th: req.ctx.th })}
        <label class="field"><span class="tiny muted">Choisir une photo</span><input class="input" type="file" name="photo" accept=".jpg,.jpeg,.png,.webp,image/jpeg,image/png,image/webp" required/></label>
        <button class="btn sm" type="submit">${u.has_profile_photo ? 'Remplacer la photo' : 'Ajouter la photo'}</button>
      </form>
      ${u.has_profile_photo ? `<form method="post" action="${url('/profil/photo/delete', req.ctx)}" style="margin-top:8px">${hiddenT(req.ctx.t, { th: req.ctx.th })}<button class="btn sm ghost" type="submit">Supprimer la photo</button></form>` : ''}
    </section>`;
  const school = u.role === 'student' ? `<h3 class="section-title" style="font-size:13px">Scolarité</h3>
    <form class="card" method="post" action="${url('/profil/enrollment', req.ctx)}">${hiddenT(req.ctx.t, { th: req.ctx.th })}
      <div class="grid" style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
        <div class="field"><label>Filière</label>${select('program_id', o.programs, s.program_id)}</div>
        <div class="field"><label>Niveau</label>${select('level_id', o.levels, s.level_id)}</div>
      </div>
      <div class="field"><label>Année universitaire</label>${select('academic_year_id', o.years.map((y) => ({ ...y, name: y.label })), s.academic_year_id)}</div>
      <button class="btn sm">Mettre à jour ma scolarité</button>
    </form>` : `<div class="card profile-account-card"><b>Compte administrateur</b><span class="tiny muted">${esc(adminInfo?.department || 'Administration')}</span></div>`;
  const body = `<h1 style="font-size:18px;margin:4px 2px 10px">Mon profil</h1>
    <div class="card profile-identity-card"><div><b>${esc(`${u.last_name || ''} ${u.first_name || ''}`.trim() || 'Profil')}</b><span class="tiny muted">${esc(u.email)}</span></div><span class="chip gray">${u.role === 'admin' ? 'Admin' : 'Étudiant'}</span></div>
    ${photoCard}
    ${school}
    <h3 class="section-title" style="font-size:13px">${u.role === 'admin' ? 'Identité affichée dans les publications' : 'Identité'}</h3>
    ${u.role === 'admin' ? '<p class="tiny muted profile-identity-help">Cette identité sera affichée avec votre photo comme auteur des publications.</p>' : ''}
    <form class="card" method="post" action="${url('/profil/names', req.ctx)}">${hiddenT(req.ctx.t, { th: req.ctx.th })}
      <div class="grid" style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
        <div class="field"><label>${u.role === 'admin' ? 'Nom affiché' : 'Nom'}</label><input class="input" name="last_name" value="${esc(u.last_name || '')}"/></div>
        <div class="field"><label>Prénom</label><input class="input" name="first_name" value="${esc(u.first_name || '')}"/></div>
      </div>
      <button class="btn sm">Enregistrer</button>
    </form>
    <h3 class="section-title" style="font-size:13px">Mot de passe</h3>
    <form class="card" method="post" action="${url('/profil/password', req.ctx)}">${hiddenT(req.ctx.t, { th: req.ctx.th })}
      <div class="field"><label>Mot de passe actuel</label><input class="input" type="password" name="old_password" required/></div>
      <div class="grid" style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
        <div class="field"><label>Nouveau</label><input class="input" type="password" name="password" minlength="6" required/></div>
        <div class="field"><label>Confirmation</label><input class="input" type="password" name="password2" minlength="6" required/></div>
      </div>
      <button class="btn sm">Changer le mot de passe</button>
    </form>
    <div class="profile-logout-wrap"><a class="btn danger profile-logout" href="${url('/deconnexion', { th: req.ctx.th })}">Se déconnecter</a></div>`;
  res.send(u.role === 'student'
    ? stuPage(req, 'Profil', body, { tabs: null, bodyClass: 'profile-page' })
    : page(req.ctx, { title: 'Profil', body, bodyClass: 'profile-page' }));
}));
r.post('/profil/enrollment', need('student'), H(async (req, res) => {
  const s = await student(req);
  const programId = asNum(req.body.program_id);
  const levelId = asNum(req.body.level_id);
  const yearId = asNum(req.body.academic_year_id) ?? null;
  const academicClass = await resolveAcademicClass(programId, levelId, yearId);
  await db.prepare('UPDATE students SET program_id=?, level_id=?, class_id=?, academic_year_id=? WHERE id=?')
    .run(programId, levelId, academicClass?.id ?? null, yearId, s.id);
  res.redirect(303, url('/profil', { ...req.ctx, ok: 'Scolarité mise à jour.' }));
}));
r.post('/profil/names', need(), H(async (req, res) => {
  await db.prepare('UPDATE users SET last_name=?, first_name=? WHERE id=?').run(String(req.body.last_name || '').trim() || req.user.last_name, String(req.body.first_name || '').trim() || req.user.first_name, req.user.id);
  res.redirect(303, url('/profil', { ...req.ctx, ok: 'Profil enregistré.' }));
}));
r.post('/profil/password', need(), H(async (req, res) => {
  const fail = (m) => res.redirect(303, url('/profil', { ...req.ctx, err: m }));
  if (!verifyPassword(String(req.body.old_password || ''), req.user.password_hash)) return fail('Mot de passe actuel incorrect.');
  if (req.body.password !== req.body.password2) return fail('La confirmation ne correspond pas.');
  if (String(req.body.password || '').length < 6) return fail('Nouveau mot de passe : 6 caractères minimum.');
  await db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(hashPassword(req.body.password), req.user.id);
  res.redirect(303, url('/profil', { ...req.ctx, ok: 'Mot de passe changé.' }));
}));

/* ------------------------------------------------------------------ */
/* Espace administrateur                                                */
/* ------------------------------------------------------------------ */
const adminPage = (req, title, body, options = {}) => page(req.ctx, { title, body, adminTab: (req.ctx.pathname.match(/^\/admin\/(etudiants|modeles|import|referentiels|emploi|messages|archives)/)?.[0] || '/admin').replace('/etudiants/', '/etudiants').replace('/modeles/', '/modeles'), ...options });

r.get('/admin', need('admin'), H(async (req, res) => {
  const st = {
    students: (await db.prepare('SELECT COUNT(*) n FROM students').get()).n,
    users: (await db.prepare('SELECT COUNT(*) n FROM users').get()).n,
    templates: (await db.prepare('SELECT COUNT(*) n FROM templates').get()).n,
    published: (await db.prepare("SELECT COUNT(*) n FROM publications WHERE status IN ('published','locked')").get()).n,
    messages: (await db.prepare("SELECT COUNT(*) n FROM admin_messages WHERE status='unread'").get()).n,
  };
  const byProgram = await db.prepare(`SELECT p.name, COUNT(s.id) n FROM students s JOIN programs p ON p.id=s.program_id GROUP BY p.id ORDER BY n DESC`).all();
  const recent = await db.prepare(`SELECT s.id, u.first_name, u.last_name, s.matricule, p.name AS program FROM students s JOIN users u ON u.id=s.user_id LEFT JOIN programs p ON p.id=s.program_id ORDER BY s.created_at DESC, s.id DESC LIMIT 6`).all();
  const body = `<h1 style="font-size:18px;margin:4px 2px 10px">Tableau de bord</h1>
    <div class="cards2">
      <div class="stat"><div class="v">${st.students}</div><div class="k">Étudiants</div></div>
      <div class="stat"><div class="v">${st.users}</div><div class="k">Comptes</div></div>
      <div class="stat"><div class="v">${st.templates}</div><div class="k">Modèles de relevés</div></div>
      <div class="stat ${st.published ? 'ok' : 'warn'}"><div class="v">${st.published}</div><div class="k">Semestres publiés</div></div>
      <div class="stat ${st.messages ? 'warn' : 'ok'}"><div class="v">${st.messages}</div><div class="k">Messages non lus</div></div>
    </div>
    <div class="row" style="gap:8px;margin:14px 0;flex-wrap:wrap">
      <a class="btn sm" style="width:auto;text-decoration:none" href="${url('/admin/etudiants', req.ctx)}">Gérer les étudiants</a>
      <a class="btn sm" style="width:auto;text-decoration:none" href="${url('/admin/messages', req.ctx)}">Messages${st.messages ? ` · ${st.messages}` : ''}</a>
      <a class="btn sm" style="width:auto;text-decoration:none" href="${url('/admin/import', req.ctx)}">Importer un Excel</a>
      <a class="btn sm ghost" style="width:auto;text-decoration:none" href="${url('/admin/modeles', req.ctx)}">Modèles & règles</a>
      <a class="btn sm ghost" style="width:auto;text-decoration:none" href="${url('/admin/referentiels', req.ctx)}">Référentiels</a>
    </div>
    <div class="grid" style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
      <div class="card"><h3 style="margin:0 0 8px;font-size:13px">Derniers inscrits</h3>
        ${recent.map((s) => `<div class="list-item tap"><a href="${url('/admin/etudiants/' + s.id, req.ctx)}" style="flex:1;display:flex;justify-content:space-between;text-decoration:none;color:inherit"><span>${esc(s.last_name)} ${esc(s.first_name)}</span><span class="tiny muted">${esc(s.program || '—')} · ${esc(s.matricule)}</span></a></div>`).join('') || '<div class="tiny muted">Aucun étudiant.</div>'}</div>
      <div class="card"><h3 style="margin:0 0 8px;font-size:13px">Répartition par filière</h3>
        <div class="row" style="gap:6px;flex-wrap:wrap">${byProgram.map((p) => chip(`${esc(p.name)} · ${p.n}`, 'violet'))}</div></div>
    </div>`;
  res.send(adminPage(req, 'Admin', body));
}));

/* — Étudiants — */
const studentSelect = `SELECT s.id, s.matricule, s.program_id, s.level_id, s.class_id, s.academic_year_id, s.created_at,
         u.id AS user_id, u.email, u.is_active, u.first_name, u.last_name,
         p.name AS program, l.name AS level, y.label AS year
  FROM students s JOIN users u ON u.id=s.user_id
  LEFT JOIN programs p ON p.id=s.program_id LEFT JOIN levels l ON l.id=s.level_id
  LEFT JOIN academic_years y ON y.id=s.academic_year_id`;

const messageStudentContacts = async () => await db.prepare(`
  SELECT s.id AS student_id, u.id AS user_id, u.email, u.first_name, u.last_name,
         p.name AS program, l.name AS level,
         CASE WHEN pp.user_id IS NULL THEN 0 ELSE 1 END AS has_profile_photo
  FROM students s
  JOIN users u ON u.id=s.user_id
  LEFT JOIN programs p ON p.id=s.program_id
  LEFT JOIN levels l ON l.id=s.level_id
  LEFT JOIN profile_photos pp ON pp.user_id=u.id
  WHERE u.is_active=1
  ORDER BY u.last_name, u.first_name, u.id`).all();

const loadAllMessageRows = async () => {
  const originals = await db.prepare(`SELECT id, sender_id, subject, body, status, created_at
    FROM admin_messages ORDER BY created_at, id`).all();
  const replies = await db.prepare(`SELECT id, student_id, sender_id, body, status, created_at
    FROM admin_message_replies ORDER BY created_at, id`).all();
  const byStudent = new Map();
  const add = (studentId, row) => { const key = Number(studentId); if (!byStudent.has(key)) byStudent.set(key, []); byStudent.get(key).push(row); };
  for (const m of originals) add(m.sender_id, { ...m, kind: 'student' });
  for (const m of replies) add(m.student_id, { ...m, kind: 'admin', subject: '' });
  for (const [key, rows] of byStudent) byStudent.set(key, sortMessages(rows));
  return byStudent;
};

r.get('/admin/messages', need('admin'), H(async (req, res) => {
  const allContacts = await messageStudentContacts();
  const search = String(req.query.q || '').trim().slice(0, 80);
  const contacts = search
    ? allContacts.filter((c) => [c.first_name, c.last_name, c.email, c.program, c.level].some((v) => String(v || '').toLowerCase().includes(search.toLowerCase())))
    : allContacts;
  const selectedId = Number(req.query.student);
  const selected = Number.isInteger(selectedId) && selectedId > 0
    ? allContacts.find((c) => Number(c.user_id) === selectedId)
    : null;
  if (selected) await db.prepare("UPDATE admin_messages SET status='read' WHERE sender_id=? AND status='unread'").run(selected.user_id);
  const byStudent = await loadAllMessageRows();
  const unreadTotal = contacts.reduce((n, c) => n + (byStudent.get(Number(c.user_id)) || []).filter((m) => m.kind === 'student' && m.status === 'unread').length, 0);

  if (selected) {
    const rows = byStudent.get(Number(selected.user_id)) || [];
    const avatar = messageAvatar(selected, req.ctx, 'messenger-avatar-large');
    const body = `<section class="messenger-shell messenger-conversation-page">
        <header class="messenger-chat-header"><a class="messenger-back" href="${url('/admin/messages', req.ctx)}" title="Retour" aria-label="Retour aux messages"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6"/></svg><span>Messages</span></a>${avatar}<div><b>${esc(messageDisplayName(selected, 'Étudiant'))}</b><span>${esc([selected.program, selected.level].filter(Boolean).join(' · ') || selected.email)}</span></div></header>
        <div class="messenger-thread" data-message-thread>${messengerThread(rows, 'admin', 'Aucun message dans cette conversation. Vous pouvez écrire le premier message.')}</div>
        ${messengerComposer(url('/admin/messages/' + selected.user_id + '/reply', req.ctx), req.ctx, 'Message')}
      </section>
      <script>(function(){var t=document.querySelector('[data-message-thread]');if(t)t.scrollTop=t.scrollHeight;})();</script>`;
    res.send(adminPage(req, 'Conversation', body, { bodyClass: 'messenger-conversation', minimal: false }));
    return;
  }

  const orderedContacts = contacts.map((c) => {
    const rows = byStudent.get(Number(c.user_id)) || [];
    return { c, rows, last: rows.at(-1) };
  }).sort((a, b) => {
    const at = a.last?.created_at ? String(a.last.created_at) : '';
    const bt = b.last?.created_at ? String(b.last.created_at) : '';
    if (at && bt) return bt.localeCompare(at) || Number(b.c.user_id) - Number(a.c.user_id);
    if (at) return -1;
    if (bt) return 1;
    return `${a.c.last_name || ''} ${a.c.first_name || ''}`.localeCompare(`${b.c.last_name || ''} ${b.c.first_name || ''}`);
  });
  const list = orderedContacts.length
    ? orderedContacts.map(({ c, rows, last }) => {
      const unread = rows.filter((m) => m.kind === 'student' && m.status === 'unread').length;
      return messengerContact({
        href: url('/admin/messages', { ...req.ctx, student: c.user_id }),
        avatar: messageAvatar(c, req.ctx),
        name: messageDisplayName(c, 'Étudiant'),
        subtitle: [c.program, c.level].filter(Boolean).join(' · ') || c.email,
        preview: previewMessage(rows, 'Extrait du dernier message'),
        time: last?.created_at, unread,
      });
    }).join('')
    : '<div class="messenger-thread-empty"><span>◌</span><p>Aucun étudiant disponible.</p></div>';
  const body = `<section class="messenger-shell messenger-inbox-page">
      ${messengerPageHeading('Message')}
      ${messengerSearch(url('/admin/messages', req.ctx), search)}
      <div class="messenger-contact-list">${list}</div>
    </section>`;
  res.send(adminPage(req, 'Messages', body, { bodyClass: 'messenger-inbox', minimal: false }));
}));

r.post('/admin/messages/:studentId/reply', need('admin'), H(async (req, res) => {
  const studentId = Number(req.params.studentId);
  const contact = await db.prepare(`SELECT u.id FROM users u JOIN students s ON s.user_id=u.id
    WHERE u.id=? AND u.role='student' AND u.is_active=1`).get(studentId);
  if (!contact) throw notFound('Étudiant introuvable');
  const body = String(req.body.body || '').trim().slice(0, 4000);
  if (!body) throw badRequest('Écrivez une réponse avant de l’envoyer.');
  await db.prepare(`INSERT INTO admin_message_replies (student_id, sender_id, body, status)
    VALUES (?,?,?,'unread')`).run(studentId, req.user.id, body);
  res.redirect(303, url('/admin/messages', { ...req.ctx, student: studentId, ok: 'Réponse envoyée.' }));
}));

/* Compatibilité avec les anciens liens « marquer comme lu ». */
r.post('/admin/messages/:id/read', need('admin'), H(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) throw notFound('Message introuvable');
  await db.prepare("UPDATE admin_messages SET status='read' WHERE id=?").run(id);
  res.redirect(303, url('/admin/messages', req.ctx));
}));

r.get('/admin/etudiants', need('admin'), H(async (req, res) => {
  const q = String(req.query.q || '').trim();
  let rows = await db.prepare(studentSelect + ' ORDER BY u.last_name, u.first_name LIMIT 500').all();
  if (q) { const qq = q.toLowerCase(); rows = rows.filter((s) => [s.first_name, s.last_name, s.email, s.matricule].some((v) => String(v || '').toLowerCase().includes(qq))); }
  const o = await opts();
  const body = `<div class="row spread" style="margin:4px 2px 10px"><h1 style="font-size:18px;margin:0">Étudiants (${rows.length})</h1></div>
    <form class="card" method="get" action="${url('/admin/etudiants', req.ctx)}" style="padding:10px"><div class="row" style="gap:8px">
      <input class="input grow" name="q" value="${esc(q)}" placeholder="Rechercher nom, e-mail, matricule…"/>
      <button class="btn sm mini" style="width:auto">Chercher</button></div></form>
    <div class="card" style="padding:6px 10px;overflow-x:auto"><table class="tbl"><thead><tr><th>Nom</th><th>Matricule</th><th>Filière</th><th>Niveau</th><th>Compte</th><th></th></tr></thead><tbody>
    ${rows.map((s) => `<tr><td><a class="link-btn" href="${url('/admin/etudiants/' + s.id, req.ctx)}">${esc(s.last_name)} ${esc(s.first_name)}</a><div class="tiny muted">${esc(s.email)}</div></td>
      <td>${esc(s.matricule)}</td><td>${esc(s.program || '—')}</td><td>${esc(s.level || '—')}</td>
      <td>${s.is_active ? chip('Actif', 'ok') : chip('Désactivé', 'bad')}</td>
      <td class="n"><a class="chip violet" style="text-decoration:none" href="${url('/admin/etudiants/' + s.id, req.ctx)}">Ouvrir</a></td></tr>`).join('')}
    </tbody></table></div>
    <details class="card" style="margin-top:12px"><summary style="cursor:pointer;font-weight:700">Créer un étudiant</summary>
      <form method="post" action="${url('/admin/etudiants', req.ctx)}" style="margin-top:10px">${hiddenT(req.ctx.t, { th: req.ctx.th })}
      <div class="grid" style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px">
        <div class="field"><label>Nom *</label><input class="input" name="last_name" required/></div>
        <div class="field"><label>Prénom *</label><input class="input" name="first_name" required/></div>
        <div class="field"><label>Matricule *</label><input class="input" name="matricule" required/></div>
      </div>
      <div class="grid" style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
        <div class="field"><label>E-mail *</label><input class="input" type="email" name="email" required/></div>
        <div class="field"><label>Mot de passe initial</label><input class="input" name="password" placeholder="etudiant123 par défaut"/></div>
        <div class="field"><label>Filière</label>${select('program_id', o.programs, '', '')}</div>
        <div class="field"><label>Niveau</label>${select('level_id', o.levels, '', '')}</div>
      </div>
      <button class="btn sm">Créer le compte étudiant</button>
      <p class="tiny muted" style="margin-top:6px">Sans mot de passe saisi, le mot de passe de démonstration est attribué et affiché après création.</p></form></details>`;
  res.send(adminPage(req, 'Étudiants', body));
}));

r.post('/admin/etudiants', need('admin'), H(async (req, res) => {
  const b = req.body;
  for (const f of ['first_name', 'last_name', 'email', 'matricule']) if (!String(b[f] || '').trim()) return res.redirect(303, url('/admin/etudiants', { ...req.ctx, err: `Champ manquant : ${f}` }));
  if (!emailRe.test(b.email)) return res.redirect(303, url('/admin/etudiants', { ...req.ctx, err: 'E-mail invalide' }));
  const generated = !String(b.password || '').trim();
  const pw = generated ? 'etudiant123' : String(b.password);
  const programId = asNum(b.program_id);
  const levelId = asNum(b.level_id);
  const yearId = asNum(b.academic_year_id) ?? (await db.prepare('SELECT id FROM academic_years WHERE is_current=1').get())?.id ?? null;
  const academicClass = await resolveAcademicClass(programId, levelId, yearId);
  const ui = await tx(async () => {
    const x = await db.prepare('INSERT INTO users (email,password_hash,role,first_name,last_name) VALUES (?,?,?,?,?)')
      .run(b.email.trim().toLowerCase(), hashPassword(pw), 'student', b.first_name.trim(), b.last_name.trim());
    await db.prepare('INSERT INTO students (user_id,matricule,program_id,level_id,class_id,academic_year_id) VALUES (?,?,?,?,?,?)')
      .run(x.lastInsertRowid, b.matricule.trim(), programId, levelId, academicClass?.id ?? null, yearId);
    return x;
  });
  res.redirect(303, url('/admin/etudiants/' + (await db.prepare('SELECT id FROM students WHERE user_id=?').get(ui.lastInsertRowid)).id, { ...req.ctx, ok: 'Étudiant créé' + (generated ? ' — mot de passe initial : etudiant123' : ' — mot de passe : le vôtre') }));
}));

r.get('/admin/etudiants/:id', need('admin'), H(async (req, res) => {
  const s = await db.prepare(studentSelect + ' WHERE s.id=?').get(Number(req.params.id));
  if (!s) throw notFound('Étudiant introuvable');
  const d = await studentData(s);
  const o = await opts();
  const officialSem = d.template ? d.official.semesters : [];
  const gradesTables = d.template ? officialSem.map((sem, idx) => {
    const tree = d.semesters.find((x) => x.id === sem.id);
    const pub = d.pubs[sem.id] || { status: 'draft' };
    const locked = pub.status === 'locked';
    return `<div class="sem-title"><h2>S${sem.number} — ${esc(sem.name)} <span class="tiny muted" style="font-weight:400">moyenne en direct : <b id="sa${sem.id}">${fmt(sem.average)}</b>/20</span></h2>${pubChip(pub.status)}${locked ? ' <span class="tiny muted">· déverrouillez pour corriger</span>' : ''}</div>
      <form class="card" style="padding:6px 10px;overflow-x:auto" method="post" action="${url('/admin/etudiants/' + s.id + '/official/' + sem.id, req.ctx)}">${hiddenT(req.ctx.t, { th: req.ctx.th })}
      <table class="tbl"><thead><tr><th>Matière</th><th class="n">Normale</th><th class="n">Rattr.</th><th class="n">Définitive</th><th>Statut</th></tr></thead><tbody>
      ${sem.units.map((u) => `<tr class="ue-head"><td colspan="5">${esc(u.code)} — ${esc(u.name)} · <b id="ue${u.id}">${fmt(u.average)}</b>/20</td></tr>` +
        u.courses.map((c) => {
          const cid = c.id;
          return `<tr><td>${esc(c.name)}</td>
          <td class="n"><input class="gin" type="number" step="0.01" min="0" max="20" name="n_${cid}" value="${c.normal ?? ''}" ${locked ? 'disabled' : ''}/></td>
          <td class="n"><input class="gin" type="number" step="0.01" min="0" max="20" name="r_${cid}" value="${c.rattrapage ?? ''}" ${locked ? 'disabled' : ''}/></td>
          <td class="n"><b id="def${cid}">${fmt(c.definitive)}</b></td><td><span id="st${cid}">${statusChip(c.status)}</span></td></tr>`;
        }).join('')).join('')}
      </tbody></table>
      ${locked ? '' : '<div style="margin-top:10px"><button class="btn sm">Enregistrer (source officielle)</button></div>'}
      </form>`;
  }).join('') : '';
  const body = `<div class="row spread" style="margin:4px 2px 10px;flex-wrap:wrap;gap:8px">
      <h1 style="font-size:18px;margin:0">${esc(s.last_name)} ${esc(s.first_name)}</h1>
      <div class="row" style="gap:6px;flex-wrap:wrap">${d.template ? chip(esc(d.template.name), 'violet') : chip('Aucun modèle', 'bad')} ${s.is_active ? chip('Actif', 'ok') : chip('Désactivé', 'bad')}</div></div>
    ${d.template ? `<div class="cards2"><div class="stat"><div class="v">${fmt(d.official.generalAverage)}</div><div class="k">Moyenne officielle</div></div>
      <div class="stat ok"><div class="v">${fmt(d.official.creditsEarned, 0)}</div><div class="k">Crédits / ${fmt(d.official.creditsExpected, 0)}</div></div>
      <div class="stat"><div class="v">${fmt(d.personal.generalAverage)}</div><div class="k">Moyenne perso (brouillon)</div></div></div>` : ''}
    <div class="row" style="gap:8px;margin:12px 0;flex-wrap:wrap">
      <a class="btn sm ghost" style="width:auto;text-decoration:none" href="${url('/admin/fichiers/releve/' + s.id + '.pdf', { ...req.ctx, source: 'official' })}">Relevé officiel (PDF, une page)</a>
      <a class="btn sm ghost" style="width:auto;text-decoration:none" href="${url('/admin/fichiers/releve/' + s.id + '.pdf', { ...req.ctx, source: 'personal' })}">Relevé perso (PDF)</a>
    </div>
    <details class="card"><summary style="cursor:pointer;font-weight:700">Modifier la fiche (scolarité, contact, mot de passe)</summary>
      <form method="post" action="${url('/admin/etudiants/' + s.id, req.ctx)}" style="margin-top:10px">${hiddenT(req.ctx.t, { th: req.ctx.th })}
      <div class="grid" style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px">
        <div class="field"><label>Nom</label><input class="input" name="last_name" value="${esc(s.last_name)}"/></div>
        <div class="field"><label>Prénom</label><input class="input" name="first_name" value="${esc(s.first_name)}"/></div>
        <div class="field"><label>Matricule</label><input class="input" name="matricule" value="${esc(s.matricule)}"/></div>
      </div>
      <div class="grid" style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
        <div class="field"><label>E-mail</label><input class="input" type="email" name="email" value="${esc(s.email)}"/></div>
        <div class="field"><label>Réinitialiser le mot de passe</label><input class="input" name="reset_password" placeholder="Laisser vide pour ne pas changer"/></div>
        <div class="field"><label>Filière</label>${select('program_id', o.programs, s.program_id)}</div>
        <div class="field"><label>Niveau</label>${select('level_id', o.levels, s.level_id)}</div>
      </div>
      <div class="row" style="gap:8px;flex-wrap:wrap"><button class="btn sm">Enregistrer</button>
      <button class="btn sm ghost" name="toggle_active" value="1" formnovalidate>${s.is_active ? 'Désactiver le compte' : 'Réactiver le compte'}</button></div></form>
      <form method="post" action="${url('/admin/etudiants/' + s.id + '/delete', req.ctx)}" style="margin-top:10px">${hiddenT(req.ctx.t, { th: req.ctx.th })}
      <label class="small" style="display:flex;gap:8px;align-items:center"><input type="checkbox" name="confirm" value="1"/> Supprimer définitivement l’étudiant, son compte et ses notes</label>
      <button class="btn sm danger" style="width:auto;margin-top:6px">Supprimer</button></form>
    </details>
    ${gradesTables}` + (d.template ? liveCalcScript({ rules: d.official.rules, tree: liveTree(d.semesters), source: liveScores(d.official) }) : '');
  res.send(adminPage(req, 'Étudiant', body));
}));

r.post('/admin/etudiants/:id', need('admin'), H(async (req, res) => {
  const s = await db.prepare('SELECT * FROM students WHERE id=?').get(Number(req.params.id));
  if (!s) throw notFound();
  const b = req.body;
  if (b.toggle_active) { await db.prepare('UPDATE users SET is_active=1-is_active WHERE id=?').run(s.user_id); return res.redirect(303, url('/admin/etudiants/' + s.id, { ...req.ctx, ok: 'Compte mis à jour.' })); }
  const programId = asNum(b.program_id);
  const levelId = asNum(b.level_id);
  const academicClass = await resolveAcademicClass(programId, levelId, s.academic_year_id);
  await tx(async () => {
    await db.prepare('UPDATE users SET first_name=COALESCE(?,first_name), last_name=COALESCE(?,last_name), email=COALESCE(?,email) WHERE id=?')
      .run(String(b.first_name || '').trim() || null, String(b.last_name || '').trim() || null, b.email ? String(b.email).trim().toLowerCase() : null, s.user_id);
    await db.prepare('UPDATE students SET matricule=COALESCE(?,matricule), program_id=?, level_id=?, class_id=?, academic_year_id=? WHERE id=?')
      .run(String(b.matricule || '').trim() || null, programId, levelId, academicClass?.id ?? null, s.academic_year_id, s.id);
    if (String(b.reset_password || '').trim()) await db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(hashPassword(b.reset_password), s.user_id);
  });
  res.redirect(303, url('/admin/etudiants/' + s.id, { ...req.ctx, ok: 'Fiche enregistrée.' }));
}));
r.post('/admin/etudiants/:id/delete', need('admin'), H(async (req, res) => {
  if (req.body.confirm !== '1') return res.redirect(303, url('/admin/etudiants/' + req.params.id, { ...req.ctx, err: 'Cochez la confirmation de suppression.' }));
  const s = await db.prepare('SELECT * FROM students WHERE id=?').get(Number(req.params.id));
  if (s) await db.prepare('DELETE FROM users WHERE id=?').run(s.user_id);
  res.redirect(303, url('/admin/etudiants', { ...req.ctx, ok: 'Étudiant supprimé.' }));
}));
r.post('/admin/etudiants/:id/official/:semId', need('admin'), H(async (req, res) => {
  const s = await db.prepare('SELECT * FROM students WHERE id=?').get(Number(req.params.id));
  if (!s) throw notFound();
  const sem = await db.prepare('SELECT * FROM semesters WHERE id=?').get(Number(req.params.semId));
  if (!sem) throw notFound('Semestre inconnu');
  const pub = await db.prepare('SELECT status FROM publications WHERE semester_id=?').get(sem.id);
  if (pub?.status === 'locked') return res.redirect(303, url('/admin/etudiants/' + s.id, { ...req.ctx, err: 'Semestre verrouillé : déverrouillez-le avant de corriger.' }));
  const courses = (await db.prepare(`SELECT c.id FROM courses c JOIN units u ON u.id=c.unit_id WHERE u.semester_id=?`).all(sem.id)).map((c) => c.id);
  const stmt = await db.prepare(`INSERT INTO grades (student_id,course_id,source,normal,rattrapage,updated_at) VALUES (?,?,'official',?,?,datetime('now'))
    ON CONFLICT(student_id,course_id,source) DO UPDATE SET normal=excluded.normal, rattrapage=excluded.rattrapage, updated_at=datetime('now')`);
  await tx(async () => { for (const cid of courses) await stmt.run(s.id, cid, score(req.body['n_' + cid] ?? ''), score(req.body['r_' + cid] ?? '')); });
  res.redirect(303, url('/admin/etudiants/' + s.id, { ...req.ctx, ok: 'Notes officielles enregistrées (S' + sem.number + ').' }));
}));

/* — Modèles de relevés — */
r.get('/admin/modeles', need('admin'), H(async (req, res) => {
  const rows = await db.prepare(`SELECT t.*, p.name AS program, l.name AS level, y.label AS year,
      (SELECT COUNT(*) FROM semesters s WHERE s.template_id=t.id) AS n_semesters,
      (SELECT COUNT(*) FROM courses c JOIN units u ON u.id=c.unit_id JOIN semesters s2 ON s2.id=u.semester_id WHERE s2.template_id=t.id) AS n_courses
    FROM templates t JOIN programs p ON p.id=t.program_id JOIN levels l ON l.id=t.level_id
    LEFT JOIN academic_years y ON y.id=t.academic_year_id ORDER BY l.ord, p.name`).all();
  const o = await opts();
  const body = `<h1 style="font-size:18px;margin:4px 2px 10px">Modèles de relevés (${rows.length})</h1>
    <div class="card" style="padding:6px 10px;overflow-x:auto"><table class="tbl"><thead><tr><th>Modèle</th><th>Filière · Niveau · Année</th><th class="n">Semestres</th><th class="n">Matières</th><th class="n"></th></tr></thead><tbody>
    ${rows.map((t) => `<tr><td><a class="link-btn" href="${url('/admin/modeles/' + t.id, req.ctx)}">${esc(t.name)}</a></td>
      <td class="tiny">${esc(t.program)} · ${esc(t.level)} · ${esc(t.year || '—')}</td><td class="n">${t.n_semesters}</td><td class="n">${t.n_courses}</td>
      <td class="n"><a class="chip gray" style="text-decoration:none" href="${url('/admin/fichiers/modele/' + t.id + '.csv', req.ctx)}">CSV</a>
      <a class="chip violet" style="text-decoration:none" href="${url('/admin/modeles/' + t.id, req.ctx)}">Ouvrir</a></td></tr>`).join('')}
    </tbody></table></div>
    <form class="card" style="margin-top:12px" method="post" action="${url('/admin/modeles', req.ctx)}">${hiddenT(req.ctx.t, { th: req.ctx.th })}
      <h3 style="margin:0 0 8px;font-size:13px">Nouveau modèle</h3>
      <div class="grid" style="display:grid;grid-template-columns:2fr 1fr 1fr 1fr;gap:10px">
        <div class="field"><label>Nom (optionnel)</label><input class="input" name="name" placeholder="ex : L3 — Droit · 2026-2027"/></div>
        <div class="field"><label>Filière *</label>${select('program_id', o.programs, '', 'required')}</div>
        <div class="field"><label>Niveau *</label>${select('level_id', o.levels, '', 'required')}</div>
        <div class="field"><label>Année *</label>${select('academic_year_id', o.years.map((y) => ({ ...y, name: y.label })), '', 'required')}</div>
      </div>
      <button class="btn sm">Créer le modèle</button>
      <p class="tiny muted" style="margin-top:6px">Un modèle vierge démarre avec les règles Excel par défaut ; tout est modifiable ensuite.</p></form>`;
  res.send(adminPage(req, 'Modèles', body));
}));

r.post('/admin/modeles', need('admin'), H(async (req, res) => {
  const b = req.body;
  const name = String(b.name || '').trim() || (async () => {
    const p = (await db.prepare('SELECT name FROM programs WHERE id=?').get(b.program_id))?.name;
    const l = (await db.prepare('SELECT name FROM levels WHERE id=?').get(b.level_id))?.name;
    return `${l} — ${p}`;
  })();
  const info = await db.prepare('INSERT INTO templates (program_id,level_id,academic_year_id,name,rules_json) VALUES (?,?,?,?,?)')
    .run(asNum(b.program_id), asNum(b.level_id), asNum(b.academic_year_id), name, JSON.stringify({}));
  res.redirect(303, url('/admin/modeles/' + info.lastInsertRowid, { ...req.ctx, ok: 'Modèle créé.' }));
}));
r.post('/admin/modeles/:id/delete', need('admin'), H(async (req, res) => {
  if (req.body.confirm !== '1') return res.redirect(303, url('/admin/modeles/' + req.params.id, { ...req.ctx, err: 'Cochez la confirmation.' }));
  await db.prepare('DELETE FROM templates WHERE id=?').run(Number(req.params.id));
  res.redirect(303, url('/admin/modeles', { ...req.ctx, ok: 'Modèle supprimé.' }));
}));

const RULE_OPTIONS = {
  final_grade_rule: [['max_normal_rattrapage', 'max(normale, rattrapage) — comme l’Excel fourni'], ['normal_then_rattrapage', 'normale, rattrapage si < seuil'], ['weighted', 'moyenne pondérée normale/rattrapage']],
  ue_average_method: [['simple', 'moyenne simple des matières de l’UE'], ['coefficient_weighted', 'pondérée par coefficients']],
  semester_average_method: [['ue_simple_mean', 'moyenne simple des UE'], ['ue_credit_weighted', 'UE pondérées par crédits'], ['course_weighted', 'toutes matières pondérées coeff.']],
  general_average_method: [['semester_mean', 'moyenne des semestres'], ['credit_weighted_semesters', 'semestres pondérés crédits']],
  credit_validation_basis: [['normal', 'note NORMALE ≥ seuil (règle relevé Excel)'], ['definitive', 'note DÉFINITIVE ≥ seuil']],
};

r.get('/admin/modeles/:id', need('admin'), H(async (req, res) => {
  const t = await db.prepare(`SELECT t.*, p.name AS program, l.name AS level, y.label AS year FROM templates t
    JOIN programs p ON p.id=t.program_id JOIN levels l ON l.id=t.level_id LEFT JOIN academic_years y ON y.id=t.academic_year_id WHERE t.id=?`).get(Number(req.params.id));
  if (!t) throw notFound('Modèle introuvable');
  const tree = await loadTemplateTree(t.id);
  const rules = resolveRules(t);
  const o = await opts();
  const ruleForm = `<h3 class="section-title" style="font-size:13px">Règles de calcul <span class="tiny muted">(tout est configurable — rien n’est codé en dur)</span></h3>
    <form class="card" method="post" action="${url('/admin/modeles/' + t.id + '/rules', req.ctx)}">${hiddenT(req.ctx.t, { th: req.ctx.th })}
    <div class="grid" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:10px">
      ${Object.entries(RULE_OPTIONS).map(([k, os]) => `<div class="field"><label>${k}</label><select class="input" name="${k}">${os.map(([v, l]) => `<option value="${v}" ${rules[k] === v ? 'selected' : ''}>${l}</option>`).join('')}</select></div>`).join('')}
      <div class="field"><label>plafond rattrapage (vide = aucun)</label><input class="input" type="number" step="0.5" min="0" max="20" name="rattrapage_cap" value="${rules.rattrapage_cap ?? ''}"/></div>
      <div class="field"><label>poids rattrapage (règle « weighted »)</label><input class="input" type="number" step="0.05" min="0" max="1" name="rattrapage_weight" value="${rules.rattrapage_weight}"/></div>
      <div class="field"><label>seuil de validation</label><input class="input" type="number" step="0.5" min="0" max="20" name="pass_threshold" value="${rules.pass_threshold}"/></div>
    </div>
    <button class="btn sm">Enregistrer les règles</button></form>`;

  const semCards = (await Promise.all(tree.map(async (s, si) => {
    const pub = await db.prepare('SELECT status FROM publications WHERE semester_id=?').get(s.id) || { status: 'draft' };
    return `<div class="card" style="margin-top:12px">
      <div class="row spread"><h3 style="margin:0;font-size:14px">Semestre ${s.number} — ${esc(s.name)}</h3><span>${pubChip(pub.status)} · ${s.units.reduce((a, u) => a + u.courses.length, 0)} matières</span></div>
      <form class="row" style="margin-top:8px;gap:6px;flex-wrap:wrap" method="post" action="${url('/admin/semesters/' + s.id, req.ctx)}">${hiddenT(req.ctx.t, { th: req.ctx.th })}
        <input class="input" style="width:70px" name="number" value="${s.number}" title="numéro"/>
        <input class="input" style="width:200px;flex:1" name="name" value="${esc(s.name)}"/>
        <input class="input" style="width:80px" type="number" name="ects_expected" value="${s.ects_expected}" title="ECTS"/>
        <button class="btn sm mini" style="width:auto">Enregistrer</button>
        <select name="action" class="input" style="width:auto"><option value="publish">Publier les résultats</option><option value="lock">Verrouiller</option><option value="unlock">Déverrouiller</option><option value="draft">Repasser en brouillon</option></select>
        <button class="btn sm mini ghost" style="width:auto" formaction="${url('/admin/semesters/' + s.id + '/publication', req.ctx)}">Appliquer publication</button>
        <button class="btn sm mini danger" style="width:auto" formaction="${url('/admin/semesters/' + s.id + '/delete', req.ctx)}">Supprimer le semestre</button>
      </form>
      ${s.units.map((u) => `<div style="margin-top:10px;border-top:1px dashed var(--line);padding-top:8px">
        <div class="row spread"><b class="small">${esc(u.code)} — ${esc(u.name)}</b>
        <form method="post" action="${url('/admin/units/' + u.id + '/delete', req.ctx)}" style="display:inline">${hiddenT(req.ctx.t, { th: req.ctx.th })}<button class="btn mini danger" style="width:auto" onclick="return true">✕ UE</button></form></div>
        <table class="tbl"><thead><tr><th>Matière</th><th class="n">Coef.</th><th class="n">Crédits</th><th></th></tr></thead><tbody>
        ${u.courses.map((c) => `<tr>
          <td><input class="input" style="padding:5px 8px;font-size:12.5px" name="name" value="${esc(c.name)}" form="cf${c.id}"/></td>
          <td class="n"><input class="gin" type="number" step="0.5" min="0" name="coefficient" value="${c.coefficient}" form="cf${c.id}"/></td>
          <td class="n"><input class="gin" type="number" step="1" min="0" name="credits" value="${c.credits}" form="cf${c.id}"/></td>
          <td class="n" style="white-space:nowrap"><button class="btn mini" style="width:auto" form="cf${c.id}">✓</button><button class="btn mini danger" style="width:auto" form="cdf${c.id}">✕</button></td></tr>`).join('')}
        </tbody></table>
        <div style="display:none">
        ${u.courses.map((c) => `<form id="cf${c.id}" method="post" action="${url('/admin/courses/' + c.id, req.ctx)}">${hiddenT(req.ctx.t, { th: req.ctx.th })}</form>
          <form id="cdf${c.id}" method="post" action="${url('/admin/courses/' + c.id + '/delete', req.ctx)}">${hiddenT(req.ctx.t, { th: req.ctx.th })}</form>`).join('')}
        </div>
        <form class="row" style="gap:6px;margin-top:6px;flex-wrap:wrap" method="post" action="${url('/admin/units/' + u.id + '/courses', req.ctx)}">${hiddenT(req.ctx.t, { th: req.ctx.th })}
          <input class="input" style="flex:1;min-width:160px;padding:7px 10px" name="name" placeholder="nouvelle matière…"/>
          <input class="gin" type="number" name="coefficient" value="1" title="coef" step="0.5"/>
          <input class="gin" type="number" name="credits" value="1" title="crédits"/>
          <button class="btn mini" style="width:auto">＋ matière</button></form>
      </div>`).join('')}
      <form class="row" style="gap:6px;margin-top:8px;flex-wrap:wrap" method="post" action="${url('/admin/semesters/' + s.id + '/units', req.ctx)}">${hiddenT(req.ctx.t, { th: req.ctx.th })}
        <input class="input" style="width:90px;padding:7px 10px" name="code" placeholder="UE12"/>
        <input class="input" style="flex:1;min-width:160px;padding:7px 10px" name="name" placeholder="nom de l’UE"/>
        <button class="btn mini" style="width:auto">＋ UE</button></form>
    </div>`;
  }))).join('');

  const body = `<div class="row spread" style="flex-wrap:wrap;gap:8px;margin:4px 2px 10px">
      <h1 style="font-size:18px;margin:0">${esc(t.name)}</h1>
      <div class="row" style="gap:6px">${chip(esc(t.program), 'violet')}${chip(esc(t.level))}${chip(esc(t.year || '—'))}
      <a class="chip gray" style="text-decoration:none" href="${url('/admin/fichiers/modele/' + t.id + '.csv', req.ctx)}">CSV structure</a></div></div>
    <form class="card" method="post" action="${url('/admin/modeles/' + t.id, req.ctx)}">${hiddenT(req.ctx.t, { th: req.ctx.th })}
      <div class="grid" style="display:grid;grid-template-columns:2fr 1fr 1fr 1fr auto;gap:10px;align-items:end">
        <div class="field"><label>Nom</label><input class="input" name="name" value="${esc(t.name)}"/></div>
        <div class="field"><label>Filière</label>${select('program_id', o.programs, t.program_id)}</div>
        <div class="field"><label>Niveau</label>${select('level_id', o.levels, t.level_id)}</div>
        <div class="field"><label>Année</label>${select('academic_year_id', o.years.map((y) => ({ ...y, name: y.label })), t.academic_year_id)}</div>
        <button class="btn sm" style="margin-bottom:18px">Enregistrer</button></div></form>
    ${ruleForm}
    <div class="section-title"><h3 style="font-size:14px;margin:0">Structure — ${tree.length} semestre(s)</h3>
      <form method="post" action="${url('/admin/modeles/' + t.id + '/semesters', req.ctx)}" class="row" style="gap:6px">${hiddenT(req.ctx.t, { th: req.ctx.th })}
        <input class="input" style="width:64px;padding:6px 8px" type="number" name="number" placeholder="n°"/>
        <input class="input" style="width:170px;padding:6px 8px" name="name" placeholder="Semestre 5"/>
        <input class="input" style="width:70px;padding:6px 8px" type="number" name="ects_expected" placeholder="ECTS" value="30"/>
        <button class="btn mini" style="width:auto">＋ semestre</button></form></div>
    ${semCards || '<div class="empty">Aucun semestre — ajoutez-en ou importez le modèle depuis un Excel.</div>'}
    <details class="card" style="margin-top:14px"><summary style="cursor:pointer;font-weight:700;color:var(--bad)">Zone de danger</summary>
      <form method="post" action="${url('/admin/modeles/' + t.id + '/delete', req.ctx)}" style="margin-top:8px">${hiddenT(req.ctx.t, { th: req.ctx.th })}
      <label class="small" style="display:flex;gap:8px;align-items:center"><input type="checkbox" name="confirm" value="1"/> Supprimer le modèle et toute sa structure (les notes des étudiants restent)</label>
      <button class="btn sm danger" style="width:auto;margin-top:6px">Supprimer le modèle</button></form></details>`;
  res.send(adminPage(req, t.name, body));
}));

r.post('/admin/modeles/:id', need('admin'), H(async (req, res) => {
  await db.prepare(`UPDATE templates SET name=?, program_id=?, level_id=?, academic_year_id=?, updated_at=datetime('now') WHERE id=?`)
    .run(String(req.body.name || '').trim(), asNum(req.body.program_id), asNum(req.body.level_id), asNum(req.body.academic_year_id), Number(req.params.id));
  res.redirect(303, url('/admin/modeles/' + req.params.id, { ...req.ctx, ok: 'Modèle enregistré.' }));
}));
r.post('/admin/modeles/:id/rules', need('admin'), H(async (req, res) => {
  const t = await db.prepare('SELECT * FROM templates WHERE id=?').get(Number(req.params.id));
  const cur = resolveRules(t);
  const nextRules = {
    ...cur,
    final_grade_rule: req.body.final_grade_rule, ue_average_method: req.body.ue_average_method,
    semester_average_method: req.body.semester_average_method, general_average_method: req.body.general_average_method,
    credit_validation_basis: req.body.credit_validation_basis,
    rattrapage_cap: req.body.rattrapage_cap === '' ? null : asNum(req.body.rattrapage_cap),
    rattrapage_weight: asNum(req.body.rattrapage_weight) ?? cur.rattrapage_weight,
    pass_threshold: asNum(req.body.pass_threshold) ?? cur.pass_threshold,
  };
  await db.prepare(`UPDATE templates SET rules_json=?, updated_at=datetime('now') WHERE id=?`).run(JSON.stringify(nextRules), t.id);
  res.redirect(303, url('/admin/modeles/' + t.id, { ...req.ctx, ok: 'Règles de calcul enregistrées — tous les barèmes sont recalculés.' }));
}));
r.post('/admin/modeles/:id/semesters', need('admin'), H(async (req, res) => {
  const number = asNum(req.body.number);
  if (number == null) return res.redirect(303, url('/admin/modeles/' + req.params.id, { ...req.ctx, err: 'Numéro de semestre requis.' }));
  const ord = (await db.prepare('SELECT COALESCE(MAX(ord),0)+1 o FROM semesters WHERE template_id=?').get(Number(req.params.id))).o;
  await db.prepare('INSERT INTO semesters (template_id,number,name,ects_expected,ord) VALUES (?,?,?,?,?)')
    .run(Number(req.params.id), number, String(req.body.name || '').trim() || `Semestre ${number}`, asNum(req.body.ects_expected) ?? 30, ord);
  res.redirect(303, url('/admin/modeles/' + req.params.id, { ...req.ctx, ok: 'Semestre ajouté.' }));
}));
r.post('/admin/semesters/:id', need('admin'), H(async (req, res) => {
  const sem = await db.prepare('SELECT * FROM semesters WHERE id=?').get(Number(req.params.id));
  await db.prepare('UPDATE semesters SET number=?, name=?, ects_expected=? WHERE id=?')
    .run(asNum(req.body.number) ?? sem.number, String(req.body.name || '').trim() || sem.name, asNum(req.body.ects_expected) ?? sem.ects_expected, sem.id);
  res.redirect(303, url('/admin/modeles/' + sem.template_id, { ...req.ctx, ok: 'Semestre mis à jour.' }));
}));
r.post('/admin/semesters/:id/delete', need('admin'), H(async (req, res) => {
  const sem = await db.prepare('SELECT * FROM semesters WHERE id=?').get(Number(req.params.id));
  await db.prepare('DELETE FROM semesters WHERE id=?').run(sem.id);
  res.redirect(303, url('/admin/modeles/' + sem.template_id, { ...req.ctx, ok: 'Semestre supprimé.' }));
}));
r.post('/admin/semesters/:id/publication', need('admin'), H(async (req, res) => {
  const sem = await db.prepare('SELECT * FROM semesters WHERE id=?').get(Number(req.params.id));
  if (!sem) throw notFound();
  const action = String(req.body.action || '');
  const current = await db.prepare('SELECT * FROM publications WHERE semester_id=?').get(sem.id);
  if (action === 'draft') await db.prepare('DELETE FROM publications WHERE semester_id=?').run(sem.id);
  else if (action === 'lock') {
    if (!current) return res.redirect(303, url('/admin/modeles/' + sem.template_id, { ...req.ctx, err: 'Publiez d’abord les résultats avant de les verrouiller.' }));
    await db.prepare(`UPDATE publications SET status='locked' WHERE semester_id=?`).run(sem.id);
  } else if (action === 'unlock') {
    if (current?.status !== 'locked') return res.redirect(303, url('/admin/modeles/' + sem.template_id, { ...req.ctx, err: 'Ce semestre n’est pas verrouillé.' }));
    await db.prepare(`UPDATE publications SET status='published' WHERE semester_id=?`).run(sem.id);
  } else {
    // publish : snapshot des résultats officiels de tous les étudiants du semestre
    const template = await db.prepare('SELECT * FROM templates WHERE id=?').get(sem.template_id);
    const tree = await loadTemplateTree(template.id);
    const semTree = tree.find((s) => s.id === sem.id);
    const students = await db.prepare('SELECT id FROM students WHERE program_id=? AND level_id=?').all(template.program_id, template.level_id);
    const snapshot = {};
    for (const st of students) {
      const ids = semTree.units.flatMap((u) => u.courses.map((c) => c.id));
      const m = new Map();
      if (ids.length) { const marks = ids.map(() => '?').join(','); for (const row of await db.prepare(`SELECT course_id, normal, rattrapage FROM grades WHERE student_id=? AND source='official' AND course_id IN (${marks})`).all(st.id, ...ids)) m.set(row.course_id, row); }
      const fake = computeReleve(template, [semTree], m);
      snapshot[st.id] = { average: fake.semesters[0]?.average ?? null, creditsEarned: fake.semesters[0]?.creditsEarned ?? 0 };
    }
    await db.prepare(`INSERT INTO publications (semester_id,status,published_by,published_at,snapshot_json) VALUES (?,'published',?,datetime('now'),?)
      ON CONFLICT(semester_id) DO UPDATE SET status='published', published_by=excluded.published_by, published_at=datetime('now'), snapshot_json=excluded.snapshot_json`)
      .run(sem.id, req.user.id, JSON.stringify({ published: true, semester: snapshot }));
  }
  res.redirect(303, url('/admin/modeles/' + sem.template_id, { ...req.ctx, ok: 'Publication : ' + action + ' ✓' }));
}));
r.post('/admin/semesters/:id/units', need('admin'), H(async (req, res) => {
  const sem = await db.prepare('SELECT * FROM semesters WHERE id=?').get(Number(req.params.id));
  const ord = (await db.prepare('SELECT COALESCE(MAX(ord),0)+1 o FROM units WHERE semester_id=?').get(sem.id)).o;
  await db.prepare('INSERT INTO units (semester_id,code,name,ord) VALUES (?,?,?,?)').run(sem.id, String(req.body.code || 'UE').trim(), String(req.body.name || '').trim() || req.body.code, ord);
  res.redirect(303, url('/admin/modeles/' + sem.template_id, { ...req.ctx, ok: 'UE ajoutée.' }));
}));
r.post('/admin/units/:id/delete', need('admin'), H(async (req, res) => {
  const u = await db.prepare(`SELECT u.*, s.template_id FROM units u JOIN semesters s ON s.id=u.semester_id WHERE u.id=?`).get(Number(req.params.id));
  await db.prepare('DELETE FROM units WHERE id=?').run(u.id);
  res.redirect(303, url('/admin/modeles/' + u.template_id, { ...req.ctx, ok: 'UE supprimée.' }));
}));
r.post('/admin/units/:id/courses', need('admin'), H(async (req, res) => {
  const u = await db.prepare(`SELECT u.*, s.template_id FROM units u JOIN semesters s ON s.id=u.semester_id WHERE u.id=?`).get(Number(req.params.id));
  if (!String(req.body.name || '').trim()) return res.redirect(303, url('/admin/modeles/' + u.template_id, { ...req.ctx, err: 'Nom de matière requis.' }));
  const ord = (await db.prepare('SELECT COALESCE(MAX(ord),0)+1 o FROM courses WHERE unit_id=?').get(u.id)).o;
  await db.prepare('INSERT INTO courses (unit_id,name,coefficient,credits,ord) VALUES (?,?,?,?,?)')
    .run(u.id, String(req.body.name).trim(), asNum(req.body.coefficient) ?? 1, asNum(req.body.credits) ?? 1, ord);
  res.redirect(303, url('/admin/modeles/' + u.template_id, { ...req.ctx, ok: 'Matière ajoutée.' }));
}));
r.post('/admin/courses/:id', need('admin'), H(async (req, res) => {
  const c = await db.prepare(`SELECT c.*, s.template_id FROM courses c JOIN units u ON u.id=c.unit_id JOIN semesters s ON s.id=u.semester_id WHERE c.id=?`).get(Number(req.params.id));
  await db.prepare('UPDATE courses SET name=?, coefficient=?, credits=? WHERE id=?')
    .run(String(req.body.name || '').trim() || c.name, asNum(req.body.coefficient) ?? c.coefficient, asNum(req.body.credits) ?? c.credits, c.id);
  res.redirect(303, url('/admin/modeles/' + c.template_id, { ...req.ctx, ok: 'Matière mise à jour — moyennes recalculées.' }));
}));
r.post('/admin/courses/:id/delete', need('admin'), H(async (req, res) => {
  const c = await db.prepare(`SELECT c.id, s.template_id FROM courses c JOIN units u ON u.id=c.unit_id JOIN semesters s ON s.id=u.semester_id WHERE c.id=?`).get(Number(req.params.id));
  await db.prepare('DELETE FROM courses WHERE id=?').run(c.id);
  res.redirect(303, url('/admin/modeles/' + c.template_id, { ...req.ctx, ok: 'Matière supprimée.' }));
}));

/* — Référentiels — */
const REF_TABLES = {
  years: { table: 'academic_years', cols: [['label', 'Libellé']], add: [['label', 'ex : 2026-2027'], ['start_year', '2026']], order: 'start_year DESC', current: true },
  programs: { table: 'programs', cols: [['name', 'Nom'], ['code', 'Code']], add: [['name', 'Gestion'], ['code', 'GEST']], order: 'name' },
  levels: { table: 'levels', cols: [['name', 'Nom'], ['cycle', 'Cycle'], ['ord', 'Ordre']], add: [['name', 'L1'], ['cycle', 'Licence'], ['ord', '1']], order: 'ord, name' },
  institutions: { table: 'institutions', cols: [['name', 'Nom'], ['code', 'Code']], add: [['name', 'Université de…'], ['code', 'UNIV']], order: 'name' },
};
r.get('/admin/referentiels', need('admin'), H(async (req, res) => {
  const o = await opts();
  const block = async (key, title) => {
    const conf = REF_TABLES[key];
    const rows = await db.prepare(`SELECT * FROM ${conf.table} ORDER BY ${conf.order}`).all();
    return `<div class="card" style="margin-bottom:12px"><h3 style="margin:0 0 8px;font-size:13px">${title}</h3>
      <table class="tbl"><tbody>${rows.map((row) => { const fid = 'rf' + key + row.id; return `<tr>
        <td>${conf.cols.map(([col, lbl]) => `<input class="input" style="padding:5px 8px;font-size:12.5px;max-width:260px;display:inline-block" name="${col}" value="${esc(row[col] ?? '')}" title="${esc(lbl)}" form="${fid}"/>`).join(' ')}</td>
        <td class="n" style="white-space:nowrap">${conf.current && row.is_current ? chip('courante', 'ok') : conf.current ? `<button class="btn mini ghost" style="width:auto" form="rc${fid}">année courante</button>` : ''}
        <button class="btn mini" style="width:auto" form="${fid}">✓</button> <button class="btn mini danger" style="width:auto" form="rd${fid}">✕</button></td></tr>`; }).join('')}</tbody></table>
      <div style="display:none">${rows.map((row) => { const fid = 'rf' + key + row.id; return `<form id="${fid}" method="post" action="${url('/admin/ref/' + key + '/' + row.id, req.ctx)}">${hiddenT(req.ctx.t, { th: req.ctx.th })}</form>
        <form id="rd${fid}" method="post" action="${url('/admin/ref/' + key + '/' + row.id + '/delete', req.ctx)}">${hiddenT(req.ctx.t, { th: req.ctx.th })}</form>
        ${conf.current ? `<form id="rc${fid}" method="post" action="${url('/admin/ref/years/' + row.id + '/current', req.ctx)}">${hiddenT(req.ctx.t, { th: req.ctx.th })}</form>` : ''}`; }).join('')}</div>
      <form class="row" style="gap:6px;margin-top:8px;flex-wrap:wrap" method="post" action="${url('/admin/ref/' + key, req.ctx)}">${hiddenT(req.ctx.t, { th: req.ctx.th })}
        ${conf.add.map(([c, ph]) => `<input class="input" style="width:150px;padding:7px 10px" name="${c}" placeholder="${esc(ph)}" ${c === conf.add[0][0] ? 'required' : ''}/>`).join('')}
        <button class="btn mini" style="width:auto">＋ Ajouter</button></form></div>`;
  };
  const body = `<h1 style="font-size:18px;margin:4px 2px 10px">Référentiels</h1>
    ${await block('years', 'Années universitaires')}
    ${await block('programs', 'Filières')}
    ${await block('levels', 'Niveaux')}
    ${await block('institutions', 'Établissements')}`;
  res.send(adminPage(req, 'Référentiels', body));
}));
r.post('/admin/ref/:key', need('admin'), H(async (req, res) => {
  const conf = REF_TABLES[req.params.key]; if (!conf) throw notFound();
  const cols = [...conf.cols.map(([c]) => c), ...conf.add.map(([c]) => c).filter((c) => !conf.cols.some(([x]) => x === c))];
  const uniq = [...new Set(cols)];
  await db.prepare(`INSERT INTO ${conf.table} (${uniq.join(',')}) VALUES (${uniq.map(() => '?').join(',')})`)
    .run(...uniq.map((c) => { const v = req.body[c]; return v === '' || v == null ? null : /^-?\d+(\.\d+)?$/.test(String(v).trim()) ? Number(v) : String(v).trim(); }));
  res.redirect(303, url('/admin/referentiels', { ...req.ctx, ok: 'Ligne ajoutée.' }));
}));
r.post('/admin/ref/:key/:id', need('admin'), H(async (req, res) => {
  const conf = REF_TABLES[req.params.key]; if (!conf) throw notFound();
  const sets = conf.cols.map(([c]) => c).filter((c) => req.body[c] !== undefined);
  if (sets.length) await db.prepare(`UPDATE ${conf.table} SET ${sets.map((c) => c + '=?').join(',')} WHERE id=?`)
    .run(...sets.map((c) => { const v = req.body[c]; return v === '' || v == null ? null : /^-?\d+(\.\d+)?$/.test(String(v).trim()) ? Number(v) : String(v).trim(); }), Number(req.params.id));
  res.redirect(303, url('/admin/referentiels', { ...req.ctx, ok: 'Ligne mise à jour.' }));
}));
r.post('/admin/ref/years/:id/current', need('admin'), H(async (req, res) => {
  await tx(async () => { await db.prepare('UPDATE academic_years SET is_current=0').run(); await db.prepare('UPDATE academic_years SET is_current=1 WHERE id=?').run(Number(req.params.id)); });
  res.redirect(303, url('/admin/referentiels', { ...req.ctx, ok: 'Année courante définie.' }));
}));
r.post('/admin/ref/:key/:id/delete', need('admin'), H(async (req, res) => {
  const conf = REF_TABLES[req.params.key]; if (!conf) throw notFound();
  try { await db.prepare(`DELETE FROM ${conf.table} WHERE id=?`).run(Number(req.params.id)); } catch { return res.redirect(303, url('/admin/referentiels', { ...req.ctx, err: 'Suppression impossible : cette ligne est référencée ailleurs.' })); }
  res.redirect(303, url('/admin/referentiels', { ...req.ctx, ok: 'Ligne supprimée.' }));
}));

/* ------------------------------------------------------------------ */
/* Archives administrables : dépôt de sujets (3 Mo maximum)            */
/* ------------------------------------------------------------------ */
const ARCHIVE_YEAR_MIN = 2022;
const ARCHIVE_YEAR_MAX = 2027;
const archiveYearLabel = (startYear) => `${startYear}-${startYear + 1}`;

/** Les imports Archives proposent toujours les années universitaires 2022-2023 à 2027-2028. */
async function ensureArchiveYears() {
  const labels = Array.from({ length: ARCHIVE_YEAR_MAX - ARCHIVE_YEAR_MIN + 1 }, (_, index) => archiveYearLabel(ARCHIVE_YEAR_MIN + index));
  const placeholders = labels.map(() => '?').join(',');
  const existing = await db.prepare(`SELECT id, label, start_year FROM academic_years
    WHERE start_year BETWEEN ? AND ? OR label IN (${placeholders})`)
    .all(ARCHIVE_YEAR_MIN, ARCHIVE_YEAR_MAX, ...labels);
  const byLabel = new Map(existing.map((row) => [String(row.label), row]));
  for (let year = ARCHIVE_YEAR_MIN; year <= ARCHIVE_YEAR_MAX; year += 1) {
    const label = archiveYearLabel(year);
    if (byLabel.has(label)) continue;
    try {
      await db.prepare('INSERT INTO academic_years (label, start_year, is_current) VALUES (?,?,0)').run(label, year);
    } catch (error) {
      /* Une autre instance peut avoir créé la même année simultanément. */
      if (!/unique|duplicate/i.test(String(error?.message || error))) throw error;
    }
  }
  return db.prepare(`SELECT id, label, start_year FROM academic_years
    WHERE start_year BETWEEN ? AND ? OR label IN (${placeholders})
    ORDER BY start_year DESC, label DESC`).all(ARCHIVE_YEAR_MIN, ARCHIVE_YEAR_MAX, ...labels);
}

async function loadArchiveSubjectSuggestions() {
  return db.prepare(`SELECT name AS subject FROM courses
      WHERE name IS NOT NULL AND TRIM(name) <> ''
    UNION
    SELECT subject FROM archive_documents
      WHERE subject IS NOT NULL AND TRIM(subject) <> ''
    ORDER BY subject`).all();
}

const archiveDownloadName = (value) => String(value || 'archive-document').replace(/[\"\r\n]/g, '_').slice(0, 180);
const archiveUploadOne = (req, res, next) => archiveUpload.single('file')(req, res, (err) => {
  if (!err) return next();
  if (err.code === 'LIMIT_FILE_SIZE') return next(badRequest('Fichier trop volumineux : 3 Mo maximum.'));
  next(err);
});

r.get('/admin/archives', need('admin'), H(async (req, res) => {
  const [years, levels, subjectSuggestions] = await Promise.all([
    ensureArchiveYears(),
    db.prepare('SELECT id, name FROM levels ORDER BY ord, name').all(),
    loadArchiveSubjectSuggestions(),
  ]);
  const rows = await db.prepare(`SELECT ad.id, ad.subject, ad.kind, ad.file_name, ad.mime, ad.size, ad.created_at,
      y.label AS year_label, l.name AS level_name
    FROM archive_documents ad
    LEFT JOIN academic_years y ON y.id=ad.academic_year_id
    JOIN levels l ON l.id=ad.level_id
    ORDER BY ad.created_at DESC, ad.id DESC`).all();
  const sizeMo = (value) => `${(Number(value || 0) / (1024 * 1024)).toFixed(2)} Mo`;
  const list = rows.length ? `<div class="stack">${rows.map((row) => `<div class="card archive-admin-item">
      <div class="row spread" style="gap:10px;align-items:flex-start"><div><b>${esc(row.subject)}</b><div class="tiny muted">${esc(row.file_name)} · ${esc(row.mime)} · ${sizeMo(row.size)}</div></div><span class="chip ${row.kind === 'rattrapage' ? 'warn' : 'info'}">${row.kind === 'rattrapage' ? 'Rattrapage' : 'Examen'}</span></div>
      <div class="small muted" style="margin-top:8px">${esc(row.year_label || 'Année non renseignée')} · ${esc(row.level_name)} · <a href="${url('/admin/archives/fichiers/' + row.id, req.ctx)}">Ouvrir</a></div>
      <form method="post" action="${url('/admin/archives/' + row.id + '/delete', req.ctx)}" style="margin-top:8px"><button class="btn sm danger" type="submit">Supprimer</button></form>
    </div>`).join('')}</div>` : '<div class="empty">Aucun sujet importé pour le moment.</div>';
  const body = `<div class="row spread" style="margin:4px 2px 12px"><div><h1 style="font-size:18px;margin:0">Archives</h1><p class="small muted" style="margin:6px 0 0">Importez un sujet PDF, PNG ou JPG de 3 Mo maximum.</p></div></div>
    <form class="card archive-admin-form" method="post" action="${url('/admin/archives/import', req.ctx)}" enctype="multipart/form-data">
      ${hiddenT(req.ctx.t, { th: req.ctx.th })}
      <div class="field"><label for="archive-file">Fichier du sujet</label><input class="input" id="archive-file" type="file" name="file" accept=".pdf,.png,.jpg,.jpeg,application/pdf,image/png,image/jpeg" required/><div class="tiny muted" style="margin-top:5px">Formats acceptés : PDF, PNG, JPG · 3 Mo maximum</div></div>
      <div class="archive-admin-fields">
        <div class="field"><label for="archive-year">Année</label><select class="input" id="archive-year" name="academic_year_id" required><option value="">Choisir une année</option>${years.map((y) => `<option value="${y.id}">${esc(y.label)}</option>`).join('')}</select></div>
        <div class="field"><label for="archive-level">Niveau</label><select class="input" id="archive-level" name="level_id" required><option value="">Choisir un niveau</option>${levels.map((l) => `<option value="${l.id}">${esc(l.name)}</option>`).join('')}</select></div>
        <div class="field"><label for="archive-kind">Type de sujet</label><select class="input" id="archive-kind" name="kind" required><option value="">Choisir un type</option><option value="examen">Examen</option><option value="rattrapage">Rattrapage</option></select></div>
        <div class="field"><label for="archive-subject">Matière</label><input class="input" id="archive-subject" name="subject" list="archive-subject-suggestions" maxlength="200" placeholder="Commencez à saisir le nom de la matière" required/><datalist id="archive-subject-suggestions">${subjectSuggestions.map((row) => `<option value="${esc(row.subject)}"></option>`).join('')}</datalist><div class="tiny muted" style="margin-top:5px">Les noms des matières existantes sont proposés automatiquement.</div></div>
      </div>
      <button class="btn" type="submit">Importer dans les archives</button>
    </form>
    <section class="archive-admin-list" aria-labelledby="archive-admin-list-title"><div class="section-title"><h2 id="archive-admin-list-title" style="font-size:16px">Sujets importés</h2><span class="tiny muted">${rows.length} document${rows.length > 1 ? 's' : ''}</span></div>${list}</section>`;
  res.send(adminPage(req, 'Archives', body));
}));

r.post('/admin/archives/import', need('admin'), archiveUploadOne, H(async (req, res) => {
  await ensureArchiveYears();
  const subject = String(req.body.subject || '').trim().slice(0, 200);
  const yearId = Number(req.body.academic_year_id);
  const levelId = Number(req.body.level_id);
  const kind = String(req.body.kind || '');
  if (!req.file) throw badRequest('Sélectionnez un fichier à importer.');
  if (!subject) throw badRequest('La matière est obligatoire.');
  if (!['examen', 'rattrapage'].includes(kind)) throw badRequest('Choisissez Examen ou Rattrapage.');
  if (!Number.isInteger(yearId) || !await db.prepare('SELECT id FROM academic_years WHERE id=?').get(yearId)) throw badRequest('Année universitaire invalide.');
  if (!Number.isInteger(levelId) || !await db.prepare('SELECT id FROM levels WHERE id=?').get(levelId)) throw badRequest('Niveau invalide.');
  if (req.file.size > ARCHIVE_FILE_MAX) throw badRequest('Fichier trop volumineux : 3 Mo maximum.');
  await db.prepare(`INSERT INTO archive_documents
    (uploaded_by, academic_year_id, level_id, subject, kind, file_name, mime, content, size)
    VALUES (?,?,?,?,?,?,?,?,?)`).run(req.user.id, yearId, levelId, subject, kind, String(req.file.originalname || 'sujet').slice(0, 200), req.file.mimetype, req.file.buffer, req.file.size);
  res.redirect(303, url('/admin/archives', { ...req.ctx, ok: 'Sujet importé dans les archives.' }));
}));

r.get('/admin/archives/fichiers/:id', need('admin'), H(async (req, res) => {
  const row = await db.prepare('SELECT file_name, mime, content FROM archive_documents WHERE id=?').get(Number(req.params.id));
  if (!row) throw notFound('Sujet introuvable');
  res.setHeader('Content-Type', row.mime || 'application/octet-stream');
  res.setHeader('Content-Disposition', `inline; filename="${archiveDownloadName(row.file_name)}"`);
  res.setHeader('Cache-Control', 'private, no-store');
  res.send(Buffer.isBuffer(row.content) ? row.content : Buffer.from(row.content));
}));

r.post('/admin/archives/:id/delete', need('admin'), H(async (req, res) => {
  await db.prepare('DELETE FROM archive_documents WHERE id=?').run(Number(req.params.id));
  res.redirect(303, url('/admin/archives', { ...req.ctx, ok: 'Sujet supprimé des archives.' }));
}));

/* ------------------------------------------------------------------ */
/* Import Excel (aperçu confirmation, jamais d'écrasement silencieux) */
/* ------------------------------------------------------------------ */
/**
 * Retrouve le classeur envoyé à l'étape précédente et renvoie son contenu binaire
 * (il est stocké dans la base, pas sur un disque).
 */
const safeFile = async (fileId) => {
  const fichier = await readUpload(fileId);
  if (!fichier) throw notFound('Fichier import introuvable (ré-uploadez-le)');
  return fichier;
};

r.get('/admin/import', need('admin'), H(async (req, res) => {
  const o = await opts();
  const file = req.query.file ? String(req.query.file) : null;
  let sheetStep = '';
  let analyzeBlock = '';
  if (file) {
    try {
      const p = (await safeFile(file)).content;
      const wb = readWorkbook(p, { cellFormula: true });
      const sheets = wb.SheetNames.map((name) => {
        const aoa = wb.Sheets[name] ? XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: true, defval: null }) : [];
        const first = (aoa[0] || []).filter((v) => v != null && String(v).trim() !== '');
        return { name, rows: aoa.length, looksFlat: aoa.length >= 3 && first.length >= 3, headers: aoa.slice(0, 6) };
      });
      const sheetSel = String(req.query.sheet || sheets[0]?.name || '');
      const mode = req.query.mode === 'grades' ? 'grades' : 'structure';
      const targets = o.templates;
      sheetStep = `<div class="card"><div class="row spread"><b>${esc(String(req.query.name || file))}</b><a class="link-btn small" href="${url('/admin/import', req.ctx)}">recommencer</a></div>
        <form class="grid" style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:10px" method="get" action="${url('/admin/import', req.ctx)}">
          <input type="hidden" name="file" value="${esc(file)}"/>
          <div class="field"><label>Feuille</label><select class="input" name="sheet">${sheets.map((s) => `<option value="${esc(s.name)}" ${s.name === sheetSel ? 'selected' : ''}>${esc(s.name)} · ${s.rows} lignes</option>`).join('')}</select></div>
          <div class="field"><label>Mode d’import</label><select class="input" name="mode">
            <option value="structure" ${mode === 'structure' ? 'selected' : ''}>Structure du relevé (semestres / UE / matières)</option>
            <option value="grades" ${mode === 'grades' ? 'selected' : ''}>Notes plates (par matricule + matière)</option></select></div>
          <div class="field"><label>Modèle cible</label><select class="input" name="target" ${mode === 'grades' ? 'required' : ''}>
            <option value="">— ${mode === 'structure' ? 'aperçu sans cible' : 'choisir…'} —</option>
            ${targets.map((t) => `<option value="${t.id}" ${String(req.query.target) === String(t.id) ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}</select></div>
          ${mode === 'grades' ? (() => {
            const aoa = XLSX.utils.sheet_to_json(readWorkbook(p).Sheets[sheetSel] || {}, { header: 1, raw: true, defval: null });
            const sug = suggestMapping(aoa);
            const cols = (aoa[sug?.headerRow ?? 0] || []).filter((v) => v != null && String(v).trim() !== '').map(String);
            return `<div class="field"><label>Mapping des colonnes (noms exacts d’en-têtes)</label><div class="grid" style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px">
              ${['matricule', 'subject', 'normal', 'rattrapage', 'coefficient', 'credits'].map((k) => `<input class="input" name="map_${k}" value="${esc(sug?.cols?.[k] ?? sug?.[k] ?? '')}" placeholder="${k}"/>`).join('')}
            </div><div class="tiny muted" style="margin-top:4px">En-têtes trouvés : ${cols.map((c) => `<span class="chip gray">${esc(c)}</span>`).join(' ')}</div></div>`;
          })() : ''}
          <div><button class="btn sm">Analyser (aperçu)</button></div>
        </form></div>`;
      if (req.query.sheet) {
        // Aperçu demandé on prépare le formulaire caché d'analyse complète
        analyzeBlock = `<form method="post" action="${url('/admin/import/analyze', req.ctx)}" class="card">
          <input type="hidden" name="file" value="${esc(file)}"/><input type="hidden" name="sheet" value="${esc(sheetSel)}"/>
          <input type="hidden" name="mode" value="${esc(mode)}"/><input type="hidden" name="target" value="${esc(String(req.query.target || ''))}"/>
          ${mode === 'grades' ? ['matricule', 'subject', 'normal', 'rattrapage', 'coefficient', 'credits'].map((k) => `<input type="hidden" name="map_${k}" value="${esc(String(req.query['map_' + k] || ''))}"/>`).join('') : ''}

          <h3 style="margin:0 0 8px;font-size:13px">Aperçu de l’analyse</h3>
          <p class="tiny muted" style="margin:0 0 8px">Cliquez pour lancer l’analyse complète (aucune écriture) : correspondances, conflits, lignes ignorées.</p>
          <button class="btn sm">Lancer l’analyse</button></form>`;
      }
    } catch (e) { req.ctx.error = esc(e.message); }
  }
  const body = `<h1 style="font-size:18px;margin:4px 2px 10px">Import Excel</h1>
    <p class="small muted" style="margin:0 2px 10px">Aperçu systématique avant toute écriture · un import n’écrase jamais rien sans confirmation explicite.</p>
    ${!file ? `<form class="card" method="post" action="${url('/admin/import/upload', req.ctx)}" enctype="multipart/form-data">${hiddenT(req.ctx.t, { th: req.ctx.th })}
      <div class="row" style="gap:8px;flex-wrap:wrap;align-items:center">
        <input class="input" style="flex:1;min-width:220px" type="file" name="file" accept=".xlsx,.xls" required/>
        <button class="btn sm">Téléverser</button></div>
      <p class="tiny muted" style="margin-top:8px">Formats acceptés : .xlsx / .xls (8 Mo max). Ex. : le fichier « Relevé de notes.xlsx » fourni.</p></form>` : sheetStep + analyzeBlock}
    <h3 class="section-title" style="font-size:13px">Journal des imports</h3>
    <div class="card" style="padding:6px 10px;overflow-x:auto"><table class="tbl"><thead><tr><th>Date</th><th>Par</th><th>Résumé</th></tr></thead><tbody>
      ${(await db.prepare(`SELECT i.*, u.email FROM imports i LEFT JOIN users u ON u.id=i.user_id ORDER BY i.id DESC LIMIT 20`).all()).map((i) =>
    `<tr><td class="tiny muted">${esc(i.created_at || '')}</td><td class="tiny">${esc(i.email || '')}</td><td class="small">${esc(i.summary || '')}</td></tr>`).join('') || '<tr><td class="tiny muted">Aucun import pour l’instant.</td></tr>'}
    </tbody></table></div>`;
  res.send(adminPage(req, 'Import', body));
}));

r.post('/admin/import/upload', need('admin'), upload.single('file'), H(async (req, res) => {
  if (!req.file) return res.redirect(303, url('/admin/import', { ...req.ctx, err: 'Aucun fichier reçu.' }));
  const id = await saveUpload(req.file.originalname, req.file.buffer);
  res.redirect(303, url('/admin/import', { t: req.ctx.t, th: req.ctx.th, file: id, name: req.file.originalname }));
}));

async function analyzeImport({ file, sheet, mode, target, mapping, source = 'official' }) {
  const p = (await safeFile(file)).content;
  if (mode === 'structure') {
    const { rows } = loadSheetCells(p, sheet);
    const parsed = parseReleveStructure(rows);
    if (!parsed.ok) throw badRequest(parsed.error);
    let conflicts = null;
    if (target) {
      const existing = (await db.prepare('SELECT COUNT(*) n FROM semesters WHERE template_id=?').get(Number(target))).n;
      if (existing > 0) conflicts = `Le modèle cible contient déjà ${existing} semestre(s) : l’import les remplacera (notes conservées si les matières correspondent).`;
    }
    return {
      mode, conflicts,
      headline: `${parsed.semesters.length} semestre(s), ${parsed.semesters.reduce((a, s) => a + s.units.length, 0)} UE, ${parsed.semesters.reduce((a, s) => a + s.units.reduce((x, u) => x + u.courses.length, 0), 0)} matière(s) détectés`,
      table: `<table class="tbl"><thead><tr><th>Semestre</th><th>UE</th><th>Matière</th><th class="n">Coef.</th><th class="n">Crédits</th></tr></thead><tbody>
        ${parsed.semesters.flatMap((s) => s.units.flatMap((u) => u.courses.map((c) => `<tr><td>S${s.number}</td><td>${esc(u.code)}</td><td>${esc(c.name)}</td><td class="n">${fmt(c.coefficient ?? 1, 0)}</td><td class="n">${fmt(c.credits ?? 1, 0)}</td></tr>`))).slice(0, 200).join('')}
      </tbody></table>`,
      warnings: (parsed.warnings || []).map((w) => `<div class="warn-line">${esc(w)}</div>`).join(''),
    };
  }
  if (!target) throw badRequest('Choisissez le modèle de relevé cible');
  const template = await db.prepare('SELECT * FROM templates WHERE id=?').get(Number(target));
  if (!template) throw notFound('Modèle introuvable');
  const tree = await loadTemplateTree(template.id);
  const courseIndex = new Map();
  for (const s of tree) for (const u of s.units) for (const c of u.courses) courseIndex.set(normName(c.name), { course: c, semester: s });
  const { aoa } = loadSheetValues(p, sheet);
  const flat = parseFlatGrades(aoa, mapping || {});
  const studentsByMatricule = new Map((await db.prepare('SELECT s.id, s.matricule, u.first_name, u.last_name FROM students s JOIN users u ON u.id=s.user_id').all()).map((s) => [normName(s.matricule), s]));
  const items = (await Promise.all(flat.rows.map(async (row) => {
    const match = courseIndex.get(normName(row.subject));
    const st = row.matricule ? studentsByMatricule.get(normName(row.matricule)) : null;
    let conflict = false;
    if (match && st) {
      const existing = await db.prepare('SELECT normal, rattrapage FROM grades WHERE student_id=? AND course_id=? AND source=?').get(st.id, match.course.id, source);
      if (existing && (existing.normal != null || existing.rattrapage != null) && (row.normal != null || row.rattrapage != null)) conflict = true;
    }
    return { ...row, matched: !!match && !!st, student: st ? `${st.first_name} ${st.last_name}` : null, conflict };
  })));
  const conflicts = items.filter((i) => i.conflict).length;
  return {
    mode, templateName: template.name,
    headline: `${items.length} lignes · ${items.filter((i) => i.matched).length} rapprochées · ${items.length - items.filter((i) => i.matched).length} sans correspondance${conflicts ? ` · ${conflicts} note(s) existante(s) à écraser` : ''}`,
    conflicts: conflicts ? `${conflicts} note(s) existent déjà et seront écrasées si vous confirmez (sinon : ignorées).` : null,
    table: `<table class="tbl"><thead><tr><th>Matricule</th><th>Étudiant</th><th>Matière</th><th class="n">Normale</th><th class="n">Rattr.</th><th>État</th></tr></thead><tbody>
      ${items.slice(0, 200).map((i) => `<tr><td>${esc(i.matricule)}</td><td>${esc(i.student || '—')}</td><td>${esc(i.subject)}</td><td class="n">${fmt(i.normal)}</td><td class="n">${fmt(i.rattrapage)}</td>
      <td>${i.matched ? (i.conflict ? chip('écraserait', 'warn') : chip('ok', 'ok')) : chip('sans correspondance', 'bad')}</td></tr>`).join('')}
    </tbody></table>`,
    warnings: '',
  };
}

r.post('/admin/import/analyze', need('admin'), H(async (req, res) => {
  const b = req.body;
  const mapping = {};
  for (const k of ['matricule', 'subject', 'normal', 'rattrapage', 'coefficient', 'credits']) if (String(b['map_' + k] || '').trim()) mapping[k === 'matricule' ? 'matricule' : k] = b['map_' + k];
  const A = await analyzeImport({ file: b.file, sheet: b.sheet, mode: b.mode, target: b.target || null, mapping });
  const body = `<h1 style="font-size:18px;margin:4px 2px 10px">Import — aperçu avant écriture</h1>
    <div class="card"><div class="row spread"><b>${esc(A.headline)}</b>${b.target ? chip(esc(A.templateName || 'modèle cible'), 'violet') : ''}</div>
    ${A.conflicts ? `<div class="banner warn" style="margin-top:8px">${esc(A.conflicts)}</div>` : ''}
    ${A.warnings}<div style="max-height:52vh;overflow:auto;margin-top:10px">${A.table}</div></div>
    ${b.mode === 'structure' && !b.target ? `<div class="banner bad" style="margin-top:10px">Choisissez un modèle cible sur la page précédente pour pouvoir importer.</div>` : `
    <form class="card" style="margin-top:10px" method="post" action="${url('/admin/import/commit', req.ctx)}">
      ${hiddenT(req.ctx.t, { th: req.ctx.th })}
      ${Object.entries({ file: b.file, sheet: b.sheet, mode: b.mode, target: b.target, source: b.mode === 'grades' ? 'official' : '' }).map(([k, v]) => `<input type="hidden" name="${k}" value="${esc(v ?? '')}"/>`).join('')}
      ${['matricule', 'subject', 'normal', 'rattrapage', 'coefficient', 'credits'].map((k) => `<input type="hidden" name="map_${k}" value="${esc(b['map_' + k] ?? '')}"/>`).join('')}
      <div class="row" style="gap:10px;flex-wrap:wrap;align-items:center">
        <label class="small"><b>En cas de conflit :</b></label>
        <select class="input" style="width:auto" name="onConflict"><option value="overwrite">écraser (j’ai vérifié)</option><option value="skip" ${A.conflicts ? 'selected' : ''}>ignorer les lignes existantes</option></select>
        ${b.mode === 'grades' ? '<label class="small"><input type="checkbox" name="createMissingCourses" value="1"/> créer les matières inconnues (1re UE)</label>' : ''}
        <label class="small" style="color:var(--bad)"><input type="checkbox" name="confirm" value="1" required/> Je confirme l’écriture en base</label>
        <button class="btn sm">Importer maintenant</button>
        <a class="link-btn small" href="${url('/admin/import', { t: req.ctx.t, th: req.ctx.th, file: b.file, sheet: b.sheet, mode: b.mode, target: b.target })}">ajuster</a>
      </div></form>`}`;
  res.send(adminPage(req, 'Import', body));
}));

r.post('/admin/import/commit', need('admin'), H(async (req, res) => {
  if (req.body.confirm !== '1') return res.redirect(303, url('/admin/import', { ...req.ctx, err: 'Confirmation requise pour écrire dans la base.' }));
  const b = req.body;
  const onConflict = b.onConflict === 'skip' ? 'skip' : 'overwrite';
  const p = (await safeFile(b.file)).content;
  let summary = '';
  if (b.mode === 'structure') {
    if (!b.target) throw badRequest('Modèle cible requis');
    const templateId = Number(b.target);
    const nSem = (await db.prepare('SELECT COUNT(*) n FROM semesters WHERE template_id=?').get(templateId)).n;
    if (nSem > 0 && onConflict !== 'overwrite') throw new ApiError(409, 'Le modèle contient déjà une structure : relancez avec « écraser » confirmé.');
    const { rows } = loadSheetCells(p, b.sheet);
    const parsed = parseReleveStructure(rows);
    if (!parsed.ok) throw badRequest(parsed.error);
    await tx(async () => {
      if (nSem > 0) await db.prepare('DELETE FROM semesters WHERE template_id=?').run(templateId);
      let sOrd = 0;
      for (const s of parsed.semesters) {
        const si = (await db.prepare('INSERT INTO semesters (template_id,number,name,ects_expected,ord) VALUES (?,?,?,?,?)')
          .run(templateId, s.number, s.name || `Semestre ${s.number}`, s.ects || 30, sOrd++)).lastInsertRowid;
        let uOrd = 0;
        for (const u of s.units) {
          const ui = (await db.prepare('INSERT INTO units (semester_id,code,name,ord) VALUES (?,?,?,?)').run(si, u.code, u.name, uOrd++)).lastInsertRowid;
          let cOrd = 0;
          for (const c of u.courses) await db.prepare('INSERT INTO courses (unit_id,name,coefficient,credits,ord) VALUES (?,?,?,?,?)').run(ui, c.name, c.coefficient ?? 1, c.credits ?? 1, cOrd++);
        }
      }
      await db.prepare(`UPDATE templates SET updated_at=datetime('now') WHERE id=?`).run(templateId);
      await db.prepare('INSERT INTO imports (user_id,filename,mode,summary,rows_affected) VALUES (?,?,?,?,?)').run(req.user.id, b.file, 'structure', `Structure importée dans le modèle #${templateId} : ${parsed.semesters.length} semestre(s)`, parsed.semesters.length);
    });
    summary = `Structure importée dans le modèle #${templateId} : ${parsed.semesters.length} semestre(s)`;
  } else {
    const template = await db.prepare('SELECT * FROM templates WHERE id=?').get(Number(b.target));
    if (!template) throw notFound('Modèle introuvable');
    const source = 'official';
    const tree = await loadTemplateTree(template.id);
    const courseIndex = new Map();
    for (const s of tree) for (const u of s.units) for (const c of u.courses) courseIndex.set(normName(c.name), { course: c, semester: s });
    const studentsByMatricule = new Map((await db.prepare('SELECT id, matricule FROM students').all()).map((s) => [normName(s.matricule), s]));
    const mapping = {};
    for (const k of ['matricule', 'subject', 'normal', 'rattrapage', 'coefficient', 'credits']) if (String(b['map_' + k] || '').trim()) mapping[k] = b['map_' + k];
    const { aoa } = loadSheetValues(p, b.sheet);
    const flat = parseFlatGrades(aoa, mapping);
    let written = 0, skipped = 0, unmatched = 0, createdCourses = 0;
    await tx(async () => {
      for (const row of flat.rows) {
        let match = courseIndex.get(normName(row.subject));
        const st = row.matricule ? studentsByMatricule.get(normName(row.matricule)) : null;
        if (!st) { unmatched++; continue; }
        if (!match) {
          if (!b.createMissingCourses) { unmatched++; continue; }
          const firstSem = tree[0]; const firstUe = firstSem?.units[0];
          if (!firstUe) { unmatched++; continue; }
          const cid = (await db.prepare('INSERT INTO courses (unit_id,name,coefficient,credits,ord) VALUES (?,?,?,?,?)').run(firstUe.id, row.subject, row.coefficient ?? 1, row.credits ?? 1, 999)).lastInsertRowid;
          match = { course: { id: cid }, semester: firstSem };
          courseIndex.set(normName(row.subject), match);
          createdCourses++;
        }
        const pub = await db.prepare('SELECT status FROM publications WHERE semester_id=?').get(match.semester.id);
        if (pub?.status === 'locked') { skipped++; continue; }
        const existing = await db.prepare('SELECT normal, rattrapage FROM grades WHERE student_id=? AND course_id=? AND source=?').get(st.id, match.course.id, source);
        if (existing && (existing.normal != null || existing.rattrapage != null) && onConflict !== 'overwrite') { skipped++; continue; }
        await db.prepare(`INSERT INTO grades (student_id,course_id,source,normal,rattrapage,updated_at) VALUES (?,?,?, ?,?,datetime('now'))
          ON CONFLICT(student_id,course_id,source) DO UPDATE SET normal=excluded.normal, rattrapage=excluded.rattrapage, updated_at=datetime('now')`)
          .run(st.id, match.course.id, source, row.normal, row.rattrapage);
        written++;
      }
      await db.prepare('INSERT INTO imports (user_id,filename,mode,summary,rows_affected) VALUES (?,?,?,?,?)').run(req.user.id, b.file, 'grades', `Import ${source} : ${written} écritures, ${skipped} ignorées, ${unmatched} sans correspondance, ${createdCourses} matières créées`, written);
    });
    summary = `${written} note(s) importée(s) · ${skipped} ignorée(s) · ${unmatched} sans correspondance · ${createdCourses} matière(s) créée(s)`;
  }
  await dropUpload(b.file);                       /* import terminé : le classeur n'a plus à rester stocké */
  res.redirect(303, url('/admin/import', { t: req.ctx.t, th: req.ctx.th, ok: summary }));
}));

/* — Fichiers d'export (admin) + divers — */
r.get('/admin/fichiers/etudiants.csv', need('admin'), H(async (_req, res) => {
  const rows = await db.prepare(`SELECT s.matricule, u.last_name, u.first_name, u.email, p.name AS program, l.name AS level, y.label AS year
    FROM students s JOIN users u ON u.id=s.user_id LEFT JOIN programs p ON p.id=s.program_id
    LEFT JOIN levels l ON l.id=s.level_id LEFT JOIN academic_years y ON y.id=s.academic_year_id ORDER BY u.last_name`).all();
  sendCsv(res, 'etudiants.csv', csv(rows, ['matricule', 'last_name', 'first_name', 'email', 'program', 'level', 'year']));
}));
r.get('/admin/fichiers/modele/:id.csv', need('admin'), H(async (req, res) => {
  const t = await db.prepare('SELECT * FROM templates WHERE id=?').get(Number(req.params.id));
  if (!t) throw notFound();
  const rows = [];
  for (const s of await loadTemplateTree(t.id)) for (const u of s.units) for (const c of u.courses) rows.push({ semestre: s.name, ue: u.code, matiere: c.name, coefficient: c.coefficient, credits: c.credits });
  sendCsv(res, `modele-${t.id}.csv`, csv(rows, ['semestre', 'ue', 'matiere', 'coefficient', 'credits']));
}));
r.get('/admin/fichiers/releve/:id.pdf', need('admin'), H(async (req, res) => {
  const st = await db.prepare('SELECT * FROM students WHERE id=?').get(+req.params.id);
  if (!st) throw notFound('Étudiant introuvable');
  await sendRelevePdf(res, st, req.query.source === 'personal' ? 'personal' : 'official', { allAccess: true });
}));

r.get('/admin/fichiers/releve/:id.xlsx', need('admin'), H(async (req, res) => {
  const s = await db.prepare('SELECT * FROM students WHERE id=?').get(Number(req.params.id));
  if (!s) throw notFound();
  await sendReleveXlsx(res, s, req.query.source === 'personal' ? 'personal' : 'official');
}));

/* ---- Admin — calendrier daté par niveau ---- */
const ADMIN_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const adminToday = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const adminValidDate = (value) => ADMIN_DATE_RE.test(String(value || '')) && !Number.isNaN(new Date(`${value}T12:00:00`).getTime());
const adminDay = (value) => {
  const d = new Date(`${value}T12:00:00`);
  return d.getDay() === 0 ? 0 : d.getDay(); /* dimanche = 0, lundi = 1 … samedi = 6 */
};
const adminDateLabel = (value) => new Date(`${value}T12:00:00`).toLocaleDateString('fr-FR', {
  weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric',
});

/* Une seule structure est utilisée par niveau. Le modèle académique du niveau
   détermine la filière et l'année ; le propriétaire technique est ensuite
   résolu ou créé automatiquement, sans choix visible. */
const calendarOwner = async (levelId) => {
  const template = await db.prepare(`SELECT t.program_id, t.level_id, t.academic_year_id,
      l.name AS level_name, p.name AS program_name
    FROM templates t
    JOIN levels l ON l.id=t.level_id
    JOIN programs p ON p.id=t.program_id
    WHERE t.level_id=?
    ORDER BY CASE WHEN t.academic_year_id=(SELECT id FROM academic_years WHERE is_current=1 LIMIT 1) THEN 0 ELSE 1 END,
      t.updated_at DESC, t.id DESC
    LIMIT 1`).get(levelId);
  if (template) {
    const owner = await resolveAcademicClass(template.program_id, template.level_id, template.academic_year_id);
    return owner ? { ...owner, level_name: template.level_name, program_name: template.program_name } : null;
  }
  return await db.prepare(`SELECT c.id, c.level_id, c.program_id,
      l.name AS level_name, p.name AS program_name
    FROM classes c
    JOIN levels l ON l.id=c.level_id
    JOIN programs p ON p.id=c.program_id
    WHERE c.level_id=?
    ORDER BY CASE WHEN c.academic_year_id=(SELECT id FROM academic_years WHERE is_current=1 LIMIT 1) THEN 0 ELSE 1 END, c.id
    LIMIT 1`).get(levelId);
};

r.get('/admin/emploi', need('admin'), H(async (req, res) => {
  const levels = await db.prepare('SELECT id, name, ord FROM levels ORDER BY ord, name').all();
  if (!levels.length) {
    res.send(adminPage(req, 'Calendrier', '<div class="empty">Créez d’abord un niveau et un modèle de relevé.</div>'));
    return;
  }

  const requestedLevel = Number(req.query.level);
  const levelId = levels.some((l) => l.id === requestedLevel) ? requestedLevel : levels[0].id;
  const selectedLevel = levels.find((l) => l.id === levelId);
  const owner = await calendarOwner(levelId);
  const selectedDate = adminValidDate(req.query.date) ? String(req.query.date) : adminToday();
  const weekday = adminDay(selectedDate);

  if (!owner) {
    res.send(adminPage(req, 'Calendrier', `<div class="empty">Aucune filière n’est configurée pour ${esc(selectedLevel.name)}.</div>`));
    return;
  }

  /* Les matières sont prises dans TOUS les semestres du niveau et de la filière :
     S3 et S4 apparaissent dans la même liste. */
  const semesters = await db.prepare(`SELECT s.id, s.number, s.name
    FROM semesters s JOIN templates t ON t.id=s.template_id
    WHERE t.level_id=? AND t.program_id=? ORDER BY s.ord, s.number`).all(owner.level_id, owner.program_id);
  const courses = await db.prepare(`SELECT c.id, c.name, c.coefficient, c.credits,
      u.code AS ucode, s.id AS semester_id, s.number AS semester_number, s.name AS semester_name
    FROM courses c
    JOIN units u ON u.id=c.unit_id
    JOIN semesters s ON s.id=u.semester_id
    JOIN templates t ON t.id=s.template_id
    WHERE t.level_id=? AND t.program_id=?
    ORDER BY s.ord, u.ord, c.ord, c.id`).all(owner.level_id, owner.program_id);

  /* Les anciens créneaux restent hebdomadaires ; les nouveaux sont rattachés à
     une date exacte. Dans les deux cas, l’identifiant technique reste invisible. */
  const rows = await db.prepare(`SELECT sl.*, c.name AS cname,
      s.number AS semester_number, s.name AS semester_name,
      l.name AS level_name, p.name AS program_name
    FROM schedule_slots sl
    LEFT JOIN courses c ON c.id=sl.course_id
    LEFT JOIN semesters s ON s.id=sl.semester_id
    LEFT JOIN templates t ON t.id=s.template_id
    LEFT JOIN levels l ON l.id=t.level_id
    LEFT JOIN programs p ON p.id=t.program_id
    WHERE sl.class_id=?
      AND (sl.slot_date=? OR (sl.slot_date IS NULL AND sl.day=?))
    ORDER BY COALESCE(sl.slot_date, ?), sl.day, sl.start`).all(owner.id, selectedDate, weekday, selectedDate);

  const levelOptions = levels.map((l) => `<option value="${l.id}" ${l.id === levelId ? 'selected' : ''}>${esc(l.name)}</option>`).join('');
  const courseOptions = courses.length
    ? courses.map((c) => `<option value="${c.id}">S${c.semester_number} · ${esc(c.ucode ? c.ucode + ' · ' : '')}${esc(c.name)}</option>`).join('')
    : '<option value="">Aucune matière — utilisez un intitulé libre</option>';

  const filter = `<form class="inline" method="get" action="${url('/admin/emploi', req.ctx)}" style="margin-bottom:12px;align-items:end">
    <div class="field" style="min-width:150px"><label>Niveau</label><select class="input" name="level">${levelOptions}</select></div>
    <div class="field" style="min-width:175px"><label>Date</label><input class="input" type="date" name="date" value="${esc(selectedDate)}" required/></div>
    <button class="btn sm ghost" style="width:auto">Afficher</button></form>`;

  const form = `<form class="card" method="post" action="${url('/admin/emploi/add', req.ctx)}" style="margin-top:14px">
    ${hiddenT(req.ctx.t, { th: req.ctx.th })}
    <input type="hidden" name="level" value="${levelId}"/><input type="hidden" name="slot_date" value="${esc(selectedDate)}"/>
    <h3 style="margin:0 0 10px;font-size:14px">Ajouter un créneau — ${esc(owner.level_name)} · ${esc(owner.program_name)}</h3>
    <p class="tiny muted" style="margin:-4px 0 12px">Date sélectionnée : <b>${esc(adminDateLabel(selectedDate))}</b>. Les matières proposées regroupent tous les semestres du niveau, notamment S3 et S4.</p>
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:10px">
      <div class="field" style="grid-column:span 2"><label>Matière du niveau — tous les semestres</label><select class="input" name="course_id"><option value="">— Intitulé libre —</option>${courseOptions}</select></div>
      <div class="field"><label>ou intitulé libre</label><input class="input" name="title" placeholder="Examen, TD…"/></div>
      <div class="field"><label>Type du créneau</label><select class="input" name="slot_type"><option value="course">Cours</option><option value="exam">Examen</option></select></div>
      <div class="field"><label>Début</label><input class="input" type="time" name="start" value="08:00" required/></div>
      <div class="field"><label>Fin</label><input class="input" type="time" name="end" value="10:00" required/></div>
      <div class="field"><label>Salle</label><input class="input" name="room" placeholder="Amphi A"/></div>
    </div>
    <button class="btn sm" style="margin-top:8px">Ajouter le créneau à cette date</button></form>`;

  const table = rows.length ? `<div class="card" style="padding:0;overflow-x:auto"><table class="tbl"><thead><tr><th>Date</th><th>Semestre</th><th>Type</th><th>Horaires</th><th>Matière</th><th>Salle</th><th></th></tr></thead><tbody>
      ${rows.map((rw) => {
    const dateText = rw.slot_date ? adminDateLabel(rw.slot_date) : `${DAY_NAMES[rw.day - 1]} · hebdomadaire`;
    const semText = rw.semester_number ? `S${rw.semester_number}` : '—';
    const typeText = rw.slot_type === 'exam' ? 'Examen' : 'Cours';
    return `<tr><td>${esc(dateText)}</td><td>${esc(semText)}</td><td>${esc(typeText)}</td><td class="n" style="text-align:left">${esc(rw.start)}–${esc(rw.end)}</td><td>${esc(rw.cname || rw.title || '')}</td><td>${esc(rw.room || '—')}</td>
        <td class="r"><form method="post" action="${url('/admin/emploi/del', req.ctx)}" style="display:inline">${hiddenT(req.ctx.t, { th: req.ctx.th })}<input type="hidden" name="id" value="${rw.id}"/><input type="hidden" name="level" value="${levelId}"/><input type="hidden" name="slot_date" value="${esc(selectedDate)}"/><button class="btn sm danger mini">Supprimer</button></form></td></tr>`;
  }).join('')}
    </tbody></table></div>` : `<div class="empty">Aucun créneau pour ${esc(adminDateLabel(selectedDate))}. Ajoutez-en ci-dessous.</div>`;
  res.send(adminPage(req, 'Calendrier', `<h1 style="font-size:18px;margin:4px 2px 10px">Calendrier de l’emploi du temps</h1>${filter}${table}${form}`));
}));

r.post('/admin/emploi/add', need('admin'), H(async (req, res) => {
  const levelId = Number(req.body.level);
  const selectedDate = adminValidDate(req.body.slot_date) ? String(req.body.slot_date) : adminToday();
  const day = adminDay(selectedDate);
  if (!levelId || !adminValidDate(selectedDate)) throw badRequest('Niveau et date requis');
  if (!(day >= 1 && day <= 6)) throw badRequest('Choisissez une date du lundi au samedi');
  const owner = await calendarOwner(levelId);
  if (!owner) throw badRequest('Niveau sans filière configurée');
  if (!/^\d{2}:\d{2}$/.test(String(req.body.start || '')) || !/^\d{2}:\d{2}$/.test(String(req.body.end || '')) || String(req.body.end) <= String(req.body.start)) throw badRequest('Horaires invalides : format HH:MM, fin après début');
  const start = String(req.body.start); const end = String(req.body.end);
  const courseId = req.body.course_id ? Number(req.body.course_id) : null;
  let semesterId = null;
  if (courseId) {
    const course = await db.prepare(`SELECT c.id, s.id AS semester_id
      FROM courses c JOIN units u ON u.id=c.unit_id JOIN semesters s ON s.id=u.semester_id
      JOIN templates t ON t.id=s.template_id
      WHERE c.id=? AND t.level_id=? AND t.program_id=?`).get(courseId, owner.level_id, owner.program_id);
    if (!course) throw badRequest('Matière inconnue pour le niveau sélectionné');
    semesterId = course.semester_id;
  } else {
    /* Un intitulé libre reste rattaché à une structure valide, mais le semestre
       est résolu automatiquement puisque ce choix n'est plus exposé. */
    const sem = await db.prepare(`SELECT s.id FROM semesters s JOIN templates t ON t.id=s.template_id
      WHERE t.level_id=? AND t.program_id=?
      ORDER BY CASE WHEN t.academic_year_id=(SELECT id FROM academic_years WHERE is_current=1 LIMIT 1) THEN 0 ELSE 1 END,
        s.ord, s.number, s.id LIMIT 1`).get(owner.level_id, owner.program_id);
    if (!sem) throw badRequest('Aucun semestre configuré pour ce niveau');
    semesterId = sem.id;
  }
  const title = courseId ? null : String(req.body.title || '').trim().slice(0, 120);
  if (!courseId && !title) throw badRequest('Choisissez une matière ou saisissez un intitulé libre');
  const room = String(req.body.room || '').trim().slice(0, 60) || null;
  const slotType = req.body.slot_type === 'exam' ? 'exam' : 'course';
  await db.prepare('INSERT INTO schedule_slots (class_id, semester_id, course_id, title, slot_date, slot_type, day, start, end, room) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .run(owner.id, semesterId, courseId, title, selectedDate, slotType, day, start, end, room);
  res.redirect(303, url('/admin/emploi', { ...req.ctx, level: owner.level_id, date: selectedDate, ok: 'Créneau ajouté' }));
}));

r.post('/admin/emploi/del', need('admin'), H(async (req, res) => {
  const id = Number(req.body.id);
  const selectedDate = adminValidDate(req.body.slot_date) ? String(req.body.slot_date) : adminToday();
  const rw = await db.prepare('SELECT id, class_id FROM schedule_slots WHERE id=?').get(id);
  if (!rw) throw notFound('Créneau introuvable');
  const owner = await db.prepare('SELECT id, level_id FROM classes WHERE id=?').get(rw.class_id);
  await db.prepare('DELETE FROM schedule_slots WHERE id=?').run(id);
  res.redirect(303, url('/admin/emploi', { ...req.ctx, level: owner?.level_id || Number(req.body.level) || '', date: selectedDate, ok: 'Créneau supprimé' }));
}));

export default r;
