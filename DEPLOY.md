# UC_MOMENTUM v1.1 — Controlled Deployment Runbook

This runbook is intentionally designed for an EXPAND → deploy → verify → later
CONTRACT rollout. Run commands from the repository root and target the D1
**database `uc-portfolio-db`** consistently.

> Release preparation does not run any command below against production.

## 0. Preconditions

- Use the exact tested release commit from `release/uc-momentum-v1.1`.
- Confirm the live D1 schema read-only before applying a migration; `schema.sql`
  in this repository is historical and not authoritative.
- Confirm how Cloudflare Git builds treat the release branch and `main` before
  any push/merge that could trigger a production deployment.
- Keep D1 exports and any broker/portfolio recovery data **outside GitHub**.
- Keep Cloudflare builds for non-production branches disabled during release
  preparation; `main` remains the production branch.

## 1. Exact rollback point

Immediately before EXPAND, retrieve and privately record the **current D1 Time
Travel bookmark**. Do not substitute an approximate/future wall-clock timestamp.

```bash
npx wrangler d1 time-travel info uc-portfolio-db
```

Cloudflare Time Travel is always on for supported production D1 databases. The
bookmark returned above is the exact pre-EXPAND rollback target. Optionally also
export the remote database to a secure local path outside this repository:

```bash
npx wrangler d1 export uc-portfolio-db --remote --output=/secure/path/uc-portfolio-db-pre-v11.sql
```

Never place that export under `backup/`, `test/`, `migrations/` or any tracked
repository path.

## 2. Capture broker-field integrity snapshot

```bash
npx wrangler d1 execute uc-portfolio-db --remote --file=migrations/000_integrity_snapshot.sql
```

Record the returned aggregate values privately. Do not paste them into GitHub.
The snapshot SQL is written to respect D1's five-term compound-SELECT limit.

## 3. EXPAND — additive/backward-compatible schema

```bash
npx wrangler d1 execute uc-portfolio-db --remote --file=migrations/001_v11_expand.sql
```

At this point the **old Worker must remain operational**. EXPAND preserves the
legacy macro gate columns and `rotation_replaces` specifically for this reason.
If old-Worker smoke checks fail, stop and restore before deploying v1.1.

## 4. Deploy the exact tested v1.1 Worker commit

Deploy only the release commit already validated against the EXPAND schema.
Do not merge an unverified change into `main` first.

```bash
npx wrangler deploy
```

Record the deployed Worker version/commit using your normal Cloudflare release
controls.

## 5. Dry refresh — writes suppressed

```bash
curl -fsS "$WORKER_URL/api/refresh?dry=1" > /tmp/uc-v11-dry.json
```

Review macro/regime rationale, liquidity, holding strategy state, scan results,
coverage/data errors and the `suppressedWrites` list. A dry refresh must not
mutate broker-owned holdings/trades/GTT state.

## 6. Integrity check before real refresh

```bash
npx wrangler d1 execute uc-portfolio-db --remote --file=migrations/003_integrity_verify.sql
```

Broker-owned comparison queries must show no changes. Strategy fields may still
be unpopulated until the first real refresh. Aggregate verification is split to
respect D1's five-term compound-SELECT limit.

## 7. First real refresh

Only after dry-run review and integrity checks pass:

```bash
curl -fsS "$WORKER_URL/api/refresh" > /tmp/uc-v11-live.json
```

Review the response for data/coverage errors and expected conservative fail-safe
behavior where inputs are missing or stale.

Then rerun integrity verification:

```bash
npx wrangler d1 execute uc-portfolio-db --remote --file=migrations/003_integrity_verify.sql
```

Queries that protect broker-owned fields/row sets/aggregates must return zero
violations.

## 8. Observe v1.1 before CONTRACT

Leave the database in the EXPAND state until the v1.1 Worker has been operating
normally for an agreed observation window. EXPAND intentionally supports both
old and new Worker schemas and is the safer rollback state.

## 9. CONTRACT — separate later change window

Only after v1.1 is verified stable and rollback to the old Worker is no longer
required:

```bash
npx wrangler d1 execute uc-portfolio-db --remote --file=migrations/002_v11_contract.sql
```

CONTRACT removes retired macro gate fields and the obsolete rotation replacement
column. After CONTRACT, the pre-v1.1 Worker is no longer schema-compatible.
Run v1.1 smoke/integrity checks again.

## Rollback principles

- **Before CONTRACT:** prefer Worker rollback while retaining the additive
  EXPAND schema; it is designed to remain compatible with the old Worker.
- If database state itself is damaged, restore using the exact recorded D1 Time
  Travel bookmark / secure export according to Cloudflare operational procedures.
- **After CONTRACT:** database rollback and Worker rollback must be coordinated,
  because the legacy Worker requires columns CONTRACT removes.
- Broker/execution state remains authoritative outside the strategy engine; do
  not manufacture holdings, trades, quantities or GTT identifiers from repo
  seed files.

## Repository paths used by this release

```text
src/index.js
src/strategy.js
src/dashboard.html
migrations/000_integrity_snapshot.sql
migrations/001_v11_expand.sql
migrations/002_v11_contract.sql
migrations/003_integrity_verify.sql
test/*.test.mjs
test/schema_compat.py
test/pre_v11_schema.sql
```

`migrations/patch_dashboard.py` is retained only as an auditable/reproducible
patch tool. The release commits the already-patched `src/dashboard.html`; do not
patch the dashboard ad hoc during production deployment.
