# 🚀 NexusX — VPS Deployment Guide (বাংলা)

এই guide-টা সম্পূর্ণ beginner-friendly। আপনি copy-paste করে এক এক করে চালালেই server live হয়ে যাবে।

---

## 📋 কী লাগবে

- একটা VPS (Ubuntu 22.04 LTS recommended) — Hostinger / DigitalOcean / Contabo / যেকোনো
- একটা domain — যেমন `nexus-x.site` (DNS access থাকতে হবে)
- SSH access (root বা sudo user)
- AccHub এবং IMS-এর username/password

> পুরনো code আগে থেকেই server-এ আছে — আমরা সেটা **backup করে নতুন code দিয়ে replace** করব। DB file (data) সংরক্ষিত থাকবে।

---

## ১️⃣ Server-এ SSH login

আপনার local terminal থেকে:

```bash
ssh root@YOUR_SERVER_IP
```

---

## ২️⃣ পুরনো setup backup নিন (গুরুত্বপূর্ণ!)

```bash
# পুরনো backend folder backup
cd ~
mkdir -p backups
tar czf backups/nexus-backup-$(date +%F-%H%M).tar.gz /var/www/nexus 2>/dev/null || echo "old folder not found, skipping"

# DB file আলাদা করে backup
cp /var/www/nexus/backend/data/nexus.db backups/nexus.db.$(date +%F-%H%M).bak 2>/dev/null || true
```

আপনার পুরনো install path অন্য জায়গায় হলে `/var/www/nexus`-এর জায়গায় সেই path দিন।

---

## ৩️⃣ Required software install (already-installed হলে skip)

```bash
# Node.js 20 LTS
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# Build tools (better-sqlite3 compile-এর জন্য)
sudo apt-get install -y build-essential python3 git nginx

# pm2 (process manager)
sudo npm install -g pm2

# Chromium (IMS bot-এর জন্য)
sudo apt-get install -y chromium-browser

# certbot (SSL-এর জন্য)
sudo apt-get install -y certbot python3-certbot-nginx
```

Verify:
```bash
node -v       # v20.x.x
pm2 -v
chromium-browser --version
```

---

## ৪️⃣ নতুন code upload করুন

### Option A — Git দিয়ে (recommended)

Lovable project-এর GitHub repo connect থাকলে:

```bash
sudo mkdir -p /var/www/nexus
sudo chown -R $USER:$USER /var/www/nexus
cd /var/www/nexus

# পুরনো source folder থাকলে move করুন
[ -d backend ] && mv backend backend.old.$(date +%s)
[ -d src ] && mv src src.old.$(date +%s)

git clone https://github.com/YOUR_USERNAME/YOUR_REPO.git .
```

### Option B — SCP দিয়ে (Git না থাকলে)

আপনার local machine থেকে:

```bash
# project root থেকে
scp -r ./backend root@YOUR_SERVER_IP:/var/www/nexus/
scp -r ./src ./public ./index.html ./package.json ./vite.config.ts \
       ./tsconfig*.json ./tailwind.config.ts ./postcss.config.js \
       root@YOUR_SERVER_IP:/var/www/nexus/
```

---

## ৫️⃣ Backend setup

```bash
cd /var/www/nexus/backend

# Dependencies install
npm install --production=false

# .env file তৈরি করুন
cp .env.example .env
nano .env
```

`.env`-তে এই values ঠিক করুন:

```env
PORT=4000
NODE_ENV=production

# JWT_SECRET generate করুন এই command দিয়ে — copy করে নিচে paste করুন:
#   node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"
JWT_SECRET=এখানে_উপরের_command_থেকে_যা_এসেছে_paste_করুন

DB_PATH=./data/nexus.db

# আপনার domain — frontend যেটা থেকে আসবে
CORS_ORIGIN=https://nexus-x.site,https://www.nexus-x.site

# Default admin (প্রথমবার DB তৈরি হলে এই credentials দিয়ে login হবে)
ADMIN_USERNAME=admin
ADMIN_PASSWORD=খুব_শক্ত_একটা_password_দিন

# AccHub
ACCHUB_BASE_URL=https://sms.acchub.io
ACCHUB_USERNAME=ShovonYE
ACCHUB_PASSWORD=আপনার_acchub_password

# IMS
IMS_ENABLED=true
IMS_BASE_URL=https://www.imssms.org
IMS_USERNAME=Shovonkhan7
IMS_PASSWORD=আপনার_ims_password
IMS_CHROME_PATH=/usr/bin/chromium-browser
IMS_SCRAPE_INTERVAL=8
IMS_HEADLESS=true

OTP_POLL_INTERVAL=5
RATE_LIMIT_WINDOW_MS=60000
RATE_LIMIT_MAX=120
```

`Ctrl+O`, `Enter`, `Ctrl+X` দিয়ে save করুন।

### পুরনো DB restore (যদি থাকে)

```bash
mkdir -p data
# পুরনো DB থাকলে copy করুন
cp ~/backups/nexus.db.*.bak data/nexus.db 2>/dev/null || echo "fresh DB হবে"
```

### Backend test run

```bash
npm start
```

Output-এ `🚀 NexusX backend listening on http://localhost:4000` দেখলে `Ctrl+C` দিয়ে stop করুন।

### pm2 দিয়ে background-এ চালান

```bash
pm2 start server.js --name nexus-api
pm2 save
pm2 startup     # কমান্ডটা যা দেয় সেটা copy-paste করে চালান
```

Check:
```bash
pm2 status
pm2 logs nexus-api --lines 50
```

---

## ৬️⃣ Frontend build

```bash
cd /var/www/nexus

# .env.production তৈরি করুন
cat > .env.production <<EOF
VITE_API_URL=https://api.nexus-x.site/api
EOF

npm install
npm run build
```

`dist/` folder তৈরি হবে।

---

## ৭️⃣ Nginx configure করুন

### Frontend (main domain)

```bash
sudo nano /etc/nginx/sites-available/nexus-x.site
```

Paste:

```nginx
server {
    listen 80;
    server_name nexus-x.site www.nexus-x.site;

    root /var/www/nexus/dist;
    index index.html;

    # SPA routing
    location / {
        try_files $uri $uri/ /index.html;
    }

    # Static assets cache
    location ~* \.(js|css|png|jpg|jpeg|gif|ico|svg|woff|woff2)$ {
        expires 30d;
        add_header Cache-Control "public, immutable";
    }
}
```

### Backend API (subdomain)

```bash
sudo nano /etc/nginx/sites-available/api.nexus-x.site
```

Paste:

```nginx
server {
    listen 80;
    server_name api.nexus-x.site;

    client_max_body_size 1m;

    location / {
        proxy_pass http://127.0.0.1:4000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}
```

### Enable + reload

```bash
sudo ln -sf /etc/nginx/sites-available/nexus-x.site /etc/nginx/sites-enabled/
sudo ln -sf /etc/nginx/sites-available/api.nexus-x.site /etc/nginx/sites-enabled/
sudo nginx -t      # syntax check
sudo systemctl reload nginx
```

---

## ৮️⃣ DNS সেট করুন

আপনার domain registrar / Cloudflare-এ:

| Type | Name | Value           |
|------|------|-----------------|
| A    | @    | YOUR_SERVER_IP  |
| A    | www  | YOUR_SERVER_IP  |
| A    | api  | YOUR_SERVER_IP  |

DNS propagate হতে ৫–৩০ মিনিট লাগতে পারে। Check:
```bash
dig +short nexus-x.site
dig +short api.nexus-x.site
```

---

## ৯️⃣ SSL (HTTPS) install করুন

```bash
sudo certbot --nginx -d nexus-x.site -d www.nexus-x.site -d api.nexus-x.site
```

Email দিন, terms accept করুন, "Redirect HTTP to HTTPS" → **2 (yes)**।

Auto-renewal test:
```bash
sudo certbot renew --dry-run
```

---

## ১️⃣০️⃣ Firewall

```bash
sudo ufw allow OpenSSH
sudo ufw allow 'Nginx Full'
sudo ufw enable
```

---

## ✅ Final test

Browser-এ যান:
- `https://nexus-x.site` → frontend দেখা যাবে
- `https://api.nexus-x.site/api/health` → `{"ok":true,"ts":...}` দেখা যাবে

Login করুন `.env`-এর `ADMIN_USERNAME`/`ADMIN_PASSWORD` দিয়ে → `/sys/control-panel`

---

## 🔄 ভবিষ্যতে update করতে হলে

```bash
cd /var/www/nexus
git pull                         # নতুন code নামান

# Backend update
cd backend
npm install
pm2 restart nexus-api

# Frontend rebuild
cd ..
npm install
npm run build
# nginx already serves dist/, কিছু করতে হবে না
```

---

## 🆘 Troubleshooting

| সমস্যা | Solution |
|--------|----------|
| `pm2 logs` এ "JWT_SECRET must be set..." | `.env`-এ JWT_SECRET ৩২+ char-এর random string দিন |
| API call CORS error | `.env`-এর `CORS_ORIGIN`-এ exact frontend URL (https সহ) দিন, pm2 restart করুন |
| IMS bot login fail | `IMS_HEADLESS=false` করে local-এ test করুন; `chromium-browser --version` check করুন |
| Login হয় কিন্তু পরে logout | `https://` ছাড়া cookie set হবে না — SSL ঠিকমতো install হয়েছে কিনা check করুন |
| 502 Bad Gateway | `pm2 status` দেখুন backend running কিনা; `pm2 logs nexus-api` |

---

## 🔐 Security checklist

- [x] `JWT_SECRET` 64+ char random
- [x] `ADMIN_PASSWORD` শক্ত (12+ char, mixed)
- [x] HTTPS active (httpOnly cookie শুধু HTTPS-এ যায়)
- [x] `CORS_ORIGIN` explicit (no wildcard)
- [x] UFW firewall active
- [x] পুরনো DB backup আছে

Done! 🎉
