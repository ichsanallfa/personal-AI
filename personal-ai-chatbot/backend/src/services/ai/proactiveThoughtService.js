import { config } from "../../config/env.js";
import { BACKEND_ROOT } from "../../config/paths.js";
import fs from "fs";
import path from "path";
import { memoryService } from "../memory/memoryService.js";
import { chatHistoryService } from "../memory/chatHistoryService.js";
import { reminderDispatcher } from "../reminder/reminderDispatcher.js";
import { vtubeService } from "../vtube/vtubeService.js";
import { osuSkillModel } from "../game/osu/osuSkillModel.js";
import { removeStageDirections } from "./responseText.js";
import { identityService } from "../auth/identityService.js";
import { aiService } from "./aiService.js";
import { logger } from "../../utils/logger.js";
import { proactiveOutbox, normalizeCounter } from "./proactiveOutbox.js";
import axios from "axios";
import { randomUUID } from "crypto";

const ACCEPTED = Symbol("accepted");

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
  constructor({ transport = null, ownerKey = null, outbox = null } = {}) {
    this.enabled = true;
    this.intervalHandle = null;
    // Keep service creation distinct from owner activity; otherwise startup falsely resets idle timer.
    this.lastSpokenAt = Date.now() - 24 * 60 * 60 * 1000;
    this.lastUserMessageAt = this.lastSpokenAt;
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
    this.nextEligibleAt = this.lastUserMessageAt + this.minIdleTimeMs;
    this.lastInitialMode = null;
    this.lastProactiveMessage = null;
    this.lastProactiveAt = 0;
    this.lastSchedulerCheckAt = 0;
    this.lastSchedulerSkipReason = null;
    this.lastDispatchSucceeded = null;
    this.recentProactiveFile = path.join(BACKEND_ROOT, "data", "proactiveHistory.json");
    try {
      this.recentProactiveMessages = process.env.NODE_ENV === "test"
        ? []
        : JSON.parse(fs.readFileSync(this.recentProactiveFile, "utf8")).messages || [];
    } catch {
      this.recentProactiveMessages = [];
    }
    this.maxRecentProactiveMessages = 30;
    this.ownerKey = ownerKey || (process.env.NODE_ENV === "test" ? randomUUID() : this.targetUserId);
    this.testMode = process.env.NODE_ENV === "test";
    this.transport = transport;
    this.workerId = randomUUID();
    this.outbox = outbox || proactiveOutbox;
    this.isShuttingDown = false;
    this.schedulerTaskPromise = null;
    this.cyclePromise = null;
    this.dispatchPromise = null;
    this.restorePersistentState();
  }

  getPersistentState() {
    return {
      enabled: this.enabled,
      lastUserActivityAt: this.lastUserMessageAt,
      lastSuccessfulDispatchAt: this.lastSuccessfulDispatchAt || 0,
      unansweredPings: this.unrespondedPings,
      nextEligibleAt: this.nextEligibleAt || 0,
      lastProactiveAt: this.lastProactiveAt,
      lastProactiveMessage: this.lastProactiveMessage,
      targetPlatform: this.targetPlatform,
      lastInitialMode: this.lastInitialMode,
      currentCooldownMs: this.currentCooldownMs,
      lastProactiveCooldownMs: this.lastProactiveCooldownMs || 0,
    };
  }

  persistFields(fields) {
    this.outbox.updateState(this.ownerKey, fields);
  }

  restorePersistentState() {
    const state = this.outbox.loadState(this.ownerKey, {
      enabled: this.enabled,
      lastUserActivityAt: this.lastUserMessageAt,
      unansweredCount: this.unrespondedPings,
      minIdleTimeMs: this.minIdleTimeMs,
      currentCooldownMs: this.currentCooldownMs,
    });
    this.enabled = state.enabled;
    this.lastUserMessageAt = state.lastUserActivityAt;
    this.lastSpokenAt = Math.max(state.lastUserActivityAt, state.lastSuccessfulDispatchAt);
    this.lastSuccessfulDispatchAt = state.lastSuccessfulDispatchAt;
    this.unrespondedPings = state.unansweredCount;
    this.nextEligibleAt = state.nextEligibleAt;
    this.lastProactiveAt = state.lastProactiveAt;
    this.lastProactiveMessage = state.lastProactiveMessage;
    this.targetPlatform = state.targetPlatform;
    this.lastInitialMode = state.lastInitialMode;
    this.currentCooldownMs = state.currentCooldownMs || this.currentCooldownMs;
    this.lastProactiveCooldownMs = state.lastProactiveCooldownMs;
    if (this.unrespondedPings === 0 && this.lastSuccessfulDispatchAt === 0 && this.lastUserMessageAt <= Date.now() - 24 * 60 * 60 * 1000 + 100) {
      this.lastSpokenAt = this.lastUserMessageAt;
    }
    this.outbox.recoverExpired(this.ownerKey);
    this.lastChannelDispatches = {};
    this.unrespondedPings = Number.isInteger(state.unansweredCount) ? state.unansweredCount : 0;
  }

  rememberProactiveText(text) {
    this.recentProactiveMessages.push(text);
    this.recentProactiveMessages = this.recentProactiveMessages.slice(-this.maxRecentProactiveMessages);
    if (process.env.NODE_ENV === "test") return;
    try {
      fs.mkdirSync(path.dirname(this.recentProactiveFile), { recursive: true });
      fs.writeFileSync(this.recentProactiveFile, JSON.stringify({ messages: this.recentProactiveMessages }, null, 2));
    } catch (error) {
      logger.warn(`Failed to persist proactive history: ${error.message}`);
    }
  }

  normalizeProactiveText(text) {
    return text.toLocaleLowerCase("id-ID")
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  isRecentDuplicate(candidate) {
    const normalized = this.normalizeProactiveText(candidate);
    if (!normalized) return true;
    return this.recentProactiveMessages.slice(-10).some((recent) => {
      const previous = this.normalizeProactiveText(recent);
      if (normalized === previous) return true;
      const words = new Set(normalized.split(" ").filter((word) => word.length > 2));
      const previousWords = new Set(previous.split(" ").filter((word) => word.length > 2));
      if (!words.size || !previousWords.size) return false;
      const overlap = [...words].filter((word) => previousWords.has(word)).length;
      return overlap / (words.size + previousWords.size - overlap) >= 0.8;
    });
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
    this.getCurrentUnansweredCount();
    const hadUnansweredProactive = this.unrespondedPings > 0;
    if (this.unrespondedPings > 0) {
      logger.info(`Owner responded! Resetting unresponded proactive pings from ${this.unrespondedPings} to 0`);
    }
    this.unrespondedPings = 0;
    this.lastInitialMode = null;
    this.lastUserMessageAt = Date.now();
    this.lastSpokenAt = Date.now();
    this.currentCooldownMs = this.getRandomCooldown();
    this.nextEligibleAt = this.lastUserMessageAt + this.minIdleTimeMs;
    if (platform === "discord" || platform === "telegram") this.targetPlatform = platform;
    this.outbox.resetUnanswered(this.ownerKey, {
      lastUserActivityAt: this.lastUserMessageAt,
      nextEligibleAt: this.nextEligibleAt,
      currentCooldownMs: this.currentCooldownMs,
      targetPlatform: this.targetPlatform,
    });
    this.unrespondedPings = 0;
    if (hadUnansweredProactive) {
      this.lastProactiveMessage = null;
      this.lastProactiveAt = 0;
      this.lastInitialMode = null;
      this.outbox.clearLastThought(this.ownerKey);
    }
  }

  getStatus() {
    return {
      enabled: this.enabled,
      schedulerRunning: Boolean(this.intervalHandle),
      targetPlatform: this.targetPlatform || (config.discordOwnerId ? "discord" : null),
      lastSpokenAt: this.lastSpokenAt,
      lastUserMessageAt: this.lastUserMessageAt,
      unrespondedPings: this.unrespondedPings,
      lastInitialMode: this.lastInitialMode,
      cooldownMinutes: Number((this.currentCooldownMs / 60000).toFixed(1)),
      minIdleMinutes: Number((this.minIdleTimeMs / 60000).toFixed(1)),
      waitingForAnswerMinutes: Number((this.waitingForAnswerMs / 60000).toFixed(1)),
      timeSinceLastSpokenMinutes: Number(((Date.now() - this.lastSpokenAt) / 60000).toFixed(1)),
      lastSchedulerCheckAt: this.lastSchedulerCheckAt,
      lastSchedulerSkipReason: this.lastSchedulerSkipReason,
      lastDispatchSucceeded: this.lastDispatchSucceeded,
      channelDispatches: this.lastChannelDispatches || {},
      canSpeakNow: this.canTriggerSpontaneousThought(),
    };
  }

  toggle(enable) {
    this.enabled = typeof enable === "boolean" ? enable : !this.enabled;
    logger.info(`Proactive Thought Engine ${this.enabled ? "enabled" : "disabled"}`);
    this.outbox.updateEnabled(this.ownerKey, this.enabled);
    return this.getStatus();
  }

  canTriggerSpontaneousThought(force = false) {
    this.getCurrentUnansweredCount();
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
        // Stage 2+: cooldown uses the interval captured after the previous send.
        // getRandomCooldown() recalculates from the new stage; don't compare against that new value.
        const timeSinceLastPing = now - this.lastProactiveAt;
        const requiredWait = this.lastProactiveAt
          ? this.lastProactiveCooldownMs || this.currentCooldownMs
          : this.currentCooldownMs;
        if (timeSinceLastPing < requiredWait) {
          return false;
        }
      }
    }

    return true;
  }

  generateThoughtPrompt(userMemoryItems = [], mode = null) {
    this.getCurrentUnansweredCount();
    const memoryFacts = userMemoryItems.map((m) => m.content).slice(0, 4);
    const osuStatus = osuSkillModel.getStatus();

    let memoryContext = "";
    if (memoryFacts.length > 0) {
      memoryContext = `Fakta tentang Alfaa: ${memoryFacts.join("; ")}.`;
    }

    let urgencyInstruction = "";
    const stage = this.unrespondedPings;
    if (stage === 0) {
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
    } else if (stage === 1) {
      urgencyInstruction = `Alfaa belum membalas pesanmu sebelumnya setelah beberapa lama! Sekarang masuk mode mencari Alfaa. Tanyakan kenapa hening dan apakah dia masih di situ.`;
    } else if (stage === 2 || stage === 3) {
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
    this.getCurrentUnansweredCount();
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
    const recentMessages = this.recentProactiveMessages.slice(-10);
    const prompt = `${this.generateThoughtPrompt(userMemory.items || [], chosenMode)}\n\nJANGAN ULANGI atau parafrase pesan proaktif sebelumnya. Pesan terakhir: ${JSON.stringify(recentMessages)}`;

    const resolvedProvider = aiProvider || (aiService?.getProvider ? aiService.getProvider() : null);

    if (resolvedProvider && resolvedProvider.name !== "mock" && resolvedProvider.isAvailable && resolvedProvider.isAvailable()) {
      try {
        for (let attempt = 0; attempt < 3; attempt += 1) {
          const reply = await resolvedProvider.generateCompletion({
            systemPrompt: prompt,
            messages: [{ role: "user", content: attempt === 0
              ? "Keluarkan TEPAT 1 kalimat spontan yang belum pernah kamu kirim ke Alfaa."
              : "Hasil sebelumnya terlalu mirip dengan pesan lama. Buat pemikiran baru dengan topik berbeda, tepat 1 kalimat." }],
            temperature: 0.95,
          });
          const candidate = reply?.trim().replace(/^["']|["']$/g, "");
          if (candidate && !this.isRecentDuplicate(candidate)) return candidate;
        }
      } catch (err) {
        logger.warn(`Proactive LLM generation failed, using curated fallback: ${err.message}`);
      }
    }

    // Fallback templates are also filtered; return null rather than repeat stale text.
    const freshTemplates = templates.filter((text) => !this.isRecentDuplicate(text));
    if (!freshTemplates.length) {
      logger.warn(`No unique proactive fallback available: ${templates.length} templates matched recent history.`);
      return null;
    }
    logger.info(`Proactive fallback selected from ${freshTemplates.length}/${templates.length} fresh templates.`);
    return freshTemplates[Math.floor(Math.random() * freshTemplates.length)];
  }

  async triggerSpontaneousThought({ force = false, aiProvider = null, platform = null } = {}) {
    if (this.isShuttingDown) return { triggered: false, reason: "Service shutting down" };
    if (this.cyclePromise) return this.cyclePromise;
    this.cyclePromise = this.runProactiveCycle({ force, aiProvider, platform });
    try {
      return await this.cyclePromise;
    } finally {
      this.cyclePromise = null;
    }
  }

  async runProactiveCycle({ force = false, aiProvider = null, platform = null } = {}) {
    if (this.isShuttingDown) return { triggered: false, reason: "Service shutting down" };
    if (typeof force !== "boolean") throw new TypeError("force must be a boolean");
    this.getCurrentUnansweredCount();
    if (this.outbox.hasActiveThought(this.ownerKey)) return { triggered: false, reason: "Pending proactive dispatch exists" };
    if (!this.canTriggerSpontaneousThought(force)) {
      return { triggered: false, reason: "Cooldown or quiet hours active" };
    }

    const currentStage = this.unrespondedPings;
    const generatedText = await this.generateSpontaneousText(aiProvider);
    if (this.isShuttingDown) return { triggered: false, reason: "Service shutting down" };
    if (!generatedText) return { triggered: false, reason: "No unique proactive message available" };
    const thoughtText = removeStageDirections(generatedText);

    const channels = this.resolveChannels(platform || this.targetPlatform);
    if (channels.length === 0) return { triggered: false, reason: "No proactive delivery channel configured" };

    this.lastProactiveMessage = thoughtText;
    this.lastProactiveAt = Date.now();

    const dispatches = channels.length ? this.outbox.enqueueThoughtIfAbsent({
      thoughtId: randomUUID(),
      ownerKey: this.ownerKey,
      content: thoughtText,
      channels,
    }) : [];
    if (!dispatches.length) return { triggered: false, reason: "Pending proactive dispatch exists" };
    this.lastChannelDispatches = Object.fromEntries(dispatches.map((row) => [row.channel, {
      status: row.status,
      dispatchId: row.dispatch_id,
    }]));
    const ownerState = this.outbox.loadState(this.ownerKey, {
      enabled: this.enabled,
      lastUserActivityAt: this.lastUserMessageAt,
      unansweredPings: this.unrespondedPings,
      minIdleTimeMs: this.minIdleTimeMs,
      currentCooldownMs: this.currentCooldownMs,
    });
    this.outbox.updateThoughtState(this.ownerKey, { message: thoughtText, at: this.lastProactiveAt });
    this.rememberProactiveText(thoughtText);

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

    // Web notification remains separate and is not counted as channel acceptance.
    this.lastChannelDispatches = await this.dispatchToPlatforms(thoughtText, platform || this.targetPlatform, dispatches) || {};
    this.lastDispatchSucceeded = Object.values(this.lastChannelDispatches).some(({ status }) => status === "accepted");
    const anyChannelAccepted = Object.values(this.lastChannelDispatches).some(({ status }) => status === "accepted");

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
      accepted: anyChannelAccepted,
      message: thoughtText,
      stage: currentStage,
      unrespondedPings: this.unrespondedPings,
      nextCooldownMinutes: Number((this.currentCooldownMs / 60000).toFixed(1)),
      timestamp: this.lastSpokenAt,
      dispatches: this.lastChannelDispatches,
      reason: anyChannelAccepted ? undefined : "Thought queued but no channel accepted delivery",
    };
  }

  resolveChannels(platform = null) {
    if (this.transport) {
      if (platform === "telegram" || platform === "discord") return [{ channel: platform, targetKey: `mock-${platform}` }];
      return ["telegram", "discord"].map((channel) => ({ channel, targetKey: `mock-${channel}` }));
    }
    const channels = [];
    if ((!platform || platform === "telegram") && config.telegramBotToken && config.telegramOwnerId) {
      channels.push({ channel: "telegram", targetKey: config.telegramOwnerId });
    }
    if ((!platform || platform === "discord") && config.discordOwnerId) {
      channels.push({ channel: "discord", targetKey: config.discordOwnerId });
    }
    return channels;
  }

  async processDispatches(initialDispatches = null, { recheckPolicy = true } = {}) {
    if (this.isShuttingDown && !initialDispatches?.length) return {};
    if (this.dispatchPromise) return this.dispatchPromise;
    this.dispatchPromise = this.runDispatchWorker(initialDispatches, { recheckPolicy });
    try {
      return await this.dispatchPromise;
    } finally {
      this.dispatchPromise = null;
    }
  }

  async runDispatchWorker(initialDispatches = null, { recheckPolicy = true } = {}) {
    const results = {};
    const claimed = initialDispatches?.length
      ? initialDispatches.map((intent) => this.outbox.claimById(intent.dispatch_id, this.workerId)).filter(Boolean)
      : null;
    for (let count = 0; count < 20; count += 1) {
      if (this.isShuttingDown && !claimed) break;
      const dispatch = claimed ? claimed[count] : this.outbox.claimDueForOwner(this.ownerKey, this.workerId);
      if (!dispatch) break;
      let accepted = false;
      let failure = null;
      try {
        const persistedState = this.outbox.loadState(this.ownerKey, {
          enabled: this.enabled,
          lastUserActivityAt: this.lastUserMessageAt,
          unansweredPings: this.unrespondedPings,
          minIdleTimeMs: this.minIdleTimeMs,
          currentCooldownMs: this.currentCooldownMs,
        });
        if (recheckPolicy && (!persistedState.enabled || this.isQuietHoursNow() || Date.now() < persistedState.nextEligibleAt || !this.isDispatchPolicyAllowed(dispatch))) {
          this.outbox.markFailed(dispatch, this.workerId, "policy_blocked", false);
          results[dispatch.channel] = { status: "failed", dispatchId: dispatch.dispatch_id };
          continue;
        }
        accepted = await this.sendChannel(dispatch) === ACCEPTED;
        if (!accepted) failure = Object.assign(new Error("transport_unconfirmed"), { retryable: false });
      } catch (error) {
        failure = error;
      }
      if (accepted) {
        const now = Date.now();
        const nextCooldownMs = this.getRandomCooldownFor(this.unrespondedPings + 1);
        if (!this.outbox.markAcceptedWithState(dispatch, this.workerId, now, {
          lastUserActivityAt: this.lastUserMessageAt,
          lastProactiveMessage: this.lastProactiveMessage,
          targetPlatform: this.targetPlatform,
          lastInitialMode: this.lastInitialMode,
          currentCooldownMs: nextCooldownMs,
          waitingForAnswerMs: this.waitingForAnswerMs,
        })) continue;
        this.lastSuccessfulDispatchAt = now;
        this.lastSpokenAt = now;
        const acceptedState = this.outbox.getState(this.ownerKey);
        this.unrespondedPings = acceptedState.unansweredCount;
        this.allowTestCounterOverride = false;
        this.nextEligibleAt = acceptedState.nextEligibleAt;
        this.lastProactiveCooldownMs = acceptedState.lastProactiveCooldownMs;
        this.currentCooldownMs = acceptedState.currentCooldownMs;
        results[dispatch.channel] = { status: "accepted", dispatchId: dispatch.dispatch_id, acceptedAt: now };
      } else {
        const code = this.classifyTransportError(failure);
        this.outbox.markFailed(dispatch, this.workerId, code, this.isRetryableError(failure));
        const latest = this.outbox.getDispatch(dispatch.dispatch_id);
        if (latest?.status === "failed") {
          this.outbox.undoUnansweredThought(this.ownerKey, dispatch.thought_id);
          const state = this.outbox.getState(this.ownerKey);
          if (state) {
            this.unrespondedPings = state.unansweredCount;
            this.nextEligibleAt = state.nextEligibleAt;
          }
        }
        results[dispatch.channel] = { status: dispatch.attempt_count >= 5 ? "failed" : "pending", dispatchId: dispatch.dispatch_id, errorCode: code };
      }
    }
    if (initialDispatches?.length) {
      for (const row of initialDispatches) {
        const latest = this.outbox.getDispatch(row.dispatch_id);
        results[row.channel] ||= { status: latest?.status || row.status, dispatchId: row.dispatch_id };
      }
    }
    return results;
  }

  isQuietHoursNow() {
    const hour = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Jakarta" })).getHours();
    return isWithinQuietHours(hour, 23, 7);
  }

  getRandomCooldownFor(unansweredPings) {
    if (unansweredPings <= 3) return Math.round((30 + Math.random() * 30) * 1000);
    return Math.round((5 + Math.random() * 5) * 60 * 1000);
  }

  isDispatchPolicyAllowed(dispatch) {
    return dispatch.owner_key === this.ownerKey && this.enabled && !this.isQuietHoursNow() &&
      Date.now() >= (this.nextEligibleAt || 0) &&
      this.resolveChannels(dispatch.channel).some(({ targetKey }) => String(targetKey) === dispatch.target_key);
  }

  isRetryableError(error) {
    return error?.retryable !== false && ![400, 401, 403, 404].includes(error?.status);
  }

  getCurrentUnansweredCount() {
    const state = this.outbox.getState(this.ownerKey);
    this.unrespondedPings = normalizeCounter(state?.unansweredCount);
    return this.unrespondedPings;
  }

  setUnansweredCount(count) {
    const normalized = normalizeCounter(count);
    this.outbox.setUnansweredCount(this.ownerKey, normalized);
    this.unrespondedPings = normalized;
    return normalized;
  }

  classifyTransportError(error) {
    return String(error?.code || error?.status || error?.message || "transport_error")
      .replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 100);
  }

  async sendChannel(dispatch) {
    if (this.transport) return (await this.transport(dispatch)) === true ? ACCEPTED : false;
    if (process.env.NODE_ENV === "test") {
      throw Object.assign(new Error("transport_disabled_in_test"), { retryable: false });
    }
    if (dispatch.channel === "telegram") {
      const response = await axios.post(`https://api.telegram.org/bot${config.telegramBotToken}/sendMessage`, {
        chat_id: dispatch.target_key, text: dispatch.content,
      }, { timeout: 15000 });
      if (response.status >= 200 && response.status < 300 && response.data?.ok === true && response.data?.result?.message_id) return ACCEPTED;
      const telegramCode = response.data?.error_code;
      throw Object.assign(new Error("telegram_api_rejected"), {
        status: telegramCode || response.status,
        retryable: response.status >= 500 || telegramCode === 429,
      });
    }
    if (dispatch.channel === "discord") {
      const { client } = await import("../../bots/discordBot.js");
      if (client?.isReady?.()) {
        const user = await client.users.fetch(dispatch.target_key);
        if (!user) throw Object.assign(new Error("discord_user_not_found"), { retryable: false, status: 404 });
        const sentMessage = await user.send(dispatch.content);
        if (sentMessage?.id) return ACCEPTED;
        throw new Error("discord_client_unconfirmed");
      }
      const channelResponse = await axios.post("https://discord.com/api/v10/users/@me/channels",
        { recipient_id: dispatch.target_key }, { headers: { Authorization: `Bot ${config.discordBotToken}` }, timeout: 15000 });
      if (!channelResponse.data?.id) throw Object.assign(new Error("discord_channel_unconfirmed"), { retryable: false, status: 502 });
      const messageResponse = await axios.post(`https://discord.com/api/v10/channels/${channelResponse.data.id}/messages`,
        { content: dispatch.content }, { headers: { Authorization: `Bot ${config.discordBotToken}` }, timeout: 15000 });
      if (messageResponse.status >= 200 && messageResponse.status < 300 && messageResponse.data?.id) return ACCEPTED;
      throw Object.assign(new Error("discord_api_rejected"), { status: messageResponse.status });
    }
    return false;
  }

  async dispatchToPlatforms(text, platform = null, queuedDispatches = null) {
    if (queuedDispatches) return this.processDispatches(queuedDispatches, { recheckPolicy: false });
    const channels = this.resolveChannels(platform);
    const intents = channels.length ? this.outbox.enqueueThought({
      thoughtId: randomUUID(), ownerKey: this.ownerKey, content: text, channels,
    }) : [];
    const results = await this.processDispatches(intents, { recheckPolicy: false });
    return Object.fromEntries(Object.entries(results).map(([channel, result]) => [channel, result.status === "accepted"]));
  }

  startScheduler(checkIntervalMs = 60 * 1000) {
    if (this.intervalHandle) return;
    this.isShuttingDown = false;

    this.restorePersistentState();
    // Check every interval if next random cooldown has elapsed
    this.intervalHandle = setInterval(() => {
      if (this.isShuttingDown || this.schedulerTaskPromise || this.cyclePromise || this.dispatchPromise) return;
      this.schedulerTaskPromise = this.executeSchedulerTick()
        .catch((error) => {
          logger.error(`Proactive scheduler failed: ${error.message}`);
        })
        .finally(() => {
          this.schedulerTaskPromise = null;
        });
    }, checkIntervalMs);

    this.intervalHandle.unref();
    logger.info("Autonomous Proactive Thought & Spam Scheduler started.");
  }

  async executeSchedulerTick() {
    if (this.isShuttingDown) return;
    this.lastSchedulerCheckAt = Date.now();
    const status = this.getStatus();
    const pending = this.outbox.listDueChannels(this.ownerKey);
    if (pending.length) {
      try {
        if (status.enabled && !this.isQuietHoursNow() && Date.now() >= this.nextEligibleAt) {
          await this.processDispatches();
        }
      } catch (error) {
        logger.error(`Proactive retry worker failed: ${error.message}`);
      }
      return;
    }
    if (!status.canSpeakNow) {
      const quiet = isWithinQuietHours(
        new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Jakarta" })).getHours(),
        23,
        7,
      );
      this.lastSchedulerSkipReason = quiet
        ? "quiet-hours"
        : this.unrespondedPings === 0
          ? `idle (${status.timeSinceLastSpokenMinutes}/${status.minIdleMinutes}m)`
          : `follow-up cooldown (${Number(((Date.now() - this.lastProactiveAt) / 60000).toFixed(1))}/${Number(((this.lastProactiveCooldownMs || this.currentCooldownMs) / 60000).toFixed(1))}m)`;
      return;
    }

    this.lastSchedulerSkipReason = null;
    logger.info(`Proactive scheduler eligible: idle ${status.timeSinceLastSpokenMinutes}m, target ${status.targetPlatform || "none"}.`);
    try {
      const result = await this.triggerSpontaneousThought();
      if (!result.triggered) {
        this.lastSchedulerSkipReason = result.reason;
        logger.warn(`Proactive scheduler skipped send: ${result.reason}`);
      }
    } catch (error) {
      logger.error(`Proactive scheduler failed: ${error.message}`);
    }
  }

  stopScheduler() {
    this.isShuttingDown = true;
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
  }

  async drain() {
    this.stopScheduler();
    await Promise.allSettled([
      this.schedulerTaskPromise,
      this.cyclePromise,
      this.dispatchPromise,
    ].filter(Boolean));
  }
}

export const proactiveThoughtService = new ProactiveThoughtService();
