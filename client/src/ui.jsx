/* ui.jsx — composants d'interface partagés (mobile-first, sans dépendance externe). */
import React, { useEffect, useRef, useState } from 'react';

export const Card = ({ children, className = '' }) => <div className={`card ${className}`}>{children}</div>;
export const Row = ({ children, className = '' }) => <div className={`row ${className}`}>{children}</div>;
export const Muted = ({ children }) => <span className="muted small">{children}</span>;

export function Chip({ tone = 'gray', children, icon }) {
  return <span className={`chip ${tone}`}>{icon}{children}</span>;
}

export const STATUS_META = {
  validee: { label: 'Validée', tone: 'ok' },
  rattrapage_a_passer: { label: 'Rattrapage', tone: 'warn' },
  non_validee: { label: 'Non validée', tone: 'bad' },
  en_attente: { label: 'En attente', tone: 'gray' },
};
export const StatusChip = ({ status }) => {
  const m = STATUS_META[status] || STATUS_META.en_attente;
  return <Chip tone={m.tone}>{m.label}</Chip>;
};
export const PUB_META = {
  draft: { label: 'Non publié', tone: 'gray' },
  published: { label: 'Publié', tone: 'info' },
  locked: { label: 'Verrouillé', tone: 'violet' },
};
export const PubChip = ({ status }) => {
  const m = PUB_META[status] || PUB_META.draft;
  return <Chip tone={m.tone}>{m.label}</Chip>;
};

export function Bar({ value, max, tone = '' }) {
  const pct = max > 0 ? Math.min(100, Math.round((value / max) * 100)) : 0;
  return <div className={`bar ${tone}`}><i style={{ width: pct + '%' }} /></div>;
}

/** Anneau de progression SVG (moyenne /20). */
export function Donut({ value, max = 20, size = 92, stroke = 9, label, sub }) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const pct = value == null ? 0 : Math.min(1, value / max);
  const hue = value == null ? 'var(--muted)' : value >= 10 ? 'var(--ok)' : 'var(--bad)';
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{ flex: 'none' }}>
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--line)" strokeWidth={stroke} />
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={hue} strokeWidth={stroke} strokeLinecap="round"
        strokeDasharray={`${c * pct} ${c}`} transform={`rotate(-90 ${size / 2} ${size / 2})`}
        style={{ transition: 'stroke-dasharray .6s cubic-bezier(.2,.8,.2,1)' }} />
      <text x="50%" y={label ? '44%' : '47%'} className="donut-label" fontSize={size / 4.6} fontWeight="800" fill="var(--text)">{label ?? '—'}</text>
      {sub && <text x="50%" y="63%" className="donut-label" fontSize={size / 9.5} fontWeight="600" fill="var(--muted)">{sub}</text>}
    </svg>
  );
}

export function Empty({ icon = '📭', title, children, action }) {
  return (
    <div className="empty">
      <div className="big-ico">{icon}</div>
      <h3>{title}</h3>
      {children && <p className="small" style={{ margin: '6px 0 12px' }}>{children}</p>}
      {action}
    </div>
  );
}

export const Spinner = () => <div className="spin" />;

export function useToast() {
  const [msg, setMsg] = useState(null);
  const timer = useRef();
  const toast = (m) => { setMsg(m); clearTimeout(timer.current); timer.current = setTimeout(() => setMsg(null), 2200); };
  return [msg ? <div className="toast">{msg}</div> : null, toast];
}

/** Champ numérique 0-20 (vide autorisé) ; renvoie number|null. */
export function ScoreInput({ value, onChange, disabled, placeholder = '—' }) {
  const [local, setLocal] = useState(value == null ? '' : String(value).replace('.', ','));
  useEffect(() => { setLocal(value == null ? '' : String(value).replace('.', ',')); }, [value]);
  const commit = () => {
    const s = local.trim().replace(',', '.');
    if (s === '') { onChange(null); return; }
    const n = parseFloat(s);
    if (Number.isFinite(n)) onChange(Math.max(0, Math.min(20, Math.round(n * 100) / 100)));
    else setLocal(value == null ? '' : String(value));
  };
  return (
    <input
      className="input sm input num score-input" inputMode="decimal" type="text"
      value={local} disabled={disabled} placeholder={placeholder}
      onChange={(e) => setLocal(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => { if (e.key === 'Enter') { commit(); e.currentTarget.blur(); } }}
    />
  );
}

export function Field({ label, children }) {
  return <label className="field"><label>{label}</label>{children}</label>;
}

export function Modal({ open, onClose, title, children, width = 480 }) {
  useEffect(() => {
    if (!open) return;
    const esc = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
  }, [open]);
  if (!open) return null;
  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 60, background: 'rgba(10,14,22,.55)', display: 'flex', alignItems: 'flex-end', justifyContent: 'center' }}
      onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()}
        style={{ background: 'var(--card)', width: 'min(100%, ' + width + 'px)', borderRadius: '22px 22px 0 0', padding: '18px 18px calc(18px + env(safe-area-inset-bottom))', maxHeight: '88dvh', overflowY: 'auto', animation: 'fade .2s ease' }}>
        <Row className="spread" style={{ marginBottom: 12 }}>
          <h3>{title}</h3>
          <button className="icon-btn" onClick={onClose} aria-label="Fermer">✕</button>
        </Row>
        {children}
      </div>
    </div>
  );
}

/** Barre de recherche + filtres. */
export function SearchBar({ value, onChange, placeholder = 'Rechercher…' }) {
  return (
    <div className="card tight" style={{ padding: '9px 12px', display: 'flex', alignItems: 'center', gap: 8 }}>
      <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" style={{ color: 'var(--muted)', flex: 'none' }}>
        <circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" strokeLinecap="round" />
      </svg>
      <input className="input" style={{ border: 0, padding: '4px 2px', background: 'transparent' }} value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />
      {value && <button className="icon-btn" style={{ width: 26, height: 26, border: 0 }} onClick={() => onChange('')}>✕</button>}
    </div>
  );
}

export const fmtDate = (s) => { if (!s) return ''; try { return new Date(s.replace(' ', 'T') + 'Z').toLocaleString('fr-FR', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }); } catch { return s; } };
