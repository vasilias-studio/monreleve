/* TemplateEditor.jsx — édition complète d'un modèle :
 * métadonnées, règles de calcul (aucun coefficient codé en dur côté écran),
 * semestres → UE → matières (ajout/édition/suppression), publication par semestre. */
import React, { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, download } from '../../api.js';
import { Card, Row, Chip, Spinner, useToast, Modal, Field, PubChip, fmtDate } from '../../ui.jsx';

const RULE_OPTIONS = {
  final_grade_rule: [
    ['max_normal_rattrapage', 'Définitive = MAX(Normale, Rattrapage)'],
    ['normal_then_rattrapage', 'Le rattrapage remplace la normale'],
    ['weighted', 'Moyenne pondérée Normale / Rattrapage'],
  ],
  ue_average_method: [['simple', 'Moyenne simple des matières de l’UE'], ['coefficient_weighted', 'Pondérée par les coefficients']],
  semester_average_method: [['ue_simple_mean', 'Moyenne simple des moyennes d’UE'], ['ue_credit_weighted', 'Pondérée par les crédits des UE'], ['course_weighted', 'Pondérée par les coefficients (toutes matières)']],
  general_average_method: [['semester_mean', 'Moyenne des moyennes de semestre'], ['credit_weighted_semesters', 'Pondérée par les crédits de semestre']],
  credit_validation_basis: [['normal', 'Crédits acquis si NOTE NORMALE ≥ seuil'], ['definitive', 'Crédits acquis si note DÉFINITIVE ≥ seuil']],
};

export default function TemplateEditor() {
  const { id } = useParams();
  const nav = useNavigate();
  const [t, setT] = useState(null);
  const [toast, showToast] = useToast();
  const load = useCallback(() => api('/admin/templates/' + id).then(setT).catch((e) => { showToast(e.message); if (!t) nav('/admin/modeles'); }), [id]);
  useEffect(load, [load]);

  if (!t) return <Spinner />;
  const refresh = () => load();

  return (
    <div className="fade">
      {toast}
      <Row style={{ marginBottom: 10 }}>
        <Link to="/admin/modeles" className="btn xs ghost">← Modèles</Link>
        <div className="grow" />
        <button className="btn xs subtle" onClick={() => downloadCsv(id)}>⬇️ Export structure</button>
        <button className="btn xs danger" onClick={async () => { if (confirm('Supprimer ce modèle, ses semestres, UE et matières ? (les notes saisies seront perdues)')) { await api('/admin/templates/' + id, { method: 'DELETE', body: { confirm: true } }); nav('/admin/modeles'); } }}>🗑 Supprimer</button>
      </Row>

      <Card>
        <MetaForm t={t} onSaved={refresh} toast={showToast} />
      </Card>

      <RulesForm t={t} onSaved={refresh} toast={showToast} />

      <div className="section-title"><h2>Semestres</h2>
        <AddBtn label="+ Semestre" onAdd={async (v) => { const n = prompt('Numéro du semestre (ex : 5) :', String(t.semesters.length + 1)); if (!n) return; await api(`/admin/templates/${id}/semesters`, { method: 'POST', body: { number: n, name: 'Semestre ' + n, ects_expected: v } }); refresh(); }} placeholder="30" /></div>

      {t.semesters.map((s) => (
        <SemesterBlock key={s.id} sem={s} template={t} onChanged={refresh} toast={showToast} />
      ))}
    </div>
  );
}

function downloadCsv(templateId) {
  download('/admin/export/template/' + templateId + '.csv', 'modele-structure.csv');
}

/* ---------- métadonnées ---------- */
function MetaForm({ t, onSaved, toast }) {
  const [opts, setOpts] = useState(null);
  const [f, setF] = useState({ name: t.name, program_id: String(t.program_id), level_id: String(t.level_id), academic_year_id: String(t.academic_year_id) });
  useEffect(() => { api('/auth/options').then(setOpts); }, []);
  const save = async () => {
    try { await api('/admin/templates/' + t.id, { method: 'PUT', body: f }); toast('Enregistré ✓'); onSaved(); } catch (e) { toast('⚠️ ' + e.message); }
  };
  return (
    <div>
      <h2>{t.program} — {t.level}</h2>
      <p className="tiny muted" style={{ margin: '3px 0 10px' }}>Mis à jour {t.updated_at ? fmtDate(t.updated_at) : 'à la création'}</p>
      {!opts ? <Row><Chip tone="gray">Chargement…</Chip></Row> : (
        <div className="grid3" style={{ gap: 8 }}>
          <Field label="Filière"><select className="input sm" value={f.program_id} onChange={(e) => setF({ ...f, program_id: e.target.value })}>{opts.programs.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></Field>
          <Field label="Niveau"><select className="input sm" value={f.level_id} onChange={(e) => setF({ ...f, level_id: e.target.value })}>{opts.levels.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select></Field>
          <Field label="Année"><select className="input sm" value={f.academic_year_id} onChange={(e) => setF({ ...f, academic_year_id: e.target.value })}>{opts.years.map((y) => <option key={y.id} value={y.id}>{y.label}</option>)}</select></Field>
        </div>
      )}
      <Field label="Nom du modèle"><input className="input sm" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
      <button className="btn sm subtle" onClick={save}>Enregistrer les métadonnées</button>
    </div>
  );
}

/* ---------- règles de calcul ---------- */
function RulesForm({ t, onSaved, toast }) {
  const [r, setR] = useState({ ...t.rules });
  const [open, setOpen] = useState(false);
  const save = async () => {
    try { await api('/admin/templates/' + t.id, { method: 'PUT', body: { rules: r } }); toast('Règles enregistrées ✓'); setOpen(false); onSaved(); } catch (e) { toast('⚠️ ' + e.message); }
  };
  const sel = (key) => (
    <Field label={LABELS[key]}>
      <select className="input sm" value={r[key] ?? ''} onChange={(e) => setR({ ...r, [key]: isNaN(e.target.value) ? e.target.value : Number(e.target.value) })}>
        {RULE_OPTIONS[key].map(([v, l]) => <option key={v} value={v}>{l}</option>)}
      </select>
    </Field>
  );
  const LABELS = {
    final_grade_rule: 'Note définitive',
    ue_average_method: 'Moyenne d’UE',
    semester_average_method: 'Moyenne de semestre',
    general_average_method: 'Moyenne générale',
    credit_validation_basis: 'Acquisition des crédits',
  };
  return (
    <Card>
      <Row className="spread">
        <div><h3>⚙️ Règles de calcul</h3>
          <div className="tiny muted">Modifiables par modèle — la structure Excel du fichier fourni est reproduite par défaut.</div></div>
        <button className="btn xs ghost" onClick={() => setOpen(!open)}>{open ? 'Fermer' : 'Modifier'}</button>
      </Row>
      {!open && (
        <div className="row wrap" style={{ gap: 6, marginTop: 10 }}>
          <Chip tone="violet">{RULE_OPTIONS.final_grade_rule.find((x) => x[0] === r.final_grade_rule)?.[1] || r.final_grade_rule}</Chip>
          <Chip tone="gray">Seuil : {r.pass_threshold}</Chip>
          <Chip tone="gray">UE : {RULE_OPTIONS.ue_average_method.find((x) => x[0] === r.ue_average_method)?.[1] || r.ue_average_method}</Chip>
          <Chip tone="gray">Semestre : {RULE_OPTIONS.semester_average_method.find((x) => x[0] === r.semester_average_method)?.[1] || r.semester_average_method}</Chip>
          <Chip tone="gray">Crédits : {RULE_OPTIONS.credit_validation_basis.find((x) => x[0] === r.credit_validation_basis)?.[1] || r.credit_validation_basis}</Chip>
        </div>
      )}
      {open && (
        <div style={{ marginTop: 10 }}>
          {sel('final_grade_rule')}
          <div className="grid2">
            <Field label="Seuil de validation"><input className="input sm num" type="number" step="0.5" value={r.pass_threshold} onChange={(e) => setR({ ...r, pass_threshold: Number(e.target.value) })} /></Field>
            <Field label="Plafond rattrapage (vide = aucun)"><input className="input sm num" type="number" step="0.5" placeholder="—" value={r.rattrapage_cap ?? ''} onChange={(e) => setR({ ...r, rattrapage_cap: e.target.value === '' ? null : Number(e.target.value) })} /></Field>
          </div>
          {r.final_grade_rule === 'weighted' && (
            <Field label="Poids du rattrapage (0–1)"><input className="input sm num" type="number" step="0.05" min="0" max="1" value={r.rattrapage_weight} onChange={(e) => setR({ ...r, rattrapage_weight: Number(e.target.value) })} /></Field>
          )}
          {sel('ue_average_method')}
          {sel('semester_average_method')}
          {sel('general_average_method')}
          {sel('credit_validation_basis')}
          <Row style={{ gap: 8 }}>
            <button className="btn sm" style={{ flex: 2 }} onClick={save}>Enregistrer les règles</button>
            <button className="btn sm ghost" style={{ flex: 1 }} onClick={() => { setR({ ...t.rules }); setOpen(false); }}>Annuler</button>
          </Row>
        </div>
      )}
    </Card>
  );
}

/* ---------- semestre → UE → matières ---------- */
function SemesterBlock({ sem, template, onChanged, toast }) {
  const act = async (action) => {
    try { await api(`/admin/semesters/${sem.id}/publication`, { method: 'POST', body: { action } }); toast('Publication mise à jour ✓'); onChanged(); }
    catch (e) { toast('⚠️ ' + e.message); }
  };
  return (
    <details className="acc">
      <summary>
        <span className="chev"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round"><path d="m9 6 6 6-6 6" /></svg></span>
        <div className="grow"><h3>{sem.name}</h3>
          <div className="row" style={{ gap: 6, marginTop: 3 }}>
            <PubChip status={(sem.publication || {}).status || 'draft'} />
            <Chip tone="gray">{sem.units.length} UE</Chip>
            <Chip tone="gray">{sem.units.reduce((a, u) => a + u.courses.length, 0)} matières</Chip>
            <Chip tone="gray">{sem.ects_expected} ECTS</Chip>
          </div>
        </div>
        <div className="row" style={{ gap: 6 }} onClick={(e) => e.preventDefault()}>
          {((sem.publication || {}).status || 'draft') === 'draft' && <button className="btn xs primary" style={{ width: 'auto' }} onClick={() => act('publish')}>Publier</button>}
          {(sem.publication || {}).status === 'published' && <button className="btn xs ghost" style={{ width: 'auto' }} onClick={() => act('lock')}>🔒</button>}
          {(sem.publication || {}).status === 'locked' && <button className="btn xs ghost" style={{ width: 'auto' }} onClick={() => act('unlock')}>🔓</button>}
          <button className="btn xs danger" style={{ width: 'auto' }} onClick={async (e) => { e.stopPropagation(); if (confirm('Supprimer ce semestre et tout son contenu ?')) { await api('/admin/semesters/' + sem.id, { method: 'DELETE' }); onChanged(); } }}>🗑</button>
        </div>
      </summary>
      <div className="acc-body">
        <Row style={{ gap: 6 }}>
          <button className="btn xs subtle" onClick={async () => { const code = prompt('Code de l’UE (ex : UE 16) :'); if (!code) return; await api(`/admin/semesters/${sem.id}/units`, { method: 'POST', body: { code, name: code } }); onChanged(); }}>+ Ajouter une UE</button>
          <button className="btn xs ghost" onClick={async () => { const ects = prompt('Crédits ECTS attendus sur ce semestre :', sem.ects_expected); if (ects == null) return; await api('/admin/semesters/' + sem.id, { method: 'PUT', body: { ects_expected: ects } }); onChanged(); }}>Éditer</button>
        </Row>
        {sem.units.map((u) => <UeBlock key={u.id} ue={u} onChanged={onChanged} toast={toast} />)}
        {sem.units.length === 0 && <p className="small muted" style={{ marginTop: 8 }}>Aucune UE pour l’instant.</p>}
      </div>
    </details>
  );
}

function UeBlock({ ue, onChanged, toast }) {
  const [adding, setAdding] = useState(false);
  const [nf, setNf] = useState({ name: '', coefficient: 1, credits: 2 });
  return (
    <div style={{ border: '1px solid var(--line)', borderRadius: 14, padding: 10, marginTop: 10, background: 'var(--card-2)' }}>
      <Row className="spread">
        <div className="row" style={{ gap: 6 }}>
          <strong style={{ fontSize: 13.5 }}>{ue.code}</strong>
          <button className="btn xs ghost" style={{ padding: '2px 8px', fontSize: 11 }} onClick={async () => { const name = prompt('Nom de l’UE :', ue.name); if (name == null) return; await api('/admin/units/' + ue.id, { method: 'PUT', body: { name, code: ue.code } }); onChanged(); }}>✏️</button>
        </div>
        <div className="row" style={{ gap: 6 }}>
          <Chip tone="gray">{ue.courses.length} matière(s)</Chip>
          <button className="btn xs danger" style={{ padding: '2px 8px', fontSize: 11 }} onClick={async () => { if (confirm('Supprimer cette UE et ses matières ?')) { await api('/admin/units/' + ue.id, { method: 'DELETE' }); onChanged(); } }}>🗑</button>
        </div>
      </Row>
      <div style={{ marginTop: 6 }}>
        {ue.courses.map((c) => (
          <Row key={c.id} style={{ gap: 6, padding: '6px 2px', borderBottom: '1px dashed var(--line)' }}>
            <div className="grow" style={{ minWidth: 0 }}>
              <div style={{ fontSize: 13, fontWeight: 650, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{c.name}</div>
              <div className="tiny muted">coef. {c.coefficient} · {c.credits} crédit(s)</div>
            </div>
            <button className="btn xs ghost" style={{ padding: '3px 8px', fontSize: 11 }} onClick={async () => {
              const name = prompt('Nom de la matière :', c.name); if (name === null) return;
              const coef = prompt('Coefficient :', c.coefficient); if (coef === null) return;
              const cr = prompt('Crédits :', c.credits); if (cr === null) return;
              await api('/admin/courses/' + c.id, { method: 'PUT', body: { name, coefficient: coef, credits: cr } }); onChanged();
            }}>✏️</button>
            <button className="btn xs danger" style={{ padding: '3px 8px', fontSize: 11 }} onClick={async () => { if (confirm('Supprimer cette matière ?')) { await api('/admin/courses/' + c.id, { method: 'DELETE' }); onChanged(); } }}>🗑</button>
          </Row>
        ))}
      </div>
      {adding ? (
        <div style={{ marginTop: 8, background: 'var(--card)', borderRadius: 10, padding: 8 }}>
          <Field label="Nouvelle matière"><input className="input sm" placeholder="Nom de la matière" value={nf.name} onChange={(e) => setNf({ ...nf, name: e.target.value })} /></Field>
          <div className="grid2" style={{ gap: 8 }}>
            <Field label="Coefficient"><input className="input sm num" type="number" step="0.5" value={nf.coefficient} onChange={(e) => setNf({ ...nf, coefficient: e.target.value })} /></Field>
            <Field label="Crédits"><input className="input sm num" type="number" step="0.5" value={nf.credits} onChange={(e) => setNf({ ...nf, credits: e.target.value })} /></Field>
          </div>
          <Row style={{ gap: 6 }}>
            <button className="btn xs" style={{ flex: 2 }} onClick={async () => { if (!nf.name) return; await api('/admin/units/' + ue.id + '/courses', { method: 'POST', body: nf }); setAdding(false); setNf({ name: '', coefficient: 1, credits: 2 }); onChanged(); }}>Ajouter</button>
            <button className="btn xs ghost" style={{ flex: 1 }} onClick={() => setAdding(false)}>Annuler</button>
          </Row>
        </div>
      ) : (
        <button className="btn xs ghost" style={{ marginTop: 6 }} onClick={() => setAdding(true)}>+ Ajouter une matière</button>
      )}
    </div>
  );
}

function AddBtn({ label, onAdd, placeholder }) {
  const [open, setOpen] = useState(false);
  const [v, setV] = useState(placeholder || '');
  return open ? (
    <Row style={{ gap: 6 }}>
      <input className="input sm" style={{ width: 90 }} placeholder={placeholder} value={v} onChange={(e) => setV(e.target.value)} />
      <button className="btn xs" onClick={() => { onAdd(v); setV(''); setOpen(false); }}>OK</button>
      <button className="btn xs ghost" onClick={() => setOpen(false)}>✕</button>
    </Row>
  ) : <button className="btn xs subtle" onClick={() => setOpen(true)}>{label}</button>;
}
