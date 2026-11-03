import { osuSkillModel } from "./osuSkillModel.js";
import { parseBeatmapContent, parseBeatmapFile } from "./beatmapParser.js";
import { simulateMatch, evaluateNoteHit } from "./osuSimulator.js";
import { vtubeService } from "../../vtube/vtubeService.js";
import { logger } from "../../../utils/logger.js";

export const generateLucyGameReaction = (result) => {
  const { progression, accuracy, hits, maxCombo } = result;

  if (progression.leveledUp) {
    return `Yey! Lucy naik ke Level ${progression.newLevel}! Refleks dan akurasiku terasa makin cepat!`;
  }

  if (hits.miss === 0 && accuracy >= 98) {
    return `Sempurna! Full Combo dengan akurasi ${accuracy}%! Lucy mainnya keren banget kan?`;
  }

  if (accuracy >= 90) {
    return `Permainan bagus! Akurasi ${accuracy}% dan combo tertinggi ${maxCombo}. Aku mulai terbiasa!`;
  }

  if (hits.miss > 8) {
    return `Aduh... banyak miss tadi (${hits.miss} miss). Tanganku masih agak kaku, yuk coba latihan lagi!`;
  }

  return `Selesai! Akurasi ${accuracy}%. Lumayan untuk nambah pengalaman bermain!`;
};

class OsuGameService {
  constructor() {
    this.activeLiveSession = null;
  }

  getSkillStatus() {
    return osuSkillModel.getStatus();
  }

  resetSkill() {
    return osuSkillModel.reset();
  }

  playMatch({ beatmapContent, beatmapPath }) {
    const beatmap = beatmapContent
      ? parseBeatmapContent(beatmapContent)
      : parseBeatmapFile(beatmapPath);

    const result = simulateMatch(beatmap, osuSkillModel);
    const reaction = generateLucyGameReaction(result);

    // Trigger VTube Studio emotion based on outcome
    try {
      if (result.progression.leveledUp || result.accuracy >= 92) {
        vtubeService.setExpression("senang");
      } else if (result.hits.miss > 5) {
        vtubeService.setExpression("kesal");
      } else {
        vtubeService.setExpression("netral");
      }
    } catch (err) {
      logger.warn(`VTube reaction trigger failed: ${err.message}`);
    }

    return {
      success: true,
      data: {
        ...result,
        lucyReaction: reaction,
      },
    };
  }

  startLiveSession({ beatmapContent, beatmapPath, onEvent }) {
    if (this.activeLiveSession) {
      this.stopLiveSession();
    }

    const beatmap = beatmapContent
      ? parseBeatmapContent(beatmapContent)
      : parseBeatmapFile(beatmapPath);

    const session = {
      beatmap,
      startTime: Date.now(),
      currentIndex: 0,
      combo: 0,
      maxCombo: 0,
      count300: 0,
      count100: 0,
      count50: 0,
      countMiss: 0,
      timerHandle: null,
      stopped: false,
    };

    this.activeLiveSession = session;

    const tick = () => {
      if (session.stopped) return;
      const elapsed = Date.now() - session.startTime;

      while (session.currentIndex < beatmap.hitObjects.length) {
        const note = beatmap.hitObjects[session.currentIndex];
        if (note.time > elapsed) {
          break;
        }

        const hit = evaluateNoteHit(note, beatmap.hitWindows, osuSkillModel, session.combo);
        session.currentIndex += 1;

        if (hit.result === "miss") {
          session.countMiss += 1;
          session.combo = 0;
          vtubeService.setExpression("kesal");
        } else {
          if (hit.result === "300") session.count300 += 1;
          else if (hit.result === "100") session.count100 += 1;
          else if (hit.result === "50") session.count50 += 1;

          session.combo += 1;
          if (session.combo > session.maxCombo) session.maxCombo = session.combo;
          if (session.combo % 25 === 0) {
            vtubeService.setExpression("senang");
          }
        }

        if (onEvent) {
          onEvent({ type: "note", hit, combo: session.combo });
        }
      }

      if (session.currentIndex >= beatmap.hitObjects.length) {
        this.stopLiveSession();
        if (onEvent) {
          onEvent({ type: "finish", maxCombo: session.maxCombo });
        }
      } else {
        session.timerHandle = setTimeout(tick, 20);
      }
    };

    session.timerHandle = setTimeout(tick, 20);
    return { status: "started", totalNotes: beatmap.hitObjects.length };
  }

  stopLiveSession() {
    if (this.activeLiveSession) {
      this.activeLiveSession.stopped = true;
      if (this.activeLiveSession.timerHandle) {
        clearTimeout(this.activeLiveSession.timerHandle);
      }
      this.activeLiveSession = null;
    }
    return { status: "stopped" };
  }
}

export const osuGameService = new OsuGameService();
