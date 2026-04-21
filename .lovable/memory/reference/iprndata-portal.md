---
name: IPRNData portal
description: Login + scrape endpoints for iprndata.com (iprnBot — HTTP-only, no puppeteer)
type: reference
---
# IPRNData (iprndata.com)

URL: https://iprndata.com
Username: MAMUN25
Password: mamun@11aa
Stack: Yii2 PHP framework (CSRF-protected forms)

## Auth flow (HTTP-only — no captcha, no JS)
1. GET  /user-management/auth/login    → cookies (PHPSESSID, _csrf-frontend) + CSRF token in <meta name="csrf-token"> and <input name="_csrf-frontend">
2. POST /user-management/auth/login    → form-encoded: _csrf-frontend, LoginForm[username], LoginForm[password], LoginForm[rememberMe]=0, login-button=
   Headers: X-CSRF-Token, Origin, Referer
   Returns 302 → /dashboard
3. GET  /dashboard                     → 200 with username string + "MARGIN TREND" markers = logged in

## Key URLs (scraped)
- /billing-groups/index   → number pool table (Range | Number | Country ...)
- /sms-records/index      → recent SMS feed (Date | Phone | CLI | Body | ...) — OTP source

## Bot architecture (iprnBot)
- HTTP-only with axios + manual cookie jar (no puppeteer needed → ~10MB RAM vs 500MB)
- Auto re-login on /login redirect (session expiry)
- Pool sync every 600s, OTP poll every 4s (configurable via IPRN_NUMBERS_INTERVAL / IPRN_SCRAPE_INTERVAL)
- Mirrors msi/ims provider pattern: provider='iprn', mode='manual', table iprn_range_meta
- Same allocation flow as MSI: scrape → upsert pool → admin assigns → OTP arrives → markOtpReceived

## Differences from IMS/MSI
- No browser → no Chromium dependency, no captcha solving
- 5x lighter resources (axios session vs full Chrome)
- Faster polling possible (min 2s vs 3s/15s for MSI/IMS)
