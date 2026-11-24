# Security Policy

## Supported versions

| Version | Supported |
| --- | --- |
| Latest Apify Actor build and `main` branch | Yes |
| Older releases | No. Please upgrade first |

## Reporting a vulnerability

Please **do not open a public issue** for security problems. Email **info@getfairquery.com** with a description, the affected version, reproduction steps and the impact.

Response targets: acknowledgement within **3 business days**, initial assessment within **7 days**, and a fix or mitigation for critical issues within **30 days**, with coordinated disclosure and credit if you want it.

Please don't access other users' data or degrade any website while testing. Report vulnerabilities in third-party platforms (Apify, Greenhouse, Lever, Ashby, npm) to those vendors.

## Network and SSRF model

- Only URLs and domains supplied by the user are fetched, plus same-site links found during domain discovery, the site's robots.txt and sitemaps, and the documented public job-board APIs (`boards-api.greenhouse.io`, `api.lever.co`, `api.ashbyhq.com`) when a careers page links to one.
- Every hop: http/https on ports 80/443 only, no credentials in URLs, DNS answers checked against private, loopback, link-local, CGNAT, multicast and reserved ranges (IPv4 and IPv6), connection pinned to the checked address (no DNS rebinding), redirects re-checked hop by hop including robots.txt.
- The headless browser (opt-in) aborts requests to private hosts, blocks service workers, images, media and fonts, and uses a fresh context per page.
- Webhooks: HTTPS only, public addresses only, 10 s timeout, one retry. The webhook URL is a secret input and is never logged.
- **robots.txt** (RFC 9309): 4xx = allowed, 5xx/unreachable = not crawled, `Crawl-delay` honoured (over 30 s = host skipped).
- **Kill switch:** HTTP 403 or 429 stops all further requests to that host for the run. No proxies, no cookies or sessions, no login, no CAPTCHA solving.
- **Caps:** 200 pages per run, 5 MB per HTML page, 30 MB per sitemap file, 50,000 sitemap URLs, 20 MB per job-board response. User regexes are length-limited and rejected if they risk catastrophic backtracking.

## Data handling

- Runs execute in *your own* Apify account. Change rows go to the run's dataset; baselines (cleaned page text by section, parsed plans, job ids and titles, sitemap URLs) go to a named key-value store in your account (`stateStoreName`) that you control and can delete. Nothing is sent to Fairquery.
- Only public pages are read. The Actor stores no cookies and collects no personal data beyond what a public page itself shows (for example a job title).
- The repository contains no credentials.
