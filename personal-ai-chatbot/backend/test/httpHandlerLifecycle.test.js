import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import fs from "fs";
import os from "os";
import path from "path";
import Database from "better-sqlite3";

import { setupGracefulShutdown } from "../src/server.js";
import {
  initHttpHandlerTracking,
  getActiveHandlersCount,
  waitForActiveHandlers,
  resetHandlerTrackingForTests,
} from "../src/utils/httpHandlerTracker.js";

// Ensure tracking is initialized
initHttpHandlerTracking();

test("R13-A: Long async handler performs SQLite write after delay; shutdown does not close SQLite before write completes", async () => {
  resetHandlerTrackingForTests();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "lucy-r13-a-"));
  const dbPath = path.join(tempDir, "test-a.sqlite");
  const testDb = new Database(dbPath, { timeout: 10000 });
  testDb.exec("CREATE TABLE IF NOT EXISTS docs (id INTEGER PRIMARY KEY, content TEXT)");

  const app = express();
  let writeExecutedWhileDbOpen = false;
  let handlerCompleted = false;

  let requestArrivedResolve;
  const requestArrivedPromise = new Promise((r) => {
    requestArrivedResolve = r;
  });

  app.get("/async-write", async (req, res) => {
    requestArrivedResolve();
    await new Promise((r) => setTimeout(r, 80));
    writeExecutedWhileDbOpen = testDb.open;
    testDb.prepare("INSERT INTO docs (content) VALUES (?)").run("written safely during shutdown");
    handlerCompleted = true;
    res.json({ ok: true });
  });

  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;

  const fetchPromise = fetch(`http://127.0.0.1:${port}/async-write`, {
    headers: { Connection: "close" },
  }).then((r) => r.json());

  await requestArrivedPromise;
  assert.equal(getActiveHandlersCount(), 1, "Handler is actively tracked");

  // Shutdown initiated while write is still pending
  const shutdownPromise = (async () => {
    // Custom shutdown matching server.js flow with isolated DB
    await new Promise((resolve) => server.close(resolve));
    await waitForActiveHandlers(5000);
    testDb.close();
  })();

  await Promise.all([fetchPromise, shutdownPromise]);

  assert.equal(handlerCompleted, true, "Handler completed execution");
  assert.equal(writeExecutedWhileDbOpen, true, "Database was open when write executed");
  assert.equal(testDb.open, false, "Database is now closed cleanly after handler finished");

  // Verify record on re-opened DB
  const verifyDb = new Database(dbPath);
  const row = verifyDb.prepare("SELECT * FROM docs WHERE content=?").get("written safely during shutdown");
  assert.ok(row, "Data was committed to SQLite successfully");
  verifyDb.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("R13-B: Client disconnects while handler is still running; handler remains tracked until Promise settles", async () => {
  resetHandlerTrackingForTests();
  const app = express();
  let handlerSettled = false;

  let handlerStartedResolve;
  const handlerStartedPromise = new Promise((r) => {
    handlerStartedResolve = r;
  });

  app.get("/client-abort", async (req, res) => {
    handlerStartedResolve();
    // Simulate long async work
    await new Promise((r) => setTimeout(r, 100));
    handlerSettled = true;
    res.json({ done: true });
  });

  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;

  const controller = new AbortController();
  const fetchPromise = fetch(`http://127.0.0.1:${port}/client-abort`, {
    signal: controller.signal,
  }).catch(() => "aborted");

  await handlerStartedPromise;
  assert.equal(getActiveHandlersCount(), 1, "Handler tracked when request begins");

  // Client aborts connection
  controller.abort();
  await fetchPromise;

  // Verify: Socket is aborted, but handler Promise is STILL tracked!
  assert.equal(handlerSettled, false, "Handler is still in flight");
  assert.equal(getActiveHandlersCount(), 1, "Handler remains tracked even after client disconnected");

  // Wait for handler to naturally settle
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(handlerSettled, true, "Handler settled");
  assert.equal(getActiveHandlersCount(), 0, "Tracking released after handler Promise settled");

  server.close();
});

test("R13-C: Handler throws an error; tracking is released and error handling is preserved", async () => {
  resetHandlerTrackingForTests();
  const app = express();

  app.get("/throw-route", async (req, res) => {
    await new Promise((r) => setTimeout(r, 20));
    throw new Error("Deliberate handler exception");
  });

  app.use((err, req, res, next) => {
    res.status(500).json({ error: err.message });
  });

  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;

  const res = await fetch(`http://127.0.0.1:${port}/throw-route`, {
    headers: { Connection: "close" },
  });
  const data = await res.json();

  assert.equal(res.status, 500);
  assert.equal(data.error, "Deliberate handler exception");
  assert.equal(getActiveHandlersCount(), 0, "Tracking released even though handler threw");

  server.close();
});

test("R13-D: Multiple concurrent handlers; shutdown waits for all tracked handlers", async () => {
  resetHandlerTrackingForTests();
  const app = express();
  let finishedCount = 0;

  app.get("/concurrent", async (req, res) => {
    await new Promise((r) => setTimeout(r, 60));
    finishedCount += 1;
    res.json({ ok: true, count: finishedCount });
  });

  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;

  const req1 = fetch(`http://127.0.0.1:${port}/concurrent`, { headers: { Connection: "close" } });
  const req2 = fetch(`http://127.0.0.1:${port}/concurrent`, { headers: { Connection: "close" } });
  const req3 = fetch(`http://127.0.0.1:${port}/concurrent`, { headers: { Connection: "close" } });

  // Wait a small tick so all 3 requests reach server
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(getActiveHandlersCount(), 3, "All 3 concurrent handlers are tracked");

  const shutdown = setupGracefulShutdown(server, { exitProcess: false, socketTimeoutMs: 5000, handlerTimeoutMs: 5000 });
  await shutdown();

  await Promise.all([req1, req2, req3]);
  assert.equal(finishedCount, 3, "All 3 handlers completed successfully before shutdown completed");
  assert.equal(getActiveHandlersCount(), 0, "All tracking entries released");
});

test("R13-E: Handler exceeds HTTP socket timeout; socket closure does not cause premature database closure", async () => {
  resetHandlerTrackingForTests();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "lucy-r13-e-"));
  const dbPath = path.join(tempDir, "test-e.sqlite");
  const testDb = new Database(dbPath, { timeout: 10000 });
  testDb.exec("CREATE TABLE IF NOT EXISTS docs (id INTEGER PRIMARY KEY, content TEXT)");

  const app = express();
  let writeSuccess = false;
  let dbOpenAtWrite = null;

  let requestArrivedResolve;
  const requestArrivedPromise = new Promise((r) => {
    requestArrivedResolve = r;
  });

  app.get("/slow-socket-worker", async (req, res) => {
    requestArrivedResolve();
    // Handler takes 120ms (exceeding socketTimeout of 40ms)
    await new Promise((r) => setTimeout(r, 120));
    dbOpenAtWrite = testDb.open;
    try {
      testDb.prepare("INSERT INTO docs (content) VALUES (?)").run("survived socket closure");
      writeSuccess = true;
    } catch (e) {
      writeSuccess = false;
    }
    try {
      res.json({ ok: true });
    } catch {}
  });

  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;

  const fetchPromise = fetch(`http://127.0.0.1:${port}/slow-socket-worker`).catch(() => "socket_closed");

  await requestArrivedPromise;

  // Custom shutdown simulation with socketTimeoutMs = 40ms, handlerTimeoutMs = 1000ms
  const shutdown = async () => {
    // 1. Force close sockets at 40ms
    await new Promise((resolve) => {
      setTimeout(() => {
        if (typeof server.closeAllConnections === "function") server.closeAllConnections();
        server.close(resolve);
      }, 40);
    });

    // 2. Wait for handler promises up to 1000ms
    const handlersClean = await waitForActiveHandlers(1000);

    // 3. Close DB only after handlers finish
    if (handlersClean && getActiveHandlersCount() === 0) {
      testDb.close();
    }
  };

  await Promise.all([fetchPromise, shutdown()]);

  assert.equal(dbOpenAtWrite, true, "Database remained open when slow handler executed write after socket closure");
  assert.equal(writeSuccess, true, "Write operation succeeded despite socket being severed");
  assert.equal(testDb.open, false, "Database closed after handler settled");

  const verifyDb = new Database(dbPath);
  const row = verifyDb.prepare("SELECT * FROM docs WHERE content=?").get("survived socket closure");
  assert.ok(row, "Record persisted");
  verifyDb.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("R13-F: Synchronous route with no async handler operates normally and does not corrupt tracking", async () => {
  resetHandlerTrackingForTests();
  const app = express();

  app.get("/sync-test", (req, res) => {
    res.json({ sync: true });
  });

  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;

  const res = await fetch(`http://127.0.0.1:${port}/sync-test`, {
    headers: { Connection: "close" },
  });
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.equal(body.sync, true);
  assert.equal(getActiveHandlersCount(), 0, "Synchronous route does not register handler tracking");

  server.close();
});

test("R14B: custom thenables are tracked, settled, and forwarded to Express", async () => {
  resetHandlerTrackingForTests();
  const app = express();
  let rejectThenable = false;

  app.get("/thenable", (req, res) => {
    let responded = false;
    return {
      then(resolve, reject) {
        setTimeout(() => {
          if (rejectThenable) return reject?.(new Error("custom thenable failure"));
          if (!responded) {
            responded = true;
            res.json({ ok: true });
          }
          resolve?.();
        }, 20);
      },
    };
  });
  app.use((error, req, res, next) => res.status(500).json({ error: error.message }));

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const url = `http://127.0.0.1:${server.address().port}/thenable`;

  const fulfilled = fetch(url, { headers: { Connection: "close" } });
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(getActiveHandlersCount(), 1);
  assert.equal((await fulfilled).status, 200);
  assert.equal(getActiveHandlersCount(), 0);

  rejectThenable = true;
  const rejected = fetch(url, { headers: { Connection: "close" } });
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(getActiveHandlersCount(), 1);
  const response = await rejected;
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { error: "custom thenable failure" });
  assert.equal(getActiveHandlersCount(), 0);

  initHttpHandlerTracking();
  server.close();
});
