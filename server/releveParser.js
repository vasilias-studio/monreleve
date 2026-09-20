/**
 * releveParser.js — Analyse des fichiers Excel de type « relevé de notes » (comme
 * Relevé de notes.xlsx fourni) et des tables plates de notes.
 *
 * Format « relevé » (structure du fichier fourni) :
 *   - lignes "SEMESTRE 3" / "SEMESTRE 4"        → délimiteur de semestre
 *   - lignes "Moyenne UE 9" (après ses matières) → fin de bloc UE ; les matières
 *     accumulées depuis le début (ou le bloc précédent) appartiennent à cette UE
 *   - colonne Matières / Note Normal / Repechage / Définitive / Cédit (fautes d'orthographe tolérées)
 *   - les CRÉDITS sont cachés dans les formules =IF(C12>=10, 2, "-") → extraits par regex
 *   - lignes de coefficient optionnelles (absentes du fichier fourni → défaut 1, configurable ensuite)
 */
import * as XLSX from 'xlsx';
import fs from 'node:fs';

const norm = (s) => String(s ?? '').trim().toLowerCase().replace(/\s+/g, ' ');

/** readFile non exposé par le build ESM du paquet : on charge le buffer nous-mêmes. */
/**
 * Lit un classeur depuis un CHEMIN de fichier ou depuis son CONTENU binaire.
 * Le contenu binaire est ce qu'on utilise pour les fichiers importés : ils vivent
 * dans la base (table `uploads`), pas sur un disque.
 */
export function readWorkbook(source, opts = {}) {
  const data = Buffer.isBuffer(source) ? source : (source instanceof Uint8Array ? Buffer.from(source) : fs.readFileSync(source));
  return XLSX.read(data, { type: 'buffer', ...opts });
}

/** Charge une feuille en matrice de cellules {v, f, t} (valeur + formule + type). */
export function loadSheetCells(filePath, sheetName) {
  const wb = readWorkbook(filePath, { cellFormula: true, cellDates: false });
  const name = sheetName && wb.SheetNames.includes(sheetName) ? sheetName : wb.SheetNames[0];
  const ws = wb.Sheets[name];
  if (!ws || !ws['!ref']) return { sheets: wb.SheetNames, sheetName: name, rows: [] };
  const range = XLSX.utils.decode_range(ws['!ref']);
  const rows = [];
  for (let r = range.s.r; r <= range.e.r; r++) {
    const row = [];
    for (let c = range.s.c; c <= range.e.c; c++) {
      const cell = ws[XLSX.utils.encode_cell({ r, c })];
      row.push(cell ? { v: cell.v, f: cell.f, t: cell.t, w: cell.w } : null);
    }
    rows.push(row);
  }
  return { sheets: wb.SheetNames, sheetName: name, rows };
}

/** Matrice brute de valeurs (pour l'aperçu plat). */
export function loadSheetValues(filePath, sheetName, headerRow = 0) {
  const wb = readWorkbook(filePath, { cellFormula: false });
  const name = sheetName && wb.SheetNames.includes(sheetName) ? sheetName : wb.SheetNames[0];
  const ws = wb.Sheets[name];
  const aoa = ws ? XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null }) : [];
  return { sheets: wb.SheetNames, sheetName: name, aoa, headerRow };
}

const SEM_RE = /^\s*SEMESTRE\s*([Ss]?\s*\d+)\s*$/i;
const UE_AVG_RE = /^\s*(?:moyenne\s*)?UE\s*([0-9A-Za-z\-\/]+)\s*$/i;
const SKIP_RE = /^(moyenne|totaux?|sigle|relev[ée]|note\s+finale|d[ée]cision|admis|ajourn[ée])/i;

/**
 * Reconnaissance automatique des en-têtes de colonnes.
 * Retourne {headerRowIndex, cols:{subject, normal, rattrapage, definitive, credits, coefficient}}
 */
function detectHeader(rows) {
  const patterns = {
    subject: /^(mati[èe]res?|libell[ée]|cours|ue\/mati[èe]re)/,
    normal: /^(note\s*(normale|normal|n)?|normale?|n)$/i,
    rattrapage: /^(note\s*rattrapage|rattrapage|repechage|r[ée]p[ée]tition)$/i,
    definitive: /^(note\s*d[ée]finitive|d[ée]finitive|df|note\s*finale)$/i,
    credits: /^(cr[ée]dits?|c[ée]dit|ects)$/i,
    coefficient: /^(coefficients?|coef|c)$/i,
  };
  for (let i = 0; i < Math.min(rows.length, 15); i++) {
    const found = {};
    const scan = (row) => row.forEach((cell, j) => {
      const label = norm(cell && cell.v);
      if (!label) return;
      for (const [key, re] of Object.entries(patterns)) {
        if (found[key] == null && re.test(label)) found[key] = j;
      }
    });
    scan(rows[i]);
    if (found.subject && (found.normal || found.definitive || found.credits)) {
      // En-tête sur 2 lignes (comme le fichier Excel fourni : « Note » fusionné sur Normal/Rattrapage/Définitive)
      if (i + 1 < rows.length) scan(rows[i + 1]);
      if (i + 2 < rows.length && (!found.definitive || !found.credits)) scan(rows[i + 2]);
      return { headerRowIndex: i, cols: found };
    }
  }
  return null;
}

/** Libellés résiduels d'en-tête à ne jamais prendre pour des matières. */
const HEADERISH_RE = /^(normal|normale|note|rattrapage|repechage|r[ée]p[ée]tition|d[ée]finitive|cr[ée]dit|c[ée]dit|ects|coefficient|coef|mati[èe]res?)$/i;

/** Extrait le crédit : valeur numérique directe, sinon à l'intérieur de la formule IF(...>=10, N, "-"). */
function extractCredits(cell, normalCell) {
  if (!cell) return null;
  if (typeof cell.v === 'number') return cell.v;
  if (cell.f) {
    const m = String(cell.f).match(/>=\s*[\d.,]+\s*,\s*([\d.]+)/);
    if (m) return parseFloat(m[1]);
  }
  return null;
}

/** Extrait le coefficient s'il existe (sinon null → défaut modèle). */
function num(cell) {
  if (!cell) return null;
  if (typeof cell.v === 'number') return cell.v;
  if (typeof cell.v === 'string') {
    const s = cell.v.replace(',', '.').trim();
    const n = parseFloat(s);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * Parse le format « relevé à blocs » (celui du fichier fourni).
 * Retourne { ok, semesters:[{number,name,ects,units:[{code,name,courses:[{name,coefficient,credits}]}]}], warnings }
 */
export function parseReleveStructure(rows) {
  const warnings = [];
  const header = detectHeader(rows);
  if (!header) return { ok: false, error: 'Aucune ligne d’en-tête détectée (colonnes attendues : Matières, Note, Crédit…)' };
  const { cols } = header;
  const semesterCol = 0; // colonne A souvent vide ; on cherche le libellé sur toute la ligne

  const semesters = [];
  let currentSem = null, currentUeCourses = [];

  const findLabel = (row) => {
    // libellé de ligne = première cellule texte non vide
    for (const c of row) if (c && typeof c.v === 'string' && c.v.trim()) return c.v.trim();
    for (const c of row) if (c && c.v != null && String(c.v).trim()) return String(c.v).trim();
    return '';
  };

  for (let i = header.headerRowIndex + 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row || row.every((c) => !c || c.v == null || String(c.v).trim() === '')) continue;
    const label = findLabel(row);
    if (!label) continue;

    const sem = label.match(SEM_RE);
    if (sem) {
      // fin de semestre en cours
      currentSem = { number: parseInt(sem[1].replace(/\D/g, ''), 10), name: label, ects: 0, units: [] };
      semesters.push(currentSem);
      currentUeCourses = [];
      continue;
    }
    // « Moyenne UE x » AVANT le filtrage des lignes « moyenne » : c'est le clôtureur de bloc UE.
    const ue = label.match(UE_AVG_RE);
    if (HEADERISH_RE.test(norm(label))) continue; // restes d'en-tête fusionné (« Normal », « Cédit »…)
    if (ue) {
      if (!currentSem) {
        // UE rencontrée avant tout en-tête de semestre → semestre implicite n°1
        currentSem = { number: 1, name: 'Semestre 1', ects: 0, units: [] };
        semesters.push(currentSem);
      }
      const code = `UE ${ue[1]}`;
      currentSem.units.push({ code, name: `UE ${ue[1]}`, courses: currentUeCourses });
      currentUeCourses = [];
      continue;
    }

    if (/^moyenne\b/i.test(norm(label))) continue; // « MOYENNE S3 » etc. : recalculé par le moteur, jamais stocké en matière
    const subjectCell = row[cols.subject];
    const subject = subjectCell && typeof subjectCell.v === 'string' ? subjectCell.v.trim()
      : (subjectCell && subjectCell.v != null ? String(subjectCell.v).trim() : label);
    if (!subject || /^(matières?|libell[ée])$/i.test(subject) || HEADERISH_RE.test(norm(subject))) continue;

    const credits = extractCredits(row[cols.credits], row[cols.normal]) ?? 1;
    const coefficient = cols.coefficient != null ? (num(row[cols.coefficient]) ?? 1) : 1;
    if (!currentSem) {
      currentSem = { number: 1, name: 'Semestre 1', ects: 0, units: [] };
      semesters.push(currentSem);
    }
    currentUeCourses.push({ name: subject, coefficient, credits, _row: i + 1 });
  }

  if (currentUeCourses.length) {
    // bloc orphelin non terminé par « Moyenne UE x »
    const code = `UE ${((currentSem?.units.length || 0) + 1)}`;
    warnings.push(`Le dernier bloc (${currentUeCourses.length} matière(s)) n’était pas clôturé par « Moyenne UE … » : rattaché à ${code}.`);
    currentSem.units.push({ code, name: code, courses: currentUeCourses });
  }
  for (const s of semesters) s.ects = s.units.reduce((a, u) => a + u.courses.reduce((x, c) => x + (c.credits || 0), 0), 0);
  const total = semesters.reduce((a, s) => a + s.units.reduce((x, u) => x + u.courses.length, 0), 0);
  if (!semesters.length || total === 0) return { ok: false, error: 'Aucune matière détectée dans ce format.' };
  return { ok: true, semesters, warnings, header };
}

/**
 * Parse une table plate (1 ligne = 1 matière) avec la correspondance de colonnes choisie
 * par l'administrateur. mapping = {matricule, subject, ue, semester, normal, rattrapage, credits, coefficient}
 */
export function parseFlatGrades(aoa, mapping) {
  const rows = aoa;
  // détection de la ligne d'en-tête : première ligne où au moins 2 colonnes mappées sont du texte
  let headerRow = 0;
  for (let i = 0; i < Math.min(rows.length, 10); i++) {
    const hits = Object.values(mapping).filter((c) => c != null && typeof rows[i]?.[c] === 'string').length;
    if (hits >= 2) { headerRow = i; break; }
  }
  const get = (r, c) => (c == null ? null : rows[r]?.[c] ?? null);
  const out = [];
  for (let i = headerRow + 1; i < rows.length; i++) {
    const subject = get(i, mapping.subject);
    if (!subject || typeof subject !== 'string' || !subject.trim()) continue;
    const asNum = (v) => {
      if (typeof v === 'number') return v;
      if (typeof v === 'string' && v.trim()) { const n = parseFloat(v.replace(',', '.')); return Number.isFinite(n) ? n : null; }
      return null;
    };
    out.push({
      matricule: get(i, mapping.matricule) != null ? String(get(i, mapping.matricule)).trim() : null,
      semester: get(i, mapping.semester) != null ? String(get(i, mapping.semester)).trim() : null,
      ue: get(i, mapping.ue) != null ? String(get(i, mapping.ue)).trim() : null,
      subject: subject.trim(),
      normal: asNum(get(i, mapping.normal)),
      rattrapage: asNum(get(i, mapping.rattrapage)),
      credits: asNum(get(i, mapping.credits)),
      coefficient: asNum(get(i, mapping.coefficient)),
    });
  }
  return { headerRow, rows: out };
}

/** Correspondances automatiques proposées à partir des libellés de colonnes. */
export function suggestMapping(aoa) {
  const headerIdx = 0;
  const labels = (aoa[headerIdx] || []).map((v) => norm(v));
  const find = (res) => {
    for (const re of res) { const i = labels.findIndex((l) => re.test(l)); if (i >= 0) return i; }
    return null;
  };
  return {
    matricule: find([/matricule|code etudiant|n° etudiant|cne/]),
    subject: find([/^mati[èe]re|^cours|^libelle|^ue\/mati/]),
    ue: find([/^ue\b|^code ue|^bloc/]),
    semester: find([/^semestre|^sem\b/]),
    normal: find([/note normale|^normale|^note\b|^n$/]),
    rattrapage: find([/rattrapage|repechage|rep|catch-up/]),
    credits: find([/cr[ée]dit|ects/]),
    coefficient: find([/coef|coefficient|^c$/]),
  };
}

export { XLSX };
