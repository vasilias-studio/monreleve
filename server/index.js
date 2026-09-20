/**
 * index.js — lanceur du serveur MonRelevé (site web HTML + API REST).
 *
 *   npm run serve   → http://localhost:4000
 *
 * Le serveur écoute ici ; l'application elle-même est construite dans app.js, ce qui
 * permet de la déployer telle quelle sur un hébergement sans serveur (Vercel) via api/index.js.
 * Pour un déploiement PostgreSQL/Supabase, voir DEPLOIEMENT-VERCEL.md.
 */
import app, { ensureBootstrap } from './app.js';

const PORT = Number(process.env.PORT || 4000);

/* Préparation de la base avant d'accepter des requêtes (seed si elle est vide). */
ensureBootstrap().catch((e) => console.error('[start] amorçage :', e.message));

app.listen(PORT, '0.0.0.0', () => console.log(`MonRelevé — API+app sur http://0.0.0.0:${PORT}`));
