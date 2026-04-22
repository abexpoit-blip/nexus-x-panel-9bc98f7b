---
name: IPRN-SMS portal (panel.iprn-sms.com)
description: Symfony-based iKangoo panel — full HTTP API for ranges, numbers ZIP download, and stats (no scraping needed)
type: reference
---
# IPRN-SMS (panel.iprn-sms.com)

URL: https://panel.iprn-sms.com
Username: shahriyaar
Password: 000000
Stack: Symfony (form_login firewall) — admin template "Admin Lab Dashboard" by ikangoo
NO captcha, NO JS-rendered content — pure HTML + JSON API.

## Auth flow (HTTP-only)
1. GET  /login          → cookie PHPSESSID, hidden input `_csrf_token` in #loginform
2. POST /login_check    → form: `_csrf_token`, `_username`, `_password`, `_remember_me=on` (optional), `_submit=Login`
3. 302 → /premium-number/source-ideas (logged in) or back to /login (failed)
4. Session check: GET / → 301 to /statistics/ when logged-in; redirects to /login when not.

## Real JSON API endpoints (XHR — `X-Requested-With: XMLHttpRequest`)
All return application/json. `:type` = `sms` (or `voice` for non-SMS).

### Ranges & numbers (THE POOL)
- GET /api/helper/premium-number/my_numbers/:type
    Query: draw, start, length (DataTables-style)
    Returns: `{recordsTotal, recordsFiltered, aaData:[{id,name,user_id,user,source_id,source,payout,currency,quantity}]}`
    `aaData[].id` = range_id, `quantity` = total numbers in that range, `name` = "Country Operator XXXXXXXX(batch)"
- GET /api/helper/premium-number/my_numbers_grouped/:type   → empty unless filters
- GET /api/helper/premium-number/my_numbers_download_all/:type
    Returns: application/zip — one .txt per range, each line = one full E.164 number (no '+').
    Filename pattern: `<range name>-<user>-<source>-numbers.txt`
- GET /api/helper/premium-number/my_numbers_download/:type?id=<rangeId>&user_id=<uid>&source_id=<sid>
    Returns: application/force-download (single range as plain text)

### Sources (brands assigned to numbers)
- /api/helper/premium-number/sources-for-user/:type     (404 for normal user — admin only)
- /api/helper/premium-number/show-forbidden-sources    (returns {group, range} maps)

### Refresh / re-pool trigger
- GET /api/helper/refresh-numbers/:type
    Triggers server-side number refresh. Returns truthy on DONE, false if "Already Updating".
    REQUIRES role beyond plain user (we got 403 with shahriyaar). Useful only for admin accounts.

### Stats
- GET /api/helper/premium-number/stats/:type            (500 currently)
- /premium_number/stats/sms (page)                       — UI version

### Test (sandbox/SMS test)
- /api/helper/premium-number/test/:type
- /api/helper/premium-number/get-test-numbers/:type
- /api/helper/premium-number/download-test-numbers/:type

## UI pages (HTML — for menu/links only)
- /premium-number/source-ideas       — TOP/INTERESTING source brands list (betPawa, SOCAR, Zoho, WeChat, etc.)
- /premium-number/my-numbers/sms     — DataTable of assigned ranges (uses my_numbers/sms ajax)
- /premium-number/test/sms
- /premium-number/reports-by-hour/sms
- /premium_number/stats/sms
- /finance/account_details, /finance/invoices
- /statistics/

## How OTP / SMS feed works (TBD)
The user-facing flow is: download numbers → use them on a target service → SMS arrives at IPRN platform → reports.
**No live "OTP per number" feed has been observed for this user role.** Any OTP polling needs the reports endpoint:
- /api/helper/premium-number/reports/:type   (pull SMS log; format unknown — needs probe)
- /api/helper/premium-number/reports-by-hour/:type

## Bot strategy (iprnSmsBot)
- HTTP-only with axios + cookie jar (Symfony PHPSESSID), same pattern as iprndata bot.
- Login resume from saved cookie; re-login on /login redirect.
- Pool sync:
    1. GET my_numbers/sms → list of range_id + name + quantity
    2. For each range, GET my_numbers_download/sms?id=...&user_id=...&source_id=... → text file with ALL numbers
    3. Bulk-insert into `allocations` table with provider='iprn_sms', operator=range name, country inferred from first 2-3 digits.
- This is FULL AUTO POOLING — user doesn't need to upload txt files manually anymore.
- Provider mode: 'manual' (same as iprn/msi/ims) but admin doesn't have to do anything once bot runs.

## Differences from iprndata.com
- Symfony vs Yii2 (form keys: `_username` vs `LoginForm[username]`)
- ZIP download API replaces HTML table scraping → much faster & more reliable
- Real range-id system (not just "range_prefix" string)
- Account here has 13,979 numbers across 3 ranges (Tajikistan 9981, Timor Leste 2999, PH GLOBE 999)
