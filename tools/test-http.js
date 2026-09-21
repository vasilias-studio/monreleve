/**
 * tools/test-http.js — essai de bout en bout de l'application en marche.
 *
 * Le serveur doit tourner (`npm run serve`) ; ce script parcourt les pages et les
 * formulaires réels avec des requêtes HTTP, quel que soit le pilote de base
 * (SQLite local, PostgreSQL/Supabase) et vérifie que les pages se construisent
 * correctement : codes de réponse, présence des données, et surtout ABSENCE de
 * `[object Promise]` — signature d'un `await` manquant après la migration.
 *
 * Usage : node tools/test-http.js [http://127.0.0.1:4000]
 */
const BASE = (process.argv[2] || 'http://127.0.0.1:4000').replace(/\/$/, '');

let ok = 0, ko = 0;
const journal = [];
const verifier = (nom, condition, detail = '') => {
  if (condition) { ok++; console.log(`  ✓ ${nom}`); }
  else { ko++; console.log(`  ✗ ${nom}${detail ? ' — ' + detail : ''}`); journal.push(nom); }
};

/** Requête sans suivi de redirection, pour lire les en-têtes. */
async function appel(chemin, { methode = 'GET', corps = null, cookie = null, type = 'form' } = {}) {
  const entetes = {};
  if (cookie) entetes.Cookie = cookie;
  let body;
  if (corps) {
    if (type === 'json') { entetes['Content-Type'] = 'application/json'; body = JSON.stringify(corps); }
    else { entetes['Content-Type'] = 'application/x-www-form-urlencoded'; body = new URLSearchParams(corps).toString(); }
  }
  const r = await fetch(BASE + chemin, { method: methode, headers: entetes, body, redirect: 'manual' });
  const texte = await r.text().catch(() => '');
  const setCookie = r.headers.getSetCookie ? r.headers.getSetCookie() : [r.headers.get('set-cookie')].filter(Boolean);
  return {
    statut: r.status,
    texte,
    cookie: setCookie.map((c) => c.split(';')[0]).join('; '),
    emplacement: r.headers.get('location') || '',
    type: r.headers.get('content-type') || '',
    disposition: r.headers.get('content-disposition') || '',
  };
}

const propre = (nom, reponse) => {
  verifier(nom, !reponse.texte.includes('[object Promise]'),
    reponse.texte.includes('[object Promise]') ? 'page contenant [object Promise] (await manquant)' : '');
};

console.log(`\nEssai HTTP de ${BASE}\n`);

/* 1. pages publiques */
const login = await appel('/login');
verifier('GET /login → 200', login.statut === 200, `statut ${login.statut}`);
verifier('page de connexion', /connexion|Connexion|se connecter/i.test(login.texte));
propre('/login', login);

const racine = await appel('/');
verifier('GET / → redirection', [301, 302, 303].includes(racine.statut), `statut ${racine.statut}`);

/* 2. connexion administrateur puis pages d'administration */
const connexionAdmin = await appel('/login', { methode: 'POST', corps: { email: 'admin@univ.mg', password: 'admin123' } });
verifier('POST /login (admin) → redirection', [301, 302, 303].includes(connexionAdmin.statut), `statut ${connexionAdmin.statut}`);
const cookieAdmin = connexionAdmin.cookie;
verifier('cookie de session posé', /mrt=/.test(cookieAdmin), cookieAdmin);
verifier('redirection de connexion sans jeton dans l URL', !/[?&]t=/.test(connexionAdmin.emplacement), connexionAdmin.emplacement);
const sessionAdmin = cookieAdmin.match(/(?:^|;\s*)mrt=([^;]+)/)?.[1] || '';
const lienPartage = await appel('/accueil?t=' + encodeURIComponent(sessionAdmin));
verifier('lien étudiant partagé sans cookie → connexion requise',
  [301, 302, 303].includes(lienPartage.statut) && /\/login(?:\?|$)/.test(lienPartage.emplacement),
  `${lienPartage.statut} ${lienPartage.emplacement}`);
const cookieUtiliseCommeApi = await fetch(BASE + '/api/auth/me', { headers: { Authorization: `Bearer ${sessionAdmin}` } });
verifier('jeton de cookie HTML refusé par l API', cookieUtiliseCommeApi.status === 403, `statut ${cookieUtiliseCommeApi.status}`);

for (const [chemin, attendu] of [
  ['/accueil', /annonce|Annonces/i],
  ['/admin', /admin/i],
  ['/admin/etudiants', /étudiant|etudiant/i],
  ['/admin/modeles', /modèle|modele/i],
  ['/admin/referentiels', /référentiel|referentiel|filière|filiere/i],
  ['/admin/import', /import/i],
  ['/admin/emploi', /emploi|créneau|creneau/i],
  ['/admin/messages', /message/i],
]) {
  const r = await appel(chemin, { cookie: cookieAdmin });
  verifier(`GET ${chemin} → 200`, r.statut === 200, `statut ${r.statut}`);
  verifier(`GET ${chemin} : contenu attendu`, attendu.test(r.texte));
  propre(chemin, r);
  if (chemin === '/accueil') {
    verifier('HTML étudiant/admin sans jeton de session', !/[?&]t=/.test(r.texte) && !/name="t"/.test(r.texte));
    verifier('composeur admin : image jointe et multipart', /enctype="multipart\/form-data"/.test(r.texte) && /name="image"/.test(r.texte));
  }
  if (chemin === '/admin/messages') {
    verifier('messagerie admin : liste des étudiants', /messenger-contact/.test(r.texte) && /messenger-inbox-page/.test(r.texte));
    const studentConversation = r.texte.match(/href="\/admin\/messages\?student=(\d+)"/);
    if (studentConversation) {
      const conversation = await appel(`/admin/messages?student=${studentConversation[1]}`, { cookie: cookieAdmin });
      verifier('messagerie admin : conversation étudiant', conversation.statut === 200 && /messenger-conversation-page/.test(conversation.texte) && /messenger-thread/.test(conversation.texte) && /messenger-composer/.test(conversation.texte));
      propre('messagerie admin', conversation);
    } else {
      verifier('messagerie admin : conversation étudiant', false, 'aucun étudiant dans la liste');
    }
  }
}

/* 3. API JSON (mêmes données, autre façade) — authentification par jeton porteur */
async function jeton(email, password) {
  const r = await fetch(BASE + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }),
  });
  const j = await r.json().catch(() => ({}));
  return { statut: r.status, jeton: j.token || '', corps: j };
}
const apiAdmin = await jeton('admin@univ.mg', 'admin123');
verifier('POST /api/auth/login (admin) → 200', apiAdmin.statut === 200, `statut ${apiAdmin.statut}`);
verifier('jeton d\'API renvoyé', Boolean(apiAdmin.jeton));
const repMe = await fetch(BASE + '/api/auth/me', { headers: { Authorization: `Bearer ${apiAdmin.jeton}` } });
const profil = await repMe.json().catch(() => null);
verifier('GET /api/auth/me → 200', repMe.status === 200, `statut ${repMe.status}`);
verifier('/api/auth/me : session administrateur', profil?.user?.role === 'admin' || profil?.role === 'admin', JSON.stringify(profil).slice(0, 120));
/* (le contrôle API côté étudiant est fait plus bas, une fois la session étudiante ouverte) */

/* 4. connexion étudiante : ses propres données seulement
 *    (plusieurs comptes possibles : celui du poste de travail, puis ceux du seed) */
const CANDIDATS = ['ericotlauranto34@gmail.com', 'naina.randria@example.mg', 'tojo.hanta@example.mg'];
let connexionEtudiant = null, emailEtudiant = '';
for (const email of CANDIDATS) {
  const essai = await appel('/login', { methode: 'POST', corps: { email, password: 'etudiant123' } });
  if ([301, 302, 303].includes(essai.statut) && /mrt=/.test(essai.cookie)) { connexionEtudiant = essai; emailEtudiant = email; break; }
}
verifier('POST /login (étudiant) → redirection', Boolean(connexionEtudiant), `aucun compte étudiant parmi : ${CANDIDATS.join(', ')}`);
if (!connexionEtudiant) { console.log('\n(impossible de poursuivre sans compte étudiant)\n'); process.exit(1); }
console.log(`  · session étudiante : ${emailEtudiant}`);
const cookieEtudiant = connexionEtudiant.cookie;
const apiEtudiant = await jeton(emailEtudiant, 'etudiant123');
const repEtudiant = await fetch(BASE + '/api/auth/me', { headers: { Authorization: `Bearer ${apiEtudiant.jeton}` } });
const profilEtudiant = await repEtudiant.json().catch(() => null);
verifier('API étudiant : profil complet', repEtudiant.status === 200 && Boolean(profilEtudiant), JSON.stringify(profilEtudiant).slice(0, 120));

for (const chemin of ['/accueil', '/saisie', '/releve', '/calendrier?weeks=2', '/messages', '/profil']) {
  const r = await appel(chemin, { cookie: cookieEtudiant });
  verifier(`étudiant GET ${chemin} → 200`, r.statut === 200, `statut ${r.statut}`);
  propre(`étudiant ${chemin}`, r);
  if (chemin === '/messages') {
    verifier('navigation : bouton message présent', /pb-send|Envoyer un message/i.test(r.texte));
    verifier('messagerie : liste de contacts', /messenger-contact/.test(r.texte) && /messenger-inbox-page/.test(r.texte));
    verifier('formulaire de message présent', /name="subject"/.test(r.texte) && /name="body"/.test(r.texte));
    const conversation = await appel('/messages?conversation=admin', { cookie: cookieEtudiant });
    verifier('messagerie : conversation étudiant', conversation.statut === 200 && /messenger-conversation-page/.test(conversation.texte) && /messenger-thread/.test(conversation.texte) && /messenger-composer/.test(conversation.texte));
    propre('messagerie étudiant', conversation);
  }
}
const enteteAccueil = await appel('/accueil', { cookie: cookieEtudiant });
const topbarAccueil = enteteAccueil.texte.match(/<header class="topbar[\s\S]*?<\/header>/)?.[0] || '';
verifier('barre Frame-115 sur l accueil', /topbar-home/.test(topbarAccueil) && /topbar-avatar/.test(topbarAccueil) && /Bonjour/.test(topbarAccueil) && /topbar-theme/.test(topbarAccueil) && !/Se déconnecter/.test(topbarAccueil));
const enteteProfil = await appel('/profil', { cookie: cookieEtudiant });
const topbarProfil = enteteProfil.texte.match(/<header class="topbar[\s\S]*?<\/header>/)?.[0] || '';
verifier('barre Frame-115 sur les autres pages', /topbar-page/.test(topbarProfil) && /topbar-name/.test(topbarProfil) && !/topbar-greeting/.test(topbarProfil));
verifier('profil : bouton retour et navigation basse masquée', /topbar-back/.test(topbarProfil) && !/class="tabbar"/.test(enteteProfil.texte));
verifier('profil : ajout photo et déconnexion', /name="photo"/.test(enteteProfil.texte) && /Se déconnecter/.test(enteteProfil.texte));
const profilAdmin = await appel('/profil', { cookie: cookieAdmin });
verifier('profil admin : photo et retour disponibles', profilAdmin.statut === 200 && /name="photo"/.test(profilAdmin.texte) && /topbar-back/.test(profilAdmin.texte));
const enteteSombre = await appel('/accueil?th=dark', { cookie: cookieEtudiant });
verifier('barre Frame-115 en mode sombre', /<html[^>]+data-theme="dark"/.test(enteteSombre.texte) && /topbar-home/.test(enteteSombre.texte));
const annonceAccueil = await appel('/accueil', { cookie: cookieEtudiant });
const idAnnonceAccueil = annonceAccueil.texte.match(/href="\/accueil\/annonces\/(\d+)"/)?.[1];
const imageAnnoncePath = annonceAccueil.texte.match(/\/accueil\/annonces\/(\d+)\/image/)?.[0];
verifier('accueil : carrousel et cartes d annonces BDD', /announcement-carousel|post-main/.test(annonceAccueil.texte) && Boolean(idAnnonceAccueil));
verifier('accueil : défilement horizontal toutes les 3 secondes', /setInterval\(function \(\) \{ go\(index \+ 1\); \}, 3000\)/.test(annonceAccueil.texte));
if (idAnnonceAccueil) {
  const annonceDetail = await appel(`/accueil/annonces/${idAnnonceAccueil}`, { cookie: cookieEtudiant });
  verifier('détail annonce → 200', annonceDetail.statut === 200, `statut ${annonceDetail.statut}`);
  verifier('détail : image, panneau blanc et retour', /announcement-detail-media/.test(annonceDetail.texte) && /announcement-detail-sheet/.test(annonceDetail.texte) && /announcement-back/.test(annonceDetail.texte));
  verifier('détail : barre supérieure et navigation masquées', !/class="topbar/.test(annonceDetail.texte) && !/class="tabbar/.test(annonceDetail.texte));
  propre('détail annonce', annonceDetail);
}
if (imageAnnoncePath) {
  const imageAnnonce = await fetch(BASE + imageAnnoncePath, { headers: { Cookie: cookieEtudiant } });
  verifier('image jointe à l annonce → JPEG servi', imageAnnonce.status === 200 && /image\/jpeg/i.test(imageAnnonce.headers.get('content-type') || ''), `statut ${imageAnnonce.status}`);
} else {
  verifier('image jointe à l annonce → URL BDD présente', false, 'aucune image jointe trouvée dans le carrousel');
}
const archivesEtudiant = await appel('/archives', { cookie: cookieEtudiant });
verifier('archives : page accessible', archivesEtudiant.statut === 200 && /Archives/.test(archivesEtudiant.texte));
verifier('archives : sujets et téléchargements présents', /Sujets de révision/.test(archivesEtudiant.texte) && /Télécharger le sujet/.test(archivesEtudiant.texte));
verifier('archives : navigation remplace Relevé', /href="\/archives"/.test(archivesEtudiant.texte) && /Archives/.test(archivesEtudiant.texte) && !/href="\/releve"[^>]*>Relevé/.test(archivesEtudiant.texte));
propre('/archives', archivesEtudiant);
const releveCompat = await appel('/releve', { cookie: cookieEtudiant });
verifier('compatibilité /releve → page Archives', releveCompat.statut === 200 && /Archives|Sujets de révision/.test(releveCompat.texte));
propre('/releve', releveCompat);
const saisieEtudiant = await appel('/saisie', { cookie: cookieEtudiant });
verifier('saisie : moyennes S3 et S4 en haut', saisieEtudiant.statut === 200 && /Moyennes des semestres/.test(saisieEtudiant.texte) && /Moyenne S3/.test(saisieEtudiant.texte) && /Moyenne S4/.test(saisieEtudiant.texte) && saisieEtudiant.texte.indexOf('Moyennes des semestres') < saisieEtudiant.texte.indexOf('Saisie de notes'));
verifier('saisie : ancien relevé retiré', !/saisie-releve-fusion|Relevé complet|Moyennes & progression/.test(saisieEtudiant.texte));
verifier('saisie : formulaire et calcul en direct conservés', /Saisie de notes/.test(saisieEtudiant.texte) && /Moyenne générale \(en direct\)/.test(saisieEtudiant.texte));
propre('/saisie avec moyennes S3/S4', saisieEtudiant);

const sujetPath = archivesEtudiant.texte.match(/href="(\/archives\/sujets\/[^"?]+\.pdf)"/)?.[1];
if (sujetPath) {
  const sujet = await fetch(BASE + sujetPath, { headers: { Cookie: cookieEtudiant } });
  verifier('sujet de révision protégé → PDF 200', sujet.status === 200 && /application\/pdf/i.test(sujet.headers.get('content-type') || ''), `statut ${sujet.status}`);
  verifier('sujet de révision en téléchargement', /attachment/i.test(sujet.headers.get('content-disposition') || ''));
  const sujetPublic = await appel(sujetPath);
  verifier('sujet de révision sans session → connexion requise', [301, 302, 303].includes(sujetPublic.statut) && /login/.test(sujetPublic.emplacement));
} else {
  verifier('un sujet de révision est proposé', false, 'aucun lien de sujet trouvé');
}

/* 5. exports PDF (une page) */
const pdf = await appel('/mon-releve.pdf', { cookie: cookieEtudiant });
verifier('GET /mon-releve.pdf → 200', pdf.statut === 200, `statut ${pdf.statut}`);
verifier('PDF renvoyé', pdf.texte.startsWith('%PDF') && /application\/pdf/i.test(pdf.type));
verifier('PDF en téléchargement', /attachment/i.test(pdf.disposition));
const xlsx = await appel('/mon-releve.xlsx', { cookie: cookieEtudiant });
verifier('GET /mon-releve.xlsx → 200', xlsx.statut === 200, `statut ${xlsx.statut}`);
verifier('Excel renvoyé', /spreadsheetml|application\/vnd\.openxmlformats-officedocument/i.test(xlsx.type));
verifier('Excel en téléchargement', /attachment/i.test(xlsx.disposition));

/* 6. action d'écriture : « J'aime » sur une annonce (puis retour à l'état initial) */
const accueilEtudiant = await appel('/accueil', { cookie: cookieEtudiant });
const idAnnonce = accueilEtudiant.texte.match(/\/accueil\/annonces\/(\d+)\/aime/)?.[1];
if (idAnnonce) {
  const aime = await appel(`/accueil/annonces/${idAnnonce}/aime`, { methode: 'POST', cookie: cookieEtudiant });
  verifier('POST /accueil/:id/aime → redirection', [301, 302, 303].includes(aime.statut), `statut ${aime.statut}`);
  const retour = await appel(`/accueil/annonces/${idAnnonce}/aime`, { methode: 'POST', cookie: cookieEtudiant });   /* on remet l'état d'origine */
  verifier('second clic (retrait du like)', [301, 302, 303].includes(retour.statut));
  const apres = await appel('/accueil', { cookie: cookieEtudiant });
  propre('/accueil après écriture', apres);
} else {
  verifier('annonce présente pour tester « J\'aime »', false, 'aucun lien /aime trouvé');
}

/* 6b. import Excel : le classeur est reçu, rangé en base, puis relu pour l'aperçu
 *     (aucun disque : indispensable sur un hébergement sans serveur) */
import fs from 'node:fs';
const fichierTest = 'Relev-de-notes.xlsx';
if (fs.existsSync(fichierTest)) {
  const donnees = new FormData();
  donnees.append('file', new Blob([fs.readFileSync(fichierTest)]), fichierTest);
  const envoi = await fetch(BASE + '/admin/import/upload', { method: 'POST', headers: { Cookie: cookieAdmin }, body: donnees, redirect: 'manual' });
  const emplacement = envoi.headers.get('location') || '';
  verifier('POST /admin/import/upload → redirection', [301, 302, 303].includes(envoi.status), `statut ${envoi.status}`);
  verifier('identifiant de fichier renvoyé', /[?&]file=[\w.\-]+/.test(emplacement), emplacement);
  if (/[?&]file=/.test(emplacement)) {
    const apercu = await appel(emplacement.replace(BASE, ''), { cookie: cookieAdmin });
    verifier('aperçu du classeur importé → 200', apercu.statut === 200, `statut ${apercu.statut}`);
    verifier('aperçu : feuilles lues depuis la base', /Feuil|feuille|Semestre/i.test(apercu.texte));
    verifier('aperçu : aucune erreur d import', !/Fichier import introuvable/i.test(apercu.texte));
    propre('aperçu de l\'import', apercu);
    /* import réel de la structure vers un modèle — non testé ici : il écrirait dans la base */
  }

  /* Fichiers refusés : l'erreur doit être lisible, jamais une page blanche ni une trace technique */
  const mauvais = new FormData();
  mauvais.append('file', new Blob([Buffer.from('ceci n est pas un classeur')], { type: 'text/plain' }), 'notes.txt');
  const refus = await fetch(BASE + '/admin/import/upload', { method: 'POST', headers: { Cookie: cookieAdmin }, body: mauvais });
  const texteRefus = await refus.text();
  verifier('import d un fichier .txt → refusé proprement', refus.status === 400 || /Format attendu/.test(texteRefus), `statut ${refus.status}`);
  verifier('le refus explique le format attendu', /xlsx|xls|Format attendu/i.test(texteRefus));

  const vide = new FormData();
  vide.append('file', new Blob([Buffer.from('PK')], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), 'casse.xlsx');
  const casse = await fetch(BASE + '/admin/import/upload', { method: 'POST', headers: { Cookie: cookieAdmin }, body: vide });
  const texteCasse = await casse.text();
  verifier('classeur illisible → message clair', casse.status < 500 && !/at Object\.|at async |node_modules/.test(texteCasse), `statut ${casse.status}`);
} else {
  console.log(`  · ${fichierTest} absent : import non testé`);
}

/* 7. visiteurs non connectés : les pages privées redirigent */
for (const chemin of ['/accueil', '/archives', '/releve', '/admin', '/saisie', '/messages']) {
  const r = await appel(chemin);
  verifier(`visiteur ${chemin} → redirection`, [301, 302, 303].includes(r.statut), `statut ${r.statut}`);
}

console.log(`\n${ko === 0 ? '✓' : '✗'} ${ok} contrôle(s) réussi(s), ${ko} échec(s)${journal.length ? ' : ' + journal.join(' · ') : ''}\n`);
process.exit(ko === 0 ? 0 : 1);
