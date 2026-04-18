#!/usr/bin/env bash
# ============================================================
# NexusX one-command deploy script (bulletproof)
# Usage (on VPS):  bash /opt/nexus/nexus-x-panel/deploy.sh
# ============================================================
set -e

G='\033[0;32m'; Y='\033[1;33m'; R='\033[0;31m'; B='\033[0;36m'; N='\033[0m'

PROJECT_DIR="/opt/nexus/nexus-x-panel"
BACKEND_DIR="$PROJECT_DIR/backend"
PM2_NAME="nexus-backend"

# === EDIT THIS if your nginx serves from a different folder ===
# Auto-detected from your nginx config: /var/www/nexus-x.site
NGINX_WEBROOT="${NGINX_WEBROOT:-/var/www/nexus-x.site}"

echo -e "${B}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${N}"
echo -e "${B}  NexusX Deploy — $(date '+%Y-%m-%d %H:%M:%S')${N}"
echo -e "${B}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${N}"

cd "$PROJECT_DIR"

# 1. Pull latest from GitHub
echo -e "\n${Y}▶ Pulling latest code from GitHub…${N}"
BEFORE=$(git rev-parse --short HEAD)
if ! git diff --quiet || ! git diff --cached --quiet; then
  echo -e "${Y}  ⚠ Local changes detected — auto-stashing${N}"
  git stash push -u -m "auto-stash by deploy.sh $(date +%s)" || true
  STASHED=1
fi
git fetch origin
git reset --hard origin/main
AFTER=$(git rev-parse --short HEAD)
if [ "${STASHED:-0}" = "1" ]; then
  git stash pop || echo -e "${Y}  ⚠ Stash pop conflict — check 'git stash list'${N}"
fi
if [ "$BEFORE" = "$AFTER" ]; then
  echo -e "${G}✓ Already up to date ($AFTER)${N}"
else
  echo -e "${G}✓ Updated $BEFORE → $AFTER${N}"
fi

# 2. Backend deps + restart
echo -e "\n${Y}▶ Installing backend dependencies…${N}"
cd "$BACKEND_DIR"
npm install --omit=dev --no-audit --no-fund
echo -e "${G}✓ Backend deps installed${N}"

echo -e "\n${Y}▶ Restarting backend (pm2: $PM2_NAME)…${N}"
if pm2 list | grep -q "$PM2_NAME"; then
  pm2 restart "$PM2_NAME" --update-env
else
  pm2 start server.js --name "$PM2_NAME"
fi
pm2 save > /dev/null
echo -e "${G}✓ Backend restarted${N}"

# 3. Frontend build (FORCE clean build — no stale cache)
echo -e "\n${Y}▶ Building frontend (clean)…${N}"
cd "$PROJECT_DIR"
rm -rf dist node_modules/.vite
npm install --no-audit --no-fund
npm run build
if [ ! -f "$PROJECT_DIR/dist/index.html" ]; then
  echo -e "${R}✗ Build failed — dist/index.html not found${N}"
  exit 1
fi
BUILD_HASH=$(grep -oE 'assets/index-[A-Za-z0-9]+\.js' "$PROJECT_DIR/dist/index.html" | head -1)
echo -e "${G}✓ Frontend built → $BUILD_HASH${N}"

# 4. Sync to nginx webroot
if [ -d "$NGINX_WEBROOT" ]; then
  echo -e "\n${Y}▶ Syncing dist/ → $NGINX_WEBROOT …${N}"
  rsync -a --delete "$PROJECT_DIR/dist/" "$NGINX_WEBROOT/"
  echo -e "${G}✓ Webroot updated${N}"
else
  echo -e "${Y}  ⚠ $NGINX_WEBROOT does not exist — skipping rsync${N}"
  echo -e "${Y}     Set: export NGINX_WEBROOT=/your/path  before running${N}"
fi

# 5. Reload nginx (so it picks up new files)
if command -v nginx >/dev/null 2>&1; then
  echo -e "\n${Y}▶ Reloading nginx…${N}"
  sudo nginx -t && sudo systemctl reload nginx
  echo -e "${G}✓ nginx reloaded${N}"
fi

# 6. Status snapshot
echo -e "\n${B}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${N}"
echo -e "${G}✅ DEPLOY COMPLETE${N}"
echo -e "${B}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${N}"
pm2 list
echo ""
echo -e "${B}Live build hash:${N} $BUILD_HASH"
echo -e "${B}Latest commits:${N}"
cd "$PROJECT_DIR" && git log --oneline -3
echo ""
echo -e "${Y}If browser still shows old UI:${N} Ctrl+Shift+R (hard refresh) or open Incognito"
echo -e "${Y}Tail backend logs:${N} pm2 logs $PM2_NAME --lines 30"
