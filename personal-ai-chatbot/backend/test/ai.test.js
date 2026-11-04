import test from "node:test";
import assert from "node:assert/strict";
import { detectEmotion } from "../src/services/ai/emotionDetector.js";
import { aiService } from "../src/services/ai/aiService.js";
import { buildFallbackReply } from "../src/services/ai/fallbackResponder.js";
import { removeStageDirections } from "../src/services/ai/responseText.js";
import { ROLES } from "../src/config/constants.js";

test("Emotion Detector: Happy sentiment", () => {
  const result = detectEmotion("Wah aku senang sekali hari ini, mantap!");
  assert.equal(result.emotion, "senang");
  assert.ok(result.intensity > 0.5);
});

test("Emotion Detector: Gratitude sentiment", () => {
  const result = detectEmotion("Terima kasih banyak atas bantuannya ya!");
  assert.equal(result.emotion, "terima_kasih");
  assert.ok(result.intensity > 0.5);
});

test("Emotion Detector: Angry / irritated sentiment", () => {
  const result = detectEmotion("Aduh kesal banget, error terus!");
  assert.equal(result.emotion, "kesal");
});

test("AI Service: Prompt Builder includes WIB time and owner context", () => {
  const prompt = aiService.buildSystemPrompt(
    { identity: { name: "Lucy", creator: "Alfaa" }, rules: ["Rahasia"] },
    [{ content: "Suka kopi", category: "preference" }],
    [{ content: "Sedang ngoding" }],
    { role: ROLES.OWNER }
  );

  assert.ok(prompt.includes("Lucy"));
  assert.ok(prompt.includes("Alfaa"));
  assert.ok(prompt.includes("WIB"));
  assert.ok(prompt.includes("Suka kopi"));
  assert.match(prompt, /jahil/i);
  assert.match(prompt, /Tetap Lucy/i);
  assert.match(prompt, /Hindari filler/i);
  assert.match(prompt, /emotikon keyboard/i);
  assert.match(prompt, /tanda bintang/i);
});

test("AI Service: Generates mock / fallback response gracefully", async () => {
  const res = await aiService.generateReply({
    userId: "test_ai_user",
    userRole: ROLES.USER,
    message: "Halo Lucy, siapa namamu?",
    preferredProvider: "mock",
  });

  assert.ok(res.reply);
  assert.equal(res.mode, "mock");
});

test("AI response cleanup removes starred stage directions but keeps keyboard emoticons", () => {
  assert.equal(removeStageDirections("Halo *tertawa kecil* Alfaa! >-<"), "Halo Alfaa! >-<");
  assert.equal(removeStageDirections("*tersenyum* Halo, Alfaa!"), "Halo, Alfaa!");
  assert.equal(removeStageDirections("_menghela napas_ Halo!"), "Halo!");
  assert.equal(removeStageDirections("Halo ~~tertawa~~ Alfaa"), "Halo Alfaa");
  assert.equal(removeStageDirections("_tersenyum_ Halo Alfaa!"), "Halo Alfaa!");
  assert.equal(removeStageDirections("Halo (tertawa kecil) Alfaa!"), "Halo Alfaa!");
  assert.equal(removeStageDirections("Halo, tersenyum. Aku bisa bantu!"), "Halo. Aku bisa bantu!");
  assert.equal(removeStageDirections("Halo [ekspresi senang] Alfaa!"), "Halo Alfaa!");
  assert.equal(removeStageDirections("*ketawa kecil* Aku bisa bantu."), "Aku bisa bantu.");
  assert.equal(removeStageDirections("/tertawa/ Aku paham."), "Aku paham.");
  assert.equal(removeStageDirections('berdiri ceria "Aku selalu semangat kalau deket Alfaa! Kamu gimana? Jangan lupa minum air hari ini~ :sweat_drops:"'), '"Aku selalu semangat kalau deket Alfaa! Kamu gimana? Jangan lupa minum air hari ini~ :sweat_drops:"');
  assert.equal(removeStageDirections("Lagi ngapain nih? tutup mata 😆 Eh, ada kabar."), "Lagi ngapain nih? Eh, ada kabar.");
  assert.equal(removeStageDirections('ceria "Aku selalu semangat kalau dekat Alfaa!"'), '"Aku selalu semangat kalau dekat Alfaa!"');
  assert.match(removeStageDirections("*nagih latihan lagi*"), /^(>-<|:3|;_;|\^_\^|T_T|\._\.|O_O)$/);
});
