/**
 * figma-export.js — Génère des maquettes SVG 1:1 du site MonRelevé pour Figma.
 * Chaque écran devient un fichier SVG vectoriel : importé dans Figma (glisser-déposer),
 * il se transforme en calques modifiables (vrais textes, vrais rects, puces, champs).
 * Les valeurs affichées proviennent de la base de données réelle (notes de naina,
 * moyennes calculées par le moteur officiel compute.js).
 *
 *   node tools/figma-export.js   →   design/figma/*.svg + monreleve-complet.svg
 */
import fs from 'node:fs';
import path from 'node:path';
import db from '../server/db.js';
import { computeReleve, resolveRules } from '../server/compute.js';
import { loadTemplateTree } from '../server/routes/student.js';

const OUT = path.join(import.meta.dirname, '..', 'design', 'figma');
fs.mkdirSync(OUT, { recursive: true });

/* ───────────────────────── palette (styles.css) ───────────────────────── */
const C = {
  bg: '#F2E9D8', bgSoft: '#ECE9E2', card: '#FFFFFF', card2: '#FBF7EE',
  text: '#161513', muted: '#8A857C', line: '#F2E9D8', /* traits retirés sur demande : couleur = fond → invisible */
  primary: '#BF814B', primarySoft: '#F3E3D2', primary2: '#BF814B', purple3: '#BF814B',
  ink: '#161513',
  ok: '#4E6E54', okBg: '#E4EBE1', warn: '#9A6218', warnBg: '#F3E3D2',
  bad: '#9C3B2E', badBg: '#F2DFDB', info: '#55606E', infoBg: '#E6E9EC',
};
const F = (size, weight = 400) => `font-family="Josefin Sans, Inter, sans-serif" font-size="${size}" font-weight="${weight}"`;
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (v, d = 2) => (v == null || !Number.isFinite(Number(v)) ? '—' : Number(v).toLocaleString('fr-FR', { minimumFractionDigits: d, maximumFractionDigits: d }));
const tw = (s, fsz = 13, w = 400) => String(s).length * fsz * (w >= 700 ? 0.56 : 0.52); // largeur estimée
const fit = (s, px, fsz = 13, w = 400) => { s = String(s); if (tw(s, fsz, w) <= px) return s; while (s.length > 1 && tw(s + '…', fsz, w) > px) s = s.slice(0, -1); return s + '…'; };

/* ───────────────────────── primitives de dessin ───────────────────────── */
const rect = (x, y, w, h, { r = 0, fill = 'none', stroke = 'none', sw = 1, op = 1 } = {}) =>
  `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" fill="${fill}" ${stroke === 'none' ? '' : `stroke="${stroke}" stroke-width="${sw}" `}opacity="${op}"/>`;
const text = (x, y, s, { size = 13, weight = 400, fill = C.text, anchor = 'start' } = {}) =>
  `<text x="${x}" y="${y}" ${F(size, weight)} fill="${fill}" text-anchor="${anchor}">${esc(s)}</text>`;
const line = (x1, y1, x2, y2, col = C.line) => `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${col}" stroke-width="1"/>`;
function card(x, y, w, h, id) { return `<g id="${id}">${rect(x, y, w, h, { r: 2, fill: C.card, stroke: C.line })}</g>`; }
function chip(x, y, label, kind = 'gray', { small = false } = {}) {
  const map = { ok: [C.ok, C.okBg], bad: [C.bad, C.badBg], warn: [C.warn, C.warnBg], info: [C.info, C.infoBg], violet: [C.primary, C.primarySoft], gray: [C.muted, C.bgSoft], white: ['rgba(255,255,255,.9)', 'rgba(255,255,255,.16)'] };
  const [fg, bg] = map[kind];
  const fsz = small ? 10 : 11; const w = Math.round(tw(label, fsz, 700)) + 18; const h = small ? 17 : 21;
  return `<g>${rect(x, y, w, h, { r: 99, fill: bg, stroke: kind === 'gray' ? C.line : 'none', sw: 1 })}${text(x + 9, y + (small ? 12 : 14.5), label, { size: fsz, weight: 700, fill: fg })}</g>`;
}
const chipW = (label, small = false) => Math.round(tw(label, small ? 10 : 11, 700)) + 18;
function btn(x, y, w, h, label, { variant = 'primary', size = 13 } = {}) {
  const st = { primary: [`url(#gbtn)`, '#fff'], ghost: [C.card, C.text], subtle: [C.primarySoft, C.primary], danger: [C.badBg, C.bad] }[variant];
  return `<g id="btn-${esc(label)}">${rect(x, y, w, h, { r: 999, fill: st[0], stroke: variant === 'ghost' ? C.line : 'none' })}${text(x + w / 2, y + h / 2 + size * .36, label, { size, weight: 700, fill: st[1], anchor: 'middle' })}</g>`;
}
function field(x, y, w, label, value, { select = false, placeholder = false } = {}) {
  return `<g id="field-${esc(label)}">${text(x, y, label, { size: 11, weight: 600, fill: C.muted })}${rect(x, y + 6, w, 38, { r: 2, fill: placeholder && !value ? C.card : C.bgSoft, stroke: C.line })}${value ? text(x + 12, y + 30, fit(value, w - 34), { size: 13, weight: select ? 600 : 400 }) : ''}${select ? `<path d="M ${x + w - 20} ${y + 21} l 5 6 5 -6" stroke="${C.muted}" stroke-width="1.8" fill="none" stroke-linecap="round"/>` : ''}</g>`;
}
function topbar(y = 0, who = 'Naina Ranao', initials = 'NR') {
  return `<g id="topbar">${rect(0, y, 390, 52, { fill: 'none' })}${rect(4, y + 8, 36, 36, { r: 6, fill: C.primary })}${text(22, y + 31, initials, { size: 12, weight: 800, fill: '#fff', anchor: 'middle' })}${text(48, y + 31, who, { size: 14.5, weight: 800 })}${text(342, y + 31, '⎋', { size: 16 })}${line(0, y + 52, 390, y + 52)}</g>`;
}
const TABS = [['home', 'Accueil', true], ['pencil', 'Saisie'], ['send', 'Message'], ['list', 'Relevé'], ['calendar', 'Calendrier']];
const ICONS = {
  home: (x, y, col) => `<path d="M ${x - 9} ${y - 1} L ${x} ${y - 9} L ${x + 9} ${y - 1} M ${x - 6.5} ${y - 3.5} V ${y + 8} H ${x + 6.5} V ${y - 3.5}" stroke="${col}" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`,
  list: (x, y, col) => `<g stroke="${col}" stroke-width="2" fill="none" stroke-linecap="round"><line x1="${x - 4}" y1="${y - 6}" x2="${x + 10}" y2="${y - 6}"/><line x1="${x - 4}" y1="${y}" x2="${x + 10}" y2="${y}"/><line x1="${x - 4}" y1="${y + 6}" x2="${x + 10}" y2="${y + 6}"/><circle cx="${x - 9}" cy="${y - 6}" r="1.6" fill="${col}"/><circle cx="${x - 9}" cy="${y}" r="1.6" fill="${col}"/><circle cx="${x - 9}" cy="${y + 6}" r="1.6" fill="${col}"/></g>`,
  pencil: (x, y, col) => `<g stroke="${col}" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M ${x - 8} ${y + 9} L ${x - 6} ${y + 2} L ${x + 6} ${y - 8} L ${x + 9} ${y - 5} L ${x - 3} ${y + 7} Z"/></g>`,
  calendar: (x, y, col) => `<g stroke="${col}" stroke-width="2" fill="none" stroke-linecap="round"><rect x="${x - 9}" y="${y - 7}" width="18" height="15" rx="2"/><line x1="${x - 5}" y1="${y - 10}" x2="${x - 5}" y2="${y - 5}"/><line x1="${x + 5}" y1="${y - 10}" x2="${x + 5}" y2="${y - 5}"/><line x1="${x - 9}" y1="${y - 1}" x2="${x + 9}" y2="${y - 1}"/></g>`,
  chart: (x, y, col) => `<g stroke="${col}" stroke-width="2.4" fill="none" stroke-linecap="round"><line x1="${x - 8}" y1="${y + 8}" x2="${x - 8}" y2="${y - 2}"/><line x1="${x - 1.5}" y1="${y + 8}" x2="${x - 1.5}" y2="${y - 9}"/><line x1="${x + 5}" y1="${y + 8}" x2="${x + 5}" y2="${y}"/><line x1="${x - 10}" y1="${y + 8}" x2="${x + 10}" y2="${y + 8}"/></g>`,
  user: (x, y, col) => `<g stroke="${col}" stroke-width="2" fill="none" stroke-linecap="round"><circle cx="${x}" cy="${y - 4}" r="4.4"/><path d="M ${x - 8} ${y + 8} C ${x - 6} ${y + 1.5} ${x + 6} ${y + 1.5} ${x + 8} ${y + 8}"/></g>`,
};
function tabbar(y) {
  /* Réplique exacte du repère (design/repere-navigation.svg) : contenu natif posé centré en bas du mobile. */
  let inner = '';
  try {
    const raw = fs.readFileSync(new URL('../design/repere-navigation.svg', import.meta.url), 'utf8');
    inner = raw.replace(/^<\?xml[^>]*\?>\s*/, '').replace(/^<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '').trim();
  } catch (e) { inner = ''; }
  if (!inner) return '';
  const x = Math.round((390 - 371.373) / 2);
  return `<g id="tabbar-pastille" aria-label="Accueil · Saisie · Message · Relevé · Calendrier" transform="translate(${x} ${y})">${inner}</g>`;
}
function stat(x, y, w, val, key, kind) { const fg = { ok: C.ok, warn: C.warn, bad: C.bad }[kind]; return `<g id="stat-${esc(key)}">${rect(x, y, w, 56, { r: 2, fill: C.card, stroke: C.line })}${text(x + 12, y + 28, val, { size: 18, weight: 800, fill: fg || C.text })}${text(x + 12, y + 45, key, { size: 10.5, weight: 600, fill: C.muted })}</g>`; }
function inputBox(x, y, w, val, { disabled = false } = {}) {
  return `<g>${rect(x, y, w, 28, { r: 2, fill: disabled ? C.bgSoft : C.card, stroke: C.line })}${val !== '' ? text(x + w / 2, y + 18.5, val, { size: 12, weight: 700, anchor: 'middle' }) : ''}</g>`;
}
const statusLabel = { validee: ['Validée', 'ok'], non_validee: ['Non validée', 'bad'], rattrapage_a_passer: ['Rattrapage à passer', 'warn'], en_attente: ['En attente', 'gray'] };
const pubLabel = { published: ['Résultats publiés', 'info'], locked: ['Verrouillé', 'warn'], draft: ['Brouillon', 'gray'] };

/* ───────────────────────── données réelles (base) ───────────────────────── */
const template = await db.prepare('SELECT * FROM templates WHERE id=1').get();
const tree = await loadTemplateTree(1);
const rules = resolveRules(template);
const stud = await db.prepare('SELECT * FROM students WHERE id=1').get();
const ids = tree.flatMap((s) => s.units.flatMap((u) => u.courses.map((c) => c.id)));
const gmap = async (src) => { const m = new Map(); for (const g of await db.prepare(`SELECT course_id, normal, rattrapage FROM grades WHERE student_id=? AND source=? AND course_id IN (${ids.map(() => '?').join(',')})`).all(stud.id, src, ...ids)) m.set(g.course_id, g); return m; };
const personal = computeReleve(template, tree, await gmap('personal'));
const official = computeReleve(template, tree, await gmap('official'));
const pubs = {}; for (const s of tree) pubs[s.id] = (await db.prepare('SELECT status FROM publications WHERE semester_id=?').get(s.id))?.status || 'draft';
const counts = personal.counts;
const pct = Math.round((personal.creditsEarned / personal.creditsExpected) * 100);



/* ───────────────────────── écrans ───────────────────────── */
const screens = [];
function screen(name, w, h, body, id) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
<defs><linearGradient id="gbtn" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${C.ink}"/><stop offset=".55" stop-color="${C.ink}"/><stop offset="1.2" stop-color="${C.ink}"/></linearGradient></defs>
<rect width="${w}" height="${h}" fill="${C.bg}"/>
<g id="a-${id || name}">${body}</g></svg>`;
  screens.push({ name, w, h, svg });
}

/* 01 · Connexion (390) */
{
  let y = 60, b = topbar();
  b += `<g id="hero">${rect(20, y, 350, 118, { r: 2, fill: C.ink })}${rect(40, y + 20, 44, 44, { r: 8, fill: C.primary })}${text(62, y + 48, 'MR', { size: 16, weight: 800, fill: '#fff', anchor: 'middle' })}${text(40, y + 92, 'Bon retour ', { size: 21, weight: 800, fill: '#fff' })}${text(40, y + 112, 'Connectez-vous pour retrouver votre relevé de notes', { size: 11.5, fill: 'rgba(255,255,255,.8)' })}</g>`;
  y += 134;
  b += card(20, y, 350, 300, 'carte-connexion');
  b += field(40, y + 38, 310, 'ADRESSE E-MAIL', 'naina.randria@example.mg');
  b += field(40, y + 96, 310, 'MOT DE PASSE', '•••••••••');
  b += `<g id="forgot">${text(40, y + 150, 'Mot de passe oublié ?', { size: 11.5, weight: 600, fill: C.primary })}</g>`;
  b += btn(40, y + 164, 310, 44, 'Se connecter');
  b += `<g id="signup">${text(120, y + 235, 'Pas encore de compte ?', { size: 11.5, fill: C.muted })}${text(262, y + 235, 'Créer un compte', { size: 11.5, weight: 700, fill: C.primary })}</g>`;
  b += `<g id="demo-hint">${text(195, y + 276, 'Démo — étudiant : naina.randria@example.mg / etudiant123', { size: 9.5, fill: C.muted, anchor: 'middle' })}${text(195, y + 290, 'admin : admin@univ.mg / admin123', { size: 9.5, fill: C.muted, anchor: 'middle' })}</g>`;
  screen('01-connexion', 390, 520, b);
}

/* 03 · Accueil étudiant (390) */
{
  let y = 60, b = topbar();
  b += `<g id="hero-acc"><rect x="16" y="${y}" width="358" height="196" rx="2" fill="url(#gbtn)"/>
    ${chip(32, y + 16, 'Naina', 'white')}${chip(150, y + 16, 'L2 — Gestion — 2026-2027', 'white')}${text(32, y + 84, `${fmt(personal.generalAverage)}`, { size: 40, weight: 850, fill: '#fff' })}${text(32 + tw(fmt(personal.generalAverage), 40, 850) + 6, y + 84, '/20', { size: 16, weight: 600, fill: 'rgba(255,255,255,.8)' })}
    ${text(32, y + 104, 'Moyenne générale personnelle · officielle : ' + fmt(official.generalAverage), { size: 11, fill: 'rgba(255,255,255,.78)' })}
    ${rect(32, y + 125, 326, 2, { r: 0, fill: 'rgba(242,233,216,0)' })}${rect(32, y + 125, Math.max(30, 326 * pct / 100), 2, { r: 0, fill: C.primary })}
    ${text(32, y + 148, `Crédits obtenus : ${fmt(personal.creditsEarned, 0)} / ${fmt(personal.creditsExpected, 0)} ECTS`, { size: 11, weight: 700, fill: '#fff' })}
    ${text(32, y + 176, `(${pct} % de l'année validée)`, { size: 10.5, fill: 'rgba(255,255,255,.75)' })}</g>`;
  y += 210;
  b += `<g id="stats-acc">${stat(16, y, 83, String(counts.validees), 'Validées', 'ok')}${stat(107, y, 83, String(counts.non_validees), 'Non validées', counts.non_validees ? 'bad' : undefined)}${stat(198, y, 83, String(counts.rattrapage), 'Rattrapages', counts.rattrapage ? 'warn' : undefined)}${stat(289, y, 83, String(counts.en_attente), 'En attente')}</g>`;
  y += 70;
  b += `<g id="quick-actions">${btn(16, y, 112, 36, 'Saisir mes notes', { size: 11.5 })}${btn(134, y, 108, 36, 'Mon relevé', { variant: 'ghost', size: 11.5 })}${btn(248, y, 126, 36, 'Exporter PDF · 1 page', { variant: 'ghost', size: 11.5 })}</g>`;
  y += 54;
  b += `${text(16, y + 4, 'Semestres', { size: 13, weight: 800 })}${text(374, y + 4, 'Gestion', { size: 10, fill: C.muted, anchor: 'end' })}`; y += 14;
  for (const s of personal.semesters) {
    const [plab, pkind] = pubLabel[pubs[s.id]];
    b += `<g id="semestre-S${s.number}">${rect(16, y, 358, 58, { r: 2, fill: C.card, stroke: C.line })}${rect(28, y + 13, 32, 32, { r: 2, fill: C.primarySoft, stroke: C.line })}${text(44, y + 34, String(s.number), { size: 13, weight: 800, fill: C.primary, anchor: 'middle' })}${text(70, y + 26, fit(s.name, 170), { size: 12.5, weight: 700 })}${text(70, y + 43, `${s.units.length} UE · ${s.units.reduce((a, x) => a + x.courses.length, 0)} matières · crédits ${fmt(s.creditsEarned, 0)}/${fmt(s.ectsExpected, 0)}`, { size: 10, fill: C.muted })}${text(360, y + 25, `${fmt(s.average)}/20`, { size: 13, weight: 800, anchor: 'end' })}${chip(360 - chipW(plab, true), y + 32, plab, pkind, { small: true })}</g>`;
    y += 66;
  }
  b += tabbar(y + 8);
  screen('03-accueil-etudiant', 390, y + 8 + 66 + 16, b);
}

/* 04 · Saisie (390) */
{
  let y = 60, b = topbar();
  const cur = personal.semesters[0];
  b += `${text(16, y + 6, 'Saisie de notes — S' + cur.number, { size: 15, weight: 800 })}${text(16, y + 22, 'Calcul en direct comme dans Excel — enregistré puis revérifié par le serveur', { size: 9.5, fill: C.muted })}`;
  y += 32;
  b += `<g id="live-stats">${stat(16, y, 174, fmt(cur.average) + '/20', 'Moyenne du semestre (en direct)')}${stat(200, y, 174, fmt(personal.generalAverage) + '/20', 'Moyenne générale (en direct)')}</g>`;
  y += 64;
  b += `<g id="onglets-semestres">${personal.semesters.map((s, i) => chip(16 + (i === 0 ? 0 : chipW(`S${personal.semesters[0].number} · ${fmt(personal.semesters[0].average)}`, true) + 8), y, `S${s.number} · ${fmt(s.average)}`, i === 0 ? 'violet' : 'gray', { small: true })).join('')}</g>`;
  y += 28;
  const cardTop = y;
  const COL = { x0: 16, name: 150, coef: 26, cred: 30, n: 54, r: 54, def: 60, rowH: 31, headH: 22 };
  const colX = (i) => COL.x0 + 10 + [0, COL.name, COL.name + COL.coef, COL.name + COL.coef + COL.cred, COL.name + COL.coef + COL.cred + COL.n, COL.name + COL.coef + COL.cred + COL.n + COL.r, COL.name + COL.coef + COL.cred + COL.n + COL.r + COL.def][i];
  let cy = y + COL.headH;
  let grid = `${rect(COL.x0, y, 358, COL.headH, { fill: C.card2 })}${text(COL.x0 + 10, y + 15, 'MATIÈRE', { size: 9, weight: 700, fill: C.muted })}${text(colX(1) + COL.coef, y + 15, 'COEF', { size: 8.5, weight: 700, fill: C.muted, anchor: 'end' })}${text(colX(2) + COL.cred, y + 15, 'CRÉD.', { size: 8.5, weight: 700, fill: C.muted, anchor: 'end' })}${text(colX(3) + COL.n, y + 15, 'NORMALE', { size: 8.5, weight: 700, fill: C.muted, anchor: 'end' })}${text(colX(4) + COL.r, y + 15, 'RATTR.', { size: 8.5, weight: 700, fill: C.muted, anchor: 'end' })}${text(366, y + 15, 'DÉF.', { size: 8.5, weight: 700, fill: C.muted, anchor: 'end' })}`;
  for (const u of cur.units) {
    grid += `${rect(COL.x0, cy, 358, 24, { fill: C.bgSoft })}${text(COL.x0 + 10, cy + 16, fit(`${u.code} — ${u.name}`, 200), { size: 10.5, weight: 800 })}${text(COL.x0 + 348, cy + 16, `moyenne : ${fmt(u.average)}/20`, { size: 10, weight: 700, fill: C.muted, anchor: 'end' })}`;
    cy += 24;
    for (const c of u.courses) {
      grid += `${line(COL.x0 + 6, cy + COL.rowH - 1, COL.x0 + 352, cy + COL.rowH - 1)}${text(COL.x0 + 10, cy + 20, fit(c.name, COL.name - 14), { size: 11, weight: 500 })}${text(colX(1) + COL.coef, cy + 20, fmt(c.coefficient, 0), { size: 11, anchor: 'end' })}${text(colX(2) + COL.cred, cy + 20, fmt(c.credits, 0), { size: 11, anchor: 'end' })}${inputBox(colX(3), cy + 2, COL.n, c.normal != null ? String(c.normal) : '')}${inputBox(colX(4), cy + 2, COL.r, c.rattrapage != null ? String(c.rattrapage) : '')}${text(366, cy + 20, fmt(c.definitive), { size: 11.5, weight: 800, anchor: 'end' })}`;
      cy += COL.rowH;
    }
  }
  b += `<g id="carte-grille-saisie">${rect(COL.x0, cardTop, 358, cy - cardTop + 6, { r: 2, fill: C.card, stroke: C.line })}${grid}</g>`;
  b += btn(16, cy + 16, 358, 42, 'Enregistrer le semestre');
  b += tabbar(cy + 74);
  screen('04-saisie-etudiant', 390, cy + 74 + 66 + 16, b);
}

/* 05 · Relevé (390) */
{
  let y = 60, b = topbar();
  b += `${text(16, y + 6, 'Relevé de notes', { size: 15, weight: 800 })}<g id="segments">${rect(238, y - 8, 136, 30, { r: 999, fill: C.bgSoft, stroke: C.line })}${rect(241, y - 5, 64, 24, { r: 999, fill: C.ink })}${text(273, y + 12, 'Mes notes', { size: 11, weight: 600, fill: '#F2E9D8', anchor: 'middle' })}${text(341, y + 12, 'Officiel', { size: 11, weight: 600, fill: C.muted, anchor: 'middle' })}</g>`;
  y += 34;
  for (const s of personal.semesters) {
    const [plab, pkind] = pubLabel[pubs[s.id]];
    b += `<g id="releve-S${s.number}">${text(16, y + 8, `S${s.number} — ${s.name}`, { size: 12.5, weight: 800 })}${chip(374 - chipW(plab, true), y - 6, plab, pkind, { small: true })}</g>`;
    y += 20;
    const th = rect(16, y, 358, 22, { fill: C.card2 }) + `${text(26, y + 15, 'MATIÈRE', { size: 9, weight: 700, fill: C.muted })}${text(170, y + 15, 'DÉF.', { size: 9, weight: 700, fill: C.muted, anchor: 'end' })}${text(210, y + 15, 'COEF', { size: 9, weight: 700, fill: C.muted, anchor: 'end' })}${text(255, y + 15, 'CRÉDITS', { size: 9, weight: 700, fill: C.muted, anchor: 'end' })}${text(368, y + 15, 'STATUT', { size: 9, weight: 700, fill: C.muted, anchor: 'end' })}`;
    let cy = y + 22;
    let rows = '';
    for (const u of s.units.slice(0, 2)) {
      rows += rect(16, cy, 358, 22, { fill: C.bgSoft }) + text(26, cy + 15, `${u.code} — ${u.name} · moyenne ${fmt(u.average)}/20`, { size: 10.5, weight: 800 }); cy += 22;
      for (const c of u.courses.slice(0, 3)) {
        const [lab, kind] = statusLabel[c.status];
        rows += `${line(16, cy + 26, 374, cy + 26)}${text(26, cy + 16, fit(c.name, 130), { size: 11, weight: 500 })}${text(170, cy + 16, fmt(c.definitive), { size: 11.5, weight: 800, anchor: 'end' })}${text(210, cy + 16, fmt(c.coefficient, 0), { size: 11, anchor: 'end' })}${text(255, cy + 16, `${fmt(c.creditsEarned, 0)}/${fmt(c.credits, 0)}`, { size: 11, anchor: 'end' })}` + chip(374 - chipW(lab, true) - 8, cy + 3, lab, kind, { small: true });
        cy += 27;
      }
    }
    rows += `${rect(16, cy, 358, 26, { fill: C.card2 })}${text(26, cy + 17, 'Moyenne du semestre', { size: 11, weight: 800 })}${text(368, cy + 17, `${fmt(s.average)} · crédits ${fmt(s.creditsEarned, 0)}/${fmt(s.ectsExpected, 0)}`, { size: 11, weight: 800, fill: C.primary, anchor: 'end' })}`;
    b += `<g id="table-S${s.number}">${rect(16, y, 358, cy + 26 - y, { r: 2, fill: C.card, stroke: C.line })}${th}${rows}</g>`;
    y = cy + 44;
  }
  b += `<g id="total">${rect(16, y, 358, 74, { r: 2, fill: C.card, stroke: C.line })}${text(195, y + 22, 'MOYENNE GÉNÉRALE (mes notes)', { size: 10, weight: 700, fill: C.muted, anchor: 'middle' })}${text(195, y + 52, fmt(personal.generalAverage) + '/20', { size: 26, weight: 850, anchor: 'middle' })}${text(195, y + 68, `Crédits : ${fmt(personal.creditsEarned, 0)} / ${fmt(personal.creditsExpected, 0)} ECTS`, { size: 10.5, fill: C.muted, anchor: 'middle' })}</g>`;
  y += 90;
  b += `${text(16, y + 14, 'MOYENNES & PROGRESSION', { size: 9.5, weight: 700, fill: C.muted })}`; y += 24;
  b += `<g id="progression">${stat(16, y, 110, fmt(personal.generalAverage), 'Moyenne générale')}${stat(134, y, 110, fmt(personal.creditsEarned, 0), 'Crédits obtenus', 'ok')}${stat(252, y, 122, fmt(personal.creditsRemaining, 0), 'Crédits restants', 'warn')}</g>`; y += 68;
  b += tabbar(y);
  screen('05-releve', 390, y + 66 + 16, b);
}

/* 07 · Calendrier (390) — emploi du temps de la classe */
{
  let y = 60, b = topbar();
  b += `${text(16, y + 6, 'Calendrier — Semestre 3', { size: 15, weight: 800 })}`; y += 24;
  b += `<g id="chips-semestre">${rect(16, y, 56, 24, { r: 999, fill: C.primarySoft, stroke: C.line })}${text(44, y + 16, 'S3', { size: 11, weight: 700, fill: C.primary, anchor: 'middle' })}${rect(78, y, 56, 24, { r: 999, fill: C.card, stroke: C.line })}${text(106, y + 16, 'S4', { size: 11, weight: 600, fill: C.muted, anchor: 'middle' })}</g>`; y += 34;
  const DAYS = ['Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi'];
  const slotsQ = await db.prepare(`SELECT sl.day, sl.start, sl.end, sl.room, c.name FROM schedule_slots sl LEFT JOIN courses c ON c.id = sl.course_id WHERE sl.semester_id = (SELECT id FROM semesters WHERE template_id = 1 AND number = 3) AND sl.class_id = (SELECT MIN(class_id) FROM students) ORDER BY sl.day, sl.start`).all();
  const byDay = {};
  for (const r of slotsQ) (byDay[r.day] ||= []).push(r);
  for (let d = 1; d <= 5; d++) {
    const list = (byDay[d] || []).slice(0, 2);
    if (!list.length) continue;
    const hh = 26 + list.length * 34;
    b += `<g id="cal-j${d}">${rect(16, y, 358, hh, { r: 2, fill: C.card, stroke: C.line })}${rect(16, y, 358, 24, { r: 2, fill: C.card2 })}${line(16, y + 24, 374, y + 24)}${text(26, y + 16, DAYS[d - 1].toUpperCase(), { size: 9.5, weight: 700, fill: C.muted })}`;
    let sy = y + 30;
    for (const sl of list) {
      b += `${text(26, sy + 17, `${sl.start}–${sl.end}`, { size: 10.5, weight: 800, fill: C.primary })}${text(118, sy + 17, fit(sl.name || 'Cours', 170), { size: 11, weight: 500 })}${text(368, sy + 17, sl.room || '', { size: 10, fill: C.muted, anchor: 'end' })}`;
      sy += 34;
    }
    b += `</g>`;
    y += hh + 8;
  }
  y += 6;
  b += tabbar(y);
  screen('07-calendrier-etudiant', 390, y + 66 + 16, b);
}

/* 10 · Admin — tableau de bord (1280) */
function adminChrome(title, extra = '') {
  const tabs = [['Tableau de bord', true], ['Étudiants'], ['Modèles'], ['Import Excel'], ['Référentiels']];
  let b = `<g id="topbar-admin">${rect(0, 0, 1280, 56, { fill: C.card })}${text(24, 34, 'MR', { size: 13, weight: 800, fill: '#fff', anchor: 'middle' })}${rect(10, 12, 32, 32, { r: 6, fill: C.primary })}${text(26, 33, 'MR', { size: 12.5, weight: 800, fill: '#fff', anchor: 'middle' })}${text(52, 33, 'MonRelevé', { size: 14.5, weight: 800 })}${chip(140, 17, 'Admin', 'violet')}${text(1150, 33, 'Espace administrateur', { size: 11, fill: C.muted })}${text(1230, 33, '', { size: 14 })}${text(1258, 33, '⎋', { size: 15 })}</g>`;
  b += `<g id="nav-admin">${rect(0, 56, 1280, 44, { fill: C.card2 })}${tabs.map(([l, on], i) => { const x = 24 + i * (chipW(l) + 10); return ''; }).join('')}`;
  let x = 24; for (const [l, on] of tabs) { b += chip(x, 68, l, on ? 'violet' : 'gray'); x += chipW(l) + 10; }
  b += '</g>';
  b += `<g id="titre-admin">${text(24, 132, title, { size: 16, weight: 800 })}${extra}</g>`;
  return b;
}
{
  let b = adminChrome('Tableau de bord');
  const st4 = [['Étudiants', 2], ['Comptes', (await db.prepare('SELECT COUNT(*) n FROM users').get()).n], ['Modèles de relevés', (await db.prepare('SELECT COUNT(*) n FROM templates').get()).n], ['Semestres publiés', (await db.prepare("SELECT COUNT(*) n FROM publications WHERE status IN ('published','locked')").get()).n]];
  b += `<g id="kpi-admin">${st4.map(([k, v], i) => `<g>${rect(24 + i * 313, 150, 301, 76, { r: 2, fill: C.card, stroke: C.line })}${text(44 + i * 313, 186, String(v), { size: 24, weight: 850 })}${text(44 + i * 313, 208, k, { size: 11, weight: 600, fill: C.muted })}</g>`).join('')}</g>`;
  b += `<g id="actions-admin">${btn(24, 242, 190, 40, 'Gérer les étudiants', { size: 12 })}${btn(224, 242, 186, 40, 'Importer un Excel', { size: 12 })}${btn(420, 242, 168, 40, 'Modèles & règles', { variant: 'ghost', size: 12 })}${btn(598, 242, 158, 40, 'Référentiels', { variant: 'ghost', size: 12 })}</g>`;
  b += card(24, 300, 620, 260, 'derniers-inscrits');
  b += text(44, 328, 'Derniers inscrits', { size: 12, weight: 800 });
  const recents = await db.prepare(`SELECT u.last_name, u.first_name, s.matricule, p.name AS program FROM students s JOIN users u ON u.id=s.user_id LEFT JOIN programs p ON p.id=s.program_id ORDER BY s.created_at DESC, s.id DESC LIMIT 5`).all();
  recents.forEach((s, i) => {
    const y = 342 + i * 42;
    b += `${rect(44, y, 580, 36, { r: 2, fill: C.card2 })}${text(58, y + 23, `${s.last_name} ${s.first_name}`, { size: 12, weight: 700 })}${text(612, y + 23, `${s.program || '—'} · ${s.matricule}`, { size: 10.5, fill: C.muted, anchor: 'end' })}`;
  });
  b += card(664, 300, 592, 260, 'par-filiere');
  b += text(684, 328, 'Répartition par filière', { size: 12, weight: 800 });
  const byp = await db.prepare('SELECT p.name, COUNT(s.id) n FROM students s JOIN programs p ON p.id=s.program_id GROUP BY p.id ORDER BY n DESC').all();
  let cx = 684; for (const p of byp) { const lab = `${p.name} · ${p.n}`; b += chip(cx, 344, lab, 'violet'); cx += chipW(lab) + 8; }
  screen('10-admin-tableau-de-bord', 1280, 620, b);
}

/* 11 · Admin — étudiants (1280) */
{
  let b = adminChrome('Étudiants', `<text x="140" y="132" ${F(11, 500)} fill="${C.muted}">recherche + création</text>`);
  b += `<g id="recherche">${rect(24, 150, 1232, 52, { r: 2, fill: C.card, stroke: C.line })}${rect(44, 160, 700, 32, { r: 10, fill: C.bgSoft, stroke: C.line })}${text(58, 181, 'Rechercher nom, e-mail, matricule…', { size: 11.5, fill: C.muted })}${btn(760, 160, 92, 32, 'Chercher', { variant: 'ghost', size: 11.5 })}</g>`;
  const rows = await db.prepare(`SELECT u.last_name, u.first_name, u.email, s.matricule, p.name AS program, l.name AS level, u.is_active FROM students s JOIN users u ON u.id=s.user_id LEFT JOIN programs p ON p.id=s.program_id LEFT JOIN levels l ON l.id=s.level_id ORDER BY u.last_name LIMIT 4`).all();
  let y = 218;
  b += `<g id="table-etudiants">${rect(24, y, 1232, 40, { r: 12, fill: C.card2 })}${['NOM', 'MATRICULE', 'FILIÈRE', 'NIVEAU', 'COMPTE'].map((h, i) => text(44 + [0, 340, 520, 720, 880][i], y + 26, h, { size: 9.5, weight: 700, fill: C.muted })).join('')}</g>`;
  y += 40;
  rows.forEach((s, ri) => {
    b += `${line(44, y + 46, 1236, y + 46)}${text(44, y + 22, `${s.last_name} ${s.first_name}`, { size: 12.5, weight: 700, fill: C.primary })}${text(44, y + 38, s.email, { size: 10.5, fill: C.muted })}${text(340, y + 28, s.matricule, { size: 12 })}${text(520, y + 28, s.program || '—', { size: 12 })}${text(720, y + 28, s.level || '—', { size: 12 })}${chip(880, y + 14, s.is_active ? 'Actif' : 'Désactivé', s.is_active ? 'ok' : 'bad', { small: true })}${`<g>${rect(1160, y + 8, 76, 30, { r: 999, fill: C.primarySoft })}${text(1198, y + 28, 'Ouvrir', { size: 11, weight: 700, fill: C.primary, anchor: 'middle' })}</g>`}`;
    y += 48;
  });
  b += `<g id="creer-etudiant">${rect(24, y + 12, 1232, 150, { r: 2, fill: C.card, stroke: C.line })}${text(44, y + 40, 'Créer un étudiant', { size: 12.5, weight: 800 })}${field(44, y + 58, 186, 'NOM *', '')}${field(242, y + 58, 186, 'PRÉNOM *', '')}${field(440, y + 58, 186, 'MATRICULE *', '')}${field(638, y + 58, 240, 'E-MAIL *', '')}${field(890, y + 58, 200, 'MOT DE PASSE INITIAL', 'etudiant123 (vide = auto)')}${field(44, y + 112, 220, 'FILIÈRE', 'Gestion', { select: true })}${field(276, y + 112, 160, 'NIVEAU', 'L2', { select: true })}${btn(460, y + 108, 130, 38, 'Créer le compte', { size: 11.5 })}</g>`;
  screen('11-admin-etudiants', 1280, y + 190, b);
}

/* 12 · Admin — fiche étudiant (1280) */
{
  let b = adminChrome(`Étudiant — ${'Randria Naina'}`);
  const [plab, pkind] = pubLabel[pubs[tree[0].id]];
  b += `<g id="entete-fiche">${chip(300, 118, 'L2 — Gestion — 2026-2027', 'violet')}${chip(560, 118, 'Actif', 'ok')}</g>`;
  b += `<g id="kpi-fiche">${stat(24, 150, 240, fmt(official.generalAverage), 'Moyenne officielle')}${stat(280, 150, 240, `${fmt(official.creditsEarned, 0)} / ${fmt(official.creditsExpected, 0)}`, 'Crédits (officiels)', 'ok')}${stat(536, 150, 240, fmt(personal.generalAverage), 'Moyenne perso (brouillon)')}</g>`;
  b += `<g id="exports-fiche">${btn(820, 158, 210, 36, 'Relevé officiel (PDF)', { variant: 'ghost', size: 11 })}${btn(1040, 158, 216, 36, 'Relevé perso (PDF)', { variant: 'ghost', size: 11 })}</g>`;
  b += `<g id="fiche-collapse">${rect(24, 210, 1232, 44, { r: 2, fill: C.card, stroke: C.line })}${text(44, 237, 'Modifier la fiche (scolarité, contact, mot de passe)', { size: 12, weight: 700 })}${text(1236, 237, '⌄', { size: 14, fill: C.muted, anchor: 'end' })}</g>`;
  let y = 288;
  for (const s of official.semesters) {
    const locked = pubs[s.id] === 'locked';
    b += `<g id="notes-S${s.number}">${text(24, y + 8, `S${s.number} — ${s.name}`, { size: 13, weight: 800 })}${text(200, y + 8, `moyenne en direct : ${fmt(s.average)}/20`, { size: 10.5, fill: C.muted })}${chip(380, y - 6, pubLabel[pubs[s.id]][0], pubLabel[pubs[s.id]][1], { small: true })}</g>`;
    y += 20;
    b += rect(24, y, 1232, 34 * Math.min(3, s.units[0].courses.length) + 26 + 8, { r: 2, fill: C.card, stroke: C.line });
    const u0 = s.units[0];
    let cy = y + 26;
    b += `${rect(24, y + 4, 1232, 22, { fill: C.bgSoft })}${text(40, y + 19, `${u0.code} — ${u0.name} · ${fmt(u0.average)}/20`, { size: 11, weight: 800 })}${text(1240, y + 19, 'MOYENNE UE', { size: 9, weight: 700, fill: C.muted, anchor: 'end' })}`;
    for (const c of u0.courses.slice(0, 3)) {
      b += `${text(40, cy + 24, fit(c.name, 500), { size: 12, weight: 500 })}${inputBox(600, cy + 6, 90, c.normal != null ? String(c.normal) : '', { disabled: locked })}${inputBox(704, cy + 6, 90, c.rattrapage != null ? String(c.rattrapage) : '', { disabled: locked })}${text(840, cy + 24, fmt(c.definitive), { size: 12.5, weight: 800 })}${chip(920, cy + 8, statusLabel[c.status][0], statusLabel[c.status][1], { small: true })}`;
      cy += 34;
    }
    b += btn(40, cy + 6, 220, 34, 'Enregistrer (source officielle)', { size: 11.5 });
    y = cy + 52;
  }
  screen('12-admin-fiche-etudiant', 1280, y + 20, b);
}

/* 13 · Admin — éditeur de modèle + règles (1280) */
{
  let b = adminChrome('Modèle — L2 — Gestion — 2026-2027');
  b += `<g id="select-filiere">${chip(560, 118, 'Gestion', 'violet')}${chip(660, 118, 'L2', 'gray')}${chip(716, 118, '2026-2027', 'gray')}${btn(1090, 112, 166, 32, 'CSV structure', { variant: 'ghost', size: 11 })}</g>`;
  b += `<g id="reglages-cadre">${rect(24, 150, 1232, 190, { r: 2, fill: C.card, stroke: C.line })}${text(44, 178, 'Règles de calcul — tout est configurable, rien n’est codé en dur', { size: 12, weight: 800 })}${field(44, 192, 224, 'NOTE DÉFINITIVE', 'max(normale, rattrapage)', { select: true })}${field(280, 192, 224, 'MOYENNE D’UE', 'simple', { select: true })}${field(516, 192, 240, 'MOYENNE DE SEMESTRE', 'moyenne des UE', { select: true })}${field(768, 192, 230, 'MOYENNE GÉNÉRALE', 'moyenne des semestres', { select: true })}${field(1010, 192, 226, 'PLAFOND RATTRAPAGE', 'aucun')}${field(44, 248, 224, 'CRÉDITS SI', 'note normale ≥ seuil', { select: true })}${field(280, 248, 110, 'SEUIL', '10')}${btn(410, 252, 168, 34, 'Enregistrer les règles', { size: 11.5 })}${text(44, 322, 'Ces valeurs proviennent des formules du « Relevé de notes.xlsx » fourni (max(N,R), IF(note>=10…)).', { size: 10, fill: C.muted })}</g>`;
  let y = 360;
  for (const s of personal.semesters) {
    b += `<g id="sem-card-S${s.number}">${rect(24, y, 1232, 118, { r: 2, fill: C.card, stroke: C.line })}${text(44, y + 28, `Semestre ${s.number} — ${s.name}`, { size: 13, weight: 800 })}${chip(420, y + 12, pubLabel[pubs[s.id]][0], pubLabel[pubs[s.id]][1], { small: true })}${text(1236, y + 28, `${s.units.reduce((a, u) => a + u.courses.length, 0)} matières`, { size: 10.5, fill: C.muted, anchor: 'end' })}${field(44, y + 40, 64, 'N°', String(s.number))}${field(120, y + 40, 280, 'NOM', s.name)}${field(412, y + 40, 76, 'ECTS', String(s.ects_expected))}${field(500, y + 40, 190, 'ACTION PUBLICATION', 'Publier les résultats', { select: true })}${btn(702, y + 56, 96, 34, 'Enregistrer', { size: 11 })}${btn(808, y + 56, 130, 34, 'Appliquer pub.', { variant: 'ghost', size: 11 })}${btn(948, y + 56, 130, 34, 'Supprimer semestre', { variant: 'danger', size: 11 })}${text(44, y + 104, `↳ ${s.units.length} UE (UE9, UE10…) — matières éditables en place : nom, coefficient, crédits`, { size: 10.5, fill: C.muted })}</g>`;
    y += 130;
    if (s.number === 3) {
      const u = tree[0].units[0];
      b += `<g id="ue-detail">${rect(60, y, 1196, 40 + u.courses.length * 34, { r: 2, fill: C.card, stroke: C.line })}${text(76, y + 26, `${u.code} — ${u.name}`, { size: 11.5, weight: 800 })}${text(1240, y + 26, '✕ supprimer l’UE', { size: 10, fill: C.bad, anchor: 'end' })}`;
      let cy = y + 38;
      for (const c of u.courses) { b += `${line(76, cy + 30, 1240, cy + 30)}${inputBox(76, cy + 4, 420, c.name)}${text(560, cy + 22, 'COEF.', { size: 9, weight: 700, fill: C.muted })}${inputBox(610, cy + 4, 60, String(c.coefficient))}${text(720, cy + 22, 'CRÉDITS', { size: 9, weight: 700, fill: C.muted })}${inputBox(780, cy + 4, 60, String(c.credits))}${btn(880, cy + 4, 34, 26, '✓', { size: 11 })}<g>${rect(924, cy + 4, 34, 26, { r: 999, fill: C.badBg })}${text(941, cy + 21, '✕', { size: 11, weight: 700, fill: C.bad, anchor: 'middle' })}</g>`; cy += 34; }
      b += `${field(76, cy + 8, 300, '', 'nouvelle matière…')}${inputBox(396, cy + 30, 50, '1')}${inputBox(454, cy + 30, 50, '2')}${btn(520, cy + 28, 100, 26, '＋ matière', { size: 10.5 })}</g>`;
      y += 40 + u.courses.length * 34 + 52;
    }
  }
  b += `<g id="zone-danger">${rect(24, y, 1232, 56, { r: 14, fill: C.badBg })}${text(44, y + 24, 'Zone de danger', { size: 11.5, weight: 800, fill: C.bad })}${text(44, y + 41, 'Supprimer le modèle et toute sa structure (les notes des étudiants restent)', { size: 10.5, fill: C.bad })}${btn(1080, y + 12, 152, 32, 'Supprimer', { variant: 'danger', size: 11 })}</g>`;
  screen('13-admin-editeur-modele', 1280, y + 90, b);
}

/* 14 · Admin — import (1280) */
{
  let b = adminChrome('Import Excel');
  b += `${text(24, 150, 'Aperçu systématique avant toute écriture · un import n’écrase jamais rien sans confirmation explicite.', { size: 11, fill: C.muted })}`;
  b += `<g id="upload">${rect(24, 164, 1232, 74, { r: 2, fill: C.card, stroke: C.line })}${rect(44, 184, 640, 34, { r: 10, fill: C.bgSoft, stroke: C.line })}${text(58, 206, ' Relevé-de-notes.xlsx', { size: 12, weight: 600 })}${btn(1120, 184, 116, 34, 'recommencer', { variant: 'ghost', size: 11 })}</g>`;
  b += `<g id="parametres">${rect(24, 248, 1232, 120, { r: 2, fill: C.card, stroke: C.line })}${field(44, 268, 240, 'FEUILLE', 'Feuil2 · 64 lignes', { select: true })}${field(300, 268, 300, 'MODE', 'Structure du relevé (semestres / UE / matières)', { select: true })}${field(616, 268, 240, 'MODÈLE CIBLE', 'L2 — Gestion — 2026-2027', { select: true })}${btn(880, 264, 160, 40, 'Analyser', { size: 11.5 })}</g>`;
  b += `<g id="apercu">${rect(24, 378, 1232, 268, { r: 2, fill: C.card, stroke: C.line })}${text(44, 404, 'Aperçu de l’analyse — aucune écriture', { size: 12, weight: 800 })}${chip(320, 390, '2 semestre(s), 7 UE, 29 matière(s) détectés', 'ok', { small: true })}${rect(44, 418, 1192, 26, { r: 2, fill: C.warnBg })}${text(58, 436, 'Le modèle cible contient déjà 2 semestre(s) : l’import les remplacera (notes conservées si les matières correspondent).', { size: 11, weight: 600, fill: C.warn })}`;
  const th = `${['SEMESTRE', 'UE', 'MATIÈRE', 'COEF.', 'CRÉDITS'].map((h, i) => text(58 + [0, 110, 190, 700, 820][i], 466, h, { size: 9, weight: 700, fill: C.muted })).join('')}`;
  let yy = 474; const samples = personal.semesters[0].units[0].courses.slice(0, 3);
  for (const c of samples) { b += `${text(58, yy, 'S3', { size: 11 })}${text(110, yy, 'UE9', { size: 11 })}${text(190, yy, fit(c.name, 480), { size: 11 })}${text(720, yy, String(c.coefficient), { size: 11 })}${text(840, yy, String(c.credits), { size: 11 })}`; yy += 24; }
  b += text(58, yy + 4, '… 26 lignes supplémentaires', { size: 10, fill: C.muted });
  b += `${rect(44, 522, 1192, 44, { r: 2, fill: C.bgSoft })}${text(58, 540, 'En cas de conflit :', { size: 10.5, weight: 700 })}${text(160, 540, 'ignorer les lignes existantes ▾', { size: 10.5, fill: C.primary, weight: 700 })}${text(58, 558, 'Je confirme l’écriture en base', { size: 10.5, weight: 600, fill: C.bad })}${btn(1060, 528, 160, 32, 'Importer maintenant', { size: 10.5 })}</g>`;
  b += `<g id="journal">${rect(24, 656, 1232, 120, { r: 2, fill: C.card, stroke: C.line })}${text(44, 682, 'Journal des imports', { size: 11.5, weight: 800 })}${line(44, 694, 1236, 694)}${text(44, 716, '2026-09-18 · admin@univ.mg · Structure importée dans le modèle #1 : 2 semestre(s)', { size: 10.5, fill: C.muted })}${text(44, 738, '2026-09-18 · admin@univ.mg · Import official : 0 écritures, 0 ignorées, 29 sans correspondance', { size: 10.5, fill: C.muted })}</g>`;
  screen('14-admin-import', 1280, 796, b);
}

/* 15 · Admin — référentiels (1280) */
{
  let b = adminChrome('Référentiels');
  let y = 150;
  const ref = (title, heads, rows, { current = false } = {}) => {
    let html = `<g id="ref-${esc(title)}">${text(24, y + 12, title, { size: 12, weight: 800 })}${rect(24, y + 22, 1232, 30 + rows.length * 40, { r: 2, fill: C.card, stroke: C.line })}`;
    rows.forEach((row, i) => {
      const yy = y + 30 + i * 40;
      html += `${line(40, yy + 36, 1240, yy + 36)}${row.map((cell, j) => (typeof cell === 'string' ? inputBox(44 + j * 260, yy + 6, 240, cell) : cell(yy))).join('')}${`<g>${rect(1120, yy + 6, 50, 26, { r: 999, fill: C.primarySoft })}${text(1145, yy + 23, '✓', { size: 11, weight: 700, fill: C.primary, anchor: 'middle' })}</g>`}${`<g>${rect(1178, yy + 6, 34, 26, { r: 999, fill: C.badBg })}${text(1195, yy + 23, '✕', { size: 11, weight: 700, fill: C.bad, anchor: 'middle' })}</g>`}` + (current && i === 0 ? `<g>${rect(940, yy + 6, 168, 26, { r: 9, fill: C.bgSoft, stroke: C.line })}${text(1024, yy + 23, '✓ année courante', { size: 10.5, weight: 700, fill: C.muted, anchor: 'middle' })}</g>` : current ? `<g>${rect(940, yy + 6, 168, 26, { r: 12, fill: 'none' })}</g>` : '');
    });
    html += `${field(44, y + rows.length * 40 + 42, 240, '', 'nouvelle ligne…')}${btn(300, y + rows.length * 40 + 62, 100, 26, '＋ Ajouter', { variant: 'ghost', size: 10.5 })}</g>`;
    y += 30 + rows.length * 40 + 80;
    return html;
  };
  b += ref('Années universitaires', [], [['2026-2027'], ['2025-2026']], { current: true });
  b += ref('Filières', [], [['Gestion'], ['Droit'], ['Économie']], {});
  b += ref('Niveaux', [], [['L2', 'Licence', '2'], ['L1', 'Licence', '1']], {});
  screen('15-admin-referentiels', 1280, y + 10, b);
}

/* ───────────────────────── fichiers + planche complète ───────────────────────── */
for (const s of screens) fs.writeFileSync(path.join(OUT, `monreleve-${s.name}.svg`), s.svg);

const gap = 56, labelH = 30;
const cols = [];
let curRow = [], curY = labelH, maxRowH = 0, curX = gap, totalW = gap, totalH = labelH;
const placed = [];
// disposition : mobile 390 en colonne de gauche (rangée 1), admin en grand à droite
let x = gap, y = labelH, rowH = 0;
for (const s of screens) {
  if (x + s.w + gap > 2 * (screens.find((q) => q.w > 500)?.w || 1280) + gap * 4 && x > gap) { x = gap; y += rowH + gap * 2 + labelH; rowH = 0; }
  placed.push({ ...s, x, y });
  x += s.w + gap; rowH = Math.max(rowH, s.h); totalW = Math.max(totalW, x); totalH = y + rowH;
}
const sheet = `<svg xmlns="http://www.w3.org/2000/svg" width="${totalW}" height="${totalH + 40}" viewBox="0 0 ${totalW} ${totalH + 40}">
<rect width="${totalW}" height="${totalH + 40}" fill="#FBF7EE"/>
${placed.map((s) => {
  const inner = s.svg.replace(/^<svg[^>]*>/, '').replace(/<\/svg>$/, '').replace('<defs>', `<defs><linearGradient id="gbn-${s.name}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${C.primary}"/><stop offset=".55" stop-color="${C.primary2}"/></linearGradient></defs><defs>`);
  return `<g id="${s.name}">${text(s.x, s.y - 10, `${s.name} — ${s.w}×${s.h}`, { size: 14, weight: 800 })}${rect(s.x, s.y, s.w, s.h, { r: 22, fill: C.bg, stroke: '#FBF7EE' })}${inner.replace(/id="gbtn"/g, `id="gbtn-${s.name}"`).replace(/url\(#gbtn\)/g, `url(#gbtn-${s.name})`)}</g>`;
}).join('')}
</svg>`;
fs.writeFileSync(path.join(OUT, 'monreleve-complet.svg'), sheet);
console.log(`✓ ${screens.length} écrans → design/figma/ + planche complète (${totalW}×${totalH + 40})`);
