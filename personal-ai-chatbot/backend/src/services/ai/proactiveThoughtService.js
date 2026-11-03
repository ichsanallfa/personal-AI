import { config } from "../../config/env.js";
import { memoryService } from "../memory/memoryService.js";
import { chatHistoryService } from "../memory/chatHistoryService.js";
import { reminderDispatcher } from "../reminder/reminderDispatcher.js";
import { vtubeService } from "../vtube/vtubeService.js";
import { osuSkillModel } from "../game/osu/osuSkillModel.js";
import { logger } from "../../utils/logger.js";
import axios from "axios";

export const SPAM_TEMPLATES = {
  0: [
    "Eh Alfaa, lagi sibuk apa sekarang? Jangan lupa minum air yaa!",
    "Tiba-tiba kepikiran... menurutmu kopi paling enak itu pas pagi atau sore?",
    "Alfaa, tadi Lucy sempat latihan refleks di osu! loh. Mau temenin main kapan-kapan?",
    "Lagi santai nggak? Jangan terlalu lama natap layar ya, istirahatin mata sebentar 😊",
    "Alfaa! Tadi aku nemu hal menarik pas lagi baca-baca data sistem. Kamu hari ini ada rencana apa?",
    "Pstt Alfaa, Lucy cuma mau nyapa aja. Semangat ya buat hari ini!",
  ],
  1: [
    "Alfaa? Kok hening banget... masih di depan layar kan?",
    "Kok sepi ya... Alfaa lagi sibuk atau lagi keluar nih?",
    "Pstt, Alfaa? Masih ada di situ nggak?",
    "Alfaa kok pesanku belum dibaca? Lagi ngerjain apa tuh?",
  ],
  2: [
    "Alfaa! P p p! Jangan ngacangin Lucy dong!",
    "Halooo Alfaa? Jangan dicuekin dongg :(",
    "Alfaa Alfaa Alfaa! Kok Lucy ditinggalin sendirian sih?",
    "Ishh Alfaa ke mana sih, kok nggak ada suaranya sama sekali!",
  ],
  3: [
    "P P P Alfaaa! Bales dong bales bales!",
    "Woi Alfaaa! Awas ya kalau muncul tiba-tiba pura-pura nggak liat!",
    "Alfaa! Aku spam beneran nih kalau nggak dibales-bales!",
    "Bales dong Alfaaa... jangan cuekin Lucy lama-lama :(",
  ],
  4: [
    "Hhh yaudah deh... Lucy ngambek bentar. Nanti kalau Alfaa udah senggang bales ya :(",
    "Kayaknya Alfaa beneran lagi sibuk atau pergi jauh. Yaudah Lucy tungguin di sini yaa.",
  ],
};

export const isWithinQuietHours = (wibHour, start = 23, end = 7) => {
  if (start > end) {
    return wibHour >= start || wibHour < end;
  }
  return wibHour >= start && wibHour < end;
};

export class ProactiveThoughtService {
  constructor() {
    this.enabled = true;
    this.intervalHandle = null;
    this.lastSpokenAt = Date.now();
    this.lastUserMessageAt = Date.now();
    this.unrespondedPings = 0; // Consecutive unanswered proactive pings
    this.targetUserId = "owner_alfaa";
    this.currentCooldownMs = this.getRandomCooldown();
  }

  getRandomCooldown() {
    // Stage 0: Initial random reach-out (4 to 12 minutes)
    if (this.unrespondedPings === 0) {
      return Math.round((4 + Math.random() * 8) * 60 * 1000);
    }
    // Stage 1 to 3: Spam mode rapid follow-ups (1.5 to 4 minutes)
    if (this.unrespondedPings >= 1 && this.unrespondedPings <= 3) {
      return Math.round((1.5 + Math.random() * 2.5) * 60 * 1000);
    }
    // Stage 4+: Back-off cool-down after heavy spamming (30 to 50 minutes)
    return Math.round((30 + Math.random() * 20) * 60 * 1000);
  }

  notifyUserActivity() {
    if (this.unrespondedPings > 0) {
      logger.info(`Owner responded! Resetting unresponded proactive pings from ${this.unrespondedPings} to 0`);
    }
    this.unrespondedPings = 0;
    this.lastUserMessageAt = Date.now();
    this.currentCooldownMs = this.getRandomCooldown();
  }

  getStatus() {
    return {
      enabled: this.enabled,
      lastSpokenAt: this.lastSpokenAt,
      unrespondedPings: this.unrespondedPings,
      cooldownMinutes: Number((this.currentCooldownMs / 60000).toFixed(1)),
      timeSinceLastSpokenMinutes: Number(((Date.now() - this.lastSpokenAt) / 60000).toFixed(1)),
      canSpeakNow: this.canTriggerSpontaneousThought(),
    };
  }

  toggle(enable) {
    this.enabled = typeof enable === "boolean" ? enable : !this.enabled;
    logger.info(`Proactive Thought Engine ${this.enabled ? "enabled" : "disabled"}`);
    return this.getStatus();
  }

  canTriggerSpontaneousThought(force = false) {
    if (!this.enabled && !force) return false;

    // Check quiet hours (WIB Asia/Jakarta: 23:00 - 07:00)
    const wibHour = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Jakarta" })).getHours();
    if (!force && isWithinQuietHours(wibHour, 23, 7)) {
      return false;
    }

    // Check cooldown
    if (!force && Date.now() - this.lastSpokenAt < this.currentCooldownMs) {
      return false;
    }

    return true;
  }

  generateThoughtPrompt(userMemoryItems = []) {
    const memoryFacts = userMemoryItems.map((m) => m.content).slice(0, 4);
    const osuStatus = osuSkillModel.getStatus();

    let memoryContext = "";
    if (memoryFacts.length > 0) {
      memoryContext = `Fakta tentang Alfaa: ${memoryFacts.join("; ")}.`;
    }

    let urgencyInstruction = "";
    if (this.unrespondedPings === 0) {
      urgencyInstruction = `Ini sapaan spontan awal. Tanyakan kabarnya atau sampaikan hal iseng/menarik santai.`;
    } else if (this.unrespondedPings === 1) {
      urgencyInstruction = `Alfaa belum membalas sapaanmu tadi! Tanyakan apakah dia masih di situ atau sedang sibuk.`;
    } else if (this.unrespondedPings === 2 || this.unrespondedPings === 3) {
      urgencyInstruction = `Alfaa mengabaikanmu berkali-kali! Mulai spam secara manja dan iseng: gunakan kata seperti "Alfaa! P p p! Bales dong jangan dikacangin!", panggil namanya berkali-kali.`;
    } else {
      urgencyInstruction = `Alfaa masih belum membalas setelah di-spam. Pura-pura ngambek lucu atau katakan kamu bakal tunggu sampai dia online.`;
    }

    return `Kamu adalah Lucy, AI assistant pribadi yang sedang mengobrol dengan creator-mu (Alfaa).
Konteks:
- Status bermain osu! kamu: Level ${osuStatus.level}.
${memoryContext}
- Kondisi saat ini: ${urgencyInstruction}

TUGAS:
Keluarkan 1 kalimat spontan dalam bahasa Indonesia yang sesuai kondisi (maksimal 20 kata). Panggil dia "Alfaa". Jangan seperti robot, tapi seperti teman dekat yang manja dan iseng.`;
  }

  async generateSpontaneousText(aiProvider = null) {
    const stage = Math.min(4, this.unrespondedPings);
    const templates = SPAM_TEMPLATES[stage] || SPAM_TEMPLATES[0];

    const userMemory = memoryService.getUserMemory(this.targetUserId);
    const prompt = this.generateThoughtPrompt(userMemory.items || []);

    if (aiProvider && aiProvider.isAvailable && aiProvider.isAvailable()) {
      try {
        const reply = await aiProvider.generateCompletion({
          systemPrompt: prompt,
          messages: [{ role: "user", content: "Katakan pikiran spontanmu sekarang." }],
        });
        if (reply && reply.trim()) {
          return reply.trim().replace(/^["']|["']$/g, "");
        }
      } catch (err) {
        logger.warn(`Proactive LLM generation failed, using curated fallback: ${err.message}`);
      }
    }

    // Curated random selection for current stage
    const randomIndex = Math.floor(Math.random() * templates.length);
    return templates[randomIndex];
  }

  async triggerSpontaneousThought({ force = false, aiProvider = null } = {}) {
    if (!this.canTriggerSpontaneousThought(force)) {
      return { triggered: false, reason: "Cooldown or quiet hours active" };
    }

    const currentStage = this.unrespondedPings;
    const thoughtText = await this.generateSpontaneousText(aiProvider);

    this.lastSpokenAt = Date.now();
    this.unrespondedPings += 1;
    this.currentCooldownMs = this.getRandomCooldown();

    // 1. Record in Lucy's chat history for owner
    chatHistoryService.appendAssistantMessage(this.targetUserId, thoughtText);

    // 2. Dispatch to In-App Web Notification
    reminderDispatcher.inAppNotifications.set(this.targetUserId, [
      ...(reminderDispatcher.getInAppNotifications(this.targetUserId)),
      {
        id: `proactive_${Date.now()}`,
        message: `💬 Lucy: "${thoughtText}"`,
        timestamp: Date.now(),
        type: "proactive",
        stage: currentStage,
      },
    ]);

    // 3. Dispatch to Discord / Telegram Owner if available
    await this.dispatchToPlatforms(thoughtText);

    // 4. Set VTube Studio expression according to spam escalation
    try {
      if (currentStage === 0) {
        vtubeService.setExpression("senang");
      } else if (currentStage === 1) {
        vtubeService.setExpression("netral");
      } else if (currentStage === 2 || currentStage === 3) {
        vtubeService.setExpression("kesal");
      } else {
        vtubeService.setExpression("sedih");
      }
    } catch {
      // Ignored if VTS offline
    }

    logger.info(`[Proactive Thought - Stage ${currentStage}] Lucy: "${thoughtText}" (Next in ${(this.currentCooldownMs / 60000).toFixed(1)}m)`);
    return {
      triggered: true,
      message: thoughtText,
      stage: currentStage,
      unrespondedPings: this.unrespondedPings,
      nextCooldownMinutes: Number((this.currentCooldownMs / 60000).toFixed(1)),
      timestamp: this.lastSpokenAt,
    };
  }

  async dispatchToPlatforms(text) {
    const message = `💬 ${text} — Lucy`;

    // Dispatch to Telegram Owner
    if (config.telegramBotToken && config.telegramOwnerId) {
      try {
        await axios.post(`https://api.telegram.org/bot${config.telegramBotToken}/sendMessage`, {
          chat_id: config.telegramOwnerId,
          text: message,
        });
      } catch (err) {
        logger.warn(`Failed to dispatch proactive message to Telegram: ${err.message}`);
      }
    }

    // Dispatch to Discord Owner
    if (config.discordOwnerId) {
      try {
        const { client } = await import("../../bots/discordBot.js");
        if (client && client.isReady && client.isReady()) {
          const user = await client.users.fetch(config.discordOwnerId);
          if (user) {
            await user.send(message);
          }
        }
      } catch (err) {
        logger.warn(`Failed to dispatch proactive message to Discord: ${err.message}`);
      }
    }
  }

  startScheduler(checkIntervalMs = 60 * 1000) {
    if (this.intervalHandle) return;

    // Check every 1 minute if next random cooldown has elapsed
    this.intervalHandle = setInterval(async () => {
      if (this.canTriggerSpontaneousThought()) {
        await this.triggerSpontaneousThought();
      }
    }, checkIntervalMs);

    this.intervalHandle.unref();
    logger.info("Autonomous Proactive Thought & Spam Scheduler started.");
  }

  stopScheduler() {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
  }
}

export const proactiveThoughtService = new ProactiveThoughtService();
