# Memory: index.md
Updated: just now

# Project Memory

## Core
ALWAYS provide deploy + log-check command after every backend code change. User runs on VPS at /opt/nexus/nexus-x-panel — standard deploy is `bash deploy.sh`.
IMS bot rate-limit: 15s minimum between any interactive action on imssms.org CDR page.
MSI bot: NO rate-limit needed (instant), 3–5s scrape interval is fine.
IPRN-SMS panel uses Symfony — has clean JSON API + ZIP download for numbers (no scraping needed).

## Memories
- [IMS Portal](mem://reference/ims-portal) — Login creds + scrape flow rules for imssms.org
- [MSI Portal](mem://reference/msi-portal) — Login creds + page URLs + msiBot architecture for 145.239.130.45/ints
- [IPRNData portal](mem://reference/iprndata-portal) — iprndata.com Yii2 panel (older, html-scraped)
- [IPRN-SMS portal](mem://reference/iprn-sms-portal) — panel.iprn-sms.com Symfony panel + JSON API + ZIP download (NEW)
