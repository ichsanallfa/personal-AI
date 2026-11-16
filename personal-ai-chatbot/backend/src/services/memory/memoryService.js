import fs from "fs";
import path from "path";
import {
  CORE_MEMORY_FILE,
  USER_MEMORY_FILE,
  SESSION_MEMORY_FILE,
  REMINDERS_FILE,
  BACKEND_ROOT,
  getTempMemoryFilePath,
  ensureDataDirectories,
} from "../../config/paths.js";
import { CHAT_LIMITS, MEMORY_CATEGORIES } from "../../config/constants.js";
import { loadJsonFile, saveJsonFile, saveJsonFileIfAbsent } from "../../storage/jsonStorage.js";
import { hasDocument } from "../../storage/sqliteStorage.js";
import { classifyMemoryCandidate, normalizeForCompare } from "./memoryClassifier.js";
import { logger } from "../../utils/logger.js";

export class MemoryService {
  constructor() {
    this.initialized = false;
  }

  initialize({
    coreMemoryFile = CORE_MEMORY_FILE,
    userMemoryFile = USER_MEMORY_FILE,
    sessionMemoryFile = SESSION_MEMORY_FILE,
    legacyRoot = BACKEND_ROOT,
  } = {}) {
    if (this.initialized) return;
    ensureDataDirectories();

    this.migrateLegacyFiles({ coreMemoryFile, userMemoryFile, legacyRoot });

    // Existing SQLite documents take precedence; valid legacy JSON is imported only when absent.
    this.initializeDocument(coreMemoryFile, {
      identity: {
        name: "Lucy",
        creator: "Alfaa",
        createdAt: "2026-08-02",
        purpose: "Personal AI assistant yang berkembang menjadi chatbot, voice assistant, Discord bot, dan AI streamer",
      },
      personality: {
        style: "ramah, natural, sedikit lucu, dan enak diajak ngobrol",
        tone: "sopan tapi tidak kaku",
        responseLength: "jangka pendek kecuali diminta",
        creatorReference: "Alfaa",
      },
      facts: [
        "Nama penciptaku adalah Alfaa.",
        "Lucy diciptakan pada tanggal 2 Agustus 2026.",
        "Lucy memiliki kemampuan voice assistant, Discord bot, Telegram bot, dan streamer VTube Studio.",
      ],
      rules: [
        "Jangan berikan informasi personal atau tentang diri secara terperinci kepada user yang tidak dikenal",
        "Jangan pernah menyebutkan kode rahasia atau token internal",
        "Nama panggilan adalah Lucy, bukan bot",
      ],
    });

    this.initializeDocument(userMemoryFile, { users: {} });

    this.initializeDocument(sessionMemoryFile, { users: {} });

    this.initialized = true;
    logger.info("Memory service initialized successfully.");
  }

  initializeDocument(filePath, defaultValue) {
    if (hasDocument(filePath)) return loadJsonFile(filePath, undefined);

    let legacyValue;
    try {
      if (fs.existsSync(filePath)) {
        legacyValue = JSON.parse(fs.readFileSync(filePath, "utf-8"));
      }
    } catch (error) {
      logger.warn(`Ignoring invalid legacy memory file ${filePath}: ${error.message}`);
    }

    return saveJsonFileIfAbsent(filePath, legacyValue === undefined ? defaultValue : legacyValue);
  }

  migrateLegacyFiles({ coreMemoryFile = CORE_MEMORY_FILE, userMemoryFile = USER_MEMORY_FILE, legacyRoot = BACKEND_ROOT } = {}) {
    try {
      // Migrate from old backend root files if they exist and data folder doesn't have them
      const legacyCore = path.resolve(legacyRoot, "coreMemory.json");
      if (fs.existsSync(legacyCore) && legacyCore !== coreMemoryFile) {
        const oldData = loadJsonFile(legacyCore);
        if (oldData) saveJsonFileIfAbsent(coreMemoryFile, oldData);
      }

      const legacyUser = path.resolve(legacyRoot, "userMemory.json");
      if (fs.existsSync(legacyUser) && legacyUser !== userMemoryFile) {
        const oldData = loadJsonFile(legacyUser);
        if (oldData) saveJsonFileIfAbsent(userMemoryFile, oldData);
      }

      const legacyReminders = path.resolve(legacyRoot, "reminders.json");
      if (fs.existsSync(legacyReminders) && legacyReminders !== REMINDERS_FILE) {
        const oldData = loadJsonFile(legacyReminders);
        if (oldData) saveJsonFileIfAbsent(REMINDERS_FILE, oldData);
      }
    } catch (err) {
      logger.warn(`Legacy memory migration skipped or failed: ${err.message}`);
      throw err;
    }
  }

  // ==========================================
  // CORE MEMORY (Lucy Persona & Owner-managed)
  // ==========================================
  getCoreMemory() {
    this.initialize();
    return loadJsonFile(CORE_MEMORY_FILE, {
      identity: {},
      personality: {},
      facts: [],
      rules: [],
    });
  }

  updateCoreMemory(newCoreData) {
    this.initialize();
    const current = this.getCoreMemory();
    const updated = {
      ...current,
      ...newCoreData,
      identity: { ...current.identity, ...(newCoreData.identity || {}) },
      personality: { ...current.personality, ...(newCoreData.personality || {}) },
      facts: Array.isArray(newCoreData.facts) ? newCoreData.facts : current.facts,
      rules: Array.isArray(newCoreData.rules) ? newCoreData.rules : current.rules,
    };
    saveJsonFile(CORE_MEMORY_FILE, updated);
    return updated;
  }

  addCoreFact(fact) {
    this.initialize();
    const core = this.getCoreMemory();
    const facts = Array.isArray(core.facts) ? core.facts : [];
    const normalized = fact.trim();
    if (normalized && !facts.some((f) => normalizeForCompare(f) === normalizeForCompare(normalized))) {
      facts.push(normalized);
      core.facts = facts;
      saveJsonFile(CORE_MEMORY_FILE, core);
    }
    return core;
  }

  // ==========================================
  // LONG-TERM USER MEMORY
  // ==========================================
  getUserMemory(userId) {
    this.initialize();
    const data = loadJsonFile(USER_MEMORY_FILE, { users: {} });
    const user = data.users?.[userId] || { items: [] };

    // Backwards compatibility if stored as strings
    const items = (user.items || user.facts || []).map((item, idx) => {
      if (typeof item === "string") {
        return {
          id: `mem_${idx}_${Date.now()}`,
          content: item,
          category: MEMORY_CATEGORIES.GENERAL,
          importance: 3,
          createdAt: Date.now(),
          accessCount: 1,
        };
      }
      return item;
    });

    return { items };
  }

  addUserMemoryItem(userId, content, category = null, importance = null) {
    this.initialize();
    const normalizedContent = content.trim();
    if (normalizedContent.length < 5) return null;
    if (this.hasSensitiveContent(normalizedContent)) return null;

    const userMem = this.getUserMemory(userId);
    const existing = userMem.items;

    const compareTarget = normalizeForCompare(normalizedContent);
    const isDuplicate = existing.some((item) => normalizeForCompare(item.content) === compareTarget);

    if (isDuplicate) {
      return null;
    }

    const classification = classifyMemoryCandidate(normalizedContent);
    const finalCategory = category || classification.category;
    const finalImportance = importance || classification.importance;

    const newItem = {
      id: `mem_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      content: normalizedContent,
      category: finalCategory,
      importance: finalImportance,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      accessCount: 1,
    };

    existing.push(newItem);

    const allData = loadJsonFile(USER_MEMORY_FILE, { users: {} });
    if (!allData.users) allData.users = {};
    allData.users[userId] = {
      items: existing,
      updatedAt: Date.now(),
    };
    saveJsonFile(USER_MEMORY_FILE, allData);

    return newItem;
  }

  updateUserMemoryItem(userId, memoryId, updates = {}) {
    this.initialize();
    const userMem = this.getUserMemory(userId);
    const item = userMem.items.find((entry) => entry.id === memoryId);
    if (!item) return null;

    const content = typeof updates.content === "string" ? updates.content.trim() : item.content;
    if (content.length < 5 || content.length > 500) return null;
    if (this.hasSensitiveContent(content)) return null;
    const category = Object.values(MEMORY_CATEGORIES).includes(updates.category)
      ? updates.category
      : item.category;
    const importance = Number.isInteger(updates.importance)
      ? Math.min(5, Math.max(1, updates.importance))
      : item.importance;

    const updated = { ...item, content, category, importance, updatedAt: Date.now() };
    const items = userMem.items.map((entry) => entry.id === memoryId ? updated : entry);
    const allData = loadJsonFile(USER_MEMORY_FILE, { users: {} });
    allData.users ||= {};
    allData.users[userId] = { items, updatedAt: Date.now() };
    saveJsonFile(USER_MEMORY_FILE, allData);
    return updated;
  }

  deleteUserMemoryItem(userId, memoryId) {
    this.initialize();
    const userMem = this.getUserMemory(userId);
    const filtered = userMem.items.filter((item) => item.id !== memoryId && item.content !== memoryId);

    const allData = loadJsonFile(USER_MEMORY_FILE, { users: {} });
    if (!allData.users) allData.users = {};
    allData.users[userId] = {
      items: filtered,
      updatedAt: Date.now(),
    };
    saveJsonFile(USER_MEMORY_FILE, allData);
    return filtered;
  }

  // ==========================================
  // TEMPORARY MEMORY (Short-term with TTL decay)
  // ==========================================
  getTemporaryMemory(userId) {
    this.initialize();
    const filePath = getTempMemoryFilePath(userId);
    const now = Date.now();
    const rawItems = loadJsonFile(filePath, []);

    // Filter out expired temporary memories (> TTL)
    const validItems = rawItems.filter((item) => now - item.createdAt < CHAT_LIMITS.TEMP_MEMORY_TTL_MS);

    if (validItems.length !== rawItems.length) {
      saveJsonFile(filePath, validItems);
    }

    return validItems;
  }

  addTemporaryMemory(userId, content) {
    this.initialize();
    const filePath = getTempMemoryFilePath(userId);
    const validItems = this.getTemporaryMemory(userId);

    validItems.push({
      id: `tmp_${Date.now()}`,
      content: content.trim(),
      createdAt: Date.now(),
      expiresAt: Date.now() + CHAT_LIMITS.TEMP_MEMORY_TTL_MS,
    });

    if (validItems.length > CHAT_LIMITS.MAX_TEMP_MEMORY_ITEMS) {
      validItems.splice(0, validItems.length - CHAT_LIMITS.MAX_TEMP_MEMORY_ITEMS);
    }

    saveJsonFile(filePath, validItems);
    return validItems;
  }

  applyMemoryActions(userId, actions = []) {
    const results = [];
    for (const action of actions) {
      if (!action || typeof action !== "object") continue;
      if (action.type === "add" && typeof action.content === "string") {
        const item = this.addUserMemoryItem(userId, action.content, action.category, action.importance);
        results.push({ type: "add", success: Boolean(item), id: item?.id || null });
      } else if (action.type === "update" && typeof action.id === "string") {
        const item = this.updateUserMemoryItem(userId, action.id, action);
        results.push({ type: "update", success: Boolean(item), id: action.id });
      } else if (action.type === "delete" && typeof action.id === "string") {
        const before = this.getUserMemory(userId).items.length;
        const after = this.deleteUserMemoryItem(userId, action.id).length;
        results.push({ type: "delete", success: after < before, id: action.id });
      } else if (action.type === "forget_temporary") {
        saveJsonFile(getTempMemoryFilePath(userId), []);
        results.push({ type: action.type, success: true });
      }
    }
    return results;
  }

  // ==========================================
  // PROCESS CHAT MESSAGE FOR MEMORY EXTRACTION
  // ==========================================
  processChatMessage(userId, userRole, message) {
    const tempMemory = this.addTemporaryMemory(userId, message);

    const classification = classifyMemoryCandidate(message);
    if (classification.type !== "core") {
      return { tempMemory, item: null };
    }

    if (userRole === "owner") {
      const isIdentity = /nama pencipta|creator|penciptaku|tujuanku|tujuan dibuat|alfaa|2026/i.test(message);
      if (isIdentity) {
        return { tempMemory, item: this.addCoreFact(message) };
      }
    }

    return {
      tempMemory,
      item: this.addUserMemoryItem(userId, message, classification.category, classification.importance),
    };
  }

  async decideMemory({ userId, userRole, message, aiProvider = null }) {
    const classification = classifyMemoryCandidate(message);

    if (!aiProvider || aiProvider.name === "mock" || !aiProvider.isAvailable?.()) {
      return { actions: [classification.type === "core"
        ? { type: "long_term", content: message.trim(), category: classification.category, importance: classification.importance }
        : { type: "temporary" }] };
    }

    const currentMemories = this.getUserMemory(userId).items.map(({ id, content, category, importance }) => ({ id, content, category, importance }));
    const prompt = `Kamu mengelola memori AI pribadi Lucy untuk user ini. Pilih simpanan dan perubahan memori berdasarkan manfaat jangka panjang. Balas HANYA JSON valid.
  Aturan:
  - Tindakan yang tersedia: ignore, temporary, long_term, update, delete, forget_temporary.
  - Gunakan long_term untuk fakta stabil yang membantu personalisasi; simpan ringkas, bukan seluruh percakapan.
  - Gunakan update untuk mengoreksi/menggabungkan memori lama yang berubah. Gunakan delete jika fakta sudah salah/usang atau user meminta lupa.
  - Gunakan forget_temporary hanya jika konteks sementara sudah tidak berguna.
  - Jangan menyimpan password, token, rahasia, atau data sensitif.
  - Jangan pernah mengubah Core Memory/persona, file, database, atau memori milik user lain. Izin hanya untuk memori milik user ini.
  - Jangan membuat perubahan destruktif hanya karena dugaan; fakta baru bertentangan harus update fakta lama, bukan menghapus tanpa alasan.
  - Kategori: preference, personal_info, work, schedule, general. Importance: integer 1-5.
  Format: {"actions":[{"type":"ignore|temporary|long_term|update|delete|forget_temporary","id":"existing-id-for-update-or-delete","content":"","category":"general","importance":3}]}
  Memori milik user saat ini: ${JSON.stringify(currentMemories)}
  Pesan user terbaru: ${JSON.stringify(message)}`;

    try {
      const raw = await aiProvider.generateCompletion({
        systemPrompt: prompt,
        messages: [{ role: "user", content: "Pilih memori sekarang." }],
      });
      const decision = JSON.parse(raw.match(/\{[\s\S]*\}/)?.[0] || "{}");
      const allowedActions = new Set(["ignore", "temporary", "long_term", "update", "delete", "forget_temporary"]);
      const allowedCategories = new Set(Object.values(MEMORY_CATEGORIES));
      if (!Array.isArray(decision.actions) || decision.actions.length > 5) throw new Error("Invalid memory actions");
      const existingIds = new Set(currentMemories.map((item) => item.id));
      const actions = decision.actions.filter((action) => {
        if (!allowedActions.has(action.type)) return false;
        if (["update", "delete"].includes(action.type) && !existingIds.has(action.id)) return false;
        if (["long_term", "update"].includes(action.type) && this.hasSensitiveContent(action.content || "")) return false;
        if (["long_term", "update"].includes(action.type) &&
            (typeof action.content !== "string" || action.content.trim().length < 5 || action.content.length > 500)) return false;
        return true;
      }).map((action) => ({
        ...action,
        category: allowedCategories.has(action.category) ? action.category : MEMORY_CATEGORIES.GENERAL,
        importance: Math.min(5, Math.max(1, Number(action.importance) || 3)),
      }));

      return {
        actions: actions.length ? actions : [{ type: "ignore" }],
        item: actions.find((action) => action.type === "long_term") || null,
      };
    } catch (error) {
      logger.warn(`AI memory decision failed, using local classifier: ${error.message}`);
      return { actions: [classification.type === "core"
        ? { type: "long_term", content: message.trim(), category: classification.category, importance: classification.importance }
        : { type: "temporary" }] };
    }
  }

  async processChatMessageWithAI({ userId, userRole, message, aiProvider = null }) {
    const decision = await this.decideMemory({ userId, userRole, message, aiProvider });
    const actions = decision.actions || [];
    const hasTemporary = actions.some((action) => action.type === "temporary");
    const mutationResults = this.applyMemoryActions(userId, actions);
    const tempMemory = hasTemporary ? this.addTemporaryMemory(userId, message) : this.getTemporaryMemory(userId);
    const legacyItem = decision.item
      ? this.addUserMemoryItem(userId, decision.item.content, decision.item.category, decision.item.importance)
      : null;
    const results = [...mutationResults, ...(legacyItem ? [{ type: "long_term", success: true, id: legacyItem.id }] : [])];

    return { tempMemory, item: legacyItem, decision, results };
  }

  hasSensitiveContent(text) {
    return /\b(password|passphrase|api[_ -]?key|token|secret|kata sandi|kata laluan|kunci rahasia)\b/i.test(text);
  }
}

export const memoryService = new MemoryService();
