/* Students.jsx — liste + recherche + création d'étudiants par l'admin. */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api.js';
import { Card, Row, Chip, Modal, Field, Spinner, useToast, SearchBar, Empty } from '../../ui.jsx';

export default function Students() {
  const [q, setQ] = useState('');
  const [filters, setFilters] = useState({ program_id: '', level_id: '' });
  const [rows, setRows] = useState(null);
  const [opts, setOpts] = useState({ programs: [], levels: [], years: [], classes: [] });
  const [creating, setCreating] = useState(false);
  const [toast, showToast] = useToast();
  const [err, setErr] = useState(null);

  const load = useCallback(() => {
    const params = new URLSearchParams({ ...(q ? { q } : {}), ...Object.fromEntries(Object.entries(filters).filter(([, v]) => v)) });
    api('/admin/students?' + params).then(setRows).catch((e) => setErr(e.message));
  }, [q, filters]);
  useEffect(() => { const t = setTimeout(load, 250); return () => clearTimeout(t); }, [load]);
  useEffect(() => { api('/auth/options').then(setOpts); }, []);

  return (
    <div className="fade">
      {toast}
      <Row className="spread" style={{ marginBottom: 10 }}>
        <h1 style={{ fontSize: 20 }}>Étudiants <span className="muted" style={{ fontSize: 14, fontWeight: 600 }}>({rows?.length ?? '…'})</span></h1>
        <button className="btn sm" style={{ width: 'auto' }} onClick={() => setCreating(true)}>+ Nouvel inscrit</button>
      </Row>
      <SearchBar value={q} onChange={setQ} placeholder="Nom, matricule ou e-mail…" />
      <div className="row" style={{ gap: 8, margin: '8px 0 12px' }}>
        <select className="input sm" value={filters.program_id} onChange={(e) => setFilters({ ...filters, program_id: e.target.value })} style={{ flex: 1 }}>
          <option value="">Toutes filières</option>
          {opts.programs.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <select className="input sm" value={filters.level_id} onChange={(e) => setFilters({ ...filters, level_id: e.target.value })} style={{ flex: 1 }}>
          <option value="">Tous niveaux</option>
          {opts.levels.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
        </select>
      </div>
      {err && <div className="banner bad">⚠️ {err}</div>}
      {!rows ? <Spinner /> : rows.length === 0 ? (
        <Empty icon="🔎" title="Aucun étudiant trouvé">Ajustez la recherche ou inscrivez un étudiant.</Empty>
      ) : rows.map((s) => (
        <Link key={s.id} to={'/admin/etudiants/' + s.id} className="list-item" style={{ textDecoration: 'none', color: 'inherit' }}>
          <div className="avatar">{(s.first_name || '?')[0]}{(s.last_name || '')[0]}</div>
          <div className="grow">
            <strong className="small">{s.last_name} {s.first_name}</strong>
            <div className="tiny muted">{s.matricule} · {s.email}</div>
          </div>
          <div style={{ textAlign: 'right' }}>
            <div className="tiny" style={{ fontWeight: 700 }}>{s.level} — {s.program}</div>
            <div className="tiny muted">{s.class || 'sans classe'}</div>
          </div>
          {!s.is_active && <Chip tone="bad">Désactivé</Chip>}
        </Link>
      ))}
      <CreateStudent open={creating} onClose={() => setCreating(false)} opts={opts} onDone={(m) => { showToast(m); setCreating(false); load(); }} toast={showToast} />
    </div>
  );
}

function CreateStudent({ open, onClose, opts, onDone, toast }) {
  const [f, setF] = useState({ first_name: '', last_name: '', email: '', matricule: '', password: '', program_id: '', level_id: '', class_id: '', academic_year_id: '' });
  const [busy, setBusy] = useState(false);
  const classes = useMemo(() => opts.classes.filter((c) => (!f.program_id || c.program_id === +f.program_id) && (!f.level_id || c.level_id === +f.level_id)), [opts, f]);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const submit = async () => {
    setBusy(true);
    try {
      const r = await api('/admin/students', { method: 'POST', body: { ...f, program_id: f.program_id || null, level_id: f.level_id || null, class_id: f.class_id || null, academic_year_id: f.academic_year_id || (opts.years.find((y) => y.is_current) || {}).id || null } });
      onDone(r.generated_password ? `Étudiant créé — mot de passe provisoire : ${r.generated_password}` : 'Étudiant créé ✓');
      setF({ first_name: '', last_name: '', email: '', matricule: '', password: '', program_id: '', level_id: '', class_id: '', academic_year_id: '' });
    } catch (e) { toast('⚠️ ' + e.message); } finally { setBusy(false); }
  };
  return (
    <Modal open={open} onClose={onClose} title="Inscrire un étudiant">
      <div className="stack">
        <div className="grid2">
          <Field label="Prénom"><input className="input" value={f.first_name} onChange={set('first_name')} /></Field>
          <Field label="Nom"><input className="input" value={f.last_name} onChange={set('last_name')} /></Field>
        </div>
        <Field label="Matricule"><input className="input" value={f.matricule} onChange={set('matricule')} /></Field>
        <Field label="E-mail"><input className="input" type="email" value={f.email} onChange={set('email')} /></Field>
        <Field label="Mot de passe (vide = provisoire)"><input className="input" value={f.password} onChange={set('password')} placeholder="etudiant123" /></Field>
        <Field label="Filière">
          <select className="input" value={f.program_id} onChange={set('program_id')}>
            <option value="">— —</option>
            {opts.programs.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </Field>
        <div className="grid2">
          <Field label="Niveau">
            <select className="input" value={f.level_id} onChange={set('level_id')}>
              <option value="">— —</option>
              {opts.levels.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
            </select>
          </Field>
          <Field label="Classe">
            <select className="input" value={f.class_id} onChange={set('class_id')}>
              <option value="">— —</option>
              {classes.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </Field>
        </div>
        <button className="btn" disabled={busy} onClick={submit}>{busy ? 'Création…' : 'Créer le compte'}</button>
      </div>
    </Modal>
  );
}
