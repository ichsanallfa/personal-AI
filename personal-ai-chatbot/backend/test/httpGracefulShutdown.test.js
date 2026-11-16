import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { setupGracefulShutdown } from "../src/server.js";
import { reminderService } from "../src/services/reminder/reminderService.js";
import { proactiveThoughtService } from "../src/services/ai/proactiveThoughtService.js";
import { db } from "../src/storage/sqliteStorage.js";

for (const [label, thrownValue, expectedMessage] of [
  ["Error", new Error("handler wait failed"), "handler wait failed"],
  ["null", null, "null"],
  ["undefined", undefined, "undefined"],
  ["string", "handler wait failed", "handler wait failed"],
]) {
test(`R14D: ${label} handler wait failure stays fail-safe`, async () => {
  const messages = [];
  const originalError = console.error;
  const originalExit = process.exit;
  let exitCode;
  console.error = (...args) => messages.push(args.join(" "));
  process.exit = (code) => {
    exitCode = code;
  };
  try {
    const shutdown = setupGracefulShutdown({ listening: false }, {
      waitForHandlers: async () => {
        throw thrownValue;
      },
    });
    await shutdown();
    assert.equal(db.open, true, "SQLite remains open when handler settlement is unknown");
    assert.ok(messages.some((message) => message.includes("Error waiting for HTTP handlers")));
    assert.ok(messages.some((message) => message.includes(expectedMessage)));
    assert.equal(exitCode, 1, "Handler wait failure exits non-zero");
  } finally {
    console.error = originalError;
    process.exit = originalExit;
  }
});
}

test("HTTP graceful shutdown: in-flight request finishes database access before closeDatabase and new requests rejected", async () => {
  const app = express();
  let dbOpenDuringRequest = false;
  let requestSucceeded = false;
  let requestArrivedResolve;
  const requestArrivedPromise = new Promise((r) => {
    requestArrivedResolve = r;
  });

  app.get("/active-query", async (req, res) => {
    requestArrivedResolve();
    // Delay to simulate in-flight work while shutdown begins
    await new Promise((r) => setTimeout(r, 80));
    dbOpenDuringRequest = db.open;
    const docCount = db.prepare("SELECT count(*) as c FROM documents").get().c;
    requestSucceeded = true;
    res.json({ ok: true, docCount });
  });

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;

  // Start request with Connection: close so keep-alive socket does not hang server.close
  const fetchPromise = fetch(`http://127.0.0.1:${port}/active-query`, {
    headers: { Connection: "close" },
  }).then((r) => r.json());

  // Wait until request has actually reached the server handler
  await requestArrivedPromise;

  // Initiate graceful shutdown while request is still running in-flight
  let schedulerDrained = false;
  proactiveThoughtService.startScheduler();
  const originalDrain = proactiveThoughtService.drain.bind(proactiveThoughtService);
  proactiveThoughtService.drain = async () => {
    await originalDrain();
    schedulerDrained = true;
  };

  const shutdown = setupGracefulShutdown(server, { exitProcess: false, timeoutMs: 5000 });
  await shutdown();

  const responseData = await fetchPromise;
  assert.equal(requestSucceeded, true, "In-flight HTTP request completed successfully");
  assert.equal(dbOpenDuringRequest, true, "Database remained open while in-flight request executed");
  assert.equal(responseData.ok, true);

  // 1. New requests are rejected because server stopped accepting
  await assert.rejects(
    () => fetch(`http://127.0.0.1:${port}/active-query`, { headers: { Connection: "close" } }),
    /ECONNREFUSED|fetch failed/
  );

  // 2. Scheduler was drained
  assert.equal(schedulerDrained, true, "Proactive scheduler was drained");
  assert.equal(proactiveThoughtService.isShuttingDown, true);

  // 3. Database is closed now
  assert.equal(db.open, false, "Database is closed after all work");

  // 4. Repeated shutdown does not throw or double-close
  await assert.doesNotReject(() => shutdown(), "Repeated shutdown call must be idempotent");

  // Restore for any further tests
  proactiveThoughtService.drain = originalDrain;
});

test("HTTP graceful shutdown: lifecycle execution order is strictly preserved", async () => {
  const lifecycleOrder = [];

  const mockServer = {
    listening: true,
    close(cb) {
      lifecycleOrder.push("server.close");
      setTimeout(cb, 20);
    },
    closeIdleConnections() {
      lifecycleOrder.push("server.closeIdleConnections");
    },
  };

  const origStopReminder = reminderService.stopScheduler.bind(reminderService);
  const origStopProactive = proactiveThoughtService.stopScheduler.bind(proactiveThoughtService);
  const origDrainProactive = proactiveThoughtService.drain.bind(proactiveThoughtService);

  reminderService.stopScheduler = () => {
    lifecycleOrder.push("reminderService.stopScheduler");
  };
  proactiveThoughtService.stopScheduler = () => {
    lifecycleOrder.push("proactiveThoughtService.stopScheduler");
  };
  proactiveThoughtService.drain = async () => {
    lifecycleOrder.push("proactiveThoughtService.drain");
  };

  const shutdown = setupGracefulShutdown(mockServer, { exitProcess: false, timeoutMs: 5000 });
  await shutdown();

  // Verify ordering:
  // 1. server.close must happen before reminder/proactive stop and drain
  assert.ok(lifecycleOrder.indexOf("server.close") < lifecycleOrder.indexOf("reminderService.stopScheduler"));
  assert.ok(lifecycleOrder.indexOf("reminderService.stopScheduler") < lifecycleOrder.indexOf("proactiveThoughtService.stopScheduler"));
  assert.ok(lifecycleOrder.indexOf("proactiveThoughtService.stopScheduler") < lifecycleOrder.indexOf("proactiveThoughtService.drain"));

  // Restore
  reminderService.stopScheduler = origStopReminder;
  proactiveThoughtService.stopScheduler = origStopProactive;
  proactiveThoughtService.drain = origDrainProactive;
});

test("HTTP graceful shutdown: safe when server is already stopped or not listening", async () => {
  const notListeningServer = {
    listening: false,
    close() {
      throw new Error("Server not running");
    },
  };

  const shutdown = setupGracefulShutdown(notListeningServer, { exitProcess: false });
  await assert.doesNotReject(() => shutdown(), "Must handle non-listening server cleanly");
});
