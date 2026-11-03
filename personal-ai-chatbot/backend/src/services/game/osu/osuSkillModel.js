import { OSU_DATA_FILE } from "../../../config/paths.js";
import { loadJsonFile, saveJsonFile } from "../../../storage/jsonStorage.js";

// Box-Muller transform for realistic Gaussian noise
export const sampleGaussian = (mean = 0, stdDev = 1) => {
  let u = 0;
  let v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  const num = Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
  return num * stdDev + mean;
};

export const computeSkillProfile = (level = 1) => {
  const boundedLevel = Math.max(1, Math.min(20, Math.floor(level)));
  const t = (boundedLevel - 1) / 19; // 0.0 at level 1, 1.0 at level 20

  return {
    level: boundedLevel,
    aimNoiseSigma: Math.round(38 - t * 34),       // 38px at lvl 1 -> 4px at lvl 20
    timingNoiseMs: Math.round(65 - t * 57),       // 65ms at lvl 1 -> 8ms at lvl 20
    reactionDelayMs: Math.round(280 - t * 150),   // 280ms at lvl 1 -> 130ms at lvl 20
    panicFactor: Number((1.4 - t * 0.4).toFixed(2)), // 1.4x panic at lvl 1 -> 1.0x at lvl 20
  };
};

export class OsuSkillModel {
  constructor() {
    this.state = null;
  }

  load() {
    if (this.state) return this.state;
    this.state = loadJsonFile(OSU_DATA_FILE, {
      level: 1,
      exp: 0,
      totalPlays: 0,
      totalHits: 0,
      totalMisses: 0,
      highestCombo: 0,
      updatedAt: Date.now(),
    });
    return this.state;
  }

  save() {
    if (!this.state) return;
    this.state.updatedAt = Date.now();
    saveJsonFile(OSU_DATA_FILE, this.state);
  }

  getExpForNextLevel(level) {
    return level * 350; // Level 1 needs 350 EXP, level 2 needs 700 EXP...
  }

  getStatus() {
    const data = this.load();
    const profile = computeSkillProfile(data.level);
    const expNeeded = this.getExpForNextLevel(data.level);

    return {
      ...data,
      profile,
      expNeeded,
      progressPercent: Math.min(100, Math.round((data.exp / expNeeded) * 100)),
    };
  }

  sampleAimOffset(currentCombo = 0) {
    const data = this.load();
    const profile = computeSkillProfile(data.level);
    // Panic multiplier scales jitter during high combos at lower levels
    const comboPressure = Math.min(1.5, 1.0 + (currentCombo / 100) * (profile.panicFactor - 1.0));
    const effectiveSigma = profile.aimNoiseSigma * comboPressure;

    return {
      offsetX: Math.round(sampleGaussian(0, effectiveSigma)),
      offsetY: Math.round(sampleGaussian(0, effectiveSigma)),
    };
  }

  sampleTimingOffset() {
    const data = this.load();
    const profile = computeSkillProfile(data.level);
    return Math.round(sampleGaussian(0, profile.timingNoiseMs));
  }

  addMatchResult({ hits = 0, misses = 0, maxCombo = 0, score = 0 } = {}) {
    const data = this.load();
    const expGained = Math.max(10, hits * 3 + maxCombo * 2 + Math.floor(score / 5000));
    const oldLevel = data.level;

    data.exp += expGained;
    data.totalPlays += 1;
    data.totalHits += hits;
    data.totalMisses += misses;
    if (maxCombo > data.highestCombo) {
      data.highestCombo = maxCombo;
    }

    let leveledUp = false;
    while (data.level < 20 && data.exp >= this.getExpForNextLevel(data.level)) {
      data.exp -= this.getExpForNextLevel(data.level);
      data.level += 1;
      leveledUp = true;
    }

    this.save();

    return {
      oldLevel,
      newLevel: data.level,
      leveledUp,
      expGained,
      currentStatus: this.getStatus(),
    };
  }

  reset() {
    this.state = {
      level: 1,
      exp: 0,
      totalPlays: 0,
      totalHits: 0,
      totalMisses: 0,
      highestCombo: 0,
      updatedAt: Date.now(),
    };
    this.save();
    return this.getStatus();
  }
}

export const osuSkillModel = new OsuSkillModel();
