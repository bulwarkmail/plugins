import { describe, expect, it } from 'vitest';
import { resolveLanguage, toLtCode, cleanVariants, autoVariants } from '../src/lib/languages.js';
import { endpointFor, normalizeServerUrl, readAdmin, readPrefs, effectiveLevel, userDisabledRules } from '../src/lib/config.js';
import { wordMatcher, addWord } from '../src/lib/words.js';
import { kindOf, normalizeMatch } from '../src/lib/matches.js';

// The language rule, the admin's lock, the server, word lists and kinds.

const admin = (config = {}) => readAdmin(config);
const prefs = (raw = {}) => readPrefs(raw);

describe('language codes', () => {
  it('gives English, German and Portuguese a variant, from the preferred ones or a default', () => {
    expect(toLtCode('en')).toBe('en-US');
    expect(toLtCode('de')).toBe('de-DE');
    expect(toLtCode('pt')).toBe('pt-PT');
    expect(toLtCode('en', ['en-GB'])).toBe('en-GB');
    expect(toLtCode('de-ch')).toBe('de-CH');
    expect(toLtCode('en-IE', ['en-GB'])).toBe('en-GB');
  });

  it('maps a language LanguageTool knows in one variant and refuses the others', () => {
    expect(toLtCode('pl')).toBe('pl-PL');
    expect(toLtCode('fr-FR')).toBe('fr');
    expect(toLtCode('nl')).toBe('nl');
    expect(toLtCode('cs')).toBeNull();
    expect(toLtCode('zh-TW')).toBeNull();
  });

  it('keeps one known variant per language', () => {
    expect(cleanVariants('de-at, en-GB, de-CH, xx-YY, en')).toEqual(['de-AT', 'en-GB']);
    expect(autoVariants(['en-GB'])).toEqual(['en-GB', 'de-DE', 'pt-PT']);
  });
});

describe('which language a check goes out in', () => {
  it('follows the writing language', () => {
    expect(resolveLanguage({ writing: 'de', admin: admin(), prefs: prefs() })).toEqual({ language: 'de-DE' });
  });

  it('detects with variants for every language that needs one when nothing is set', () => {
    expect(resolveLanguage({ writing: 'auto', admin: admin({ preferredVariants: 'de-AT' }), prefs: prefs() }))
      .toEqual({ language: 'auto', preferredVariants: ['de-AT', 'en-US', 'pt-PT'] });
  });

  it("uses the admin's fixed default when the writing language is auto", () => {
    expect(resolveLanguage({ writing: 'auto', admin: admin({ defaultLanguage: 'fr' }), prefs: prefs() })).toEqual({ language: 'fr' });
  });

  it("puts the user's fixed language and variants before the writing language", () => {
    const p = prefs({ language: 'en', variants: ['en-GB'] });
    expect(resolveLanguage({ writing: 'de', admin: admin({ preferredVariants: 'en-US' }), prefs: p })).toEqual({ language: 'en-GB' });
  });

  it("ignores the user's language and variants when the admin locked them", () => {
    const p = prefs({ language: 'en', variants: ['de-CH'] });
    const locked = admin({ userMayChange: false, preferredVariants: 'de-AT' });
    expect(resolveLanguage({ writing: 'de', admin: locked, prefs: p, userMayChange: false })).toEqual({ language: 'de-AT' });
    const fixed = admin({ userMayChange: false, defaultLanguage: 'fr' });
    expect(resolveLanguage({ writing: 'de', admin: fixed, prefs: p, userMayChange: false })).toEqual({ language: 'fr' });
  });

  it('says so for a language LanguageTool does not check', () => {
    expect(resolveLanguage({ writing: 'cs', admin: admin(), prefs: prefs() })).toEqual({ unsupported: 'cs' });
  });
});

describe('admin config', () => {
  it('reads the server address without the API path', () => {
    expect(normalizeServerUrl('http://languagetool:8010/')).toBe('http://languagetool:8010');
    expect(normalizeServerUrl('https://lt.example.com/api/v2/check')).toBe('https://lt.example.com/api');
    expect(normalizeServerUrl('ftp://x')).toBeNull();
    expect(normalizeServerUrl('https://user:pw@x')).toBeNull();
  });

  it('uses the server, the public API only when allowed, or nothing', () => {
    expect(endpointFor(admin({ serverUrl: 'https://lt.example.com' }))).toMatchObject({ credentialId: 'server', base: 'https://lt.example.com', host: 'lt.example.com', isPublic: false });
    expect(endpointFor(admin({ serverUrl: 'https://lt.example.com' }), { tokenSet: true }).credentialId).toBe('server-token');
    expect(endpointFor(admin())).toEqual({ off: 'not_set_up' });
    expect(endpointFor(admin({ allowPublicApi: true }))).toMatchObject({ credentialId: 'public', base: 'https://api.languagetool.org', isPublic: true });
    expect(endpointFor(admin({ allowPublicApi: true }), { noThirdPartyTraffic: true })).toEqual({ off: 'third_party' });
  });

  it("lets the admin's lock override the user's level and rules", () => {
    const p = prefs({ picky: true, disabledRules: [{ id: 'R1', label: 'Rule' }] });
    expect(effectiveLevel(admin(), p)).toBe('picky');
    expect(userDisabledRules(admin(), p)).toEqual(['R1']);
    expect(effectiveLevel(admin({ userMayChange: false }), p)).toBe('default');
    expect(userDisabledRules(admin({ userMayChange: false }), p)).toEqual([]);
  });
});

describe('dictionary words', () => {
  it('matches exactly, in capitals, and any case for lower-case entries', () => {
    const words = wordMatcher(['Bulwark', 'jmap'], ['Rath & Blume']);
    expect(words.has('Bulwark')).toBe(true);
    expect(words.has('BULWARK')).toBe(true);
    expect(words.has('bulwark')).toBe(false);
    expect(words.has('JMAP')).toBe(true);
    expect(words.has('Jmap')).toBe(true);
    expect(words.has('Blume')).toBe(true);
    expect(words.has('blume')).toBe(false);
    expect(words.has('Bulwarc')).toBe(false);
  });

  it('adds a word once, sorted, trimmed, and refuses an overlong one', () => {
    expect(addWord(['b'], 'a')).toEqual(['a', 'b']);
    expect(addWord(['a'], 'a')).toEqual(['a']);
    expect(addWord([], '  x  ')).toEqual(['x']);
    expect(addWord([], 'y'.repeat(101))).toEqual([]);
  });
});

describe('kinds', () => {
  it.each([
    [{ issueType: 'misspelling', category: { id: 'TYPOS' } }, 'spelling'],
    [{ issueType: 'typographical', category: { id: 'TYPOS' } }, 'spelling'],
    [{ issueType: 'grammar', category: { id: 'GRAMMAR' } }, 'grammar'],
    [{ issueType: 'typographical', category: { id: 'PUNCTUATION' } }, 'grammar'],
    [{ issueType: 'duplication', category: { id: 'MISC' } }, 'grammar'],
    [{ issueType: 'whitespace', category: { id: 'TYPOGRAPHY' } }, 'grammar'],
    [{ issueType: 'style', category: { id: 'STYLE' } }, 'style'],
    [{ issueType: 'register', category: { id: 'MISC' } }, 'style'],
    [{ issueType: 'locale-violation', category: { id: 'MISC' } }, 'style'],
    [{ issueType: 'uncategorized', category: { id: 'REDUNDANCY' } }, 'style'],
    [{ issueType: 'uncategorized', category: { id: 'CONFUSED_WORDS' } }, 'grammar'],
    [{ issueType: 'uncategorized', category: { id: 'MISC' } }, 'other'],
    [{}, 'other'],
  ])('%j is %s', (rule, kind) => {
    expect(kindOf(rule)).toBe(kind);
  });

  it('keeps at most 5 suggestions, without empty ones or line breaks', () => {
    const m = normalizeMatch({
      offset: 0, length: 3, message: 'Long', shortMessage: 'Short',
      replacements: ['', 'a', 'a', 'b\nc', 'c', 'd', 'e', 'f', 'g'].map((value) => ({ value })),
      rule: { id: 'R', description: 'Desc', issueType: 'grammar', category: { id: 'GRAMMAR' } },
    });
    expect(m).toEqual({ offset: 0, length: 3, kind: 'grammar', message: 'Long', shortMessage: 'Short', replacements: ['a', 'c', 'd', 'e', 'f'], ruleId: 'R', ruleLabel: 'Desc', categoryId: 'GRAMMAR' });
  });
});
