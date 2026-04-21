# Memory: index.md
Updated: 0d ago

# Project Memory

## Core
ALWAYS provide deploy + log-check command after every backend code change. User runs on VPS at /opt/nexus/nexus-x-panel — standard deploy is `bash deploy.sh`.
IMS bot rate-limit: 15s minimum between any interactive action on imssms.org CDR page.
MSI bot: NO rate-limit needed (instant), 3–5s scrape interval is fine.
IPRN bot: HTTP-only (no puppeteer), Yii2 panel, 4s OTP poll, 600s pool sync. Provider id 'iprn', mode 'manual'.

## Memories
- [IMS Portal](mem://reference/ims-portal) — Login creds + scrape flow rules for imssms.org
- [MSI Portal](mem://reference/msi-portal) — Login creds + page URLs + msiBot architecture for 145.239.130.45/ints
- [IPRNData Portal](mem://reference/iprndata-portal) — Login + scrape endpoints for iprndata.com (HTTP-only iprnBot, no puppeteer)
