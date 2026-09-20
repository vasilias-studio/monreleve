/* history.js — historique « pushState-free » pour l'aperçu en iframe sandboxée.
 * En contexte opaque (sandbox sans allow-same-origin), history.pushState/replaceState lève
 * une SecurityError → l'app réagissait en crashant à la première navigation (écran gris).
 * Ici, toute navigation passe par le hash natif (location.hash), toujours autorisé. */

const read = () => {
  const raw = window.location.hash.slice(1) || '/';
  const qi = raw.indexOf('?');
  const pathname = (qi >= 0 ? raw.slice(0, qi) : raw) || '/';
  const search = qi >= 0 ? raw.slice(qi) : '';
  return { pathname, search, hash: '', state: null, key: 'k' + Date.now() };
};

export function createSafeHashHistory() {
  const listeners = new Set();
  const notify = () => listeners.forEach((l) => l({ action: 'POP', location: read() }));

  const goTo = (to, replace) => {
    const target = '#' + (typeof to === 'string' ? to : (to.pathname || '/') + (to.search || ''));
    try {
      if (replace) window.location.replace(target);
      else window.location.hash = target.slice(1);
    } catch {
      try { window.location.href = target; } catch { /* cadre figé : rien d'autre à faire */ }
    }
    // hash identique → pas d'événement hashchange : notifier manuellement
    setTimeout(() => { if (read().pathname !== currentLocation.pathname) notify(); }, 0);
  };

  let currentLocation = read();
  window.addEventListener('hashchange', () => { currentLocation = read(); notify(); });

  return {
    get index() { return 0; },
    get location() { currentLocation = read(); return currentLocation; },
    get action() { return 'POP'; },
    createHref: (to) => '#' + (typeof to === 'string' ? to : (to.pathname || '/') + (to.search || '')),
    encodeLocation: (loc) => loc,
    push: (to) => goTo(to, false),
    replace: (to) => goTo(to, true),
    go() { /* navigation par hash uniquement ; back/forward restent gérés par le navigateur */ },
    listen(listener) { listeners.add(listener); return () => listeners.delete(listener); },
  };
}
