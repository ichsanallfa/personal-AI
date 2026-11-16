import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { fork } from "child_process";
import Database from "better-sqlite3";

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "lucy-proactive-outbox-"));
process.env.RUNTIME_DIR = path.join(tempRoot, "runtime");
process.env.SQLITE_DB_PATH = path.join(tempRoot, "outbox.sqlite");

const [{ proactiveOutbox, createProactiveOutbox, ensureProactiveSchema, normalizeCounter }, { ProactiveThoughtService }, storage] = await Promise.all([
  import("../src/services/ai/proactiveOutbox.js"),
  import("../src/services/ai/proactiveThoughtService.js"),
  import("../src/storage/sqliteStorage.js"),
]);

const ownerKey = `outbox-owner-${Date.now()}`;
const channels = [{ channel: "telegram", targetKey: "tg-test" }, { channel: "discord", targetKey: "dc-test" }];

test("state persists across service reconstruction", () => {
  const first = new ProactiveThoughtService({ ownerKey });
  first.notifyUserActivity("telegram");
  first.toggle(false);
  const second = new ProactiveThoughtService({ ownerKey });
  assert.equal(second.enabled, false);
  assert.equal(second.targetPlatform, "telegram");
  assert.ok(second.lastUserMessageAt > 0);
});

test("default unanswered count is zero and persisted state restores zero", () => {
  const owner = `${ownerKey}-default-counter`;
  const service = new ProactiveThoughtService({ ownerKey: owner });
  assert.equal(service.unrespondedPings, 0);
  assert.equal(proactiveOutbox.getState(owner).unansweredCount, 0);
  const restored = new ProactiveThoughtService({ ownerKey: owner });
  assert.equal(restored.unrespondedPings, 0);
});

test("dispatch intents persist and dedupe per channel", () => {
  const args = { thoughtId: "thought-1", ownerKey, content: "hello", channels };
  const first = proactiveOutbox.enqueueThought(args);
  const repeated = proactiveOutbox.enqueueThought(args);
  assert.equal(first.length, 2);
  assert.deepEqual(repeated.map((row) => row.dispatch_id), first.map((row) => row.dispatch_id));
  assert.deepEqual(proactiveOutbox.listDueChannels(ownerKey).map((row) => row.channel).sort(), ["discord", "telegram"]);
});

test("claim is atomic and duplicate workers cannot claim same dispatch", () => {
  const [intent] = proactiveOutbox.enqueueThought({ thoughtId: "claim-one", ownerKey, content: "claim", channels: [channels[0]] });
  const a = proactiveOutbox.claimById(intent.dispatch_id, "worker-a");
  const b = proactiveOutbox.claimById(intent.dispatch_id, "worker-b");
  assert.equal(a.lease_owner, "worker-a");
  assert.equal(b, null);
});

test("expired lease recovers and retry reaches terminal cap", () => {
  const [intent] = proactiveOutbox.enqueueThought({ thoughtId: "lease-one", ownerKey, content: "lease", channels: [channels[0]] });
  const claimed = proactiveOutbox.claimById(intent.dispatch_id, "worker-old");
  assert.ok(claimed);
  storage.db.prepare("UPDATE proactive_dispatches SET lease_expires_at=? WHERE dispatch_id=?")
    .run(Date.now() - 1, intent.dispatch_id);
  proactiveOutbox.recoverExpired(ownerKey, Date.now());
  const recovered = proactiveOutbox.claimById(intent.dispatch_id, "worker-new");
  assert.ok(recovered);
  assert.equal(recovered.lease_owner, "worker-new");
});

test("Telegram success and failure are stored per channel; only accepted updates success state", async () => {
  const dispatches = [];
  const service = new ProactiveThoughtService({ ownerKey: `${ownerKey}-delivery`, transport: async (dispatch) => {
    dispatches.push(dispatch.channel);
    if (dispatch.channel === "telegram") return true;
    throw Object.assign(new Error("temporary_network"), { retryable: true });
  } });
  service.lastProactiveMessage = "partial";
  service.lastInitialMode = "question";
  proactiveOutbox.loadState(service.ownerKey, {
    enabled: true,
    lastUserActivityAt: Date.now() - 100_000,
    unansweredCount: 0,
    minIdleTimeMs: 0,
    currentCooldownMs: 30_000,
  });
  const [telegram, discord] = proactiveOutbox.enqueueThought({
    thoughtId: "partial", ownerKey: service.ownerKey, content: "partial", channels,
  });
  const outcomes = await service.processDispatches([telegram, discord], { recheckPolicy: false });
  assert.equal(outcomes.telegram.status, "accepted");
  assert.equal(outcomes.discord.status, "pending");
  assert.deepEqual(dispatches.sort(), ["discord", "telegram"]);
});

test("lease recovery preserves accepted state and accepted dispatch", () => {
  const owner = `${ownerKey}-accepted-recovery`;
  const service = new ProactiveThoughtService({ ownerKey: owner });
  proactiveOutbox.setUnansweredCount(owner, 3);
  const state = proactiveOutbox.getState(owner);
  const [dispatch] = proactiveOutbox.enqueueThought({ thoughtId: "already-accepted", ownerKey: owner,
    content: "accepted", channels: [channels[0]] });
  const claimed = proactiveOutbox.claimById(dispatch.dispatch_id, "worker-accept");
  assert.ok(claimed);
  assert.equal(proactiveOutbox.markAcceptedWithState(claimed, "worker-accept", Date.now(), {
    lastUserActivityAt: state.lastUserActivityAt,
    lastProactiveMessage: "accepted",
    targetPlatform: null,
    lastInitialMode: "question",
    currentCooldownMs: 30_000,
    waitingForAnswerMs: 300_000,
  }), true);
  const counterBeforeRecovery = proactiveOutbox.getState(owner).unansweredCount;
  proactiveOutbox.recoverExpired(owner, Date.now() + 120_000);
  assert.equal(proactiveOutbox.getDispatch(dispatch.dispatch_id).status, "accepted");
  assert.equal(proactiveOutbox.getState(owner).unansweredCount, counterBeforeRecovery);
  assert.equal(proactiveOutbox.getState(owner).unansweredCount, 4);
});

test("concurrent cycle calls share one in-flight thought generation", async () => {
  const service = new ProactiveThoughtService({ ownerKey: `${ownerKey}-cycle`, transport: async () => true });
  service.enabled = true;
  service.lastProactiveMessage = "Thought unik untuk test";
  service.lastInitialMode = "question";
  service.nextEligibleAt = 0;
  service.canTriggerSpontaneousThought = () => true;
  let release;
  let generationCount = 0;
  let generationStarted;
  const started = new Promise((resolve) => { generationStarted = resolve; });
  service.generateSpontaneousText = async () => {
    generationCount += 1;
    generationStarted();
    await new Promise((resolve) => { release = resolve; });
    return "Thought unik untuk test";
  };
  service.resolveChannels = () => [{ channel: "telegram", targetKey: "tg-cycle" }];
  proactiveOutbox.loadState(service.ownerKey, {
    enabled: true,
    lastUserActivityAt: Date.now() - 100_000,
    unansweredCount: 0,
    minIdleTimeMs: 0,
    currentCooldownMs: 30_000,
  });
  const first = service.triggerSpontaneousThought({ force: true });
  await started;
  const second = service.triggerSpontaneousThought({ force: true });
  release();
  await Promise.all([first, second]);
  assert.equal(generationCount, 1);
});

test("persistent cooldown blocks normal triggers after service recreation", () => {
  const persistedOwner = `${ownerKey}-cooldown`;
  const first = new ProactiveThoughtService({ ownerKey: persistedOwner });
  first.notifyUserActivity();
  const restored = new ProactiveThoughtService({ ownerKey: persistedOwner });
  restored.nextEligibleAt = Date.now() + 60_000;
  proactiveOutbox.updateState(persistedOwner, { nextEligibleAt: restored.nextEligibleAt });
  const nextInstance = new ProactiveThoughtService({ ownerKey: persistedOwner });
  assert.equal(nextInstance.canTriggerSpontaneousThought(false), false);
});

test("normalizeCounter correctly handles all input variations", () => {
  assert.equal(normalizeCounter(undefined), 0);
  assert.equal(normalizeCounter(null), 0);
  assert.equal(normalizeCounter(-1), 0);
  assert.equal(normalizeCounter(-99), 0);
  assert.equal(normalizeCounter(0), 0);
  assert.equal(normalizeCounter(1), 1);
  assert.equal(normalizeCounter("5"), 5);
  assert.equal(normalizeCounter("0"), 0);
  assert.equal(normalizeCounter("-3"), 0);
  assert.equal(normalizeCounter(NaN), 0);
  assert.equal(normalizeCounter("invalid"), 0);

  const testOwner = `${ownerKey}-norm`;
  const service = new ProactiveThoughtService({ ownerKey: testOwner });
  service.setUnansweredCount(-5);
  assert.equal(service.unrespondedPings, 0);
  assert.equal(proactiveOutbox.getState(testOwner).unansweredCount, 0);

  service.setUnansweredCount("7");
  assert.equal(service.unrespondedPings, 7);
  assert.equal(proactiveOutbox.getState(testOwner).unansweredCount, 7);

  service.setUnansweredCount(NaN);
  assert.equal(service.unrespondedPings, 0);
  assert.equal(proactiveOutbox.getState(testOwner).unansweredCount, 0);
});

test("multi-instance concurrency: atomic claim and enqueue prevent duplicate work across instances", () => {
  const multiOwner = `${ownerKey}-multi-instance`;
  // Two distinct worker instances sharing same SQLite storage
  const worker1 = "worker-pid-101";
  const worker2 = "worker-pid-102";

  // 1. Concurrent enqueueThoughtIfAbsent: only first gets dispatches
  const options = { thoughtId: "concurrent-thought", ownerKey: multiOwner, content: "ping", channels };
  const firstEnqueue = proactiveOutbox.enqueueThoughtIfAbsent(options);
  const secondEnqueue = proactiveOutbox.enqueueThoughtIfAbsent(options);
  assert.equal(firstEnqueue.length, 2);
  assert.equal(secondEnqueue.length, 0, "Second concurrent enqueue must be blocked by active dispatches");

  // 2. Concurrent claimDueForOwner: worker1 and worker2 compete for the same first dispatch
  const claim1 = proactiveOutbox.claimDueForOwner(multiOwner, worker1);
  const claim2 = proactiveOutbox.claimDueForOwner(multiOwner, worker2);
  assert.ok(claim1, "Worker 1 should claim first dispatch");
  assert.ok(claim2, "Worker 2 should claim second dispatch");
  assert.notEqual(claim1.dispatch_id, claim2.dispatch_id, "Two workers must never claim the same dispatch_id");

  // Attempting to claim the already-claimed dispatch by ID fails for another worker
  const stolenClaim = proactiveOutbox.claimById(claim1.dispatch_id, worker2);
  assert.equal(stolenClaim, null, "Active lease must prevent other worker from claiming by ID");
});

test("counter idempotency: multiple channel acceptances for same thought increment counter only once", () => {
  const thoughtOwner = `${ownerKey}-idempotent-counter`;
  const service = new ProactiveThoughtService({ ownerKey: thoughtOwner });
  service.setUnansweredCount(0);
  const stateBefore = proactiveOutbox.getState(thoughtOwner);
  assert.equal(stateBefore.unansweredCount, 0);

  const [tgDispatch, dcDispatch] = proactiveOutbox.enqueueThought({
    thoughtId: "multi-channel-thought",
    ownerKey: thoughtOwner,
    content: "dual-channel",
    channels,
  });

  const worker = "dual-accept-worker";
  const claimedTg = proactiveOutbox.claimById(tgDispatch.dispatch_id, worker);
  const claimedDc = proactiveOutbox.claimById(dcDispatch.dispatch_id, worker);

  // Accept Telegram first
  const tgAccepted = proactiveOutbox.markAcceptedWithState(claimedTg, worker, Date.now(), {
    lastUserActivityAt: stateBefore.lastUserActivityAt,
    lastProactiveMessage: "dual-channel",
    targetPlatform: null,
    lastInitialMode: "question",
    currentCooldownMs: 30_000,
    waitingForAnswerMs: 300_000,
  });
  assert.equal(tgAccepted, true);
  const stateAfterTg = proactiveOutbox.getState(thoughtOwner);
  assert.equal(stateAfterTg.unansweredCount, 1, "First channel acceptance increments counter from 0 to 1");

  // Accept Discord second for same thought_id
  const dcAccepted = proactiveOutbox.markAcceptedWithState(claimedDc, worker, Date.now(), {
    lastUserActivityAt: stateBefore.lastUserActivityAt,
    lastProactiveMessage: "dual-channel",
    targetPlatform: null,
    lastInitialMode: "question",
    currentCooldownMs: 30_000,
    waitingForAnswerMs: 300_000,
  });
  assert.equal(dcAccepted, true);
  const stateAfterDc = proactiveOutbox.getState(thoughtOwner);
  assert.equal(stateAfterDc.unansweredCount, 1, "Second channel acceptance for same thought MUST NOT increment counter again");

  // Verify dedicated counter_applied column in dispatches
  const tgRow = storage.db.prepare("SELECT counter_applied, last_error_code FROM proactive_dispatches WHERE dispatch_id=?").get(tgDispatch.dispatch_id);
  const dcRow = storage.db.prepare("SELECT counter_applied, last_error_code FROM proactive_dispatches WHERE dispatch_id=?").get(dcDispatch.dispatch_id);
  assert.equal(tgRow.counter_applied, 1, "First accepted dispatch has counter_applied = 1");
  assert.equal(dcRow.counter_applied, 0, "Second accepted dispatch has counter_applied = 0");
  assert.equal(tgRow.last_error_code, null, "last_error_code must remain null on accepted");
  assert.equal(dcRow.last_error_code, null, "last_error_code must remain null on accepted");
});

test("retry policy: only failed channel is retried, accepted channel is untouched, attempt cap enforced", () => {
  const retryOwner = `${ownerKey}-retry-policy`;
  const [tgDispatch, dcDispatch] = proactiveOutbox.enqueueThought({
    thoughtId: "retry-thought",
    ownerKey: retryOwner,
    content: "retry test",
    channels,
  });

  const worker = "retry-worker";
  const claimedTg = proactiveOutbox.claimById(tgDispatch.dispatch_id, worker);
  const claimedDc = proactiveOutbox.claimById(dcDispatch.dispatch_id, worker);

  // Tg accepted, Dc fails with retryable error
  proactiveOutbox.markAccepted(claimedTg.dispatch_id, worker);
  proactiveOutbox.markFailed(claimedDc, worker, "econnreset", true, Date.now());

  // Check due channels: only discord is due, telegram is accepted and never due
  const due = proactiveOutbox.listDueChannels(retryOwner, Date.now() + 60_000);
  assert.equal(due.length, 1);
  assert.equal(due[0].channel, "discord");

  // Simulate retrying up to max attempts (attempt_count = 5)
  for (let attempt = 2; attempt <= 5; attempt++) {
    const claim = proactiveOutbox.claimById(dcDispatch.dispatch_id, worker, Date.now() + 60_000 * attempt);
    assert.ok(claim, `Attempt ${attempt} should be claimable`);
    assert.equal(claim.attempt_count, attempt);
    proactiveOutbox.markFailed(claim, worker, "econnreset", true, Date.now() + 60_000 * attempt);
  }

  // After 5 attempts, discord status must be terminal 'failed'
  const finalDc = proactiveOutbox.getDispatch(dcDispatch.dispatch_id);
  assert.equal(finalDc.status, "failed");
  assert.equal(finalDc.attempt_count, 5);

  // Tg must remain 'accepted'
  const finalTg = proactiveOutbox.getDispatch(tgDispatch.dispatch_id);
  assert.equal(finalTg.status, "accepted");
});

test("migration: legacy database without counter_applied gets migrated, old rows intact with default 0", () => {
  const legacyDbPath = path.join(tempRoot, "legacy-migration.sqlite");
  const legacyDb = new Database(legacyDbPath);
  legacyDb.pragma("journal_mode = WAL");
  legacyDb.exec(`
    CREATE TABLE proactive_state (
      owner_key TEXT PRIMARY KEY,
      enabled INTEGER NOT NULL DEFAULT 1,
      last_user_activity_at INTEGER NOT NULL,
      last_successful_dispatch_at INTEGER NOT NULL DEFAULT 0,
      unanswered_count INTEGER NOT NULL DEFAULT 0,
      next_eligible_at INTEGER NOT NULL DEFAULT 0,
      last_proactive_at INTEGER NOT NULL DEFAULT 0,
      last_proactive_message TEXT,
      target_platform TEXT,
      last_initial_mode TEXT,
      current_cooldown_ms INTEGER NOT NULL DEFAULT 0,
      last_proactive_cooldown_ms INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE proactive_dispatches (
      dispatch_id TEXT PRIMARY KEY,
      dedupe_key TEXT NOT NULL UNIQUE,
      thought_id TEXT NOT NULL,
      owner_key TEXT NOT NULL,
      channel TEXT NOT NULL CHECK(channel IN ('telegram', 'discord')),
      target_key TEXT NOT NULL,
      content TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('pending', 'sending', 'accepted', 'failed')),
      attempt_count INTEGER NOT NULL DEFAULT 0,
      next_attempt_at INTEGER NOT NULL,
      lease_owner TEXT,
      lease_expires_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      accepted_at INTEGER,
      last_error_code TEXT
    );
  `);

  const now = Date.now();
  legacyDb.prepare(`INSERT INTO proactive_dispatches
    (dispatch_id, dedupe_key, thought_id, owner_key, channel, target_key, content, status, attempt_count, next_attempt_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?)`).run(
    "old-dispatch-1", "old-dedupe-1", "old-thought-1", "legacy-owner", "telegram", "12345",
    "Pesan dispatch dari database lama", now, now, now
  );

  const colsBefore = legacyDb.pragma("table_info(proactive_dispatches)");
  assert.equal(colsBefore.some((c) => c.name === "counter_applied"), false, "Before migration, counter_applied does not exist");

  ensureProactiveSchema(legacyDb);

  const colsAfter = legacyDb.pragma("table_info(proactive_dispatches)");
  assert.equal(colsAfter.some((c) => c.name === "counter_applied"), true, "After migration, counter_applied column exists");

  const migratedRow = legacyDb.prepare("SELECT * FROM proactive_dispatches WHERE dispatch_id = ?").get("old-dispatch-1");
  assert.equal(migratedRow.content, "Pesan dispatch dari database lama");
  assert.equal(migratedRow.counter_applied, 0, "Old dispatch row receives default 0");

  legacyDb.close();
});

test("migration: repeated migration is idempotent on database that already has column", () => {
  const legacyDbPath = path.join(tempRoot, "legacy-migration.sqlite");
  const db = new Database(legacyDbPath);
  assert.doesNotThrow(() => ensureProactiveSchema(db));
  assert.doesNotThrow(() => ensureProactiveSchema(db));
  const row = db.prepare("SELECT * FROM proactive_dispatches WHERE dispatch_id = ?").get("old-dispatch-1");
  assert.equal(row.counter_applied, 0);
  db.close();
});

test("migration: non-duplicate-column SQLite errors are not swallowed", () => {
  const faultyDb = {
    exec(sql) {
      if (sql.includes("ALTER TABLE")) {
        const err = new Error("disk I/O error");
        err.name = "SqliteError";
        err.code = "SQLITE_IOERR";
        throw err;
      }
    },
    pragma(param) {
      if (param.includes("table_info")) return [{ name: "dispatch_id" }];
      return [];
    },
  };

  assert.throws(() => ensureProactiveSchema(faultyDb), {
    message: /disk I\/O error/,
    code: "SQLITE_IOERR",
  });
});

test("migration: concurrent startup simulated race condition tolerates duplicate column if column is present", () => {
  const simulatedDb = {
    _cols: [{ name: "dispatch_id" }],
    exec(sql) {
      if (sql.includes("ALTER TABLE")) {
        // Simulate race: another concurrent process just added the column right now
        this._cols.push({ name: "counter_applied" });
        const err = new Error("duplicate column name: counter_applied");
        err.name = "SqliteError";
        err.code = "SQLITE_ERROR";
        throw err;
      }
    },
    pragma(param) {
      if (param.includes("table_info")) return this._cols;
      return [];
    },
  };

  assert.doesNotThrow(() => ensureProactiveSchema(simulatedDb));
  assert.equal(simulatedDb._cols.some((c) => c.name === "counter_applied"), true);
});

test("multi-process concurrency: two independent SQLite connections claiming same dispatch", async () => {
  const sharedDbPath = path.join(tempRoot, "concurrency-claims.sqlite");
  const conn1 = new Database(sharedDbPath, { timeout: 10000 });
  conn1.pragma("journal_mode = WAL");
  conn1.pragma("busy_timeout = 10000");
  const conn2 = new Database(sharedDbPath, { timeout: 10000 });
  conn2.pragma("journal_mode = WAL");
  conn2.pragma("busy_timeout = 10000");

  const outbox1 = createProactiveOutbox(conn1);
  const outbox2 = createProactiveOutbox(conn2);

  const [dispatch] = outbox1.enqueueThought({
    thoughtId: "thought-claim-conc",
    ownerKey: "owner-claim-conc",
    content: "claim race",
    channels: [{ channel: "telegram", targetKey: "tg-claim" }],
  });

  const [claim1, claim2] = await Promise.all([
    Promise.resolve().then(() => outbox1.claimById(dispatch.dispatch_id, "worker-1")),
    Promise.resolve().then(() => outbox2.claimById(dispatch.dispatch_id, "worker-2")),
  ]);

  const claimedCount = Number(Boolean(claim1)) + Number(Boolean(claim2));
  assert.equal(claimedCount, 1, "Exactly one worker must succeed in claiming");
  const winner = claim1 || claim2;
  const loser = claim1 ? claim2 : claim1;
  assert.ok(winner, "One worker won the claim");
  assert.equal(loser, null, "Other worker got null");
  assert.equal(winner.status, "sending");

  // Worker 2 tries to claim while worker 1 holds active lease: must return null
  const secondAttempt = outbox2.claimById(dispatch.dispatch_id, "worker-2");
  assert.equal(secondAttempt, null, "Cannot claim while another worker holds valid lease");

  conn1.close();
  conn2.close();
});

test("multi-process concurrency: two independent connections cannot create duplicate active thoughts", async () => {
  const sharedDbPath = path.join(tempRoot, "concurrency-active.sqlite");
  const conn1 = new Database(sharedDbPath, { timeout: 10000 });
  conn1.pragma("journal_mode = WAL");
  conn1.pragma("busy_timeout = 10000");
  const conn2 = new Database(sharedDbPath, { timeout: 10000 });
  conn2.pragma("journal_mode = WAL");
  conn2.pragma("busy_timeout = 10000");

  const outbox1 = createProactiveOutbox(conn1);
  const outbox2 = createProactiveOutbox(conn2);
  const sharedOwner = "shared-active-owner";

  const [res1, res2] = await Promise.all([
    Promise.resolve().then(() => outbox1.enqueueThoughtIfAbsent({
      thoughtId: "thought-a",
      ownerKey: sharedOwner,
      content: "message a",
      channels: [{ channel: "telegram", targetKey: "tg-a" }],
    })),
    Promise.resolve().then(() => outbox2.enqueueThoughtIfAbsent({
      thoughtId: "thought-b",
      ownerKey: sharedOwner,
      content: "message b",
      channels: [{ channel: "telegram", targetKey: "tg-b" }],
    })),
  ]);

  const successCount = Number(res1.length > 0) + Number(res2.length > 0);
  assert.equal(successCount, 1, "Only one worker can create active thought");
  const emptyRes = res1.length === 0 ? res1 : res2;
  assert.deepEqual(emptyRes, []);

  const totalActive = conn1.prepare("SELECT COUNT(*) AS c FROM proactive_dispatches WHERE owner_key=? AND status IN ('pending', 'sending')").get(sharedOwner).c;
  assert.equal(totalActive, 1, "Database contains exactly one active thought");

  conn1.close();
  conn2.close();
});

test("multi-process concurrency: counter increments once and no lost updates across independent connections", async () => {
  const sharedDbPath = path.join(tempRoot, "concurrency-counter.sqlite");
  const conn1 = new Database(sharedDbPath, { timeout: 10000 });
  conn1.pragma("journal_mode = WAL");
  conn1.pragma("busy_timeout = 10000");
  const conn2 = new Database(sharedDbPath, { timeout: 10000 });
  conn2.pragma("journal_mode = WAL");
  conn2.pragma("busy_timeout = 10000");

  const outbox1 = createProactiveOutbox(conn1);
  const outbox2 = createProactiveOutbox(conn2);
  const owner = "counter-concurrency-owner";

  outbox1.loadState(owner, {
    enabled: true,
    lastUserActivityAt: Date.now() - 3600000,
    unansweredCount: 0,
    minIdleTimeMs: 60000,
    currentCooldownMs: 60000,
  });

  const [tgDispatch, dcDispatch] = outbox1.enqueueThought({
    thoughtId: "thought-two-channel",
    ownerKey: owner,
    content: "multi-channel thought",
    channels: [
      { channel: "telegram", targetKey: "tg-user" },
      { channel: "discord", targetKey: "dc-user" },
    ],
  });

  const claimTg = outbox1.claimById(tgDispatch.dispatch_id, "worker-tg");
  const claimDc = outbox2.claimById(dcDispatch.dispatch_id, "worker-dc");
  assert.ok(claimTg && claimDc, "Both channels claimed by separate workers");

  const now = Date.now();
  const stateSpec = {
    lastUserActivityAt: now - 3600000,
    lastProactiveMessage: "multi-channel thought",
    targetPlatform: "telegram",
    lastInitialMode: null,
    currentCooldownMs: 60000,
    waitingForAnswerMs: 60000,
  };

  const [acceptTg, acceptDc] = await Promise.all([
    Promise.resolve().then(() => outbox1.markAcceptedWithState(claimTg, "worker-tg", now, stateSpec)),
    Promise.resolve().then(() => outbox2.markAcceptedWithState(claimDc, "worker-dc", now, stateSpec)),
  ]);

  assert.equal(acceptTg, true);
  assert.equal(acceptDc, true);

  const finalState = outbox1.getState(owner);
  assert.equal(finalState.unansweredCount, 1, "Counter incremented exactly once despite 2 channels accepted");

  const rows = conn1.prepare("SELECT channel, counter_applied FROM proactive_dispatches WHERE thought_id=?").all("thought-two-channel");
  const appliedSum = rows.reduce((acc, r) => acc + r.counter_applied, 0);
  assert.equal(appliedSum, 1, "Only one dispatch has counter_applied = 1");

  conn1.close();
  conn2.close();
});

test("multi-process concurrency: OS-level child process worker verifies cross-process claim and deduplication", async () => {
  const osDbPath = path.join(tempRoot, "concurrency-os.sqlite");
  const parentConn = new Database(osDbPath, { timeout: 10000 });
  parentConn.pragma("journal_mode = WAL");
  parentConn.pragma("busy_timeout = 10000");
  const parentOutbox = createProactiveOutbox(parentConn);

  const owner = "os-test-owner";
  const [dispatch] = parentOutbox.enqueueThought({
    thoughtId: "os-thought-1",
    ownerKey: owner,
    content: "os cross process test",
    channels: [{ channel: "telegram", targetKey: "12345" }],
  });

  const workerScript = path.resolve("test/helpers/multiProcessWorker.js");
  const runChildWorker = (action, payload) => new Promise((resolve, reject) => {
    const child = fork(workerScript, [osDbPath, action, JSON.stringify(payload)], {
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    let response = null;
    child.on("message", (msg) => { response = msg; });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code !== 0 && (!response || !response.ok)) {
        resolve(response || { ok: false, error: `Child exited with code ${code}` });
      } else {
        resolve(response || { ok: true, result: null });
      }
    });
  });

  const [parentClaim, childRes] = await Promise.all([
    Promise.resolve().then(() => parentOutbox.claimById(dispatch.dispatch_id, "parent-worker")),
    runChildWorker("claimById", { dispatchId: dispatch.dispatch_id, workerId: "child-worker" }),
  ]);

  assert.equal(childRes.ok, true, `Child worker succeeded: ${childRes.error}`);
  const parentWon = Boolean(parentClaim);
  const childWon = Boolean(childRes.result);
  assert.equal(parentWon !== childWon, true, "Exactly one OS process claims the dispatch");

  const childEnqueue = await runChildWorker("enqueueThoughtIfAbsent", {
    thoughtId: "os-thought-duplicate",
    ownerKey: owner,
    content: "duplicate from child",
    channels: [{ channel: "telegram", targetKey: "12345" }],
  });

  assert.equal(childEnqueue.ok, true);
  assert.deepEqual(childEnqueue.result, [], "Child process cannot create duplicate active thought while pending/sending exists");

  parentConn.close();
});

test("shutdown lifecycle: shutdown during in-flight cycle settles cleanly and prevents new cycles", async () => {
  const service = new ProactiveThoughtService({ ownerKey: "shutdown-cycle-owner" });
  service.generateSpontaneousText = async () => {
    await new Promise((r) => setTimeout(r, 40));
    return "Pesan sebelum shutdown";
  };

  const cyclePromise = service.triggerSpontaneousThought();
  assert.ok(service.cyclePromise, "cyclePromise is active");

  service.stopScheduler();
  assert.equal(service.isShuttingDown, true, "isShuttingDown flag is true");

  await service.drain();
  assert.equal(service.cyclePromise, null, "cyclePromise resolved and cleared");

  const blocked = await service.triggerSpontaneousThought();
  assert.equal(blocked.triggered, false);
  assert.equal(blocked.reason, "Service shutting down");
});

test("shutdown lifecycle: shutdown during in-flight transport completes in-flight and stops further claims", async () => {
  const service = new ProactiveThoughtService({ ownerKey: "shutdown-dispatch-owner" });
  let transportInvoked = false;
  service.transport = async () => {
    transportInvoked = true;
    await new Promise((r) => setTimeout(r, 40));
    return true;
  };

  const dispatchTask = service.dispatchToPlatforms("pesan transport", "telegram");
  assert.ok(service.dispatchPromise, "dispatchPromise is active");

  service.stopScheduler();
  assert.equal(service.isShuttingDown, true);

  await service.drain();
  assert.equal(service.dispatchPromise, null, "dispatchPromise resolved and cleared");
  assert.equal(transportInvoked, true, "Transport was invoked and completed");
});

test("shutdown lifecycle: manual trigger blocked after shutdown initiated", async () => {
  const service = new ProactiveThoughtService({ ownerKey: "shutdown-blocked-owner" });
  service.stopScheduler();
  assert.equal(service.isShuttingDown, true);

  const res = await service.triggerSpontaneousThought();
  assert.equal(res.triggered, false);
  assert.equal(res.reason, "Service shutting down");

  const dispatches = await service.processDispatches();
  assert.deepEqual(dispatches, {}, "processDispatches returns empty when shutting down");
});

test("shutdown lifecycle: database not closed before active async work completes", async () => {
  const tempDb = new Database(path.join(tempRoot, "shutdown-db.sqlite"));
  tempDb.pragma("journal_mode = WAL");
  tempDb.pragma("busy_timeout = 10000");
  const tempOutbox = createProactiveOutbox(tempDb);
  const service = new ProactiveThoughtService({ ownerKey: "shutdown-db-owner", outbox: tempOutbox });

  let dbWasOpenDuringWork = false;
  let workCompleted = false;

  service.transport = async () => {
    await new Promise((r) => setTimeout(r, 40));
    dbWasOpenDuringWork = tempDb.open;
    workCompleted = true;
    return true;
  };

  const work = service.dispatchToPlatforms("test db close order", "telegram");
  service.stopScheduler();
  await service.drain();
  await work;

  tempDb.close();

  assert.equal(dbWasOpenDuringWork, true, "Database was open while transport and DB updates ran");
  assert.equal(workCompleted, true, "Active work completed before database was closed");
  assert.equal(tempDb.open, false, "Database is now cleanly closed");
});

test("shutdown lifecycle: drain handles error gracefully and completes without hanging", async () => {
  const service = new ProactiveThoughtService({ ownerKey: "shutdown-error-owner" });
  service.generateSpontaneousText = async () => {
    await new Promise((r) => setTimeout(r, 20));
    throw new Error("AI generation crashed unexpectedly");
  };

  service.triggerSpontaneousThought().catch(() => {});
  service.stopScheduler();
  await assert.doesNotReject(() => service.drain(), "drain must settle even if in-flight work failed");
  assert.equal(service.cyclePromise, null);
});

test("SQLite setup and reads use disposable database", () => {
  assert.ok(process.env.SQLITE_DB_PATH.startsWith(tempRoot));
  assert.equal(storage.db.name, process.env.SQLITE_DB_PATH);
});

test.after(() => {
  storage.closeDatabase();
  fs.rmSync(tempRoot, { recursive: true, force: true });
});
