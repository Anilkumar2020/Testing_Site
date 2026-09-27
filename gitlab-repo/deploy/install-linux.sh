#!/usr/bin/env bash
# URL Tester — Linux installer (Ubuntu/Debian, RHEL/Rocky/Alma/Fedora, Amazon Linux)
# Usage:  sudo bash deploy/install-linux.sh            (installs to /opt/url-tester, runs as a systemd service on port 8080)
#         sudo PORT=9090 PSI_KEY=xxxx bash deploy/install-linux.sh
set -euo pipefail
APP_DIR=/opt/url-tester
PORT="${PORT:-8080}"
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
[ "$(id -u)" -eq 0 ] || { echo "Run with sudo"; exit 1; }

echo "==> Installing Node.js 20 (if missing)"
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 18 ]; then
  if command -v apt-get >/dev/null; then
    apt-get update -y && apt-get install -y curl ca-certificates
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
    apt-get install -y nodejs
  elif command -v dnf >/dev/null || command -v yum >/dev/null; then
    PM=$(command -v dnf || command -v yum)
    curl -fsSL https://rpm.nodesource.com/setup_20.x | bash -
    $PM install -y nodejs
  else
    echo "Unsupported distro: install Node.js 18+ manually"; exit 1
  fi
fi
node -v

echo "==> Copying app to $APP_DIR"
id urltester >/dev/null 2>&1 || useradd --system --create-home --home-dir /var/lib/urltester --shell /usr/sbin/nologin urltester
mkdir -p "$APP_DIR"
cp -r "$SRC_DIR/url-tester.html" "$SRC_DIR/server" "$APP_DIR/"
chown -R urltester:urltester "$APP_DIR"

echo "==> Installing dependencies + browser engines (this takes a few minutes)"
cd "$APP_DIR/server"
sudo -u urltester -H npm install --omit=dev
npx --yes playwright install-deps chromium firefox webkit || echo "WARN: could not install all browser system libraries"
sudo -u urltester -H npx --yes playwright install chromium firefox webkit

echo "==> Creating systemd service"
cat >/etc/systemd/system/url-tester.service <<EOF
[Unit]
Description=URL Tester
After=network-online.target
Wants=network-online.target

[Service]
User=urltester
WorkingDirectory=$APP_DIR/server
Environment=PORT=$PORT
Environment=PSI_KEY=${PSI_KEY:-}
Environment=HOME=/var/lib/urltester
ExecStart=$(command -v node) server.js
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now url-tester

echo "==> Opening firewall port $PORT (if a firewall is active)"
if command -v ufw >/dev/null && ufw status | grep -q active; then ufw allow "$PORT"/tcp; fi
if command -v firewall-cmd >/dev/null && systemctl is-active --quiet firewalld; then firewall-cmd --permanent --add-port="$PORT"/tcp && firewall-cmd --reload; fi

sleep 2
systemctl --no-pager status url-tester | head -n 8
IP=$(hostname -I 2>/dev/null | awk '{print $1}')
echo
echo "Done. Open:  http://localhost:$PORT   or   http://$IP:$PORT"
echo "Logs:        journalctl -u url-tester -f"
