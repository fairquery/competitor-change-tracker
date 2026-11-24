# Changelog

## Unreleased

### Digest mode

- Each digest row and the run `OUTPUT` include `since`, `changes_count`, `changed` and `is_baseline`.
- `since` is the ISO time of the previous successful digest for `watchlistName`. It is stored in the caller's Apify key-value store (`stateStoreName`, default `fairquery-competitor-tracker`), next to page baselines. It is null on the first digest. Nothing is sent to Fairquery.
- The first digest for a watchlist is `is_baseline: true`. Its summary starts with `Baseline for {domain}:` and cannot be read as a quiet period.
- A later digest with differences starts `Since {since}:`. A confirmed quiet digest is exactly `No changes since {since}.`
- `changes_count` counts page changes plus technologies added or removed. `changed` is true when that count is greater than zero. Jobs opened and closed are not included.
- Only the last successful digest time is kept. There is no `sinceOverride` input. An aborted run, or a run that stops for max cost, does not move the clock.
- CSS selectors and `digestTech` are unchanged. `digestJobs`, if sent, is ignored.
