#!/usr/bin/env bash
# ============================================================
# NexusX AUTO-DEPLOY one-command installer
# Run ONCE on VPS:  bash /opt/nexus/nexus-x-panel/setup-auto-deploy.sh
#
# What this does:
#   1. Installs a tiny webhook listener (port 9000) as a pm2 service
#   2. Listens for GitHub push events on main branch
#   3. Auto-runs deploy.sh whenever you push to GitHub
#   4. Configures nginx to expose /github-webhook publicly over HTTPS
#
# After install: any `git push` to main → VPS auto-deploys in ~30s.
# ============================================================
set -e

G='\033[0;32m'; Y='\033[1;33m'; R='\033[0;31m'; B='\033[0;36m'; N='\033[0m'

PROJECT_DIR="/opt/nexus/nexus-x-panel"
WEBHOOK_PORT=9000
WEBHOOK_SECRET="${WEBHOOK_SECRET:-$(openssl rand -hex 24)}"
DOMAIN="${DOMAIN:-nexus-x.site}"
NGINX_SITE="/etc/nginx/sites-available/${DOMAIN}"

echo -e "${B}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${N}"
echo -e "${B}  NexusX Auto-Deploy Setup${N}"
echo -e "${B}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${N}"

# ------------------------------------------------------------
# 1. Save webhook secret (so deploy.sh + GitHub agree on it)
# ------------------------------------------------------------
echo -e "\n${Y}▶ Generating webhook secret…${N}"
echo "$WEBHOOK_SECRET" > "$PROJECT_DIR/.webhook-secret"
chmod 600 "$PROJECT_DIR/.webhook-secret"
echo -e "${G}✓ Secret saved to $PROJECT_DIR/.webhook-secret${N}"

# ------------------------------------------------------------
# 2. Write the webhook listener script
# ------------------------------------------------------------
echo -e "\n${Y}▶ Writing webhook listener…${N}"
# Use .cjs because root package.json has "type": "module"
rm -f "$PROJECT_DIR/webhook-server.js"   # remove old broken .js if exists
cat > "$PROJECT_DIR/webhook-server.cjs" <<'WEBHOOK_EOF'
// Tiny GitHub webhook listener — verifies HMAC, then runs deploy.sh
const http = require('http');
const crypto = require('crypto');
const { exec } = require('child_process');
const fs = require('fs');

const PORT = +(process.env.WEBHOOK_PORT || 9000);
const SECRET = fs.readFileSync('/opt/nexus/nexus-x-panel/.webhook-secret', 'utf8').trim();
const DEPLOY_CMD = 'bash /opt/nexus/nexus-x-panel/deploy.sh';

let deploying = false;

function verifySignature(payload, signature) {
  if (!signature) return false;
  const hmac = crypto.createHmac('sha256', SECRET);
  hmac.update(payload);
  const expected = 'sha256=' + hmac.digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch { return false; }
}

http.createServer((req, res) => {
  if (req.method !== 'POST' || req.url !== '/github-webhook') {
    res.writeHead(404); return res.end('not found');
  }
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const sig = req.headers['x-hub-signature-256'];
    if (!verifySignature(body, sig)) {
      console.warn('[webhook] invalid signature from', req.socket.remoteAddress);
      res.writeHead(401); return res.end('invalid signature');
    }
    const event = req.headers['x-github-event'];
    if (event === 'ping') {
      res.writeHead(200); return res.end('pong');
    }
    if (event !== 'push') {
      res.writeHead(200); return res.end('ignored: ' + event);
    }
    let payload;
    try { payload = JSON.parse(body); } catch { res.writeHead(400); return res.end('bad json'); }
    const ref = payload.ref || '';
    if (!/refs\/heads\/(main|master)$/.test(ref)) {
      res.writeHead(200); return res.end('ignored branch: ' + ref);
    }
    if (deploying) {
      res.writeHead(202); return res.end('already deploying — will pick up latest');
    }
    deploying = true;
    res.writeHead(202); res.end('deploy triggered');
    console.log(`[webhook] ${new Date().toISOString()} → deploying ${payload.head_commit?.id?.slice(0,7) || ''}`);
    exec(DEPLOY_CMD, { maxBuffer: 50 * 1024 * 1024 }, (err, stdout, stderr) => {
      deploying = false;
      if (err) { console.error('[webhook] deploy FAILED:', err.message); console.error(stderr); }
      else { console.log('[webhook] deploy OK'); console.log(stdout.split('\n').slice(-15).join('\n')); }
    });
  });
}).listen(PORT, '127.0.0.1', () => {
  console.log(`✓ Webhook listener on http://127.0.0.1:${PORT}/github-webhook`);
});
WEBHOOK_EOF
echo -e "${G}✓ webhook-server.js created${N}"

# ------------------------------------------------------------
# 3. Start under pm2
# ------------------------------------------------------------
echo -e "\n${Y}▶ Starting webhook under pm2…${N}"
# Always recreate so pm2 picks up the .cjs file (not the old broken .js)
pm2 delete nexus-webhook >/dev/null 2>&1 || true
cd "$PROJECT_DIR"
WEBHOOK_PORT=$WEBHOOK_PORT pm2 start webhook-server.cjs --name nexus-webhook
pm2 save > /dev/null
echo -e "${G}✓ nexus-webhook running on 127.0.0.1:$WEBHOOK_PORT${N}"

# ------------------------------------------------------------
# 4. Add nginx location block (idempotent)
# ------------------------------------------------------------
if [ -f "$NGINX_SITE" ] && ! grep -q "github-webhook" "$NGINX_SITE"; then
  echo -e "\n${Y}▶ Adding /github-webhook to nginx ($NGINX_SITE)…${N}"
  # Insert just before the LAST closing brace of the HTTPS server block
  sudo cp "$NGINX_SITE" "$NGINX_SITE.bak.$(date +%s)"
  sudo sed -i '0,/^}$/!{ /^}$/i\
    location /github-webhook {\
        proxy_pass http://127.0.0.1:'"$WEBHOOK_PORT"'/github-webhook;\
        proxy_set_header Host $host;\
        proxy_set_header X-Real-IP $remote_addr;\
        client_max_body_size 5m;\
    }
}' "$NGINX_SITE" || true
  sudo nginx -t && sudo systemctl reload nginx
  echo -e "${G}✓ nginx reloaded${N}"
else
  echo -e "${Y}  ⚠ nginx block already has /github-webhook (or site not found)${N}"
fi

# ------------------------------------------------------------
# 5. Done — print GitHub setup instructions
# ------------------------------------------------------------
echo ""
echo -e "${B}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${N}"
echo -e "${G}✅ AUTO-DEPLOY READY${N}"
echo -e "${B}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${N}"
echo ""
echo -e "${Y}▶ এখন GitHub এ এই webhook যোগ করুন:${N}"
echo ""
echo -e "  1. GitHub repo → ${B}Settings → Webhooks → Add webhook${N}"
echo -e "  2. ${B}Payload URL:${N}    https://${DOMAIN}/github-webhook"
echo -e "  3. ${B}Content type:${N}   application/json"
echo -e "  4. ${B}Secret:${N}         ${G}${WEBHOOK_SECRET}${N}"
echo -e "  5. ${B}Events:${N}         Just the push event"
echo -e "  6. ${B}Active:${N}         ✓ checked"
echo -e "  7. Click ${B}Add webhook${N}"
echo ""
echo -e "${Y}▶ Test:${N}"
echo -e "  • GitHub এ যেকোনো commit push করুন"
echo -e "  • VPS log দেখুন: ${B}pm2 logs nexus-webhook --lines 30${N}"
echo -e "  • Deploy log: ${B}pm2 logs nexus-backend --lines 30${N}"
echo ""
echo -e "${Y}▶ Manual deploy (whenever you want):${N}"
echo -e "  ${B}bash $PROJECT_DIR/deploy.sh${N}"
echo ""
echo -e "${R}⚠ এই secret টা সংরক্ষণ করুন — হারালে এই script আবার চালান:${N}"
echo -e "  cat $PROJECT_DIR/.webhook-secret"
echo ""
