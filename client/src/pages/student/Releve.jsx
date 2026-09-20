/* Releve.jsx — relevé de notes : semestres → UE → matières.
 * Deux modes : « Mes notes » (saisie personnelle, modifiable) et « Résultats officiels » (lecture seule).
 * Les coefficients, crédits et règles viennent du modèle (base de données), jamais codés ici. */
import React, { useEffect, useMemo, useState } from 'react';
import { api, fmt } from '../../api.js';
import { Card, Chip, Row, StatusChip, PubChip, ScoreInput, Spinner, Empty, useToast, fmtDate } from '../../ui.jsx';

const RULE_LABELS = {
  max_normal_rattrapage: 'Note définitive = MAX(Normale, Rattrapage)',
  normal_then_rattrapage: 'Le rattrapage remplace la normale',
  weighted: 'Définitive = moyenne pondérée normale / rattrapage',
};

function CourseRow({ course, editable, onSet, saving }) {
  const [open, setOpen] = useState(editable && course.status !== 'validee');
  return (
    <div style={{ border: '1px solid var(--line)', borderRadius: 14, background: 'var(--card)', marginBottom: 8, overflow: 'hidden' }}>
      <button onClick={() => setOpen((o) => !o)} style={{ all: 'unset', display: 'flex', width: '100%', alignItems: 'center', gap: 10, padding: '10px 12px', cursor: 'pointer', boxSizing: 'border-box' }}>
        <div className="grow" style={{ minWidth: 0 }}>
          <div style={{ fontWeight: 700, fontSize: 13.8, lineHeight: 1.25 }}>{course.name}</div>
          <div className="tiny muted">coef. {course.coefficient} · {course.credits} crédit{course.credits > 1 ? 's' : ''}</div>
        </div>
        <div style={{ textAlign: 'right' }}>
          <div className="num-td" style={{ fontSize: 15, color: course.definitive == null ? 'var(--muted)' : course.definitive >= 10 ? 'var(--ok)' : 'var(--bad)' }}>
            {fmt(course.definitive)}
          </div>
          <div className="tiny muted">déf.</div>
        </div>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" style={{ color: 'var(--muted)', transform: open ? 'rotate(90deg)' : 'none', transition: 'transform .15s' }}><path d="m9 6 6 6-6 6" /></svg>
      </button>
      {open && (
        <div style={{ padding: '0 12px 12px' }}>
          <Row className="spread">
            <Row style={{ gap: 14 }}>
              <div><div className="tiny muted" style={{ textAlign: 'center', marginBottom: 4 }}>Normale</div>
                <ScoreInput value={course.normal} disabled={!editable} onChange={(v) => onSet('normal', v)} /></div>
              <div><div className="tiny muted" style={{ textAlign: 'center', marginBottom: 4 }}>Rattrapage</div>
                <ScoreInput value={course.rattrapage} disabled={!editable} onChange={(v) => onSet('rattrapage', v)} /></div>
            </Row>
            <div style={{ textAlign: 'right' }}>
              <div className="tiny muted" style={{ marginBottom: 4 }}>Définitive</div>
              <div className="num-td" style={{ fontSize: 20 }}>{fmt(course.definitive)}</div>
              <div style={{ marginTop: 5 }}><StatusChip status={course.status} /></div>
            </div>
          </Row>
          {editable && <div className="tiny muted" style={{ marginTop: 6 }}>{saving === course.id ? '💾 Enregistrement…' : 'Modifiez une note : le calcul est automatique.'}</div>}
        </div>
      )}
    </div>
  );
}

export default function Releve() {
  const [source, setSource] = useState('personal');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(null);
  const [draft, setDraft] = useState({});
  const [toast, showToast] = useToast();

  const load = (src) => {
    setLoading(true);
    api('/student/releve?source=' + src)
      .then((d) => { setData(d); setDraft({}); })
      .catch((e) => showToast(e.message))
      .finally(() => setLoading(false));
  };
  useEffect(() => { load(source); }, [source]);

  const editable = source === 'personal';
  const semesters = data?.semesters || [];

  const onSet = async (courseId, field, value) => {
    const key = String(courseId);
    const nextDraft = { ...(draft[key] || {}), [field]: value };
    setDraft({ ...draft, [key]: nextDraft });
    setSaving(courseId);
    try {
      const body = { normal: nextDraft.normal !== undefined ? nextDraft.normal : data.semesters.flatMap((s) => s.units.flatMap((u) => u.courses)).find((c) => c.id === courseId)?.normal, rattrapage: nextDraft.rattrapage !== undefined ? nextDraft.rattrapage : data.semesters.flatMap((s) => s.units.flatMap((u) => u.courses)).find((c) => c.id === courseId)?.rattrapage };
      const res = await api('/student/grades/' + courseId, { method: 'PUT', body });
      applyComputed(res.computed);
      const d2 = { ...draft }; delete d2[key]; setDraft(d2);
      showToast('Note enregistrée ✓');
    } catch (e) { showToast('⚠️ ' + e.message); } finally { setSaving(null); }
  };

  /** Fusionne les valeurs recalculées renvoyées par le serveur dans l’arbre affiché. */
  function applyComputed(computed) {
    setData((prev) => {
      const semById = Object.fromEntries(computed.semesters.map((s) => [s.id, s]));
      const next = { ...prev, computedTotals: computed };
      next.semesters = prev.semesters.map((s) => {
        const cs = semById[s.id];
        if (!cs) return s;
        const ueById = Object.fromEntries(cs.units.map((u) => [u.id, u]));
        return {
          ...s,
          average: cs.average,
          creditsEarned: cs.creditsEarned,
          units: s.units.map((u) => {
            const cu = ueById[u.id];
            if (!cu) return u;
            const cById = Object.fromEntries(cu.courses.map((c) => [c.id, c]));
            return { ...u, average: cu.average, courses: u.courses.map((c) => ({ ...c, ...(cById[c.id] || {}) })) };
          }),
        };
      });
      return next;
    });
  }

  if (loading && !data) return <Spinner />;
  if (!data || data.error) return <Empty icon="🗂" title="Modèle indisponible">{data?.error}</Empty>;
  if (data.empty) return (
    <Empty icon="🔒" title="Aucun résultat officiel publié">
      L’administration n’a encore publié aucun relevé officiel. En attendant, retrouvez vos estimations dans « Mes notes ».
    </Empty>
  );

  const totals = data.computedTotals || data.totals;

  return (
    <div className="fade">
      {toast}
      <div className="segments" style={{ marginBottom: 12 }}>
        <button className={source === 'personal' ? 'on' : ''} onClick={() => setSource('personal')}>✏️ Mes notes</button>
        <button className={source === 'official' ? 'on' : ''} onClick={() => setSource('official')}>📄 Résultats officiels</button>
      </div>

      {source === 'personal'
        ? <div className="banner info" style={{ marginBottom: 12 }}>✏️ Mode personnel : ces notes vous appartiennent, elles alimentent vos moyennes d’estimation et restent modifiables.</div>
        : <div className="banner ok" style={{ marginBottom: 12 }}>📄 Relevé officiel : validé par l’administration, il ne peut plus être modifié par les étudiants.</div>}

      {data.rules && <p className="tiny muted" style={{ margin: '0 2px 10px' }}>⚙️ {RULE_LABELS[data.rules.final_grade_rule] || 'Règles personnalisées'} · seuil de validation {fmt(data.rules.pass_threshold, 0)} · crédits acquis sur la note {data.rules.credit_validation_basis === 'normal' ? 'normale' : 'définitive'}</p>}

      <div className="row spread" style={{ marginBottom: 8, padding: '0 2px' }}>
        <h2>{data.template?.name || data.template?.program}</h2>
        {totals && <Chip tone="violet">Moyenne {fmt(totals.generalAverage)}</Chip>}
      </div>

      {semesters.map((s) => {
        const pending = s.units.every((u) => u.courses.every((c) => c.status === 'en_attente'));
        return (
          <details className="acc" key={s.id} open={!pending}>
            <summary>
              <span className="chev"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round"><path d="m9 6 6 6-6 6" /></svg></span>
              <div className="grow">
                <h3>{s.name}</h3>
                <div className="row" style={{ gap: 6, marginTop: 3 }}>
                  <Chip tone={s.average == null ? 'gray' : s.average >= 10 ? 'ok' : 'bad'}>Moyenne {fmt(s.average)}</Chip>
                  <Chip tone="gray">{fmt(s.creditsEarned, 0)}/{s.ectsExpected} crédits</Chip>
                  {source === 'official' && <PubChip status={s.publication} />}
                </div>
              </div>
            </summary>
            <div className="acc-body">
              {s.units.map((u) => (
                <div key={u.id} style={{ marginTop: 10 }}>
                  <Row className="spread" style={{ padding: '0 2px 6px' }}>
                    <strong style={{ fontSize: 13 }}>{u.name || u.code}</strong>
                    <Chip tone={u.average == null ? 'gray' : u.average >= 10 ? 'ok' : 'bad'}>Moy. UE {fmt(u.average)}</Chip>
                  </Row>
                  {u.courses.map((c) => (
                    <CourseRow key={c.id} course={{ ...c, ...(draft[String(c.id)] || {}) }} editable={editable} onSet={(f, v) => onSet(c.id, f, v)} saving={saving} />
                  ))}
                </div>
              ))}
              {source === 'official' && s.published_at && <p className="tiny muted" style={{ marginTop: 6 }}>Publié le {fmtDate(s.published_at)}</p>}
            </div>
          </details>
        );
      })}
      {totals && (
        <Card style={{ marginTop: 4 }}>
          <Row className="spread">
            <div><div className="tiny muted">Moyenne {source === 'personal' ? 'estimée' : 'officielle'}</div><div style={{ fontSize: 30, fontWeight: 850, letterSpacing: '-.02em' }}>{fmt(totals.generalAverage)}</div></div>
            <div style={{ textAlign: 'right' }}>
              <div className="tiny muted">Crédits obtenus</div>
              <div style={{ fontSize: 22, fontWeight: 800 }}>{fmt(totals.creditsEarned, 0)}<span className="muted" style={{ fontSize: 14 }}> / {totals.creditsExpected}</span></div>
            </div>
          </Row>
        </Card>
      )}
    </div>
  );
}
