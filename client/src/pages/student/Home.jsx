/* Home.jsx — tableau de bord étudiant : identité, moyenne, crédits, semestres, résultats officiels. */
import React from 'react';
import { Link } from 'react-router-dom';
import { fmt } from '../../api.js';
import { api } from '../../api.js';
import { useApp } from '../../store.jsx';
import { Card, Chip, Donut, Bar, Empty, Spinner, StatusChip, PubChip } from '../../ui.jsx';

export function useOverview() {
  const [data, setData] = React.useState(null);
  const [error, setError] = React.useState(null);
  const load = React.useCallback(() => { api('/student/overview').then(setData).catch((e) => setError(e.message)); }, []);
  React.useEffect(load, [load]);
  return { data, error, reload: load, setData };
}

export default function Home() {
  const { user } = useApp();
  const { data, error } = useOverview();
  if (error) return <div className="banner bad">⚠️ {error}</div>;
  if (!data) return <Spinner />;
  if (!data.template) return (
    <Empty icon="🎓" title="Aucun modèle de relevé disponible">
      Votre filière / niveau n’est pas encore configuré. Contactez l’administration.
    </Empty>
  );
  const p = data.personal;
  const officialSemesters = data.official?.semesters || [];
  const hasOfficial = officialSemesters.length > 0;
  const pct = p.creditsExpected ? Math.round((p.creditsEarned / p.creditsExpected) * 100) : 0;

  return (
    <div className="fade">
      {/* ---- carte principale ---- */}
      <div className="hero" style={{ marginBottom: 14 }}>
        <div className="row spread" style={{ alignItems: 'flex-start' }}>
          <div>
            <div className="small" style={{ opacity: .85 }}>Bonjour,</div>
            <h1 style={{ fontSize: 22 }}>{user.first_name} {user.last_name}</h1>
            <div className="row" style={{ gap: 6, marginTop: 8 }}>
              <span className="chip violet" style={{ background: 'rgba(255,255,255,.16)', color: '#fff', borderColor: 'rgba(255,255,255,.3)' }}>{data.template.level} — {data.template.program}</span>
              <span className="chip" style={{ background: 'rgba(255,255,255,.16)', color: '#fff', borderColor: 'rgba(255,255,255,.3)' }}>{data.template.year}</span>
            </div>
          </div>
          <Donut value={p.generalAverage} size={96} label={fmt(p.generalAverage)} sub="/ 20" />
        </div>
        <div style={{ marginTop: 14 }}>
          <div className="row spread small" style={{ color: 'rgba(255,255,255,.9)', marginBottom: 5 }}>
            <span>Crédits obtenus</span><strong>{fmt(p.creditsEarned, 0)} / {p.creditsExpected}</strong>
          </div>
          <div className="bar" style={{ background: 'rgba(255,255,255,.25)' }}><i style={{ width: pct + '%', background: '#fff' }} /></div>
        </div>
      </div>

      {/* ---- stats rapides ---- */}
      <div className="grid4" style={{ marginBottom: 4 }}>
        <div className="stat ok"><div className="v">{p.counts.validees}</div><div className="k">Matières validées</div></div>
        <div className="stat warn"><div className="v">{p.counts.rattrapage}</div><div className="k">En rattrapage</div></div>
        <div className="stat bad"><div className="v">{p.counts.non_validees}</div><div className="k">Non validées</div></div>
        <div className="stat"><div className="v">{fmt(p.creditsRemaining, 0)}</div><div className="k">Crédits restants</div></div>
      </div>

      {/* ---- résultats officiels ---- */}
      {hasOfficial ? (
        <Card className="tight" style={{ borderColor: 'color-mix(in srgb, var(--info) 35%, transparent)', background: 'var(--info-bg)' }}>
          <div className="row spread">
            <div>
              <strong style={{ fontSize: 13.5 }}>📄 Résultats officiels disponibles</strong>
              <div className="tiny muted">Semestre(s) : {officialSemesters.map((s) => 'S' + s.number).join(', ')}</div>
            </div>
            <Link to="/releve" className="btn sm subtle" style={{ textDecoration: 'none' }}>Consulter</Link>
          </div>
        </Card>
      ) : (
        <Card className="tight" style={{ marginBottom: 12 }}>
          <div className="row small muted" style={{ gap: 8 }}>ℹ️ Aucun résultat officiel publié pour l’instant — les moyennes affichées sont vos <strong>notes personnelles</strong>.</div>
        </Card>
      )}

      {/* ---- semestres ---- */}
      <div className="section-title"><h2>Semestres</h2><span className="tiny muted">Moyennes personnelles</span></div>
      {p.semesters.map((s) => (
        <Card key={s.id} className="tight">
          <div className="row spread" style={{ marginBottom: 8 }}>
            <div>
              <h3>{s.name}</h3>
              <div className="row" style={{ gap: 6, marginTop: 4 }}>
                <PubChip status={(data.publications[s.id] || {}).status || 'draft'} />
                {s.units.every((u) => u.courses.every((c) => c.status === 'en_attente')) && <Chip tone="gray">Aucune saisie</Chip>}
              </div>
            </div>
            <div style={{ textAlign: 'right' }}>
              <div style={{ fontSize: 24, fontWeight: 800, color: s.average == null ? 'var(--muted)' : (s.average >= 10 ? 'var(--ok)' : 'var(--bad)') }}>{fmt(s.average)}</div>
              <div className="tiny muted">moyenne</div>
            </div>
          </div>
          <div className="row spread tiny muted" style={{ marginBottom: 4 }}>
            <span>Crédits</span><span><strong>{fmt(s.creditsEarned, 0)}</strong> / {s.ectsExpected}</span>
          </div>
          <Bar value={s.creditsEarned} max={s.ectsExpected} tone={s.creditsEarned >= s.ectsExpected ? 'ok' : ''} />
          <div className="row" style={{ gap: 6, marginTop: 10, flexWrap: 'wrap' }}>
            {s.units.map((u) => (
              <Chip key={u.id} tone={u.average == null ? 'gray' : u.average >= 10 ? 'ok' : 'bad'}>
                {u.code} · {fmt(u.average)}
              </Chip>
            ))}
          </div>
          <div className="row" style={{ marginTop: 12 }}>
            <Link to="/releve" className="btn sm ghost grow" style={{ textDecoration: 'none' }}>Ouvrir le relevé</Link>
          </div>
        </Card>
      ))}

      {/* ---- matières à suivre ---- */}
      {(() => {
        const catchup = p.semesters.flatMap((s) => s.units.flatMap((u) => u.courses.filter((c) => c.status === 'rattrapage_a_passer').map((c) => ({ ...c, sem: s.number }))));
        if (!catchup.length) return null;
        return (
          <>
            <div className="section-title"><h3>⚠️ Matières en rattrapage</h3></div>
            {catchup.slice(0, 6).map((c) => (
              <Card key={c.id} className="tight">
                <div className="row spread">
                  <div><strong style={{ fontSize: 14 }}>{c.name}</strong><div className="tiny muted">S{c.sem} · coef. {c.coefficient} · {c.credits} crédit(s)</div></div>
                  <div style={{ textAlign: 'right' }}><div className="num-td">{fmt(c.normal)}</div><StatusChip status={c.status} /></div>
                </div>
              </Card>
            ))}
          </>
        );
      })()}
    </div>
  );
}
