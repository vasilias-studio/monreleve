/* App.jsx — routeur + coquilles de navigation (onglets bas pour l'étudiant, barre d'onglets admin). */
import React from 'react';
import { Routes, Route, NavLink, Navigate, useLocation, Outlet } from 'react-router-dom';
import { useApp } from './store.jsx';
import { Spinner } from './ui.jsx';

import Login from './pages/Login.jsx';
import Register from './pages/Register.jsx';
import Forgot from './pages/Forgot.jsx';
import Home from './pages/student/Home.jsx';
import Releve from './pages/student/Releve.jsx';
import Moyennes from './pages/student/Moyennes.jsx';
import Profil from './pages/student/Profil.jsx';
import AdminDashboard from './pages/admin/Dashboard.jsx';
import Students from './pages/admin/Students.jsx';
import StudentDetail from './pages/admin/StudentDetail.jsx';
import Templates from './pages/admin/Templates.jsx';
import TemplateEditor from './pages/admin/TemplateEditor.jsx';
import ImportPage from './pages/admin/Import.jsx';
import Refs from './pages/admin/Refs.jsx';

const I = {
  home: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 10.5 12 3l9 7.5" /><path d="M5 9.5V21h14V9.5" /></svg>,
  list: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M8 6h13M8 12h13M8 18h13" /><circle cx="4" cy="6" r="1" fill="currentColor" /><circle cx="4" cy="12" r="1" fill="currentColor" /><circle cx="4" cy="18" r="1" fill="currentColor" /></svg>,
  chart: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M4 20v-8M10 20V4M16 20v-6M21 20H3" /></svg>,
  user: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="12" cy="8" r="4" /><path d="M4 21c1.5-4 5-5.5 8-5.5S18.5 17 20 21" /></svg>,
};

function ThemeToggle() {
  const { theme, toggleTheme } = useApp();
  return <button className="icon-btn" onClick={toggleTheme} aria-label="Changer de thème" title="Thème">{theme === 'dark' ? '☀️' : '🌙'}</button>;
}

export function TopBar({ title, right }) {
  return (
    <header className="topbar">
      <div className="brand"><span className="logo-dot">MR</span> MonRelevé</div>
      <div className="spacer" />
      {title && <strong className="small" style={{ color: 'var(--muted)' }}>{title}</strong>}
      {right}
      <ThemeToggle />
    </header>
  );
}

function StudentLayout() {
  return (
    <>
      <TopBar />
      <main className="fade"><Outlet /></main>
      <nav className="tabbar">
        <NavLink to="/accueil" className={({ isActive }) => (isActive ? 'active' : '')}><I.home />Accueil</NavLink>
        <NavLink to="/releve" className={({ isActive }) => (isActive ? 'active' : '')}><I.list />Relevé</NavLink>
        <NavLink to="/moyennes" className={({ isActive }) => (isActive ? 'active' : '')}><I.chart />Moyennes</NavLink>
        <NavLink to="/profil" className={({ isActive }) => (isActive ? 'active' : '')}><I.user />Profil</NavLink>
      </nav>
    </>
  );
}

function AdminLayout() {
  const tabs = [
    ['/admin', 'Tableau de bord', true],
    ['/admin/etudiants', 'Étudiants'],
    ['/admin/modeles', 'Modèles'],
    ['/admin/import', 'Import Excel'],
    ['/admin/referentiels', 'Référentiels'],
  ];
  const { pathname } = useLocation();
  return (
    <>
      <TopBar title="Espace administrateur" />
      <nav className="admin-nav" aria-label="Navigation administration">
        {tabs.map(([to, label, exact]) => (
          <NavLink key={to} to={to} end={exact}
            className={({ isActive }) => `admin-nav-link${isActive ? ' is-active' : ''}`}
            aria-current={pathname === to || (!exact && pathname.startsWith(to + '/')) ? 'page' : undefined}>
            {label}
          </NavLink>
        ))}
      </nav>
      <main className="wide fade"><Outlet /></main>
    </>
  );
}

function Guard({ role, children }) {
  const { user, booting } = useApp();
  if (booting) return <div style={{ minHeight: '100dvh', display: 'grid', placeItems: 'center' }}><Spinner /></div>;
  if (!user) return <Navigate to="/login" replace />;
  if (role && user.role !== role) return <Navigate to={user.role === 'admin' ? '/admin' : '/accueil'} replace />;
  return children;
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/register" element={<Register />} />
      <Route path="/forgot" element={<Forgot />} />
      <Route element={<Guard role="student"><StudentLayout /></Guard>}>
        <Route path="/moyennes" element={<Moyennes />} />
        <Route path="/accueil" element={<Home />} />
        <Route path="/releve" element={<Releve />} />
        <Route path="/profil" element={<Profil />} />
      </Route>
      <Route element={<Guard role="admin"><AdminLayout /></Guard>}>
        <Route path="/admin" element={<AdminDashboard />} />
        <Route path="/admin/etudiants" element={<Students />} />
        <Route path="/admin/etudiants/:id" element={<StudentDetail />} />
        <Route path="/admin/modeles" element={<Templates />} />
        <Route path="/admin/modeles/:id" element={<TemplateEditor />} />
        <Route path="/admin/import" element={<ImportPage />} />
        <Route path="/admin/referentiels" element={<Refs />} />
      </Route>
      <Route path="*" element={<RedirectHome />} />
    </Routes>
  );
}
function RedirectHome() {
  const { user, booting } = useApp();
  if (booting) return <Spinner />;
  return <Navigate to={user ? (user.role === 'admin' ? '/admin' : '/accueil') : '/login'} replace />;
}
