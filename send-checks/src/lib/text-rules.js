/**
 * The admin's keywords and patterns.
 *
 * Keywords: one per line, matched without regard to case; a keyword that
 * starts and ends with a letter or digit only matches as a whole word
 * ("secret" doesn't match "secretary").
 *
 * Patterns: one per line, `Name: regex` or `Name: /regex/flags`, or just the
 * regex. An admin's regex can be slow on purpose or by accident, so each is
 * checked first (length, nested quantifiers, back references), the text is
 * scanned in pieces, and the whole scan stops after a time budget.
 */

export const MAX_PATTERN_LENGTH = 200;
export const MAX_RULES = 50;
const CHUNK = 8 * 1024;
const OVERLAP = 256;
export const PATTERN_BUDGET_MS = 250;

function lines(value) {
  return String(value ?? '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The admin's keyword list as matchers. */
export function parseKeywords(value) {
  const out = [];
  const seen = new Set();
  for (const keyword of lines(value).slice(0, MAX_RULES * 4)) {
    const key = keyword.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const wordStart = /^[\p{L}\p{N}]/u.test(keyword) ? '(?<![\\p{L}\\p{N}_])' : '';
    const wordEnd = /[\p{L}\p{N}]$/u.test(keyword) ? '(?![\\p{L}\\p{N}_])' : '';
    out.push({ keyword, re: new RegExp(`${wordStart}${escapeRegex(keyword)}${wordEnd}`, 'iu') });
  }
  return out;
}

export function findKeywords(text, keywords) {
  if (!text) return [];
  return keywords.filter((k) => k.re.test(text)).map((k) => k.keyword);
}

/**
 * Why a pattern is refused, or null when it may run. Nested quantifiers
 * like (a+)+ or (\w*)* and back references are the usual causes of
 * catastrophic backtracking.
 */
export function patternProblem(source) {
  if (!source) return 'empty';
  if (source.length > MAX_PATTERN_LENGTH) return 'too long';
  if (/\\[1-9]|\\k</.test(source)) return 'back reference';
  // A group with a quantifier inside, followed by another quantifier.
  if (/\((?:[^()\\]|\\.)*(?:[+*]|\{\d+,?\d*\})(?:[^()\\]|\\.)*\)\s*(?:[+*]|\{\d+,?\d*\})/.test(source)) return 'nested quantifier';
  // Alternatives that overlap inside a repeated group, e.g. (a|a)+ or (\w|\d)*.
  if (/\((?:[^()\\]|\\.)*\|(?:[^()\\]|\\.)*\)\s*(?:[+*]|\{\d+,?\d*\})/.test(source)) return 'repeated alternation';
  return null;
}

/**
 * The admin's pattern lines as { name, re }; broken or refused lines are
 * left out and returned in `skipped` with the reason.
 */
export function parsePatterns(value) {
  const rules = [];
  const skipped = [];
  for (const line of lines(value).slice(0, MAX_RULES)) {
    let name = '';
    let body = line;
    const named = /^([^:/]{1,60}?):\s+(.+)$/.exec(line);
    if (named) {
      name = named[1].trim();
      body = named[2].trim();
    }
    let source = body;
    let flags = 'i';
    const literal = /^\/(.+)\/([a-z]*)$/.exec(body);
    if (literal) {
      source = literal[1];
      flags = [...new Set(literal[2].split(''))].filter((f) => 'imsu'.includes(f)).join('');
    }
    const problem = patternProblem(source);
    if (problem) {
      skipped.push({ line, reason: problem });
      continue;
    }
    try {
      rules.push({ name: name || source, re: new RegExp(source, `${flags}g`) });
    } catch (err) {
      skipped.push({ line, reason: String(err && err.message ? err.message : err) });
    }
  }
  return { rules, skipped };
}

/**
 * The first match of each pattern in `text`, as { name, match }. Stops when
 * `deadline` (a Date.now() value) has passed, with `timedOut` set.
 */
export function findPatterns(text, rules, deadline = Date.now() + PATTERN_BUDGET_MS) {
  const found = [];
  let timedOut = false;
  if (!text || rules.length === 0) return { found, timedOut };
  for (const rule of rules) {
    let hit = null;
    for (let at = 0; at < text.length && !hit; at += CHUNK) {
      if (Date.now() > deadline) {
        timedOut = true;
        return { found, timedOut };
      }
      const piece = text.slice(at, at + CHUNK + OVERLAP);
      rule.re.lastIndex = 0;
      let m;
      while ((m = rule.re.exec(piece))) {
        if (m[0]) {
          hit = m[0];
          break;
        }
        rule.re.lastIndex += 1;
      }
    }
    if (hit) found.push({ name: rule.name, match: hit });
  }
  return { found, timedOut };
}

/** A match shown without giving it away: the first and last two characters. */
export function maskMatch(value) {
  const s = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (s.length <= 4) return '•'.repeat(Math.max(s.length, 1));
  if (s.length <= 8) return `${s[0]}…${s[s.length - 1]}`;
  return `${s.slice(0, 2)}…${s.slice(-2)}`;
}
