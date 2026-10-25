# Running the SAMAAN API on a cloud VM

Replaces the laptop + cloudflared quick tunnel (random address, dropped at any time). The VM gives
one permanent HTTPS address, so the iPhone app is built once and keeps working.

## 1. Create the VM (you, in the provider's console)
- Ubuntu 24.04 LTS, x86_64, **2 GB RAM**, 1 vCPU, 25 GB disk (any of: DigitalOcean droplet,
  AWS Lightsail, Google Cloud e2-small, Oracle Cloud free tier).
- Add this laptop's SSH public key (`cat ~/.ssh/id_ed25519.pub`) when creating it.
- Allow inbound TCP 22, 80, 443 in the provider's firewall (Lightsail / Oracle / GCP need this; the
  script also enables `ufw` on the VM).
- Note the public IP and the login user (`root` on DigitalOcean, `ubuntu` on Lightsail/GCP/Oracle).

## 2. Deploy (from this laptop)
```bash
export NVIDIA_API_KEY=<key>          # Listen's conversation model; written to /etc/samaan.env on the VM
export SAMAAN_ADMIN_TOKEN=$(openssl rand -hex 16)   # protects the authority console; keep it, staff type it once
make deploy HOST=root@<ip> SEED=1    # first time: copies the database, graph and photos
```
The API is then live at `https://<ip with dashes>.sslip.io` (free DNS name with a real Let's
Encrypt certificate) or at your own name with `DOMAIN=api.example.com` (point its A record at the
IP first).

Later code updates: `make deploy HOST=root@<ip>` (never overwrites the VM's data).

## 3. Point the app at it (once)
```bash
make ios-sync API_URL=https://<ip with dashes>.sslip.io
cd web/ios/App && LANG=en_US.UTF-8 pod install && xcodebuild -workspace App.xcworkspace -scheme App ...
```
then install on the phone (docs/IOS_APP.md).

## Authority console
`https://<host>/admin`: report triage, barriers, work orders, workers (docs/ADMIN.md). The deploy
builds and uploads it; staff enter `SAMAAN_ADMIN_TOKEN` once per browser.

## What runs on the VM
- `/opt/samaan`: the code and `data/` (SQLite database, footpath graph, photos). After the first
  seed the VM is the source of truth; uploads and reports from phones land there.
- `samaan-api.service`: uvicorn on 127.0.0.1:8000, restarts on crash and on reboot.
- Caddy: HTTPS on 443, automatic certificates, 20 MB upload limit, proxies to the API.
- Slim install (`deploy/requirements-api.txt`): no PyTorch/Ultralytics; the API never imports
  them. 125 non-ML tests pass in that environment. Detector runs (`make infer-zero-shot`) stay
  on the laptop.

## Operations
```bash
ssh root@<ip> 'systemctl status samaan-api --no-pager; journalctl -u samaan-api -n 50 --no-pager'
ssh root@<ip> 'journalctl -u caddy -n 50 --no-pager'        # certificate problems
scp root@<ip>:/opt/samaan/data/processed/samaan.sqlite ./backup-$(date +%F).sqlite   # backup
```
