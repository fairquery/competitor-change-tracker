# Website Change Monitor: Competitor Pricing, Terms & Careers

## What does it do?

This **website change monitor** tracks your competitors' public **pricing, terms and privacy, careers, changelog and sitemap** pages on a schedule and reports **only the changes that matter**, each with a plain-English summary and a severity. Prices are parsed per plan, legal pages are compared section by section, Greenhouse, Lever and Ashby job boards are compared role by role, and sitemaps show new and removed pages. Pin a **CSS selector** when you only care about one region of a page (a pricing table, a plan grid, a legal section).

**Digest mode** writes one row per competitor domain. That row combines this Actor's pricing, terms and changelog changes with technologies added or removed (Website Tech, SEO and AI Readiness), and can post one Slack, Discord or JSON webhook message per domain. Each row says whether it is the first digest for that named watchlist (`is_baseline`) or what changed since the previous successful digest (`since`, `changes_count`, `changed`). The first digest is a baseline. It is not a quiet period.

Timestamps, rotating tokens, cookie banners, navigation and footers are ignored, so an unchanged page doesn't raise an alert. Send alerts to a webhook (JSON, Slack or Discord format) or read them from the dataset. It's exactly as fresh as your schedule: each run is one check.

## How much does it cost?

Pay per event, no subscription. Prices per 1,000 events (no start fee):

| Event                                | Free plan | Starter (Bronze) | Scale (Silver) | Business (Gold) |
| ------------------------------------ | --------- | ---------------- | -------------- | --------------- |
| `page-checked` (primary)             | $0.30     | $0.30            | $0.30          | $0.30           |
| `change-detected`                    | $4.90     | $4.90            | $4.90          | $4.90           |
| `page-rendered` (optional, JS pages) | $5.90     | $5.90            | $5.90          | $5.90           |

The [Apify Free plan](https://apify.com/pricing) includes **$5 of usage every month**, no credit card needed, and this Actor's event charges come out of that $5. That covers **20 pages checked every hour for a 30-day month** (14,400 checks = $4.32) with room for about 138 change reports, or about 16,600 page checks in total.

**Example (Free-plan prices):** 10 pricing pages checked daily: 300 checks a month = **$0.09**, plus $4.90 per 1,000 changes reported.

The price is the same on every Apify plan. Set a maximum cost per run in the run options and the Actor stops before exceeding it.

## How to use it

1. Add **Pages** with a type (`pricing`, `terms`, `privacy`, `careers`, `changelog`, `blog`, or `product` for a sitemap URL or site root), or give **Domains** and let it find those pages. Optional: set `cssSelector` on a page, or one selector for the whole run, to compare only that DOM region.
2. Set a minimum severity and, optionally, a **webhook URL** for alerts. For a weekly competitor rollup, set `mode` to `digest` and schedule the run weekly.
3. Click **Start** once to store the baseline, then create an Apify Schedule (hourly, daily or weekly). Later runs report only changes. The first digest for a `watchlistName` is a baseline (`is_baseline: true`, `since: null`), not a "no change" result. It saves a tech-stack baseline. The next run reports what changed since that time.

**Example input**

```json
{
    "pages": [
        {
            "url": "https://basecamp.com/pricing",
            "type": "pricing"
        },
        {
            "url": "https://linear.app/pricing",
            "type": "pricing"
        },
        {
            "url": "https://linear.app/terms",
            "type": "terms"
        },
        {
            "url": "https://jobs.ashbyhq.com/linear",
            "type": "careers"
        }
    ]
}
```

**Example output** (one row from a real run on 2026-10-17, shortened to the main fields). In this test run the stored baseline was edited to simulate the old price:

```json
{
    "type": "change",
    "url": "https://basecamp.com/pricing",
    "page_type": "pricing",
    "severity": "high",
    "change_kind": "price_changed",
    "summary": "\"Pro\" price changed from $79/month to $99/month (up 25.3%).",
    "details": {
        "plan": "Pro",
        "from": {
            "amount": 79,
            "currency": "USD",
            "period": "month",
            "billing": null,
            "unit": null,
            "raw": "$79"
        },
        "to": {
            "amount": 99,
            "currency": "USD",
            "period": "month",
            "billing": null,
            "unit": null,
            "raw": "$99"
        },
        "change_pct": 25.3
    },
    "checked_at": "2026-10-18T02:45:39.652Z",
    "previous_checked_at": "2026-10-18T02:43:49.387Z"
}
```

## FAQ

### How do I track a competitor's pricing page for changes?

Add the pricing page with type `pricing`, run once to save a baseline, then schedule the Actor. You get a row when a plan is added or removed or a price changes, with old and new values.

### How often does it check?

As often as your Apify Schedule runs it, for example hourly or daily. It doesn't watch pages continuously, and a change made and reverted between two runs isn't seen.

### Will cookie banners and timestamps trigger false alerts?

They're filtered out, along with rotating tokens, navigation and footers, and changes are re-read before reporting to cut A/B-test noise. Some variant noise can still get through.

### Can it watch JavaScript-only pages?

Yes. Set `renderJs` to `auto` (render only pages whose plain HTML has no readable prices or almost no text) or `always`, and run with at least 1 GB memory; each rendered page adds $5.90 per 1,000.

## Limits

Plan parsing is heuristic; usage-based pricing pages and calculators can produce odd plan names. Runs use Apify datacenter IPs, so prices may differ by country. Sites that block automated access are skipped. Fairquery is not affiliated with any tracked site.

## When to use this Actor (LLM / tool selection)

Use it when a person, agent or workflow needs to:

- Know when a competitor **changes a price, adds or removes a plan**, or switches monthly/annual billing
- See **which sections of a Terms of Service or Privacy Policy changed**, with the removed and added sentences
- Spot **new or removed product, feature or integration pages** (sitemap diff)
- Follow **hiring signals**: new and closed roles by department from Greenhouse, Lever or Ashby boards, or keyword counts on a plain careers page
- Get one **digest per competitor domain** for what changed since the last successful run of that named watchlist: pricing, terms and changelog changes, and tech-stack additions or removals (`mode: "digest"`)
- Watch **one DOM region** of a page with a CSS selector (`#pricing`, `main .plans`) instead of the whole document
- Get **new changelog or blog entries** with their links
- Send alerts to **Slack, Discord or any HTTPS webhook**, filtered by severity

Do **not** use it for: pages behind a login, paywall or CAPTCHA (never accessed), visual/pixel comparison of designs, minute-by-minute monitoring, or sites whose robots.txt disallows the page (skipped and reported).

## What counts as a change

| Page type             | What is compared                                                                        | Example summary (from test runs)                                                                                                              |
| --------------------- | --------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `pricing`             | Plans: name, price, currency, period (month/year/hour), per-user units, billed annually | `"Pro" price changed from $79/month to $99/month (up 25.3%).` · `New plan "Studio" ($59/month).`                                              |
| `terms`, `privacy`    | Sections (by heading), sentence-level diff, renamed sections                            | `Terms of service: 2 sections changed: "Terms of Service" (modified: +1/−1 sentences), "Linear’s Ownership" (added). Removed: “…” Added: “…”` |
| `careers`             | Job board (Greenhouse/Lever/Ashby) roles by id, or careers-page text and keyword counts | `3 new roles (3 Product); 1 role closed (1 Engineering). Open roles: 27 → 29 (+7%).`                                                          |
| `changelog`, `blog`   | Entry headings and links                                                                | `2 new changelog entries: “Stacked pull requests”, …`                                                                                         |
| `product` (site root) | sitemap.xml URLs (index files and .gz supported)                                        | `2 pages removed from the sitemap (2 product/feature-like), e.g. /features/…`                                                                 |
| `generic`             | Page text by section                                                                    | `Page: 1 section changed …`                                                                                                                   |

Severities: **high** (price/plan changes, substantive legal edits about liability, data, AI, arbitration, fees, termination and similar), **medium** (larger text changes, product pages added/removed, notable hiring shifts, watched keywords), **low** (small edits, routine sitemap churn, a page switching back to a version seen before).

### Noise filtering

- Strips scripts, styles, nav, footer, cookie/consent banners and hidden templates; reads the main content.
- Masks timestamps, dates, "x minutes ago", session tokens, UUIDs, hashes, cache-busting parameters, copyright years and live counters. Numbers are masked except on pricing and legal pages, where they matter.
- Ignores reordered sentences, small edits under `minChangeChars`, and your own `ignorePatterns`.
- **Confirms each change with a second read** (after the polite delay; not charged) so A/B variants that come and go within seconds are not reported.
- **Remembers recent versions:** a page alternating between two versions across runs alerts once, then only as one low-severity "switched back" item.
- Small edits accumulate against the old baseline until they cross the threshold, so a slow drip of edits is not lost.

## Input

You can give exact pages, plain URLs (type guessed from the path), or domains plus the page types to find.

| Field                                                   | Default                                              | What it does                                                                                                                                                                                                                                           |
| ------------------------------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `mode`                                                  | `watch`                                              | `watch` writes one row per change. `digest` also writes one row per domain (pricing/terms/changelog + tech-stack add/remove) with `since`, `changes_count`, `changed` and `is_baseline`, and posts one webhook payload per domain |
| `digestTech`                                            | true                                                 | In digest mode, call Website Tech, SEO and AI Readiness. It bills your account at its own per-1,000 price. Set it to false to leave that signal out                                                                                                    |
| `digestJobs`                                            |                                                      | Old input, still accepted and ignored, because jobs are no longer part of the digest                                                                                                                                                                  |
| `cssSelector`                                           |                                                      | CSS selector applied to every page that does not set its own. Only that region is compared                                                                                                                                                             |
| `pages`                                                 |                                                      | List of `{ "url": "...", "type": "pricing", "cssSelector": "#pricing" }` (types: pricing, product, terms, privacy, careers, changelog, blog, generic). `cssSelector` is optional                                                                       |
| `urls`                                                  |                                                      | Plain URL list; type guessed from the path (`/pricing` → pricing, `/terms` → terms, …)                                                                                                                                                                 |
| `domains`                                               |                                                      | Competitor domains; the Actor finds the requested page types via homepage links and a few common paths (cached 30 days, discovery requests are free)                                                                                                   |
| `pageTypes`                                             | pricing, terms, privacy, careers, changelog, product | Page types to find for `domains`                                                                                                                                                                                                                       |
| `watchlistName`                                         | `default`                                            | Name of this watchlist. Page baselines and the digest `since` time are stored under this name in your Apify key-value store. Use the same name every run. Different names do not share history                                                         |
| `maxPages`                                              | 50 (≤ 200)                                           | Cap per run                                                                                                                                                                                                                                            |
| `minSeverity`                                           | `low`                                                | Changes below it are not output or charged                                                                                                                                                                                                             |
| `careersKeywords` / `watchKeywords`                     |                                                      | Words to count on careers pages / anywhere (e.g. "AI", "SOC 2", "enterprise")                                                                                                                                                                          |
| `ignorePatterns`                                        |                                                      | Extra regexes to ignore (ReDoS-checked)                                                                                                                                                                                                                |
| `minChangeChars`                                        | 20                                                   | Smallest text change worth reporting (legal pages use a lower floor)                                                                                                                                                                                   |
| `includeDiff`                                           | true                                                 | Include removed/added sentences in `details`                                                                                                                                                                                                           |
| `webhookUrl`, `webhookFormat`, `webhookMinSeverity`     | , `json`, `medium`                                   | HTTPS webhook for alerts: `json`, `slack` or `discord` (stored as a secret input)                                                                                                                                                                      |
| `renderJs`                                              | `never`                                              | `auto`: render with a headless browser only when plain HTML has no readable prices or almost no text; `always`: render all. Needs ≥ 1024 MB memory; robots.txt still applies                                                                           |
| `confirmChanges`                                        | true                                                 | Re-read a page once before reporting a change                                                                                                                                                                                                          |
| `sitemapInclude` / `sitemapExclude` / `maxSitemapFiles` | / / 10                                               | Filter sitemap URLs by regex; cap sitemap files read                                                                                                                                                                                                   |
| `requestDelaySecs`                                      | 1.5 (1–30)                                           | Minimum gap between requests to the same host (a larger robots.txt Crawl-delay wins)                                                                                                                                                                   |
| `stateStoreName`                                        | `fairquery-competitor-tracker`                       | Named key-value store in your Apify account. Holds page baselines and, for each `watchlistName`, the last successful digest time and detected technologies. Stays until you delete it                                                                  |
| `resetBaseline`                                         | false                                                | Start over: this run becomes the new baseline                                                                                                                                                                                                          |

### Example input

```json
{
    "watchlistName": "saas-competitors",
    "pages": [
        { "url": "https://basecamp.com/pricing", "type": "pricing" },
        { "url": "https://linear.app/pricing", "type": "pricing" },
        { "url": "https://github.com/site/terms", "type": "terms" },
        { "url": "https://jobs.ashbyhq.com/linear", "type": "careers" }
    ],
    "domains": ["cal.com"],
    "careersKeywords": ["AI", "enterprise"],
    "webhookUrl": "https://hooks.slack.com/services/…",
    "webhookFormat": "slack"
}
```

Weekly digest (one dataset row and, when `webhookUrl` is set, one Slack/Discord/JSON message per domain):

```json
{
    "mode": "digest",
    "watchlistName": "saas-competitors",
    "domains": ["linear.app", "cal.com"],
    "pageTypes": ["pricing", "terms", "changelog"],
    "cssSelector": "main",
    "webhookUrl": "https://hooks.slack.com/services/…",
    "webhookFormat": "slack"
}
```

Then add an **Apify Schedule** (for example hourly or daily, or weekly for digest) with the same input, including the same `watchlistName`. The first run stores baselines; every later run reports changes. Digest state stays in that named store in your Apify account. It is not sent to Fairquery.

## Output

One dataset row per change (view **Changes**), plus `baseline`, `skipped` and `error` rows so you can see what happened to every page. A summary goes to the `OUTPUT` record.

### Change row (from a test run; the old price was simulated by editing the stored baseline)

```json
{
    "type": "change",
    "watchlist": "fq-test-main",
    "checked_at": "2026-10-18T02:15:41.208Z",
    "url": "https://basecamp.com/pricing",
    "page_type": "pricing",
    "domain": "basecamp.com",
    "severity": "high",
    "change_kind": "price_changed",
    "summary": "\"Pro\" price changed from $79/month to $99/month (up 25.3%).",
    "details": {
        "plan": "Pro",
        "from": { "amount": 79, "currency": "USD", "period": "month", "raw": "$79" },
        "to": { "amount": 99, "currency": "USD", "period": "month", "raw": "$99" },
        "change_pct": 25.3
    },
    "previous_checked_at": "2026-10-18T02:10:52.136Z"
}
```

`change_kind` values: `price_changed`, `plan_prices_changed`, `plan_added`, `plan_removed`, `pricing_restructured`, `pricing_unparsed`, `pricing_text_changed`, `legal_text_changed`, `content_changed`, `pages_added`, `pages_removed`, `jobs_changed`, `careers_keywords_changed`, `new_entries`, `keyword_changed`, `reverted_to_seen_version`, `digest`.

### Digest row (`mode: "digest"`, one per domain)

```json
{
    "type": "digest",
    "change_kind": "digest",
    "domain": "linear.app",
    "severity": "high",
    "since": "2026-10-18T02:10:52.136Z",
    "changes_count": 3,
    "changed": true,
    "is_baseline": false,
    "summary": "Since 2026-10-18T02:10:52.136Z: linear.app weekly digest: \"Pro\" price changed from $12/month to $15/month. jobs: not included. tech: added Segment; removed Google Analytics.",
    "details": {
        "page_changes": [
            { "page_type": "pricing", "severity": "high", "change_kind": "price_changed", "summary": "…" }
        ],
        "jobs": {
            "status": "skipped",
            "code": "JOBS_SIGNAL_RETIRED",
            "message": "Jobs opened and closed are not included in digest mode.",
            "opened": 0,
            "closed": 0
        },
        "tech": {
            "status": "ok",
            "added": [{ "name": "Segment", "category": "Analytics" }],
            "removed": [{ "name": "Google Analytics", "category": "Analytics" }],
            "current_count": 12
        }
    }
}
```

`since` is the ISO time of the previous successful digest for this `watchlistName`, stored in your Apify key-value store (`stateStoreName`). It is null on the first digest. `changes_count` counts page changes plus technologies added or removed. `changed` is true when that count is greater than zero. `is_baseline` is true only on the first digest for that watchlist.

Read the flags in this order:

- `is_baseline: true` — first digest. The summary starts with `Baseline for {domain}:` and says this is not a quiet period. `changed: false` here means nothing was diffed yet, not that the competitors were quiet.
- `changed: true` — the summary starts with `Since {since}:`.
- `changed: false` and `is_baseline: false`, and the summary is exactly `No changes since {since}.` — every enabled signal was compared and nothing changed. Jobs are not included.
- If `tech.status` is `baseline` or `error`, or tech was skipped because the run aborted, hit max cost, or passed the domain cap, the summary does **not** say `No changes since`. Those rows are not a confirmed quiet period.

`tech.status` is `ok`, `baseline` (first successful read; nothing is reported as added or removed yet), `error` or `skipped`. `jobs.status` is `skipped`: jobs opened and closed are not included. A quiet digest is still one row per domain. Page-change rows are still written alongside the digest. The digest row itself is not a separate charge.

The clock is one timestamp per watchlist: the last digest that finished and saved state. Older windows are not stored, and there is no input to override `since`. An aborted run or a run that stops for max cost does not move the clock. Use the same `watchlistName` and `stateStoreName` on every scheduled run. A different watchlist name has its own clock in the same store.

### Run summary (`OUTPUT`)

`status`, `pages_checked`, `baselines`, `changes`, `changes_by_severity`, `unchanged`, `skipped`, `errors`, `requests`, `bytes_downloaded`, `browser_renders`, `events`, `webhook`, `warnings`, `duration_secs` and a per-page list with notes such as `304 Not Modified` or `ROBOTS_DISALLOWED`. `warnings` is present when digest mode is given `digestJobs: true`.

A digest run adds `mode`, `digests`, `digest_calls`, and the same watchlist fields as the rows: `since`, `changes_count` (sum across domains), `changed` and `is_baseline`. `digest_calls.jobs` is not a child run: `actor_id` is null, and each row's jobs section stays `skipped` with code `JOBS_SIGNAL_RETIRED`. `since` and `is_baseline` describe the watchlist, not one domain. `changed: false` on a baseline run is not a quiet period.

## Pricing (pay per event)

| Event                                                            | Price           |
| ---------------------------------------------------------------- | --------------- |
| Page checked (each page, job-board read or sitemap file fetched) | $0.30 per 1,000 |
| Change reported (at or above `minSeverity`)                      | $4.90 per 1,000 |
| Page rendered with the headless browser (optional)               | $5.90 per 1,000 |

Free: baselines beyond the page check, robots-blocked/skipped/error rows, discovery requests, confirmation re-reads, filtered A/B flips below `minSeverity`, and the digest row itself. Set a maximum cost per run in the run options and the Actor stops before exceeding it (baselines are not saved for pages it could not pay for, so nothing is lost).

Digest mode also starts [Website Tech, SEO and AI Readiness](https://apify.com/fairquery/website-tech-seo-ai-readiness) ($1.50 per 1,000 sites on the free plan). That charge lands on the same Apify account. Turn `digestTech` off to leave it out.

| Example           | Checks per month | Cost               |
| ----------------- | ---------------- | ------------------ |
| 10 pages, daily   | 300              | ≈ $0.09 + changes  |
| 20 pages, hourly  | 14,400           | ≈ $4.32 + changes  |
| 100 pages, hourly | 72,000           | ≈ $21.60 + changes |

## How it behaves (politeness and safety)

- **Public, no-login pages only.** No cookies or sessions are kept, no logins, no CAPTCHA solving, no proxies to get around blocks.
- **robots.txt is respected** (RFC 9309, longest match, `Crawl-delay` honoured; a host asking for more than 30 s is skipped). Disallowed pages are skipped and reported. 5xx/unreachable robots.txt = not crawled. Every redirect hop is re-checked.
- **Honest user agent:** `FairqueryChangeTracker/1.0 (+https://getfairquery.com; info@getfairquery.com)`.
- **Polite rate:** one request at a time per host, at least 1.5 s apart (configurable, never below 1 s), at most 4 hosts in parallel. Conditional requests (ETag / If-Modified-Since) so unchanged pages often cost the site nothing.
- **Kill switch:** an HTTP 403 or 429 stops all further requests to that host for the run.
- **Plain HTTP first.** The headless browser is opt-in, only for JavaScript-rendered pages, still checks robots.txt, blocks images/fonts/media and keeps no state between pages.
- Job boards are read through their documented public APIs (Greenhouse Job Board API, Lever Postings API, Ashby Public Job Posting API).
- Private/internal addresses are refused (SSRF protection with DNS pinning; ports 80/443 only).

## Memory / runtime

256 MB is enough for plain HTTP checks (a 24-page rerun took about 7–30 s in tests). Browser rendering needs 1024 MB or more. Default timeout 30 minutes.

## Limitations

- **Plan parsing is heuristic.** It works on most server-rendered pricing pages (tested on Basecamp, Linear, GitHub, GitLab, Zapier, Slack, Notion, Dropbox, Netlify, Tailscale and more), but usage-based pricing pages and calculators can produce odd plan names. Even then, changes are still caught by the section text comparison, and unchanged pages produce no false alerts.
- Prices may vary by country, currency and A/B tests. Runs use Apify datacenter IPs (usually US). The confirmation re-read and version memory reduce, but cannot fully remove, variant noise.
- JavaScript-only pricing pages need `renderJs` and 1 GB memory. Sites that block automated access are skipped, never worked around.
- Freshness equals your schedule. Changes made and reverted between two runs are not seen.
- If the same watchlist is run twice at the same time, the runs can overwrite each other's baselines. Schedule one run per watchlist at a time.
- Baselines live in a named key-value store in your Apify account until you delete it. Digest mode uses that same store. For each `watchlistName` it keeps the last successful digest time (the `since` clock) and the detected-technology list. Page snapshots stay under the same watchlist name. None of this is sent to Fairquery.
- Digest history is only that last timestamp. A later run cannot be asked for an older window.

## FAQ

**How is this different from Visualping or Distill?** Visualping and Distill are general-purpose website change monitors for almost any page; Visualping, for example, adds screenshots, AI change summaries and an important-or-not flag to every change. This Actor is narrower: it understands page types and returns, as structured rows, which plan's price moved and by how much, which legal section changed and which roles opened, ignoring dates, tokens and banners. It runs on your Apify schedule and is billed per check, with no monthly plan.

**Does the first run report anything?** It stores a baseline per page and outputs one `baseline` row per page (charged as a page check only). It does not emit page-change rows. In digest mode the first run for that `watchlistName` sets `is_baseline: true` and `since: null`. Do not read `changed: false` on that run as "nothing changed".

**Can I get alerts in Slack?** Yes: set `webhookUrl` to a Slack incoming webhook and `webhookFormat` to `slack`. In watch mode, only changes at or above `webhookMinSeverity` (default medium) are sent, as one message per run. In digest mode, the run posts one message per domain; page lines in that message still respect `webhookMinSeverity`, and the tech-stack lines are included. Jobs opened and closed are not included. The dataset row is the machine contract: `changed` and `changes_count` count every page change that was written, including ones the webhook text leaves out. The webhook text does not say `No changes since {since}.` when the row's `changed` is true.

**Can I watch only part of a page?** Yes. Set `cssSelector` on a page (`"#pricing"`, `"main .plans"`) or once for the whole run. The Actor compares that region only. A selector that matches nothing is reported as `SELECTOR_NOT_FOUND` and is not charged. Changing the selector saves a new baseline for the new region instead of diffing it against the old one. Job-board API URLs ignore the selector, because those pages are not read as HTML.

**What is digest mode?** Set `mode` to `digest` and schedule it (weekly is a typical choice) with a stable `watchlistName`. Each domain gets one dataset row and, if you set a webhook, one payload: pricing, terms and changelog changes from this Actor, and technologies added or removed since the previous digest. The row and the run `OUTPUT` include `since`, `changes_count`, `changed` and `is_baseline`. The first digest saves baselines and does not pretend every current technology is new. A later quiet digest says `No changes since {since}.` State for that watchlist stays in your Apify key-value store (`stateStoreName`, default `fairquery-competitor-tracker`).

**Will it get my IP banned?** It sends roughly one request per page per run, with honest identification, robots.txt and delays. If a site answers 403 or 429, the Actor stops contacting it for the rest of the run.

**Is it real-time?** No. It checks when it runs. Use an Apify Schedule for the frequency you need.

## Fairquery family

Other Fairquery tools on the Apify Store. Each one returns structured rows with machine-readable error codes, and error rows are never charged:

- [Email Validator for Agents (MX, Disposable, Typo)](https://apify.com/fairquery/email-validator-mx-disposable): syntax, MX, disposable, role and typo checks without sending mail; $0.79 per 1,000 emails
- [Website Contact & Company Enricher](https://apify.com/fairquery/website-contact-company-enricher): domain in, public business emails, phones, socials and company details out; $3 per 1,000 domains
- [Website Tech, SEO & llms.txt Check for Agents](https://apify.com/fairquery/website-tech-seo-ai-readiness): tech stack, SEO score, AI-crawler rules and llms.txt per site; $1.50 per 1,000 sites
- [Sanctions & Watchlist Screener (OFAC, EU, UK, UN)](https://apify.com/fairquery/sanctions-watchlist-screener): fuzzy name screening against official sanctions lists; $3 per 1,000 names + $7.00 per 1,000 runs
- [LLM Data Guard: PII & Secret Redactor](https://apify.com/fairquery/llm-data-guard-pii-secrets): redact PII and secrets before text reaches an LLM; $1.50 per 1,000 documents + $0.20 per 1,000 findings
- [Dependency Vulnerability Check for Agents](https://apify.com/fairquery/osv-dependency-vulnerability-check): packages and lockfiles against OSV.dev; $0.50 per 1,000 packages + $1.50 per 1,000 vulnerabilities
- [EDGAR Company Facts & Filings for Agents](https://apify.com/fairquery/edgar-company-facts-filings): SEC filings and XBRL facts by ticker, CIK or name; $1.50 per 1,000 companies on the free plan; lower on paid Apify plans
- [AI Exposure Scanner: Public Secrets, Files & AI-Crawler Policy](https://apify.com/fairquery/ai-exposure-scanner): passive, scored scan of your own domains and public GitHub repos for leaked secrets (masked), exposed files, AI-crawler policy, security headers and SPF/DMARC; $39.00 per 1,000 domains + $3.90 per 1,000 repos + $1.90 per 1,000 findings

All Fairquery Actors: https://apify.com/fairquery

## Disclaimer

Fairquery is not affiliated with any of the sites mentioned. Page content belongs to its owners. Use the Actor only for public pages and in line with the sites' terms.
