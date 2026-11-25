# Lucy Personal AI — Master Project Context

**Snapshot:** 2026-11-25
**Purpose:** Durable handoff for future AI sessions.
**Authority:** Explicit owner decisions govern acceptance and architecture. Current source governs current implementation. Prior reports provide historical evidence only.
**Evidence limits:** Complete old chat transcripts and every historical test log were not available for independent reconstruction. No claim of 100% historical completeness.

This is a concise handoff, not a substitute for detailed specifications. Source and tests determine current implementation; owner decisions determine acceptance; detailed designs govern target behavior.

## 1. Project Identity and Vision

Lucy is intended to grow into a Hybrid Cognitive System with persistent identity, source-aware memory, context retrieval, reasoning proposals, curiosity, goals, decisions, learning, reflection, controlled runtime, evaluation, privacy, and safe improvement proposals. These are targets, not current capability claims. Proactive messaging does not prove cognition or subjective experience.

## 2. Accepted Hybrid Cognitive Principles

**LLM proposes; backend owns authority.** LLM interprets, reasons, and proposes. Backend owns identity/policy, context, memory, authoritative state, permissions, approval, task lifecycle, action execution, outcomes, retries, privacy, and evaluation.

LLM output never directly executes privileged actions or mutates authoritative state without backend validation. Decision Engine remains separate from Action Executor. Role authorization differs from human approval. Proactive Outbox is delivery infrastructure, not a universal task engine. Observability uses structured metadata and evidence references, not private chain-of-thought by default.

Architecture remains lightweight modular monolith. Do not add microservices, Redis, PostgreSQL, Kafka, or vector database without concrete evidence and owner approval.

## 3. Stack and Constraints

- Windows 10; Intel i5-3470; 12 GB RAM; no discrete GPU.
- Heavy inference uses external providers; local backend stays lightweight.
- Node.js, Express 5, ESM, React, Vite, SQLite, `better-sqlite3`, legacy JSON compatibility.
- OpenRouter, Gemini, OpenAI, Mock providers.
- Bounded event/scheduled work, concurrency, context, and API cost.
- SQLite remains primary storage.

## 4. Evidence Labels

- **IMPLEMENTED:** code exists.
- **CURRENTLY VERIFIED:** current source or current test run confirms behavior.
- **HISTORICAL REPORT / HISTORICAL TEST RESULT:** prior evidence; not a current run.
- **OWNER ACCEPTED:** explicit owner status supplied in project context.
- **INDEPENDENTLY REVIEWED:** reviewer status supplied in project context.
- **PROPOSED:** design only.
- **DEFERRED:** intentionally postponed.
- **NOT STARTED:** no work performed.
- **UNKNOWN / REQUIRES VERIFICATION:** evidence unavailable.

These labels are independent. Implementation does not imply current verification or owner acceptance.

## 5. Phase 0 — Foundation Stabilization

### Task 01B-1 — SQLite persistence

**Status: OWNER ACCEPTED. Implementation historically reported; relevant source paths inspected in prior audits.**

SQLite document precedence; legacy JSON imports only when document absent; defaults only if both absent; insert-only/idempotent initialization; invalid JSON does not replace existing SQLite data; failed initialization can retry.

Source/test references: `backend/src/storage/sqliteStorage.js`, `backend/src/storage/jsonStorage.js`, `backend/src/services/memory/memoryService.js`, `backend/test/memoryInitialization.test.js`.

Historical milestone: 18 tests reported. Not a current test run.

### Task 01B-2 — Core memory integration

**Status: OWNER ACCEPTED. Implementation historically reported; source/tests inspected in prior audits.**

Core facts enter prompt; facts are string-filtered, trimmed, deduplicated, capped at 20; policy remains higher priority; memory is read per reply.

Source/tests: `backend/src/services/ai/aiService.js`, `backend/test/ai.test.js`.

Historical milestone: 24 tests reported. Not additive to later counts and not a current test run.

### Task 01B-3A — Proactive reliability audit/design

**Status: OWNER ACCEPTED. Design accepted.**

Design covers SQLite state, channel outbox, stable IDs/deduplication, atomic claims, leases, bounded retry/backoff, short transactions, network calls outside transactions, policy revalidation, Telegram/Discord.

### Task 01B-3B — Proactive reliability implementation

**Status: OWNER ACCEPTED. Implementation reported and covered by historical verification; not freshly re-audited in this document task.**

Relevant source: `backend/src/services/ai/proactiveThoughtService.js`, `backend/src/services/ai/proactiveOutbox.js`, `backend/src/utils/httpHandlerTracker.js`, `backend/src/server.js`, `backend/src/app.js`.

Implementation reported: durable proactive state/outbox, counter idempotency, atomic claims/lease recovery, Express handler tracking, HTTP close before handler wait, background drain, conditional database close, fail-safe shutdown.

R13–R14E history: R13 added handler tracking after socket-close timeout was shown not to stop async handlers. R14A requested authoritative evidence. R14B fixed thenable tracking and wait-failure handling. R14C found unsafe null exception formatting. R14D corrected arbitrary thrown-value formatting. R14E was reported as final evidence run.

**Historical R14E test result:**

```text
tests 96
pass 96
fail 0
NODE_EXIT_CODE=0
```

Not executed during this document reconciliation.

**Multi-process evidence:** `docs/lucy-development/PROACTIVE_RELIABILITY_R10_VERIFICATION.md` and `backend/test/r10ConcurrencyVerification.test.js` describe forked child processes, barriers, and a physical SQLite file. Reported R10 tests cover OS-level migration concurrency and counter atomicity. Not rerun here.

Revision reconciliation:

- R9 describes earlier limits of mock/two-connection tests; R10 later adds OS-process tests.
- R11's server-close callback was not sufficient proof of handler Promise settlement; R12 demonstrated the gap and R13 added handler tracking.
- R13 and R14 docs contain revision-specific counts. R14 doc reports 91; later R14 amendments/reporting give 96. These are historical milestones, not additive.
- R14A–R14E amendments were supplied in conversation context; no standalone R14A–R14E files were found under inspected `docs/`.

Phase 0 deferred: TTS authentication; Osu allowed-root/path validation; distributed rate limiting; durable web notification; backup/restore; provider delivery reconciliation.

## 6. Phase 1 — Step 1: Existing Architecture Audit

**Status: OWNER ACCEPTED.**

Actual paths identified in prior source audits:

- `backend/src/app.js` — Express middleware/routes.
- `backend/src/services/ai/aiService.js` — provider selection and prompt/reply orchestration.
- `backend/src/services/memory/memoryService.js` — core/user/temp memory and memory operations.
- `backend/src/services/memory/chatHistoryService.js` — actual chat-history path; it is not under `services/ai/`.
- `backend/src/services/ai/proactiveThoughtService.js` — proactive eligibility, generation, dispatch, scheduler/drain.
- `backend/src/services/ai/proactiveOutbox.js` — SQLite proactive state and channel dispatch.
- `backend/src/storage/sqliteStorage.js` — SQLite/WAL/document transactions.
- `backend/src/storage/jsonStorage.js` — JSON compatibility adapter.
- `backend/src/server.js` — startup, shutdown, handler wait, service drain, conditional DB close.

Existing service names and integrations are not evidence of complete cognition. Current source must be checked before implementation.

## 7. Phase 1 — Step 2: Gap Analysis R1–R4

**Status: OWNER ACCEPTED.**

Domains: A Identity & Personality; B Memory; C Context; D Reasoning/Cognitive Core; E Curiosity; F Goals; G Decision/Learning; H Reflection; I Autonomous Runtime; J Self-Improvement; K Cognitive Evaluation/Observability.

Domain K1–K8: cognitive trace; retrieval evaluation; reasoning evaluation; decision evaluation; behavioral consistency; cognitive regression; evaluation integrity; privacy/data governance.

Accepted distinctions:

- Role authorization ≠ human review/approval.
- Shared prompt ≠ measured behavioral consistency.
- Basic retrieval ≠ relevance-ranked historical retrieval.
- Memory update/delete primitives or LLM proposals ≠ deterministic conflict resolution.
- Self-themed messages ≠ reflection.
- Application logs ≠ structured cognitive traces.
- Action execution success ≠ decision outcome success.
- Provenance, verification, uncertainty, and confidence differ.
- LLM-generated confidence is not calibrated truth.
- Prefer metadata/evidence references over private chain-of-thought.

Reported gaps: semantic retrieval, provenance/verification, deterministic supersession, structured reasoning state, curiosity, goals, general decision learning, reflection, general task lifecycle, human approval, cognitive evaluation, controlled self-improvement.

## 8. Phase 1 — Step 3: Target Architecture

**Status: OWNER ACCEPTED.**

Accepted target: lightweight modular monolith with Interaction, Identity/Policy, Memory/Retrieval, Context Assembler, Cognitive Orchestrator, provider adapters, Curiosity, Goal Manager, Decision Engine, Approval Manager, Action Executor, Outcome Evaluator, Learning Manager, Reflection Manager, Runtime Manager, Evaluation/Observability, SQLite persistence.

Boundaries: memory hides storage details; decision does not execute; approval differs from role authorization; outbox remains delivery-focused; evaluation is privacy-aware. No additional infrastructure without evidence and owner approval.

## 9. Phase 1 — Step 4: Memory & Database Design

**Status: OWNER ACCEPTED, R1–R4.4. Design only; normalized schema is not implemented.**

Accepted structures: `memory_records`, `memory_versions`, `memory_sources`, `memory_evidence`, `memory_relationships`.

Integrity requirements:

- Every PK and composite-FK component is explicitly `NOT NULL`.
- Owner-scoped composite keys/FKs prevent cross-owner references.
- `current_version_id` is `NOT NULL` and points to same-owner version using deferred composite FK.
- `PRAGMA foreign_keys = ON` is configured and verified on every connection.
- Versions are immutable through one authoritative repository boundary.
- `memory_versions` owns canonical version content; `memory_records` is current projection.
- Snapshot/version updates are atomic, equality-checked with null-safe comparison, and reject stale pointers.
- Lifecycle (`active`, `disputed`, `deleted`) is separate from verification (`unverified`, `user_confirmed`, `externally_verified`).
- Provenance, factual validity, retention, deletion request, logical lifecycle, authorization, and physical erasure are distinct.
- `deletion_requested_at` records request/pending state; `status='deleted'` iff `deleted_at IS NOT NULL` describes logical lifecycle only. Neither field authorizes deletion/propagation or proves physical erasure.
- D-14 privacy-deletion exception and scope remain `PROPOSED — PENDING OWNER ACCEPTANCE`. Ordinary retention policy approval does not authorize mutating canonical historical `memory_versions`. An exception strictly requires explicit owner acceptance of D-14 or a direct amendment to accepted R4.4 invariants. Backup/media erasure and physical sanitization remain deferred or require verification.
- Migration authority is explicit per phase; parity, rollback, and no-silent-divergence are required.

Deferred: append-only validity-correction events; FTS5 support/retrieval strategy; backup/restore; historical evidence deletion; migration checkpoint tooling; goal-memory integration. No additional schema decisions are inferred here.

## 10. Phase 1 — Step 5: Cognitive Pipeline & Runtime

**Status: OWNER ACCEPTED — R6.** Project owner explicitly approved Phase 1 Step 5 on 2026-11-16. Step 6 Cycle 19 revision is drafted and PENDING INDEPENDENT REVIEW; it remains NOT YET OWNER-ACCEPTED. Implementation remains NOT STARTED.

R6 separates paths:

Simple conversation:

```text
Input → Identity/Policy → Bounded Context → Basic Memory Retrieval → LLM Response → Delivery
```

Cognitive operation:

```text
Input/Event → Identity/Policy → Context → Memory → Reasoning → Proposal → Backend Validation → Decision → Approval if required → Authorized Action → Outcome → Reflection/Learning Candidate
```

Memory mutation remains a separate LLM-proposal/backend-validation path. Proactive work remains a separate schedule/event-driven workflow.

### Operation, approval, action

Operation lifecycle:

```text
created, queued, running, awaiting_approval, completed, failed, cancelled, expired
```

Approval lifecycle:

```text
not_required, pending, approved, rejected, expired, cancelled
```

Rejection cancels operation with `approval_rejected`; expiry terminates it with `approval_expired`. Resume revalidates owner, permissions, proposal, resource state, and approval expiry.

Action lifecycle:

```text
prepared, authorized, running, succeeded, failed, unknown, cancelled
```

Action reconciliation:

```text
not_required, pending, resolved_succeeded, resolved_failed, unresolved
```

Action attempts have separate IDs/results; running attempt has no final result; restart does not imply failure. Unknown non-idempotent action is not automatically retried. Reconciliation does not execute an action. Retry requires safety evidence, remaining bounded retry budget, and authorization revalidation.

### Logical message, target, dispatch, attempt

These are distinct from reminder occurrence, cognitive operation, goal, and action.

- One logical message can have multiple delivery targets.
- Each target has stable non-null `target_id`, owner, channel, immutable required/optional policy, eligibility decision/time, and optional `target_key`.
- Eligibility: `eligible`, `suppressed`, `not_configured`, `cancelled_before_dispatch`.
- Only eligible target creates one dispatch.
- Owner-aware composite keys/FKs link message → target → dispatch → attempt.
- Dispatch lifecycle: `queued`, `sending`, `retry_wait`, `accepted`, `failed`, `unknown`, `cancelled`.
- Delivery attempt result: `accepted`, `confirmed_failure`, `unknown`.
- Step 6 proposed outcome model separates Attempt Result, Attempt Evidence, Effective External Outcome (`not_started`, `accepted`, `confirmed_failure`, `unknown`), and Effective Target Delivery State (`pending`, `accepted`, `failed`, `unknown`, `suppressed`, `cancelled`, `not_deliverable`). `not_started` describes the factual absence of committed invocation permits AND actual adapter/transport/network/provider effects under proposition-specific evidence evaluation (strictly requiring no permit ever committed and no adapter invocation, transport handoff, actual transmission, network activity, or provider response). A missing marker with adapter, transport, or provider evidence is a protocol-integrity anomaly that defaults to `unknown` (fails closed) and preserves immutable audit evidence. Re-authorization following an anomaly requires protocol-integrity containment under explicit owner policy and strictly follows two canonical branches: (1) Branch A (non-execution), requiring permit `NONE`/`RESOLVED`, external outcome `confirmed_failure` covering all potential submissions across all paths, and all guards; or (2) Branch B (verified idempotent replay), requiring Replay Overlap Safety for the exact same logical operation and stable provider key (deduplication contract covering all concurrent, delayed, paused/resumed, and late-arriving requests across the entire overlap window), while old permits remain factually `POSSIBLY_EXERCISABLE` and external outcome remains `unknown` (replay is duplicate-safe, not proof of prior non-execution). Authorization-path safety is a deterministic derived predicate separating pre-marker path (`OPEN`, `CLOSED`, `UNCERTAIN` where `CLOSED` includes never-claimed dispatches and unclaimed `retry_wait`, allowing fresh claim creation under normal policy without conflating old-path status with authorization grants) from committed permit exercise (`NONE`, `POSSIBLY_EXERCISABLE`, `RESOLVED` where `RESOLVED` reflects process termination/boundary, not external effect). Fencing an old claim generation revokes database write authority but cannot revoke an already-committed permit from a paused process. Ambiguous marker/fencing transactions require serialized recovery under `BEGIN IMMEDIATE`. Pre-marker active claims keep targets `pending` without falsely proving authorization paths closed to replacements; confirmed marker-absent `UNCERTAIN` states remain in recovery hold `pending` even after deadline expiry without authorizing new work. Generational fencing is mandatory before re-authorization or takeover. These are design requirements only; details are in `docs/architecture/LUCY_FINAL_SPECIFICATION.md` Sections 8.1–8.3.2.
- Message aggregate consumes only normalized Effective Target Delivery State. A confirmed failed attempt with safe retry active remains target `pending`; acceptance in one verified replay group cannot hide an unresolved independent group.
- HTTP/SDK automatic retries are not assumed; Cycle 14 design requires one finite global retransmission budget per backend attempt, durable atomic reservations, and verified idempotency through possible late-arrival windows. Provider key retention/cancellation capabilities remain unknown; no exactly-once or exact physical transmission count guarantee.
- Delivery reconciliation: `not_required`, `pending`, `resolved_accepted`, `resolved_failed`, `unresolved`.
- Delivery reconciliation terminology is intentionally distinct from action reconciliation.
- Aggregate message status is derived/rebuildable from targets and dispatches; required/optional outcomes remain separately visible.
- External delivery is not exactly-once without provider support. Unknown non-idempotent effects are not automatically retried. Provider acceptance does not prove user read.

### Projections and reminders

Outbox/message state is delivery authority. Chat history and in-app notifications are projections reconciled by stable message ID. Current in-app notifications are process-memory only, per prior source audit.

Reminder occurrence states: `scheduled`, `due`, `handoff_pending`, `handed_off`, `cancelled`, `handoff_failed`. One-time identity derives from reminder ID; recurring identity uses deterministic scheduled occurrence key. `handed_off` means durable outbox intent exists, not provider acceptance or user acknowledgement. Outbox owns delivery retry afterward.

Current source limitation, from inspected historical audit: `backend/src/services/reminder/reminderService.js` removes due reminders before asynchronous dispatch; delivery failure may lose a reminder. Durable handoff is proposed, not implemented.

### Proactive/runtime and evaluation

Proactive scheduler/outbox remains delivery-specific. Runtime design uses bounded concurrency, resource-scoped coordination, short SQLite transactions, and network calls outside transactions. Restart recovery revalidates authorization and reconciles ambiguous results.

Observability stores structured metadata/evidence references, not private chain-of-thought.

### Unresolved automatic messaging issue

Owner reported an unresolved automatic messaging problem. Exact symptom/reproduction is **UNKNOWN / REQUIRES OWNER CONFIRMATION**. Diagnostic scope: generation, eligibility, timing/frequency, duplication, channel delivery, history projection, in-app notification, reminder handoff, restart recovery. No fix or root cause is claimed.

## 11. Cross-Phase Decision Register

- SQLite remains primary; JSON is compatibility, not post-cutover authority.
- Keep lightweight modular monolith.
- LLM proposes; backend validates and owns state/actions.
- Decision and execution remain separate.
- Authorization and human approval remain separate.
- Proactive Outbox is not the universal task engine.
- Simple chat does not run full cognitive pipeline by default.
- No exactly-once external delivery claim without provider support.
- No private chain-of-thought persistence by default.
- No Step 6 or implementation without explicit owner approval.

### Step 6 Cycle 19 status (2026-11-25)

`docs/architecture/LUCY_FINAL_SPECIFICATION.md` contains Cycle 19 draft resolutions:
- Normative scope clarification: Section 1.3 explicitly distinguishes internal normative blueprint consistency from owner acceptance of D-12–D-15 and Phase 2 implementation authorization.
- Finding C19-IR-P1-01: Replay normalization and target state decouple external-effect resolution from protocol-integrity disposition; an unresolved integrity anomaly does not force external outcome to `unknown` if all external submissions are conclusively accounted for.
- Finding C19-IR-P1-02: `not_started` strictly requires no relevant backend invocation permit was ever successfully committed, complete reliable history, and no adapter invocation, transport handoff, actual transmission, network activity, or provider response. Process termination or permit `RESOLVED` does not establish `not_started`.
- Finding C19-IR-P1-03: Two-branch Re-Authorization Guard explicitly documented: Branch A (proven non-execution, permit `NONE`/`RESOLVED`, outcome `confirmed_failure`, integrity contained) and Branch B (verified idempotent replay for exact same logical operation/key, permit remains `POSSIBLY_EXERCISABLE`, outcome remains `unknown`, integrity contained).
- Finding C19-IR-P1-04: Protocol-Integrity Operational Containment Standard formalized with 8 deterministic criteria (root cause + verified mitigation OR verified path isolation/fencing; all old holders accounted for; Branch B requires mapping all requests to same operation under owner policy; fails closed absent explicit policy).
- Finding C19-IR-P2-01: Pre-Marker UNCERTAIN recovery hold precedence over deadline and cancellation formalized (Cases A, B, C); target held `pending` without authorizing new work; hold does not extend deadline; once path becomes `CLOSED`, deadline expiry transitions to `failed` (`delivery_deadline_expired`).
- Finding C19-IR-P2-02: Authoritative reference pseudocode made 1-to-1 equivalent to 11-step normative algorithm.
- Finding C19-IR-P2-03: Normative language explicitly bounded to proposed blueprint consistency.
- Review traceability in Section 15.1 retains historical Cycle 14–18 dispositions and marks Cycle 19 findings (C19-IR-P1-01 through C19-IR-P2-03) as `ADDRESSED IN CYCLE 19 DRAFT — PENDING INDEPENDENT REVIEW`. Section 4.6 relabeled as historical snapshot.
- Append-only memory invariants preserved: ordinary retention policy approval cannot bypass R4.4 append-only history or D-14 owner acceptance.

Status: **PHASE 1 STEP 6 — REVISION DRAFTED — PENDING INDEPENDENT REVIEW**. This is not review approval or owner acceptance.

Remaining verification limits: Telegram/Discord provider idempotency/key retention through late arrival, `Retry-After`, downstream status, cancellation/lookup, actual HTTP/SDK/transport hidden retry behavior; selected SQLite reservation and sanitization behavior; backup restore filtering. No maximum network delay or physical-erasure guarantee is assumed. WP4 checklist requires future verification. D-01–D-11 remain owner accepted; D-12–D-15 remain `PROPOSED — PENDING OWNER ACCEPTANCE`. D-14 is not accepted. Step 5 R6 remains owner accepted. Phase 2 remains **NOT STARTED — NO IMPLEMENTATION AUTHORIZATION**. No source changes or tests were part of Cycle 19.

## 12. Implementation Versus Design Ledger

| Capability | Status | Evidence boundary |
|---|---|---|
| SQLite document persistence / legacy fallback | IMPLEMENTED; OWNER ACCEPTED; historical tests | Source references in Section 5; no current test run here |
| Core facts in prompt | IMPLEMENTED; OWNER ACCEPTED; historical tests | `aiService.js`, `ai.test.js`; no current test run here |
| Proactive state/outbox | IMPLEMENTED; OWNER ACCEPTED; historical reports | Source/test evidence exists; not re-audited in this documentation reconciliation |
| Multi-process claims/migration/counter tests | HISTORICAL TEST EVIDENCE | `backend/test/r10ConcurrencyVerification.test.js`, `PROACTIVE_RELIABILITY_R10_VERIFICATION.md`; not rerun here |
| Handler tracking/shutdown | IMPLEMENTED; OWNER ACCEPTED; historically verified | Prior R13–R14 reports/source; no current test run here |
| Normalized memory structures | PROPOSED; OWNER ACCEPTED as design | Not implemented; no schema/migration authorized |
| Cognitive Orchestrator/reasoning state | PROPOSED; NOT STARTED | Step 5 design only |
| Goals, curiosity, reflection, learning managers | PROPOSED; NOT STARTED | No complete current implementation established |
| Consequential action approval workflow | PROPOSED; NOT STARTED | Role authorization exists; dedicated approval lifecycle absent in prior audit |
| Logical message/target/attempt runtime model | PROPOSED; OWNER ACCEPTED as Step 5 R6 design | Not implemented by design approval |
| Durable reminder handoff | PROPOSED; NOT STARTED | Current remove-before-dispatch behavior remains a limitation |
| Cognitive evaluation/trace subsystem | PROPOSED; NOT STARTED | No structured subsystem established |
| R14E regression result | HISTORICAL TEST RESULT | 96 pass, 0 fail, exit 0; no current execution here |

## 13. Owner Acceptance Matrix

| Work | Exact status |
|---|---|
| Phase 0 — Task 01B | OWNER ACCEPTED |
| Phase 1 — Step 1 | OWNER ACCEPTED |
| Phase 1 — Step 2 R1–R4 | OWNER ACCEPTED |
| Phase 1 — Step 3 | OWNER ACCEPTED |
| Phase 1 — Step 4 R1–R4.4 | OWNER ACCEPTED |
| Phase 1 — Step 5 R6 | OWNER ACCEPTED — R6 |
| Phase 1 — Step 6 | REVISION DRAFTED — PENDING INDEPENDENT REVIEW — NOT YET OWNER-ACCEPTED |
| Phase 2 — Implementation | NOT STARTED |

These are owner statuses supplied in the project task context. This document does not grant or infer acceptance.

## 14. Known Unresolved Problems

1. Automatic messaging issue: symptom/reproduction unknown; not claimed solved.
2. Reminder scheduler removes due reminders before async dispatch; failure may lose reminder.
3. Proactive history is currently appended before channel acceptance in inspected source; target design calls for delivery-aware projection and reconciliation.
4. In-app notification persistence is process-local and not restart-durable in current source as reported/previously inspected.
5. External delivery ambiguity remains; no exactly-once guarantee.
6. Current source has no complete semantic retrieval, cognitive state, general goal lifecycle, approval workflow, reflection engine, or cognitive evaluation subsystem.

## 15. Deferred Technical Debt

- TTS authentication review.
- Osu allowed-root/path validation.
- Distributed rate limiting.
- Durable web notifications.
- Append-only validity-correction events.
- FTS5 availability and memory retrieval strategy.
- Backup/restore policy.
- Historical evidence deletion policy.
- Provider-specific delivery idempotency/reconciliation.
- Runtime lock implementation.
- Migration checkpoint tooling.
- Step 6 independent review and owner acceptance; current Cycle 19 status and blockers are recorded above and in `docs/architecture/LUCY_FINAL_SPECIFICATION.md` Sections 15–16.

Do not silently expand scope or treat deferred work as resolved.

## 16. Current Project Status

- Phase 0 Task 01B: OWNER ACCEPTED.
- Phase 1 Steps 1–4: OWNER ACCEPTED.
- Phase 1 Step 5 R6: OWNER ACCEPTED — R6 (approved 2026-11-16).
- Step 6 final specification: REVISION DRAFTED — PENDING INDEPENDENT REVIEW — NOT YET OWNER-ACCEPTED.
- Phase 2 implementation: NOT STARTED.
- Latest supplied regression result: historical 96 pass, 0 fail, exit 0. No current test run is asserted.

## 17. Next Authorized Task

Step 5 R6 is owner accepted. Step 6 Cycle 19 revision is drafted, pending independent review, and remains NOT YET OWNER-ACCEPTED. Phase 2 implementation remains NOT STARTED and requires separate owner authorization.

## 18. Future AI Session Handoff

When starting a new AI session for Lucy Personal AI:

1. Read `docs/architecture/LUCY_PROJECT_MASTER_CONTEXT.md` first.
2. Read relevant detailed design references in Section 20.
3. Inspect current Git status before modifying anything.
4. Verify actual source before implementation; do not assume historical reports remain current.
5. Respect owner-accepted decisions.
6. Avoid repeating completed work unnecessarily.
7. Do not start a later step without owner approval.
8. Keep planning/design separate from implementation.
9. Never reset, clean, or discard user changes without permission.
10. Report uncertainty rather than inventing context.

## 19. Context Limitations and Verification Requirements

Complete historical transcripts and all test logs were not independently re-read. The owner-acceptance matrix is supplied project status, not independently reconstructed approval evidence. Historical test results are not current runs. Inspect current source and rerun relevant tests before implementation.

Detailed Step 1 and Phase 0 reports were inspected. No standalone Step 2–5 design files were found under inspected `docs/`; those accepted designs are summarized from supplied conversation context. The detailed index is limited to discovered/inspected files and does not prove no records exist elsewhere.

## 20. Detailed Design Document Index

Authority key:

- **Supporting design/evidence:** inspected reference; acceptance remains separate.
- **Historical/superseded:** records prior state; later evidence/design controls within its scope.
- **No separate file found:** design supplied in conversation context, no standalone file verified under inspected `docs/`.

### Phase 0 — Task 01B

| Work | Document title | Exact path | Revision | Authority status |
|---|---|---|---|---|
| 01B-3A | Lucy Proactive Reliability Audit & Design | `docs/lucy-development/PROACTIVE_RELIABILITY_AUDIT.md` | Not stated | Supporting design; owner acceptance supplied separately |
| 01B-3B | Proactive Reliability Implementation (Task 01B-3B) | `docs/lucy-development/PROACTIVE_RELIABILITY_IMPLEMENTATION.md` | Implementation report | Supporting historical implementation report; source is current implementation authority |
| 01B-3B | Proactive Reliability — R7 Final Hardening Report | `docs/lucy-development/PROACTIVE_RELIABILITY_R7_FINAL.md` | R7 | Historical implementation/test report |
| 01B-3B | Proactive Reliability — R9 Concurrency & Shutdown Verification | `docs/lucy-development/PROACTIVE_RELIABILITY_R9_VERIFICATION.md` | R9 | Historical; its stated two-connection/mock test limits are superseded by R10 evidence where covered |
| 01B-3B | Proactive Reliability — R10 Final Concurrency & Shutdown Verification | `docs/lucy-development/PROACTIVE_RELIABILITY_R10_VERIFICATION.md` | R10 | Supporting historical test evidence for OS-process tests; not rerun here |
| 01B-3B | Proactive Reliability — R11 HTTP Graceful Shutdown Final Report | `docs/lucy-development/PROACTIVE_RELIABILITY_R11_FINAL.md` | R11 | Historical; shutdown-order improvement, but request-close callback alone does not establish handler-Promise settlement |
| 01B-3B | Proactive Reliability — R12 Shutdown Timeout Audit | `docs/lucy-development/PROACTIVE_RELIABILITY_R12_VERIFICATION.md` | R12 | Historical audit of socket-close/handler gap |
| 01B-3B | Proactive Reliability — R13 Final Report | `docs/lucy-development/PROACTIVE_RELIABILITY_R13_FINAL.md` | R13 | Historical; superseded by later thenable/shutdown exception amendments |
| 01B-3B | Proactive Reliability — R14 Read-Only Verification | `docs/lucy-development/PROACTIVE_RELIABILITY_R14_VERIFICATION.md` | R14 | Historical report, 91 tests; predates R14A–R14E corrections, not final post-fix evidence |
| 01B-1/2 | Separate detailed final reports | — | — | No separate authoritative file found; historical milestone counts are conversation/report claims |

### Phase 1 — Step 1

| Step | Document title | Exact path | Revision | Authority status |
|---|---|---|---|---|
| Step 1 | Lucy Existing Architecture Audit | `docs/lucy-development/LUCY_EXISTING_ARCHITECTURE.md` | Not stated | Inspected static audit; owner accepted per supplied status; source snapshot may be stale |

### Phase 1 — Step 2

| Step | Document title | Exact path | Revision | Authority status |
|---|---|---|---|---|
| Step 2 R1–R4 | Standalone detailed gap-analysis documents | — | R1–R4 amendments | No separate authoritative file found under inspected `docs/`; accepted findings are summarized in Section 7 from supplied context |

### Phase 1 — Step 3

| Step | Document title | Exact path | Revision | Authority status |
|---|---|---|---|---|
| Step 3 | Standalone target architecture document | — | Target design supplied in conversation | No separate authoritative file found under inspected `docs/`; accepted decisions summarized in Section 8 |

### Phase 1 — Step 4

| Step | Document title | Exact path | Revision | Authority status |
|---|---|---|---|---|
| Step 4 R1–R4.4 | Standalone memory/database design document | — | R4.4 designated final reviewed reference | No separate authoritative file found under inspected `docs/`; accepted rules summarized in Section 9 from supplied context |

### Phase 1 — Step 5

| Step | Document title | Exact path | Revision | Authority status |
|---|---|---|---|---|
| Step 5 R1–R6 | Standalone cognitive pipeline/runtime document | — | R6 latest design supplied in conversation | No separate authoritative file found under inspected `docs/`; R6 independently reviewed and OWNER ACCEPTED on 2026-11-16 |

No document is promoted to owner-accepted authority solely because its filename says “FINAL.” Later amendments supersede earlier versions only where they explicitly change them.
