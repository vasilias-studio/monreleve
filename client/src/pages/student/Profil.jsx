/* Profil.jsx — compte étudiant : informations, scolarité (filière/niveau/année),
 * sécurité (mot de passe), thème, déconnexion. */
import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../../api.js';
import { useApp } from '../../store.jsx';
import { Card, Field, Row, Chip, useToast, Modal } from '../../ui.jsx';

export default function Profil() {
  const { user, setUser, logout, refresh, theme, toggleTheme } = useApp();
  const nav = useNavigate();
  const [toast, showToast] = useToast();
  const [opts, setOpts] = useState({ programs: [], levels: [], years: [] });
  const [enr, setEnr] = useState({ program_id: '', level_id: '', academic_year_id: '' });
  const [idn, setIdn] = useState({ first_name: user?.first_name || '', last_name: user?.last_name || '' });
  const [pwOpen, setPwOpen] = useState(false);
  const [pw, setPw] = useState({ old_password: '', password: '', confirm: '' });

  useEffect(() => {
    api('/auth/options').then((o) => {
      setOpts(o);
      const st = user?.student || {};
      setEnr({ program_id: st.program_id ? String(st.program_id) : '', level_id: st.level_id ? String(st.level_id) : '', academic_year_id: st.academic_year_id ? String(st.academic_year_id) : '' });
    });
  }, [user]);

  const saveEnrollment = async () => {
    try {
      await api('/student/enrollment', { method: 'PUT', body: { program_id: enr.program_id || null, level_id: enr.level_id || null, academic_year_id: enr.academic_year_id || null } });
      await refresh();
      showToast('Scolarité mise à jour ✓');
    } catch (e) { showToast('⚠️ ' + e.message); }
  };
  const saveIdentity = async () => {
    try {
      await api('/auth/me', { method: 'PUT', body: idn });
      await refresh();
      showToast('Profil enregistré ✓');
    } catch (e) { showToast('⚠️ ' + e.message); }
  };
  const savePassword = async () => {
    if (pw.password !== pw.confirm) { showToast('⚠️ La confirmation ne correspond pas'); return; }
    try {
      await api('/auth/me', { method: 'PUT', body: { old_password: pw.old_password, password: pw.password } });
      setPwOpen(false); setPw({ old_password: '', password: '', confirm: '' });
      showToast('Mot de passe modifié ✓');
    } catch (e) { showToast('⚠️ ' + e.message); }
  };

  const st = user?.student || {};
  return (
    <div className="fade">
      {toast}
      <Card>
        <Row style={{ gap: 14 }}>
          <div className="avatar" style={{ width: 56, height: 56, borderRadius: 18, fontSize: 19 }}>
            {(st && user ? (user.first_name || '?')[0] : '?')}{(user?.last_name || '')[0]}
          </div>
          <div className="grow">
            <h2>{user?.first_name} {user?.last_name}</h2>
            <div className="small muted">{user?.email}</div>
            <div className="row" style={{ gap: 6, marginTop: 6, flexWrap: 'wrap' }}>
              {st.matricule && <Chip tone="gray">Matricule {st.matricule}</Chip>}
              {st.year && <Chip tone="gray">{st.year}</Chip>}
            </div>
          </div>
        </Row>
      </Card>

      <div className="section-title"><h3>Scolarité</h3></div>
      <Card>
        <Field label="Filière">
          <select className="input" value={enr.program_id} onChange={(e) => setEnr({ ...enr, program_id: e.target.value })}>
            <option value="">— Non définie —</option>
            {opts.programs.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </Field>
        <div className="grid2">
          <Field label="Niveau">
            <select className="input" value={enr.level_id} onChange={(e) => setEnr({ ...enr, level_id: e.target.value })}>
              <option value="">— —</option>
              {opts.levels.map((l) => <option key={l.id} value={l.id}>{l.name} · {l.cycle}</option>)}
            </select>
          </Field>

        </div>
        <Field label="Année universitaire">
          <select className="input" value={enr.academic_year_id} onChange={(e) => setEnr({ ...enr, academic_year_id: e.target.value })}>
            <option value="">— —</option>
            {opts.years.map((y) => <option key={y.id} value={y.id}>{y.label}{y.is_current ? ' (en cours)' : ''}</option>)}
          </select>
        </Field>
        <button className="btn subtle" onClick={saveEnrollment}>Mettre à jour ma scolarité</button>
        <p className="tiny muted" style={{ marginTop: 8 }}>Votre relevé est rechargé automatiquement selon le modèle de votre filière + niveau + année.</p>
      </Card>

      <div className="section-title"><h3>Identité</h3></div>
      <Card>
        <div className="grid2">
          <Field label="Prénom"><input className="input" value={idn.first_name} onChange={(e) => setIdn({ ...idn, first_name: e.target.value })} /></Field>
          <Field label="Nom"><input className="input" value={idn.last_name} onChange={(e) => setIdn({ ...idn, last_name: e.target.value })} /></Field>
        </div>
        <button className="btn subtle" onClick={saveIdentity}>Enregistrer</button>
      </Card>

      <div className="section-title"><h3>Préférences & sécurité</h3></div>
      <Card className="stack">
        <Row className="spread">
          <div><strong className="small">Apparence</strong><div className="tiny muted">Mode clair / sombre</div></div>
          <button className="btn xs ghost" onClick={toggleTheme}>{theme === 'dark' ? '☀️ Clair' : '🌙 Sombre'}</button>
        </Row>
        <Row className="spread">
          <div><strong className="small">Mot de passe</strong><div className="tiny muted">Modifier mon mot de passe</div></div>
          <button className="btn xs ghost" onClick={() => setPwOpen(true)}>Changer</button>
        </Row>
        <Row className="spread">
          <div><strong className="small">Session</strong><div className="tiny muted">Déconnexion de cet appareil</div></div>
          <button className="btn xs danger" onClick={() => { logout(); nav('/login'); }}>Se déconnecter</button>
        </Row>
      </Card>

      <Modal open={pwOpen} onClose={() => setPwOpen(false)} title="Nouveau mot de passe">
        <div className="stack">
          <Field label="Mot de passe actuel"><input className="input" type="password" value={pw.old_password} onChange={(e) => setPw({ ...pw, old_password: e.target.value })} /></Field>
          <Field label="Nouveau mot de passe"><input className="input" type="password" value={pw.password} onChange={(e) => setPw({ ...pw, password: e.target.value })} /></Field>
          <Field label="Confirmation"><input className="input" type="password" value={pw.confirm} onChange={(e) => setPw({ ...pw, confirm: e.target.value })} /></Field>
          <button className="btn" onClick={savePassword}>Valider</button>
        </div>
      </Modal>
    </div>
  );
}
