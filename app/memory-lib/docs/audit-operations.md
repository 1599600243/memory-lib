# Audit Operations

## Bounded reads

`GET /v1/admin/audit` reads from the end of `runtime/audit/access.jsonl` in bounded blocks. It returns the newest matching events and exposes non-enumerable `truncated` and `scanned_bytes` metadata to in-process callers. Sparse filters stop at the default 8 MiB scan limit instead of reading the entire file. `countAuditLines` counts with a streaming pass and caches the result in `.access.count.json`; a size change or rotation invalidates the cache.

Run the reproducible benchmark with:

```text
node scripts/audit-query-bench.mjs I:\OpenClaw\memory-data\runtime\audit\access.jsonl
```

The benchmark reports elapsed time, heap delta, and scanned bytes.

## Archive and rotation

Archiving is an explicit operator CLI, separate from the server startup. It is dry-run by default:

```text
node scripts/audit-archive.mjs --audit I:\OpenClaw\memory-data\runtime\audit\access.jsonl --cutoff 2026-09-29T00:00:00Z
```

An actual archive requires `--execute`. It first copies and fsyncs the complete source into `backups/`, then writes raw source lines to monthly `archive/access-YYYY-MM.jsonl` files and atomically replaces the main file. The report includes the backup path and line counts. Existing archive content is preserved and new rows are appended as raw bytes.

```text
node scripts/audit-archive.mjs --execute --audit I:\OpenClaw\memory-data\runtime\audit\access.jsonl --cutoff 2026-09-29T00:00:00Z --max-bytes 67108864 --retain-months 12
```

Rotation compresses older JSONL archives to `.gz` when they fall outside the retention window or the archive set exceeds the configured size. It never deletes the JSONL source. There is no implicit deletion path: any future purge must add an explicit dry-run report, a complete backup, and a separate `--execute` confirmation.

## Denial aggregation and alerting

The audit writer keeps successful events one-for-one. Consecutive denied events with the exact same `(action, denyReason, agent, role, credentialFingerprint)` are counted within a 60-second window. The first denial is written immediately with `window_head: true`; a later `aggregated: true` row records only the additional folded events in `repeat` (`count - 1`), plus `window_start` and `window_end`, when the window closes. Therefore every audit row represents `repeat ?? 1` real events, and health thresholds use that same event-unit accounting. A different key, success event, or window boundary closes the previous group. The writer exposes `flush()` for controlled shutdown and archive boundaries.

The server automatically runs additive archive rotation once per day by default. It restores `runtime/audit/rotation-state.json`, performs an asynchronous startup due-check, and repeats the due-check on the configured interval; a completed persisted rotation is not repeated after restart. Health exposes `next_due_at` and `overdue` under `audit.rotation`. These startup flags override the defaults: `--audit-max-bytes` (64 MiB), `--audit-retain-months` (12), `--audit-rotate-interval-minutes` (1440), and `--audit-unauthenticated-threshold` (100). Set the rotation interval to `0` only through an embedding option; the CLI defaults keep rotation enabled. `POST /v1/admin/audit/rotate` is admin-gated and dry-run by default; pass `{"dry_run":false}` only when explicitly executing a rotation.

`GET /v1/health` includes an `audit` block with byte size, line count, recent denied/unauthenticated/aggregated counts, and rotation state. The degraded threshold is based on the **real denied-event count**, not JSONL row count: ordinary or `window_head` rows count as 1 and an aggregated row counts as `repeat` (the additional folded events). `degraded: true` occurs when unauthenticated events exceed the configured `--audit-unauthenticated-threshold` within the 60-second window.
