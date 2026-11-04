import test from "node:test";
import assert from "node:assert/strict";
import {
  isWithinQuietHours,
  ProactiveThoughtService,
  SPAM_TEMPLATES,
} from "../src/services/ai/proactiveThoughtService.js";
import { chatHistoryService } from "../src/services/memory/chatHistoryService.js";
import { identityService } from "../src/services/auth/identityService.js";

test("Proactive: Quiet hours correctly identifies sleep hours (23:00 - 07:00)", () => {
  assert.equal(isWithinQuietHours(23), true);
  assert.equal(isWithinQuietHours(2), true);
  assert.equal(isWithinQuietHours(6), true);
  assert.equal(isWithinQuietHours(7), false);
  assert.equal(isWithinQuietHours(12), false);
  assert.equal(isWithinQuietHours(20), false);
});

test("Proactive: Toggle and status tracking", () => {
  const service = new ProactiveThoughtService();
  assert.equal(service.enabled, true);

  service.toggle(false);
  assert.equal(service.getStatus().enabled, false);

  service.toggle(true);
  assert.equal(service.getStatus().enabled, true);
});

test("Proactive: Owner messages use canonical Discord chat identity", () => {
  const service = new ProactiveThoughtService();
  assert.equal(
    service.targetUserId,
    identityService.resolveCanonicalUserId("discord", process.env.DISCORD_OWNER_ID),
  );
});

test("Proactive: Cooldowns use shorter intervals", () => {
  const service = new ProactiveThoughtService();
  assert.ok(service.currentCooldownMs >= 30_000 && service.currentCooldownMs <= 60_000);

  service.unrespondedPings = 1;
  const followUp = service.getRandomCooldown();
  assert.ok(followUp >= 30_000 && followUp <= 60_000);

  service.unrespondedPings = 4;
  const backoff = service.getRandomCooldown();
  assert.ok(backoff >= 5 * 60_000 && backoff <= 10 * 60_000);
});

test("Proactive: Prompt builder incorporates user memory and osu progress", () => {
  const service = new ProactiveThoughtService();
  const dummyMemory = [{ content: "Alfaa suka minum kopi tubruk hangat" }];
  const prompt = service.generateThoughtPrompt(dummyMemory);

  assert.match(prompt, /Lucy/i);
  assert.match(prompt, /Alfaa/i);
  assert.match(prompt, /kopi tubruk/i);
  assert.match(prompt, /osu!/i);
});

test("Proactive: Final-stage messages avoid awkward filler", () => {
  const service = new ProactiveThoughtService();
  service.unrespondedPings = 4;
  const prompt = service.generateThoughtPrompt();
  assert.match(prompt, /Hindari filler/i);
  assert.match(prompt, /emotikon keyboard/i);
  assert.ok(!SPAM_TEMPLATES[4].some((text) => /yaudah|bentar dulu/i.test(text)));
});

test("Proactive: Trigger spontaneous thought dispatches and records to chat history", async () => {
  const service = new ProactiveThoughtService();
  service.targetUserId = "test_owner_proactive";
  service.dispatchToPlatforms = async () => {};

  const result = await service.triggerSpontaneousThought({ force: true });
  assert.equal(result.triggered, true);
  assert.ok(typeof result.message === "string");
  assert.ok(result.message.length > 5);

  const history = chatHistoryService.getHistory("test_owner_proactive");
  assert.ok(history.length > 0);
  const lastTurn = history[history.length - 1];
  assert.equal(lastTurn.role, "assistant");
  assert.equal(lastTurn.isProactive, true);
});

test("Proactive: Spam escalation when owner ignores, and reset on reply", async () => {
  const service = new ProactiveThoughtService();
  service.targetUserId = "test_owner_spam";
  service.dispatchToPlatforms = async () => {};

  assert.equal(service.unrespondedPings, 0);

  // 1st Ping (Stage 0: initial sapaan)
  const res1 = await service.triggerSpontaneousThought({ force: true });
  assert.equal(res1.stage, 0);
  assert.equal(service.unrespondedPings, 1);

  // 2nd Ping (Stage 1: nanya kok hening)
  const res2 = await service.triggerSpontaneousThought({ force: true });
  assert.equal(res2.stage, 1);
  assert.equal(service.unrespondedPings, 2);

  // 3rd Ping (Stage 2: mulai spam / p p p)
  const res3 = await service.triggerSpontaneousThought({ force: true });
  assert.equal(res3.stage, 2);
  assert.equal(service.unrespondedPings, 3);
  assert.ok(res3.nextCooldownMinutes <= 1, "Follow-up cooldown should be 30-60 seconds");

  // Owner replies!
  service.notifyUserActivity();
  assert.equal(service.unrespondedPings, 0, "Unresponded pings must reset to 0 upon reply");
});

test("Proactive: Prevents interruption during active conversation and requires idle time", () => {
  const service = new ProactiveThoughtService();
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
  const service = new ProactiveThoughtService();
  service.waitingForAnswerMs = 5 * 60 * 1000;

  // Verify prompt generation for the 3 distinct modes
  const questionPrompt = service.generateThoughtPrompt([], "question");
  assert.match(questionPrompt, /BERTANYA SPONTAN/i);

  const randomPrompt = service.generateThoughtPrompt([], "random_thought");
  assert.match(randomPrompt, /CHAT RANDOM/i);

  const seekingPrompt = service.generateThoughtPrompt([], "seeking");
  assert.match(seekingPrompt, /MENCARI OWNER/i);

  // When unrespondedPings === 1 (Lucy just asked/sent random), must wait for answer before escalating
  service.unrespondedPings = 1;
  service.lastSpokenAt = Date.now() - 60 * 1000; // only 1 minute ago (< 5m wait)
  assert.equal(service.canTriggerSpontaneousThought(false), false, "Must wait for answer before escalating to spam");

  service.lastSpokenAt = Date.now() - 6 * 60 * 1000; // 6 minutes ago (> 5m wait)
  const wibHour = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Jakarta" })).getHours();
  const inQuiet = isWithinQuietHours(wibHour, 23, 7);
  assert.equal(service.canTriggerSpontaneousThought(false), !inQuiet, "Should escalate after waiting period elapses");
});



