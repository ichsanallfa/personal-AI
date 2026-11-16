# Lucy Proactive Reliability Audit & Design

**Scope:** read-only static audit of current proactive code paths, callers, transports, persistence adapters, lifecycle, and tests. No source, schema, configuration, database, or data files changed. No app/tests run. `.env` values and database/data contents were not inspected. Line references reflect inspected source snapshot.

## Section 1 — Existing Implementation

Proactive subsystem is `ProactiveThoughtService` in `backend/src/services/ai/proactiveThoughtService.js`. Module exports singleton plus class. Constructor initializes settings/state and reads recent generated text from a raw JSON file. Runtime startup in `backend/src/server.js:startServer()` initializes memory then, outside test mode, starts reminder and proactive intervals and VTube service before listening. Scheduler starts once per singleton because `startScheduler()` returns when `intervalHandle` is truthy (`proactiveThoughtService.js:497-498`). Shutdown calls `stopScheduler()` (`server.js:69-73`), which clears timer but does not await an active callback.

Callers: one-minute interval callback; owner-protected `POST /api/proactive/trigger` in `backend/src/controllers/proactive.controller.js:29-45`; chat controller activity updates and direct timestamp update in `backend/src/controllers/chat.controller.js:32,45`; owner activity endpoint in `proactive.controller.js:16-24`. `POST /trigger` defaults `force=true`, so route can bypass enabled, quiet hours, idle, and cooldown checks; route itself requires owner via `backend/src/routes/proactive.routes.js:15`. The status endpoint `GET /api/proactive/status` has no auth middleware (`proactive.routes.js:13`); no app-wide auth was found (`backend/src/app.js:22+`). Controller applies `Boolean(force)`, so JSON string `"false"` is truthy and still forces; only boolean `false` disables force (`proactive.controller.js:31-35`). No current daily limit was found in proactive service/routes.

Cycle: eligibility via `canTriggerSpontaneousThought()` → stage/mode prompt and provider/fallback generation → duplicate filter → state/history updates → local chat-history append → in-memory notification enqueue → Telegram/Discord dispatch → VTube expression. `triggered:true` means text generation and local side effects completed, not transport delivery.

Generation calls the selected non-mock provider up to three times only when completions resolve but return empty/duplicate candidates. A thrown provider error exits the loop immediately, is logged, and curated templates are tried (`:333-377`). The seed/mode/template sets are program-defined. Duplicate filter compares normalized text/Jaccard against the latest ten messages (`:170-184`).

Current policy: idle default 10 minutes (`:134`), answer-wait default five minutes (`:136`); random cooldown is 30–60 seconds at ping counts 0–3 and 5–10 minutes from count 4 (`:187-195`). Ping count 1 uses the separate answer-wait threshold (`:258-261`). No daily limit is implemented in the inspected proactive service/routes.

## Section 2 — Persistent vs Process-local State

| State | Current location | Lifecycle / restart impact |
|---|---|---|
| `enabled` | Service instance boolean (`:120`) | Resets true on process start; owner toggle is not persisted. |
| `intervalHandle` | Service instance timer (`:121`) | Recreated on startup; not durable task state. |
| `lastSpokenAt`, `lastUserMessageAt` | Instance timestamps (`:123-124`); also chat controller mutates `lastSpokenAt` (`chat.controller.js:45`) | Constructor sets both to 24 hours ago; restarts lose actual activity time and can make Lucy appear idle immediately. |
| `unrespondedPings` | Instance counter (`:125`) | Resets to zero on restart; escalation state lost. |
| `targetUserId`, `targetPlatform` | Instance fields (`:126-132`) | Target recomputed from config/identity; last active channel lost. |
| `currentCooldownMs`, `lastProactiveCooldownMs` | Instance random/current and later captured cooldown (`:132,401-402`) | Resets/re-randomizes; waiting window changes across restart. |
| `minIdleTimeMs`, `waitingForAnswerMs` | Instance values from environment (`:134-136`) | Recomputed from current environment. |
| `lastInitialMode`, `lastProactiveMessage`, `lastProactiveAt` | Instance fields (`:137-140`) | Lost; recent last thought context and timing reset. |
| `lastSchedulerCheckAt`, `lastSchedulerSkipReason` | Instance fields (`:141-142`) | Lost; observability resets. |
| `lastDispatchSucceeded` | Instance field (`:143`, set at `:413`) | Lost; only latest aggregate boolean, not per-channel or durable. |
| `recentProactiveMessages` | In-memory array, max 30; raw `backend/data/proactiveHistory.json` read/write (`:144-160`) | Text history may survive restart, but write errors are caught. Keeps text only, no IDs/status/time/target. Not stored in SQLite abstraction. Actual data not inspected. |
| Chat history annotation | `chatHistoryService.appendAssistantMessage()` and SQLite-backed JSON storage (`:403-404`) | Persists as chat history when storage succeeds; separate from dispatch status, can record unsent thought. |
| In-app proactive notification | `reminderDispatcher.inAppNotifications` Map (`backend/src/services/reminder/reminderDispatcher.js:5`) | Process-local; lost on restart. Proactive inserts before external send (`:407-420`). |
| Reminder scheduler state | Separate service and stored reminders (`backend/src/services/reminder/reminderService.js`) | Not the proactive queue; not evidence of proactive recovery. |
| Active cycle / in-flight lock | No visible field or persisted lock | Nothing prevents two cycles in same process or across processes. |

## Section 3 — Delivery Lifecycle

1. **Thought generated:** `generateSpontaneousText()` returns a provider result or fresh curated template. Provider completion resolving is only generation success.
2. **Dispatch requested:** `triggerSpontaneousThought()` immediately updates `lastSpokenAt`, `unrespondedPings`, message/time/cooldown, persists recent text, appends chat history, and enqueues an in-app notification before external transport (`:389-412`).
3. **Transport accepted (best available signal):** `dispatchToPlatforms()` returns one boolean. Telegram sets `delivered=true` when Axios POST resolves; response payload is not validated (`:447-455`). Discord sets it true when `user.send()` resolves or REST channel/message POSTs resolve (`:460-486`). This shows provider/API acceptance, not end-user receipt/read.
4. **Delivery confirmed:** No read receipt/acknowledgement exists for either external channel. Web polling endpoint drains queue (`reminder.controller.js:96-105`); `NotificationToast` polls every 10 seconds and invokes `onSpeak`, but queue removal precedes proof of render/playback (`frontend/src/components/NotificationToast.jsx:8-31`). Web enqueue is not included in `lastDispatchSucceeded`.
5. The returned `triggered:true` does not expose dispatch success. `lastDispatchSucceeded` is set after aggregate dispatch returns. Telegram/Discord errors are caught/logged, return false if no send succeeded (`:441-493`). If the client is ready but Discord fetch/send throws, REST fallback is not attempted. In auto mode a successful Telegram send can suppress Discord REST fallback because `delivered` is shared.

Identity caution: target ID resolves Discord owner to canonical ID if configured, else `owner_alfaa` (`:126-130`). Web owner identity is `owner_alfaa` (`auth.controller.js`/`authService.js`); alignment depends on identity link. Not verified in runtime.

Status can report Discord as default display target when a Discord owner ID exists (`:215`), while `targetPlatform` initializes null and scheduler passes that null to auto-dispatch (`:132`, `:413`), which may try both configured Telegram and Discord. Status therefore does not prove actual channel selection.

## Section 4 — Failure Scenario Matrix

| Condition | Current behavior | Risk / impact |
|---|---|---|
| LLM timeout/error | Generation catches, logs and uses templates; no fresh template means no thought (`:356-377`). | No durable retry; current cycle may end without message. |
| Transport rejects/errors | Catch and log per channel; aggregate false if no channel succeeds (`:441-493`). | Counters, history and web notification already advanced; unsent message treated as proactive activity and duplicate-filter history can suppress retry. |
| Transport returns false/unexpected result | Current internal transports mostly throw or resolve; `dispatchToPlatforms()` does not validate external semantic response beyond Axios resolution and resulting boolean. | False, malformed body or API-level failure may be misclassified as success where HTTP resolves. |
| Stop/restart during generation/dispatch | Interval cleared, but in-flight promise is not awaited; DB closed later in shutdown (`server.js:69-95`). | Process termination can leave partial local state or send after shutdown begins. |
| Restart before retry | No retry queue/state persisted. | Failed thought is not retried; state resets; possible immediate new thought. |
| External send succeeds, process crashes before `lastDispatchSucceeded` | State/history already written before send; final bool is process memory set after send. | On restart, no durable success record. A future new thought may duplicate semantically; exact same dispatch is not replayed because no queue exists. |
| Local persistence fails before send | `rememberProactiveText()` catches file errors; chat history storage behavior depends storage return; notification Map succeeds locally. | Cycle proceeds to transport despite incomplete local records. Not atomic across these side effects. |
| SQLite failure in chat history append | Storage helper may catch/log depending call path; proactive caller does not check success result. | External message can be sent while local transcript/status inconsistent. Exact failure semantics need storage-call verification. |
| Multiple channel sends | Shared aggregate boolean; errors isolated per channel. | Partial success is not recorded per channel; retrying aggregate later would duplicate already successful channel. |
| Two interval ticks / manual trigger | No in-flight guard; eligibility checked before async generation. `force` bypasses gates. | Duplicate same-stage generation and sends; races on counter/timestamps. |

## Section 5 — Restart & Concurrency Analysis

**Startup:** `startServer()` invokes `proactiveThoughtService.startScheduler()` only outside test mode (`backend/src/server.js:20-29`). Singleton guard prevents duplicate interval setup in one instance. It does not coordinate multiple server processes, workers, or containers. Module import creates state before server starts. Recent history is loaded from a JSON file; no other proactive state load/recovery path found.

**Shutdown:** `stopScheduler()` calls `clearInterval()` but cannot cancel or await an already executing async callback (`proactiveThoughtService.js:535-541`). Shutdown can close SQLite while a callback is still doing local storage work.

**Overlap:** Node `setInterval(async () => ...)` does not wait for previous callback. If generation/send exceeds interval, another callback may start. Both may pass eligibility before either advances state (state advances only after generation); forced HTTP calls can also overlap and bypass gates. No mutex, claim token, DB lease, or idempotency key found. Two processes have independent singleton state and timers.

**Activity semantics:** chat controller resets proactive state before AI generation; any authenticated caller reaching this controller can affect owner-global proactive counters. A failed chat still called `notifyUserActivity()` first. Discord bot additionally calls `/activity` after `/chat`; duplicate reset. Local `/off` flags in bot adapters are not tied to proactive service's `enabled` flag.

**State to restore:** successful delivery timestamps per target/channel; owner activity timestamp; unanswered count/stage; enabled preference if persistence desired; cooldown deadline (absolute `nextEligibleAt`, not random relative duration); pending/failed dispatch attempts and dedupe keys. Recompute timer from persisted deadlines at startup; do not send solely because a task was recovered. Re-check enabled, permission, quiet-hours, daily limit and cooldown before each actual attempt. Observability-only last check/skip can be recomputed/reset.

## Section 6 — Proposed Target Design

Use a small SQLite-backed proactive dispatch/outbox document or table plus one state record. Existing SQLite document storage already offers transactional keyed writes, but a queue needs atomic claim/update and indexed due-work queries; a normalized table is more suitable than serializing an ever-growing queue in one document. Schema change requires explicit approval and migration plan; no change in this task.

Minimal architecture:

- `proactive_state`: singleton owner/target state and durable policy counters/timestamps.
- `proactive_dispatches`: one row per intended message/channel, status, retry and lease metadata.
- Generate candidate thought only after a backend eligibility check. Persist immutable dispatch intent before transport.
- Claim due `pending` rows atomically with a lease and unique `dispatch_id`; release DB transaction before network call.
- Before send, revalidate current permission, enabled state, quiet hours, cooldown and daily limit. Recovery alone only restores queue; it never triggers a fresh message.
- Mark each channel independently. A shared thought sent to Discord and Telegram has one logical thought ID plus separate channel dispatch rows, so partial success is representable.
- Accept only transport-specific successful API response; record as `accepted`, not “delivered/read”. Web notification needs durable queue and client acknowledgement if reliable display is required.

LLM supplies content only. Backend owns target, permission, limits, time policy, dispatch, persistence and retry. No autonomous tool actions are introduced.

## Section 7 — Database Design

Proposed schema (not implemented):

`proactive_state(owner_key PRIMARY KEY, enabled, last_user_activity_at, last_successful_dispatch_at, unanswered_count, next_eligible_at, updated_at)`

`proactive_dispatches(dispatch_id PRIMARY KEY, dedupe_key UNIQUE, thought_id, owner_key, channel, target_key, content, status, attempt_count, next_attempt_at, lease_owner, lease_expires_at, created_at, updated_at, accepted_at, last_error_code)`

- `dispatch_id`: stable identity per channel delivery; use UUID generated by backend.
- `thought_id`: groups channel-specific attempts for same generated text.
- `dedupe_key`: deterministic for logical thought + channel (and bounded window/policy) to reject duplicate enqueue; do not dedupe merely by text forever.
- `status`: `pending`, `sending`, `accepted`, `failed`, optionally `cancelled`; call accepted state, not confirmed delivery.
- `attempt_count`/`next_attempt_at`: bounded exponential backoff with jitter and maximum attempts/dead-letter state.
- `lease_owner`/`lease_expires_at`: atomic worker claim, recoverable after worker crash.
- timestamps: creation/update/attempt/acceptance; use UTC epoch consistently.
- `last_error_code`: sanitized category only, never credential/header/body containing secrets.
- `target_key`: platform user identifier; ensure scoped/authorized and avoid storing credentials.
- content retention: policy-based delete/anonymize accepted/terminal rows after audit window; do not put secrets in prompt/content. Consider encrypting sensitive personal content only if existing threat model requires it.

Potential schema is a real migration. Current SQLite `documents(key,value,updated_at)` has no queryable queue index; adding queue table requires versioned migration, backup/rollback plan and test on disposable DB first.

## Section 8 — Recovery & Retry Strategy

Use **at-least-once attempt semantics**, not exactly-once delivery. Most platform APIs do not offer Lucy-controlled idempotency for sending a message; crash after remote acceptance but before local status commit is irreducibly ambiguous. Strategy:

1. Persist row as pending before attempt.
2. Atomic lease claim moves pending→sending with lease expiry.
3. On accepted API response, persist accepted and per-channel state.
4. On explicit rejection/timeout, persist failed/next attempt; classify retryable versus permanent errors. Bounded exponential backoff + jitter, max attempts, then terminal failed/manual status.
5. On restart, expired `sending` lease becomes retry candidate only after policy revalidation. Ambiguous timeout may cause duplicate; content/channel dedupe and bounded retries reduce but cannot eliminate it.
6. For crash after remote accept before local commit, reconcile only if API exposes message lookup/correlation; otherwise retry may duplicate. Do not claim exactly-once.
7. Daily count and cooldown should count successful transport acceptance (or separately define attempt limits). Retry must not bypass permission/quiet-hours/daily cap. Keep reserved attempt rate-limit so retries cannot flood.
8. Process-wide worker lock: DB lease claim in transaction; lease heartbeat for long calls; a single-proactive-cycle lease can prevent duplicate generation. Unique dedupe key blocks duplicate intent across workers.
9. Persist owner activity changes through authenticated backend action. Startup schedules next evaluation at `next_eligible_at`; it does not enqueue a thought automatically.
10. Web queue: replace process Map only if durable web notifications are required; claim/ack per client or define at-most-once drain semantics. Current poll-and-clear loses notification on client/render failure and competing sessions consume the same queue.

## Section 9 — Regression Test Plan

Implement later with temporary SQLite database and mock transports only:

1. Successful send marks channel `accepted` and updates success timestamp/counter.
2. Transport throw leaves no successful-delivery count/timestamp.
3. Counter changes only after accepted response.
4. Successful timestamp changes only after accepted response.
5. Retryable failure schedules retry; permanent failure reaches terminal state.
6. Restart restores state and due work without immediately generating/sending new thought.
7. Expired `sending` lease recovers to retryable pending state.
8. Duplicate enqueue with same idempotency key creates one dispatch.
9. Two concurrent cycle calls produce at most one claimed thought/dispatch.
10. Cooldown and daily limit persist and remain enforced after restart.
11. SQLite transaction failure leaves intent/state not falsely accepted and bubbles error.
12. Discord, Telegram, and web semantics tested independently; API acceptance must not be asserted as recipient read/receipt.
13. Partial multi-channel success retries only failed channel.
14. Stop during dispatch drains/awaits in-flight work or cleanly leaves recoverable lease.
15. Timeout-after-remote-acceptance documents unavoidable duplicate ambiguity.

## Section 10 — Implementation Scope

**Likely files:** `backend/src/services/ai/proactiveThoughtService.js` (cycle/state separation), `backend/src/services/reminder/reminderDispatcher.js` or a focused proactive transport adapter (per-channel result semantics), `backend/src/storage/sqliteStorage.js` only if adding transactional methods, one new migration/schema module only after approval, `backend/src/server.js` (worker lifecycle/shutdown drain), `backend/src/controllers/proactive.controller.js` (status/trigger result), `backend/src/routes/proactive.routes.js` only if permissions/rate controls need adjustment, `backend/test/proactive.test.js` plus focused storage/dispatch tests.

**Likely unchanged:** AI provider implementations, frontend, memory schema, bot command handlers unless channel opt-out controls are explicitly wired, reminder parser/scheduler, VTube, curiosity/goal/cognitive systems.

**Compatibility risks:** changing `triggered` semantics/API shape; moving aggregate bool to per-channel result; legacy status consumers; changed cooldown/escalation meaning; missed/duplicate notifications during migration; identity mismatch between Discord canonical owner and web owner; dev/test imports of singleton. Maintain existing API fields during transition or version contract.

**Schema risk:** new versioned SQLite migration for queue/state; backup, rollback, and idempotent migration tests required. Existing document keys remain untouched. No migration should execute against active data without explicit approval and backup.

**Channels:** Discord `user.send()` / REST resolve implies platform accepted, not read. Telegram Axios resolving means HTTP success; inspect Telegram API `ok` payload. Web Map currently has no durable acknowledgement. Keep separate per-channel outcomes and never infer one platform's success from another.

## Section 11 — Recommendation

Approve reliability design before implementation. First define what constitutes “successful” (API accepted versus user-visible), target/identity and opt-out policy. Then implement persistent outbox with per-channel rows and atomic leases, while preserving current API response fields. Add persistence/migration tests on temporary SQLite DB, then delivery failure/partial success/restart/overlap tests. Enable scheduler only after recovery and permission/cooldown checks pass. No exactly-once claim; use bounded at-least-once retries with deduplication and explicit ambiguity handling.
