const KEYBOARD_EMOTES = [">-<", ":3", ";_;", "^_^", "T_T", "._.", "O_O"];

export const removeStageDirections = (text) => {
  let result = text
    .replace(/\*{1,2}([^*\r\n]+)\*{1,2}/g, " ")
    .replace(/(^|\s)_[^_\r\n]+_(?=\s|$)/g, " ")
    .replace(/~{1,2}([^~\r\n]+)~{1,2}/g, " ")
    .replace(/\([^()\r\n]*\)/g, " ")
    .replace(/\[(?:aksi|ekspresi|tertawa|tersenyum|berpikir|berbisik)[^\]\r\n]*\]/gi, " ")
    .replace(/(?:^|\s)\/[^/\r\n]+\/(?=\s|$)/g, " ")
    .replace(/\b(?:berdiri|duduk|berjalan|berlari|melompat|menari|tertawa|ketawa|tersenyum|menyeringai|menghela napas|menangis|berpikir|melambaikan tangan|mengangguk|menggeleng|tutup mata|menutup mata|melotot|mengedipkan mata|mengangkat alis|mengernyitkan dahi|ceria)(?:\s+[\p{L}\p{M}]+){0,2}(?:\s+[\p{Extended_Pictographic}]+)?(?=\s|[,.;!?"]|$)/giu, " ")
    .replace(/\s{2,}/g, " ")
    .replace(/[,;]\s*([.!?])/g, "$1")
    .replace(/\s+([,.;!?])/g, "$1")
    .replace(/([.!?])\s*([.!?])+/g, "$1")
    .trim();

  if (!result && text.trim()) return KEYBOARD_EMOTES[Math.floor(Math.random() * KEYBOARD_EMOTES.length)];
  return result;
};
