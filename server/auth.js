/**
 * auth.js — Authentification JWT + contrôles d'autorisation CÔTÉ SERVEUR.
 * Un étudiant n'atteint JAMAIS les données d'un autre : toutes les routes « student »
 * sont scopées sur l'identifiant issu du token, jamais sur un id fourni par le client.
 */
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import db, { DATA_DIR } from './db.js';

/**
 * Clé de signature des jetons.
 *   · Hébergement (Supabase/Vercel, Docker, VM…) : variable SESSION_SECRET — indispensable
 *     car un disque n'est pas partagé ni durable entre instances (les jetons émis par une
 *     instance doivent rester valides pour les autres).
 *   · Poste de travail : fichier data/secret.key généré au premier lancement, pour que
 *     `npm run serve` fonctionne sans rien configurer.
 */
const SECRET = (() => {
  const env = process.env.SESSION_SECRET || process.env.JWT_SECRET;
  if (env && String(env).trim().length >= 16) return String(env).trim();
  if (process.env.VERCEL || process.env.NODE_ENV === 'production') {
    throw new Error('SESSION_SECRET manquant : définissez une chaîne aléatoire d\'au moins 16 caractères (voir DEPLOIEMENT-VERCEL.md)');
  }
  const fichier = path.join(DATA_DIR, 'secret.key');
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(fichier)) fs.writeFileSync(fichier, crypto.randomBytes(48).toString('hex'));
  return fs.readFileSync(fichier, 'utf8').trim();
})();

export function hashPassword(pw) { return bcrypt.hashSync(pw, 10); }
export function verifyPassword(pw, hash) { return bcrypt.compareSync(pw, hash); }
export function signToken(user) {
  return jwt.sign({ uid: user.id, role: user.role }, SECRET, { expiresIn: '30d' });
}

/** Erreur HTTP typée, sérialisée proprement par le handler d'erreur. */
export class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
export const badRequest = (m) => new ApiError(400, m);
export const forbidden = (m = 'Accès refusé') => new ApiError(403, m);
export const notFound = (m = 'Ressource introuvable') => new ApiError(404, m);

/** Middleware : exige un Bearer token valide ; attache req.user. */
export async function authRequired(req, _res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return next(forbidden('Authentification requise'));
  try {
    const payload = jwt.verify(token, SECRET);
    const user = await db.prepare('SELECT * FROM users WHERE id=? AND is_active=1').get(payload.uid);
    if (!user) return next(forbidden('Compte inactif ou supprimé'));
    req.user = user;
    next();
  } catch {
    next(forbidden('Session expirée, reconnectez-vous'));
  }
}

/** Vérifie un jeton et renvoie l'utilisateur actif, ou null (utilisé par l'interface HTML). */
export async function readToken(token) {
  if (!token) return null;
  try {
    const payload = jwt.verify(String(token), SECRET);
    return await db.prepare('SELECT * FROM users WHERE id=? AND is_active=1').get(payload.uid) || null;
  } catch { return null; }
}

export function requireRole(role) {
  return (req, _res, next) => {
    if (req.user?.role !== role) return next(forbidden('Rôle insuffisant'));
    next();
  };
}

/** Attache la ligne « students » du compte courant ; erreur si introuvable. */
export async function attachStudent(req, _res, next) {
  const student = await db.prepare('SELECT * FROM students WHERE user_id=?').get(req.user.id);
  if (!student) return next(forbidden('Profil étudiant introuvable'));
  req.student = student;
  next();
}

export const newResetToken = () => crypto.randomBytes(24).toString('hex');
