#!/usr/bin/env bash
# Deploy the SAMAAN API to a cloud VM from this laptop.
#   deploy/deploy.sh <user@ip> [--seed-data] [--domain host.example.com]
# First run: pass --seed-data to copy the database, graph and photos (afterwards the VM is the
# source of truth and code-only deploys never overwrite its data). Without --domain the free
# <ip>.sslip.io name is used, which gets a real HTTPS certificate from Let's Encrypt.
# Secrets: NVIDIA_API_KEY from this shell's environment is written to /etc/samaan.env on the VM.
set -euo pipefail
cd "$(dirname "$0")/.."
TARGET="${1:?usage: deploy/deploy.sh <user@ip> [--seed-data] [--domain name]}"; shift
SEED=0; DOMAIN=""
while [ $# -gt 0 ]; do
  case "$1" in
    --seed-data) SEED=1 ;;
    --domain) DOMAIN="$2"; shift ;;
    *) echo "unknown option $1"; exit 2 ;;
  esac
  shift
done
IP="${TARGET#*@}"
[ -n "$DOMAIN" ] || DOMAIN="$(echo "$IP" | tr '.' '-').sslip.io"
SSH="ssh -o StrictHostKeyChecking=accept-new $TARGET"
SUDO=""; [ "${TARGET%@*}" = "root" ] || SUDO="sudo"

echo "==> code -> $TARGET:/opt/samaan"
$SSH "$SUDO mkdir -p /opt/samaan && $SUDO chown \$(id -un) /opt/samaan"
rsync -az --delete \
  --exclude '.git/' --exclude '.venv/' --exclude 'web/' --exclude 'Photos/' --exclude 'data/' \
  --exclude '__pycache__/' --exclude '*.pt' --exclude 'ml/runs/' --exclude 'samaan.egg-info/' \
  ./ "$TARGET:/opt/samaan/"

echo "==> authority console (web/dist-admin)"
( cd web && npx vite build --config vite.admin.config.ts >/dev/null )
$SSH "mkdir -p /opt/samaan/web"
rsync -az --delete web/dist-admin/ "$TARGET:/opt/samaan/web/dist-admin/"

if [ "$SEED" = 1 ]; then
  echo "==> data snapshot (database via sqlite backup, graph, photos)"
  TMP=$(mktemp -d)
  python3 -c "import sqlite3,sys; s=sqlite3.connect(sys.argv[1]); d=sqlite3.connect(sys.argv[2]); s.backup(d); d.close(); s.close()" data/processed/samaan.sqlite "$TMP/samaan.sqlite"
  $SSH "mkdir -p /opt/samaan/data/processed /opt/samaan/data/raw"
  rsync -az "$TMP/samaan.sqlite" "$TARGET:/opt/samaan/data/processed/samaan.sqlite"
  rsync -az --exclude '*.sqlite' --exclude 'smoke_results/' data/processed/ "$TARGET:/opt/samaan/data/processed/"
  rsync -az data/raw/own data/raw/mapillary "$TARGET:/opt/samaan/data/raw/"
  [ -d data/raw/reports ] && rsync -az data/raw/reports "$TARGET:/opt/samaan/data/raw/"
  rm -rf "$TMP"
fi

echo "==> server setup ($DOMAIN)"
$SSH "cd /opt/samaan && $SUDO env DOMAIN='$DOMAIN' bash deploy/setup_server.sh"

if [ -n "${NVIDIA_API_KEY:-}${SAMAAN_ADMIN_TOKEN:-}" ]; then
  echo "==> secrets"
  { [ -n "${NVIDIA_API_KEY:-}" ] && printf 'NVIDIA_API_KEY=%s\n' "$NVIDIA_API_KEY"
    [ -n "${SAMAAN_ADMIN_TOKEN:-}" ] && printf 'SAMAAN_ADMIN_TOKEN=%s\n' "$SAMAAN_ADMIN_TOKEN"; true; } \
    | $SSH "$SUDO tee /etc/samaan.env >/dev/null && $SUDO chmod 600 /etc/samaan.env && $SUDO systemctl restart samaan-api"
fi
[ -n "${NVIDIA_API_KEY:-}" ] || echo "(NVIDIA_API_KEY not set here: Listen uses on-device rules until it is added to /etc/samaan.env)"
[ -n "${SAMAAN_ADMIN_TOKEN:-}" ] || echo "WARNING: SAMAAN_ADMIN_TOKEN not set: the authority console at /admin is open to anyone with the URL"

echo "==> check https://$DOMAIN/health"
for i in 1 2 3 4 5 6; do
  if curl -fsS -m 15 "https://$DOMAIN/health"; then echo; echo "LIVE: https://$DOMAIN"; exit 0; fi
  sleep 5
done
echo "HTTPS not answering yet (certificate may still be issuing); check: $SSH 'journalctl -u caddy -n 50'"
exit 1
