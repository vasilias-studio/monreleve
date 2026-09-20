import React from 'react';
import { createRoot } from 'react-dom/client';
import { unstable_HistoryRouter as HistoryRouter } from 'react-router-dom';
import App from './App.jsx';
import { AppProvider } from './store.jsx';
import { createSafeHashHistory } from './history.js';
import './styles.css';

const history = createSafeHashHistory();

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <HistoryRouter history={history}>
      <AppProvider>
        <App />
      </AppProvider>
    </HistoryRouter>
  </React.StrictMode>
);

