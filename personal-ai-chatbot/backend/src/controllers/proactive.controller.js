import { proactiveThoughtService } from "../services/ai/proactiveThoughtService.js";
import { aiService } from "../services/ai/aiService.js";

export const getProactiveStatus = async (req, res, next) => {
  try {
    const status = proactiveThoughtService.getStatus();
    res.json({
      success: true,
      data: status,
    });
  } catch (error) {
    next(error);
  }
};

export const triggerProactiveThought = async (req, res, next) => {
  try {
    const { force = true } = req.body || {};
    const provider = aiService.getProvider();
    const result = await proactiveThoughtService.triggerSpontaneousThought({
      force: Boolean(force),
      aiProvider: provider,
    });

    res.json({
      success: true,
      data: result,
    });
  } catch (error) {
    next(error);
  }
};

export const toggleProactiveService = async (req, res, next) => {
  try {
    const { enabled } = req.body || {};
    const status = proactiveThoughtService.toggle(enabled);

    res.json({
      success: true,
      data: status,
      message: `Proactive Thought Engine ${status.enabled ? "enabled" : "disabled"}`,
    });
  } catch (error) {
    next(error);
  }
};
