// LanguageTool's matches: what kind of issue each one is, and the shape
// the plugin keeps (cached per paragraph) and hands to the host.

export const MAX_REPLACEMENTS = 5;

const STYLE_TYPES = new Set(['style', 'register', 'locale-violation', 'inconsistency', 'terminology', 'locale-specific-content']);
const GRAMMAR_TYPES = new Set([
  'grammar', 'typographical', 'duplication', 'whitespace', 'characters', 'numbers', 'omission',
  'addition', 'non-conformance', 'formatting', 'markup', 'pattern-problem', 'inconsistent-entities',
]);
const STYLE_CATEGORIES = new Set(['STYLE', 'REDUNDANCY', 'PLAIN_ENGLISH', 'REGIONALISMS', 'GENDER_NEUTRALITY', 'WIKIPEDIA', 'COLLOQUIALISMS']);
const GRAMMAR_CATEGORIES = new Set([
  'GRAMMAR', 'PUNCTUATION', 'TYPOGRAPHY', 'CASING', 'CONFUSED_WORDS', 'COMPOUNDING', 'COLLOCATIONS',
  'SEMANTICS', 'NONSTANDARD_PHRASES', 'MISUSED_TERMS_EU_PUBLICATIONS', 'AMERICAN_ENGLISH_STYLE', 'BRITISH_ENGLISH',
]);

/** spelling, grammar, style or other, from a match's rule. */
export function kindOf(rule) {
  const issueType = String(rule?.issueType ?? '').toLowerCase();
  const category = String(rule?.category?.id ?? '').toUpperCase();
  if (issueType === 'misspelling' || category === 'TYPOS') return 'spelling';
  if (STYLE_TYPES.has(issueType)) return 'style';
  if (GRAMMAR_TYPES.has(issueType)) return 'grammar';
  if (STYLE_CATEGORIES.has(category)) return 'style';
  if (GRAMMAR_CATEGORIES.has(category)) return 'grammar';
  return 'other';
}

const text = (v) => (typeof v === 'string' ? v.trim() : '');

/**
 * A LanguageTool match in the plugin's shape, with `offset` still where
 * LanguageTool put it. Null for a match without a usable range or message.
 */
export function normalizeMatch(m) {
  if (!m || typeof m !== 'object') return null;
  const { offset, length } = m;
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 1) return null;
  const rule = m.rule && typeof m.rule === 'object' ? m.rule : {};
  const message = text(m.message) || text(m.shortMessage) || text(rule.description);
  if (!message) return null;
  const replacements = [];
  for (const r of Array.isArray(m.replacements) ? m.replacements : []) {
    if (replacements.length >= MAX_REPLACEMENTS) break;
    const value = r && typeof r.value === 'string' ? r.value : null;
    // An empty replacement (delete the word) would be a button with no label.
    if (!value || /[\r\n]/.test(value) || replacements.includes(value)) continue;
    replacements.push(value);
  }
  const out = { offset, length, kind: kindOf(rule), message, replacements };
  const short = text(m.shortMessage);
  if (short && short !== message) out.shortMessage = short;
  if (text(rule.id)) out.ruleId = text(rule.id);
  if (text(rule.description)) out.ruleLabel = text(rule.description);
  if (text(rule.category?.id)) out.categoryId = text(rule.category.id).toUpperCase();
  return out;
}
