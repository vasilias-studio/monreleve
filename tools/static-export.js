#!/usr/bin/env node
/* ============================================================
   tools/static-export.js — export « site HTML statique »
   Interroge le serveur MonRelevé en local, récupère chaque page
   rendue (contenu réel, charte Vasilías) et écrit une version
   AUTONOME dans site-html/ :
     · CSS inliné (plus de /style.css)
     · liens internes réécrits en fichiers .html RELATIFS,
       variantes à paramètres conservées (ex. S4 → saisie-sem2.html)
     · jetons ?t= et thème ?th= retirés, jamais de « & » orphelin · calendrier : 9 semaines embarquées
     · bascule de thème locale (localStorage) sur chaque page
   Les appels API (formulaires, exports .xlsx, déconnexion) nécessitent
   le serveur réel : cette copie est une visite figée du design.
   Usage : node server/index.js (autre terminal) puis node tools/static-export.js
   ============================================================ */
import { mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const BASE = process.env.BASE || 'http://localhost:4000';
const OUT = 'site-html';

/* amorces d'exploration : [fichier de sortie, URL serveur, compte utilisé] */
const SEEDS = [
  ['login.html', '/login', null],
  ['register.html', '/register', null],
  ['forgot.html', '/forgot', null],
  ['accueil.html', '/accueil', 'student'],
  ['saisie.html', '/saisie', 'student'],
  ['releve.html', '/releve', 'student'],
  ['releve-officiel.html', '/releve?source=official', 'student'],
  /* ?weeks=13 : la copie statique embarque 13 semaines (≈ 3 mois) autour de la date d'export,
     pour pouvoir avancer/reculer d'un jour à la fois comme un vrai calendrier */
  ['calendrier.html', '/calendrier?weeks=13', 'student'],
  /* les pastilles S3/S4 ont été retirées de la page : la variante « Semestre 4 » reste exportée,
     atteignable par son fichier (ou ?sem= côté serveur) */
  ['calendrier-s4.html', '/calendrier?sem=2&weeks=13', 'student'],
  ['profil.html', '/profil', 'student'],
  ['admin-emploi.html', '/admin/emploi', 'admin'],
  ['accueil-admin.html', '/accueil', 'admin'],   /* le fil vu par l'administration (avec le composeur) */
  ['admin.html', '/admin', 'admin'],
  ['admin-etudiants.html', '/admin/etudiants', 'admin'],
  ['admin-modeles.html', '/admin/modeles', 'admin'],
  ['admin-referentiels.html', '/admin/referentiels', 'admin'],
  ['admin-import.html', '/admin/import', 'admin'],
];

/* routes considérées comme pages (→ candidate à l'export) ; le reste reste tel quel */
const PAGE_PATHS = new Set([
  '/', '/login', '/register', '/forgot', '/reset', '/accueil', '/saisie', '/releve', '/moyennes', '/calendrier', '/profil',
  '/admin', '/admin/etudiants', '/admin/modeles', '/admin/referentiels', '/admin/import', '/admin/emploi',
]);
/* aliases : une route supprimée/équivalente pointe vers la page canonique */
const ALIAS = { '/reset': '/login', '/moyennes': '/releve', '/': '/accueil' };

/* script inséré dans chaque page : thème local via localStorage (pas de cookie en statique) */
/* bandeau inséré en tête de contenu : la copie statique s'annonce (consultation seule) */
const STATIC_NOTE = `<div class="static-note">
  <b>Copie statique</b> — consultation seule du design. Saisie, annonces et exports PDF fonctionnent dans l’application : <code>npm run serve</code> puis <code>localhost:4000</code>.
</div>`;

const THEME_JS = `<script>
(function () {
  var K = 'mr-theme', h = document.documentElement;
  try { var v = localStorage.getItem(K); if (v) h.setAttribute('data-theme', v); } catch (e) {}
  document.addEventListener('submit', function (e) {
    if ((e.target.getAttribute('method') || '').toLowerCase() === 'post') {
      e.preventDefault();
      var b = document.createElement('div');
      b.className = 'banner warn'; b.textContent = 'Copie statique : cette action nécessite l’application réelle (npm run serve).';
      e.target.appendChild(b);
    }
  });
  var a = document.querySelector('a.icon-btn[title^="Thème"]');
  if (a) { a.href = 'javascript:void 0'; a.addEventListener('click', function () {
    var next = h.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    h.setAttribute('data-theme', next);
    try { localStorage.setItem(K, next); } catch (e) {}
  }); }
})();
</script>`;

const login = async (email, password) => {
  const r = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!r.ok) throw new Error(`login ${email} → HTTP ${r.status}`);
  return (await r.json()).token;
};

/* clé canonique d'une URL interne : chemin + requête triée, t/th retirés */
const normKey = (u) => {
  u = u.split('#')[0];
  const i = u.indexOf('?');
  const path = (i < 0 ? u : u.slice(0, i)).replace(/\/$/, '') || '/';
  const keep = (i < 0 ? '' : u.slice(i + 1)).split('&')
    /* paramètres volatils ignorés : t/th (session), d (jour sélectionné au calendrier) → pas de pages dupliquées */
    .filter((kv) => kv && !/^(t|th|d|weeks)=/.test(kv)).sort();
  return keep.length ? `${path}?${keep.join('&')}` : path;
};
const fileForKey = (key) => `${key.replace(/^\//, '').replace(/[?&=]/g, (c) => ({ '?': '-', '&': '-', '=': '' }[c]))}.html`;

async function main() {
  const css = readFileSync('client/src/styles.css', 'utf8') + `
/* --- bandeau de la copie statique (n'existe que dans l'export) --- */
.static-note { display: flex; gap: 8px; align-items: baseline; flex-wrap: wrap; background: color-mix(in srgb, var(--accent) 16%, var(--bg));
  color: var(--text); font-size: 12.5px; line-height: 1.45; padding: 9px 16px; }
.static-note b { text-transform: uppercase; letter-spacing: .06em; font-size: 11px; color: var(--accent); }
.static-note code { background: color-mix(in srgb, var(--accent) 18%, transparent); border-radius: 4px; padding: 1px 5px; font-size: 12px; }
`; // + bandeau statique
  const tokens = {
    student: await login('naina.randria@example.mg', 'etudiant123'),
    admin: await login('admin@univ.mg', 'admin123'),
  };

  /* ── passe 1 : crawl — on découvre les variantes (sem=2, source=…) au fil des pages ── */
  const byKey = new Map();       // clé canonique → fichier de sortie
  const queue = SEEDS.map(([file, url, who]) => {
    const key = ALIAS[url.split('?')[0]] === undefined ? normKey(url) : normKey(ALIAS[url.split('?')[0]] ?? url);
    byKey.set(key, file);
    return { file, url, who, key };
  });
  // clés d'alias explicites → fichier canonique
  for (const [from, to] of Object.entries(ALIAS)) {
    const base = queue.find((q) => q.key === normKey(to) || (SEEDS.find((s) => s[1] === to) || [])[1] === to);
    if (base) byKey.set(from, base.file);
    else { const f = SEEDS.find((s) => s[1] === to); if (f) byKey.set(from, f[0]); }
  }

  const fetched = [];
  let guard = 0;
  while (queue.length && guard++ < 30) {
    const entry = queue.shift();
    const tok = entry.who ? tokens[entry.who] : null;
    const full = entry.url + (tok ? (entry.url.includes('?') ? '&' : '?') + 't=' + tok : '');
    const r = await fetch(BASE + full, { redirect: 'follow' });
    if (!r.ok) { console.error(`✗ ${entry.url} → HTTP ${r.status}`); continue; }
    const html = await r.text();
    fetched.push({ ...entry, html });
    for (const m of html.matchAll(/(?:href|action)="(\/[^"#]*)"/g)) {
      const key = normKey(m[1]);
      const path = key.split('?')[0];
      if (!PAGE_PATHS.has(path) || byKey.has(key)) continue;
      const file = fileForKey(key);
      byKey.set(key, file);
      queue.push({ file, url: key, who: entry.who, key });
    }
  }

  /* ── passe 2 : transformations et écriture ── */
  rmSync(OUT, { recursive: true, force: true }); // jamais de fichier périmé dans l'export
  mkdirSync(OUT, { recursive: true });
  let n = 0;
  for (const { file, html } of fetched) {
    let h = html.replace('<link rel="stylesheet" href="/style.css"/>', `<style>\n${css}\n</style>`);
    h = h.replace(/((?:href|action|data-[a-z0-9-]+))="([^"]*)"/g, (m, attr, u) => {
      if (!u.startsWith('/')) return m;
      const dest = byKey.get(normKey(u));
      if (dest) return `${attr}="${dest}"`;
      /* data-* : lu par un script (navigation clavier) → page statique ou lien conservé, mais jeton retiré */
      if (attr.startsWith('data-')) {
        const i = u.indexOf('?');
        const keep = (i < 0 ? '' : u.slice(i + 1)).split('&').filter((kv) => kv && !/^(t|th)=/.test(kv));
        return `${attr}="${u.slice(0, i)}${keep.length ? '?' + keep.join('&') : ''}"`;
      }
      if (u.startsWith('/api/') || u.startsWith('/admin/fichiers/') || u.startsWith('/mon-releve') || u === '/deconnexion') {
        // sans serveur : action impossible → lien inerte (évite tout « Not found »)
        return `${attr}="javascript:void(0)"`;
      }
      if (attr === 'action') {
        // formulaire de service (non mappé à une page) : inerte + jamais de jeton dans le fichier
        if (!u.startsWith('/login') && !u.startsWith('/register') && !u.startsWith('/forgot') && !u.startsWith('/reset')) return `${attr}="javascript:void(0)"`;
      }
      if (u.includes('t=eyJ')) {
        const i = u.indexOf('?');
        const keep = (i < 0 ? '' : u.slice(i + 1)).split('&').filter((kv) => kv && !/^(t|th)=/.test(kv));
        return `${attr}="${u.slice(0, i)}${keep.length ? '?' + keep.join('&') : ''}"`;
      }
      return m;
    });
    h = h.replace(/<input type="hidden" name="t"[^>]*>/g, '');
    /* marque la copie statique : le calendrier y bascule ses 7 jours pré-rendus sans recharger */
    h = h.replace('<html lang="fr"', '<html lang="fr" data-static="1"');
    /* le bandeau s'annonce dès l'ouverture (premier <main> uniquement) */
    const iMain = h.indexOf('<main');
    if (iMain >= 0) h = h.slice(0, iMain) + STATIC_NOTE + h.slice(iMain);
    h = h.replace('</body>', THEME_JS + '\n</body>');
    /* garde : un export qui contient encore un jeton est un export raté */
    if (/eyJ/.test(h)) throw new Error(`${file} : jeton de session encore présent — export interrompu`);
    writeFileSync(join(OUT, file), h);
    n++; console.log(`✓ ${file}`);
  }

  /* page d'entrée */
  writeFileSync(join(OUT, 'index.html'), `<!doctype html>
<html lang="fr"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>MonRelevé — version statique</title>
<style>
${css}
body { display: flex; flex-direction: column; }
main { flex: 1; min-height: 70vh; display: grid; place-items: center; }
.idx { display: grid; gap: 10px; max-width: 520px; width: 100%; }
.idx a.btn { justify-content: space-between; }
</style></head>
<body>
<main>
  ${STATIC_NOTE}
  <div class="idx">
    <p class="eyebrow">[ export statique · ${new Date().toLocaleDateString('fr-FR')} ]</p>
    <h1>MonRelevé</h1>
    <p class="muted small">Visite figée du design (données au moment de l'export). Les formulaires nécessitent le serveur réel : <code>npm run serve</code>.</p>
    <a class="btn" href="accueil.html">Espace étudiant — Accueil <span>→</span></a>
    <a class="btn ghost" href="saisie.html">Saisie de notes — S3/S4 (calcul en direct) <span>→</span></a>
    <a class="btn ghost" href="releve.html">Relevé &amp; progression <span>→</span></a>
    <a class="btn ghost" href="calendrier.html">Calendrier — emploi du temps <span>→</span></a>
    <a class="btn ghost" href="admin.html">Console administrateur <span>→</span></a>
    <a class="btn ghost" href="login.html">Connexion / inscription <span>→</span></a>
  </div>
</main>
</body></html>`);
  console.log(`\n${n + 1} fichiers → ${OUT}/ (dont index.html)`);
}
main().catch((e) => { console.error('ERREUR :', e.message); process.exit(1); });
