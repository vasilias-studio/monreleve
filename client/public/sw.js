/* sw.js — ANCIEN service worker, désormais auto-destructif.
 * Le cache applicatif est géré par le navigateur uniquement (en-têtes HTTP: index no-store,
 * assets hashés immutables). Ce stub nettoie les résidus des versions précédentes :
 * vider les caches puis se désenregistrer. Les clients déjà enregistrés se réparent seuls. */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', () => {
  caches.keys()
    .then((keys) => Promise.all(keys.map((k) => caches.delete(k))))
    .then(() => self.registration.unregister())
    .then(() => self.clients.matchAll({ type: 'window' }))
    .then((clients) => clients.forEach((c) => c.navigate()));
});
