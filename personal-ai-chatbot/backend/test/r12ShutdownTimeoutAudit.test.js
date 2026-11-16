import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import Database from "better-sqlite3";
import fs from "fs";
import os from "os";
import path from "path";

test("R12 Audit: closing HTTP sockets via timeout does NOT wait for unhandled async handler promises", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "lucy-r12-audit-"));
  const dbPath = path.join(tempDir, "r12-audit.sqlite");
  const testDb = new Database(dbPath, { timeout: 10000 });
  testDb.exec("CREATE TABLE IF NOT EXISTS docs (id INTEGER PRIMARY KEY, content TEXT)");

  const app = express();
  let handlerStarted = false;
  let handlerFinished = false;
  let errorCaughtInHandler = null;
  let dbOpenWhenHandlerAccessed = null;

  let handlerStartedResolve;
  const handlerStartedPromise = new Promise((r) => {
    handlerStartedResolve = r;
  });

  app.get("/long-operation", async (req, res) => {
    handlerStarted = true;
    handlerStartedResolve();

    // Simulate async operation that takes longer than shutdown timeout (e.g., 200ms vs 50ms timeout)
    await new Promise((r) => setTimeout(r, 200));

    try {
      dbOpenWhenHandlerAccessed = testDb.open;
      testDb.prepare("INSERT INTO docs (content) VALUES (?)").run("saved after timeout");
      handlerFinished = true;
      res.json({ ok: true });
    } catch (err) {
      errorCaughtInHandler = err;
    }
  });

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;

  // Client initiates request
  const fetchPromise = fetch(`http://127.0.0.1:${port}/long-operation`).catch((err) => err);

  // Wait until route handler has started
  await handlerStartedPromise;

  // Replicate R11 closeHttpServer with short timeout (50ms)
  const closeHttpServerR11 = (httpServer, timeoutMs) => new Promise((resolve) => {
    let closed = false;
    const timer = setTimeout(() => {
      if (!closed) {
        closed = true;
        if (typeof httpServer.closeAllConnections === "function") {
          httpServer.closeAllConnections();
        }
        resolve();
      }
    }, timeoutMs);
    timer.unref?.();

    if (typeof httpServer.closeIdleConnections === "function") {
      httpServer.closeIdleConnections();
    }

    httpServer.close(() => {
      if (!closed) {
        closed = true;
        clearTimeout(timer);
        resolve();
      }
    });
  });

  // Execute shutdown with 50ms timeout
  const shutdownStart = Date.now();
  await closeHttpServerR11(server, 50);
  const shutdownDuration = Date.now() - shutdownStart;

  // Server closeHttpServer resolved because timeout fired and closeAllConnections() severed sockets
  assert.ok(shutdownDuration < 150, "closeHttpServer resolved early due to timeout");

  // Shutdown sequence proceeds to close database
  testDb.close();
  assert.equal(testDb.open, false, "Database was closed by shutdown sequence");

  // Wait for the route handler to finish its 200ms delay
  await new Promise((r) => setTimeout(r, 200));
  await fetchPromise;

  // VERIFICATION OF FINDINGS:
  assert.equal(handlerStarted, true, "1. Handler was started");
  assert.equal(dbOpenWhenHandlerAccessed, false, "2. Handler attempted to access database when db.open was already false");
  assert.ok(errorCaughtInHandler, "3. Error occurred in handler when attempting to access closed database");
  assert.match(
    errorCaughtInHandler.message,
    /database connection is not open|not open/i,
    "4. Error caught is 'database connection is not open'"
  );
  assert.equal(handlerFinished, false, "5. Handler could not complete its database write");

  fs.rmSync(tempDir, { recursive: true, force: true });
});
