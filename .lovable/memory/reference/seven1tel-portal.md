---
name: Seven1Tel Portal
description: Login + scrape config for seven1tel /ints panel (94.23.120.156) — same software as MSI bot
type: reference
---
URL: http://94.23.120.156/ints/login
Username: Sayedahmed
Password: Rumon1275
Captcha: math (e.g. "What is 6+10=?") — same as MSI, NOT reCAPTCHA (commented out in HTML)
After login: redirects to /ints/agent/SMSDashboard
Agent pages: /ints/agent/MySMSNumbers, /ints/agent/SMSCDRReports
Bot file: backend/workers/seven1telBot.js (clone of msiBot.js)
Provider id: 'seven1tel', Server label: 'Server G'
Settings keys: seven1tel_enabled, seven1tel_username, seven1tel_password, seven1tel_base_url, seven1tel_cookies, seven1tel_otp_interval
Admin UI: /admin/seven1tel-status
