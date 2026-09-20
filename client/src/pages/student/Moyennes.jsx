/* Moyennes.jsx — écran statistiques : moyenne générale, progression par semestre/UE,
 * répartition des statuts, crédits. Tout est calculé côté serveur (source unique de vérité). */
import React, { useEffect, useState } from 'react';
import { api, fmt } from '../../api.js';
import { Card, Chip, Donut, Bar, Row, Spinner, Empty } from '../../ui.jsx';

function Seg({ items, value, onChange }) {
  return (
    <div className="segments" style={{ marginBottom: 12 }}>
      {items.map((it) => (
        <button key={it.id} className={value === it.id ? 'on' : ''} onClick={() => onChange(it.id)}>{it.label}</button>
      ))}
    </div>
  );
}

export default function Moyennes() {
  const [source, setSource] = useState('personal');
  const [stats, setStats] = useState(null);
  const [err, setErr] = useState(null);
  useEffect(() => { api('/student/stats').then(setStats).catch((e) => setErr(e.message)); }, []);
  if (err) return <div className="banner bad">⚠️ {err}</div>;
  if (!stats) return <Spinner />;
  const s = stats[source];
  if (!s) return <Empty icon="📊" title="Pas encore de données" />;
  const hasAny = s.semesters.some((x) => x.average != null);
  const maxAvg = 20;
  const statusTotal = Object.values(s.counts).reduce((a, b) => a + b, 0) || 1;
  const seg = (n) => Math.max(2, Math.round((s.counts[n] / statusTotal) * 100));

  return (
    <div className="fade">
      <Seg items={[{ id: 'personal', label: '✏️ Mes notes' }, { id: 'official', label: '📄 Officiel' }]} value={source} onChange={setSource} />

      <Card>
        <Row className="spread">
          <div>
            <div className="tiny muted" style={{ textTransform: 'uppercase', letterSpacing: '.06em' }}>Moyenne {source === 'personal' ? 'estimée' : 'officielle'}</div>
            <div style={{ fontSize: 40, fontWeight: 850, letterSpacing: '-.03em' }}>{fmt(s.generalAverage)} <span style={{ fontSize: 15, color: 'var(--muted)', fontWeight: 600 }}>/ 20</span></div>
            <div style={{ marginTop: 8 }}>
              {s.generalAverage == null ? <Chip tone="gray">En attente de notes</Chip>
                : s.generalAverage >= 10 ? <Chip tone="ok">✓ Moyenne acquisitive (≥ 10)</Chip>
                : <Chip tone="bad">Moyenne inférieure à 10 — rattrapage nécessaire</Chip>}
            </div>
          </div>
          <Donut value={s.generalAverage} size={110} stroke={11} label={fmt(s.generalAverage)} sub="générale" />
        </Row>
      </Card>

      <div className="section-title"><h3>Répartition des matières</h3></div>
      <Card>
        <Row style={{ gap: 8 }}>
          <div className="grow">
            <div className="bar" style={{ height: 14, display: 'flex', overflow: 'hidden' }}>
              <i style={{ width: seg('validees') + '%', background: 'linear-gradient(90deg,#067647,#12b76a)', display: 'block' }} />
              <i style={{ width: seg('rattrapage') + '%', background: 'linear-gradient(90deg,#b54708,#f79009)', display: 'block' }} />
              <i style={{ width: seg('non_validees') + '%', background: 'linear-gradient(90deg,#b42318,#f04438)', display: 'block' }} />
              <i style={{ width: seg('en_attente') + '%', background: 'var(--bg-soft)', display: 'block' }} />
            </div>
            <div className="row" style={{ gap: 10, marginTop: 10, flexWrap: 'wrap' }}>
              <Chip tone="ok">● Validées {s.counts.validees}</Chip>
              <Chip tone="warn">● Rattrapage {s.counts.rattrapage}</Chip>
              <Chip tone="bad">● Non validées {s.counts.non_validees}</Chip>
              {s.counts.en_attente > 0 && <Chip tone="gray">● En attente {s.counts.en_attente}</Chip>}
            </div>
          </div>
        </Row>
      </Card>

      <div className="section-title"><h3>Progression par semestre</h3></div>
      {s.semesters.map((sem) => (
        <Card key={sem.id} className="tight">
          <Row className="spread" style={{ marginBottom: 6 }}>
            <strong>{sem.name}</strong>
            <span className="num-td" style={{ color: sem.average == null ? 'var(--muted)' : sem.average >= 10 ? 'var(--ok)' : 'var(--bad)' }}>{fmt(sem.average)}</span>
          </Row>
          <Bar value={sem.average || 0} max={maxAvg} tone={sem.average == null ? '' : sem.average >= 10 ? 'ok' : 'bad'} />
          <div className="row spread tiny muted" style={{ margin: '8px 0 4px' }}>
            <span>Crédits : <strong>{fmt(sem.creditsEarned, 0)} / {sem.ectsExpected}</strong></span>
            <span>{sem.units.length} UE</span>
          </div>
          <Bar value={sem.creditsEarned} max={sem.ectsExpected || 1} tone={sem.creditsEarned >= sem.ectsExpected ? 'ok' : 'warn'} />
          {sem.units.some((u) => u.average != null) && (
            <div style={{ marginTop: 12 }}>
              {sem.units.map((u) => (
                <div key={u.id} style={{ marginBottom: 8 }}>
                  <Row className="spread" style={{ marginBottom: 3 }}>
                    <span className="tiny" style={{ fontWeight: 700 }}>{u.code}</span>
                    <span className="tiny num-td">{fmt(u.average)}</span>
                  </Row>
                  <Bar value={u.average || 0} max={maxAvg} tone={u.average == null ? '' : u.average >= 10 ? 'ok' : 'bad'} />
                </div>
              ))}
            </div>
          )}
        </Card>
      ))}

      <div className="section-title"><h3>Crédits (ECTS)</h3></div>
      <Card>
        <Row className="spread">
          <div>
            <div className="tiny muted">Obtenus sur l’année</div>
            <div style={{ fontSize: 28, fontWeight: 850 }}>{fmt(s.creditsEarned, 0)}<span className="muted" style={{ fontSize: 15, fontWeight: 600 }}> / {s.creditsExpected}</span></div>
          </div>
          <div style={{ textAlign: 'right' }}>
            <div className="tiny muted">Restants</div>
            <div style={{ fontSize: 28, fontWeight: 850, color: 'var(--warn)' }}>{fmt(Math.max(0, s.creditsExpected - s.creditsEarned), 0)}</div>
          </div>
        </Row>
        <div style={{ marginTop: 10 }}><Bar value={s.creditsEarned} max={s.creditsExpected || 1} tone={s.creditsEarned >= s.creditsExpected ? 'ok' : ''} /></div>
        {!hasAny && <p className="tiny muted" style={{ marginTop: 10 }}>Saisissez vos notes dans « Relevé » pour voir vos statistiques se remplir.</p>}
      </Card>
    </div>
  );
}
