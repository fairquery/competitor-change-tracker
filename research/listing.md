# Store listing draft (not published)

- **Title:** Competitor Change Tracker: Pricing, Terms, Careers & Changelog
- **Short description (actor.json):** Track competitors' public pricing, terms/privacy, careers, changelog and sitemap pages on a schedule. Get only meaningful changes: plan and price changes, changed legal sections, new pages and roles, with plain-English summaries, severity and webhook alerts.
- **Categories (max 3):** `AUTOMATION`, `BUSINESS`, `DEVELOPER_TOOLS` (alternative to the last: `SEO_TOOLS`). Set in the Console at publish time; nothing set now.
- **SEO keywords used in README:** competitor pricing tracker, price change monitor, terms of service change tracker, privacy policy changes, careers/hiring signals, changelog monitor, sitemap diff, website change detection, Visualping/Distill alternative.
- **Monetization (proposal only):** pay-per-event, see `pricing-proposal.md`. Keep: limited permissions, no Standby, events-only.
- **Claims check:** no "real-time" wording; freshness = schedule; plan parsing called heuristic; datacenter IP/geo caveat stated; competitor prices dated with sources.

## Later packaging notes (not started)

- **MCP:** expose one paid tool `track_competitor_changes(pages|domains, watchlistName, minSeverity)` that runs the Actor with the user's `APIFY_TOKEN`, and one free local tool `diff_pricing_page(url)` reusing `src/pricing.ts` + `src/http.ts` (robots-aware) for a one-off plan extraction. Could join `@fairquery/agent-trust-mcp`.
- **n8n:** template "Schedule → Apify Run Actor (competitor-change-tracker) → IF severity=high → Slack" ; or simply use the built-in `webhookUrl` with an n8n Webhook trigger.
