/**
 * tools/asyncify-db.js — outil de migration (exécuté une fois ; conservé pour la traçabilité).
 *
 * POURQUOI : SQLite (better-sqlite3) expose une API SYNCHRONE, PostgreSQL/Supabase une API
 * ASYNCHRONE. Pour que les mêmes ~300 requêtes fonctionnent sur les deux pilotes, il faut :
 *   · `await` devant chaque exécution de requête ;
 *   · `async` sur les fonctions qui en contiennent, et sur celles qui les appellent
 *     (propagation en cascade dans le graphe d'appel, y compris d'un fichier à l'autre) ;
 *   · les boucles de rendu `liste.map(rappel)` → `(await Promise.all(liste.map(async …)))`.
 *
 * COMMENT : analyse par arbre syntaxique (acorn, dépendance de développement) ; les
 * modifications sont des insertions de texte aux positions exactes du source, ce qui
 * préserve la mise en forme, les commentaires et les gabarits de chaînes.
 *
 * Restent à traiter à la main (signalés par le rapport) : rappels non-`map`
 * (.filter/.forEach/.reduce/.sort/…), `.then(...)`, événements, requêtes préparées
 * conservées dans une variable.
 *
 * Usage :
 *   node tools/asyncify-db.js <fichiers…>            → simulation + rapport
 *   node tools/asyncify-db.js <fichiers…> --ecrire   → applique les modifications
 */

import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'acorn';

const ECRIRE = process.argv.includes('--ecrire');
const fichiers = process.argv.slice(2).filter((a) => !a.startsWith('--'));
if (!fichiers.length) {
  console.error('Usage : node tools/asyncify-db.js <fichier.js> [...] [--ecrire]');
  process.exit(1);
}

const METHODES_TABLEAU = new Set(['map', 'filter', 'forEach', 'reduce', 'reduceRight', 'sort', 'some', 'every', 'find', 'findIndex', 'flatMap']);
const estFonction = (n) => n && ['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression'].includes(n.type);
const corpsDe = (n) => (n.type === 'Property' ? n.value.body : n.body);
const ASYNC_DEJA = /\basync\s*$/;

/** Parcours d'arbre générique : `enter` peut renvoyer false pour ne pas descendre. */
function parcours(node, enter, anc = []) {
  if (!node || typeof node.type !== 'string') return;
  if (enter(node, anc) === false) return;
  anc.push(node);
  for (const k of Object.keys(node)) {
    if (k === 'start' || k === 'end' || k === 'loc' || k === 'type' || k === 'raw') continue;
    const v = node[k];
    if (Array.isArray(v)) { for (const x of v) parcours(x, enter, anc); }
    else if (v && typeof v.type === 'string') parcours(v, enter, anc);
  }
  anc.pop();
}

const estRequete = (n) => n?.type === 'CallExpression' && n.callee?.type === 'MemberExpression'
  && n.callee.object?.type === 'Identifier' && n.callee.object.name === 'db' && !n.callee.computed
  && ['prepare', 'exec'].includes(n.callee.property?.name);

/* ------------------------------------------------------------------ */
/* 1. Analyse                                                          */
/* ------------------------------------------------------------------ */
function analyser(fichier) {
  const src = fs.readFileSync(fichier, 'utf8');
  const ast = parse(src, { ecmaVersion: 2022, sourceType: 'module', locations: true, allowHashBang: true });
  const info = { fichier, src, ast, fonctions: new Map(), appels: new Map(), requetes: [], exports: new Map(), imports: new Map(), parents: new Map() };

  parcours(ast, (n, anc) => { if (anc.length) info.parents.set(n, anc[anc.length - 1]); });

  /* fonctions nommées : déclaration, variable, méthode d'objet */
  parcours(ast, (n) => {
    if (n.type === 'FunctionDeclaration' && n.id) info.fonctions.set(n.id.name, n);
    if (n.type === 'VariableDeclarator' && n.id?.type === 'Identifier' && estFonction(n.init)) info.fonctions.set(n.id.name, n.init);
    if (n.type === 'Property' && (n.method || n.value?.type === 'FunctionExpression') && n.key?.type === 'Identifier') info.fonctions.set(n.key.name, n);
  });

  /* exports */
  parcours(ast, (n) => {
    if (n.type === 'ExportNamedDeclaration') {
      if (n.declaration?.type === 'FunctionDeclaration') info.exports.set(n.declaration.id.name, n.declaration.id.name);
      if (n.declaration?.type === 'VariableDeclaration') for (const d of n.declaration.declarations) if (d.id?.type === 'Identifier') info.exports.set(d.id.name, d.id.name);
      for (const s of n.specifiers || []) if (s.type === 'ExportSpecifier') info.exports.set(s.exported.name, s.local.name);
    }
    if (n.type === 'ExportDefaultDeclaration') info.exports.set('default', 'default');
  });

  /* imports */
  parcours(ast, (n) => {
    if (n.type !== 'ImportDeclaration') return;
    for (const s of n.specifiers) info.imports.set(s.local.name, { source: n.source.value, nom: s.imported?.name ?? 'default' });
  });

  /* requêtes + appels de fonctions, par fonction (sans descendre dans les imbriquées) */
  const cibles = [...info.fonctions.entries()];
  for (const [nom, noeud] of cibles) {
    const appels = new Set();
    parcours(corpsDe(noeud), (n) => {
      if (n !== noeud && estFonction(n)) return false;             /* fonction imbriquée : traitée à part */
      if (estRequete(n)) { info.requetes.push({ noeud: n, fonction: nom }); return false; }
      if (n.type === 'CallExpression') {
        const c = n.callee;
        if (c?.type === 'Identifier') appels.add(c.name);
        else if (c?.type === 'MemberExpression' && c.object?.type === 'Identifier' && !c.computed) appels.add(c.object.name);
      }
      return true;
    });
    info.appels.set(nom, appels);
  }
  /* requêtes hors fonction (niveau module) */
  parcours(ast, (n) => { if (estRequete(n) && !info.requetes.some((r) => r.noeud === n)) info.requetes.push({ noeud: n, fonction: null }); });

  /* fonctions non nommées : rappels d'appel, fonctions appelées immédiatement (IIFE),
   * valeurs affectées… Toutes doivent pouvoir devenir `async` si elles touchent la base. */
  /* variables contenant une requête préparée (exécutée plus loin : stmt.run…) */
  info.porteurs = new Set();
  parcours(ast, (n) => {
    if (n.type === 'VariableDeclarator' && n.id?.type === 'Identifier' && estRequete(n.init)) info.porteurs.add(n.id.name);
  });

  info.anonymes = [];
  const nommees = new Set([...info.fonctions.values()].map((n) => (n.type === 'Property' ? n.value : n)));
  parcours(ast, (n, anc) => {
    if (!estFonction(n) || nommees.has(n)) return;
    if (n.type === 'FunctionExpression' && n.id) return;         /* fonction nommée classique */
    info.anonymes.push({ noeud: n, parent: anc[anc.length - 1] });
  });

  return info;
}

const infos = fichiers.map(analyser);
const base = (f) => path.basename(f);
const clef = (info, nom) => `${base(info.fichier)}:${nom}`;

/* ------------------------------------------------------------------ */
/* 2. Propagation « doit être async »                                  */
/* ------------------------------------------------------------------ */
const exportAsync = new Map();
for (const info of infos) for (const [e, local] of info.exports) exportAsync.set(`${base(info.fichier)}:${e}`, false);

/* « doit être async » (donc aussi « à attendre » par les appelants) */
const doitEtreAsync = new Map();

/* 2a. fonctions déjà déclarées `async` : elles sont déjà « à attendre » */
for (const info of infos) {
  for (const [nom, noeud] of info.fonctions) {
    if ((noeud.type === 'Property' ? noeud.value : noeud).async) doitEtreAsync.set(clef(info, nom), true);
  }
}

/* 2b. fermeture transitive : une requête, un appel à une fonction async (locale ou importée),
 *     ou un rappel anonyme devenu async, rend la fonction async à son tour. */
let change = true;
while (change) {
  change = false;
  for (const info of infos) {
    for (const [nom] of info.fonctions) {
      const k = clef(info, nom);
      if (doitEtreAsync.get(k)) continue;
      const requete = info.requetes.some((r) => r.fonction === nom);
      const appelLocal = [...(info.appels.get(nom) || [])].some((c) => doitEtreAsync.get(clef(info, c)));
      const appelImport = [...(info.appels.get(nom) || [])].some((c) => {
        const imp = info.imports.get(c);
        return imp ? exportAsync.get(`${base(imp.source)}:${imp.nom}`) === true : false;
      });
      const executePorteur = [...(info.appels.get(nom) || [])].some((c) => info.porteurs.has(c));
      if (requete || appelLocal || appelImport || executePorteur) { doitEtreAsync.set(k, true); change = true; }
    }
  }
  for (const info of infos) {
    for (const [e, local] of info.exports) {
      const k = `${base(info.fichier)}:${e}`;
      if (doitEtreAsync.get(clef(info, local)) === true && exportAsync.get(k) !== true) { exportAsync.set(k, true); change = true; }
    }
  }
}

/* 2c. rappels anonymes : doivent être async s'ils contiennent une requête, appellent une
 *     fonction déjà async, ou contiennent une boucle `.map` dont le rappel est async. */
const anonymesAsync = new Map();          /* nœud → fichier d'origine */
const memoAnonyme = new Map();
const estAsyncNommee = (nom) => doitEtreAsync.get(clef(infoCourante, nom)) === true;
let infoCourante = null;
const asyncImportee = (info, nom) => {
  const imp = info.imports.get(nom);
  return imp ? exportAsync.get(`${base(imp.source)}:${imp.nom}`) === true : false;
};
const besoinAsync = (info, noeud) => {
  if (memoAnonyme.has(noeud)) return memoAnonyme.get(noeud);
  let besoin = false;
  parcours(corpsDe(noeud), (n) => {
    if (n !== noeud && estFonction(n)) {
      const inline = info.anonymes.some((a) => a.noeud === n);
      if (inline ? besoinAsync(info, n) : false) besoin = true;
      return false;
    }
    if (estRequete(n)) { besoin = true; return false; }
    if (n.type === 'CallExpression') {
      const c = n.callee;
      if (c?.type === 'Identifier' && (estAsyncNommee(c.name) || asyncImportee(info, c.name))) besoin = true;
      if (c?.type === 'MemberExpression' && !c.computed) {
        const rappel = n.arguments?.[0];
        if (METHODES_TABLEAU.has(c.property?.name) && estFonction(rappel) && besoinAsync(info, rappel)) besoin = true;
      }
    }
    return true;
  });
  memoAnonyme.set(noeud, besoin);
  return besoin;
};
for (const info of infos) {
  infoCourante = info;
  for (const a of info.anonymes) if (besoinAsync(info, a.noeud)) anonymesAsync.set(a.noeud, info);
}

const ligneDe = (src, pos) => src.slice(0, pos).split('\n').length;
const extrait = (src, pos, n = 70) => src.slice(pos, pos + n).split('\n')[0].trim();

/* ------------------------------------------------------------------ */
/* 3. Modifications                                                    */
/* ------------------------------------------------------------------ */
let total = { async: 0, await: 0, mapAll: 0 };

for (const info of infos) {
  const { src } = info;
  const edits = [];
  const aTraiter = [];

  /* remonter la chaîne d'accès : db.prepare(x).get(y) → un seul await devant toute la chaîne */
  const chaine = (n) => {
    let top = n;
    for (;;) {
      const p = info.parents.get(top);
      if (p?.type === 'MemberExpression' && p.object === top) top = p;
      else if (p?.type === 'CallExpression' && p.callee === top) top = p;
      else if (p?.type === 'ChainExpression' && p.expression === top) top = p;   /* a?.b : enveloppe d'acorn */
      else if (p?.type === 'TaggedTemplateExpression') return p;                 /* gabarit étiqueté */
      else return top;
    }
  };

  /* 3a. async sur les fonctions concernées */
  for (const [nom, noeud] of info.fonctions) {
    if (doitEtreAsync.get(clef(info, nom)) !== true) continue;
    const cible = noeud.type === 'Property' ? noeud.value : noeud;
    if (cible.async) continue;
    /* { foo() {} }  → async devant la clef ; { foo: () => {} } → async devant la valeur */
    const position = noeud.type === 'Property' && !noeud.method ? noeud.value.start : noeud.start;
    const avant = src.slice(Math.max(0, position - 12), position);
    if (ASYNC_DEJA.test(avant)) continue;
    edits.push({ pos: position, texte: 'async ' });
  }
  for (const [noeud, proprietaire] of anonymesAsync) {
    if (proprietaire !== info) continue;                  /* les positions sont locales au fichier */
    const avant = src.slice(Math.max(0, noeud.start - 12), noeud.start);
    if (noeud.async || ASYNC_DEJA.test(avant)) continue;
    edits.push({ pos: noeud.start, texte: 'async ' });
  }

  /* 3b. await devant l'EXÉCUTION de la requête.
   *     Important : `db.prepare(sql).all(x).map(f)` doit devenir
   *     `(await db.prepare(sql).all(x)).map(f)` — le `await` porte sur l'exécution,
   *     sinon `.map` s'appliquerait à la promesse (erreur « .map is not a function »). */
  const execution = (n) => {
    let noeud = n;
    for (let i = 0; i < 2; i++) {
      const p2 = info.parents.get(noeud);
      if (p2?.type === 'MemberExpression' && p2.object === noeud && !p2.computed && ['get', 'all', 'run'].includes(p2.property?.name)) { noeud = p2; continue; }
      if (p2?.type === 'CallExpression' && p2.callee === noeud) { noeud = p2; break; }
      break;
    }
    return noeud;
  };
  const continueApres = (n) => {
    const p2 = info.parents.get(n);
    if (p2?.type === 'MemberExpression' && p2.object === n) return true;
    if (p2?.type === 'CallExpression' && p2.callee === n) return true;
    if (p2?.type === 'ChainExpression' && p2.expression === n) return true;
    return false;
  };
  for (const r of info.requetes) {
    if (r.rappelANONYME) continue;
    if (info.parents.get(r.noeud)?.type === 'AwaitExpression') continue;
    const exec = execution(r.noeud);
    if (info.parents.get(exec)?.type === 'AwaitExpression') continue;
    const suite = info.parents.get(exec);
    if (suite?.type === 'MemberExpression' && suite.property?.name === 'then') continue;   /* chaîne explicite */
    if (continueApres(exec)) {
      edits.push({ pos: exec.start, texte: '(await ' });
      edits.push({ pos: exec.end, texte: ')' });
    } else {
      edits.push({ pos: exec.start, texte: 'await ' });
    }
  }

  /* 3b-bis. requêtes préparées conservées dans une variable :
   *         `const stmt = db.prepare(…)` puis `stmt.run(…)` → `await stmt.run(…)`. */
  if (info.porteurs.size) {
    parcours(info.ast, (n) => {
      if (n.type !== 'CallExpression' || n.callee?.type !== 'MemberExpression' || n.callee.computed) return;
      if (n.callee.object?.type !== 'Identifier' || !info.porteurs.has(n.callee.object.name)) return;
      if (!['get', 'all', 'run'].includes(n.callee.property?.name)) return;
      if (info.parents.get(n)?.type === 'AwaitExpression') return;
      if (continueApres(n)) { edits.push({ pos: n.start, texte: '(await ' }); edits.push({ pos: n.end, texte: ')' }); }
      else edits.push({ pos: n.start, texte: 'await ' });
    });
  }

  /* 3c. await devant les appels de fonctions devenues async */
  parcours(info.ast, (n) => {
    if (n.type !== 'CallExpression') return;
    const c = n.callee;
    if (c?.type !== 'Identifier') return;
    const imp = info.imports.get(c.name);
    const asyncLocale = doitEtreAsync.get(clef(info, c.name)) === true;
    const asyncImportee = imp ? exportAsync.get(`${base(imp.source)}:${imp.nom}`) === true : false;
    if (!asyncLocale && !asyncImportee) return;
    if (info.parents.get(n)?.type === 'AwaitExpression') return;
    if (asyncImportee && !info.fonctions.has(c.name) && !asyncLocale) {
      /* importé d'un autre module : on attend l'export, sauf si le module ne l'expose pas (helper) */
    }
    const top = chaine(n);
    if (top !== n) { edits.push({ pos: n.start, texte: '(await ' }); edits.push({ pos: n.end, texte: ')' }); }
    else edits.push({ pos: n.start, texte: 'await ' });
  });

  /* 3d. boucles de rendu : .map(…) → (await Promise.all(….map(async …))) */
  parcours(info.ast, (n) => {
    if (n.type !== 'CallExpression') return;
    const c = n.callee;
    if (c?.type !== 'MemberExpression' || c.computed) return;
    const meth = c.property?.name;
    if (!METHODES_TABLEAU.has(meth)) return;
    const rappel = n.arguments?.[0];
    if (!rappel) return;
    /* le rappel est-il asynchrone ? fonction anonyme contenant une requête, ou fonction nommée
     * devenue async (par exemple rows.map(annonceCard) où annonceCard interroge la base). */
    let asynchrone = false, anonyme = false;
    if (estFonction(rappel)) {
      if (rappel.async) return;
      anonyme = true;
      asynchrone = anonymesAsync.get(rappel) === info;
    } else if (rappel.type === 'Identifier') {
      asynchrone = doitEtreAsync.get(clef(info, rappel.name)) === true;
    }
    if (!asynchrone) return;
    if (meth === 'map') {
      edits.push({ pos: c.object.start, texte: '(await Promise.all(' });
      edits.push({ pos: n.end, texte: '))' });
      if (anonyme) edits.push({ pos: rappel.start, texte: 'async ' });
      total.mapAll++;
    } else {
      aTraiter.push(`l.${ligneDe(src, n.start)} : .${meth}(…) attend un rappel asynchrone — restructurer : ${extrait(src, n.start)}`);
    }
  });

  /* application depuis la fin du fichier pour ne pas décaler les positions
   * (dédoublonnage : une même position peut être visée par plusieurs règles) */
  const vues = new Set();
  const unique = edits.filter((e) => { const k = `${e.pos}|${e.texte}`; return vues.has(k) ? false : vues.add(k); });
  unique.sort((a, b) => b.pos - a.pos);
  let out = src;
  for (const e of unique) out = out.slice(0, e.pos) + e.texte + out.slice(e.pos);
  edits.length = 0; edits.push(...unique);
  if (ECRIRE && out !== src) fs.writeFileSync(info.fichier, out);

  const nAsync = edits.filter((e) => e.texte === 'async ').length;
  const nAwait = edits.filter((e) => e.texte.includes('await')).length;
  total.async += nAsync; total.await += nAwait;
  console.log(`\n=== ${path.relative(process.cwd(), info.fichier)} ===`);
  console.log(`  async : ${nAsync} · await : ${nAwait} · requêtes : ${info.requetes.length} · fonctions async : ${[...info.fonctions.keys()].filter((nom) => doitEtreAsync.get(clef(info, nom))).length}/${info.fonctions.size}`);
  if (aTraiter.length) { console.log('  À RESTRUCTURER À LA MAIN :'); for (const t of aTraiter) console.log('    ' + t); }
}
console.log(`\n${ECRIRE ? 'MODIFICATIONS ÉCRITES' : 'SIMULATION'} · async ${total.async} · await ${total.await} · .map→Promise.all ${total.mapAll}\n`);
