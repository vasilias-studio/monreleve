#!/usr/bin/env bash
# ============================================================
# tools/github-publish.sh — crée le dépôt GitHub et pousse MonRelevé.
#
#   GITHUB_TOKEN=ghp_xxx bash tools/github-publish.sh
#   GITHUB_TOKEN=ghp_xxx bash tools/github-publish.sh --name mon-releve --private
#   GITHUB_TOKEN=ghp_xxx bash tools/github-publish.sh --dry-run     (aucune écriture)
#
# Le jeton n'est JAMAIS écrit sur le disque : il n'est utilisé que dans l'URL de
# la commande git push (transitoire). Portées nécessaires pour un jeton classique :
#   · repo      → créer le dépôt et pousser
#   · workflow  → pousser .github/workflows/site-statique.yml (publication Pages)
# ============================================================
set -euo pipefail

NAME="monreleve"
VISIBILITY="public"
DRY=0
TOKEN="${GITHUB_TOKEN:-}"

while [ $# -gt 0 ]; do
  case "$1" in
    --name) NAME="$2"; shift 2 ;;
    --private) VISIBILITY="private"; shift ;;
    --public) VISIBILITY="public"; shift ;;
    --token) TOKEN="$2"; shift 2 ;;
    --dry-run) DRY=1; shift ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "Option inconnue : $1" >&2; exit 2 ;;
  esac
done

say()  { printf '\n\033[1m%s\033[0m\n' "$*"; }
fail() { printf '\n\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

[ -n "$TOKEN" ] || fail "Jeton absent. Relancez avec GITHUB_TOKEN=… (ou --token …)"
command -v git >/dev/null || fail "git introuvable"
command -v curl >/dev/null || fail "curl introuvable"
[ -d .git ] || fail "Lancez le script depuis la racine du projet (dossier contenant .git)"

API="https://api.github.com"
AUTH=(-H "Authorization: Bearer $TOKEN" -H "Accept: application/vnd.github+json" -H "X-GitHub-Api-Version: 2022-11-28")

say "1/5 · Vérification du jeton"
ME=$(curl -sS -m 20 "${AUTH[@]}" "$API/user" || true)
LOGIN=$(printf '%s' "$ME" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const j=JSON.parse(s);process.stdout.write(String(j.login||''))}catch(e){}})")
[ -n "$LOGIN" ] || fail "Jeton refusé par GitHub (réponse : $(printf '%s' "$ME" | head -c 160)). Vérifiez la portée « repo » (et « workflow »)."
UID_NUM=$(printf '%s' "$ME" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{process.stdout.write(String(JSON.parse(s).id||''))}catch(e){}})")
echo "  connecté en tant que : $LOGIN (id $UID_NUM)"

if [ -z "$(git log --oneline 2>/dev/null | head -1)" ]; then
  say "2/5 · Premier commit"
  git add -A
  git -c user.name="$LOGIN" -c user.email="${UID_NUM}+${LOGIN}@users.noreply.github.com" \
      commit -q -m "MonRelevé v2 — application de notes (site HTML serveur + console admin)"
  git branch -M main
else
  say "2/5 · Commit existant (réutilisé)"
  git log --oneline -1
  # le commit existant est réattribué au compte GitHub (auteur + committer)
  git -c user.name="$LOGIN" -c user.email="${UID_NUM}+${LOGIN}@users.noreply.github.com" \
      commit -q --amend --no-edit --reset-author 2>/dev/null \
    && echo "  auteur du commit : $LOGIN <${UID_NUM}+${LOGIN}@users.noreply.github.com>" || true
fi

say "3/5 · Dépôt GitHub « $NAME » ($VISIBILITY)"
CODE=$(curl -sS -m 25 -o /tmp/gh-create.json -w '%{http_code}' "${AUTH[@]}" \
  -X POST "$API/user/repos" \
  -d "{\"name\":\"$NAME\",\"description\":\"MonRelevé — application de gestion des notes universitaires (Node.js + SQLite, espace étudiant + console admin)\",\"private\":$([ "$VISIBILITY" = private ] && echo true || echo false),\"has_issues\":true,\"has_wiki\":false,\"auto_init\":false}" || true)
case "$CODE" in
  201) echo "  dépot créé : https://github.com/$LOGIN/$NAME" ;;
  422) echo "  le dépôt existe déjà → on pousse dedans" ;;
  403|401) fail "Création refusée (HTTP $CODE) : $(node -e "try{console.log(JSON.parse(require('fs').readFileSync('/tmp/gh-create.json','utf8')).message)}catch(e){console.log('')}" | head -c 200)" ;;
  *) fail "Création impossible (HTTP $CODE) : $(head -c 200 /tmp/gh-create.json)" ;;
esac
if [ "$DRY" = "1" ]; then
  say "Mode --dry-run : arrêt avant l'envoi des fichiers."
  exit 0
fi

say "4/5 · Envoi des fichiers (git push)"
git remote remove origin 2>/dev/null || true
git remote add origin "https://github.com/$LOGIN/$NAME.git"
# le jeton reste dans la commande, jamais dans .git/config
if git push -q "https://x-access-token:$TOKEN@github.com/$LOGIN/$NAME.git" main 2>/tmp/gh-push.log; then
  echo "  poussé : $(git rev-list --count main) commit(s), $(git ls-files | wc -l) fichiers"
else
  tail -3 /tmp/gh-push.log
  if grep -q "workflow" /tmp/gh-push.log; then
    fail "Refus sur .github/workflows : le jeton n'a pas la portée « workflow » (jeton classique) ou « Workflows: write » (jeton fin). Ajoutez-la puis relancez — le dépôt et le commit sont déjà prêts."
  fi
  fail "Échec du push (voir ci-dessus)."
fi

say "5/5 · Suite"
cat <<TXT
  · dépôt            : https://github.com/$LOGIN/$NAME
  · site statique    : dépôt → Settings → Pages → Source = « GitHub Actions »
                       (le workflow publie site-html/ à chaque push)
  · hébergement app  : Render → New → Blueprint → ce dépôt (render.yaml fourni)
                       ou Northflank avec volume persistant monté sur /data
  · détail des offres: DEPLOIEMENT.md
TXT
