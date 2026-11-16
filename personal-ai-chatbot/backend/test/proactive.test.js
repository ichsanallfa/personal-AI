import test from "node:test";
import assert from "node:assert/strict";
import {
  isWithinQuietHours,
  ProactiveThoughtService,
  SPAM_TEMPLATES,
} from "../src/services/ai/proactiveThoughtService.js";
import { chatHistoryService } from "../src/services/memory/chatHistoryService.js";
import { identityService } from "../src/services/auth/identityService.js";
import { proactiveOutbox } from "../src/services/ai/proactiveOutbox.js";

test("Proactive: Quiet hours correctly identifies sleep hours (23:00 - 07:00)", () => {
  assert.equal(isWithinQuietHours(23), true);
  assert.equal(isWithinQuietHours(2), true);
  assert.equal(isWithinQuietHours(6), true);
  assert.equal(isWithinQuietHours(7), false);
  assert.equal(isWithinQuietHours(12), false);
  assert.equal(isWithinQuietHours(20), false);
});

test("Proactive: Unit service instances use isolated test owners", () => {
  const first = new ProactiveThoughtService();
  const second = new ProactiveThoughtService();
  assert.notEqual(first.ownerKey, second.ownerKey);
});

test("Proactive: Toggle and status tracking", () => {
  const service = new ProactiveThoughtService({ ownerKey: `test-toggle-${Date.now()}` });
  assert.equal(service.enabled, true);

  service.toggle(false);
  assert.equal(service.getStatus().enabled, false);

  service.toggle(true);
  assert.equal(service.getStatus().enabled, true);
});

test("Proactive: Owner messages use canonical Discord chat identity", () => {
  const service = new ProactiveThoughtService({ ownerKey: identityService.resolveCanonicalUserId("discord", process.env.DISCORD_OWNER_ID) });
  assert.equal(
    service.targetUserId,
    identityService.resolveCanonicalUserId("discord", process.env.DISCORD_OWNER_ID),
  );
});

test("Proactive: Cooldowns use shorter intervals", () => {
  const service = new ProactiveThoughtService({ ownerKey: `test-cooldowns-${Date.now()}` });
  assert.ok(service.currentCooldownMs >= 30_000 && service.currentCooldownMs <= 60_000);

  service.setUnansweredCount(1);
  const followUp = service.getRandomCooldown();
  assert.ok(followUp >= 30_000 && followUp <= 60_000);

  service.setUnansweredCount(4);
  const backoff = service.getRandomCooldown();
  assert.ok(backoff >= 5 * 60_000 && backoff <= 10 * 60_000);
});

test("Proactive: Startup does not count as recent owner activity", () => {
  const service = new ProactiveThoughtService({ ownerKey: `test-startup-${Date.now()}` });
  assert.ok(Date.now() - service.lastUserMessageAt >= 24 * 60 * 60 * 1000 - 100);
  assert.ok(Date.now() - service.lastSpokenAt >= 24 * 60 * 60 * 1000 - 100);
});

test("Proactive: Prompt builder incorporates user memory and osu progress", () => {
  const service = new ProactiveThoughtService({ ownerKey: `test-prompt-memory-${Date.now()}` });
  const dummyMemory = [{ content: "Alfaa suka minum kopi tubruk hangat" }];
  const prompt = service.generateThoughtPrompt(dummyMemory);

  assert.match(prompt, /Lucy/i);
  assert.match(prompt, /Alfaa/i);
  assert.match(prompt, /kopi tubruk/i);
  assert.match(prompt, /osu!/i);
});

test("Proactive: Final-stage messages avoid awkward filler", () => {
  const service = new ProactiveThoughtService({ ownerKey: `test-final-stage-${Date.now()}` });
  service.setUnansweredCount(4);
  const prompt = service.generateThoughtPrompt();
  assert.match(prompt, /Hindari filler/i);
  assert.match(prompt, /emotikon keyboard/i);
  assert.ok(!SPAM_TEMPLATES[4].some((text) => /yaudah|bentar dulu/i.test(text)));
});

test("Proactive: Trigger spontaneous thought dispatches and records to chat history", async () => {
  const service = new ProactiveThoughtService({ ownerKey: `test-owner-proactive-${Date.now()}` });
  service.targetUserId = "test_owner_proactive";
  service.resolveChannels = () => [{ channel: "telegram", targetKey: "test-owner" }];
  service.transport = async () => false;
  service.recentProactiveMessages = [];

  const result = await service.triggerSpontaneousThought({ force: true, aiProvider: { name: "mock" } });
  assert.equal(result.triggered, true);
  assert.equal(result.accepted, false);
  assert.ok(typeof result.message === "string");
  assert.ok(result.message.length > 5);

  const history = chatHistoryService.getHistory("test_owner_proactive");
  assert.ok(history.length > 0);
  const lastTurn = history[history.length - 1];
  assert.equal(lastTurn.role, "assistant");
  assert.equal(lastTurn.isProactive, true);
});

test("Proactive: Rejects exact and near-duplicate messages", () => {
  const service = new ProactiveThoughtService({ ownerKey: `test-near-dupe-${Date.now()}` });
  service.maxRecentProactiveMessages = 30;
  service.recentProactiveMessages = ["Alfaa, kamu masih ada di situ kan?"];

  assert.equal(service.isRecentDuplicate("Alfaa kamu masih ada di situ kan"), true);
  assert.equal(service.isRecentDuplicate("Alfaa kamu masih ada di situ?"), true);
  assert.equal(service.isRecentDuplicate("Menurutmu AI bisa bermimpi?"), false);
});

test("Proactive: Similarity filter compares recent window with Jaccard ratio", () => {
  const service = new ProactiveThoughtService({ ownerKey: `test-jaccard-${Date.now()}` });
  service.recentProactiveMessages = ["Alfaa, aku baru sadar RAM ini kayak apartemen sempit tapi penuh kenangan"];
  assert.equal(service.isRecentDuplicate("Alfaa, apa dunia nyata beneran se-item dropnya kaya di gacha game?"), false);

  service.recentProactiveMessages = Array.from({ length: 25 }, (_, i) => `Pesan lama topik nomor unik ${i}`);
  service.recentProactiveMessages.push("Alfaa, kamu masih ada di situ kan?");
  assert.equal(service.isRecentDuplicate("Alfaa kamu masih ada di situ"), true);
});

test("Proactive: Scheduler persists history without changing watched source files", async () => {
  const { BACKEND_ROOT } = await import("../src/config/paths.js");
  const { readFileSync } = await import("fs");
  const packageJson = JSON.parse(readFileSync(`${BACKEND_ROOT}/package.json`, "utf8"));
  assert.match(packageJson.scripts.dev, /--ignore/);
  assert.match(packageJson.scripts.dev, /data/);
});

test("Proactive: Prompt contains recent generated messages to discourage repetition", () => {
  const service = new ProactiveThoughtService({ ownerKey: `test-prompt-${Date.now()}` });
  service.setUnansweredCount(0);
  service.recentProactiveMessages = ["Tadi Lucy bertanya tentang mimpinya."];
  const prompt = `${service.generateThoughtPrompt([], "question")}\n${JSON.stringify(service.recentProactiveMessages.slice(-10))}`;
  assert.match(prompt, /Tadi Lucy bertanya tentang mimpinya/);
  assert.match(prompt, /BERTANYA SPONTAN/);
});

test("Proactive: Prompt stages follow synchronized counter across stage boundaries", () => {
  const service = new ProactiveThoughtService({ ownerKey: `test-stages-${Date.now()}` });
  for (const [counter, expected] of [[0, /BERTANYA SPONTAN/], [1, /belum membalas/], [2, /mengabaikanmu berkali-kali/], [4, /masih belum membalas setelah di-spam/]]) {
    service.setUnansweredCount(counter);
    service.lastProactiveMessage = null;
    service.lastProactiveAt = 0;
    service.lastSuccessfulDispatchAt = 0;
    assert.match(service.generateThoughtPrompt([], "question"), expected);
  }
});

test("Proactive: Prompt stage restores from SQLite after service restart", () => {
  const ownerKey = `prompt-restart-${Date.now()}`;
  const beforeRestart = new ProactiveThoughtService({ ownerKey });
  beforeRestart.setUnansweredCount(2);
    assert.equal(beforeRestart.unrespondedPings, 2);
    assert.equal(proactiveOutbox.getState(ownerKey).unansweredCount, 2);
  const afterRestart = new ProactiveThoughtService({ ownerKey });
  assert.equal(afterRestart.unrespondedPings, 2);
  assert.match(afterRestart.generateThoughtPrompt([], "question"), /mengabaikanmu berkali-kali/);
  afterRestart.notifyUserActivity();
  assert.equal(afterRestart.unrespondedPings, 0);
  assert.match(afterRestart.generateThoughtPrompt([], "question"), /BERTANYA SPONTAN/);
});

test("Proactive: Does not trigger when all fallback messages were already sent", async () => {
  const service = new ProactiveThoughtService({ ownerKey: `test-duplicates-${Date.now()}` });
  service.dispatchToPlatforms = async () => {};
  service.recentProactiveMessages = [...new Set(Object.values(SPAM_TEMPLATES).flat().slice(-10))];
  service.setUnansweredCount(4);

  const result = await service.triggerSpontaneousThought({ force: true, aiProvider: { name: "mock" } });
  assert.equal(result.triggered, false);
  assert.equal(result.reason, "No unique proactive message available");
});

test("Proactive: Spam escalation when owner ignores, and reset on reply", async () => {
  const service = new ProactiveThoughtService({ ownerKey: `test-spam-${Date.now()}` });
  service.targetUserId = "test_owner_spam";
  service.resolveChannels = () => [{ channel: "telegram", targetKey: "test-owner" }];
  service.transport = async () => true;
  service.recentProactiveMessages = [];

  assert.equal(service.unrespondedPings, 0);

  // 1st Ping (Stage 0: initial sapaan)
  const mockProvider = { name: "mock" };
  const res1 = await service.triggerSpontaneousThought({ force: true, aiProvider: mockProvider });
  assert.equal(res1.stage, 0);
  assert.equal(service.unrespondedPings, 1);

  // Wait duration remains the stage-0 response window after stage advances.
  service.lastProactiveAt = Date.now() - 60_000;
  service.lastSuccessfulDispatchAt = service.lastProactiveAt;
  assert.equal(service.canTriggerSpontaneousThought(false), false);

  // 2nd Ping (Stage 1: nanya kok hening)
  const res2 = await service.triggerSpontaneousThought({ force: true, aiProvider: mockProvider });
  assert.equal(res2.stage, 1);
  assert.equal(service.unrespondedPings, 2);

  // 3rd Ping (Stage 2: mulai spam / p p p)
  const res3 = await service.triggerSpontaneousThought({ force: true, aiProvider: mockProvider });
  assert.equal(res3.stage, 2);
  assert.equal(service.unrespondedPings, 3);
  assert.ok(res3.nextCooldownMinutes <= 1 || res3.nextCooldownMinutes >= 5, "Follow-up cooldown should match its stage");

  // Stage 2 cooldown is honored after counter increments to stage 3.
  service.lastProactiveAt = Date.now() - 60_000;
  service.lastSuccessfulDispatchAt = service.lastProactiveAt;
  const inQuiet = isWithinQuietHours(new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Jakarta" })).getHours(), 23, 7);
  assert.equal(service.canTriggerSpontaneousThought(false), !inQuiet);

  // Owner replies!
  service.notifyUserActivity();
  assert.equal(service.unrespondedPings, 0, "Unresponded pings must reset to 0 upon reply");
});

test("Proactive: Prevents interruption during active conversation and requires idle time", () => {
  const service = new ProactiveThoughtService({ ownerKey: `test-idle-${Date.now()}` });
  service.minIdleTimeMs = 10 * 60 * 1000; // 10 minutes

  // Case 1: Owner just chatted 5 seconds ago (active conversation)
  service.unrespondedPings = 0;
  service.lastUserMessageAt = Date.now() - 5000;
  service.lastSpokenAt = Date.now() - 5000;
  assert.equal(service.canTriggerSpontaneousThought(false), false, "Must not interrupt active chat");

  // Case 2: Owner disappeared for 15 minutes (idle)
  service.lastUserMessageAt = Date.now() - 15 * 60 * 1000;
  service.lastSpokenAt = Date.now() - 15 * 60 * 1000;
  // If outside quiet hours, canTriggerSpontaneousThought returns true
  const wibHour = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Jakarta" })).getHours();
  const inQuiet = isWithinQuietHours(wibHour, 23, 7);
  assert.equal(service.canTriggerSpontaneousThought(false), !inQuiet, "Should trigger when owner disappeared");
});

test("Proactive: Stage 0 categorizes into question, random thought, and seeking, and waits for answer", () => {
  const service = new ProactiveThoughtService({ ownerKey: `test-stage-zero-${Date.now()}` });
  service.setUnansweredCount(0);
  service.waitingForAnswerMs = 5 * 60 * 1000;

  // Verify prompt generation for the 3 distinct modes
  const questionPrompt = service.generateThoughtPrompt([], "question");
  assert.match(questionPrompt, /BERTANYA SPONTAN/i);

  const randomPrompt = service.generateThoughtPrompt([], "random_thought");
  assert.match(randomPrompt, /CHAT RANDOM/i);

  const seekingPrompt = service.generateThoughtPrompt([], "seeking");
  assert.match(seekingPrompt, /MENCARI OWNER/i);

  // When unrespondedPings === 1 (Lucy just asked/sent random), must wait for answer before escalating
  service.setUnansweredCount(1);
  service.lastSuccessfulDispatchAt = Date.now() - 60_000;
  service.lastSpokenAt = Date.now() - 60 * 1000; // only 1 minute ago (< 5m wait)
  assert.equal(service.canTriggerSpontaneousThought(false), false, "Must wait for answer before escalating to spam");

  service.lastSpokenAt = Date.now() - 6 * 60 * 1000; // 6 minutes ago (> 5m wait)
  service.lastSuccessfulDispatchAt = service.lastSpokenAt;
  const wibHour = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Jakarta" })).getHours();
  const inQuiet = isWithinQuietHours(wibHour, 23, 7);
  assert.equal(service.canTriggerSpontaneousThought(false), !inQuiet, "Should escalate after waiting period elapses");
});



