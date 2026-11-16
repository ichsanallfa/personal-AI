# Proactive Reliability — R13 Final Report

## Round Context

R12 proved that `server.closeAllConnections()` destroys TCP sockets but does **not** cancel or await async Express handler Promises.  A `POST /api/chat` handler performing a SQLite write can still be mid-transaction when `closeDatabase()` runs, causing data loss or `SQLITE_MISUSE`.

R13 adds **HTTP async handler lifecycle tracking** so that `setupGracefulShutdown()` can wait for handler Promises to settle before closing the database.

---

## Root Cause (R12 Finding)

```
closeAllConnections()  →  socket destroyed  →  res.writableFinished = true
                        BUT handler async body still running
                        →  closeDatabase() called while handler writes to SQLite
```

Socket-level events (`close`, `finish`) are **not proxies** for handler completion.  Express 5's `Layer.prototype.handleRequest` captures the Promise returned by async handlers and calls `next(error)` on rejection, but nothing tracks when that Promise *settles*.

---

## Implementation

### New file: `src/utils/httpHandlerTracker.js`

Monkey-patches `Layer.prototype.handleRequest` and `Layer.prototype.handleError` globally, **once**, before any routes are registered.

**Mechanism:**
1. On first dispatch through a Layer, the original `this.handle` function is wrapped.
2. The wrapper calls the original handler; if it returns a thenable, a tracked derivative Promise is added to a module-level `Set`.
3. The tracked Promise is removed from the Set in `.finally()`, regardless of fulfillment or rejection.
4. Wrapping is idempotent via `fn.__lucyTracked` flag.

**Exports:**
| Export | Purpose |
|---|---|
| `initHttpHandlerTracking()` | Patch Layer.prototype (idempotent) |
| `getActiveHandlersCount()` | Current in-flight handler count |
| `waitForActiveHandlers(timeoutMs)` | Poll-wait until Set is empty or timeout; returns `boolean` |
| `resetHandlerTrackingForTests()` | Clear the Set for test isolation |

### Modified: `src/app.js`

```js
import { initHttpHandlerTracking } from "./utils/httpHandlerTracker.js";
initHttpHandlerTracking();
```

Called **before** route imports so every Layer is patched at dispatch time.

### Modified: `src/server.js` — `setupGracefulShutdown()`

Shutdown order (9 steps):

| Step | Action | Timeout |
|---|---|---|
| 1 | `closeHttpServer()` — stop accepting, force-close sockets | `socketTimeoutMs` (default 10s) |
| 2 | `waitForActiveHandlers()` — await handler Promises | `handlerTimeoutMs` (default 30s) |
| 3 | `reminderService.stopScheduler()` | — |
| 4–5 | `proactiveThoughtService.stopScheduler()` + `drain()` | — |
| 6 | `vtubeService.disconnect()` | — |
| 7 | `stopDiscordBot()` | — |
| 8 | `stopTelegramBot()` | — |
| 9 | `closeDatabase()` — **only if** `allHandlersSettled && getActiveHandlersCount() === 0` | — |

If handler timeout expires with handlers still active → SQLite connection is **kept open** with a warning log, and process exits with code 1.

---

## Coverage: Why All Database-Using Routes Are Covered

The patch targets `Layer.prototype` — the single dispatch point for **every** Express route and middleware.  No per-route registration needed.  Any async handler (chat, memory, proactive, osu, auth, etc.) that returns a Promise is automatically tracked.

---

## Handler Tracking After Client Disconnect

When `closeAllConnections()` destroys a socket:
- `res.writableFinished` becomes `true`
- `res.destroyed` becomes `true`
- **But** the tracked Promise in the `Set` remains until the handler's async body settles (resolves or rejects)

The tracker is **Promise-based, not socket-based**.  Client disconnection has no effect on tracking.

---

## Timeout Policy

| Parameter | Default | Scope |
|---|---|---|
| `socketTimeoutMs` | 10 000 ms | Max wait for `server.close()` callback; after timeout, `closeAllConnections()` fires |
| `handlerTimeoutMs` | 30 000 ms | Max wait for tracked handler Promises to settle |

The handler timeout is intentionally longer than the socket timeout: sockets are killed first (step 1), then handler Promises are given additional time to finish database work (step 2).

---

## Remaining Limitation

A permanently stuck handler Promise (infinite loop, deadlock) will:
- Prevent `closeDatabase()` from running
- Cause process exit with code 1
- Rely on the OS to reclaim resources

This is a deliberate safety choice: corrupting SQLite is worse than a dirty exit.

---

## Test Results

```
▶ Proactive Outbox (SQLite-backed) … 27 pass
▶ ProactiveThoughtService …          19 pass
▶ AI Service …                       16 pass
▶ Memory Service …                    8 pass
▶ Memory Initialization …             7 pass
▶ SQLite Storage …                    3 pass
▶ HTTP Graceful Shutdown …            3 pass
▶ R10 Concurrency Verification …      2 pass
▶ R12 Shutdown Timeout Audit …        1 pass
▶ HTTP Handler Lifecycle (R13) …      6 pass
──────────────────────────────────────────
Total:  91 pass   0 fail   exit code 0
Duration: ~10s
```

### R13 Test Descriptions (`test/httpHandlerLifecycle.test.js`)

| Test | Proves |
|---|---|
| R13-A: long async write completes | Handler tracked through full async body despite socket kill |
| R13-B: client disconnect mid-handler | Tracking survives `req.destroy()` |
| R13-C: handler throws error | Rejected Promise still tracked until settled |
| R13-D: concurrent handlers | Multiple simultaneous handlers all tracked |
| R13-E: socket timeout fires first | `waitForActiveHandlers` blocks until handler settles after socket timeout |
| R13-F: sync route | Sync (non-Promise) handlers do not pollute tracking Set |

---

## Git Status

**Modified (12 files, +792 −165):**

| File | Change |
|---|---|
| `package.json` | better-sqlite3 dependency |
| `src/app.js` | +`initHttpHandlerTracking()` call |
| `src/controllers/proactive.controller.js` | Use service DI |
| `src/server.js` | Shutdown rewrite (9-step, handler tracking) |
| `src/services/ai/aiService.js` | Minor refactor |
| `src/services/ai/proactiveThoughtService.js` | Full lifecycle (`drain`, `isShuttingDown`, `schedulerTaskPromise`) |
| `src/services/memory/memoryService.js` | SQLite migration |
| `src/storage/jsonStorage.js` | Minor |
| `src/storage/sqliteStorage.js` | `closeDatabase()` export |
| `test/ai.test.js` | +16 tests |
| `test/proactive.test.js` | +19 tests |
| `test/sqliteStorage.test.js` | +1 test |

**New (untracked):**

| File | Purpose |
|---|---|
| `src/services/ai/proactiveOutbox.js` | SQLite outbox with migration hardening |
| `src/utils/httpHandlerTracker.js` | Layer.prototype handler tracking |
| `test/helpers/multiProcessWorker.js` | Child process test worker |
| `test/helpers/r10Worker.js` | Barrier-synchronized concurrency worker |
| `test/httpGracefulShutdown.test.js` | HTTP shutdown order tests |
| `test/httpHandlerLifecycle.test.js` | R13 handler lifecycle tests |
| `test/memoryInitialization.test.js` | Memory init tests |
| `test/proactiveOutbox.test.js` | Outbox unit + concurrency tests |
| `test/r10ConcurrencyVerification.test.js` | Real OS-level concurrency tests |
| `test/r12ShutdownTimeoutAudit.test.js` | Socket ≠ handler proof |
| `docs/lucy-development/` | All round reports |

---

## Conclusion

R13 closes the final gap in the shutdown lifecycle. The system now tracks the **actual async execution** of every Express handler, independent of socket state, and gates SQLite closure on handler completion.  The proactive reliability implementation (Task 01B-3B) is complete pending review.
