/* Refs.jsx — gestion des référentiels : établissements, filières, niveaux, années universitaires, classes.
 * Tout est stocké en base : l'application n'a rien de codé en dur. */
import React, { useCallback, useEffect, useState } from 'react';
import { api } from '../../api.js';
import { Card, Row, Chip, Field, Modal, useToast, Spinner } from '../../ui.jsx';

const TABLES = {
  institutions: { label: 'Établissements', path: '/admin/institutions', columns: [['name', 'Nom', 'text'], ['code', 'Code', 'text']] },
  programs: { label: 'Filières', path: '/admin/programs', columns: [['name', 'Nom', 'text'], ['code', 'Code', 'text'], ['institution_id', 'Établissement', 'ref:institutions'] ], joins: { institution: 'institutions' } },
  levels: { label: 'Niveaux', path: '/admin/levels', columns: [['name', 'Nom (L1, L2, M1…)', 'text'], ['cycle', 'Cycle', 'text'], ['ord', 'Ordre', 'number']] },
  years: { label: 'Années universitaires', path: '/admin/years', columns: [['label', 'Libellé (2026-2027)', 'text'], ['start_year', 'Année de début', 'number'], ['is_current', 'Année courante', 'check']] },
  classes: { label: 'Classes / groupes', path: '/admin/classes', columns: [['name', 'Nom', 'text'], ['program_id', 'Filière', 'ref:programs'], ['level_id', 'Niveau', 'ref:levels'], ['academic_year_id', 'Année', 'ref:years']] },
};

export default function Refs() {
  const [tab, setTab] = useState('programs');
  const [data, setData] = useState({});
  const [toast, showToast] = useToast();
  const [editing, setEditing] = useState(null); // {table, row}

  const load = useCallback((table) => {
    const defs = Object.values(TABLES).filter((t) => t.path.includes(table));
    api(TABLES[table].path).then((rows) => setData((d) => ({ ...d, [table]: rows })));
  }, []);
  useEffect(() => { Object.keys(TABLES).forEach(load); }, [load]);

  const del = async (table, id) => {
    if (!confirm('Supprimer cet enregistrement ? Cette action peut être bloquée si des données y sont reliées.')) return;
    try { await api(TABLES[table].path + '/' + id, { method: 'DELETE' }); load(table); showToast('Supprimé ✓'); }
    catch (e) { showToast('⚠️ ' + e.message); }
  };
  const setYearCurrent = async (id) => { await api('/admin/years/' + id + '/current', { method: 'PUT' }); load('years'); showToast('Année courante définie ✓'); };

  const t = TABLES[tab];
  const rows = data[tab];

  return (
    <div className="fade">
      {toast}
      <h1 style={{ fontSize: 20, marginBottom: 10 }}>Référentiels</h1>
      <div className="segments" style={{ marginBottom: 14, flexWrap: 'wrap' }}>
        {Object.entries(TABLES).map(([k, v]) => (
          <button key={k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{v.label}</button>
        ))}
      </div>
      <Card>
        <Row className="spread" style={{ marginBottom: 10 }}>
          <h3>{t.label}</h3>
          <button className="btn sm" style={{ width: 'auto' }} onClick={() => setEditing({ table: tab, row: {} })}>+ Ajouter</button>
        </Row>
        {!rows ? <Spinner /> : rows.length === 0 ? <p className="muted small">Aucun élément.</p> : (
          <div className="scroll-x">
            <table className="tbl">
              <thead><tr>{t.columns.map(([k, l]) => <th key={k}>{l}</th>)}<th /></tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id}>
                    {t.columns.map(([k, , type]) => (
                      <td key={k} className="small">
                        {type === 'check' ? (r[k] ? <Chip tone="ok">oui</Chip> : <span className="muted tiny">—</span>)
                          : type.startsWith('ref:') ? (refName(data, type.slice(4), r[k + (k.endsWith('_id') ? 0 : '_id')]) || <span className="muted">—</span>)
                          : k === 'is_active' ? (r[k] ? 'actif' : 'inactif')
                          : r[k] ?? <span className="muted">—</span>}
                      </td>
                    ))}
                    <td className="r" style={{ whiteSpace: 'nowrap' }}>
                      {tab === 'years' && !r.is_current && <button className="btn xs ghost" onClick={() => setYearCurrent(r.id)}>Rendre courante</button>}
                      <button className="btn xs ghost" style={{ marginLeft: 4 }} onClick={() => setEditing({ table: tab, row: { ...r } })}>✏️</button>
                      <button className="btn xs danger" style={{ marginLeft: 4 }} onClick={() => del(tab, r.id)}>🗑</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      <p className="tiny muted">Astuce : ajoutez ici un nouveau niveau (L4, M2…), une filière ou une année universitaire — ils apparaissent immédiatement dans l’inscription et les modèles, sans toucher au code.</p>

      <RefModal editing={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load(editing.table); showToast('Enregistré ✓'); }} data={data} toast={showToast} />
    </div>
  );
}

function refName(data, tableKey, id) {
  if (!id) return null;
  const row = (data[tableKey] || []).find((x) => x.id === id);
  return row ? (row.name || row.label) : null;
}

function RefModal({ editing, onClose, onSaved, data, toast }) {
  if (!editing) return null;
  const t = TABLES[editing.table];
  const [f, setF] = useState(() => {
    const o = {};
    for (const [k, , type] of t.columns) o[k] = editing.row[k] ?? (type === 'number' || type.startsWith('ref:') ? '' : '');
    return o;
  });
  const save = async () => {
    try {
      const body = { ...f };
      for (const k of Object.keys(body)) if (body[k] === '') body[k] = null;
      if (editing.row.id) await api(t.path + '/' + editing.row.id, { method: 'PUT', body });
      else await api(t.path, { method: 'POST', body });
      onSaved();
    } catch (e) { toast('⚠️ ' + e.message); }
  };
  return (
    <Modal open onClose={onClose} title={(editing.row.id ? 'Modifier — ' : 'Ajouter — ') + t.label}>
      <div className="stack">
        {t.columns.map(([k, label, type]) => (
          <Field key={k} label={label}>
            {type.startsWith('ref:') ? (
              <select className="input" value={f[k] ?? ''} onChange={(e) => setF({ ...f, [k]: e.target.value })}>
                <option value="">— Aucun —</option>
                {(data[type.slice(4)] || []).map((r) => <option key={r.id} value={r.id}>{r.name || r.label}</option>)}
              </select>
            ) : type === 'check' ? (
              <select className="input" value={f[k] ? '1' : '0'} onChange={(e) => setF({ ...f, [k]: Number(e.target.value) })}>
                <option value="0">Non</option><option value="1">Oui</option>
              </select>
            ) : (
              <input className="input" type={type === 'number' ? 'number' : 'text'} value={f[k] ?? ''} onChange={(e) => setF({ ...f, [k]: e.target.value })} />
            )}
          </Field>
        ))}
        <button className="btn" onClick={save}>Enregistrer</button>
      </div>
    </Modal>
  );
}
