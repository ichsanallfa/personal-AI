import axios from "axios";
import { BaseAIProvider } from "./baseProvider.js";
import { config } from "../../../config/env.js";
import { logger } from "../../../utils/logger.js";

export class OpenRouterProvider extends BaseAIProvider {
  constructor() {
    super("openrouter");
  }

  isAvailable() {
    return Boolean(config.openRouterApiKey);
  }

  async generateCompletion({ systemPrompt, messages, model = config.aiModel, maxTokens = 700 }) {
    if (!this.isAvailable()) {
      throw new Error("OpenRouter API key is not configured");
    }

    const payload = {
      model,
      max_tokens: maxTokens,
      messages: [
        { role: "system", content: systemPrompt },
        ...messages,
      ],
    };

    try {
      const response = await axios.post(config.openRouterUrl, payload, {
        headers: {
          Authorization: `Bearer ${config.openRouterApiKey}`,
          "Content-Type": "application/json",
          "HTTP-Referer": "https://github.com/ichsanallfa/personal-ai-chatbot",
          "X-Title": "Lucy AI Assistant",
        },
        timeout: 30000,
      });

      const choice = response.data?.choices?.[0];
      const reply = choice?.message?.content;
      if (typeof reply !== "string" || !reply.trim()) {
        const reason = choice?.finish_reason || response.data?.error?.message || "no text content returned";
        throw new Error(`OpenRouter returned no text for model ${model}: ${reason}`);
      }
      return reply.trim();
    } catch (error) {
      logger.error("OpenRouter provider error:", error.response?.data || error.message);
      throw error;
    }
  }
}
