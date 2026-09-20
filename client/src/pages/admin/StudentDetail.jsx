/* StudentDetail.jsx — fiche étudiant côté administration :
 * profil, saisie/correction des notes OFFICIELLES, publication & verrouillage par semestre,
 * export du relevé. Les notes personnelles de l'étudiant restent privées (non exposées ici). */
import React, { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, fmt, download } from '../../api.js';
import { Card, Row, Chip, Spinner, StatusChip, PubChip, ScoreInput, useToast, Modal, Field } from '../../ui.jsx';

export default function StudentDetail() {
  const { id } = useParams();
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [toast, showToast] = useToast();
  const [editOpen, setEditOpen] = useState(false);

  const load = useCallback(() => { api('/admin/students/' + id).then(setData).catch((e) => setErr(e.message)); }, [id]);
  useEffect(load, [load]);
  if (err) return <div className="banner bad">⚠️ {err}</div>;
  if (!data) return <Spinner />;

  const s = data;
  const sems = s.official?.semesters || [];

  return (
    <div className="fade">
      {toast}
      <Row style={{ marginBottom: 10 }}>
        <Link to="/admin/etudiants" className="btn xs ghost">← Retour</Link>
        <div className="grow" />
        <button className="btn xs subtle" onClick={() => download('/admin/export/releve/' + s.id + '.xlsx?source=official', `releve-${s.matricule}-officiel.xlsx`)}>⬇️ Relevé officiel</button>
      </Row>

      <Card>
        <Row style={{ gap: 14 }}>
          <div className="avatar" style={{ width: 54, height: 54, borderRadius: 17, fontSize: 18 }}>{(s.first_name || '?')[0]}{(s.last_name || '')[0]}</div>
          <div className="grow">
            <h2>{s.last_name?.toUpperCase()} {s.first_name}</h2>
            <div className="small muted">{s.email}</div>
            <div className="row" style={{ gap: 6, marginTop: 6, flexWrap: 'wrap' }}>
              <Chip tone="violet">{s.level} — {s.program}</Chip>
              <Chip tone="gray">{s.matricule}</Chip>
              {s.year && <Chip tone="gray">{s.year}</Chip>}
              {!s.is_active && <Chip tone="bad">Compte désactivé</Chip>}
            </div>
          </div>
          <button className="btn xs ghost" onClick={() => setEditOpen(true)}>✏️ Modifier</button>
        </Row>
        {s.template && (
          <div className="row spread" style={{ marginTop: 14, padding: '10px 12px', background: 'var(--card-2)', borderRadius: 12 }}>
            <div>
              <div className="tiny muted">Modèle appliqué</div>
              <strong className="small">{s.template.name}</strong>
            </div>
            <div style={{ textAlign: 'right' }}>
              <div className="tiny muted">Moyenne officielle</div>
              <div style={{ fontSize: 22, fontWeight: 850, color: s.official?.generalAverage == null ? 'var(--muted)' : s.official.generalAverage >= 10 ? 'var(--ok)' : 'var(--bad)' }}>{fmt(s.official?.generalAverage)}</div>
            </div>
            <div style={{ textAlign: 'right' }}>
              <div className="tiny muted">Crédits</div>
              <div style={{ fontSize: 22, fontWeight: 850 }}>{fmt(s.official?.creditsEarned, 0)}<span className="muted" style={{ fontSize: 13 }}> / {s.official?.creditsExpected}</span></div>
            </div>
          </div>
        )}
      </Card>

      {!s.template && <div className="banner warn" style={{ marginBottom: 12 }}>⚠️ Aucun modèle de relevé n’est associé à sa filière/niveau. Créez le modèle pour saisir des notes.</div>}

      {s.template && sems.map((sem) => (
        <SemesterCard key={sem.id} sem={sem} studentId={s.id} pub={s.publications[sem.id]?.status || 'draft'} onChanged={load} toast={showToast} />
      ))}

      <EditStudentModal open={editOpen} onClose={() => setEditOpen(false)} student={s} onSaved={() => { showToast('Profil mis à jour ✓'); setEditOpen(false); load(); }} toast={showToast} />
    </div>
  );
}

function SemesterCard({ sem, studentId, pub, onChanged, toast }) {
  const locked = pub === 'locked';
  const [rows, setRows] = useState(sem.units.flatMap((u) => u.courses.map((c) => ({ ...c, unit: u.code }))));
  useEffect(() => { setRows(sem.units.flatMap((u) => u.courses.map((c) => ({ ...c, unit: u.code })))); }, [sem]);
  const setLocal = (id, field, v) => setRows((r) => r.map((c) => (c.id === id ? { ...c, [field]: v } : c)));
  const save = async (course) => {
    try {
      await api(`/admin/students/${studentId}/grades/${course.id}`, { method: 'PUT', body: { normal: course.normal, rattrapage: course.rattrapage } });
      toast('Note officielle enregistrée ✓');
      onChanged();
    } catch (e) { toast('⚠️ ' + e.message); }
  };
  const act = async (action) => {
    try {
      await api(`/admin/semesters/${sem.id}/publication`, { method: 'POST', body: { action } });
      toast({ publish: 'Résultats publiés ✓', lock: 'Semestre verrouillé 🔒', unlock: 'Semestre déverrouillé', draft: 'Publication retirée' }[action]);
      onChanged();
    } catch (e) { toast('⚠️ ' + e.message); }
  };
  return (
    <details className="acc" open={pub !== 'draft'}>
      <summary>
        <span className="chev"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round"><path d="m9 6 6 6-6 6" /></svg></span>
        <div className="grow">
          <h3>{sem.name}</h3>
          <div className="row" style={{ gap: 6, marginTop: 3 }}>
            <PubChip status={pub} />
            <Chip tone={sem.average == null ? 'gray' : sem.average >= 10 ? 'ok' : 'bad'}>Moy. {fmt(sem.average)}</Chip>
            <Chip tone="gray">{fmt(sem.creditsEarned, 0)}/{sem.ectsExpected} cr.</Chip>
          </div>
        </div>
        <div className="row" style={{ gap: 6 }} onClick={(e) => e.preventDefault()}>
          {pub === 'draft' && <button className="btn xs primary" style={{ width: 'auto' }} onClick={() => act('publish')}>Publier</button>}
          {pub === 'published' && <>
            <button className="btn xs ghost" style={{ width: 'auto' }} onClick={() => act('lock')}>🔒 Verrouiller</button>
            <button className="btn xs ghost" style={{ width: 'auto' }} onClick={() => act('draft')}>Retirer</button>
          </>}
          {locked && <button className="btn xs ghost" style={{ width: 'auto' }} onClick={() => act('unlock')}>🔓 Déverrouiller</button>}
        </div>
      </summary>
      <div className="acc-body">
        {locked && <div className="banner violet small" style={{ marginBottom: 8, background: 'var(--primary-soft)' }}>🔒 Verrouillé : les notes officielles sont figées. Déverrouillez pour corriger.</div>}
        <div className="scroll-x">
          <table className="tbl">
            <thead><tr><th>Matière (UE)</th><th className="c">Normale</th><th className="c">Rattrap.</th><th className="c">Déf.</th><th className="c">Coef.</th><th className="c">Créd.</th><th className="c">Statut</th></tr></thead>
            <tbody>
              {rows.map((c) => (
                <tr key={c.id}>
                  <td><div style={{ maxWidth: 220 }}><strong style={{ fontSize: 13 }}>{c.name}</strong></div><div className="tiny muted">{c.unit} · {c.credits} cr.</div></td>
                  <td className="c"><ScoreInput value={c.normal} disabled={locked} onChange={(v) => setLocal(c.id, 'normal', v)} /></td>
                  <td className="c"><ScoreInput value={c.rattrapage} disabled={locked} onChange={(v) => setLocal(c.id, 'rattrapage', v)} /></td>
                  <td className="c num-td">{fmt(c.definitive)}</td>
                  <td className="c num-td">{c.coefficient}</td>
                  <td className="c num-td">{c.credits}</td>
                  <td className="c"><StatusChip status={c.status} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!locked && (
          <div style={{ marginTop: 8 }}>
            <button className="btn sm subtle" onClick={async () => {
              const grades = {};
              for (const c of rows) grades[c.id] = { normal: c.normal, rattrapage: c.rattrapage };
              try {
                const r = await api(`/admin/students/${studentId}/official-grades`, { method: 'POST', body: { grades } });
                toast(r.blocked?.length ? `Enregistré (${r.blocked.length} bloquées par verrou)` : 'Toutes les notes enregistrées ✓');
                onChanged();
              } catch (e) { toast('⚠️ ' + e.message); }
            }}>💾 Enregistrer les {rows.length} notes du semestre</button>
          </div>
        )}
      </div>
    </details>
  );
}

function EditStudentModal({ open, onClose, student, onSaved, toast }) {
  const [f, setF] = useState(null);
  const [opts, setOpts] = useState(null);
  useEffect(() => {
    if (open) {
      setF({ first_name: student.first_name || '', last_name: student.last_name || '', email: student.email || '', matricule: student.matricule || '', program_id: student.program_id ? String(student.program_id) : '', level_id: student.level_id ? String(student.level_id) : '', academic_year_id: student.academic_year_id ? String(student.academic_year_id) : '', reset_password: '', is_active: !!student.is_active });
      api('/auth/options').then(setOpts);
    }
  }, [open, student]);
  if (!f || !opts) return null;
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const save = async () => {
    try {
      await api('/admin/students/' + student.id, { method: 'PUT', body: { ...f, program_id: f.program_id || null, level_id: f.level_id || null, academic_year_id: f.academic_year_id || null, reset_password: f.reset_password || undefined } });
      await api('/admin/students/' + student.id + '/active', { method: 'PUT', body: { is_active: f.is_active } });
      onSaved();
    } catch (e) { toast('⚠️ ' + e.message); }
  };
  const remove = async () => {
    if (!confirm('Supprimer définitivement cet étudiant, son compte et ses notes ?')) return;
    try { await api('/admin/students/' + student.id, { method: 'DELETE', body: { confirm: true } }); location.hash = '#/admin/etudiants'; } catch (e) { toast('⚠️ ' + e.message); }
  };
  return (
    <Modal open={open} onClose={onClose} title="Modifier l'étudiant">
      <div className="stack">
        <div className="grid2">
          <Field label="Prénom"><input className="input" value={f.first_name} onChange={set('first_name')} /></Field>
          <Field label="Nom"><input className="input" value={f.last_name} onChange={set('last_name')} /></Field>
        </div>
        <Field label="E-mail"><input className="input" value={f.email} onChange={set('email')} /></Field>
        <Field label="Matricule"><input className="input" value={f.matricule} onChange={set('matricule')} /></Field>
        <div className="grid2">
          <Field label="Filière"><select className="input" value={f.program_id} onChange={set('program_id')}><option value="">—</option>{opts.programs.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></Field>
          <Field label="Niveau"><select className="input" value={f.level_id} onChange={set('level_id')}><option value="">—</option>{opts.levels.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select></Field>
        </div>
        <Field label="Année"><select className="input" value={f.academic_year_id} onChange={set('academic_year_id')}><option value="">—</option>{opts.years.map((y) => <option key={y.id} value={y.id}>{y.label}</option>)}</select></Field>
        <Field label="Nouveau mot de passe (vide = inchangé)"><input className="input" value={f.reset_password} onChange={set('reset_password')} placeholder="Réinitialiser si nécessaire" /></Field>
        <Row className="spread tight"><span className="small" style={{ fontWeight: 700 }}>Compte actif</span>
          <input type="checkbox" checked={f.is_active} onChange={(e) => setF({ ...f, is_active: e.target.checked })} style={{ width: 20, height: 20 }} /></Row>
        <Row style={{ gap: 8 }}>
          <button className="btn danger" style={{ flex: 1 }} onClick={remove}>Supprimer</button>
          <button className="btn" style={{ flex: 2 }} onClick={save}>Enregistrer</button>
        </Row>
      </div>
    </Modal>
  );
}
