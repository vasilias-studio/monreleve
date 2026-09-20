/* store.jsx — contexte global : session utilisateur + thème clair/sombre. */
import React, { createContext, useContext, useEffect, useState } from 'react';
import { api, setToken, getToken, safeGetItem, safeSetItem } from './api.js';

const Ctx = createContext(null);
export const useApp = () => useContext(Ctx);

export function AppProvider({ children }) {
  const [user, setUser] = useState(null);
  const [booting, setBooting] = useState(true);

  useEffect(() => {
    (async () => {
      if (!getToken()) { setBooting(false); return; }
      try { setUser(await api('/auth/me')); } catch { setToken(null); }
      setBooting(false);
    })();
  }, []);

  const login = async (email, password) => {
    const d = await api('/auth/login', { method: 'POST', body: { email, password } });
    setToken(d.token);
    setUser(d);
    return d;
  };
  const register = async (payload) => {
    const d = await api('/auth/register', { method: 'POST', body: payload });
    setToken(d.token);
    setUser(d);
    return d;
  };
  const logout = () => { setToken(null); setUser(null); };
  const refresh = async () => { try { setUser(await api('/auth/me')); } catch { logout(); } };

  /* ---------- thème ---------- */
  const [theme, setTheme] = useState(() => safeGetItem('monreleve_theme')
    || (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    safeSetItem('monreleve_theme', theme);
  }, [theme]);

  return (
    <Ctx.Provider value={{ user, setUser, booting, login, register, logout, refresh, theme, setTheme, toggleTheme: () => setTheme((t) => (t === 'dark' ? 'light' : 'dark')) }}>
      {children}
    </Ctx.Provider>
  );
}
