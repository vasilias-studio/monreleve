# MonRelevé — kit Figma modifiable 🎨

## Option A (recommandée) : le CSS officiel à copier-coller

- **`design/monreleve-styles.css`** — toute la charte du site en un seul fichier propre :
  tokens (`:root` + variante `[data-theme="dark"]`), typographie, et un composant par section
  (topbar, tabbar, card, hero, stat, chip, bar, list-item, field/input/.gin, btn ×4 variantes,
  segments, tbl, banner, auth…). Valeurs **littérales compatibles importateurs Figma**
  (pas de `color-mix()`/`env()`), chaque bloc est commenté avec son équivalent
  *Figma style* (couleur, effet, rayon, variante de composant).
  Figma ne colle pas du CSS brut sur le canvas : utilisez un plugin de la famille
  **« CSS to Figma » / « html.to.design »** (menu *Plugins ▸ Discover plugins*), ou servez-vous
  du fichier comme tableau de référence pour créer vos Local styles (les hex sont en tête de
  chaque variable).
- **`design/monreleve-kit.html`** — le kit de composants rendu (mêmes CSS embarqués + exemples
  vivants de chaque composant + bascule clair/sombre). Collez son **code source** dans
  html.to.design (mode *Paste code*) → les frames importés arrivent **avec** couleurs, typos,
  rayons et ombres déjà appliqués.

## Option B : les maquettes SVG écran par écran

Dossier `design/figma/` : **11 écrans du site, vectorisés en SVG**, générés à partir du
code réel (charte « Vasilías » exacte de `styles.css`, données réelles de la base — notes, moyennes,
statuts, libellés). Importés dans Figma, ils deviennent des **calques entièrement
modifiables** : vrais textes, vrais rectangles, puces, champs, tableaux.

## Contenu

| Fichier | Écran | Plan de travail |
|---|---|---|
| `monreleve-01-connexion.svg` | Connexion | 390 × 520 |
| `monreleve-03-accueil-etudiant.svg` | Accueil étudiant (hero, stats, semestres, onglets bas) | 390 × 630 |
| `monreleve-04-saisie-etudiant.svg` | Saisie de notes (grille type Excel + cartes « en direct ») | 390 × 923 |
| `monreleve-05-releve.svg` | Relevé unifié (segmenté Mes notes / Officiel, totaux + Moyennes & progression) | 390 × 942 |
| `monreleve-10-admin-tableau-de-bord.svg` | Admin — tableau de bord | 1280 × 620 |
| `monreleve-11-admin-etudiants.svg` | Admin — liste + recherche + création | 1280 × 640 |
| `monreleve-12-admin-fiche-etudiant.svg` | Admin — fiche + notes officielles | 1280 × 708 |
| `monreleve-13-admin-editeur-modele.svg` | Admin — modèle : règles de calcul + structure éditable | 1280 × 938 |
| `monreleve-14-admin-import.svg` | Admin — import Excel avec aperçu & confirmation | 1280 × 796 |
| `monreleve-15-admin-referentiels.svg` | Admin — référentiels | 1280 × 770 |
| `monreleve-07-calendrier-etudiant.svg` | Calendrier — emploi du temps (vue hebdo par semestre) | 390 × 680 |
| `monreleve-complet.svg` | **La planche des 11 écrans** (repères de nom/taille inclus) | 2728 × ~3800 |

## Import dans Figma (2 minutes)

1. Ouvrez un fichier Figma (nouveau design file).
2. **Glissez-déposez** les SVG depuis ce dossier sur le canvas (ou *File ▸ Import*).
   Chaque SVG devient un groupe de calques vectoriels.
3. Sélectionnez un écran → **`Ctrl/Cmd + Alt + G`** (*Frame selection*) : chaque écran
   devient un **frame** prêt pour le design (et l'export).
4. Les groupes sont déjà nommés (`carte-grille-saisie`, `stat-Moyenne générale…`,
   `btn-…`, `tab-Accueil`…) : votre arborescence de calques est lisible.

## Palette officielle (à déclarer en *Local styles*)

| Rôle | Hex | Rôle | Hex |
|---|---|---|---|
| fond (papier) | `#F2E9D8` | encre (texte) | `#161513` |
| surface douce | `#ECE9E2` | accent (ocre) | `#BF814B` |
| carte | `#FFFFFF` (sur le site : blanc 60 % sur papier) | muet | `#8A857C` |
| carte douce | `#FBF7EE` | ~~ligne (filets)~~ | retirés du design → `transparent` |
| ok | `#4E6E54` / fond `#E4EBE1` | warn | `#9A6218` / `#F3E3D2` |
| bad | `#9C3B2E` / `#F2DFDB` | info | `#55606E` / `#E6E9EC` |

Typo : **Josefin Sans** (400 / 500 / 600 / 700) — chargée via Google Fonts dans l'app ; installez-la
dans Figma ou laissez le fallback. Titres en capitales (H1 de page), `letter-spacing:-.02em`,
micro-labels « eyebrow » en 12px majuscules `letter-spacing:.12em`.
Rayons : **2 px partout** (cartes, champs, bandeaux), **pilules 999 px** pour boutons/puces/segments —
c'est la signature du style. Design **plat** : aucune ombre, aucun dégradé ; séparation par filets 1 px ;
header = papier à 92 % + flou 8 px ; panneau « hero » = bloc encre plein. Le site utilise aussi un mode
sombre (inversion papier/encre, accent éclairci `#CF9460`) — pensez à le designer en variante.

## Après le redesign

Exportez vos frames modifiés (ou simplement décrivez les changements : couleurs, espacements,
composants, écrans nouveaux) et je les **réimplémente dans le code du site** — la structure
HTML étant rendue par un seul gabarit + un CSS partagé, l'application d'un nouveau design
est rapide et ne casse aucune logique (calculs, permissions, import restent intacts).

## Bonus : import « pixel-perfect » de la page vivante

Le plugin Figma **html.to.design** (gratuit) peut capturer une URL réelle :
`https://<hôte-d'aperçu>/accueil?t=<votre jeton>` (le jeton `?t=` vous identifie sans cookie).
Utile pour des écrans absents de la planche (inscription, profil, reset…). Résultat : des
couches Figma alignées au pixel sur le rendu navigateur.
