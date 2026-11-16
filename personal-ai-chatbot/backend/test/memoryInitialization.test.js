import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "lucy-memory-init-"));
process.env.RUNTIME_DIR = path.join(tempRoot, "runtime");
process.env.SQLITE_DB_PATH = path.join(tempRoot, "test.sqlite");

const [{ MemoryService }, storage] = await Promise.all([
  import("../src/services/memory/memoryService.js"),
  import("../src/storage/sqliteStorage.js"),
]);

const createPaths = (name) => {
  const root = path.join(tempRoot, name);
  const legacyRoot = path.join(root, "legacy");
  fs.mkdirSync(legacyRoot, { recursive: true });
  return {
    root,
    legacyRoot,
    coreMemoryFile: path.join(root, "coreMemory.json"),
    userMemoryFile: path.join(root, "userMemory.json"),
    sessionMemoryFile: path.join(root, "sessionMemory.json"),
  };
};

const initialize = (paths) => new MemoryService().initialize(paths);
const read = (filePath) => storage.readDocument(filePath, undefined);
const seedCore = { identity: { name: "Preserved Lucy" }, facts: ["kept"] };

test("SQLite memory wins when legacy JSON is absent", () => {
  const paths = createPaths("sqlite-precedence");
  storage.writeDocument(paths.coreMemoryFile, seedCore);
  initialize(paths);
  assert.deepEqual(read(paths.coreMemoryFile), seedCore);
});

test("valid legacy JSON imports when SQLite document is absent", () => {
  const paths = createPaths("legacy-import");
  const legacy = { identity: { name: "Legacy Lucy" }, facts: ["imported"] };
  fs.writeFileSync(paths.coreMemoryFile, JSON.stringify(legacy));
  initialize(paths);
  assert.deepEqual(read(paths.coreMemoryFile), legacy);
});

test("defaults seed when neither SQLite nor legacy JSON has memory", () => {
  const paths = createPaths("default-seed");
  initialize(paths);
  assert.equal(read(paths.coreMemoryFile).identity.name, "Lucy");
  assert.deepEqual(read(paths.userMemoryFile), { users: {} });
  assert.deepEqual(read(paths.sessionMemoryFile), { users: {} });
});

test("repeated initialization preserves existing SQLite data", () => {
  const paths = createPaths("idempotent");
  storage.writeDocument(paths.coreMemoryFile, seedCore);
  const service = new MemoryService();
  service.initialize(paths);
  service.initialize(paths);
  new MemoryService().initialize(paths);
  assert.deepEqual(read(paths.coreMemoryFile), seedCore);
});

test("invalid legacy JSON does not replace valid SQLite data", () => {
  const paths = createPaths("invalid-legacy");
  storage.writeDocument(paths.coreMemoryFile, seedCore);
  fs.writeFileSync(paths.coreMemoryFile, "{invalid json");
  initialize(paths);
  assert.deepEqual(read(paths.coreMemoryFile), seedCore);
});

test("SQLite document takes precedence over differing legacy JSON", () => {
  const paths = createPaths("both-sources");
  storage.writeDocument(paths.coreMemoryFile, seedCore);
  fs.writeFileSync(paths.coreMemoryFile, JSON.stringify({ identity: { name: "Legacy override" } }));
  initialize(paths);
  assert.deepEqual(read(paths.coreMemoryFile), seedCore);
});

test("failed document write aborts initialization and allows safe retry", () => {
  const paths = createPaths("write-failure-retry");
  const preservedUserMemory = { users: { owner: { items: [{ content: "keep" }] } } };
  storage.writeDocument(paths.coreMemoryFile, seedCore);
  storage.writeDocument(paths.userMemoryFile, preservedUserMemory);
  storage.db.exec(`
    CREATE TEMP TRIGGER reject_session_seed
    BEFORE INSERT ON documents
    WHEN NEW.key = '${paths.sessionMemoryFile.replaceAll("'", "''")}'
    BEGIN
      SELECT RAISE(ABORT, 'forced initialization write failure');
    END;
  `);

  const service = new MemoryService();
  assert.throws(() => service.initialize(paths), /forced initialization write failure/);
  assert.equal(service.initialized, false);
  assert.deepEqual(read(paths.coreMemoryFile), seedCore);
  assert.deepEqual(read(paths.userMemoryFile), preservedUserMemory);

  storage.db.exec("DROP TRIGGER reject_session_seed");
  service.initialize(paths);
  assert.equal(service.initialized, true);
  assert.deepEqual(read(paths.coreMemoryFile), seedCore);
  assert.deepEqual(read(paths.userMemoryFile), preservedUserMemory);
  assert.deepEqual(read(paths.sessionMemoryFile), { users: {} });
});

test.after(() => {
  storage.closeDatabase();
  fs.rmSync(tempRoot, { recursive: true, force: true });
});
