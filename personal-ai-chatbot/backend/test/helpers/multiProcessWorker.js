import Database from "better-sqlite3";
import { createProactiveOutbox } from "../../src/services/ai/proactiveOutbox.js";

const dbPath = process.argv[2];
const action = process.argv[3];
const payload = process.argv[4] ? JSON.parse(process.argv[4]) : {};

const db = new Database(dbPath, { timeout: 10000 });
db.pragma("journal_mode = WAL");
db.pragma("busy_timeout = 10000");

const outbox = createProactiveOutbox(db);

try {
  let result = null;
  if (action === "claimById") {
    result = outbox.claimById(payload.dispatchId, payload.workerId);
  } else if (action === "enqueueThoughtIfAbsent") {
    result = outbox.enqueueThoughtIfAbsent(payload);
  } else if (action === "markAcceptedWithState") {
    result = outbox.markAcceptedWithState(payload.dispatch, payload.workerId, payload.now, payload.state);
  } else if (action === "getState") {
    result = outbox.getState(payload.ownerKey);
  } else {
    throw new Error(`Unknown action: ${action}`);
  }
  db.close();
  if (process.send) {
    process.send({ ok: true, result });
  } else {
    console.log(JSON.stringify({ ok: true, result }));
  }
  process.exit(0);
} catch (error) {
  try { db.close(); } catch {}
  if (process.send) {
    process.send({ ok: false, error: error.message });
  } else {
    console.error(JSON.stringify({ ok: false, error: error.message }));
  }
  process.exit(1);
}
