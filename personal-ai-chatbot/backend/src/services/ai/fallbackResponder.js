import { getCurrentTimeInfo } from "../../utils/timeUtils.js";

const normalizeText = (text) => (text || "")
  .toLocaleLowerCase("id-ID")
  .normalize("NFD")
  .replace(/[\u0300-\u036f]/g, "")
  .replace(/[^\p{L}\p{N}\s]/gu, " ")
  .replace(/\s+/g, " ")
  .trim();

const levenshteinDistance = (left, right) => {
  if (left.length > right.length) [left, right] = [right, left];
  let previous = Array.from({ length: left.length + 1 }, (_, index) => index);
  for (let row = 1; row <= right.length; row += 1) {
    const current = [row];
    for (let column = 1; column <= left.length; column += 1) {
      current[column] = Math.min(
        current[column - 1] + 1,
        previous[column] + 1,
        previous[column - 1] + (left[column - 1] === right[row - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[left.length];
};

const hasIntentWord = (message, words) => message.split(" ").some((token) =>
  words.some((word) => token.length >= 4 && levenshteinDistance(token, word) <= Math.max(1, Math.floor(word.length * 0.2))),
);

const isTimeQuestion = (message) => {
  const lower = normalizeText(message);
  return /jam berapa|pukul berapa|waktu sekarang|sekarang jam|jam sekarang|berapa jam|waktu wib|jam wib|hari ini tanggal|tanggal berapa|hari apa sekarang/.test(lower);
};

export const buildFallbackReply = (message, memoryFacts = []) => {
  const lower = normalizeText(message);
  const memorySnippet = memoryFacts.length
    ? `(Aku ingat: ${memoryFacts.slice(0, 3).join(", ")})`
    : "";

  if (isTimeQuestion(lower)) {
    return `Sekarang hari ${getCurrentTimeInfo()} WIB. ${memorySnippet || "Ada yang bisa kubantu lagi?"}`;
  }
  if (hasIntentWord(lower, ["dimana", "berbicara", "ngobrol", "chat"]) && hasIntentWord(lower, ["kita", "saya", "aku"])) {
    return `Sekarang kita sedang chat lewat Discord, Alfaa.`;
  }
  if (hasIntentWord(lower, ["bisa", "dapat", "mampu"]) && hasIntentWord(lower, ["edit", "ubah", "akses", "izin", "memory", "memori", "sistem"])) {
    return `Bisa, Alfaa. Aku bisa mengubah memori yang diizinkan lewat backend, tapi tidak punya akses bebas ke seluruh sistem.`;
  }
  if (hasIntentWord(lower, ["discord", "telegram", "web", "private", "message", "dm"]) && hasIntentWord(lower, ["sudah", "kan", "tadi", "barusan", "lagi", "sedang", "chat", "bicara"])) {
    return `Iya, kita sedang chat lewat Discord. Kamu benar—aku seharusnya mengingat konteks itu.`;
  }
  if (hasIntentWord(lower, ["siapa", "nama"])) {
    return `Saya Lucy, asisten AI pribadi yang dibuat oleh Alfaa. ${memorySnippet || "Aku siap membantu berbagai kebutuhanmu!"}`;
  }
  if (hasIntentWord(lower, ["tujuan", "buat", "fungsi"])) {
    return `Saya dibuat sebagai asisten AI pribadi untuk chatting, pengingat, voice assistant, dan integrasi VTube Studio.`;
  }
  if (hasIntentWord(lower, ["fitur", "fiturku", "kemampuan"])) {
    return `Fiturku: chat AI, memori, pengingat, integrasi Discord dan Telegram, voice assistant, VTube Studio, serta simulasi osu!.`;
  }
  if (/terima kasih|makasih|thanks/.test(lower)) {
    return `Sama-sama! Senang bisa membantu kamu 😊`;
  }
  if (hasIntentWord(lower, ["halo", "hai", "hey"])) {
    return `Halo! Saya Lucy. Ada yang bisa kubantu hari ini?`;
  }

  return lower
    ? `Aku belum menangkap maksudmu, Alfaa. Bisa jelaskan sedikit lagi?`
    : `Saya Lucy, asisten pribadi kamu. ${memorySnippet ? `${memorySnippet} ` : ""}Ada yang bisa kubantu lagi?`;
};
