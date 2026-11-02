// Turning the host's paragraphs into LanguageTool requests, and
// LanguageTool's answers back into ranges in those paragraphs.
//
// Several paragraphs go in one request as LanguageTool's `data` parameter:
// each paragraph is text, U+FFFC (an inline object such as a mention chip
// or an image) is markup read as a space, and between paragraphs sits a
// "\n\n" markup read as a paragraph break. LanguageTool counts offsets in
// the whole string, markup included, in UTF-16 code units like JavaScript,
// so a match maps back by subtracting where its paragraph starts. A match
// that covers markup (a separator or an object) is dropped.
//
// A request carries at most `maxBytes` of text (UTF-8). A paragraph longer
// than that is cut at a line break, a sentence end or a space and sent in
// pieces, each with its offset in the paragraph.

import { normalizeMatch } from './matches.js';

export const OBJECT_CHAR = '￼';
const SEPARATOR = '\n\n';

const encoder = new TextEncoder();
export const byteLength = (s) => encoder.encode(s).length;

const isHigh = (c) => c >= 0xd800 && c <= 0xdbff;

/** Where to cut `text` so the first part has at most `maxBytes` bytes. */
function cutPoint(text, maxBytes) {
  // Find the longest prefix within the budget (bytes ≥ code units).
  let end = Math.min(text.length, maxBytes);
  while (end > 0 && byteLength(text.slice(0, end)) > maxBytes) end = Math.floor(end * 0.9);
  if (end >= text.length) return text.length;
  const head = text.slice(0, end);
  const min = Math.floor(end / 2);
  const line = head.lastIndexOf('\n');
  if (line >= min) return line + 1;
  let sentence = -1;
  for (const m of head.matchAll(/[.!?。！？]["'»”’)]*\s+/g)) sentence = m.index + m[0].length;
  if (sentence >= min) return sentence;
  const space = head.search(/\s\S*$/);
  if (space >= min) return space + 1;
  // No break: cut, but never between the halves of a surrogate pair.
  return isHigh(text.charCodeAt(end - 1)) ? end - 1 : end;
}

/** The paragraphs as pieces of at most `maxBytes`: { segmentId, text, base }. */
export function toUnits(segments, maxBytes) {
  const units = [];
  for (const seg of segments) {
    let rest = seg.text;
    let base = 0;
    while (rest.length) {
      const cut = byteLength(rest) <= maxBytes ? rest.length : Math.max(1, cutPoint(rest, maxBytes));
      units.push({ segmentId: seg.id, text: rest.slice(0, cut), base });
      base += cut;
      rest = rest.slice(cut);
    }
  }
  return units;
}

/** Units grouped into requests of at most `maxBytes` (text, objects and separators counted). */
export function toBatches(units, maxBytes) {
  const batches = [];
  let current = [];
  let size = 0;
  for (const unit of units) {
    const bytes = byteLength(unit.text);
    const extra = current.length ? SEPARATOR.length : 0;
    if (current.length && size + extra + bytes > maxBytes) {
      batches.push(current);
      current = [];
      size = 0;
    }
    size += (current.length ? SEPARATOR.length : 0) + bytes;
    current.push(unit);
  }
  if (current.length) batches.push(current);
  return batches;
}

/**
 * The `data` parameter for a batch, and where each unit starts in the
 * string LanguageTool counts offsets in.
 */
export function buildData(units, objectChar = OBJECT_CHAR) {
  const annotation = [];
  const layout = [];
  let at = 0;
  units.forEach((unit, i) => {
    if (i > 0) {
      annotation.push({ markup: SEPARATOR, interpretAs: SEPARATOR });
      at += SEPARATOR.length;
    }
    layout.push({ ...unit, start: at, end: at + unit.text.length });
    const parts = unit.text.split(objectChar);
    parts.forEach((part, j) => {
      if (j > 0) annotation.push({ markup: objectChar, interpretAs: ' ' });
      if (part) annotation.push({ text: part });
    });
    at += unit.text.length;
  });
  return { data: JSON.stringify({ annotation }), layout };
}

/** The form body of a /v2/check request. */
export function buildForm({ data, language, preferredVariants, motherTongue, level, disabledRules, disabledCategories }) {
  const form = new URLSearchParams();
  form.set('data', data);
  form.set('language', language);
  if (language === 'auto' && preferredVariants?.length) form.set('preferredVariants', preferredVariants.join(','));
  if (motherTongue) form.set('motherTongue', motherTongue);
  form.set('level', level === 'picky' ? 'picky' : 'default');
  if (disabledRules?.length) form.set('disabledRules', disabledRules.join(','));
  if (disabledCategories?.length) form.set('disabledCategories', disabledCategories.join(','));
  form.set('enabledOnly', 'false');
  return form.toString();
}

/**
 * LanguageTool's matches for a batch, per paragraph, with offsets in the
 * paragraph: Map segmentId → normalized matches. Every unit's paragraph
 * gets an entry, empty when nothing was found.
 */
export function mapMatches(matches, layout, segmentTexts, objectChar = OBJECT_CHAR) {
  const out = new Map();
  for (const unit of layout) if (!out.has(unit.segmentId)) out.set(unit.segmentId, []);
  for (const raw of Array.isArray(matches) ? matches : []) {
    const m = normalizeMatch(raw);
    if (!m) continue;
    const unit = layout.find((u) => m.offset >= u.start && m.offset + m.length <= u.end);
    if (!unit) continue; // runs over a paragraph break
    const offset = unit.base + (m.offset - unit.start);
    const text = segmentTexts.get(unit.segmentId) ?? '';
    const covered = text.slice(offset, offset + m.length);
    if (covered.length !== m.length || covered.includes(objectChar) || covered.includes('\n') || !covered.trim()) continue;
    out.get(unit.segmentId).push({ ...m, offset, text: covered });
  }
  return out;
}
