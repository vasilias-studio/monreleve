/**
 * layout.js — Coquille HTML commune du site MonRelevé (rendu 100 % serveur).
 * Aucune dépendance JS côté navigateur : liens classiques + formulaires POST, rendu 100 % serveur.
 * L'authentification transite par un cookie ET par le paramètre ?t= (jeton), ce dernier
 * étant indispensable dans les contextes où les cookies sont bloqués (aperçus en iframe
 * sandboxée, navigation privée agressive…). Deux micro-scripts tolérés, sans framework :
 * bascule de thème (localStorage) et glissement du disque de navigation (repli sans JS).
 */

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export const fmt = (v, d = 2) => (v == null || !Number.isFinite(Number(v)) ? '—' : Number(v).toLocaleString('fr-FR', { minimumFractionDigits: d, maximumFractionDigits: d }));

/** Construit une URL interne qui propage le jeton t et le thème courant. */
const INTERNAL_KEYS = new Set(['pathname', 'user', 'flash', 'error']);
export function url(pathname, { t, th, ...query } = {}) {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) if (!INTERNAL_KEYS.has(k) && v !== undefined && v !== null && v !== '' && typeof v !== 'object') q.set(k, String(v));
  if (t) q.set('t', t);
  if (th) q.set('th', th);
  const s = q.toString();
  return s ? `${pathname}?${s}` : pathname;
}

export const hiddenT = (t, extra = {}) =>
  Object.entries({ t, ...extra }).filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}"/>`).join('');

export const chip = (text, kind = 'gray') => `<span class="chip ${kind}">${text}</span>`;

export const STATUS_CHIP = {
  validee: ['Validée', 'ok'], non_validee: ['Non validée', 'bad'],
  rattrapage_a_passer: ['Rattrapage à passer', 'warn'], en_attente: ['En attente', 'gray'],
};
export const PUB_CHIP = {
  published: ['Résultats publiés', 'info'], locked: ['Verrouillé', 'warn'], draft: ['Brouillon', 'gray'],
};
export const statusChip = (st) => { const [txt, k] = STATUS_CHIP[st] || [st, 'gray']; return chip(txt, k); };
export const pubChip = (st) => { const [txt, k] = PUB_CHIP[st] || [st, 'gray']; return chip(txt, k); };

/* ---------- Navigation « pastille » : tracés repris À L'IDENTIQUE du repère Figma (Frame-101.svg). ----------
/* SVG autonomes aux coordonnées natives du calque. Remplissage crème = currentColor ;
   maison et onglet courant = cuivre. Espacements relevés sur le modèle : 28 px après la maison, 43 px ensuite. */
const PILL_ART = {
  home: { vb: '15.0 14.0 35.0 37.0', w: 35.0, h: 37.0, paths: '<path fill-rule="evenodd" clip-rule="evenodd" fill="currentColor" d="M37.2573 40.6417H27.7443C27.0671 40.6417 26.5174 40.0817 26.5174 39.3917C26.5174 38.7017 27.0671 38.1417 27.7443 38.1417H37.2573C37.9346 38.1417 38.4843 38.7017 38.4843 39.3917C38.4843 40.0817 37.9346 40.6417 37.2573 40.6417ZM44.3589 22.7633C43.765 22.23 43.0894 21.6267 42.2845 20.8683C41.9197 20.5683 41.5205 20.225 41.0968 19.8617C38.7084 17.81 35.4365 15 32.4542 15C29.5063 15 26.4454 17.6533 23.9866 19.785C23.5318 20.1783 23.1065 20.5483 22.6729 20.9067C21.9106 21.6267 21.235 22.2317 20.6395 22.7667C16.7345 26.2683 16 27.1867 16 35.355C16 50 20.1569 50 32.5 50C44.8415 50 49 50 49 35.355C49 27.185 48.2655 26.2667 44.3589 22.7633Z"/>' },
  pencil: { vb: '90.9 14.0 39.6 37.0', w: 39.6, h: 37.0, paths: '<path fill-rule="evenodd" clip-rule="evenodd" fill="currentColor" d="M127.829 46.7962H114.318C113.441 46.7962 112.729 47.5081 112.729 48.3852C112.729 49.2623 113.441 49.9742 114.318 49.9742H127.829C128.706 49.9742 129.418 49.2623 129.418 48.3852C129.418 47.5081 128.706 46.7962 127.829 46.7962Z"/><path fill-rule="evenodd" clip-rule="evenodd" fill="currentColor" d="M106.13 23.4733C106.341 23.193 106.738 23.1364 107.019 23.3465L117.994 31.5678C118.275 31.7784 118.332 32.1772 118.121 32.4581L107.909 46.0593C105.452 49.3432 101.744 50 99.1807 50C97.5917 50 96.4476 49.7458 96.3205 49.7246C96.0451 49.661 95.7908 49.4704 95.6425 49.2161C95.4942 48.9407 91.8502 42.4577 95.918 37.0551L106.13 23.4733Z"/><path fill-rule="evenodd" clip-rule="evenodd" fill="currentColor" d="M122.21 27.0127L120.791 28.8998C120.58 29.1799 120.182 29.2367 119.902 29.0265L108.925 20.8039C108.645 20.5938 108.588 20.1963 108.797 19.9153L110.219 18.0085C111.681 16.0381 113.948 15 116.236 15C117.803 15 119.371 15.4873 120.727 16.5042C122.316 17.7119 123.354 19.4703 123.651 21.4407C123.926 23.4322 123.418 25.4025 122.21 27.0127Z"/>' },
  chart: { vb: '173.4 14.0 37.1 37.0', w: 37.1, h: 37.0, paths: '<path fill-rule="evenodd" clip-rule="evenodd" fill="currentColor" d="M199.56 30.1246L194.346 36.8505C194.133 37.1352 193.813 37.3132 193.457 37.3487C193.101 37.4021 192.745 37.2954 192.46 37.0818L187.443 33.1495L182.941 39.0036C182.692 39.3416 182.282 39.5196 181.891 39.5196C181.606 39.5196 181.322 39.4306 181.072 39.2349C180.485 38.79 180.378 37.9537 180.823 37.3665L186.161 30.4449C186.375 30.1602 186.695 29.9822 187.051 29.9466C187.407 29.8932 187.763 30 188.048 30.2135L193.065 34.1459L197.443 28.4876C197.905 27.9003 198.741 27.7936 199.329 28.2562C199.898 28.7011 200.005 29.5374 199.56 30.1246ZM208.635 25.8719C207.692 26.3167 206.624 26.5658 205.521 26.5658C201.357 26.5658 197.959 23.1672 197.959 19.0036C197.959 17.8648 198.208 16.7972 198.67 15.8363C196.713 15.4271 194.435 15.2313 191.802 15.2313C178.973 15.2313 174.418 19.7687 174.418 32.6157C174.418 45.4626 178.973 50 191.802 50C204.649 50 209.204 45.4626 209.204 32.6157C209.204 30.0356 209.026 27.7936 208.635 25.8719Z"/><path fill-rule="evenodd" clip-rule="evenodd" fill="currentColor" d="M205.521 23.0071C206.268 23.0071 206.98 22.7936 207.567 22.4377C208.724 21.7438 209.507 20.4626 209.507 19.0035C209.507 16.7971 207.727 15 205.521 15C204.079 15 202.816 15.7651 202.104 16.9217C201.731 17.5267 201.517 18.2384 201.517 19.0035C201.517 21.21 203.314 23.0071 205.521 23.0071Z"/>' },
  calendar: { vb: '253.5 14.0 34.2 37.0', w: 34.2, h: 37.0, paths: '<path fill-rule="evenodd" clip-rule="evenodd" fill="currentColor" d="M278.765 18.8756V16.2353C278.765 15.5534 278.212 15 277.53 15C276.848 15 276.294 15.5534 276.294 16.2353V21.6098C276.294 22.0381 276.527 22.3988 276.859 22.6195C276.663 22.7513 276.441 22.8452 276.187 22.8452C275.506 22.8452 274.952 22.2917 274.952 21.6098V18.0422C273.631 17.8841 272.192 17.8034 270.605 17.8034C268.738 17.8034 267.072 17.9154 265.575 18.141V16.2353C265.575 15.5534 265.022 15 264.34 15C263.658 15 263.104 15.5534 263.104 16.2353V21.6098C263.104 22.0381 263.337 22.3988 263.669 22.6195C263.473 22.7513 263.251 22.8452 262.997 22.8452C262.315 22.8452 261.762 22.2917 261.762 21.6098V19.0898C258.247 20.4453 256.185 22.9671 255.21 26.9827H286.003C284.968 22.7233 282.682 20.167 278.765 18.8756Z"/><path fill-rule="evenodd" clip-rule="evenodd" fill="currentColor" d="M277.874 35.937C277.192 35.937 276.632 35.3836 276.632 34.7017C276.632 34.0198 277.177 33.4663 277.859 33.4663H277.874C278.556 33.4663 279.109 34.0198 279.109 34.7017C279.109 35.3836 278.556 35.937 277.874 35.937ZM277.874 42.2833C277.192 42.2833 276.632 41.7299 276.632 41.048C276.632 40.3644 277.177 39.8126 277.859 39.8126H277.874C278.556 39.8126 279.109 40.3644 279.109 41.048C279.109 41.7299 278.556 42.2833 277.874 42.2833ZM270.628 35.937C269.947 35.937 269.385 35.3836 269.385 34.7017C269.385 34.0198 269.932 33.4663 270.614 33.4663H270.628C271.31 33.4663 271.864 34.0198 271.864 34.7017C271.864 35.3836 271.31 35.937 270.628 35.937ZM270.628 42.2833C269.947 42.2833 269.385 41.7299 269.385 41.048C269.385 40.3644 269.932 39.8126 270.614 39.8126H270.628C271.31 39.8126 271.864 40.3644 271.864 41.048C271.864 41.7299 271.31 42.2833 270.628 42.2833ZM263.368 35.937C262.686 35.937 262.124 35.3836 262.124 34.7017C262.124 34.0198 262.671 33.4663 263.353 33.4663H263.368C264.05 33.4663 264.603 34.0198 264.603 34.7017C264.603 35.3836 264.05 35.937 263.368 35.937ZM263.368 42.2833C262.686 42.2833 262.124 41.7299 262.124 41.048C262.124 40.3644 262.671 39.8126 263.353 39.8126H263.368C264.05 39.8126 264.603 40.3644 264.603 41.048C264.603 41.7299 264.05 42.2833 263.368 42.2833ZM286.451 29.4523H254.762C254.594 30.803 254.507 32.2738 254.507 33.9028C254.507 45.7867 258.72 50 270.605 50C282.493 50 286.706 45.7867 286.706 33.9028C286.706 32.2738 286.619 30.803 286.451 29.4523Z"/>' },

  send: { vb: '190.0 32.0 34.0 36.0', w: 34.0, h: 36.0, paths: '<path fill="currentColor" d="M220.697 35.6148C220.626 35.4813 220.518 35.372 220.385 35.3007C217.22 33.6166 198.286 39.4852 193.389 42.3103C192.113 43.0462 191.544 43.911 191.7 44.876C192.15 47.6707 199.681 49.7887 203.766 50.737L211.439 43.0659C211.884 42.6214 212.604 42.6214 213.049 43.0659C213.493 43.5105 213.493 44.2312 213.049 44.6757L205.302 52.4196C206.274 56.548 208.37 63.8535 211.12 64.2965C211.224 64.3132 211.327 64.3223 211.428 64.3223C212.269 64.3223 213.028 63.7458 213.685 62.6078C216.51 57.7148 222.383 38.7843 220.697 35.6148Z"/>' },
};
const pillIcon = (n) => { const a = PILL_ART[n]; return `<svg viewBox="${a.vb}" width="${a.w}" height="${a.h}" aria-hidden="true">${a.paths}</svg>`; };

const ICONS = {
  home: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/></svg>',
  list: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M8 6h13M8 12h13M8 18h13"/><circle cx="4" cy="6" r="1" fill="currentColor"/><circle cx="4" cy="12" r="1" fill="currentColor"/><circle cx="4" cy="18" r="1" fill="currentColor"/></svg>',
  chart: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M4 20v-8M10 20V4M16 20v-6M21 20H3"/></svg>',
  user: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="12" cy="8" r="4"/><path d="M4 21c1.5-4 5-5.5 8-5.5S18.5 17 20 21"/></svg>',
  calendar: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M8 3v4M16 3v4M3 10h18"/></svg>',
  pencil: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" stroke-linejoin="round"><path d="m4 20 4-1L20 7l-3-3L5 16z"/></svg>',
};

/** Page complète. ctx : { t, th, title, active?, admin?, wide?, flash?, error? } */
export function page(ctx, { title = 'MonRelevé', body = '', tabs = null, adminTab = null, bare = false } = {}) {
  const th = ctx.th;
  const themeAttr = th === 'dark' || th === 'light' ? ` data-theme="${th}"` : '';
  const toggleHref = url(ctx.pathname || '/', { t: ctx.t, th: th === 'dark' ? 'light' : 'dark' });
  const logoutHref = url('/deconnexion', { t: ctx.t });

  const topbar = `<header class="topbar">
      <div class="brand">${(() => {
        const who = ctx.user;
        if (!who) return '<span class="logo-dot">MR</span> MonRelevé';
        const initials = ((who.first_name || '?')[0] + ((who.last_name || ' ')[0] || ' ')).toUpperCase();
        const href = url(who.role === 'admin' ? '/admin' : '/profil', { t: ctx.t, th });
        return `<a class="identity" href="${href}" title="Mon profil" style="text-decoration:none;color:inherit"><span class="avatar sm">${esc(initials)}</span><b>${esc(`${who.first_name} ${who.last_name}`.trim())}</b></a>${adminTab ? ' <span class="chip violet" style="margin-left:8px">Admin</span>' : ''}`;
      })()}</div>
      <div class="spacer"></div>
      ${bare ? '' : `<a class="icon-btn" href="${toggleHref}" title="Thème clair / sombre" style="text-decoration:none">${th === 'dark' ? '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>' : '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>'}</a>${ctx.t ? `<a class="icon-btn" href="${logoutHref}" title="Se déconnecter" aria-label="Se déconnecter" style="text-decoration:none"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3"/><path d="M10 17l5-5-5-5"/><path d="M15 12H3"/></svg></a>` : ''}`}
    </header>`;

  /* Barre étudiante inspirée de Frame-109 : quatre onglets autour d'un bouton central fixe
     pour écrire à l'administration. Le disque extérieur glisse sous l'onglet courant ;
     le bouton central reste posé sur la barre et passe au cuivre sur sa page. */
  const PILL_OF = { home: 'home', pencil: 'pencil', send: 'send', list: 'chart', chart: 'chart', calendar: 'calendar' };
  const actKey = tabs ? tabsActive(ctx, tabs) : null;
  const actIdx = tabs ? Math.max(0, tabs.findIndex(([, , , key]) => key === actKey)) : 0;
  const studentNav = tabs ? `<nav class="tabbar" aria-label="Navigation principale" data-active="${actIdx}">
    <span class="tab-disc" aria-hidden="true"></span>
    <span class="tab-send-disc" aria-hidden="true"></span>
    ${tabs.map(([href, ico, label, key], i) => {
    const kind = PILL_OF[ico] || 'chart';
    return `<a class="pillbtn pb-${kind}${i === actIdx ? ' cur' : ''}" href="${url(href, { t: ctx.t, th })}" title="${label}" aria-label="${label}"${i === actIdx ? ' aria-current="page"' : ''}>${pillIcon(kind)}</a>`;
  }).join('')}
  </nav>
  <script>
  /* Glissement : on anime le disque puis on navigue (repli : lien natif si JS coupé ou mouvement réduit). */
  (function () {
    var n = document.querySelector('.tabbar'); if (!n) return;
    var calm = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
    n.querySelectorAll('a.pillbtn').forEach(function (a, i) {
      a.addEventListener('click', function (e) {
        if (calm || i === +n.dataset.active || e.metaKey || e.ctrlKey || e.shiftKey) return;
        e.preventDefault();
        n.dataset.active = i;
        setTimeout(function () { location.href = a.getAttribute('href'); }, 300);
      });
    });
  })();
  </script>` : '';

  const adminNav = adminTab ? `<nav style="position:sticky;top:55px;z-index:25;background:color-mix(in srgb, var(--card) 92%, transparent);backdrop-filter:blur(10px);border-bottom:0;padding:8px 12px;display:flex;gap:6px;overflow-x:auto">
      ${[['/accueil', 'Annonces'], ['/admin', 'Tableau de bord'], ['/admin/etudiants', 'Étudiants'], ['/admin/modeles', 'Modèles'], ['/admin/import', 'Import Excel'], ['/admin/referentiels', 'Référentiels'], ['/admin/emploi', 'Calendrier'], ['/admin/messages', 'Messages']]
        .map(([p, l]) => `<a href="${url(p, { t: ctx.t, th })}" class="chip ${p === adminTab ? 'violet' : 'gray'}" style="text-decoration:none;flex:none;font-size:12.5px;padding:6px 12px">${l}</a>`).join('')}
    </nav>` : '';

  const flash = ctx.flash ? `<div class="banner ok" style="margin:10px 14px 0">${ctx.flash}</div>` : '';
  const err = ctx.error ? `<div class="banner bad" style="margin:10px 14px 0">${ctx.error}</div>` : '';

  return `<!doctype html>
<html lang="fr"${themeAttr}>
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"/>
<meta name="robots" content="noindex"/>
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><rect width='100' height='100' rx='24' fill='%23BF814B'/><text x='50' y='68' font-size='52' text-anchor='middle' fill='white' font-family='Arial' font-weight='bold'>M</text></svg>"/>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Josefin+Sans:wght@400;500;600;700&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/style.css"/>
<title>${esc(title)} · MonRelevé</title>
<style>
  /* Compléments propres à l'interface HTML (la charte vient de /style.css) */
  .cards2 { display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:10px; }
  .sem-title { display:flex; align-items:baseline; justify-content:space-between; gap:8px; flex-wrap:wrap; margin:22px 2px 8px; padding-top:6px; }
  .sem-title h2 { margin:0; font-size:1.05rem; }
  form.inline { display:flex; gap:8px; flex-wrap:wrap; align-items:end; }
  .warn-line { color:var(--warn); font-size:12px } .ok-line { color:var(--ok); font-size:12px }
</style>
</head>
<body>
${topbar}${adminNav}
<main class="${adminTab ? 'wide ' : ''}fade">${flash}${err}${body}</main>
${studentNav}
</body>
</html>`;
}
function tabsActive(ctx, tabs) {
  const p = ctx.pathname || '/';
  let best = null;
  for (const [href, , , key] of tabs) if (p === href || (href !== '/admin' && p.startsWith(href + '/'))) best = key;
  return best ?? (tabs[0]?.[3] || '');
}
