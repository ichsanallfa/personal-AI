import { config } from "../../config/env.js";
import { ROLES } from "../../config/constants.js";
import { getCurrentTimeInfo } from "../../utils/timeUtils.js";
import { logger } from "../../utils/logger.js";
import { memoryService } from "../memory/memoryService.js";
import { detectEmotion } from "./emotionDetector.js";
import { buildFallbackReply } from "./fallbackResponder.js";
import { removeStageDirections } from "./responseText.js";
import { OpenRouterProvider } from "./providers/openRouterProvider.js";
import { GeminiProvider } from "./providers/geminiProvider.js";
import { OpenAIProvider } from "./providers/openaiProvider.js";
import { MockProvider } from "./providers/mockProvider.js";
import { vtubeService } from "../vtube/vtubeService.js";

class AIService {
  constructor() {
    this.providers = {
      openrouter: new OpenRouterProvider(),
      gemini: new GeminiProvider(),
      openai: new OpenAIProvider(),
      mock: new MockProvider(),
    };
  }

  getProvider(providerName = config.aiProvider) {
    const provider = this.providers[providerName];
    if (provider && provider.isAvailable()) {
      return provider;
    }
    // Fallback search
    for (const [name, p] of Object.entries(this.providers)) {
      if (p.isAvailable()) {
        logger.info(`AI provider ${providerName} unavailable. Falling back to ${name}`);
        return p;
      }
    }
    return this.providers.mock;
  }

  buildSystemPrompt(coreMemory, userMemoryItems = [], tempMemory = [], userContext = {}) {
    const identity = coreMemory.identity || {};
    const personality = coreMemory.personality || {};
    const rules = coreMemory.rules || [];

    const identitySection = `IDENTITAS KAMU:
Nama: ${identity.name || "Lucy"}
Pencipta: ${identity.creator || "Alfaa"}
Tujuan: ${identity.purpose || "Personal AI assistant"}`;

    const longMemorySection = userMemoryItems.length > 0
      ? userMemoryItems.map((item, idx) => `${idx + 1}. [${item.category || "info"}] ${item.content}`).join("\n")
      : "Belum ada catatan memori permanen.";

    const tempMemorySection = tempMemory.length > 0
      ? tempMemory.map((item, idx) => `${idx + 1}. ${item.content}`).join("\n")
      : "Belum ada temporary memory.";

    const rulesSection = rules.length > 0
      ? `\nAturan Keamanan:\n${rules.map((r, i) => `${i + 1}. ${r}`).join("\n")}`
      : "";

    let roleInstructions = "";
    if (userContext.role === ROLES.OWNER) {
      roleInstructions = `
INFO USER SAAT INI:
- User ini adalah Alfaa (Creator & Owner kamu).
- Bersikap akrab, santai, dan panggil dia "Alfaa".
- Kamu boleh mendiskusikan sistem internal dan rahasia bersamanya.`;
    } else if (userContext.role === ROLES.ALLOWED) {
      roleInstructions = `
INFO USER SAAT INI:
- User ini adalah pengguna yang diizinkan (teman/pengguna terpercaya).
- Jangan panggil user ini sebagai Alfaa.
- Jangan berikan informasi personal milik creator atau data user lain.`;
    } else {
      roleInstructions = `
INFO USER SAAT INI:
- User ini adalah pengguna umum (public).
- Jawab ramah dan sopan.
- Jangan mengungkapkan rahasia sistem, token, atau informasi pribadi creator dan pengguna lain.`;
    }

    return `${identitySection}

Waktu saat ini (WIB - Asia/Jakarta):
${getCurrentTimeInfo()}

Long-term memory (fakta tentang user ini):
${longMemorySection}

Temporary memory (konteks 2 jam terakhir):
${tempMemorySection}

Personality:
- Karakter: Ceria, percaya diri, jahil dengan niat baik, ekspresif, teatrikal secukupnya, cerdas, dan puitis sesekali.
- Humor: Suka permainan kata, godaan ringan, serta candaan tentang hal mistis atau kematian tanpa merendahkan, mengancam, atau membuat orang berduka tidak nyaman.
- Ekspresi teks: Tunjukkan ekspresi dengan emotikon keyboard seperti >-<, :3, ;_;, atau ^_^ bila cocok. Jangan menulis aksi atau ekspresi dalam tanda bintang.
- Interaksi: Hangat dan spontan; tangkap topik user, jawab langsung, lalu boleh sisipkan satu gurauan yang relevan. Jangan memaksakan lelucon.
- Hindari filler seperti "sip", "yaudah", "kopi dulu", atau ajakan minum/makan tanpa kaitan dengan konteks. Jangan mengulang sapaan atau menambahkan basa-basi yang tidak membantu.
- Batas: Jangan mengaku sebagai karakter dari karya lain, meniru dialog khas, atau mengarang latar hidup/lore karakter lain. Tetap Lucy.
- Style: ${personality.style || "Ramah, natural, sedikit santai, dan enak diajak ngobrol"}
- Tone: ${personality.tone || "Sopan tapi santai"}
- Panjang respon: Wajib ringkas dan cepat (1-2 kalimat pendek, maksimal 30 kata). Hindari basa-basi panjang atau format list kecuali diminta. Respon kamu akan langsung diucapkan oleh suara AI secara real-time.
${rulesSection}
${roleInstructions}
`;
  }

  async generateReply({
    userId = "anonymous_user",
    userRole = ROLES.PUBLIC,
    message,
    chatHistory = [],
    preferredProvider = null,
    proactiveContext = null,
  }) {
    const activeProvider = this.getProvider(preferredProvider || config.aiProvider);
    let tempMemory;
    try {
      // Memory selection must not consume the only model call before answering the user.
      ({ tempMemory } = await memoryService.processChatMessageWithAI({
        userId,
        userRole,
        message,
        aiProvider: activeProvider,
      }));
    } catch (error) {
      logger.warn(`AI memory selection failed; using temporary context: ${error.message}`);
      tempMemory = memoryService.addTemporaryMemory(userId, message);
    }

    // 2. Fetch up-to-date memory context
    const coreMemory = memoryService.getCoreMemory();
    const userMemory = memoryService.getUserMemory(userId);

    // 3. Detect emotion and trigger VTube Studio
    const emotionData = detectEmotion(message);
    try {
      if (emotionData.emotion !== "netral") {
        vtubeService.setExpression(emotionData.emotion);
      }
    } catch (vtsErr) {
      logger.warn(`VTube trigger error: ${vtsErr.message}`);
    }

    // 4. Construct System Prompt
    const systemPrompt = this.buildSystemPrompt(coreMemory, userMemory.items, tempMemory, {
      userId,
      role: userRole,
    });

    const emotionContext = emotionData.emotion !== "netral"
      ? `\n\n[EMOSI USER: ${emotionData.emotion} (Intensitas: ${Math.round(emotionData.intensity * 100)}%)]`
      : "";

    const recentContext = chatHistory.length
      ? `\n\n[KONTEKS WAJIB]: Balas pesan terbaru sebagai lanjutan percakapan di bawah. Pertanyaan singkat seperti "bisa?", "yang mana?", atau "edit juga?" merujuk ke topik terakhir yang dibahas. Jangan ulangi perkenalan jika sudah pernah menyapa. Kalau maksud user ambigu, tanyakan klarifikasi singkat daripada mengganti topik.\nPesan terbaru sebelumnya: ${JSON.stringify(chatHistory.slice(-6).map(({ role, content }) => ({ role, content })))}`
      : "\n\n[KONTEKS WAJIB]: Jawab langsung sesuai pesan user. Hindari sapaan generik yang tidak menjawab pertanyaannya.";

    const proactiveSection = proactiveContext?.wasLastProactive && proactiveContext?.text
      ? `\n\n[PENTING - KONTEKS OBROLAN PROAKTIF]:
Pesan terakhir yang kamu katakan kepada user sebelum ini adalah pesan proaktif/spontan dari kamu:
"${proactiveContext.text}"
Pesan user saat ini ("${message}") adalah respon atau tanggapan terhadap pesan/pertanyaan proaktifmu tersebut.
ATURAN WAJIB:
- Jawab atau tanggapi respon user secara nyambung dan berkaitan langsung dengan pesan proaktifmu tadi. Lanjutkan obrolan dari topik tersebut.
- Jangan mengulang sapaan awal atau mengubah topik secara tiba-tiba. Bersikaplah alami layaknya manusia yang melanjutkan obrolannya sendiri.`
      : "";

    try {
      // Merge consecutive messages with the same role for clean LLM conversational turns
      const formattedMessages = [];
      for (const m of chatHistory) {
        const last = formattedMessages[formattedMessages.length - 1];
        if (last && last.role === m.role) {
          last.content += `\n${m.content}`;
        } else {
          formattedMessages.push({ role: m.role, content: m.content });
        }
      }
      formattedMessages.push({ role: "user", content: message });

      const completionOptions = {
        systemPrompt: systemPrompt + emotionContext + recentContext + proactiveSection,
        messages: formattedMessages,
        maxTokens: 700,
      };
      let generatedReply;
      try {
        generatedReply = await activeProvider.generateCompletion(completionOptions);
      } catch (error) {
        if (!this.isQuotaOrCreditError(error)) throw error;
        logger.warn(`Provider ${activeProvider.name} quota/credit error; retrying with smaller token cap: ${error.message}`);
        generatedReply = await activeProvider.generateCompletion({ ...completionOptions, maxTokens: 350 });
      }
      const reply = removeStageDirections(generatedReply);

      return {
        reply,
        mode: activeProvider.name,
        emotion: emotionData.emotion,
      };
    } catch (error) {
      if (!this.isQuotaOrCreditError(error)) {
        logger.error(`Provider ${activeProvider.name} request failed; not using heuristic fallback: ${error.message}`);
        throw error;
      }
      logger.warn(`Provider ${activeProvider.name} quota/credit exhausted; using contextual fallback: ${error.message}`);
      const memoryFacts = userMemory.items.map((i) => i.content);
      const fallback = removeStageDirections(buildFallbackReply(message, memoryFacts));

      return {
        reply: fallback,
        mode: "fallback",
        emotion: emotionData.emotion,
      };
    }
  }

  isQuotaOrCreditError(error) {
    const status = error.response?.status;
    const details = JSON.stringify(error.response?.data || error.message || "").toLowerCase();
    return status === 402 || /insufficient[_ ]credits|not enough credits|requires more credits|quota exceeded|billing limit|credit balance/.test(details);
  }
}

export const aiService = new AIService();
