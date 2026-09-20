/**
 * tools/verifier-async.js — contrôle indépendant après la migration asynchrone.
 *
 * Passe en revue l'arbre syntaxique des sources et signale :
 *   1. une exécution de requête (db.prepare/db.exec) qui n'est pas attendue ;
 *   2. une boucle de rendu `.map(rappel)` dont le rappel est asynchrone sans être
 *      enveloppé dans `Promise.all` (sinon la page afficherait « [object Promise] ») ;
 *   3. `.filter/.forEach/.reduce/.sort/…` avec un rappel asynchrone (ne peut pas fonctionner) ;
 *   4. un appel à une fonction locale déclarée `async` qui n'est pas attendu.
 *
 * Usage : node tools/verifier-async.js <fichier.js> [...]
 */
import fs from 'node:fs';
import { parse } from 'acorn';

const fichiers = process.argv.slice(2);
if (!fichiers.length) { console.error('Usage : node tools/verifier-async.js <fichier.js> [...]'); process.exit(1); }

const METHODES = new Set(['map', 'filter', 'forEach', 'reduce', 'reduceRight', 'sort', 'some', 'every', 'find', 'findIndex', 'flatMap']);
const estFonction = (n) => n && ['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression'].includes(n.type);
const corpsDe = (n) => (n.type === 'Property' ? n.value.body : n.body);
const ligne = (src, pos) => src.slice(0, pos).split('\n').length;
const extrait = (src, pos, n = 80) => src.slice(pos, pos + n).split('\n')[0].trim();

function parcours(node, enter, anc = []) {
  if (!node || typeof node.type !== 'string') return;
  if (enter(node, anc) === false) return;
  anc.push(node);
  for (const k of Object.keys(node)) {
    if (['start', 'end', 'loc', 'type', 'raw'].includes(k)) continue;
    const v = node[k];
    if (Array.isArray(v)) { for (const x of v) parcours(x, enter, anc); }
    else if (v && typeof v.type === 'string') parcours(v, enter, anc);
  }
  anc.pop();
}

/** La requête est-elle attendue (ou simplement transmise telle quelle) ? */
function estAttendu(parents, noeud) {
  let n = noeud;
  for (;;) {
    const p = parents.get(n);
    if (!p) return false;
    if (p.type === 'AwaitExpression') return true;
    if (p.type === 'MemberExpression' && p.object === n) { n = p; continue; }
    if (p.type === 'CallExpression' && p.callee === n) { n = p; continue; }
    if (p.type === 'ChainExpression' && p.expression === n) { n = p; continue; }   /* a?.b */
    if (p.type === 'ReturnStatement' || p.type === 'ArrowFunctionExpression' || p.type === 'Property') return true;   /* promesse transmise */
    return false;
  }
}

let problemes = 0;
for (const fichier of fichiers) {
  const src = fs.readFileSync(fichier, 'utf8');
  const ast = parse(src, { ecmaVersion: 2022, sourceType: 'module', locations: true, allowHashBang: true });
  const parents = new Map();
  parcours(ast, (n, anc) => { if (anc.length) parents.set(n, anc[anc.length - 1]); });

  /* fonctions locales déclarées async */
  const asyncs = new Set();
  parcours(ast, (n) => {
    if (n.type === 'FunctionDeclaration' && n.async && n.id) asyncs.add(n.id.name);
    if (n.type === 'VariableDeclarator' && n.id?.type === 'Identifier' && estFonction(n.init) && n.init.async) asyncs.add(n.id.name);
  });

  const signaler = (n, message) => { problemes++; console.log(`  ${fichier}:${ligne(src, n.start)} — ${message}\n      ${extrait(src, n.start)}`); };

  parcours(ast, (n) => {
    /* 1. requêtes non attendues */
    if (n.type === 'CallExpression' && n.callee?.type === 'MemberExpression'
      && n.callee.object?.type === 'Identifier' && n.callee.object.name === 'db'
      && ['prepare', 'exec'].includes(n.callee.property?.name) && !estAttendu(parents, n)) {
      signaler(n, 'requête non attendue (await manquant)');
      return false;
    }
    /* 2/3. rappels asynchrones dans les méthodes de tableau */
    if (n.type === 'CallExpression' && n.callee?.type === 'MemberExpression' && METHODES.has(n.callee.property?.name) && !n.callee.computed) {
      const rappel = n.arguments?.[0];
      if (!estFonction(rappel) || !rappel.async) return;
      let contientAwait = false;
      parcours(corpsDe(rappel), (m) => {
        if (m !== rappel && estFonction(m)) return false;
        if (m.type === 'AwaitExpression') { contientAwait = true; return false; }
        return !contientAwait;
      });
      if (!contientAwait) return;
      const parent = parents.get(n);
      const enveloppe = parent?.type === 'CallExpression' && parent.callee?.type === 'MemberExpression'
        && parent.callee.object?.name === 'Promise' && parent.callee.property?.name === 'all';
      if (n.callee.property.name === 'map' && enveloppe) return;
      signaler(n, `.${n.callee.property.name}(…) reçoit un rappel asynchrone${n.callee.property.name === 'map' ? ' sans Promise.all' : ' (ne peut pas fonctionner)'}`);
      return false;
    }
    /* 4. appel non attendu d'une fonction locale async */
    if (n.type === 'CallExpression' && n.callee?.type === 'Identifier' && asyncs.has(n.callee.name) && !estAttendu(parents, n)) {
      signaler(n, `appel à ${n.callee.name}() (async) non attendu`);
    }
    return true;
  });
}

console.log(problemes ? `\n${problemes} problème(s) détecté(s)\n` : '\nAucun problème détecté\n');
process.exit(problemes ? 1 : 0);
