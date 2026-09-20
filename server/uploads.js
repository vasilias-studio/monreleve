/**
 * uploads.js — fichiers importés (classeurs Excel) stockés DANS LA BASE.
 *
 * Pourquoi pas sur disque : le déploiement visé (Vercel) est sans serveur et sans
 * disque persistant — un fichier écrit par une requête serait perdu à la suivante.
 * Le classeur est donc conservé dans la table `uploads` (BLOB en SQLite, bytea en
 * PostgreSQL/Supabase) le temps de l'import, puis purgé automatiquement.
 *
 * Cycle de vie : envoi (upload) → identifiant court renvoyé dans l'URL → relecture
 * pour l'aperçu et la confirmation → suppression après import, ou purge des fichiers
 * de plus de `UPLOAD_KEEP_HOURS` heures (24 par défaut) à chaque nouvel envoi.
 */
import crypto from 'node:crypto';
import db from './db.js';

/** Taille maximale acceptée (multipart), en octets. */
export const TAILLE_MAX = Number(process.env.UPLOAD_MAX_MB || 12) * 1024 * 1024;

/** Durée de conservation des fichiers non importés. */
const CONSERVATION_HEURES = Number(process.env.UPLOAD_KEEP_HOURS || 24);

/** Identifiant sûr (utilisé dans les URL) : lettres, chiffres, point et tiret. */
export const idSur = (fileId) => String(fileId || '').replace(/[^\w.\-]/g, '');

/**
 * Enregistre un classeur reçu et renvoie son identifiant public.
 * @param {string} nom       nom d'origine du fichier
 * @param {Buffer} contenu   contenu binaire
 */
export async function saveUpload(nom, contenu) {
  if (!Buffer.isBuffer(contenu) || !contenu.length) throw new Error('Fichier vide');
  if (contenu.length > TAILLE_MAX) throw new Error(`Fichier trop volumineux (maximum ${Math.round(TAILLE_MAX / 1024 / 1024)} Mo)`);
  const ext = (String(nom || '').match(/\.(xlsx|xls)$/i)?.[0] || '.xlsx').toLowerCase();
  const id = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${ext}`;
  await db.prepare('INSERT INTO uploads (id, name, content, size) VALUES (?,?,?,?)')
    .run(id, String(nom || 'classeur' + ext).slice(0, 200), contenu, contenu.length);
  /* entretien opportuniste : rien à planifier côté hébergeur */
  try { await purgeUploads(); } catch { /* le nettoyage ne doit jamais bloquer un import */ }
  return id;
}

/**
 * Relit un classeur par son identifiant.
 * @returns {Promise<{id: string, name: string, content: Buffer}|null>}
 */
export async function readUpload(fileId) {
  const id = idSur(fileId);
  if (!id) return null;
  const row = await db.prepare('SELECT id, name, content FROM uploads WHERE id=?').get(id);
  if (!row) return null;
  /* selon le pilote, bytea revient en Buffer (pg) ou Uint8Array (PGlite) */
  const contenu = Buffer.isBuffer(row.content) ? row.content : Buffer.from(row.content);
  return { id: row.id, name: row.name || id, content: contenu };
}

/** Supprime un classeur (après import réussi, ou sur demande). */
export async function dropUpload(fileId) {
  const id = idSur(fileId);
  if (!id) return 0;
  return (await db.prepare('DELETE FROM uploads WHERE id=?').run(id)).changes ?? 0;
}

/** Purge les classeurs plus vieux que la durée de conservation. */
export async function purgeUploads(heures = CONSERVATION_HEURES) {
  const limite = `-${Math.max(1, Math.round(heures))} hours`;
  const r = await db.prepare("DELETE FROM uploads WHERE created_at < datetime('now', ?)").run(limite);
  return r.changes ?? 0;
}
