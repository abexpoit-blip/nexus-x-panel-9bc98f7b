#!/usr/bin/env bash
set -euo pipefail

API_DOMAIN="${API_DOMAIN:-api.nexus-x.site}"
BACKEND_URL="${BACKEND_URL:-http://127.0.0.1:4000}"
SITE_FILE="/etc/nginx/sites-available/${API_DOMAIN}"
ENABLED_FILE="/etc/nginx/sites-enabled/${API_DOMAIN}"
PM2_NAME="${PM2_NAME:-nexus-backend}"

G='\033[0;32m'; Y='\033[1;33m'; R='\033[0;31m'; B='\033[0;36m'; N='\033[0m'

echo -e "${B}Repairing API proxy for ${API_DOMAIN}${N}"

echo -e "\n${Y}1) Checking local backend...${N}"
if ! curl -fsS --max-time 5 "${BACKEND_URL}/api/health" >/tmp/nexus-api-health.json 2>/tmp/nexus-api-health.err; then
  echo -e "${Y}Local backend health failed; restarting ${PM2_NAME}...${N}"
  pm2 restart "${PM2_NAME}" --update-env
  sleep 2
  curl -fsS --max-time 8 "${BACKEND_URL}/api/health" >/tmp/nexus-api-health.json
fi
cat /tmp/nexus-api-health.json && echo ""

echo -e "\n${Y}2) Detecting SSL certificate...${N}"
CERT_DIR=""
for dir in "/etc/letsencrypt/live/${API_DOMAIN}" "/etc/letsencrypt/live/nexus-x.site"; do
  if [ -f "${dir}/fullchain.pem" ] && [ -f "${dir}/privkey.pem" ]; then
    CERT_DIR="${dir}"
    break
  fi
done

if [ -z "${CERT_DIR}" ]; then
  echo -e "${R}No Let's Encrypt certificate found for ${API_DOMAIN}.${N}"
  echo "Run: sudo certbot --nginx -d ${API_DOMAIN}"
  exit 1
fi
echo -e "${G}Using certificate: ${CERT_DIR}${N}"

echo -e "\n${Y}3) Writing clean Nginx API proxy config...${N}"
if [ -f "${SITE_FILE}" ]; then
  sudo cp "${SITE_FILE}" "${SITE_FILE}.bak.$(date +%Y%m%d%H%M%S)"
fi

sudo tee "${SITE_FILE}" >/dev/null <<EOF
server {
    listen 80;
    listen [::]:80;
    server_name ${API_DOMAIN};
    return 301 https://\$host\$request_uri;
}

server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name ${API_DOMAIN};

    ssl_certificate ${CERT_DIR}/fullchain.pem;
    ssl_certificate_key ${CERT_DIR}/privkey.pem;
    include /etc/letsencrypt/options-ssl-nginx.conf;
    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;

    client_max_body_size 1m;

    location / {
        proxy_pass ${BACKEND_URL};
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header Connection "";
        proxy_connect_timeout 5s;
        proxy_send_timeout 60s;
        proxy_read_timeout 60s;
    }
}
EOF

sudo ln -sf "${SITE_FILE}" "${ENABLED_FILE}"

echo -e "\n${Y}4) Reloading Nginx...${N}"
sudo nginx -t
sudo systemctl reload nginx

echo -e "\n${Y}5) Verifying public API...${N}"
curl -i --max-time 10 "https://${API_DOMAIN}/api/health"

echo -e "\n${G}Done. If health returns 200, hard-refresh the browser and log in again.${N}"