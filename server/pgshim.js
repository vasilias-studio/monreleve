/**
 * pgshim.js — Pont de dialecte SQLite → PostgreSQL, en UN SEUL endroit.
 *
 * Pourquoi : l'application a été écrite pour better-sqlite3 (API synchrone, SQL
 * « à la SQLite ») et compte ~300 requêtes. Plutôt que de réécrire ces requêtes
 * une par une (source d'erreurs garantie), on traduit ici, de façon déterministe
 * et testée, ce que PostgreSQL ne comprend pas tel quel :
 *
 *   · placeholders         `?`                     → `$1, $2, …`
 *   · horodatage           `datetime('now')`       → `now()`
 *                          `datetime('now','-35 minutes')` → `(now() + interval '-35 minutes')`
 *                          `datetime('now', ?)`    → `(now() + ($n)::interval)`
 *                          `date('now')`           → `current_date`
 *   · écriture idempotente `INSERT OR IGNORE`      → `INSERT … ON CONFLICT DO NOTHING`
 *   · identifiant créé     tout `INSERT` sans `RETURNING` reçoit `RETURNING id`,
 *                          pour que `lastInsertRowid` fonctionne comme en SQLite
 *   · insensibilité casse  `LIKE`                  → `ILIKE` (SQLite est insensible par défaut)
 *                          `COLLATE NOCASE`        → supprimé (l'unicité est assurée par un index sur lower())
 *
 * Rien d'autre n'est touché : les requêtes gardent leur forme d'origine dans le
 * code, ce qui permet aussi de continuer à utiliser SQLite en local (DB_DRIVER=sqlite).
 */

/** Découpe la requête en zones « protégées » (chaînes, identifiants, commentaires). */
function protectedRanges(sql) {
  const ranges = [];
  let i = 0;
  while (i < sql.length) {
    const c = sql[i];
    if (c === "'" || c === '"') {
      const start = i;
      i++;
      while (i < sql.length) {
        if (sql[i] === c) {
          if (sql[i + 1] === c) { i += 2; continue; }   /* '' échappé */
          i++;
          break;
        }
        i++;
      }
      ranges.push([start, i]);
      continue;
    }
    if (c === '-' && sql[i + 1] === '-') {              /* commentaire de fin de ligne */
      const end = sql.indexOf('\n', i);
      ranges.push([i, end < 0 ? sql.length : end]);
      i = end < 0 ? sql.length : end;
      continue;
    }
    if (c === '/' && sql[i + 1] === '*') {              /* commentaire de bloc */
      const end = sql.indexOf('*/', i + 2);
      ranges.push([i, end < 0 ? sql.length : end + 2]);
      i = end < 0 ? sql.length : end + 2;
      continue;
    }
    i++;
  }
  return ranges;
}

const inside = (ranges, index) => ranges.some(([a, b]) => index >= a && index < b);

/** Applique un remplacement seulement hors chaînes et commentaires. */
function replaceOutside(sql, re, replacer) {
  const ranges = protectedRanges(sql);
  return sql.replace(re, (...args) => {
    const index = args[args.length - 2];
    const groups = args.slice(1, -2);              /* après le match complet, avant offset/chaîne */
    return inside(ranges, index) ? args[0] : replacer(...groups);
  });
}

const isInsert = (sql) => /^\s*insert\s/i.test(sql);

/** Tables dont la clé primaire n'est pas `id` : pas de `RETURNING id` pour elles. */
const TABLES_SANS_ID = ['announcement_likes', 'announcement_images'];

/**
 * Traduit une requête écrite « à la SQLite » vers PostgreSQL.
 * @param {string} sql
 * @returns {{ text: string, insert: boolean }}
 */
export function toPostgres(sql) {
  let text = String(sql).trim().replace(/;\s*$/, '');

  /* 1. horodatages (avant le numérotage : ces motifs contiennent des chaînes littérales) */
  text = text.replace(/datetime\(\s*'now'\s*,\s*'([^']*)'\s*\)/gi, "now() + interval '$1'");
  text = text.replace(/datetime\(\s*'now'\s*\)/gi, 'now()');
  text = text.replace(/\bdate\(\s*'now'\s*\)/gi, 'current_date');

  /* 2. `end` est un mot réservé en PostgreSQL (colonne de schedule_slots) : on le cite.
        Uniquement la graphie minuscule, pour ne pas toucher un hypothétique CASE … END. */
  text = replaceOutside(text, /([.\s,(])end(?![\w])/g, (avant) => `${avant}"end"`);

  /* 4. insensibilité à la casse :
        · LIKE → ILIKE (SQLite est insensible par défaut pour l'ASCII) ;
        · suppression de COLLATE NOCASE ;
        · `email = X` → `lower(email) = lower(X)` : les adresses s'écrivent avec des majuscules
          libres (SQLite appliquait la collation NOCASE de la colonne, PostgreSQL est sensible). */
  text = replaceOutside(text, /\bLIKE\b/g, () => 'ILIKE');
  text = text.replace(/\s+COLLATE\s+NOCASE/gi, '');
  /* la colonne peut être qualifiée (u.email) : le préfixe doit rester DANS lower(...) */
  text = text.replace(/((?:(?:[A-Za-z_]\w*)\.)?\bemail\b)(\s*=\s*)(\$\d+|'[^']*'|\?)/gi,
    (_m, colonne, egal, valeur) => `lower(${colonne})${egal}lower(${valeur})`);

  /* 5. INSERT OR IGNORE → INSERT … ON CONFLICT DO NOTHING */
  let orIgnore = false;
  if (/^\s*insert\s+or\s+ignore\s+into\s/i.test(text)) {
    orIgnore = true;
    text = text.replace(/^\s*insert\s+or\s+ignore\s+into\s/i, 'INSERT INTO ');
  }

  /* 6. numérotage des placeholders `?` → `$n` (hors chaînes, `?` ambigus ignorés) */
  {
    const ranges = protectedRanges(text);
    let n = 0;
    let out = '';
    for (let i = 0; i < text.length; i++) {
      if (text[i] === '?' && !inside(ranges, i)) { out += `$${++n}`; continue; }
      out += text[i];
    }
    text = out;
  }

  /* 6-bis. `$n IS NULL` : PostgreSQL ne sait pas déduire le type d'un paramètre employé
     SEUL dans cette position (« could not determine data type of parameter $3 »), là où
     SQLite s'en moque. Un transtypage en texte rend la comparaison valide sans changer
     le résultat : la valeur est nulle, ou elle ne l'est pas. */
  text = text.replace(/(\$\d+)\s+IS\s+(NOT\s+)?NULL/gi,
    (_m, marqueur, negation) => `${marqueur}::text IS ${negation || ''}NULL`);

  /* 7. date(…, offset) avec paramètre lié : datetime('now', $3) → now() + ($3)::interval */
  text = text.replace(/datetime\(\s*'now'\s*,\s*\$(\d+)\s*\)/gi, (_m, n) => `now() + ($${n})::interval`);

  /* 8. identifiant de la ligne insérée : RETURNING id (comme lastInsertRowid) */
  let insert = isInsert(text);
  if (insert) {
    if (orIgnore && !/ON CONFLICT/i.test(text)) text += ' ON CONFLICT DO NOTHING';
    /* `RETURNING id` sert à reproduire lastInsertRowid ; les tables sans colonne `id`
       (clé primaire composite, ex. announcement_likes) en sont exclues. */
    const sansId = TABLES_SANS_ID.some((t) => new RegExp(`insert\\s+into\\s+${t}\\b`, 'i').test(text));
    if (!sansId && !/RETURNING\s/i.test(text)) text += ' RETURNING id';
  }
  return { text, insert };
}

/** Autres conversions utiles au schéma (DDL) et aux cas isolés. */
export function ddlToPostgres(ddl) {
  let t = toPostgres(ddl).text;
  t = t.replace(/INTEGER\s+PRIMARY\s+KEY\s+AUTOINCREMENT/gi, 'bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY');
  t = t.replace(/INTEGER\s+PRIMARY\s+KEY/gi, 'bigint PRIMARY KEY');
  t = t.replace(/TEXT\s+DEFAULT\s*\(\s*now\(\)\s*\)/gi, 'timestamptz DEFAULT now()');
  t = t.replace(/\bREAL\b/gi, 'double precision');
  t = t.replace(/\bBLOB\b/gi, 'bytea');          /* contenu binaire des fichiers importés */
  t = t.replace(/TEXT\s+NOT\s+NULL\s+DEFAULT\s*\(\s*now\(\)\s*\)/gi, 'timestamptz NOT NULL DEFAULT now()');
  /* les horodatages déclarés en TEXT passent en timestamptz quand la valeur par défaut est now() */
  t = t.replace(/(\b(created_at|updated_at|published_at|reset_expires)\b\s+)TEXT(\s+DEFAULT\s+now\(\))?/gi,
    (m, col, _name, def) => `${col}timestamptz${def || ''}`);
  /* `COLLATE NOCASE` a déjà été retiré : seule l'unicité de users.email est remplacée
     par l'index sur lower(email) (voir postgresSchema). Les AUTRES colonnes « TEXT NOT NULL
     UNIQUE » (levels.name, students.matricule, academic_years.label…) gardent leur contrainte. */
  t = t.replace(/(\bemail\b\s+)TEXT\s+NOT\s+NULL\s+UNIQUE/gi, '$1text NOT NULL');
  t = t.replace(/TEXT\b/gi, 'text');
  t = t.replace(/INTEGER\b/gi, 'integer');
  return t;
}

/**
 * Schéma complet pour PostgreSQL, construit depuis le DDL SQLite (source unique).
 * Ajoute ce que SQLite obtenait autrement :
 *   · `COLLATE NOCASE` sur users.email → index unique sur lower(email)
 *   · `AUTOINCREMENT` → colonnes IDENTITY
 */
export function postgresSchema(sqliteDdl) {
  const body = ddlToPostgres(sqliteDdl)
    /* les `CREATE TABLE IF NOT EXISTS` restent valides en PostgreSQL */
    .replace(/datetime\('now'\)/gi, 'now()');
  /* `toPostgres` retire le point-virgule final : on le rétablit, sinon la dernière table
     se retrouverait collée à l'index ajouté ci-dessous (erreur « syntax error at or near CREATE »). */
  const corps = body.trim().replace(/;?$/, ';');
  return `${corps}

-- unicité de l'adresse e-mail sans tenir compte de la casse (équivalent de COLLATE NOCASE)
CREATE UNIQUE INDEX IF NOT EXISTS ux_users_email_lower ON users (lower(email));
`;
}

/**
 * Analyseurs de types : PostgreSQL renvoie par défaut des chaînes pour int8/numeric
 * et des objets Date pour les horodatages. L'application attend des nombres et des
 * chaînes « YYYY-MM-DD HH:MM:SS » (format SQLite) : on rétablit ce contrat ici.
 * @param {object} pg  le module `pg` (pour pg.types.setTypeParser)
 */
const stamp = (v) => (v === null || v === undefined ? null : new Date(v).toISOString().slice(0, 19).replace('T', ' '));

/** Analyseurs appliqués aux deux pilotes PostgreSQL (pg et PGlite), par identifiant de type. */
export const TYPE_PARSERS = {
  20: (v) => (v === null ? null : Number(v)),      /* int8    → nombre (COUNT, id) */
  1700: (v) => (v === null ? null : Number(v)),    /* numeric → nombre             */
  1114: stamp,                                     /* timestamp   → « YYYY-MM-DD HH:MM:SS » */
  1184: stamp,                                     /* timestamptz → idem, en UTC           */
  1082: (v) => v,                                  /* date        → « YYYY-MM-DD »         */
};

export function installTypeParsers(pg) {
  for (const [oid, parse] of Object.entries(TYPE_PARSERS)) pg.types.setTypeParser(Number(oid), parse);
}
