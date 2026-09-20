/* Dashboard.jsx — vue d'ensemble administrateur. */
import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, download } from '../../api.js';
import { Card, Row, Chip, Spinner } from '../../ui.jsx';
import { useApp } from '../../store.jsx';

export default function Dashboard() {
  const { user } = useApp();
  const [stats, setStats] = useState(null);
  const [err, setErr] = useState(null);
  useEffect(() => { api('/admin/stats').then(setStats).catch((e) => setErr(e.message)); }, []);
  if (err) return <div className="banner bad">⚠️ {err}</div>;
  if (!stats) return <Spinner />;
  const tile = (label, value, tone) => (
    <div className={`stat ${tone || ''}`}><div className="v">{value}</div><div className="k">{label}</div></div>
  );
  return (
    <div className="fade">
      <Card className="hero" style={{ marginBottom: 14 }}>
        <Row className="spread">
          <div>
            <div className="small" style={{ opacity: .85 }}>Console scolarité</div>
            <h1 style={{ color: '#fff', fontSize: 21 }}>Bonjour {user?.first_name || 'Admin'} 👋</h1>
            <p className="small" style={{ margin: '6px 0 0', color: 'rgba(255,255,255,.85)', maxWidth: 420 }}>
              Gérez les modèles de relevés, corrigez les notes officielles et publiez les résultats par semestre.
            </p>
          </div>
          <div style={{ textAlign: 'right' }}>
            <div style={{ fontSize: 44, fontWeight: 850, lineHeight: 1 }}>{stats.students}</div>
            <div className="tiny" style={{ color: 'rgba(255,255,255,.8)' }}>étudiants inscrits</div>
          </div>
        </Row>
      </Card>

      <div className="grid4" style={{ marginBottom: 6 }}>
        {tile('Filières', stats.programs)}
        {tile('Niveaux', stats.levels)}
        {tile('Modèles actifs', stats.templates)}
        {tile('Semestres publiés', stats.published, 'ok')}
      </div>

      <div className="row wrap" style={{ gap: 8, margin: '10px 0 16px' }}>
        <Link className="btn sm subtle" to="/admin/etudiants" style={{ textDecoration: 'none' }}>👥 Étudiants</Link>
        <Link className="btn sm subtle" to="/admin/modeles" style={{ textDecoration: 'none' }}>🗂 Modèles</Link>
        <Link className="btn sm subtle" to="/admin/import" style={{ textDecoration: 'none' }}>📥 Import Excel</Link>
        <a className="btn sm ghost" href="#/admin/referentiels">⚙️ Référentiels</a>
        <ExportBtn />
      </div>

      <div className="section-title"><h3>Répartition par filière</h3></div>
      <Card>
        {stats.byProgram.length === 0 && <p className="muted small">Aucun étudiant pour le moment.</p>}
        {(() => {
          const max = Math.max(...stats.byProgram.map((x) => x.n), 1);
          return stats.byProgram.map((x) => (
            <div key={x.name} style={{ marginBottom: 10 }}>
              <Row className="spread" style={{ marginBottom: 4 }}>
                <strong className="small">{x.name}</strong><span className="tiny num-td">{x.n}</span>
              </Row>
              <div className="bar"><i style={{ width: Math.round((x.n / max) * 100) + '%' }} /></div>
            </div>
          ));
        })()}
      </Card>

      <div className="section-title"><h3>Derniers inscrits</h3></div>
      {stats.recent.map((s) => (
        <Link key={s.id} to={'/admin/etudiants/' + s.id} className="list-item" style={{ textDecoration: 'none', color: 'inherit' }}>
          <div className="avatar">{(s.first_name || '?')[0]}{(s.last_name || '')[0]}</div>
          <div className="grow">
            <strong className="small">{s.first_name} {s.last_name}</strong>
            <div className="tiny muted">{s.email} · {s.matricule}</div>
          </div>
          <div style={{ textAlign: 'right' }}>
            <div className="tiny" style={{ fontWeight: 700 }}>{s.level}</div>
            <div className="tiny muted">{s.program}</div>
          </div>
        </Link>
      ))}
    </div>
  );
}

function ExportBtn() {
  return (
    <button className="btn sm ghost" onClick={() => download('/admin/export/students.csv', 'etudiants.csv')}>⬇️ Export CSV</button>
  );
}
