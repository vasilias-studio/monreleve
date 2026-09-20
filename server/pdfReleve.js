/**
 * pdfReleve.js — relevé de notes en PDF, UNE seule page A4 (portrait).
 * Reprise de la charte « Vasilías » : papier/encre/ocre, capitales espacées,
 * aucun filet gris (séparations par fonds et blancs). La taille de ligne est
 * choisie automatiquement pour que tout tienne sur la page, quel que soit le
 * nombre de semestres/matières du modèle.
 */
import PDFDocument from 'pdfkit';

const PAPER = '#F2E9D8', INK = '#161513', MUT = '#8A857C', ACC = '#BF814B', SOFT = '#ECE9E2';
const STATUS = { validee: 'Validée', non_validee: 'Non validée', rattrapage_a_passer: 'Rattrapage', en_attente: '—' };
const PUB = { published: 'Publié', locked: 'Verrouillé' };
const nf = (v, d = 2) => (v == null || !Number.isFinite(Number(v)) ? '—' : Number(v).toLocaleString('fr-FR', { minimumFractionDigits: d, maximumFractionDigits: d }));

/**opts : { student, user, template, sems, tot, source, pubs } → Buffer PDF */
export async function buildRelevePdf(opts) {
  const { student: stud, user: u, template, sems, tot, source, pubs = {} } = opts;
  const M = 38;                                   // marges (pt)
  const W = 595.28 - M * 2;                       // largeur utile A4 portrait
  const COL = { name: 216, coef: 30, norm: 48, rattr: 48, def: 52, cred: 46, stat: W - 440 };
  const x = (k) => M + Object.entries(COL).slice(0, Object.keys(COL).indexOf(k)).reduce((a, [, v]) => a + v, 0);

  /* ── lignes à imprimer → choix du gabarit pour tenir sur une page ── */
  const rowDefs = [];
  for (const s of sems) {
    rowDefs.push('sem');
    for (const un of s.units) { rowDefs.push('ue'); for (const c of un.courses) rowDefs.push('c'); }
    rowDefs.push('avg');
  }
  const HEADER = 122, FOOTER = 96, AVAIL = 842 - HEADER - FOOTER;
  const presets = [ [13.2, 8.4], [12.2, 8.0], [11.2, 7.5], [10.2, 7.0], [9.3, 6.5], [8.5, 6.0], [7.8, 5.6] ];
  const [LH, FS] = presets.find(([lh]) => rowDefs.length * lh <= AVAIL) || presets[presets.length - 1];

  const doc = new PDFDocument({ size: 'A4', margin: 0, info: { Title: `Relevé de notes — ${u?.first_name || ''} ${u?.last_name || ''}`.trim(), Author: 'MonRelevé' } });
  const chunks = [];
  doc.on('data', (b) => chunks.push(b));
  
  const label = (tx2, ty, str, { size = FS, color = INK, bold = true, align = 'left', width } = {}) =>
    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fillColor(color).fontSize(size)
      .text(str, tx2, ty, width != null ? { width, align, lineGap: 0, ellipsis: true } : { align, lineGap: 0 });

  let y = M;
  /* ── en-tête ── */
  doc.roundedRect(M, y + 2, 15, 15, 2).fill(ACC);
  label(M + 21, y + 4, 'MONRELEVÉ', { size: 10, color: INK });
  label(M, y + 4, 'LE ' + new Date().toLocaleDateString('fr-FR', { day: '2-digit', month: 'long', year: 'numeric' }).toUpperCase(), { size: 7.5, color: MUT, bold: false, align: 'right', width: W });
  y += 30;
  label(M, y, 'Relevé de notes', { size: 24 });
  y += 27;
  const filiere = `${template?.name || ''}`.toUpperCase();
  label(M, y, `${filiere}   ·   ${source === 'official' ? 'RÉSULTATS OFFICIELS' : 'MES NOTES SAISIES (APERÇU)'}`, { size: 7.5, color: MUT });
  y += 15;
  const infos = [
    ['ÉTUDIANT', `${u?.last_name || ''} ${u?.first_name || ''}`.trim().toUpperCase()],
    ['MATRICULE', stud?.matricule || '—'],
    ['CLASSE', (stud?.class_name || '—') + ''],
    ['SEMESTRES', sems.map((s) => 'S' + s.number).join(' · ')],
  ];
  const colW = W / infos.length;
  infos.forEach(([k, v], i) => { label(M + i * colW, y, k, { size: 6.8, color: MUT }); label(M + i * colW, y + 9, v, { size: 9 }); });
  y += 28;

  /* ── tableaux par semestre ── */
  for (const s of sems) {
    doc.rect(M, y, W, LH + 3).fill(SOFT);
    label(M + 6, y + 3, `S${s.number} — ${s.name}`, { size: FS + 0.5 });
    label(M + 176, y + 3, `MOYENNE ${nf(s.average)}/20 · CRÉDITS ${nf(s.creditsEarned, 0)}/${nf(s.ectsExpected || 0, 0)}${PUB[(pubs[s.id] || {}).status] ? ' · ' + PUB[pubs[s.id].status].toUpperCase() : ''}`, { size: FS - 0.7, color: ACC, align: 'right', width: W - 182 });
    y += LH + 6;
    /* ligne de colonnes */
    label(x('name'), y, 'MATIÈRES', { size: FS - 1.6, color: MUT });
    for (const k of ['coef', 'norm', 'rattr', 'def', 'cred']) label(x(k), y, { coef: 'COEF', norm: 'NORM.', rattr: 'RATTR.', def: 'DÉF.', cred: 'CR.' }[k], { size: FS - 1.6, color: MUT, align: 'right', width: COL[k] });
    label(x('stat'), y, 'STATUT', { size: FS - 1.6, color: MUT, align: 'right', width: COL.stat });
    y += LH;
    let z = false;
    for (const un of s.units) {
      label(x('name'), y, `${un.code} — ${un.name}  ·  moy. ${nf(un.average)}`, { size: FS - 0.4, color: ACC });
      y += LH; z = false;
      for (const c of un.courses) {
        if (z) { doc.rect(M, y - 1.5, W, LH).fillOpacity(0.03).fill(INK).fillOpacity(1); }
        z = !z;
        label(x('name') + 8, y, c.name, { size: FS, bold: false });
        const nums = [['coef', nf(c.coefficient, 0)], ['norm', nf(c.normal)], ['rattr', nf(c.rattrapage)], ['def', nf(c.definitive)], ['cred', `${nf(c.creditsEarned, 0)}/${nf(c.credits, 0)}`]];
        for (const [k, v] of nums) label(x(k), y, v, { size: FS, align: 'right', width: COL[k] });
        const st = STATUS[c.status] || '—';
        label(x('stat'), y, st, { size: FS - 0.8, color: st === 'Validée' ? '#4E6E54' : st === 'Rattrapage' ? '#9A6218' : st === 'Non validée' ? '#9C3B2E' : MUT, align: 'right', width: COL.stat });
        y += LH;
      }
    }
    y += 4;
  }

  /* ── pied : totaux + signature ── */
  const fy = 842 - FOOTER;
  doc.rect(M, fy, W, 44).fill(INK);
  label(M + 12, fy + 6, 'MOYENNE GÉNÉRALE', { size: 7.5, color: PAPER, bold: false });
  label(M + 12, fy + 16, `${nf(tot.generalAverage)}/20`, { size: 17, color: PAPER });
  label(M + 150, fy + 6, 'CRÉDITS VALIDÉS', { size: 7.5, color: PAPER, bold: false });
  label(M + 150, fy + 16, `${nf(tot.creditsEarned, 0)} / ${nf(tot.creditsExpected, 0)} ECTS`, { size: 12, color: PAPER });
  const note = (tot.generalAverage ?? 0) >= 10 ? 'MOYENNE ACQUISE' : 'MOYENNE NON ACQUISE —' + ' rattrapage';
  label(M + W - 240, fy + 16, note, { size: 8.5, color: ACC, align: 'right', width: 228 });
  label(M, fy + 52, 'Fait à Antananarivo, le ' + new Date().toLocaleDateString('fr-FR'), { size: FS - 0.5, color: MUT, bold: false });
  label(M + W - 150, fy + 48, 'Cachet et signature', { size: FS - 0.5, color: MUT, bold: false, align: 'right', width: 150 });

  label(M, 842 - 18, 'Document généré par MonRelevé — une page, tous semestres · ' + (source === 'official' ? 'Résultats officiels publiés' : 'Aperçu de saisie personnelle, non contractuel'), { size: 6.5, color: MUT, bold: false });

  const done = new Promise((r) => doc.on('end', r));
  doc.end();
  await done;
  return Buffer.concat(chunks);
}
