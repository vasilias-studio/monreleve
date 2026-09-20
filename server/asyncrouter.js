/**
 * asyncrouter.js — routurier Express qui rattrape les erreurs des gestionnaires asynchrones.
 *
 * Depuis la migration vers PostgreSQL, les gestionnaires de routes attendent la base
 * (`await`) : ils sont donc `async`. Or Express 4 n'attrape PAS les promesses rejetées :
 * une erreur de requête deviendrait un rejet non géré et la page resterait bloquée.
 *
 * `asyncRouter()` renvoie un Router ordinaire dont TOUS les gestionnaires sont enveloppés :
 * la promesse est suivie et toute erreur part vers le gestionnaire d'erreurs d'Express
 * (la page d'erreur de l'application, avec le bouton « retour »).
 *
 * Règles :
 *   · les sous-routeurs sont laissés tels quels (ils ont leur propre enveloppe) ;
 *   · les gestionnaires d'erreurs (4 arguments) sont laissés tels quels ;
 *   · tout le reste est enveloppé, y compris les intergiciels (middlewares).
 */
import express from 'express';

/** Un objet Router d'Express est une fonction sur laquelle `stack` et `handle` existent. */
const estRouteur = (f) => typeof f === 'function' && f.stack !== undefined && f.handle !== undefined;

function envelopper(gestionnaire) {
  if (typeof gestionnaire !== 'function' || estRouteur(gestionnaire)) return gestionnaire;
  if (gestionnaire.length === 4) return gestionnaire;          /* (err, req, res, next) */
  const enveloppe = (req, res, next) => {
    Promise.resolve()
      .then(() => gestionnaire(req, res, next))
      .catch(next);
  };
  try { Object.defineProperty(enveloppe, 'name', { value: gestionnaire.name || 'gestionnaire' }); } catch { /* sans importance */ }
  return enveloppe;
}

export function asyncRouter(options) {
  const routeur = express.Router(options);
  for (const methode of ['get', 'post', 'put', 'patch', 'delete', 'all', 'use']) {
    const original = routeur[methode].bind(routeur);
    routeur[methode] = (...args) => {
      const chemins = [];
      const gestionnaires = [];
      for (const a of args) (typeof a === 'function' ? gestionnaires : chemins).push(a);
      return original(...chemins, ...gestionnaires.map(envelopper));
    };
  }
  return routeur;
}

export default asyncRouter;
