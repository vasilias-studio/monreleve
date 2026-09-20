import React, { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api.js';
import { useApp } from '../store.jsx';
import { TopBar } from '../App.jsx';
import { Field } from '../ui.jsx';

export default function Register() {
  const { register } = useApp();
  const nav = useNavigate();
  const [opts, setOpts] = useState({ programs: [], levels: [], years: [], classes: [] });
  const [f, setF] = useState({ first_name: '', last_name: '', matricule: '', email: '', password: '', program_id: '', level_id: '', class_id: '', academic_year_id: '' });
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api('/auth/options').then((o) => {
      setOpts(o);
      const cur = o.years.find((y) => y.is_current);
      setF((x) => ({ ...x, academic_year_id: cur ? String(cur.id) : (o.years[0] ? String(o.years[0].id) : '') }));
    }).catch(() => {});
  }, []);

  const classes = useMemo(() => opts.classes.filter((c) =>
    (!f.program_id || c.program_id === +f.program_id) && (!f.level_id || c.level_id === +f.level_id)
  ), [opts, f.program_id, f.level_id]);

  const set = (k) => (e) => setF({ ...f, [k]: e.target.value, ...(k === 'program_id' || k === 'level_id' ? { class_id: '' } : {}) });

  const submit = async (e) => {
    e.preventDefault(); setErr(null); setBusy(true);
    try {
      await register({ ...f, program_id: f.program_id || null, level_id: f.level_id || null, class_id: f.class_id || null, academic_year_id: f.academic_year_id || null });
      nav('/accueil');
    } catch (e2) { setErr(e2.message); } finally { setBusy(false); }
  };

  return (
    <>
      <TopBar />
      <div className="auth-wrap">
        <div className="auth-hero">
          <div className="logo-dot" style={{ width: 58, height: 58, borderRadius: 19, fontSize: 24 }}>MR</div>
          <h1>Créer mon compte</h1>
          <p className="muted small" style={{ margin: '4px 0 0' }}>Étudiant · votre relevé sera associé automatiquement à votre modèle</p>
        </div>
        <form className="auth-card" onSubmit={submit}>
          {err && <div className="banner bad" style={{ marginBottom: 12 }}>⚠️ {err}</div>}
          <div className="grid2">
            <Field label="Prénom"><input className="input" value={f.first_name} onChange={set('first_name')} required /></Field>
            <Field label="Nom"><input className="input" value={f.last_name} onChange={set('last_name')} required /></Field>
          </div>
          <Field label="Matricule"><input className="input" value={f.matricule} onChange={set('matricule')} placeholder="ex : 2026-GES-0142" required /></Field>
          <Field label="Adresse e-mail"><input className="input" type="email" value={f.email} onChange={set('email')} required /></Field>
          <Field label="Mot de passe"><input className="input" type="password" value={f.password} onChange={set('password')} placeholder="6 caractères minimum" required /></Field>
          <div className="divider" />
          <Field label="Filière">
            <select className="input" value={f.program_id} onChange={set('program_id')} required>
              <option value="">— Choisir —</option>
              {opts.programs.map((p) => <option key={p.id} value={p.id}>{p.name}{p.code ? ` (${p.code})` : ''}</option>)}
            </select>
          </Field>
          <div className="grid2">
            <Field label="Niveau">
              <select className="input" value={f.level_id} onChange={set('level_id')} required>
                <option value="">— Niveau —</option>
                {opts.levels.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
              </select>
            </Field>
            <Field label="Classe / groupe">
              <select className="input" value={f.class_id} onChange={set('class_id')}>
                <option value="">— Aucune —</option>
                {classes.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </Field>
          </div>
          <button className="btn" disabled={busy}>{busy ? 'Création…' : 'Créer mon compte'}</button>
          <p className="small muted" style={{ textAlign: 'center', margin: '14px 0 0' }}>
            Déjà inscrit ? <Link to="/login" className="link-btn">Se connecter</Link>
          </p>
        </form>
      </div>
    </>
  );
}
