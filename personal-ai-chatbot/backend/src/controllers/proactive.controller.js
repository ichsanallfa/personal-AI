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

export const notifyProactiveOwnerActivity = async (req, res, next) => {
  try {
    const platform = req.headers["x-platform"];
    if (platform !== "discord" && platform !== "telegram") {
      return res.status(400).json({ success: false, error: { code: "INVALID_PLATFORM" } });
    }
    proactiveThoughtService.notifyUserActivity(platform);
    res.json({ success: true });
  } catch (error) {
    next(error);
  }
};

export const triggerProactiveThought = async (req, res, next) => {
  try {
    const { force = true } = req.body || {};
    const platform = req.body?.platform || req.headers["x-platform"] || null;
    const provider = aiService.getProvider();
    const result = await proactiveThoughtService.triggerSpontaneousThought({
      force: Boolean(force),
      aiProvider: provider,
      platform,
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
