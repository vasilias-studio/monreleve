/**
 * index.js — Serveur unique MonRelevé : site web HTML (rendu serveur) + API REST.
 *   - /            → l'application web complète en HTML classique (liens + formulaires) :
 *                    base SQLite réelle, authentification, rôles étudiants/admin, import Excel.
 *   - /api/*       → le même backend en JSON, conservé pour la version mobile (PWA/Capacitor)
 *                    et toute intégration future.
 * Un seul process, un seul port (4000). `npm run serve` suffit.
 */
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import db from './db.js'; // initialise le schéma
import authRouter from './routes/auth.js';
import studentRouter from './routes/student.js';
import adminRouter from './routes/admin.js';
import importRouter from './routes/importExport.js';
import siteRouter from './html/site.js';

/* Auto-réparation : si la base est vide (premier lancement / sandbox recyclé),
 * on exécute le seed automatiquement (référentiels + modèle L2 depuis l'Excel fourni). */
try {
  if (db.prepare('SELECT COUNT(*) n FROM users').get().n === 0) {
    console.log('[start] Base vide → seed automatique…');
    await import('./seed.js');
  }
} catch (e) { console.error('[start] seed automatique échoué :', e.message); }

/* Fil d'annonces : quelques publications de démonstration si la table est vide.
 * Ensuite les annonces appartiennent à l'administration (elle publie/supprime depuis l'accueil). */
try {
  const { ensureAnnonces } = await import('./annonces.js');
  const n = ensureAnnonces();
  if (n) console.log(`[start] ${n} annonce(s) de démonstration publiée(s).`);
} catch (e) { console.error('[start] annonces de démonstration échouées :', e.message); }

/* Emploi du temps : génère un horaire de démo uniquement si aucun n'existe
 * (ensuite, la table appartient à l'admin : Admin → Calendrier). */
try {
  const { ensureSchedule } = await import('./schedule.js');
  const made = ensureSchedule();
  if (made) console.log(`[start] ${made} créneaux d'emploi du temps générés — modifiables dans Admin → Calendrier`);
} catch (e) { console.error('[start] schedule :', e.message); }

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.disable('x-powered-by');

/* Log d'accès (diagnostic : quelles URL le navigateur demande réellement) */
app.use((req, _res, next) => { console.log(`${new Date().toISOString().slice(11, 19)} ${req.method} ${req.originalUrl}`); next(); });

app.use(express.json({ limit: '2mb' }));

/* Cache : tout le site HTML est « no-store » (le serveur est la seule source de vérité —
 * impératif dans les environnements d'aperçu volatils) ; seuls les fichiers statiques
 * éventuels (.css/.js/.png…) gardent leur politique propre. */
app.use((req, res, next) => {
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

const PORT = Number(process.env.PORT || 4000);
app.listen(PORT, '0.0.0.0', () => console.log(`MonRelevé — API+app sur http://0.0.0.0:${PORT}`));
