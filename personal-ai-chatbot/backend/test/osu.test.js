import test from "node:test";
import assert from "node:assert/strict";
import { parseBeatmapContent } from "../src/services/game/osu/beatmapParser.js";
import { computeSkillProfile, OsuSkillModel } from "../src/services/game/osu/osuSkillModel.js";
import { simulateMatch } from "../src/services/game/osu/osuSimulator.js";
import { generateLucyGameReaction } from "../src/services/game/osu/osuGameService.js";

const sampleBeatmap = `osu file format v14

[General]
AudioFilename: audio.mp3
Mode: 0

[Metadata]
Title:Test Song
Artist:Test Artist
Creator:Alfaa
Version:Insane

[Difficulty]
HPDrainRate:5
CircleSize:4
OverallDifficulty:8
ApproachRate:9

[HitObjects]
256,192,1000,1,0,0:0:0:0:
300,200,1500,1,0,0:0:0:0:
350,220,2000,1,0,0:0:0:0:
400,240,2500,1,0,0:0:0:0:
`;

test("Beatmap Parser: extracts metadata and hit objects", () => {
  const parsed = parseBeatmapContent(sampleBeatmap);
  assert.equal(parsed.metadata.title, "Test Song");
  assert.equal(parsed.metadata.artist, "Test Artist");
  assert.equal(parsed.difficulty.cs, 4);
  assert.equal(parsed.difficulty.ar, 9);
  assert.equal(parsed.totalObjects, 4);
  assert.equal(parsed.hitObjects[0].time, 1000);
});

test("Osu Skill Profile: scaling noise from lvl 1 to lvl 20", () => {
  const lvl1 = computeSkillProfile(1);
  const lvl20 = computeSkillProfile(20);

  assert.ok(lvl1.aimNoiseSigma > lvl20.aimNoiseSigma, "Lvl 1 should have much more aim jitter than Lvl 20");
  assert.ok(lvl1.timingNoiseMs > lvl20.timingNoiseMs, "Lvl 1 should have more timing error than Lvl 20");
  assert.ok(lvl1.reactionDelayMs > lvl20.reactionDelayMs, "Lvl 1 should react slower than Lvl 20");
});

test("Osu Skill Model: adds EXP and handles level progression", () => {
  const model = new OsuSkillModel();
  model.reset();

  const statusInitial = model.getStatus();
  assert.equal(statusInitial.level, 1);

  // Add large match result to trigger level up
  const res = model.addMatchResult({ hits: 150, misses: 2, maxCombo: 100, score: 500000 });
  assert.ok(res.expGained > 0);
  assert.ok(res.newLevel >= 2, "Should level up after high score match");
});

test("Osu Simulator: completes match simulation and calculates accuracy", () => {
  const model = new OsuSkillModel();
  const parsed = parseBeatmapContent(sampleBeatmap);
  const result = simulateMatch(parsed, model);

  assert.equal(result.totalNotes, 4);
  assert.ok(result.accuracy >= 0 && result.accuracy <= 100);
  assert.ok(typeof result.score === "number");
});

test("Osu Game Reaction: produces cute dialog for Lucy", () => {
  const levelUpReaction = generateLucyGameReaction({
    progression: { leveledUp: true, newLevel: 2 },
    accuracy: 85,
    hits: { miss: 3 },
    maxCombo: 20,
  });
  assert.match(levelUpReaction, /Level 2/i);

  const missReaction = generateLucyGameReaction({
    progression: { leveledUp: false, newLevel: 1 },
    accuracy: 60,
    hits: { miss: 10 },
    maxCombo: 5,
  });
  assert.match(missReaction, /miss/i);
});
