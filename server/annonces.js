/**
 * annonces.js — fil d'annonces de la page d'accueil (« publications »).
 *
 * Modèle : une annonce = un texte publié par l'administration, adressé soit à
 * tous les étudiants, soit à une filière, soit à une classe. Les étudiants
 * « aiment » une annonce (une fois par personne). Rien n'est codé en dur :
 * les cibles viennent des référentiels (programs / classes).
 *
 * ⚠ Ne pas confondre avec la table `publications`, qui gère la diffusion des
 *   résultats officiels par semestre (verrou brouillon/publié).
 */
import db, { tx } from './db.js';

/** Annonces visibles par un lecteur : tout le monde pour un admin, sinon ciblage. */
export function feed(viewer, { limit = 50 } = {}) {
  const base = `SELECT a.id, a.body, a.audience, a.pinned, a.created_at, a.program_id, a.class_id,
      u.first_name, u.last_name, u.role AS author_role,
      (SELECT COUNT(*) FROM announcement_likes l WHERE l.announcement_id = a.id) AS likes
    FROM announcements a LEFT JOIN users u ON u.id = a.author_id`;
  const order = 'ORDER BY a.pinned DESC, a.created_at DESC, a.id DESC LIMIT ?';
  if (!viewer || viewer.role === 'admin') return db.prepare(`${base} ${order}`).all(limit);
  return db.prepare(`${base}
    WHERE a.audience = 'all'
       OR (a.audience = 'program' AND a.program_id = ?)
       OR (a.audience = 'class' AND a.class_id = ?)
    ${order}`).all(viewer.program_id ?? -1, viewer.class_id ?? -1, limit);
}

/** Identifiants des annonces déjà aimées par cet utilisateur (pour l'état du bouton). */
export function likedIds(userId, ids = []) {
  if (!userId || !ids.length) return new Set();
  const marks = ids.map(() => '?').join(',');
  return new Set(db.prepare(`SELECT announcement_id FROM announcement_likes WHERE user_id=? AND announcement_id IN (${marks})`).all(userId, ...ids).map((r) => r.announcement_id));
}

/** « J'aime » : bascule (ajoute ou retire), renvoie true si le like est actif après l'appel. */
export function toggleLike(announcementId, userId) {
  return tx(() => {
    const del = db.prepare('DELETE FROM announcement_likes WHERE announcement_id=? AND user_id=?').run(announcementId, userId);
    if (del.changes) return false;
    db.prepare('INSERT INTO announcement_likes (announcement_id, user_id) VALUES (?,?)').run(announcementId, userId);
    return true;
  });
}

/** Libellé de la cible d'une annonce (chip de la carte). */
export function audienceLabel(a) {
  if (a.audience === 'class') return db.prepare('SELECT name FROM classes WHERE id=?').get(a.class_id)?.name || 'Classe';
  if (a.audience === 'program') return db.prepare('SELECT name FROM programs WHERE id=?').get(a.program_id)?.name || 'Filière';
  return 'Tous les étudiants';
}

/**
 * Date relative en français, sans dépendance (« il y a 12 min », « hier »…).
 * Les dates SQLite sont stockées en UTC (datetime('now')) : on les traite comme telles,
 * ce qui garde les écarts justes quel que soit le fuseau du navigateur.
 */
export function relTime(sqliteDate) {
  if (!sqliteDate) return '';
  const iso = String(sqliteDate).includes('T') ? String(sqliteDate) : String(sqliteDate).replace(' ', 'T') + 'Z';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return String(sqliteDate);
  const min = Math.round((Date.now() - t) / 60000);
  if (min < 1) return "à l'instant";
  if (min < 60) return `il y a ${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `il y a ${h} h`;
  const j = Math.floor(h / 24);
  if (j === 1) return 'hier';
  if (j < 7) return `il y a ${j} jours`;
  return new Date(t).toLocaleDateString('fr-FR', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' });
}

/** Initiales pour l'avatar (« Administration » → AD). */
export function initialsOf(first, last) {
  const a = (first || '').trim()[0] || '';
  const b = (last || '').trim()[0] || '';
  return (a + b).toUpperCase() || '?';
}

/**
 * Publie des annonces de démonstration UNIQUEMENT si la table est vide
 * (première ouverture). Ensuite, seuls les admins écrivent : rien n'est écrasé.
 */
export function ensureAnnonces() {
  if (db.prepare('SELECT COUNT(*) n FROM announcements').get().n > 0) return 0;
  const admin = db.prepare("SELECT id FROM users WHERE role='admin' ORDER BY id LIMIT 1").get();
  if (!admin) return 0;
  const prog = db.prepare('SELECT id, name FROM programs ORDER BY id LIMIT 1').get();
  const klass = db.prepare('SELECT id, name FROM classes ORDER BY id LIMIT 1').get();
  const demo = [
    { body: "Ouverture des saisies du semestre 4 : vous pouvez compléter vos notes dès maintenant depuis l'onglet Saisie. Les résultats officiels du semestre 3 restent consultables dans Relevé.", audience: 'all', when: "-35 minutes", pinned: 1 },
    { body: "Les évaluations de mi-parcours se déroulent samedi matin, Amphi A. Présentez-vous 15 minutes avant le début de l'épreuve avec votre carte d'étudiant.", audience: 'all', when: "-6 hours", pinned: 0 },
    { body: 'Réunion des délégués de classe jeudi à 12 h en salle 21 : ordre du jour — calendrier des rattrapages et organisation des travaux de groupe.', audience: 'class', when: "-1 day", pinned: 0 },
    { body: 'La bibliothèque universitaire prolonge ses horaires pendant la période d’examens : ouverture jusqu’à 21 h du lundi au vendredi.', audience: 'program', when: "-3 days", pinned: 0 },
  ];
  return tx(() => {
    const ins = db.prepare("INSERT INTO announcements (author_id, body, audience, program_id, class_id, pinned, created_at) VALUES (?,?,?,?,?,?,datetime('now', ?))");
    let n = 0;
    for (const d of demo) {
      ins.run(admin.id, d.body, d.audience,
        d.audience === 'program' ? prog?.id ?? null : null,
        d.audience === 'class' ? klass?.id ?? null : null,
        d.pinned, d.when);
      n++;
    }
    return n;
  });
}
