/**
 * The admin's keywords and patterns.
 *
 * Both lists take one entry per line. A line that starts with "# " (hash
 * and a space) or "//" is a comment, so "#confidential" can be a keyword.
 *
 * Keywords: matched without regard to case; a keyword that starts and ends
 * with a letter or digit only matches as a whole word ("secret" doesn't
 * match "secretary").
 *
 * Patterns: `Name: regex` or `Name: /regex/flags`, or just the regex. An
 * admin's regex can be slow on purpose or by accident. The shapes that
 * cause catastrophic backtracking are refused here (patternProblem), and
 * the rest run in a Worker that is stopped at a time budget
 * (pattern-runner.js); a refused line counts as a rule that couldn't be
 * checked.
 */

export const MAX_PATTERN_LENGTH = 200;
export const MAX_RULES = 50;

/** The entries of a list setting, without blank lines and comments. */
export function listLines(value) {
  return String(value ?? '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && l !== '#' && !/^#\s/.test(l) && !l.startsWith('//'));
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The admin's keyword list as matchers. */
export function parseKeywords(value) {
  const out = [];
  const seen = new Set();
  for (const keyword of listLines(value).slice(0, MAX_RULES * 4)) {
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

// ─── Refusing slow patterns ──────────────────────────────────

// Characters to tell whether two parts of a pattern can match the same text.
const SAMPLES = [
  'a', 'A', 'z', 'Z', 'e', '0', '5', '9', '_', ' ', '\t', '\n', '-', '.', ',', '@', '/', ':', '+', '#',
  String.fromCharCode(0xe9), String.fromCharCode(0xdf), String.fromCharCode(0x20ac),
  String.fromCharCode(0x416), String.fromCharCode(0x4e2d), String.fromCharCode(0xa0),
];

function sampleSet(atom, flags) {
  if (atom.kind === 'group' || atom.kind === 'any') return null; // anything
  try {
    const re = new RegExp(`^(?:${atom.text})$`, flags.replace(/[gy]/g, ''));
    return new Set(SAMPLES.filter((c) => re.test(c)));
  } catch {
    return null;
  }
}

function overlaps(a, b, flags) {
  const sa = sampleSet(a, flags);
  const sb = sampleSet(b, flags);
  if (!sa || !sb) return true;
  if (sa.size === 0 || sb.size === 0) return true; // characters we have no sample for: assume the worst
  for (const c of sa) if (sb.has(c)) return true;
  return false;
}

/** Reads a quantifier at `i`: { min, max (Infinity), length } or null. */
function readQuantifier(source, i) {
  const c = source[i];
  let q = null;
  if (c === '*') q = { min: 0, max: Infinity, length: 1 };
  else if (c === '+') q = { min: 1, max: Infinity, length: 1 };
  else if (c === '?') q = { min: 0, max: 1, length: 1 };
  else if (c === '{') {
    const m = /^\{(\d+)(,(\d*))?\}/.exec(source.slice(i));
    if (m) {
      const min = Number(m[1]);
      const max = m[2] === undefined ? min : m[3] === '' ? Infinity : Number(m[3]);
      q = { min, max, length: m[0].length };
    }
  }
  if (q && source[i + q.length] === '?') q.length += 1; // lazy
  return q;
}

/** The length of the escape starting at `i` (a backslash). */
function escapeLength(source, i) {
  const next = source[i + 1];
  if ((next === 'p' || next === 'P' || next === 'u' || next === 'k') && source[i + 2] === '{') {
    const close = source.indexOf('}', i + 3);
    return close > 0 ? close - i + 1 : 2;
  }
  if (next === 'u' && /^[0-9a-fA-F]{4}/.test(source.slice(i + 2))) return 6;
  if (next === 'x' && /^[0-9a-fA-F]{2}/.test(source.slice(i + 2))) return 4;
  if (next === 'c' && /[A-Za-z]/.test(source[i + 2] ?? '')) return 3;
  return 2;
}

/**
 * Adds an atom to the chain of repeats on the current branch. An unbounded
 * repeat that can match what an earlier unbounded repeat matches, with only
 * optional parts between them, is refused. A part that must match (a plain
 * character, or a repeat it doesn't overlap that needs at least one
 * character) ends the chain.
 */
function chainStep(chain, atom, q, flags) {
  const unbounded = !!q && q.max === Infinity;
  if (unbounded) {
    for (let k = chain.length - 1; k >= 0; k -= 1) {
      const prev = chain[k];
      if (overlaps(prev.atom, atom, flags)) return 'overlapping repeats';
      if (prev.min >= 1) break;
    }
    chain.push({ atom, min: q.min });
    return null;
  }
  if (q && q.min === 0) return null; // optional: the chain goes on through it
  chain.length = 0;
  return null;
}

/**
 * Why a pattern is refused, or null when it may run:
 * - 'too long', 'back reference', 'unbalanced';
 * - 'nested quantifier': a repeated group with any repeat inside it, at any
 *   depth, such as (a+)+, ((a+))+ or ((\w+)\s?)+;
 * - 'repeated alternation': a repeated group with alternatives, (a|aa)+;
 * - 'overlapping repeats': unbounded repeats next to each other that can
 *   match the same characters, such as \s*\s*x or \w+\d+, which try every
 *   way of splitting a run between them.
 * Patterns that pass still run with a time limit.
 */
export function patternProblem(source, flags = '') {
  if (!source) return 'empty';
  if (source.length > MAX_PATTERN_LENGTH) return 'too long';
  if (/\\[1-9]|\\k</.test(source)) return 'back reference';

  // One frame per open group: whether it holds a repeat or an alternative,
  // and the chain of repeated atoms on its current branch.
  const frames = [{ repeat: false, alternation: false, chain: [] }];
  let i = 0;
  while (i < source.length) {
    const frame = frames[frames.length - 1];
    const c = source[i];
    let atom;
    if (c === '\\') {
      const len = escapeLength(source, i);
      const text = source.slice(i, i + len);
      i += len;
      // \b and \B match no character; they don't break a chain.
      if (text === '\\b' || text === '\\B') continue;
      atom = { kind: 'char', text };
    } else if (c === '[') {
      let j = i + 1;
      if (source[j] === '^') j += 1;
      if (source[j] === ']') j += 1;
      while (j < source.length && source[j] !== ']') j += source[j] === '\\' ? 2 : 1;
      atom = { kind: 'class', text: source.slice(i, j + 1) };
      i = j + 1;
    } else if (c === '(') {
      let j = i + 1;
      if (source[j] === '?') {
        const prefix = /^\?(?::|=|!|<=|<!|<[A-Za-z_$][\w$]*>)/.exec(source.slice(j));
        j += prefix ? prefix[0].length : 1;
      }
      frames.push({ repeat: false, alternation: false, chain: [] });
      i = j;
      continue;
    } else if (c === ')') {
      if (frames.length === 1) return 'unbalanced';
      const inner = frames.pop();
      i += 1;
      const q = readQuantifier(source, i);
      const parent = frames[frames.length - 1];
      if (q) {
        i += q.length;
        if (q.max > 1 && inner.repeat) return 'nested quantifier';
        if (q.max > 1 && inner.alternation) return 'repeated alternation';
      }
      parent.repeat = parent.repeat || inner.repeat || !!q;
      const problem = chainStep(parent.chain, { kind: 'group', text: '' }, q, flags);
      if (problem) return problem;
      continue;
    } else if (c === '|') {
      frame.alternation = true;
      frame.chain = [];
      i += 1;
      continue;
    } else if (c === '^' || c === '$') {
      frame.chain = [];
      i += 1;
      continue;
    } else if (c === '.') {
      atom = { kind: 'any', text: '.' };
      i += 1;
    } else {
      atom = { kind: 'char', text: escapeRegex(c) };
      i += 1;
    }
    const q = readQuantifier(source, i);
    if (q) {
      i += q.length;
      frame.repeat = true;
    }
    const problem = chainStep(frame.chain, atom, q, flags);
    if (problem) return problem;
  }
  if (frames.length !== 1) return 'unbalanced';
  return null;
}

/**
 * The admin's pattern lines as { name, source, flags }. Broken or refused
 * lines are left out and returned in `skipped` with their name and reason.
 */
export function parsePatterns(value) {
  const rules = [];
  const skipped = [];
  for (const line of listLines(value).slice(0, MAX_RULES)) {
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
    try {
      new RegExp(source, flags);
    } catch (err) {
      skipped.push({ line, name: name || source, reason: String(err && err.message ? err.message : err) });
      continue;
    }
    const problem = patternProblem(source, flags);
    if (problem) {
      skipped.push({ line, name: name || source, reason: problem });
      continue;
    }
    rules.push({ name: name || source, source, flags: `${flags}g` });
  }
  return { rules, skipped };
}

/** A match shown without giving it away: the first and last two characters. */
export function maskMatch(value) {
  const s = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (s.length <= 4) return '•'.repeat(Math.max(s.length, 1));
  if (s.length <= 8) return `${s[0]}…${s[s.length - 1]}`;
  return `${s.slice(0, 2)}…${s.slice(-2)}`;
}
