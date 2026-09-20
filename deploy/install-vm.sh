#!/usr/bin/env bash
# ============================================================
# deploy/install-vm.sh — installe MonRelevé sur une VM Ubuntu/Debian vierge
# (Oracle Cloud Always Free, Google Cloud e2-micro, VM d'école…).
#
#   sudo bash deploy/install-vm.sh
#
# Ce que fait le script : Node 20 si absent, l'utilisateur système `monreleve`,
# le code dans /opt/monreleve, les données dans /var/lib/monreleve, le service
# systemd, et une sauvegarde quotidienne de la base (cron 3 h).
# Rejouable sans risque (idempotent) : il ne remplace jamais une base existante.
# ============================================================
set -euo pipefail

APP_DIR=/opt/monreleve
DATA_DIR=/var/lib/monreleve
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }

say "1/6 · Node.js ≥ 20"
if ! command -v node >/dev/null || [ "$(node -v | sed 's/v\([0-9]*\).*/\1/')" -lt 20 ]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi
node -v

say "2/6 · Utilisateur système"
id -u monreleve >/dev/null 2>&1 || useradd --system --create-home --shell /usr/sbin/nologin monreleve

say "3/6 · Code dans $APP_DIR"
mkdir -p "$APP_DIR"
# on ne touche jamais à la base : seuls le code et les dépendances sont mis à jour
for d in server client tools .github; do [ -d "$SRC_DIR/$d" ] && cp -r "$SRC_DIR/$d" "$APP_DIR/"; done
for f in package.json package-lock.json Dockerfile "Relev-de-notes.xlsx"; do [ -f "$SRC_DIR/$f" ] && cp "$SRC_DIR/$f" "$APP_DIR/"; done
cd "$APP_DIR"
sudo -u monreleve npm ci --omit=dev

say "4/6 · Données dans $DATA_DIR"
mkdir -p "$DATA_DIR"
chown -R monreleve:monreleve "$DATA_DIR" "$APP_DIR"

say "5/6 · Service systemd"
cp "$SRC_DIR/deploy/monreleve.service" /etc/systemd/system/monreleve.service
systemctl daemon-reload
systemctl enable --now monreleve
sleep 3
systemctl --no-pager --lines=5 status monreleve || true

say "6/6 · Sauvegarde quotidienne à 3 h"
( crontab -u monreleve -l 2>/dev/null; echo "0 3 * * * cd $APP_DIR && /usr/bin/npm run backup -- --cron" ) | sort -u | crontab -u monreleve -

cat <<TXT

Terminé. Application sur : http://$(hostname -I | awk '{print $1}'):4000
  · journaux      : journalctl -u monreleve -f
  · mise à jour   : rejouer ce script (les données ne sont pas touchées)
  · sauvegardes   : $DATA_DIR/backups
  · premier admin : cd $APP_DIR && sudo -u monreleve npm run create-admin -- --email vous@univ.mg --password 'motdepasse'
Pensez à ouvrir le port 4000 (ou à mettre Caddy/Nginx devant pour HTTPS).
TXT
