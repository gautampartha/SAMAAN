#!/usr/bin/env bash
# Runs ON the VM (Ubuntu 22.04/24.04) as root, from /opt/samaan. Idempotent: safe to re-run.
#   DOMAIN=<host name for HTTPS> bash deploy/setup_server.sh
# Installs uv + Python 3.11 venv, the API requirements, a systemd service (uvicorn on 127.0.0.1:8000),
# Caddy with automatic HTTPS in front, and a firewall allowing only 22/80/443.
set -euo pipefail
: "${DOMAIN:?set DOMAIN}"
APP=/opt/samaan
export DEBIAN_FRONTEND=noninteractive

apt-get update -y
apt-get install -y curl ca-certificates gnupg debian-keyring debian-archive-keyring apt-transport-https ufw sqlite3 rsync

# Caddy (official repository)
if ! command -v caddy >/dev/null; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -y && apt-get install -y caddy
fi

# Service user + uv + Python 3.11 venv
id samaan >/dev/null 2>&1 || useradd --system --home "$APP" --shell /usr/sbin/nologin samaan
if ! [ -x /usr/local/bin/uv ]; then
  curl -LsSf https://astral.sh/uv/install.sh | env UV_INSTALL_DIR=/usr/local/bin INSTALLER_NO_MODIFY_PATH=1 sh
fi
export UV_PYTHON_INSTALL_DIR=/opt/uv-python
[ -x "$APP/.venv/bin/python" ] || /usr/local/bin/uv venv --python 3.11 "$APP/.venv"
/usr/local/bin/uv pip install --python "$APP/.venv/bin/python" -r "$APP/deploy/requirements-api.txt"
mkdir -p "$APP/data/processed" "$APP/data/raw/own" "$APP/data/raw/reports" "$APP/data/raw/mapillary"
chown -R samaan:samaan "$APP/data"

# Secrets live here only (written by deploy.sh from the laptop's environment)
touch /etc/samaan.env && chmod 600 /etc/samaan.env && chown root:root /etc/samaan.env

cat > /etc/systemd/system/samaan-api.service <<UNIT
[Unit]
Description=SAMAAN API
After=network-online.target
Wants=network-online.target

[Service]
User=samaan
Group=samaan
WorkingDirectory=$APP
EnvironmentFile=/etc/samaan.env
Environment=PYTHONUNBUFFERED=1
ExecStart=$APP/.venv/bin/uvicorn api.main:app --host 127.0.0.1 --port 8000 --proxy-headers --forwarded-allow-ips=127.0.0.1
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target
UNIT

cat > /etc/caddy/Caddyfile <<CADDY
$DOMAIN {
	encode gzip
	request_body {
		max_size 20MB
	}
	reverse_proxy 127.0.0.1:8000
}
CADDY

ufw allow 22/tcp >/dev/null; ufw allow 80/tcp >/dev/null; ufw allow 443/tcp >/dev/null
ufw --force enable >/dev/null

systemctl daemon-reload
systemctl enable --now samaan-api
systemctl restart samaan-api
systemctl enable --now caddy
systemctl reload caddy || systemctl restart caddy
sleep 3
curl -fsS http://127.0.0.1:8000/health && echo && echo "API up; HTTPS at https://$DOMAIN (certificate is issued on first request)"
