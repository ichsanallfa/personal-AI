import test from "node:test";
import assert from "node:assert/strict";
import { memoryService } from "../src/services/memory/memoryService.js";
import { classifyMemoryCandidate, normalizeForCompare } from "../src/services/memory/memoryClassifier.js";
import { MEMORY_CATEGORIES } from "../src/config/constants.js";

test("Memory Classifier: Classify personal preference and importance", () => {
  const result = classifyMemoryCandidate("Saya sangat suka makanan nasi goreng dan matcha latte");
  assert.equal(result.type, "core");
  assert.equal(result.category, MEMORY_CATEGORIES.PREFERENCE);
  assert.ok(result.importance >= 4);
});

test("Memory Classifier: Ignore generic questions and short banter", () => {
  const q1 = classifyMemoryCandidate("Jam berapa sekarang?");
  assert.equal(q1.type, "short");

  const q2 = classifyMemoryCandidate("halo");
  assert.equal(q2.type, "short");
});

test("Memory Service: Add user long-term memory and prevent duplicates", () => {
  const testUser = `test_user_${Date.now()}`;
  const item1 = memoryService.addUserMemoryItem(testUser, "Saya bekerja sebagai software engineer", MEMORY_CATEGORIES.WORK, 4);
  assert.ok(item1);
  assert.equal(item1.category, MEMORY_CATEGORIES.WORK);

  // Duplicate submission with different casing/punctuation
  const item2 = memoryService.addUserMemoryItem(testUser, " saya bekerja sebagai software engineer! ");
  assert.equal(item2, null, "Duplicate memory must be rejected");

  const mem = memoryService.getUserMemory(testUser);
  assert.equal(mem.items.length, 1);
});

test("Memory Service: Temporary memory TTL expiration", () => {
  const testUser = `test_temp_${Date.now()}`;
  memoryService.addTemporaryMemory(testUser, "Topik pembicaraan singkat A");
  memoryService.addTemporaryMemory(testUser, "Topik pembicaraan singkat B");

  const temp = memoryService.getTemporaryMemory(testUser);
  assert.equal(temp.length, 2);
  assert.ok(temp[0].expiresAt > Date.now());
});

test("Memory Service: Core memory management", () => {
  const core = memoryService.getCoreMemory();
  assert.ok(core.identity?.name);
  assert.ok(Array.isArray(core.facts));
  assert.ok(Array.isArray(core.rules));
});

test("Memory Service: AI decision stores durable facts and keeps casual chat temporary", async () => {
  const testUser = `test_ai_memory_${Date.now()}`;
  const provider = {
    name: "test",
    isAvailable: () => true,
    generateCompletion: async ({ systemPrompt }) => JSON.stringify(systemPrompt.includes("Memori milik user saat ini")
      ? { actions: [{
          type: "long_term",
          content: "User bekerja sebagai software engineer.",
          category: "work",
          importance: 4,
        }] }
      : { reply: "Dicatat." }),
  };

  const saved = await memoryService.processChatMessageWithAI({
    userId: testUser,
    userRole: "user",
    message: "Aku kerja sebagai software engineer di perusahaan game.",
    aiProvider: provider,
  });
  assert.equal(saved.decision.actions[0].type, "long_term");
  assert.equal(saved.item?.content, "User bekerja sebagai software engineer.");
  const savedItem = memoryService.getUserMemory(testUser).items[0];
  assert.equal(savedItem.content, "User bekerja sebagai software engineer.");
  assert.equal(savedItem.category, MEMORY_CATEGORIES.WORK);

  provider.generateCompletion = async ({ systemPrompt }) => JSON.stringify(systemPrompt.includes("Memori milik user saat ini")
    ? { actions: [{ type: "temporary" }] }
    : { reply: "Paham." });
  const casual = await memoryService.processChatMessageWithAI({
    userId: testUser,
    userRole: "user",
    message: "Wkwk itu lucu banget.",
    aiProvider: provider,
  });
  assert.equal(casual.results.length, 0);
  assert.equal(memoryService.getUserMemory(testUser).items.length, 1);
});

test("Memory Service: AI can update or delete only existing user memory IDs", async () => {
  const testUser = `test_ai_memory_edit_${Date.now()}`;
  const original = memoryService.addUserMemoryItem(testUser, "User tinggal di Bandung.", MEMORY_CATEGORIES.PERSONAL_INFO, 4);
  const provider = {
    name: "test",
    isAvailable: () => true,
    generateCompletion: async () => JSON.stringify({ actions: [
      { type: "update", id: original.id, content: "User tinggal di Yogyakarta.", category: "personal_info", importance: 4 },
      { type: "delete", id: "not-owned-or-missing" },
    ] }),
  };

  const result = await memoryService.processChatMessageWithAI({
    userId: testUser,
    userRole: "user",
    message: "Aku sudah pindah ke Yogyakarta.",
    aiProvider: provider,
  });
  assert.equal(result.results[0].success, true);
  assert.equal(result.results.length, 1, "Unknown IDs must be rejected");
  assert.equal(memoryService.getUserMemory(testUser).items[0].content, "User tinggal di Yogyakarta.");
});

test("Memory Service: Rejects memory containing credential markers", () => {
  const testUser = `test_secret_memory_${Date.now()}`;
  assert.equal(memoryService.addUserMemoryItem(testUser, "API key: sk-example-secret", MEMORY_CATEGORIES.GENERAL, 5), null);
  assert.equal(memoryService.getUserMemory(testUser).items.length, 0);
});
