/* Import.jsx — assistant d'importation Excel côté administrateur :
 * 1) envoi du fichier  2) choix du mode + correspondance des colonnes  3) aperçu & conflits  4) import avec confirmation explicite.
 * Aucune donnée existante n'est écrasée sans case « confirmer » cochée. */
import React, { useEffect, useMemo, useState } from 'react';
import { api } from '../../api.js';
import { Card, Row, Chip, Field, useToast, Empty } from '../../ui.jsx';

const MAPPING_FIELDS = [
  ['matricule', 'Matricule étudiant'],
  ['subject', 'Nom matière'],
  ['ue', 'Code UE'],
  ['semester', 'Semestre'],
  ['normal', 'Note normale'],
  ['rattrapage', 'Note de rattrapage'],
  ['credits', 'Crédit'],
  ['coefficient', 'Coefficient'],
];

export default function ImportPage() {
  const [step, setStep] = useState(1);
  const [up, setUp] = useState(null);
  const [sheet, setSheet] = useState(null);
  const [mode, setMode] = useState('structure');
  const [mapping, setMapping] = useState({});
  const [templateId, setTemplateId] = useState('');
  const [source, setSource] = useState('official');
  const [templates, setTemplates] = useState([]);
  const [preview, setPreview] = useState(null);
  const [busy, setBusy] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [overwrite, setOverwrite] = useState('skip');
  const [createMissing, setCreateMissing] = useState(false);
  const [result, setResult] = useState(null);
  const [journal, setJournal] = useState([]);
  const [toast, showToast] = useToast();

  useEffect(() => { api('/admin/templates').then(setTemplates).catch(() => {}); api('/admin/import/journal').then(setJournal).catch(() => {}); }, []);
  const currentSheet = useMemo(() => (up?.sheets || []).find((s) => s.name === sheet) || up?.sheets?.[0], [up, sheet]);
  const suggest = useMemo(() => (up?.suggestions || []).find((s) => s.name === (currentSheet?.name)), [up, currentSheet]);

  const onFile = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setBusy(true); setResult(null); setStep(1);
    try {
      const form = new FormData();
      form.append('file', file);
      const d = await api('/admin/import/upload', { method: 'POST', form });
      setUp(d); setSheet(d.sheets[0]?.name); setMapping(d.suggestions[0]?.mapping || {});
      setMode(d.suggestions[0]?.flat ? 'grades' : 'structure');
      setStep(2);
      showToast('Fichier analysé ✓');
    } catch (err2) { showToast('⚠️ ' + err2.message); } finally { setBusy(false); }
  };

  const analyze = async () => {
    setBusy(true);
    try {
      const body = { fileId: up.fileId, sheet: currentSheet?.name, mode, mapping, targetTemplateId: templateId ? Number(templateId) : null, source };
      setPreview(await api('/admin/import/analyze', { method: 'POST', body }));
      setConfirmed(false);
      setStep(3);
    } catch (e) { showToast('⚠️ ' + e.message); } finally { setBusy(false); }
  };

  const commit = async () => {
    if (!confirmed) { showToast('⚠️ Cochez la confirmation avant d’importer'); return; }
    setBusy(true);
    try {
      const body = { fileId: up.fileId, sheet: currentSheet?.name, mode, mapping, targetTemplateId: templateId ? Number(templateId) : null, source, onConflict: overwrite, createMissingCourses: createMissing, confirm: true };
      const d = await api('/admin/import/commit', { method: 'POST', body });
      setResult(d);
      setStep(4);
      api('/admin/import/journal').then(setJournal).catch(() => {});
    } catch (e) { showToast('⚠️ ' + e.message); } finally { setBusy(false); }
  };

  const reset = () => { setStep(1); setUp(null); setPreview(null); setResult(null); setConfirmed(false); };

  return (
    <div className="fade">
      {toast}
      <h1 style={{ fontSize: 20, marginBottom: 2 }}>📥 Importation Excel</h1>
      <p className="tiny muted" style={{ marginBottom: 12 }}>Format « relevé » (semestres / moyennes d’UE) ou table plate de notes, avec correspondance des colonnes et aperçu avant écriture.</p>

      <div className="row" style={{ gap: 6, marginBottom: 14 }}>
        {['1 · Fichier', '2 · Options', '3 · Aperçu', '4 · Terminé'].map((s, i) => (
          <Chip key={s} tone={step > i + 1 ? 'ok' : step === i + 1 ? 'violet' : 'gray'}>{s}</Chip>
        ))}
      </div>

      {step === 1 && (
        <Card>
          <p style={{ margin: 0 }} className="small">Sélectionnez un fichier <code>.xlsx</code> / <code>.xls</code> depuis votre appareil.</p>
          <label className="btn" style={{ marginTop: 12, cursor: 'pointer' }}>
            {busy ? 'Analyse en cours…' : '📂 Choisir un fichier Excel'}
            <input type="file" accept=".xlsx,.xls" hidden onChange={onFile} disabled={busy} />
          </label>
        </Card>
      )}

      {step >= 2 && up && (
        <Card>
          <Row className="spread">
            <div><strong className="small">{up.filename}</strong><div className="tiny muted">{up.sheets.length} feuille(s)</div></div>
            <button className="btn xs ghost" onClick={reset}>Recommencer</button>
          </Row>
          <div style={{ marginTop: 10 }}>
            <Field label="Feuille">
              <select className="input sm" value={currentSheet?.name || ''} onChange={(e) => { setSheet(e.target.value); const s = up.suggestions.find((x) => x.name === e.target.value); if (s) setMapping(s.mapping); }}>
                {up.sheets.map((s) => <option key={s.name} value={s.name}>{s.name} ({s.rows} lignes)</option>)}
              </select>
            </Field>
            <Field label="Mode d’import">
              <div className="segments sm">
                <button className={mode === 'structure' ? 'on' : ''} onClick={() => setMode('structure')}>🗂 Structure de modèle</button>
                <button className={mode === 'grades' ? 'on' : ''} onClick={() => setMode('grades')}>🧾 Notes d’étudiants</button>
              </div>
            </Field>
            {mode === 'structure' && (
              <>
                <div className="banner info tiny">Analyse le format du relevé fourni (lignes « SEMESTRE x », blocs de matières clôturés par « Moyenne UE x », crédits extraits des formules). Les coefficients absents du fichier valent 1 — modifiables ensuite.</div>
                <Field label="Modèle cible">
                  <select className="input sm" value={templateId} onChange={(e) => setTemplateId(e.target.value)}>
                    <option value="">— Créer / choisir un modèle —</option>
                    {templates.map((t) => <option key={t.id} value={t.id}>{t.name} ({t.n_courses} matières)</option>)}
                  </select>
                </Field>
              </>
            )}
            {mode === 'grades' && (
              <>
                <div className="grid2">
                  <Field label="Modèle de relevé">
                    <select className="input sm" value={templateId} onChange={(e) => setTemplateId(e.target.value)}>
                      <option value="">— Obligatoire —</option>
                      {templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                    </select>
                  </Field>
                  <Field label="Écrire dans">
                    <select className="input sm" value={source} onChange={(e) => setSource(e.target.value)}>
                      <option value="official">Notes officielles</option>
                      <option value="personal">Notes personnelles (remplissage)</option>
                    </select>
                  </Field>
                </div>
                <p className="tiny" style={{ margin: '4px 0 8px', color: 'var(--muted)' }}>Correspondance des colonnes Excel → champs de l’application :</p>
                <div className="grid2" style={{ gap: 8 }}>
                  {MAPPING_FIELDS.map(([k, label]) => (
                    <Field key={k} label={label}>
                      <select className="input sm" value={mapping[k] ?? ''} onChange={(e) => setMapping({ ...mapping, [k]: e.target.value === '' ? null : Number(e.target.value) })}>
                        <option value="">— ignorer —</option>
                        {headerLabels(currentSheet).map((h, idx) => <option key={idx} value={idx}>{String(h ?? `colonne ${idx + 1}`)}</option>)}
                      </select>
                    </Field>
                  ))}
                </div>
                <label className="row small" style={{ gap: 8, marginTop: 4 }}>
                  <input type="checkbox" checked={createMissing} onChange={(e) => setCreateMissing(e.target.checked)} /> Créer les matières inconnues (dans la 1ʳᵉ UE)
                </label>
              </>
            )}
          </div>
          <button className="btn" style={{ marginTop: 12 }} disabled={busy || !currentSheet} onClick={analyze}>{busy ? 'Analyse…' : '➡️ Analyser et aperçu'}</button>
        </Card>
      )}

      {step === 3 && preview && (
        <Card>
          <Row className="spread" style={{ marginBottom: 10 }}>
            <h3>Aperçu avant import</h3>
            <Chip tone={preview.conflicts ? 'warn' : 'ok'}>{preview.conflicts ? 'Conflits détectés' : 'Prêt'}</Chip>
          </Row>

          {mode === 'structure' && preview.parsed && (
            <>
              <p className="small" style={{ margin: '0 0 8px' }}>{preview.summary} — {preview.parsed.semesters.map((s) => `S${s.number}: ${s.units.reduce((a, u) => a + u.courses.length, 0)} matières`).join(' · ')}</p>
              {(preview.parsed.warnings || []).map((w, i) => <div key={i} className="banner warn tiny" style={{ marginBottom: 6 }}>⚠️ {w}</div>)}
              <div className="scroll-x">
                <table className="tbl">
                  <thead><tr><th>Semestre / UE</th><th>Matière</th><th className="c">Coef.</th><th className="c">Crédit</th></tr></thead>
                  <tbody>
                    {preview.parsed.semesters.map((s) => s.units.map((u) => u.courses.map((c, i) => (
                      <tr key={s.number + u.code + c.name}>
                        {i === 0 && <td rowSpan={u.courses.length} style={{ verticalAlign: 'top', whiteSpace: 'nowrap' }}><strong>sem.{s.number}</strong><div className="tiny muted">{u.code}</div></td>}
                        <td className="small">{c.name}</td>
                        <td className="c num-td">{c.coefficient}</td>
                        <td className="c num-td">{c.credits}</td>
                      </tr>
                    ))))}
                  </tbody>
                </table>
              </div>
            </>
          )}

          {mode === 'grades' && preview.items && (
            <>
              <div className="row" style={{ gap: 6, marginBottom: 8, flexWrap: 'wrap' }}>
                <Chip tone="ok">{preview.matched} importable(s)</Chip>
                {preview.unmatched > 0 && <Chip tone="bad">{preview.unmatched} sans correspondance</Chip>}
                {preview.conflicts && <Chip tone="warn">{preview.conflicts.overwrite} écrasement(s)</Chip>}
              </div>
              <div className="scroll-x">
                <table className="tbl">
                  <thead><tr><th>Étudiant</th><th>Matière</th><th className="c">Normale</th><th className="c">Rattr.</th><th className="c">État</th></tr></thead>
                  <tbody>
                    {preview.items.slice(0, 60).map((it, i) => (
                      <tr key={i}>
                        <td className="small">{it.student || <span style={{ color: 'var(--bad)' }}>{it.matricule || '—'} ❌</span>}</td>
                        <td className="small">{it.subject}{!it.matched && ' ⚠️'}</td>
                        <td className="c num-td">{it.normal ?? '—'}</td>
                        <td className="c num-td">{it.rattrapage ?? '—'}</td>
                        <td className="c">{it.conflict ? <Chip tone="warn">existe</Chip> : it.matched && it.student_id ? <Chip tone="ok">OK</Chip> : <Chip tone="bad">ignoré</Chip>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {preview.total > 60 && <p className="tiny muted">… {preview.total - 60} ligne(s) supplémentaires non affichées.</p>}
            </>
          )}

          {preview.conflicts?.message && (
            <div className="banner warn" style={{ margin: '10px 0' }}>⚠️ {preview.conflicts.message}
              {mode === 'structure' && <label className="row tiny" style={{ gap: 6, marginTop: 6 }}><input type="checkbox" checked={overwrite === 'overwrite'} onChange={(e) => setOverwrite(e.target.checked ? 'overwrite' : 'skip')} /> J’accepte de remplacer la structure existante</label>}
              {mode === 'grades' && (
                <Field label="En cas de note existante">
                  <div className="segments sm" style={{ marginTop: 4 }}>
                    <button className={overwrite === 'skip' ? 'on' : ''} onClick={() => setOverwrite('skip')}>Ignorer les conflits</button>
                    <button className={overwrite === 'overwrite' ? 'on' : ''} onClick={() => setOverwrite('overwrite')}>Écraser</button>
                  </div>
                </Field>
              )}
            </div>
          )}

          <label className="row small" style={{ gap: 8, margin: '12px 0' }}>
            <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} style={{ width: 18, height: 18 }} />
            <span>Je confirme l’import dans la base de données {mode === 'structure' ? (targetName(templates, templateId)) : 'des notes'}.</span>
          </label>
          <Row style={{ gap: 8 }}>
            <button className="btn ghost" style={{ flex: 1 }} onClick={() => setStep(2)}>← Retour</button>
            <button className="btn" style={{ flex: 2 }} disabled={busy || !confirmed || (mode === 'structure' && preview.conflicts && overwrite !== 'overwrite')} onClick={commit}>{busy ? 'Import…' : '✅ Importer maintenant'}</button>
          </Row>
        </Card>
      )}

      {step === 4 && result && (
        <Card>
          <div style={{ textAlign: 'center', padding: '10px 0' }}>
            <div style={{ fontSize: 42 }}>✅</div>
            <h2>Import terminé</h2>
            <p className="small muted">{result.summary}</p>
            <button className="btn subtle" style={{ marginTop: 10 }} onClick={reset}>Nouvel import</button>
          </div>
        </Card>
      )}

      {journal.length > 0 && (
        <>
          <div className="section-title"><h3>Journal des imports</h3></div>
          {journal.slice(0, 6).map((j) => (
            <Card key={j.id} className="tight">
              <Row className="spread">
                <div><strong className="small">{j.filename}</strong><div className="tiny muted">{j.summary || j.mode}</div></div>
                <Chip tone="gray">{j.rows_affected} écriture(s)</Chip>
              </Row>
            </Card>
          ))}
        </>
      )}
    </div>
  );
}

const headerLabels = (sheet) => (sheet?.preview?.[0] || Array.from({ length: 12 }, (_, i) => `colonne ${i + 1}`));
const targetName = (templates, id) => (id ? `dans « ${templates.find((t) => String(t.id) === String(id))?.name} »` : '');
