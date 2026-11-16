import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { fork } from "child_process";
import Database from "better-sqlite3";

const [{ createProactiveOutbox, ensureProactiveSchema }, { ProactiveThoughtService }] = await Promise.all([
  import("../src/services/ai/proactiveOutbox.js"),
  import("../src/services/ai/proactiveThoughtService.js"),
]);

const workerScript = path.resolve("test/helpers/r10Worker.js");

const spawnBarrierWorker = (dbPath, action, payload) => {
  const child = fork(workerScript, [dbPath, action, JSON.stringify(payload)], {
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });

  let readyResolve = null;
  const readyPromise = new Promise((resolve) => {
    readyResolve = resolve;
  });

  let exitResolve = null;
  const exitPromise = new Promise((resolve) => {
    exitResolve = resolve;
  });

  let lastMessage = null;
  let exitCode = null;

  child.on("message", (msg) => {
    lastMessage = msg;
    if (msg?.status === "READY") {
      readyResolve(msg);
    }
  });

  child.on("exit", (code) => {
    exitCode = code;
    exitResolve({ exitCode, message: lastMessage });
  });

  const start = () => {
    child.send({ command: "START" });
  };

  return {
    child,
    readyPromise,
    exitPromise,
    start,
    getPid: () => child.pid,
  };
};

test("R10-A: Real SQLite migration concurrency with two forked child processes", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "lucy-r10-mig-"));
  const dbPath = path.join(tempDir, "migration-concurrency.sqlite");

  const legacyDb = new Database(dbPath, { timeout: 10000 });
  legacyDb.pragma("journal_mode = WAL");
  legacyDb.pragma("busy_timeout = 10000");

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
    "legacy-r10-1", "dedupe-r10-1", "thought-r10-1", "owner-r10", "telegram", "12345",
    "Old legacy record", now, now, now
  );

  const colsBefore = legacyDb.pragma("table_info(proactive_dispatches)");
  assert.equal(colsBefore.some((c) => c.name === "counter_applied"), false, "Before migration, counter_applied is absent");
  legacyDb.close();

  // Spawn two separate Node OS child processes
  const w1 = spawnBarrierWorker(dbPath, "migrate", {});
  const w2 = spawnBarrierWorker(dbPath, "migrate", {});

  assert.notEqual(w1.getPid(), w2.getPid(), "Processes have distinct OS PIDs");

  // Wait for both to establish connections and reach barrier
  await Promise.all([w1.readyPromise, w2.readyPromise]);

  // Release barrier simultaneously
  w1.start();
  w2.start();

  const [res1, res2] = await Promise.all([w1.exitPromise, w2.exitPromise]);

  // 1. Both exit with code 0
  assert.equal(res1.exitCode, 0, `Process 1 exit code must be 0: ${JSON.stringify(res1.message)}`);
  assert.equal(res2.exitCode, 0, `Process 2 exit code must be 0: ${JSON.stringify(res2.message)}`);
  assert.equal(res1.message?.ok, true);
  assert.equal(res2.message?.ok, true);

  // 2. Open DB to verify post-migration state
  const verifyDb = new Database(dbPath, { timeout: 10000 });
  const colsAfter = verifyDb.pragma("table_info(proactive_dispatches)");
  assert.equal(colsAfter.some((c) => c.name === "counter_applied"), true, "counter_applied column exists");

  const legacyRow = verifyDb.prepare("SELECT * FROM proactive_dispatches WHERE dispatch_id=?").get("legacy-r10-1");
  assert.equal(legacyRow.content, "Old legacy record");
  assert.equal(legacyRow.counter_applied, 0, "Existing legacy row received default 0");

  // 3. Verify repeated migration is idempotent
  assert.doesNotThrow(() => ensureProactiveSchema(verifyDb), "Repeated migration must be idempotent");

  verifyDb.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("R10-B: Real OS-level counter atomicity with two forked child processes", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "lucy-r10-cnt-"));
  const dbPath = path.join(tempDir, "counter-concurrency.sqlite");

  const setupDb = new Database(dbPath, { timeout: 10000 });
  setupDb.pragma("journal_mode = WAL");
  setupDb.pragma("busy_timeout = 10000");

  const setupOutbox = createProactiveOutbox(setupDb);
  const owner = "r10-counter-owner";

  setupOutbox.loadState(owner, {
    enabled: true,
    lastUserActivityAt: Date.now() - 3600000,
    unansweredCount: 0,
    minIdleTimeMs: 60000,
    currentCooldownMs: 60000,
  });

  const [tgDispatch, dcDispatch] = setupOutbox.enqueueThought({
    thoughtId: "r10-thought-dual",
    ownerKey: owner,
    content: "Dual channel OS race thought",
    channels: [
      { channel: "telegram", targetKey: "tg-os-user" },
      { channel: "discord", targetKey: "dc-os-user" },
    ],
  });

  // Pre-claim dispatches for workers
  const claimedTg = setupOutbox.claimById(tgDispatch.dispatch_id, "os-worker-tg");
  const claimedDc = setupOutbox.claimById(dcDispatch.dispatch_id, "os-worker-dc");
  assert.ok(claimedTg && claimedDc, "Both dispatches claimed");
  setupDb.close();

  const now = Date.now();
  const stateSpec = {
    lastUserActivityAt: now - 3600000,
    lastProactiveMessage: "Dual channel OS race thought",
    targetPlatform: "telegram",
    lastInitialMode: null,
    currentCooldownMs: 60000,
    waitingForAnswerMs: 60000,
  };

  // Spawn two separate Node OS child processes
  const w1 = spawnBarrierWorker(dbPath, "markAcceptedWithState", {
    dispatch: claimedTg,
    workerId: "os-worker-tg",
    now,
    state: stateSpec,
  });

  const w2 = spawnBarrierWorker(dbPath, "markAcceptedWithState", {
    dispatch: claimedDc,
    workerId: "os-worker-dc",
    now,
    state: stateSpec,
  });

  assert.notEqual(w1.getPid(), w2.getPid(), "Processes have distinct OS PIDs");

  // Wait for both child processes to reach barrier
  await Promise.all([w1.readyPromise, w2.readyPromise]);

  // Trigger markAcceptedWithState simultaneously
  w1.start();
  w2.start();

  const [res1, res2] = await Promise.all([w1.exitPromise, w2.exitPromise]);

  assert.equal(res1.exitCode, 0, `Process 1 exit code 0: ${JSON.stringify(res1.message)}`);
  assert.equal(res2.exitCode, 0, `Process 2 exit code 0: ${JSON.stringify(res2.message)}`);
  assert.equal(res1.message?.result, true);
  assert.equal(res2.message?.result, true);

  // Read raw SQLite database directly
  const verifyDb = new Database(dbPath, { timeout: 10000 });
  verifyDb.pragma("journal_mode = WAL");

  // 1. Both dispatches must be 'accepted'
  const rows = verifyDb.prepare("SELECT dispatch_id, channel, status, counter_applied FROM proactive_dispatches WHERE thought_id=?").all("r10-thought-dual");
  assert.equal(rows.length, 2);
  assert.equal(rows[0].status, "accepted");
  assert.equal(rows[1].status, "accepted");

  // 2. Exactly one row has counter_applied = 1
  const counterAppliedCount = rows.filter((r) => r.counter_applied === 1).length;
  assert.equal(counterAppliedCount, 1, "Exactly one dispatch has counter_applied = 1");

  // 3. unanswered_count must be exactly 1
  const stateRow = verifyDb.prepare("SELECT unanswered_count, current_cooldown_ms FROM proactive_state WHERE owner_key=?").get(owner);
  assert.equal(stateRow.unanswered_count, 1, "unanswered_count must increment exactly once");

  // 4. Verify service recreation does not re-apply counter
  const verifyOutbox = createProactiveOutbox(verifyDb);
  const service = new ProactiveThoughtService({ ownerKey: owner, outbox: verifyOutbox });
  assert.equal(service.unrespondedPings, 1, "Restored unresponded pings is 1");
  verifyOutbox.recoverExpired(owner);
  assert.equal(verifyOutbox.getState(owner).unansweredCount, 1, "Lease recovery does not alter counter");

  verifyDb.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});
