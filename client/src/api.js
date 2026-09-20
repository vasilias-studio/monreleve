/* api.js — client HTTP minimaliste avec jeton Bearer + téléchargements authentifiés.
 * Le stockage est encapsulé : si le contexte (iframe sandboxée, navigation privée) bloque
 * localStorage, on retombe sur une mémoire volatile au lieu de faire planter l'app. */
const TOKEN_KEY = 'monreleve_token';
const mem = {};
const safeGet = (k) => { try { return localStorage.getItem(k); } catch { return mem[k] ?? null; } };
const safeSet = (k, v) => { try { v === null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch { if (v === null) delete mem[k]; else mem[k] = v; } };

export const getToken = () => safeGet(TOKEN_KEY);
export const setToken = (t) => safeSet(TOKEN_KEY, t || null);
export const safeGetItem = safeGet;
export const safeSetItem = safeSet;

export async function api(path, { method = 'GET', body, form } = {}) {
  const headers = {};
  const tok = getToken();
  if (tok) headers.Authorization = 'Bearer ' + tok;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  let res;
  try {
    res = await fetch('/api' + path, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : (form || undefined),
    });
  } catch {
    throw new Error('Serveur injoignable — l’API n’est pas démarrée. Relancez « npm run serve » (ou demandez le redémarrage de l’aperçu).');
  }
  const isJson = (res.headers.get('content-type') || '').includes('json');
  const data = isJson ? await res.json().catch(() => ({})) : await res.text();
  if (!res.ok) {
    const err = new Error((data && data.error) || `Erreur ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

/** Téléchargement (CSV/XLSX) avec en-tête d'authentification. */
export async function download(path, filename) {
  const tok = getToken();
  const res = await fetch('/api' + path, { headers: tok ? { Authorization: 'Bearer ' + tok } : {} });
  if (!res.ok) throw new Error('Échec du téléchargement (' + res.status + ')');
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

/* Formatage français des nombres */
export const fmt = (v, d = 2) => (v === null || v === undefined || Number.isNaN(v)) ? '—' : Number(v).toLocaleString('fr-FR', { minimumFractionDigits: d, maximumFractionDigits: d });
export const fmtShort = (v) => (v === null || v === undefined) ? '—' : Number(v).toLocaleString('fr-FR', { maximumFractionDigits: 2 });
