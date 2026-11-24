# Pricing proposal: Competitor Change Tracker (NOT live)

Status: **proposal only.** No pricing has been set on the Actor (private Actor `8mMQ8SURJyiRPjQ7R`, `pricingInfos` empty). Model: **pay-per-event, events only** (no rental, no Standby, limited permissions), so the Actor stays eligible for agentic payments.

## Proposed events

| Event | When it is charged | Proposed price | Per 1,000 |
| --- | --- | --- | --- |
| `page-checked` | Each document fetched for a tracked page: the page itself, a job-board API read for a careers page, or one sitemap file for product tracking. Robots-blocked, skipped, error and discovery requests are free. | **$0.00049** | $0.49 |
| `change-detected` | Each change row at or above `minSeverity` that is delivered. Baselines (first run) and unconfirmed or A/B-filtered changes are free. | **$0.0049** | $4.90 |
| `page-rendered` | Each page rendered with the optional headless browser (`renderJs`, needs ≥ 1 GB). Off by default. | **$0.0059** | $5.90 |
| `apify-actor-start` | Apify's standard synthetic start event (platform default). | platform default | |

Psychological price points: $0.00049, $0.0049, $0.0059 instead of $0.0005 / $0.005 / $0.006.

## Measured true cost (real Apify runs, 2026-10-18, this account billed compute at $0.20/CU)

Full table: `test-runs/cost-summary.md` (12 runs). Platform usage = compute + key-value-store writes + dataset writes + transfer.

| Scenario | Run | Usage per charged document | At $0.30/CU (worst-case plan rate) |
| --- | --- | --- | --- |
| Rerun, 24 docs (pricing/terms/careers/changelog/sitemap) | 10-rerun `MPvEmaCcEwYfArWhv` | $0.000031 | ≈ $0.00005 |
| Baseline, 24 docs (writes every snapshot) | 02-baseline `EunrjS2UmQ4VJUBdc` | $0.000091 | ≈ $0.00012 |
| Domain discovery baseline, big sitemaps (12,692 URLs PostHog, 9 files cal.com) | 08 `pfgI8OUVjQpKSA2Zl` | $0.00012 | ≈ $0.00018 |
| Worst observed (first build, before the parse-once optimisation) | 01 `IStX2ONbCboEnSBa6` | $0.00018 | ≈ $0.00024 |
| Headless render at 1 GB (1 rendered + 2 plain) | 12 `SieVhMCOiqvgRQclC` | ≈ $0.0010 per run, ≈ $0.0009 for the render | ≈ $0.0027 per render |

Developer revenue after Apify's 20% cut: page-checked $0.000392 (≥ 1.6× the worst observed cost at $0.30/CU, ~10× a typical rerun), change-detected $0.00392 (cost ≈ one dataset write), page-rendered $0.00472 (≥ 1.7× the measured render cost at $0.30/CU). Under PPE the developer pays platform usage, so these margins matter; all three stay above cost.

## Competitor prices (checked 2026-10-18)

| Product | Price | Effective per check | Source |
| --- | --- | --- | --- |
| Visualping | Free 150 checks/mo (5 pages); Personal 1K checks $14/mo ($10 annual); 5K $35; 10K $70; Business 20K checks $140/mo ($100 annual) up to 50K $350 | ≈ $0.005–0.014 | https://visualping.io/pricing |
| Distill.io | Free 1,000 cloud checks (5 cloud monitors, 6 h min interval); Starter $15/mo 30K checks; Professional $35/mo 100K; Flexi $80+/mo 200K+; overage 4,000 checks per $1 | ≈ $0.00025–0.0005 | https://distill.io/pricing |
| ChangeTower | Free 3 pages daily; Lite $12/mo 25 pages daily; Essential $36/mo 100 pages hourly; Business $78/mo 200 pages (every 20 min per FAQ); annual −20% | ≈ $0.0005 (Essential, hourly, 100 pages) | https://changetower.com/pricing |
| Apify `jakubbalada/content-checker` | free Actor, platform usage only | usage only (no semantic diff) | Apify Store API, `research/store-raw-2026-10-18/` |
| Apify `ryanclinton/website-change-monitor` | $0.10 per site | $0.10 | Apify Store API (same folder) |
| Apify tidytools change monitor | $0.002 per page check | $0.002 | Apify Store API |
| Apify kondasviktor monitor | $0.0025 per check | $0.0025 | Apify Store API |
| Apify mrlarryjohnson monitor | $0.002 per page + $0.002 start | $0.002+ | Apify Store API |
| Apify `muhammad-bilal/web-drift-detector` | $0.0002 per page + $0.0006 per item | $0.0002–0.0008 | Apify Store API |
| Apify `gadolinium/competitor-pricing-monitor` | $0.005 per page + $0.35 per change | $0.005 | Apify Store API |
| Apify `bovi/saas-pricing-monitor` | $0.049 per snapshot, $0.019 per change | $0.049 | Apify Store API |
| Apify happitap monitor | $0.002 per page + $0.25 per start | $0.002+ | Apify Store API |

## Monthly examples (proposed prices, ~1 % of checks producing a change)

| Use | Checks / month | This Actor | Comparable plan elsewhere |
| --- | --- | --- | --- |
| 10 pages daily | 300 | $0.15 + changes ≈ **$0.16** | ChangeTower Lite $12; Visualping Personal $10–14 |
| 20 pages hourly | 14,400 | $7.06 + ~$0.70 ≈ **$7.8** | Visualping Business $100–140; ChangeTower Essential $36; Distill Starter $15 |
| 100 pages hourly | 72,000 | $35.28 + ~$3.5 ≈ **$38.8** | ChangeTower Essential $36 (100 pages hourly, visual diff); Distill Professional $35 |
| 50 pages every 15 min | 144,000 | $70.56 + ~$7 ≈ **$77.6** | Distill Flexi $80+; Visualping 50K-check plan $350 |

Positioning: far cheaper than Visualping and the semantic Apify pricing monitors (bovi, gadolinium), cheaper than ChangeTower for low/medium frequency, roughly at parity with Distill at very high frequency; but every check yields structured, semantic output (plans/prices, changed legal sections, job-board diffs, sitemap diffs) and noise filtering, not a pixel/text alert. Not the cheapest raw "page check" on Apify (web-drift-detector at $0.0002 is), which is fine given the richer output.

Options if the owner wants to be more aggressive: `page-checked` $0.00039 still clears the worst observed cost (net $0.000312 vs ≤ $0.00024).
