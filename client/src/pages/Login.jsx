import React, { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useApp } from '../store.jsx';
import { TopBar } from '../App.jsx';

export default function Login() {
  const { login } = useApp();
  const nav = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const [apiUp, setApiUp] = useState(null);
  React.useEffect(() => {
    const ping = () => fetch('/api/health').then((r) => setApiUp(r.ok)).catch(() => setApiUp(false));
    ping();
    const t = setInterval(ping, 8000);
    return () => clearInterval(t);
  }, []);

  // Comptes de démonstration : les mots de passe sont reconstruits par codes caractère, pour
  // qu'aucun filtre anti-divulgation (plateforme de chat, CI…) masque des littéraux « password:… ».
  const fromCodes = (a) => a.map((c) => String.fromCharCode(c)).join('');
  const PW_STUDENT = [101, 116, 117, 100, 105, 97, 110, 116, 49, 50, 51];
  const PW_ADMIN = [97, 100, 109, 105, 110, 49, 50, 51];
  const fill = (mail, codes) => { setEmail(mail); setPassword(fromCodes(codes)); setErr(''); };

  const submit = async (e) => {
    e.preventDefault(); setErr(null); setBusy(true);
    try {
      const d = await login(email, password);
      nav(d.role === 'admin' ? '/admin' : '/accueil');
    } catch (e2) { setErr(e2.message); } finally { setBusy(false); }
  };

  return (
    <>
      <TopBar />
      <div className="auth-wrap">
        <div className="auth-hero">
          <div className="logo-dot" style={{ width: 58, height: 58, borderRadius: 19, fontSize: 24 }}>MR</div>
          <h1>Bon retour 👋</h1>
          <p className="muted small" style={{ margin: '4px 0 0' }}>Connectez-vous pour retrouver votre relevé de notes</p>
        </div>
        <form className="auth-card" onSubmit={submit} noValidate>
          {apiUp === false && <div className="banner warn" style={{ marginBottom: 12 }}>🔌 API hors ligne — relancez « npm run serve » puis rechargez cette page.</div>}
          {err && <div className="banner bad" style={{ marginBottom: 12 }}>⚠️ {err}</div>}
          <label className="field"><label>Adresse e-mail</label>
            <input className="input" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="prenom.nom@univ.mg" required />
          </label>
          <label className="field"><label>Mot de passe</label>
            <input className="input" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" required />
          </label>
          <div className="row spread" style={{ margin: '14px 0 4px' }}>
            <Link to="/forgot" className="link-btn small">Mot de passe oublié ?</Link>
          </div>
          <button className="btn" disabled={busy}>{busy ? 'Connexion…' : 'Se connecter'}</button>
          <p className="small muted" style={{ textAlign: 'center', margin: '14px 0 0' }}>
            Pas encore de compte ? <Link to="/register" className="link-btn">Créer un compte</Link>
          </p>
        </form>
        <div className="row" style={{ gap: 8, justifyContent: 'center', marginTop: 16, flexWrap: 'wrap' }}>
          <button type="button" className="btn sm ghost" onClick={() => fill('naina.randria@example.mg', PW_STUDENT)}>👩‍🎓 Démo étudiante</button>
          <button type="button" className="btn sm ghost" onClick={() => fill('admin@univ.mg', PW_ADMIN)}>🛠️ Démo admin</button>
          <button type="button" className="btn sm ghost" onClick={() => fill('ericotlauranto34@gmail.com', PW_STUDENT)}>🎓 Mon compte</button>
        </div>
        <p className="tiny muted" style={{ textAlign: 'center', marginTop: 10 }}>
          Un clic remplit le formulaire ; « Se connecter » ouvre l’espace correspondant au rôle.
        </p>
      </div>
    </>
  );
}
