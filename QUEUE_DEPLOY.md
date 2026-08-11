# UC_MOMENTUM v1.1.1 Queue Rollout — Cloudflare Free

This is the controlled rollout for replacing the synchronous v1.1 opportunity scan with a Cloudflare Queue pipeline. The goal is to remain within the Workers Free external-subrequest and D1 query budgets without publishing partial BUY/rotation decisions.

## Safety model

- Kite/broker remains authoritative for holdings, quantities, trades, orders and GTT execution.
- This release never writes broker-owned holding fields (`quantity`, `entry_price`, `entry_date`, `gtt_id`, `gtt_trigger`, `gtt_qty`) and never writes trades.
- Candidate/watchlist Yahoo work is split into Queue messages of at most 10 symbols.
- One Queue message is consumed per Worker invocation with `max_concurrency = 1`.
- Holdings are fetched fresh in the finalizer and are not duplicated in candidate batches.
- If any holding price history is unavailable, finalization retries rather than publishing a portfolio state.
- If any candidate/watchlist symbol has a terminal data error, the run is `INCOMPLETE`: BUY candidates are not actionable, rotation is held, pyramiding is blocked, and full-universe ranks/opportunities are not published.
- A production publication is a single transactional D1 `batch()` with a hard maximum of 12 SQL statements. Large row sets use D1 `json_each()` expansion rather than one SQL statement per symbol.
- Distributed dry runs write only operational `scan_runs` / `scan_staging` state. They do not publish portfolio strategy state.
- Do not apply the v1.1 CONTRACT migration during this rollout.

## Resources

Production Worker:

- `uc-portfolio`

Production D1:

- `uc-portfolio-db`
- database ID `82c725e5-14cd-4d13-82d5-2ec049319695`

Queues to create before deploying the Worker:

- `uc-momentum-scan`
- `uc-momentum-scan-dlq`

Wrangler bindings are already defined in `wrangler.toml` on the queue release branch.

## 1. Preflight

Confirm:

- production `main` is still the known-good v1.1 release;
- Cloudflare builds for non-production branches remain disabled;
- current broker integrity baseline still matches the release snapshot;
- no active manual refresh is running.

Do not touch `uc-kite-executor` or `uc-momentum-dashboard` as part of this rollout.

## 2. Create the two Queues

Create `uc-momentum-scan` and `uc-momentum-scan-dlq` in the same Cloudflare account as `uc-portfolio`.

Creating the Queues alone must not change the deployed Worker.

## 3. Apply additive queue-state migration

Apply only:

```text
migrations/004_queue_scan.sql
```

It creates only:

- `scan_runs`
- `scan_staging`
- `idx_scan_runs_status_created`
- `idx_scan_staging_run_completed`
- `idx_scan_staging_run_candidate`

Verify existing tables and broker-owned fields are unchanged. The migration is additive and can remain in place if the Worker is rolled back.

## 4. Deploy exact tested queue release

Only after the Queues and migration are verified, promote the exact tested queue release commit to `main` so the configured Cloudflare production build deploys it.

The deployed Worker entry point must be:

```text
src/queue-worker.js
```

and the `SCAN_QUEUE` producer/consumer binding must resolve to `uc-momentum-scan`.

## 5. Distributed dry run

Call:

```text
GET /api/refresh?dry=1
```

Expected immediate response:

- HTTP `202`
- `version = v1.1.1-queue`
- `accepted = true`
- `dryRun = true`
- a `runId`
- a `statusUrl`

This is asynchronous. Poll:

```text
GET /api/scan-status?runId=<runId>
```

until a terminal status is reached.

### Dry-run release gate

Proceed only if terminal status is:

```text
DRY_COMPLETE
```

and all of the following are true:

- `progressPct = 100`
- `failedItems = 0`
- `summary.universeComplete = true`
- `summary.scan.actionable = true`
- candidate/watchlist staged coverage is complete
- no `Too many subrequests` error
- no D1 query/subrequest-limit error
- no Worker CPU/resource-limit error
- no SQL/bind error
- holdings count remains 11 unless broker-authoritative Kite state has legitimately changed

`DRY_INCOMPLETE` or `FAILED` is a stop condition. Do not run the real refresh.

## 6. Broker integrity after dry run

Run the current `migrations/003_integrity_verify.sql` or equivalent read-only checks against the production baseline.

All broker-field violation queries must return zero rows.

The dry run is allowed to create/update only queue operational rows in `scan_runs` and `scan_staging`.

## 7. First real queued refresh

Only after the dry-run gate and integrity check pass, call:

```text
GET /api/refresh
```

Expected immediate response is HTTP `202` with a new real `runId`.

Poll `/api/scan-status?runId=<runId>` until terminal.

The release is successful only if terminal status is:

```text
COMPLETE
```

Then verify:

- `failedItems = 0`
- `summary.universeComplete = true`
- `summary.scan.actionable = true`
- full eligible universe was processed
- full universe ranking was published
- BUY candidates are based on the complete universe
- holding rotation/pyramid state is based on the complete universe
- NAV uses UPSERT and legacy `nifty_return_pct` is preserved
- `config.version = v1.1.1-queue`

Run broker integrity verification again immediately after completion.

## 8. Cron behavior

The weekday `16:15 IST` cron now enqueues a refresh and returns; Queue consumers perform the distributed work.

An existing active run prevents a second overlapping run. Active runs older than 90 minutes are failed closed and may be superseded by a later invocation.

## 9. Rollback

Before CONTRACT, rollback remains simple:

1. Roll back only `uc-portfolio` to the previous known-good v1.1 Worker deployment.
2. Leave D1 EXPAND and the additive queue tables in place.
3. Leave the Queues in place; the old v1.1 Worker does not bind or use them.
4. Do not restore D1 unless integrity is actually damaged.

Queue operational tables are not broker state and are safe to leave behind during a Worker rollback.

## 10. Later cleanup / data quality

Not blockers for the queue release, but complete these after stability is proven:

- populate real `nifty500.in_nifty100` membership;
- populate `crar`, `gross_npa`, `net_npa` for financial names;
- decide an observation window before ever applying `002_v11_contract.sql`.
