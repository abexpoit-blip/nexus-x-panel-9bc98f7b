---
name: NumPanel Portal
description: Login + API + scrape flow for NumberPanel (51.89.99.105) — numpanelBot architecture
type: reference
---
# NumPanel (51.89.99.105/NumberPanel/agent)

Credentials: ahmed1258 / Ahmed@123ff
Login: math captcha (e.g. "What is 5+0=?") — solved by shared `solveCaptchaText()`.

## Pages
- `/NumberPanel/agent/login` — login form (user/pass/captcha)
- `/NumberPanel/agent/SelfAllocation` — range list with REQUEST button → click to claim 1 number per click
- `/NumberPanel/agent/API` — exposes per-agent API token + CDR endpoint
- `/NumberPanel/agent/SMSCDRStats` — CDR (15s rate-limit, NOT used — we use API instead)

## CDR API (no rate-limit, no captcha)
GET `http://147.135.212.197/crapi/st/viewstats?token={TOKEN}&records=N`
Token (ahmed1258): `R1RVQ0FBUzRKjIt9WmVTa3Jrl4ZWamNbZlSQaVmOkVRTd3hyf22Thw==`
Returns `{status:"ok", records:[...]}` or `{status:"error", msg:"No Records Found"}`.

## Bot architecture (`backend/workers/numpanelBot.js`)
- Puppeteer used ONLY for: login (cookie persistence) + Self Allocation REQUEST clicks.
- OTP polling = pure HTTP fetch on CDR API → fast (every 3-5s).
- Pool fill: visits SelfAllocation, clicks REQUEST `NUMPANEL_REQUEST_PER_RANGE` times per range (default 3) every 10min.
