/* Templates.jsx — liste des modèles de relevés + création (Filière → Niveau → Année). */
import React, { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api.js';
import { Card, Row, Chip, Modal, Field, Spinner, useToast, Empty } from '../../ui.jsx';

export default function Templates() {
  const [rows, setRows] = useState(null);
  const [opts, setOpts] = useState({ programs: [], levels: [], years: [] });
  const [creating, setCreating] = useState(false);
  const [toast, showToast] = useToast();
  const load = useCallback(() => api('/admin/templates').then(setRows).catch((e) => showToast(e.message)), []);
  useEffect(() => { load(); api('/auth/options').then(setOpts); }, [load]);

  return (
    <div className="fade">
      {toast}
      <Row className="spread" style={{ marginBottom: 12 }}>
        <div><h1 style={{ fontSize: 20 }}>Modèles de relevés</h1>
          <p className="tiny muted" style={{ margin: '2px 0 0' }}>Filière → Niveau → Année → Semestres → UE → Matières</p></div>
        <button className="btn sm" style={{ width: 'auto' }} onClick={() => setCreating(true)}>+ Nouveau modèle</button>
      </Row>
      {!rows ? <Spinner /> : rows.length === 0 ? (
        <Empty icon="🗂" title="Aucun modèle">Créez un modèle ou importez un fichier Excel de relevé.</Empty>
      ) : rows.map((t) => (
        <Link key={t.id} to={'/admin/modeles/' + t.id} className="list-item" style={{ textDecoration: 'none', color: 'inherit' }}>
          <div className="avatar" style={{ background: 'var(--grad)', color: '#fff' }}>{t.level?.[0] || 'L'}</div>
          <div className="grow">
            <strong className="small">{t.name}</strong>
            <div className="tiny muted">{t.year} · {t.n_semesters} semestre(s) · {t.n_units} UE · {t.n_courses} matière(s)</div>
          </div>
          <Chip tone={t.n_courses ? 'ok' : 'warn'}>{t.n_courses ? 'Prêt' : 'À compléter'}</Chip>
        </Link>
      ))}
      <CreateTemplate open={creating} onClose={() => setCreating(false)} opts={opts} onDone={() => { showToast('Modèle créé ✓'); setCreating(false); load(); }} toast={showToast} />
    </div>
  );
}

function CreateTemplate({ open, onClose, opts, onDone, toast }) {
  const [f, setF] = useState({ name: '', program_id: '', level_id: '', academic_year_id: '' });
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    try { await api('/admin/templates', { method: 'POST', body: f }); onDone(); }
    catch (e) { toast('⚠️ ' + e.message); } finally { setBusy(false); }
  };
  return (
    <Modal open={open} onClose={onClose} title="Nouveau modèle de relevé">
      <div className="stack">
        <div className="grid2">
          <Field label="Filière"><select className="input" value={f.program_id} onChange={(e) => setF({ ...f, program_id: e.target.value })}><option value="">—</option>{opts.programs.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></Field>
          <Field label="Niveau"><select className="input" value={f.level_id} onChange={(e) => setF({ ...f, level_id: e.target.value })}><option value="">—</option>{opts.levels.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select></Field>
        </div>
        <Field label="Année universitaire"><select className="input" value={f.academic_year_id} onChange={(e) => setF({ ...f, academic_year_id: e.target.value })}><option value="">—</option>{opts.years.map((y) => <option key={y.id} value={y.id}>{y.label}</option>)}</select></Field>
        <Field label="Nom (optionnel)"><input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="ex : L3 — Gestion — 2026-2027" /></Field>
        <button className="btn" disabled={busy || !f.program_id || !f.level_id || !f.academic_year_id} onClick={submit}>{busy ? 'Création…' : 'Créer le modèle'}</button>
      </div>
    </Modal>
  );
}
