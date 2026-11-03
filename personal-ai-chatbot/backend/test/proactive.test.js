import test from "node:test";
import assert from "node:assert/strict";
import {
  isWithinQuietHours,
  ProactiveThoughtService,
} from "../src/services/ai/proactiveThoughtService.js";
import { chatHistoryService } from "../src/services/memory/chatHistoryService.js";

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

test("Proactive: Prompt builder incorporates user memory and osu progress", () => {
  const service = new ProactiveThoughtService();
  const dummyMemory = [{ content: "Alfaa suka minum kopi tubruk hangat" }];
  const prompt = service.generateThoughtPrompt(dummyMemory);

  assert.match(prompt, /Lucy/i);
  assert.match(prompt, /Alfaa/i);
  assert.match(prompt, /kopi tubruk/i);
  assert.match(prompt, /osu!/i);
});

test("Proactive: Trigger spontaneous thought dispatches and records to chat history", async () => {
  const service = new ProactiveThoughtService();
  service.targetUserId = "test_owner_proactive";

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
  assert.ok(res3.nextCooldownMinutes <= 4.5, "Spam mode cooldown should be short (1.5-4 mins)");

  // Owner replies!
  service.notifyUserActivity();
  assert.equal(service.unrespondedPings, 0, "Unresponded pings must reset to 0 upon reply");
});

