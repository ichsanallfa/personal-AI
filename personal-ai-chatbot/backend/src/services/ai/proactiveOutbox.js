import { randomUUID } from "crypto";
import { db } from "../../storage/sqliteStorage.js";

const MAX_ATTEMPTS = 5;
const LEASE_MS = 60_000;
const RETRY_BASE_MS = 5_000;
const RETRY_MAX_MS = 15 * 60_000;

export const normalizeCounter = (value) => {
  if (value === undefined || value === null) return 0;
  const num = Number(value);
  if (!Number.isFinite(num) || isNaN(num)) return 0;
  const intVal = Math.floor(num);
  return intVal >= 0 ? intVal : 0;
};

export const ensureProactiveSchema = (targetDb = db) => {
  targetDb.exec(`
    CREATE TABLE IF NOT EXISTS proactive_state (
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
    CREATE TABLE IF NOT EXISTS proactive_dispatches (
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
      last_error_code TEXT,
      counter_applied INTEGER NOT NULL DEFAULT 0
    );
  `);

  const columns = targetDb.pragma("table_info(proactive_dispatches)");
  const hasCounterApplied = columns.some((col) => col.name === "counter_applied");
  if (!hasCounterApplied) {
    try {
      targetDb.exec("ALTER TABLE proactive_dispatches ADD COLUMN counter_applied INTEGER NOT NULL DEFAULT 0");
    } catch (err) {
      const isSqliteError = err?.name === "SqliteError" || err?.code === "SQLITE_ERROR";
      const isDuplicateColMsg = typeof err?.message === "string" && /^duplicate column name:\s*counter_applied$/i.test(err.message.trim());
      const nowHasCol = targetDb.pragma("table_info(proactive_dispatches)").some((col) => col.name === "counter_applied");
      if (isSqliteError && isDuplicateColMsg && nowHasCol) {
        // Tolerated expected duplicate column error from concurrent process migration
      } else {
        throw err;
      }
    }
  }

  targetDb.exec(`
    CREATE INDEX IF NOT EXISTS proactive_dispatches_due_idx
      ON proactive_dispatches(status, next_attempt_at, lease_expires_at);
  `);
};

const mapState = (row) => row && ({
  enabled: Boolean(row.enabled),
  lastUserActivityAt: row.last_user_activity_at,
  lastSuccessfulDispatchAt: row.last_successful_dispatch_at,
  unansweredCount: normalizeCounter(row.unanswered_count),
  nextEligibleAt: row.next_eligible_at,
  lastProactiveAt: row.last_proactive_at,
  lastProactiveMessage: row.last_proactive_message,
  targetPlatform: row.target_platform,
  lastInitialMode: row.last_initial_mode,
  currentCooldownMs: row.current_cooldown_ms,
  lastProactiveCooldownMs: row.last_proactive_cooldown_ms,
});

export const createProactiveOutbox = (database = db) => {
  ensureProactiveSchema(database);

  const outbox = {
    get db() {
      return database;
    },

    loadState(ownerKey, defaults) {
      const now = Date.now();
      const initialNextEligible = defaults.lastUserActivityAt + defaults.minIdleTimeMs;
      const unansweredCount = normalizeCounter(defaults.unansweredCount ?? defaults.unansweredPings);
      const initialize = database.transaction(() => database.prepare(`INSERT OR IGNORE INTO proactive_state
        (owner_key, enabled, last_user_activity_at, unanswered_count, next_eligible_at, current_cooldown_ms, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(ownerKey, defaults.enabled ? 1 : 0, defaults.lastUserActivityAt, unansweredCount,
          initialNextEligible, defaults.currentCooldownMs, now));
      initialize();
      const row = database.prepare("SELECT * FROM proactive_state WHERE owner_key = ?").get(ownerKey);
      if (row) return mapState(row);
      return {
        enabled: defaults.enabled,
        lastUserActivityAt: defaults.lastUserActivityAt,
        lastSuccessfulDispatchAt: 0,
        unansweredCount,
        nextEligibleAt: initialNextEligible,
        lastProactiveAt: 0,
        lastProactiveMessage: null,
        targetPlatform: null,
        lastInitialMode: null,
        currentCooldownMs: defaults.currentCooldownMs,
        lastProactiveCooldownMs: 0,
      };
    },

    updateEnabled(ownerKey, enabled) {
      this.loadState(ownerKey, {
        enabled,
        lastUserActivityAt: Date.now(),
        unansweredCount: 0,
        minIdleTimeMs: 0,
        currentCooldownMs: 0,
      });
      const transaction = database.transaction(() => database.prepare(`UPDATE proactive_state SET enabled=?, updated_at=? WHERE owner_key=?`)
        .run(enabled ? 1 : 0, Date.now(), ownerKey));
      transaction();
    },

    clearLastThought(ownerKey) {
      const update = database.transaction(() => database.prepare(`UPDATE proactive_state SET last_proactive_at=0,
        last_proactive_message=NULL, last_initial_mode=NULL, updated_at=? WHERE owner_key=?`)
        .run(Date.now(), ownerKey));
      update();
    },

    getState(ownerKey) {
      return mapState(database.prepare("SELECT * FROM proactive_state WHERE owner_key=?").get(ownerKey));
    },

    getDispatch(dispatchId) {
      return database.prepare("SELECT * FROM proactive_dispatches WHERE dispatch_id=?").get(dispatchId) || null;
    },

    updateState(ownerKey, fields) {
      const columns = {
        enabled: "enabled = @enabled",
        lastUserActivityAt: "last_user_activity_at = @lastUserActivityAt",
        lastSuccessfulDispatchAt: "last_successful_dispatch_at = @lastSuccessfulDispatchAt",
        unansweredPings: "unanswered_count = @unansweredPings",
        nextEligibleAt: "next_eligible_at = @nextEligibleAt",
        lastProactiveAt: "last_proactive_at = @lastProactiveAt",
        lastProactiveMessage: "last_proactive_message = @lastProactiveMessage",
        targetPlatform: "target_platform = @targetPlatform",
        lastInitialMode: "last_initial_mode = @lastInitialMode",
        currentCooldownMs: "current_cooldown_ms = @currentCooldownMs",
        lastProactiveCooldownMs: "last_proactive_cooldown_ms = @lastProactiveCooldownMs",
      };
      const assignments = Object.keys(fields).filter((key) => columns[key]);
      if (!assignments.length) return;
      this.loadState(ownerKey, {
        enabled: fields.enabled ?? true,
        lastUserActivityAt: fields.lastUserActivityAt ?? Date.now(),
        unansweredCount: fields.unansweredPings ?? 0,
        minIdleTimeMs: 0,
        currentCooldownMs: fields.currentCooldownMs ?? 0,
      });
      const params = {
        ...fields,
        enabled: typeof fields.enabled === "boolean" ? Number(fields.enabled) : fields.enabled,
        targetPlatform: fields.targetPlatform ?? null,
        lastProactiveMessage: fields.lastProactiveMessage ?? null,
        lastInitialMode: fields.lastInitialMode ?? null,
        ownerKey,
        updatedAt: Date.now(),
      };
      const update = database.transaction(() => database.prepare(`UPDATE proactive_state SET ${assignments.map((key) => columns[key]).join(", ")}, updated_at=@updatedAt WHERE owner_key=@ownerKey`)
        .run(params));
      update();
    },

    updateThoughtState(ownerKey, { message, at }) {
      const update = database.transaction(() => database.prepare(`UPDATE proactive_state SET
        last_proactive_at=?, last_proactive_message=?, updated_at=? WHERE owner_key=?`)
        .run(at, message, Date.now(), ownerKey));
      update();
    },

    setUnansweredCount(ownerKey, count) {
      const normalized = normalizeCounter(count);
      this.loadState(ownerKey, {
        enabled: true,
        lastUserActivityAt: Date.now(),
        unansweredCount: 0,
        minIdleTimeMs: 0,
        currentCooldownMs: 0,
      });
      const update = database.transaction(() => database.prepare(`UPDATE proactive_state SET unanswered_count=?, updated_at=? WHERE owner_key=?`)
        .run(normalized, Date.now(), ownerKey));
      update();
      return normalized;
    },

    resetUnanswered(ownerKey, fields) {
      this.loadState(ownerKey, {
        enabled: true,
        lastUserActivityAt: fields.lastUserActivityAt,
        unansweredCount: 0,
        minIdleTimeMs: 0,
        currentCooldownMs: fields.currentCooldownMs,
      });
      const update = database.transaction(() => database.prepare(`UPDATE proactive_state SET last_user_activity_at=?,
        unanswered_count=0, next_eligible_at=?, target_platform=?, current_cooldown_ms=?, last_initial_mode=NULL,
        updated_at=? WHERE owner_key=?`)
        .run(fields.lastUserActivityAt, fields.nextEligibleAt, fields.targetPlatform,
          fields.currentCooldownMs, Date.now(), ownerKey));
      update();
    },

    markThoughtGenerated(ownerKey, message, at) {
      const update = database.transaction(() => database.prepare(`UPDATE proactive_state SET last_proactive_at=?, last_proactive_message=?, updated_at=? WHERE owner_key=?`)
        .run(at, message, Date.now(), ownerKey));
      update();
    },

    enqueueThought({ thoughtId = randomUUID(), ownerKey, content, channels }) {
      const insert = database.prepare(`INSERT OR IGNORE INTO proactive_dispatches
        (dispatch_id, dedupe_key, thought_id, owner_key, channel, target_key, content, status,
         attempt_count, next_attempt_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?)`);
      const now = Date.now();
      const enqueue = database.transaction(() => channels.map(({ channel, targetKey }) => {
        const dedupeKey = `${thoughtId}:${channel}:${targetKey}`;
        const id = randomUUID();
        insert.run(id, dedupeKey, thoughtId, ownerKey, channel, String(targetKey), content, now, now, now);
        return database.prepare("SELECT * FROM proactive_dispatches WHERE dedupe_key = ?").get(dedupeKey);
      }));
      return enqueue();
    },

    enqueueThoughtIfAbsent(options) {
      const create = database.transaction(() => {
        const existing = database.prepare(`SELECT 1 FROM proactive_dispatches WHERE owner_key=?
          AND status IN ('pending','sending') LIMIT 1`).get(options.ownerKey);
        if (existing) return [];
        return this.enqueueThought(options);
      });
      return create();
    },

    hasActiveThought(ownerKey) {
      return Boolean(database.prepare(`SELECT 1 FROM proactive_dispatches WHERE owner_key=?
        AND status IN ('pending','sending') LIMIT 1`).get(ownerKey));
    },

    claimDue(workerId, now = Date.now()) {
      const claim = database.transaction(() => {
        const row = database.prepare(`SELECT * FROM proactive_dispatches
          WHERE (status = 'pending' AND next_attempt_at <= ?)
             OR (status = 'sending' AND lease_expires_at <= ?)
          ORDER BY created_at LIMIT 1`).get(now, now);
        if (!row) return null;
        const result = database.prepare(`UPDATE proactive_dispatches SET status='sending', attempt_count=attempt_count+1,
          lease_owner=?, lease_expires_at=?, updated_at=? WHERE dispatch_id=? AND
          ((status='pending' AND next_attempt_at<=?) OR (status='sending' AND lease_expires_at<=?))`)
          .run(workerId, now + LEASE_MS, now, row.dispatch_id, now, now);
        return result.changes ? database.prepare("SELECT * FROM proactive_dispatches WHERE dispatch_id=?").get(row.dispatch_id) : null;
      });
      return claim();
    },

    claimDueForOwner(ownerKey, workerId, now = Date.now()) {
      const claim = database.transaction(() => {
        const row = database.prepare(`SELECT * FROM proactive_dispatches
          WHERE owner_key=? AND ((status='pending' AND next_attempt_at<=?)
            OR (status='sending' AND lease_expires_at<=?)) ORDER BY created_at LIMIT 1`)
          .get(ownerKey, now, now);
        if (!row) return null;
        const result = database.prepare(`UPDATE proactive_dispatches SET status='sending', attempt_count=attempt_count+1,
          lease_owner=?, lease_expires_at=?, updated_at=? WHERE dispatch_id=? AND
          ((status='pending' AND next_attempt_at<=?) OR (status='sending' AND lease_expires_at<=?))`)
          .run(workerId, now + LEASE_MS, now, row.dispatch_id, now, now);
        return result.changes ? database.prepare("SELECT * FROM proactive_dispatches WHERE dispatch_id=?").get(row.dispatch_id) : null;
      });
      return claim();
    },

    claimById(dispatchId, workerId, now = Date.now()) {
      const claim = database.transaction(() => {
        const result = database.prepare(`UPDATE proactive_dispatches SET status='sending', attempt_count=attempt_count+1,
          lease_owner=?, lease_expires_at=?, updated_at=? WHERE dispatch_id=? AND status='pending' AND next_attempt_at<=?`)
          .run(workerId, now + LEASE_MS, now, dispatchId, now);
        return result.changes ? database.prepare("SELECT * FROM proactive_dispatches WHERE dispatch_id=?").get(dispatchId) : null;
      });
      return claim();
    },

    markAccepted(dispatchId, workerId, now = Date.now()) {
      const accept = database.transaction(() => database.prepare(`UPDATE proactive_dispatches SET status='accepted', accepted_at=?, updated_at=?,
        lease_owner=NULL, lease_expires_at=NULL, last_error_code=NULL
        WHERE dispatch_id=? AND status='sending' AND lease_owner=?`).run(now, now, dispatchId, workerId).changes === 1);
      return accept();
    },

    markAcceptedWithState(dispatch, workerId, now, state) {
      const tx = database.transaction(() => {
        const accepted = database.prepare(`UPDATE proactive_dispatches SET status='accepted', accepted_at=?, updated_at=?,
          lease_owner=NULL, lease_expires_at=NULL, last_error_code=NULL
          WHERE dispatch_id=? AND status='sending' AND lease_owner=?`).run(now, now, dispatch.dispatch_id, workerId);
        if (accepted.changes !== 1) return false;
        const currentState = database.prepare("SELECT unanswered_count, current_cooldown_ms, next_eligible_at FROM proactive_state WHERE owner_key=?").get(dispatch.owner_key);
        if (!currentState) throw new Error("proactive_state_missing");
        const firstAcceptedChannel = database.prepare(`SELECT COUNT(*) AS count FROM proactive_dispatches
          WHERE thought_id=? AND status='accepted'`).get(dispatch.thought_id).count === 1;
        const thoughtCounterApplied = database.prepare(`SELECT COUNT(*) AS count FROM proactive_dispatches
          WHERE thought_id=? AND counter_applied=1`).get(dispatch.thought_id).count > 0;
        const applyCounter = !thoughtCounterApplied;
        const nextCount = applyCounter ? normalizeCounter(currentState.unanswered_count) + 1 : normalizeCounter(currentState.unanswered_count);
        const nextCooldownMs = state.currentCooldownMs;
        const nextEligibleAt = applyCounter
          ? now + (nextCount === 1 ? state.waitingForAnswerMs : nextCooldownMs)
          : currentState.next_eligible_at;
        if (applyCounter) {
          database.prepare("UPDATE proactive_dispatches SET counter_applied=1 WHERE dispatch_id=?")
            .run(dispatch.dispatch_id);
        }
        const updated = database.prepare(`UPDATE proactive_state SET last_successful_dispatch_at=?, last_proactive_at=?,
          unanswered_count=CASE WHEN ? THEN ? ELSE unanswered_count END,
          next_eligible_at=CASE WHEN ? THEN ? ELSE next_eligible_at END, last_proactive_message=?,
          last_proactive_cooldown_ms=?, target_platform=?, last_initial_mode=?,
          current_cooldown_ms=?, updated_at=? WHERE owner_key=?`)
          .run(now, now, applyCounter ? 1 : 0, nextCount, applyCounter ? 1 : 0, nextEligibleAt,
            state.lastProactiveMessage, nextCooldownMs, state.targetPlatform, state.lastInitialMode,
            nextCooldownMs, now, dispatch.owner_key);
        if (updated.changes !== 1) throw new Error("proactive_state_missing");
        if (!firstAcceptedChannel) {
          const nextCooldown = Math.min(15 * 60_000, Math.round(nextCooldownMs * (0.75 + Math.random() * 0.5)));
          database.prepare(`UPDATE proactive_state SET last_successful_dispatch_at=?, next_eligible_at=?, updated_at=? WHERE owner_key=?`)
            .run(now, now + nextCooldown, now, dispatch.owner_key);
        }
        return true;
      });
      return tx();
    },

    markFailed(dispatch, workerId, errorCode, retryable, now = Date.now()) {
      const terminal = !retryable || dispatch.attempt_count >= MAX_ATTEMPTS;
      const exp = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * (2 ** Math.max(0, dispatch.attempt_count - 1)));
      const delay = Math.round(exp * (0.75 + Math.random() * 0.5));
      const fail = database.transaction(() => {
        const result = database.prepare(`UPDATE proactive_dispatches SET status=?, next_attempt_at=?, updated_at=?,
        lease_owner=NULL, lease_expires_at=NULL, last_error_code=?
        WHERE dispatch_id=? AND status='sending' AND lease_owner=?`)
        .run(terminal ? "failed" : "pending", now + (terminal ? 0 : delay), now,
          String(errorCode || "transport_error").slice(0, 100), dispatch.dispatch_id, workerId);
        if (result.changes && terminal) {
          const acceptedCount = database.prepare("SELECT COUNT(*) AS count FROM proactive_dispatches WHERE thought_id=? AND status='accepted'")
            .get(dispatch.thought_id).count;
          if (acceptedCount === 0) {
            database.prepare(`UPDATE proactive_state SET unanswered_count=0, last_proactive_message=NULL,
              last_initial_mode=NULL, current_cooldown_ms=0, next_eligible_at=0, updated_at=?
              WHERE owner_key=? AND NOT EXISTS (SELECT 1 FROM proactive_dispatches
                WHERE thought_id=? AND status IN ('pending','sending'))`)
              .run(now, dispatch.owner_key, dispatch.thought_id);
          }
        }
        return result.changes === 1;
      });
      return fail();
    },

    undoUnansweredThought(ownerKey, thoughtId, now = Date.now()) {
      const update = database.transaction(() => {
        const accepted = database.prepare("SELECT COUNT(*) AS count FROM proactive_dispatches WHERE thought_id=? AND status='accepted'")
          .get(thoughtId).count;
        if (accepted === 0) {
          database.prepare(`UPDATE proactive_state SET unanswered_count=0, last_proactive_message=NULL,
            last_initial_mode=NULL, last_proactive_at=0, next_eligible_at=0, updated_at=? WHERE owner_key=?`)
            .run(now, ownerKey);
        }
      });
      update();
    },

    recoverExpired(ownerKey, now = Date.now()) {
      const recover = database.transaction(() => {
        database.prepare(`UPDATE proactive_dispatches SET status='pending', lease_owner=NULL,
        lease_expires_at=NULL, next_attempt_at=?, updated_at=?, last_error_code='expired_lease'
        WHERE owner_key=? AND status='sending' AND lease_expires_at <= ? AND attempt_count < ?`)
        .run(now, now, ownerKey, now, MAX_ATTEMPTS);
        database.prepare(`UPDATE proactive_dispatches SET status='failed', lease_owner=NULL,
          lease_expires_at=NULL, updated_at=?, last_error_code='attempts_exhausted'
          WHERE owner_key=? AND status='sending' AND lease_expires_at <= ? AND attempt_count >= ?`)
          .run(now, ownerKey, now, MAX_ATTEMPTS);
        return true;
      });
      return recover();
    },

    listDueChannels(ownerKey, now = Date.now()) {
      return database.prepare(`SELECT DISTINCT channel, target_key AS targetKey FROM proactive_dispatches
        WHERE owner_key=? AND ((status='pending' AND next_attempt_at<=?)
          OR (status='sending' AND lease_expires_at<=?))`).all(ownerKey, now, now);
    },
  };

  return outbox;
};

export const proactiveOutbox = createProactiveOutbox(db);
