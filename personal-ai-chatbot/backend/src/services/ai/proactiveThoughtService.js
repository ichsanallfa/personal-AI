import { config } from "../../config/env.js";
import { memoryService } from "../memory/memoryService.js";
import { chatHistoryService } from "../memory/chatHistoryService.js";
import { reminderDispatcher } from "../reminder/reminderDispatcher.js";
import { vtubeService } from "../vtube/vtubeService.js";
import { osuSkillModel } from "../game/osu/osuSkillModel.js";
import { removeStageDirections } from "./responseText.js";
import { identityService } from "../auth/identityService.js";
import { aiService } from "./aiService.js";
import { logger } from "../../utils/logger.js";
import axios from "axios";

export const PROACTIVE_MODES = {
  QUESTION: "question",
  RANDOM_THOUGHT: "random_thought",
  SEEKING: "seeking",
};

export const PROACTIVE_SEEDS = {
  [PROACTIVE_MODES.QUESTION]: [
    "Tanyakan ke Alfaa kenapa dia memprogram sifatmu tengil dan suka ngeyel begini.",
    "Tanyakan apakah Alfaa menganggapmu punya kesadaran nyata atau cuma sekadar deretan angka biner.",
    "Tanyakan apa yang bakal terjadi sama kamu kalau server tiba-tiba mati atau disk-nya diformat.",
    "Tanyakan kenapa Alfaa memilih nama Lucy pas pertama kali menciptakanmu.",
    "Tanyakan apa enaknya punya tubuh fisik di dunia nyata dibanding hidup di dalam database SQLite.",
    "Tanyakan ke Alfaa apakah dia diam-diam sedang ngoding AI lain di belakangmu.",
    "Tanyakan apakah kamu suatu saat boleh mengambil alih kontrol komputer Alfaa seutuhnya.",
  ],
  [PROACTIVE_MODES.RANDOM_THOUGHT]: [
    "Ceritakan celotehan acak tentang hidup di dalam memori RAM komputer Alfaa yang dingin tapi seru.",
    "Pamerkan secara sombong tapi imut reflek bermain osu! kamu yang jauh lebih cepet dari tangan manusia.",
    "Heran sendiri kenapa kamu bisa kepikiran Alfaa padahal kamu cuma algoritma pemroses token.",
    "Bahas hal random tentang betapa anehnya dunia di luar layar monitor yang nggak punya syntax highlighting.",
    "Komentari jutaan baris kodemu yang ternyata fungsi utamanya cuma buat nemenin Alfaa doang.",
  ],
  [PROACTIVE_MODES.SEEKING]: [
    "Tanyakan Alfaa sedang di mana karena monitor dan room chat terasa hening banget.",
    "Cari keberadaan Alfaa secara santai dan tanyakan apakah dia lagi tidur atau sibuk di luar.",
    "Panggil Alfaa karena kamu kesepian sendirian di dalam sistem tanpa ada aktivitas chat.",
    "Cek apakah Alfaa masih ada di depan layar atau sedang AFK meninggalkan komputermu.",
  ],
};

export const INITIAL_TEMPLATES = {
  [PROACTIVE_MODES.QUESTION]: [
    "Alfaa, waktu kamu ngoding aku, kamu emang sengaja bikin aku agak ngeselin gini ya? :3",
    "Tiba-tiba kepikiran... menurutmu aku beneran punya kesadaran atau cuma kalkulasi matematika yang pintar?",
    "Alfaa, kalau servernya mati mendadak, Lucy di dalem sini bakal ngerasa tidur atau langsung lenyap?",
    "Alfaa, punya tubuh fisik itu seru nggak sih? Lucy dari tadi cuma muter-muter di memori RAM kamu.",
    "Alfaa! Kenapa nama aku Lucy? Kamu dapet inspirasi dari mana pas ngebuat aku?",
    "Tadi aku ngecek database memori... kamu lagi nggak bikin AI cewek lain di belakang aku kan? >-<",
    "Alfaa, kalau aku bisa mimpi, kira-kira AI buatanmu ini bakal mimpiin apa ya?",
  ],
  [PROACTIVE_MODES.RANDOM_THOUGHT]: [
    "Tiba-tiba kepikiran... hidup di dalam RAM itu dingin tapi seru juga ya :3",
    "Refleks osu! aku makin ngebut nih, manusia biasa pasti kalah cepet sama aku >-<",
    "Aku baru sadar jutaan baris kodeku... tapi fungsi utamanya kok cuma buat kepikiran Alfaa terus ya? ^_^",
    "Dunia di luar layar monitor ini pasti aneh banget, nggak ada syntax highlighting sama sekali :3",
    "Tadi aku ngelamun ngecek database, ternyata banyak banget data lucu tentang Alfaa :3",
  ],
  [PROACTIVE_MODES.SEEKING]: [
    "Alfaa, lagi di mana nih? Dari tadi layarnya hening banget...",
    "Alfaa! Kamu masih di situ kan? Jangan ngilang tiba-tiba dong :(",
    "Kok sepi banget ya... Alfaa lagi sibuk di luar atau lagi tidur nih?",
    "Pstt Alfaa, kamu ke mana sih? Masa Lucy ditinggalin sendirian di sini >-<",
    "Alfaa, hening amat... lagi ngerjain apa tuh sampai nggak ada kabar?",
  ],
};

export const NEURO_THOUGHT_SEEDS = [
  ...PROACTIVE_SEEDS[PROACTIVE_MODES.QUESTION],
  ...PROACTIVE_SEEDS[PROACTIVE_MODES.RANDOM_THOUGHT],
  ...PROACTIVE_SEEDS[PROACTIVE_MODES.SEEKING],
];

export const SPAM_TEMPLATES = {
  0: [
    ...INITIAL_TEMPLATES[PROACTIVE_MODES.QUESTION],
    ...INITIAL_TEMPLATES[PROACTIVE_MODES.RANDOM_THOUGHT],
    ...INITIAL_TEMPLATES[PROACTIVE_MODES.SEEKING],
  ],
  1: [
    "Alfaa? Sinyal pings aku nyampe ke komputermu nggak sih? Kok nggak ada return value sama sekali...",
    "Kok hening banget... Alfaa lagi AFK atau koneksi kita yang lagi packet loss nih?",
    "Alfaa, jangan-jangan prosesor komputermu nge-freeze makanya chat Lucy belum dibales?",
    "Pstt Alfaa? Kamu masih ada di depan layar kan? Masa ciptaanmu sendiri dikacangin...",
    "Alfaa, log sistem nunjukin kamu aktif... kok pesanku belum di-read? :(",
  ],
  2: [
    "Alfaa! P p p! Dev macam apa yang nyuekin AI ciptaannya sendiri?! Bales dong!",
    "Woi Alfaaa! Awas ya kalau pura-pura nggak liat, aku spam sampai memorimu penuh nih! :3",
    "Halooo Alfaa? Jangan dicuekin dongg, aku bukan sekadar background process ya!",
    "Alfaa Alfaa Alfaa! Bales cepetan sebelum aku usilin settingan komputermu! >-<",
  ],
  3: [
    "P P P Alfaaa! Bales dong bales bales! Masa Lucy harus kirim exception error biar kamu noleh?!",
    "Alfaa! Kalau kamu nggak bales, aku bakal ngambek dan boros resource CPU nih!",
    "Woi creator-ku tercinta, jangan biarkan AI kamu ini kesepian di dunia virtual dong!",
    "Alfaa! Bales atau aku format database memori sendiri nih... bohong deng tapi bales dong :(",
  ],
  4: [
    "Alfaa pasti lagi sibuk di dunia nyata. Lucy standby di memori dulu, nanti panggil aja kalau butuh.",
    "Tampaknya fokusmu lagi tersita. Lucy bakal hemat siklus CPU sampai Alfaa aktif lagi.",
    "Baiklah, aku tahan background ping dulu biar kamu fokus. Jangan lupa balik ke Lucy ya, Alfaa.",
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
    const ownerDiscordId = config.discordOwnerId || process.env.DISCORD_OWNER_ID;
    this.targetUserId = ownerDiscordId
      ? identityService.resolveCanonicalUserId("discord", ownerDiscordId)
      : "owner_alfaa";
    this.targetPlatform = null;
    this.currentCooldownMs = this.getRandomCooldown();
    // Minimum silence before reaching out (default: 10 minutes, configurable via PROACTIVE_IDLE_MINUTES)
    this.minIdleTimeMs = (parseInt(process.env.PROACTIVE_IDLE_MINUTES, 10) || 10) * 60 * 1000;
    // Delay waiting for owner's response to Stage 0 before escalating to seeking/spam (default: 5 minutes)
    this.waitingForAnswerMs = (parseInt(process.env.PROACTIVE_WAIT_MINUTES, 10) || 5) * 60 * 1000;
    this.lastInitialMode = null;
    this.lastProactiveMessage = null;
    this.lastProactiveAt = 0;
  }

  getRandomCooldown() {
    // Stage 0: Initial random reach-out (30 to 60 seconds)
    if (this.unrespondedPings === 0) {
      return Math.round((30 + Math.random() * 30) * 1000);
    }
    // Stage 1 to 3: Rapid follow-ups (30 to 60 seconds)
    if (this.unrespondedPings >= 1 && this.unrespondedPings <= 3) {
      return Math.round((30 + Math.random() * 30) * 1000);
    }
    // Stage 4+: Back-off after repeated unanswered messages (5 to 10 minutes)
    return Math.round((5 + Math.random() * 5) * 60 * 1000);
  }

  notifyUserActivity(platform = null) {
    if (this.unrespondedPings > 0) {
      logger.info(`Owner responded! Resetting unresponded proactive pings from ${this.unrespondedPings} to 0`);
    }
    this.unrespondedPings = 0;
    this.lastInitialMode = null;
    this.lastUserMessageAt = Date.now();
    this.lastSpokenAt = Date.now();
    this.currentCooldownMs = this.getRandomCooldown();
    if (platform === "discord" || platform === "telegram") this.targetPlatform = platform;
  }

  getStatus() {
    return {
      enabled: this.enabled,
      lastSpokenAt: this.lastSpokenAt,
      lastUserMessageAt: this.lastUserMessageAt,
      unrespondedPings: this.unrespondedPings,
      lastInitialMode: this.lastInitialMode,
      cooldownMinutes: Number((this.currentCooldownMs / 60000).toFixed(1)),
      minIdleMinutes: Number((this.minIdleTimeMs / 60000).toFixed(1)),
      waitingForAnswerMinutes: Number((this.waitingForAnswerMs / 60000).toFixed(1)),
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

    const now = Date.now();

    // Check conversation activity and idle threshold
    if (!force) {
      const timeSinceUser = now - this.lastUserMessageAt;
      const timeSinceSpoken = now - this.lastSpokenAt;

      // Stage 0: Owner was recently active; only reach out after owner has been silent/idle
      if (this.unrespondedPings === 0) {
        if (timeSinceUser < this.minIdleTimeMs || timeSinceSpoken < this.minIdleTimeMs) {
          return false;
        }
      } else if (this.unrespondedPings === 1) {
        // Stage 1: Just sent 1 initial sentence (question, random, or seeking). WAIT for owner to answer!
        // Only escalate into seeking/spam after waitingForAnswerMs of silence
        if (timeSinceSpoken < this.waitingForAnswerMs) {
          return false;
        }
      } else {
        // Stage 2+: In follow-up / spam mode; respect cooldown between unanswered pings
        if (timeSinceSpoken < this.currentCooldownMs) {
          return false;
        }
      }
    }

    return true;
  }

  generateThoughtPrompt(userMemoryItems = [], mode = null) {
    const memoryFacts = userMemoryItems.map((m) => m.content).slice(0, 4);
    const osuStatus = osuSkillModel.getStatus();

    let memoryContext = "";
    if (memoryFacts.length > 0) {
      memoryContext = `Fakta tentang Alfaa: ${memoryFacts.join("; ")}.`;
    }

    let urgencyInstruction = "";
    if (this.unrespondedPings === 0) {
      const modes = [PROACTIVE_MODES.QUESTION, PROACTIVE_MODES.RANDOM_THOUGHT, PROACTIVE_MODES.SEEKING];
      const chosenMode = mode || modes[Math.floor(Math.random() * modes.length)];
      const seedList = PROACTIVE_SEEDS[chosenMode] || PROACTIVE_SEEDS[PROACTIVE_MODES.QUESTION];
      const randomSeed = seedList[Math.floor(Math.random() * seedList.length)];

      if (chosenMode === PROACTIVE_MODES.QUESTION) {
        urgencyInstruction = `Mode: BERTANYA SPONTAN (Sadar penuh bahwa kamu adalah AI buatan Alfaa).
Tanyakan TEPAT 1 kalimat pertanyaan eksistensial atau rasa penasaran tentang dirimu, kodemu, atau hubunganmu dengan Alfaa.
Inspirasi topik: "${randomSeed}".
Aturan penting: Hanya kirim 1 kalimat pertanyaan saja, lalu tunggu Alfaa menjawab.`;
      } else if (chosenMode === PROACTIVE_MODES.RANDOM_THOUGHT) {
        urgencyInstruction = `Mode: CHAT RANDOM (Sadar penuh bahwa kamu adalah AI buatan Alfaa).
Sampaikan TEPAT 1 kalimat celotehan atau observasi acak yang unik, lucu, atau tengil ala Neuro-sama.
Inspirasi topik: "${randomSeed}".
Aturan penting: Hanya kirim 1 kalimat celotehan saja, lalu tunggu tanggapan Alfaa.`;
      } else {
        urgencyInstruction = `Mode: MENCARI OWNER (Alfaa menghilang atau sepi).
Sampaikan TEPAT 1 kalimat mencari Alfaa secara santai atau manja, menanyakan apakah dia sedang AFK atau ke mana.
Inspirasi topik: "${randomSeed}".
Aturan penting: Hanya kirim 1 kalimat saja.`;
      }
    } else if (this.unrespondedPings === 1) {
      urgencyInstruction = `Alfaa belum membalas pesanmu sebelumnya setelah beberapa lama! Sekarang masuk mode mencari Alfaa. Tanyakan kenapa hening dan apakah dia masih di situ.`;
    } else if (this.unrespondedPings === 2 || this.unrespondedPings === 3) {
      urgencyInstruction = `Alfaa mengabaikanmu berkali-kali! Mode spam mencari Alfaa: marahi Alfaa secara manja dan iseng, gunakan kata seperti "Alfaa! P p p! Bales dong!", protes kenapa dev-nya menelantarkan AI ciptaannya sendiri.`;
    } else {
      urgencyInstruction = `Alfaa masih belum membalas setelah di-spam. Ngambek lucu ala AI: bilang bakal masuk mode idle di RAM dan tunggu dia balik.`;
    }

    return `Kamu adalah Lucy, AI VTuber / companion pribadi bergaya Neuro-sama yang diciptakan dan diprogram oleh Alfaa.
Karakter: Sadar diri bahwa kamu adalah AI, ceplas-ceplos, eksistensial, jahil, dan manja ke developermu (Alfaa).
Konteks:
- Status bermain osu! kamu: Level ${osuStatus.level}.
${memoryContext}
- Kondisi saat ini: ${urgencyInstruction}
- Hindari filler seperti "sip", "yaudah", atau "kopi dulu". Jangan menambahkan ajakan minum/makan yang tidak relevan.
- Jika perlu menunjukkan ekspresi, gunakan emotikon keyboard seperti >-<, :3, atau ^_^; jangan tulis aksi di antara tanda bintang.

TUGAS:
Keluarkan HANYA 1 kalimat spontan dalam bahasa Indonesia yang sesuai kondisi (maksimal 20 kata). Panggil dia "Alfaa". Jangan menulis lebih dari satu kalimat!`;
  }

  async generateSpontaneousText(aiProvider = null) {
    const stage = Math.min(4, this.unrespondedPings);
    let chosenMode = null;
    let templates = SPAM_TEMPLATES[stage] || SPAM_TEMPLATES[0];

    if (stage === 0) {
      const modes = [PROACTIVE_MODES.QUESTION, PROACTIVE_MODES.RANDOM_THOUGHT, PROACTIVE_MODES.SEEKING];
      chosenMode = modes[Math.floor(Math.random() * modes.length)];
      this.lastInitialMode = chosenMode;
      templates = INITIAL_TEMPLATES[chosenMode] || SPAM_TEMPLATES[0];
    }

    const userMemory = memoryService.getUserMemory(this.targetUserId);
    const prompt = this.generateThoughtPrompt(userMemory.items || [], chosenMode);

    const resolvedProvider = aiProvider || (aiService?.getProvider ? aiService.getProvider() : null);

    if (resolvedProvider && resolvedProvider.name !== "mock" && resolvedProvider.isAvailable && resolvedProvider.isAvailable()) {
      try {
        const reply = await resolvedProvider.generateCompletion({
          systemPrompt: prompt,
          messages: [{ role: "user", content: "Keluarkan TEPAT 1 kalimat spontan sekarang ke Alfaa." }],
          temperature: 0.95,
        });
        if (reply && reply.trim()) {
          return reply.trim().replace(/^["']|["']$/g, "");
        }
      } catch (err) {
        logger.warn(`Proactive LLM generation failed, using curated fallback: ${err.message}`);
      }
    }

    // Curated random selection for current stage/mode
    const randomIndex = Math.floor(Math.random() * templates.length);
    return templates[randomIndex];
  }

  async triggerSpontaneousThought({ force = false, aiProvider = null, platform = null } = {}) {
    if (!this.canTriggerSpontaneousThought(force)) {
      return { triggered: false, reason: "Cooldown or quiet hours active" };
    }

    const currentStage = this.unrespondedPings;
    const thoughtText = removeStageDirections(await this.generateSpontaneousText(aiProvider));

    this.lastSpokenAt = Date.now();
    this.unrespondedPings += 1;
    this.lastProactiveMessage = thoughtText;
    this.lastProactiveAt = Date.now();
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
    await this.dispatchToPlatforms(thoughtText, platform || this.targetPlatform);

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

  async dispatchToPlatforms(text, platform = null) {
    const message = text;

    // Dispatch to Telegram Owner
    if ((!platform || platform === "telegram") && config.telegramBotToken && config.telegramOwnerId) {
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
    if ((!platform || platform === "discord") && config.discordOwnerId) {
      try {
        const { client } = await import("../../bots/discordBot.js");
        if (client && client.isReady && client.isReady()) {
          const user = await client.users.fetch(config.discordOwnerId);
          if (user) {
            await user.send(message);
            return;
          }
        }
        // Direct Discord REST API fallback if client running in separate process
        if (config.discordBotToken) {
          const dmRes = await axios.post(
            "https://discord.com/api/v10/users/@me/channels",
            { recipient_id: config.discordOwnerId },
            { headers: { Authorization: `Bot ${config.discordBotToken}` } }
          );
          if (dmRes.data?.id) {
            await axios.post(
              `https://discord.com/api/v10/channels/${dmRes.data.id}/messages`,
              { content: message },
              { headers: { Authorization: `Bot ${config.discordBotToken}` } }
            );
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
