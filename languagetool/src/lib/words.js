// The personal dictionary and the organisation's word list: words a
// spelling match may cover without being shown.
//
// Matching:
// - an entry matches the same text exactly ("Bulwark" matches "Bulwark");
// - and the text in capitals ("BULWARK"), as at the start of a shouted line;
// - an entry written all in lower case matches any capitalisation
//   ("jmap" matches "JMAP", "Jmap" and "jmap"), so a word that is lower
//   case in the dictionary is also fine at the start of a sentence;
// - an entry with capitals is not matched in lower case ("Bulwark" does not
//   accept "bulwark"): a name the user wrote with a capital stays a name.
// An entry of several words ("Rath & Blume") also adds each word, because
// LanguageTool flags misspelt words one at a time.

export const MAX_WORD_LENGTH = 100;
export const MAX_DICTIONARY_WORDS = 5000;

/** A word as stored: trimmed, no line breaks, at most MAX_WORD_LENGTH characters; '' when unusable. */
export function cleanWord(value) {
  if (typeof value !== 'string') return '';
  const word = value.replace(/[\r\n\t]+/g, ' ').trim();
  return word.length > MAX_WORD_LENGTH ? '' : word;
}

const hasLetters = (s) => s.toLowerCase() !== s.toUpperCase();

/** A matcher over the given lists of entries. */
export function wordMatcher(...lists) {
  const exact = new Set();
  const upper = new Set();
  const lower = new Set();
  const add = (word) => {
    if (!word) return;
    exact.add(word);
    upper.add(word.toUpperCase());
    if (word === word.toLowerCase() && hasLetters(word)) lower.add(word);
  };
  for (const items of lists) {
    for (const raw of items ?? []) {
      const word = cleanWord(raw);
      if (!word) continue;
      add(word);
      const parts = word.split(/\s+/);
      if (parts.length > 1) for (const part of parts) if (hasLetters(part)) add(part);
    }
  }
  return {
    size: exact.size,
    has(text) {
      if (typeof text !== 'string' || !text) return false;
      if (exact.has(text)) return true;
      if (hasLetters(text) && text === text.toUpperCase() && upper.has(text)) return true;
      return lower.has(text.toLowerCase());
    },
  };
}

/** The list with `word` added (unless already there in that spelling), sorted. */
export function addWord(words, word) {
  const clean = cleanWord(word);
  const current = Array.isArray(words) ? words.filter((w) => typeof w === 'string') : [];
  if (!clean || current.includes(clean) || current.length >= MAX_DICTIONARY_WORDS) return current;
  return [...current, clean].sort((a, b) => a.localeCompare(b));
}

export function removeWord(words, word) {
  return (Array.isArray(words) ? words : []).filter((w) => w !== word);
}
