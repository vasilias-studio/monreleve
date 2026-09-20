/**
 * app.js — construction de l'application Express (sans écoute réseau).
 *
 * Séparé de index.js pour permettre deux modes de service avec le même code :
 *   · serveur classique (VM, ordinateur, Docker) : index.js écoute sur un port ;
 *   · fonction sans serveur (Vercel, api/index.js) : la plateforme appelle l'application.
 *
 * `ensureBootstrap()` prépare la base au premier besoin (seed si elle est vide,
 * annonces et emploi du temps de démonstration) — une seule fois par instance.
 */
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import db from './db.js';
import authRouter from './routes/auth.js';
import studentRouter from './routes/student.js';
import adminRouter from './routes/admin.js';
import importRouter from './routes/importExport.js';
import siteRouter from './html/site.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Préparation de la base, au plus une fois par instance :
 *   · seed automatique si aucun compte n'existe (référentiels + modèle L2 depuis l'Excel) ;
 *   · fil d'annonces et emploi du temps de démonstration, chacun seulement si vide.
 * Renvoie la promesse partagée : les appels suivants ne refont rien.
 */
export function ensureBootstrap() {
  bootstrap ||= (async () => {
    /* Une première requête initialise aussi le schéma PostgreSQL sur une base neuve.
       Elle reste compatible avec les anciennes bases SQLite/PostgreSQL déjà en place. */
    await db.prepare('SELECT id FROM schedule_slots LIMIT 0').all();
    /* Migration douce : les anciennes bases ont des créneaux hebdomadaires sans date.
       On ajoute la date réelle sans effacer ni réécrire ces données historiques. */
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
    /* Les anciennes annonces ciblées par classe restent lisibles sans exposer cette
       notion dans l’interface : elles deviennent générales, sans supprimer le texte. */
    await db.prepare("UPDATE announcements SET audience='all', class_id=NULL WHERE audience='class'").run();
    await db.prepare("UPDATE announcements SET body=REPLACE(REPLACE(body, 'Réunion des délégués de classe', 'Réunion d’information'), 'travaux de groupe', 'travaux collectifs') WHERE body LIKE ?").run('%délégués de classe%');
    try {
      if ((await db.prepare('SELECT COUNT(*) n FROM users').get()).n === 0) {
        console.log('[start] Base vide → seed automatique…');
        await import('./seed.js');
      }
    } catch (e) { console.error('[start] seed automatique échoué :', e.message); }
    try {
      const { ensureAnnonces } = await import('./annonces.js');
      const n = await ensureAnnonces();
      if (n) console.log(`[start] ${n} annonce(s) de démonstration publiée(s).`);
    } catch (e) { console.error('[start] annonces de démonstration échouées :', e.message); }
    try {
      const { ensureSchedule } = await import('./schedule.js');
      const made = await ensureSchedule();
      if (made) console.log(`[start] ${made} créneaux d'emploi du temps générés — modifiables dans Admin → Calendrier`);
    } catch (e) { console.error('[start] schedule :', e.message); }
  })();
  return bootstrap;
}
let bootstrap = null;

const app = express();
app.disable('x-powered-by');

/* Log d'accès (diagnostic : quelles URL le navigateur demande réellement) */
app.use((req, _res, next) => { console.log(`${new Date().toISOString().slice(11, 19)} ${req.method} ${req.originalUrl}`); next(); });

/* Préparation de la base au premier appel : sur un hébergement sans serveur,
 * l'instance démarre à la première requête — c'est donc ici qu'il faut préparer. */
app.use(async (_req, _res, next) => {
  try { await ensureBootstrap(); } catch (e) { console.error('[start] amorçage :', e.message); }
  next();
});

app.use(express.json({ limit: '2mb' }));

/* Cache : tout le site HTML est « no-store » (le serveur est la seule source de vérité —
 * impératif dans les environnements d'aperçu volatils) ; seuls les fichiers statiques
 * éventuels (.css/.js/.png…) gardent leur politique propre. */
app.use((req, res, next) => {
  /* Même une ancienne URL contenant un jeton ne doit pas le transmettre à une autre ressource. */
  res.setHeader('Referrer-Policy', 'no-referrer');
  if (!/\.(css|js|map|png|svg|ico|woff2?)$/.test(req.path)) res.setHeader('Cache-Control', 'no-store, must-revalidate');
  next();
});

/* API */
app.use('/api/auth', authRouter);
app.use('/api/student', studentRouter);
app.use('/api/admin', adminRouter);
app.use('/api/admin', importRouter);
app.get('/api/health', (_req, res) => res.json({ ok: true, name: 'MonRelevé API', time: new Date().toISOString() }));

/* Front : site web 100 % HTML, rendu côté serveur (lien + formulaire, aucun bundle JS).
 *   - /style.css → la même feuille de style que la version mobile (thème clair/sombre via
 *     l'attribut data-theme posé côté serveur : pas de localStorage, donc compatible avec
 *     les navigateurs les plus restrictifs, y compris les cadres sandboxés sans stockage).
 *   - Aucune ressource avec nom hashé → plus jamais de « vieil index pointe vers un bundle
 *     supprimé → écran gris ». Tout est no-store, le serveur est la seule source de vérité.
 *   - Les anciens liens PWA (/#/accueil, /assets/*) retombent sur le site : navigation par
 *     fragments ignorée, assets inconnus en 404 propre. */
const STYLE_FILE = path.join(__dirname, '..', 'client', 'src', 'styles.css');
app.get('/style.css', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store, must-revalidate');
  if (fs.existsSync(STYLE_FILE)) res.type('text/css').send(fs.readFileSync(STYLE_FILE, 'utf8'));
  else res.status(404).type('text/css').send('/* styles indisponibles */');
});
app.use('/', siteRouter);
app.get(/^\/(?!api\/).*/, (req, res) => {
  if (/\.(js|css|map|png|svg|ico|webmanifest|json|woff2?)$/.test(req.path)) return res.status(404).type('text/plain').send('not found');
  res.redirect(302, '/'); // anciens favoris (SPA) → entrée du site HTML
});

/* Gestion d'erreurs unifiée : JSON pour l'API, page lisible pour le navigateur. */
app.use((err, req, res, _next) => {
  const status = err.status || 500;
  if (status >= 500) console.error(err);
  const wantsHtml = req.path !== undefined && !req.path.startsWith('/api/') && String(req.headers.accept || '').includes('text/html');
  if (wantsHtml) {
    res.status(status).type('html').send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link href="https://fonts.googleapis.com/css2?family=Josefin+Sans:wght@400;500;600;700&display=swap" rel="stylesheet"><div style="font-family:'Josefin Sans',system-ui;max-width:560px;margin:15vh auto;padding:0 20px;color:#161513"><h2 style="margin:8px 0 4px;text-transform:uppercase;letter-spacing:-.02em">Erreur ${status}</h2><p style="color:#8A857C;margin:0 0 16px">${String(err.message || 'Erreur serveur').replace(/[<>&]/g, '')}</p><a href="/" style="display:inline-block;background:#161513;color:#F2E9D8;text-decoration:none;font-weight:600;font-size:12px;letter-spacing:.08em;text-transform:uppercase;padding:14px 28px;border-radius:999px">← Retour à l’accueil</a></div>`);
    return;
  }
  res.status(status).json({ error: err.message || 'Erreur serveur' });
});
export default app;
