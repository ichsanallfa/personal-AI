import Database from "better-sqlite3";
import { ensureProactiveSchema, createProactiveOutbox } from "../../src/services/ai/proactiveOutbox.js";

const dbPath = process.argv[2];
const action = process.argv[3];
const payload = process.argv[4] ? JSON.parse(process.argv[4]) : {};

let db = null;

const run = async () => {
  try {
    db = new Database(dbPath, { timeout: 10000 });
    db.pragma("journal_mode = WAL");
    db.pragma("busy_timeout = 10000");

    // Wait for start signal via IPC
    await new Promise((resolve, reject) => {
      process.on("message", (msg) => {
        if (msg && msg.command === "START") resolve();
      });
      process.on("error", reject);
      if (process.send) {
        process.send({ status: "READY", pid: process.pid });
      } else {
        resolve();
      }
    });

    let result = null;
    if (action === "migrate") {
      ensureProactiveSchema(db);
      result = { migrated: true };
    } else if (action === "markAcceptedWithState") {
      const outbox = createProactiveOutbox(db);
      result = outbox.markAcceptedWithState(payload.dispatch, payload.workerId, payload.now, payload.state);
    } else {
      throw new Error(`Unknown action: ${action}`);
    }

    db.close();
    if (process.send) {
      process.send({ ok: true, result, pid: process.pid });
    }
    process.exit(0);
  } catch (error) {
    try { if (db) db.close(); } catch {}
    if (process.send) {
      process.send({ ok: false, error: error.message, code: error.code, name: error.name, pid: process.pid });
    }
    process.exit(1);
  }
};

run();
