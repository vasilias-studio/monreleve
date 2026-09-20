/**
 * compute.js — Moteur de calcul des moyennes et crédits.
 *
 * TOUTES les règles proviennent du modèle (templates.rules_json) et sont modifiables
 * par l'administrateur. Les valeurs par ci-dessous reproduisent la logique observée
 * dans « Relevé de notes.xlsx » (L2 Gestion) :
 *
 *  - note définitive      = MAX(normale, rattrapage) ; « - » si aucune note ; rattrapage non plafonné
 *  - moyenne d'UE         = moyenne arithmétique des notes définitives (les matières sans note sont ignorées)
 *  - moyenne de semestre  = moyenne arithmétique des moyennes d'UE
 *  - moyenne générale     = moyenne arithmétique des moyennes de semestre
 *  - crédits obtenus      = crédits d'une matière validée si la NOTE NORMALE >= seuil (particularité du fichier Excel)
 *  - seuil de validation  = 10/20
 *
 * Options proposées (configurables, jamais codées dans les écrans) :
 *   final_grade_rule        : "max_normal_rattrapage" | "normal_then_rattrapage" | "weighted"
 *   rattrapage_weight       : poids du rattrapage quand rule = "weighted" (ex: 0.5)
 *   rattrapage_cap          : plafond de la note définitive après rattrapage (null = aucun plafond, comme l'Excel)
 *   ue_average_method       : "simple" | "coefficient_weighted"
 *   semester_average_method : "ue_simple_mean" | "ue_credit_weighted" | "course_weighted"
 *   general_average_method  : "semester_mean" | "credit_weighted_semesters"
 *   credit_validation_basis : "normal" | "definitive"   (source de la note qui déclenche les crédits)
 *   pass_threshold          : nombre (défaut 10)
 */

export const DEFAULT_RULES = {
  final_grade_rule: 'max_normal_rattrapage',
  rattrapage_weight: 0.5,
  rattrapage_cap: null,
  ue_average_method: 'simple',
  semester_average_method: 'ue_simple_mean',
  general_average_method: 'semester_mean',
  credit_validation_basis: 'normal',
  pass_threshold: 10,
};

export function resolveRules(template) {
  let parsed = {};
  try { parsed = JSON.parse(template.rules_json || '{}'); } catch { /* modèle sans règles → défauts */ }
  return { ...DEFAULT_RULES, ...parsed };
}

const isNum = (v) => typeof v === 'number' && !Number.isNaN(v);
export const round2 = (v) => (isNum(v) ? Math.round(v * 100) / 100 : null);

/** Note définitive d'une matière selon les règles du modèle. */
export function finalGrade(rules, normal, rattrapage) {
  const has = (v) => isNum(v);
  let f = null;
  switch (rules.final_grade_rule) {
    case 'normal_then_rattrapage': // le rattrapage remplace la normale si présent
      f = has(rattrapage) ? rattrapage : (has(normal) ? normal : null);
      break;
    case 'weighted': {
      const w = isNum(rules.rattrapage_weight) ? rules.rattrapage_weight : 0.5;
      if (has(rattrapage) && has(normal)) f = normal * (1 - w) + rattrapage * w;
      else f = has(normal) ? normal : (has(rattrapage) ? rattrapage : null);
      break;
    }
    case 'max_normal_rattrapage':
    default: // MAX(normale, rattrapage) — comportement du fichier Excel
      if (has(normal) && has(rattrapage)) f = Math.max(normal, rattrapage);
      else if (has(normal)) f = normal;
      else if (has(rattrapage)) f = rattrapage;
      break;
  }
  // Plafond éventuel après rattrapage (ex: certaines maquettes plafonnent à 10)
  if (isNum(rules.rattrapage_cap) && has(rattrapage) && f !== null) {
    f = Math.min(f, rules.rattrapage_cap);
  }
  return f;
}

/** Statut d'une matière : validee | rattrapage_a_passer | non_validee | en_attente.
 *  Le statut regarde la NOTE DÉFINITIVE (max normale/rattrapage selon les règles) :
 *  c.-à-d. « 8,5 / rattrapage 11 → Validé », conformément à l'exemple du cahier des charges. */
export function courseStatus(rules, normal, rattrapage, definitive) {
  const t = rules.pass_threshold;
  const scored = isNum(normal) || isNum(rattrapage);
  if (!scored) return 'en_attente';
  if (isNum(definitive) && definitive >= t) return 'validee';
  if (isNum(normal) && normal < t && !isNum(rattrapage)) return 'rattrapage_a_passer';
  return 'non_validee';
}

/** Crédits acquis d'une matière : selon la base configurable (note NORMALE dans le fichier Excel fourni). */
export function creditsEarned(rules, grades, credits, definitive) {
  const basis = rules.credit_validation_basis === 'definitive' ? definitive : grades.normal;
  return isNum(basis) && basis >= rules.pass_threshold ? (credits || 0) : 0;
}

/** Moyenne pondérée simple ou par coefficient/crédit à partir d'une liste {avg, coefficient, credits}. */
function weighted(items, valueKey, weightKey, fallbackWeight = 1) {
  let s = 0, w = 0;
  for (const it of items) {
    if (!isNum(it[valueKey])) continue;
    const ww = isNum(it[weightKey]) ? it[weightKey] : fallbackWeight;
    s += it[valueKey] * ww; w += ww;
  }
  return w > 0 ? s / w : null;
}

/**
 * Calcule le relevé complet d'un étudiant pour une source donnée.
 * @param {object} template  ligne templates (+ champs joints)
 * @param {Array}  semesters [{id, number, name, ects_expected, units:[{id, code, name, courses:[{id, name, coefficient, credits}]}]}]
 * @param {Map}    gradeMap  course_id -> {normal, rattrapage}
 */
export function computeReleve(template, semesters, gradeMap) {
  const rules = resolveRules(template);
  const t = rules.pass_threshold;
  const out = {
    rules,
    semesters: [],
    generalAverage: null,
    creditsEarned: 0,
    creditsExpected: 0,
    counts: { validees: 0, non_validees: 0, rattrapage: 0, en_attente: 0 },
  };

  const semAverages = [];

  for (const sem of semesters) {
    const semOut = {
      id: sem.id, number: sem.number, name: sem.name,
      ectsExpected: sem.ects_expected,
      units: [], average: null, creditsEarned: 0,
    };
    const ueAverages = [];
    const flatCourses = [];

    for (const ue of sem.units) {
      const ueOut = { id: ue.id, code: ue.code, name: ue.name, courses: [], average: null };
      const ueItems = [];
      for (const c of ue.courses) {
        const g = gradeMap.get(c.id) || {};
        const normal = isNum(g.normal) ? g.normal : null;
        const rattrapage = isNum(g.rattrapage) ? g.rattrapage : null;
        const definitive = finalGrade(rules, normal, rattrapage);
        const status = courseStatus(rules, normal, rattrapage, definitive);
        // Crédits : base configurable (normale par défaut, comme =IF(C>=10,...) dans l'Excel fourni)
        const earned = creditsEarned(rules, { normal }, c.credits, definitive);
        const course = {
          id: c.id, name: c.name,
          coefficient: c.coefficient, credits: c.credits,
          normal, rattrapage, definitive, status,
          creditsEarned: earned,
        };
        ueOut.courses.push(course);
        flatCourses.push(course);
        if (isNum(definitive)) ueItems.push({ avg: definitive, coefficient: c.coefficient, credits: c.credits });
        semOut.creditsEarned += earned;
        out.creditsEarned += earned;
        out.counts[
          status === 'validee' ? 'validees'
          : status === 'rattrapage_a_passer' ? 'rattrapage'
          : status === 'non_validee' ? 'non_validees' : 'en_attente'
        ]++;
      }
      ueOut.average = rules.ue_average_method === 'coefficient_weighted'
        ? weighted(ueItems, 'avg', 'coefficient')
        : (ueItems.length ? ueItems.reduce((a, b) => a + b.avg, 0) / ueItems.length : null);
      ueOut.average = round2(ueOut.average);
      if (isNum(ueOut.average)) ueAverages.push({
        avg: ueOut.average,
        credits: ueOut.courses.reduce((a, b) => a + (b.credits || 0), 0),
      });
      semOut.units.push(ueOut);
    }

    // Moyenne de semestre (méthodes configurables)
    if (rules.semester_average_method === 'course_weighted') {
      semOut.average = weighted(
        flatCourses.filter((c) => isNum(c.definitive)).map((c) => ({ avg: c.definitive, coefficient: c.coefficient })),
        'avg', 'coefficient');
    } else if (rules.semester_average_method === 'ue_credit_weighted') {
      semOut.average = weighted(ueAverages, 'avg', 'credits');
    } else {
      semOut.average = ueAverages.length
        ? ueAverages.reduce((a, b) => a + b.avg, 0) / ueAverages.length : null;
    }
    semOut.average = round2(semOut.average);
    if (isNum(semOut.average)) semAverages.push({ avg: semOut.average, credits: semOut.units.reduce((a, u) => a + u.courses.reduce((x, c) => x + c.credits, 0), 0) });
    out.creditsExpected += semOut.ectsExpected || 0;
    if (semOut.average === null && ueAverages.length === 0) {
      // semestre vide : on garde la structure mais sans moyenne
      semOut.empty = true;
    }
    out.semesters.push(semOut);
  }

  if (rules.general_average_method === 'credit_weighted_semesters') {
    out.generalAverage = weighted(semAverages, 'avg', 'credits');
  } else {
    out.generalAverage = semAverages.length
      ? semAverages.reduce((a, b) => a + b.avg, 0) / semAverages.length : null;
  }
  out.generalAverage = round2(out.generalAverage);
  out.creditsEarned = round2(out.creditsEarned);
  out.creditsRemaining = round2(Math.max(0, out.creditsExpected - out.creditsEarned));
  return out;
}
