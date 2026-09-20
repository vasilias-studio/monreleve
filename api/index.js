/**
 * api/index.js — point d'entrée pour Vercel (hébergement sans serveur).
 *
 * Vercel appelle cette fonction Node pour chaque requête HTTP. L'application Express
 * complète (site HTML + API REST) est réutilisée telle quelle : aucune duplication.
 *
 * Prérequis (voir DEPLOIEMENT-VERCEL.md) :
 *   · DATABASE_URL   : chaîne de connexion Supabase (base PostgreSQL) ;
 *   · SESSION_SECRET : chaîne aléatoire d'au moins 16 caractères (signature des jetons).
 *
 * Le disque n'existe pas sur Vercel : la base est sur Supabase et les classeurs importés
 * sont rangés dans la base (table `uploads`), jamais dans des fichiers.
 */
import app, { ensureBootstrap } from '../server/app.js';

export default async function gestionnaire(req, res) {
  /* Au premier appel de l'instance : préparation de la base (seed si elle est vide). */
  try { await ensureBootstrap(); } catch (e) { console.error('[vercel] amorçage :', e.message); }
  return app(req, res);
}
