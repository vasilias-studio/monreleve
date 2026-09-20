import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { TopBar } from '../App.jsx';
import { Field } from '../ui.jsx';

export default function Forgot() {
  const [email, setEmail] = useState('');
  const [stage, setStage] = useState(1);
  const [token, setToken] = useState('');
  const [pw, setPw] = useState('');
  const [msg, setMsg] = useState(null);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);

  const askReset = async (e) => {
    e.preventDefault(); setErr(null); setBusy(true);
    try {
      const d = await api('/auth/forgot', { method: 'POST', body: { email } });
      if (d.demo_token) { setToken(d.demo_token); setStage(2); setMsg(d.message); }
      else { setMsg(d.message); setStage(2); }
    } catch (e2) { setErr(e2.message); } finally { setBusy(false); }
  };
  const doReset = async (e) => {
    e.preventDefault(); setErr(null); setBusy(true);
    try {
      await api('/auth/reset', { method: 'POST', body: { token, password: pw } });
      setStage(3);
    } catch (e2) { setErr(e2.message); } finally { setBusy(false); }
  };

  return (
    <>
      <TopBar />
      <div className="auth-wrap">
        <div className="auth-hero">
          <div className="logo-dot" style={{ width: 58, height: 58, borderRadius: 19, fontSize: 24 }}>🔑</div>
          <h1>Mot de passe oublié</h1>
          <p className="muted small" style={{ margin: '4px 0 0' }}>
            {stage === 1 && 'Saisissez votre e-mail, nous vous enverrons un lien de réinitialisation.'}
            {stage === 2 && 'Collez le jeton reçu puis choisissez un nouveau mot de passe.'}
            {stage === 3 && 'Votre mot de passe a été mis à jour.'}
          </p>
        </div>
        <div className="auth-card">
          {err && <div className="banner bad" style={{ marginBottom: 12 }}>⚠️ {err}</div>}
          {msg && <div className="banner info" style={{ marginBottom: 12 }}>{msg}</div>}
          {stage === 1 && (
            <form onSubmit={askReset}>
              <Field label="Adresse e-mail"><input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required /></Field>
              <button className="btn" disabled={busy}>{busy ? 'Envoi…' : 'Envoyer le lien'}</button>
            </form>
          )}
          {stage === 2 && (
            <form onSubmit={doReset}>
              <Field label="Jeton de réinitialisation"><input className="input" value={token} onChange={(e) => setToken(e.target.value)} required /></Field>
              <Field label="Nouveau mot de passe"><input className="input" type="password" value={pw} onChange={(e) => setPw(e.target.value)} placeholder="6 caractères minimum" required /></Field>
              <button className="btn" disabled={busy}>{busy ? 'Enregistrement…' : 'Définir le mot de passe'}</button>
            </form>
          )}
          {stage === 3 && (
            <div style={{ textAlign: 'center' }}>
              <div style={{ fontSize: 40, marginBottom: 8 }}>✅</div>
              <Link to="/login" className="btn" style={{ textDecoration: 'none', margin: '8px 0 14px', display: 'flex' }}>Retour à la connexion</Link>
            </div>
          )}
          <p className="small muted" style={{ textAlign: 'center', margin: '14px 0 0' }}>
            <Link to="/login" className="link-btn">← Retour</Link>
          </p>
        </div>
      </div>
    </>
  );
}
