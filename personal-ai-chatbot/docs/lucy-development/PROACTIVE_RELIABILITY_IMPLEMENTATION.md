# Proactive Reliability Implementation (Task 01B-3B)

## Scope
Telegram and Discord only. Web notifications remain the existing in-memory dispatcher map and are excluded from channel success. Exactly-once delivery is not guaranteed.

## Dispatch lifecycle
`proactive_dispatches` stores one row per intended channel delivery before network calls. `pending` rows are atomically claimed as `sending` with worker lease; network calls occur outside SQLite transactions. Valid Telegram `ok:true` with `result.message_id`, Discord client message ID, or Discord REST message ID moves that row to `accepted`. Errors retain per-channel row and use retry metadata; nonretryable errors or attempts exhausted become `failed`.

The `proactive_state` row persists enablement, owner activity, unanswered count, successful transport acceptance time, next eligibility, last thought/context and cooldown fields. State is restored before scheduler runs. A dedicated `counter_applied` flag on `proactive_dispatches` guarantees that multiple channel deliveries for the same logical thought increment the unanswered counter at most once. Scheduler checks policy before processing retries; expired leases are recovered without resetting valid unanswered counts. Queue rows retain sanitized error categories and never contain credentials.

## Retry policy
Maximum five claimed attempts. Retry delay uses exponential base 5 seconds, cap 15 minutes, and 0.75–1.25 jitter. HTTP 429/5xx and network errors can retry; 400/401/403/404 are permanent. Terminal rows are retained for audit; no cleanup job is currently configured.

## Migration
SQLite uses idempotent `CREATE TABLE/INDEX IF NOT EXISTS` for `proactive_state`, `proactive_dispatches`, and due-work index. No existing table or document key is altered or dropped. This is an additive schema initialization, not a version-table migration. Test against disposable SQLite before deployment; existing production DB was not inspected or modified.

## Concurrency and restart
One in-process promise guard prevents overlapping cycles and dispatch workers. SQLite transactions and conditional updates prevent simultaneous claims across processes; per-owner active thought enqueue is transactional and deduplicated. A 60-second lease allows retry after worker loss. Shutdown clears scheduler and waits for current cycle/dispatch promises before DB close.

A process crash after remote API acceptance but before local `accepted` commit remains ambiguous; lease recovery can resend. This is bounded at-least-once attempt semantics, not exactly-once. Telegram/Discord API acceptance is not proof that recipient read the message.

## Compatibility
Existing proactive routes remain. `triggered` still indicates thought generation/enqueue flow, not recipient confirmation; additive `dispatches` result and status `channelDispatches` expose per-channel state. `force` defaults false and accepts booleans only; nonboolean input returns `INVALID_FORCE`.

## Tests
Run from backend: `node --import ./test/setup.js --test --test-reporter=tap test/proactiveOutbox.test.js test/proactive.test.js`. Set unique temporary `RUNTIME_DIR` and `SQLITE_DB_PATH`; do not use `.runtime/lucy.sqlite`. Supporting suites: `test/sqliteStorage.test.js`, `test/memory.test.js`, `test/memoryInitialization.test.js`, `test/ai.test.js`.
