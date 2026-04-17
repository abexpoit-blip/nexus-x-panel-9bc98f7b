#!/usr/bin/env bash
# ============================================================
# NexusX one-command deploy script
# Usage (on VPS):  bash /opt/nexus/nexus-x-panel/deploy.sh
# ============================================================
set -e

# Colors
G='\033[0;32m'; Y='\033[1;33m'; R='\033[0;31m'; B='\033[0;36m'; N='\033[0m'

PROJECT_DIR="/opt/nexus/nexus-x-panel"
BACKEND_DIR="$PROJECT_DIR/backend"
PM2_NAME="nexus-backend"

echo -e "${B}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${N}"
echo -e "${B}  NexusX Deploy — $(date '+%Y-%m-%d %H:%M:%S')${N}"
echo -e "${B}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${N}"

cd "$PROJECT_DIR"

# 1. Pull latest from GitHub (auto-stash any local edits — .env etc. stay safe)
echo -e "\n${Y}▶ Pulling latest code from GitHub…${N}"
BEFORE=$(git rev-parse --short HEAD)
# Stash any uncommitted local changes (preserves .env edits made on VPS)
if ! git diff --quiet || ! git diff --cached --quiet; then
  echo -e "${Y}  ⚠ Local changes detected — auto-stashing${N}"
  git stash push -u -m "auto-stash by deploy.sh $(date +%s)" || true
  STASHED=1
fi
git fetch origin
git reset --hard origin/main
AFTER=$(git rev-parse --short HEAD)
# Restore stash on top (your local .env edits survive)
if [ "${STASHED:-0}" = "1" ]; then
  git stash pop || echo -e "${Y}  ⚠ Stash pop had conflicts — check 'git stash list'${N}"
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

# 3. Frontend build (only if served by nginx from this VPS)
if [ -d "$PROJECT_DIR/dist" ] || [ -f "$PROJECT_DIR/vite.config.ts" ]; then
  echo -e "\n${Y}▶ Building frontend…${N}"
  cd "$PROJECT_DIR"
  npm install --no-audit --no-fund
  npm run build
  echo -e "${G}✓ Frontend built → $PROJECT_DIR/dist${N}"
fi

# 4. Status snapshot
echo -e "\n${B}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${N}"
echo -e "${G}✅ DEPLOY COMPLETE${N}"
echo -e "${B}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${N}"
pm2 list
echo ""
echo -e "${B}Latest commits:${N}"
cd "$PROJECT_DIR" && git log --oneline -3
echo ""
echo -e "${Y}Tail backend logs:${N}  pm2 logs $PM2_NAME --lines 30"
