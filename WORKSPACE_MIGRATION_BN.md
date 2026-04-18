# 🔄 Lovable Workspace Migration Guide (Bangla)

**একই GitHub repo রেখে নতুন Lovable workspace এ project shift করার complete step-by-step**

> Repo: `nexus-x-panel`
> Goal: পুরাতন Lovable workspace এর credit শেষ → নতুন workspace এ shift করব, কিন্তু **same GitHub repo** এ push হবে যাতে VPS auto-deploy অপরিবর্তিত থাকে।

---

## ⚠️ আগে যা জানা দরকার

1. **VPS এ কোনো change লাগবে না।** আপনার `deploy.sh` শুধু `git pull origin main` করে — যতক্ষণ same repo তে push হচ্ছে, VPS auto-deploy কাজ করবে।
2. **Database, OTP history, agent accounts — সব VPS এ আছে**, Lovable এ না। তাই workspace shift করলে কোনো data হারাবে না।
3. **GitHub repo এর কোনো history হারাবে না** — সব commit, branch, code আগের মতই থাকবে।
4. Lovable এর built-in "import existing GitHub repo" feature **এখনো limited**। তাই আমরা একটা workaround ব্যবহার করব।

---

## ✅ Recommended পদ্ধতি: Lovable Support এর সাহায্যে Direct Link

এটাই সবচেয়ে নিরাপদ এবং সহজ পথ।

### Step 1 — নতুন Workspace এ Login
1. Browser এ নতুন tab খুলে [https://lovable.dev](https://lovable.dev) এ যান।
2. যে account এ credit আছে সেটায় login করুন।
3. উপরে workspace selector থেকে যেই workspace এ কাজ করতে চান সেটা select করুন।

### Step 2 — একটা Placeholder Project তৈরি করুন
1. Dashboard এ **+ New Project** click করুন।
2. **Blank** template select করুন (অথবা যেকোনো কিছু — এটা পরে replace হবে)।
3. Project name দিন: `nexus-x-panel-v2` (যেকোনো নাম, কিছু যায় আসে না)।
4. Project তৈরি হওয়া পর্যন্ত wait করুন।

### Step 3 — GitHub Connect করুন (Temporary Repo)
1. বাঁ পাশে **Connectors** menu → **GitHub** → **Connect project** click করুন।
2. GitHub এ authorize করুন → আপনার যেই account এ `nexus-x-panel` repo আছে সেটা select করুন।
3. Lovable জিজ্ঞেস করবে নতুন repo বানাতে — হ্যাঁ বলুন। নাম দিন: `nexus-temp` (এটা পরে delete হবে)।
4. Wait করুন যতক্ষণ Lovable ↔ GitHub sync complete হয়।

### Step 4 — Lovable Support এ Message পাঠান
চ্যাট icon (নিচের ডানদিকে) থেকে support কে message দিন:

> **Subject:** Re-link Lovable project to existing GitHub repo
>
> Hi team, my Lovable project ID `<project-id-এখানে>` is currently connected to GitHub repo `<your-username>/nexus-temp`. Could you please re-link it to my existing repo `<your-username>/nexus-x-panel` instead? My VPS auto-deploys from that repo and I need to keep the integration intact. Thanks!

Project ID টা Lovable URL থেকে copy করতে পারবেন (e.g. `https://lovable.dev/projects/<project-id>`)।

Support সাধারণত 6–24 ঘণ্টায় link করে দেয়।

### Step 5 — Verify
1. Support এর confirmation এর পর Lovable এ একটা ছোট change করুন (e.g. কোনো comment add)।
2. GitHub এর `nexus-x-panel` repo এ commit আসছে কিনা check করুন।
3. VPS এ log দেখুন: `pm2 logs nexus-backend --lines 20` — auto-deploy trigger হয়েছে কিনা।
4. ✅ সব ঠিক থাকলে `nexus-temp` repo টা GitHub থেকে delete করে দিন।

---

## 🛠️ Alternative পদ্ধতি: Manual Code Copy (যদি Support দেরি করে)

যদি urgent কাজ থাকে এবং support এর জন্য wait করতে না চান:

### Step A — পুরাতন workspace থেকে latest code নিশ্চিত করুন
1. পুরাতন workspace এ last change টা GitHub এ push হয়েছে কিনা confirm করুন।
2. VPS এ `git log -1` দিয়ে latest commit verify করুন।

### Step B — নতুন workspace এ blank project + GitHub connect
উপরের Step 1–3 এর মতই, কিন্তু Step 3 এ Lovable নতুন repo বানাবে (e.g. `nexus-temp`)।

### Step C — Local এ দুটো repo clone করে code merge
আপনার local computer এ:
```bash
git clone https://github.com/<your-username>/nexus-x-panel.git
git clone https://github.com/<your-username>/nexus-temp.git

# nexus-temp এর সব file delete করুন (.git ছাড়া)
cd nexus-temp
find . -mindepth 1 -maxdepth 1 ! -name '.git' -exec rm -rf {} +

# nexus-x-panel এর সব file copy করুন
cp -r ../nexus-x-panel/. .
rm -rf .git/  # পুরাতন .git remove
git init
git remote add origin https://github.com/<your-username>/nexus-temp.git
git add .
git commit -m "Migrated from nexus-x-panel"
git branch -M main
git push -u origin main --force
```

### Step D — VPS এ remote URL update
VPS এ SSH করে:
```bash
cd /opt/nexus/nexus-x-panel
git remote set-url origin https://github.com/<your-username>/nexus-temp.git
git pull origin main
```

এরপর থেকে নতুন workspace → `nexus-temp` → VPS auto-deploy কাজ করবে।

> ⚠️ এই পদ্ধতিতে commit history হারাবে। তাই **Recommended পদ্ধতিই preferred**।

---

## 🔐 যে জিনিসগুলো নতুন workspace এও setup করতে হবে

Lovable workspace এ যেগুলো **store থাকে না** (project এর সাথে যায় না):

| Item | কোথায় setup করবেন |
|------|-------------------|
| GitHub connection | Connectors → GitHub (একবারই) |
| Lovable Cloud (Supabase) | এই project এ Cloud use না হলে skip |
| Custom domain | Project Settings → Domains |
| Environment secrets | Lovable Cloud → Secrets (যদি use করে থাকেন) |

আপনার `nexus-x-panel` যেহেতু পুরো **VPS-hosted backend** (Lovable Cloud use করে না), শুধু GitHub connection এর কথাই চিন্তা করতে হবে।

---

## 📋 Checklist

- [ ] নতুন workspace এ login করেছি
- [ ] Placeholder project তৈরি করেছি
- [ ] GitHub Connector setup করেছি
- [ ] Lovable Support এ re-link request পাঠিয়েছি (অথবা manual migration করেছি)
- [ ] GitHub এ commit আসছে confirm করেছি
- [ ] VPS এ auto-deploy trigger হচ্ছে confirm করেছি
- [ ] পুরাতন workspace এর project archive/delete করেছি (optional)

---

## 🆘 Trouble হলে

| সমস্যা | সমাধান |
|--------|---------|
| Lovable change করছে কিন্তু GitHub এ push হচ্ছে না | Connectors → GitHub → Disconnect → Reconnect |
| GitHub এ push হচ্ছে কিন্তু VPS এ deploy হচ্ছে না | VPS এ webhook check: `pm2 logs nexus-webhook` |
| পুরাতন workspace এ এখনো access আছে কিন্তু credit নেই | পুরাতন workspace এ disconnect GitHub আগে, তারপর নতুন এ connect — দুই workspace একসাথে same repo এ push করলে conflict হবে |

---

**সাহায্য লাগলে এই file টা Lovable support কে দেখান — তারা ঠিক বুঝবে আপনি কী চাইছেন।**
