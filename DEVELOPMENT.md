# Development

Local development of the **Competitor Change Tracker** Apify Actor. The Apify Store README is [`.actor/README.md`](./.actor/README.md) (`readme` in `.actor/actor.json`); the GitHub [README.md](./README.md) is the same text plus development notes.

## Layout

| Path                             | What                                                                                                                                                     |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/main.ts`                    | Actor entry: input, discovery, per-host workers, rows, charging, digest, webhook, OUTPUT                                                                 |
| `src/digest.ts`                  | Digest mode: per-domain assembly, the tech input flag, since/changed/is_baseline, Slack/JSON/Discord payload. No network                                 |
| `src/actors.ts`                  | Production Actor client (`Actor.call` + dataset items). Unit tests do not import it                                                                      |
| `src/input.ts`                   | Input parsing and validation (`parseInput` → input + problems), including `mode` and CSS selectors                                                       |
| `src/check.ts`                   | One page: fetch (conditional GET), optional render, snapshot, compare, confirmation re-read, version history                                             |
| `src/http.ts`                    | `Fetcher`: SSRF guard + DNS pinning, robots.txt per origin (cached 24 h), per-host gap, kill switch, decompression, size caps                            |
| `src/robots.ts`, `src/ssrf.ts`   | RFC 9309 parser (with Crawl-delay) and private-address checks                                                                                            |
| `src/extract.ts`                 | HTML cleaning (scripts, consent banners, page chrome), blocks, sections, links, changelog entries                                                        |
| `src/noise.ts`                   | Noise normalisation rules (timestamps, tokens, counters, …) and user ignore patterns                                                                     |
| `src/diff.ts`                    | Sentence-level LCS diff, section diff with rename detection                                                                                              |
| `src/pricing.ts`                 | Price parsing (currencies, EU/US numbers, periods, units), plan extraction, plan comparison                                                              |
| `src/sitemap.ts`                 | sitemap.xml / index / .gz parsing and comparison                                                                                                         |
| `src/careers.ts`                 | Greenhouse / Lever / Ashby board detection, public API reads, job comparison, keyword counts                                                             |
| `src/analyze.ts`                 | Snapshots and per-type comparison, severities, summaries                                                                                                 |
| `src/discover.ts`                | Domain → page discovery (homepage links, then a few common paths)                                                                                        |
| `src/browser.ts`                 | Optional Playwright renderer (lazy import)                                                                                                               |
| `src/webhook.ts`                 | json / slack / discord webhook bodies and delivery                                                                                                       |
| `src/billing.ts`, `src/state.ts` | PPE charging helpers; named-store keys, robots cache, snapshot loading                                                                                   |
| `test/`                          | vitest unit tests + end-to-end `checkPage` tests on synthetic fixtures (`test/fixtures/`)                                                                |
| `test-runs/`                     | Real Apify test runs: `run.py` (start + collect), `sim.py` (simulate changes by editing stored baselines), `collect.py` (cost table), one folder per run |
| `research/`                      | Pricing proposal and raw competitor data                                                                                                                 |
| `scripts/`                       | Local helpers (`render-check.mts`, `time-parse.mts`)                                                                                                     |

## Run locally

```bash
npm install                       # PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 if you don't need the browser
npm test && npm run lint && npm run build
# input in storage/key_value_stores/default/INPUT.json, then:
npx apify run
```

On a machine whose DNS returns fake benchmark addresses (198.18.0.0/15), set `FQ_DEV_ALLOW_FAKE_IP=1` for local runs. It is ignored on the Apify platform (`APIFY_IS_AT_HOME=1`). `FQ_CHROME_PATH` points the renderer at a local Chrome.

## Real test runs on Apify (private Actor)

```bash
cd test-runs
python3 run.py 02-baseline in-main.json 256      # APIFY_TOKEN from the environment; never printed
python3 run.py 03-rerun in-main.json 256          # expect 0 changes
python3 sim.py && python3 run.py 05-simulated in-main.json 256   # expect the simulated changes only
python3 collect.py                                # refresh usage, write cost-summary.md
```

## Notes

- Sample values in the input schema are `prefill`, never `default`. A run without pages, URLs or domains fails fast and is not billed.
- `page-checked` is charged per document actually fetched; changes only at or above `minSeverity`; baselines are never charged as changes. A snapshot is saved only after its rows were delivered and paid for.
- Never add proxies, cookies, logins or CAPTCHA handling. A 403/429 stops the host for the run.
- Deployed to Apify as source files (`apify push`), not from a Git remote. No pricing is set in code; `LIST_PRICES_USD` in `src/types.ts` is only the proposal used for the OUTPUT estimate.
