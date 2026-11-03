import { osuSkillModel } from "./osuSkillModel.js";

export const evaluateNoteHit = (note, hitWindows, skillModel, currentCombo) => {
  const aimOffset = skillModel.sampleAimOffset(currentCombo);
  const timingOffset = skillModel.sampleTimingOffset();

  const aimDistance = Math.hypot(aimOffset.offsetX, aimOffset.offsetY);
  const absTimeDelta = Math.abs(timingOffset);

  // If aim missed circle boundaries completely -> MISS
  if (aimDistance > note.radius) {
    return {
      result: "miss",
      scoreValue: 0,
      aimDistance,
      timingOffset,
      note,
    };
  }

  // Check timing windows
  if (absTimeDelta <= hitWindows[300]) {
    return {
      result: "300",
      scoreValue: 300,
      aimDistance,
      timingOffset,
      note,
    };
  }

  if (absTimeDelta <= hitWindows[100]) {
    return {
      result: "100",
      scoreValue: 100,
      aimDistance,
      timingOffset,
      note,
    };
  }

  if (absTimeDelta <= hitWindows[50]) {
    return {
      result: "50",
      scoreValue: 50,
      aimDistance,
      timingOffset,
      note,
    };
  }

  return {
    result: "miss",
    scoreValue: 0,
    aimDistance,
    timingOffset,
    note,
  };
};

export const simulateMatch = (beatmap, skillModel = osuSkillModel) => {
  const { hitObjects, hitWindows } = beatmap;

  let currentCombo = 0;
  let maxCombo = 0;
  let count300 = 0;
  let count100 = 0;
  let count50 = 0;
  let countMiss = 0;
  let totalScore = 0;

  const hitLogs = [];

  for (const note of hitObjects) {
    const hit = evaluateNoteHit(note, hitWindows, skillModel, currentCombo);
    hitLogs.push(hit);

    if (hit.result === "miss") {
      countMiss += 1;
      currentCombo = 0;
    } else {
      if (hit.result === "300") count300 += 1;
      else if (hit.result === "100") count100 += 1;
      else if (hit.result === "50") count50 += 1;

      currentCombo += 1;
      if (currentCombo > maxCombo) {
        maxCombo = currentCombo;
      }
      totalScore += hit.scoreValue * (1 + currentCombo * 0.05);
    }
  }

  const totalHits = count300 + count100 + count50;
  const totalNotes = totalHits + countMiss;
  const accuracy = totalNotes > 0
    ? Number((((count300 * 300 + count100 * 100 + count50 * 50) / (totalNotes * 300)) * 100).toFixed(2))
    : 0;

  // Update leveling / EXP in model
  const progression = skillModel.addMatchResult({
    hits: totalHits,
    misses: countMiss,
    maxCombo,
    score: Math.round(totalScore),
  });

  return {
    title: beatmap.metadata?.title || "Beatmap",
    artist: beatmap.metadata?.artist || "Unknown",
    totalNotes,
    hits: {
      c300: count300,
      c100: count100,
      c50: count50,
      miss: countMiss,
    },
    maxCombo,
    score: Math.round(totalScore),
    accuracy,
    progression,
  };
};
