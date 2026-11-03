import { osuGameService } from "../services/game/osu/osuGameService.js";
import { ValidationError } from "../utils/appError.js";

export const getOsuStatus = async (req, res, next) => {
  try {
    const status = osuGameService.getSkillStatus();
    res.json({
      success: true,
      data: status,
    });
  } catch (error) {
    next(error);
  }
};

export const playOsuMatch = async (req, res, next) => {
  try {
    const { beatmapContent, beatmapPath } = req.body;
    if (!beatmapContent && !beatmapPath) {
      throw new ValidationError("beatmapContent or beatmapPath is required");
    }

    const result = osuGameService.playMatch({ beatmapContent, beatmapPath });
    res.json(result);
  } catch (error) {
    next(error);
  }
};

export const resetOsuSkill = async (req, res, next) => {
  try {
    const status = osuGameService.resetSkill();
    res.json({
      success: true,
      data: status,
      message: "Lucy osu! skill stats reset to level 1",
    });
  } catch (error) {
    next(error);
  }
};
