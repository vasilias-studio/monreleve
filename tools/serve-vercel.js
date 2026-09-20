/**
 * tools/serve-vercel.js — émulation locale de la fonction Vercel (api/index.js).
 *
 * Elle sert exactement ce que Vercel exécutera : le même gestionnaire, appelé par
 * requête, sans écoute propre. Utile pour vérifier un déploiement sans serveur avant
 * de le publier, ou pour essayer la configuration Supabase en local.
 *
 * Usage :
 *   DATABASE_URL=postgres://… SESSION_SECRET=… PORT=4010 node tools/serve-vercel.js
 *   DB_DRIVER=pglite SESSION_SECRET=dev-secret-0123456789 PORT=4010 node tools/serve-vercel.js
 */
import http from 'node:http';
import gestionnaire from '../api/index.js';
import db from '../server/db.js';

const PORT = Number(process.env.PORT || 4010);

http.createServer((req, res) => {
  Promise.resolve(gestionnaire(req, res)).catch((e) => {
    console.error('[vercel-locale] erreur :', e);
    if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end('Erreur serveur');
  });
}).listen(PORT, '0.0.0.0', () => {
  console.log(`MonRelevé (émulation Vercel) sur http://0.0.0.0:${PORT} — base : ${db.driver}`);
});
