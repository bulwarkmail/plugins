import { describe, expect, it } from 'vitest';
import { findIbans, isValidIban, maskIban } from '../src/lib/iban.js';
import { findCards, luhnOk, cardLastFour } from '../src/lib/cards.js';
import { findKeywords, findPatterns, maskMatch, parseKeywords, parsePatterns, patternProblem } from '../src/lib/text-rules.js';
import { attachmentProblems, extensionsOf, parseTypeList, typeProblem } from '../src/lib/attachments.js';

describe('IBAN', () => {
  it('accepts valid IBANs of several countries, with and without spaces', () => {
    for (const iban of [
      'DE89 3704 0044 0532 0130 00',
      'GB82 WEST 1234 5698 7654 32',
      'FR14 2004 1010 0505 0001 3M02 606',
      'NL91ABNA0417164300',
      'CH93 0076 2011 6238 5295 7',
      'AT61 1904 3002 3457 3201',
      'NO93 8601 1117 947',
      'BE68 5390 0754 7034',
    ]) {
      expect(isValidIban(iban), iban).toBe(true);
      expect(findIbans(`Please pay to ${iban}, thanks.`).map((m) => m.value)).toEqual([iban.replace(/ /g, '')]);
    }
  });

  it('refuses a wrong check digit, a wrong length and unknown countries', () => {
    expect(isValidIban('DE88 3704 0044 0532 0130 00')).toBe(false);
    expect(isValidIban('DE89 3704 0044 0532 0130 0')).toBe(false);
    expect(isValidIban('XX89 3704 0044 0532 0130 00')).toBe(false);
    expect(findIbans('DE88 3704 0044 0532 0130 00')).toEqual([]);
    // One digit too many is not this IBAN followed by text.
    expect(findIbans('DE89 3704 0044 0532 0130 001')).toEqual([]);
  });

  it('finds lower-case IBANs and one IBAN in a sentence only once', () => {
    expect(findIbans('iban de89370400440532013000.').map((m) => m.value)).toEqual(['DE89370400440532013000']);
  });

  it('masks all but the country, check digits and last four', () => {
    expect(maskIban('DE89370400440532013000')).toBe('DE89 … 3000');
  });
});

describe('card numbers', () => {
  it('runs the Luhn check', () => {
    expect(luhnOk('4242424242424242')).toBe(true);
    expect(luhnOk('4242424242424241')).toBe(false);
    expect(luhnOk('378282246310005')).toBe(true);
  });

  it('finds card numbers written together, with spaces or with dashes', () => {
    expect(findCards('card 4242 4242 4242 4242 exp 12/30').map((c) => c.digits)).toEqual(['4242424242424242']);
    expect(findCards('5555-5555-5555-4444').map((c) => c.digits)).toEqual(['5555555555554444']);
    expect(findCards('Amex 378282246310005').map((c) => c.digits)).toEqual(['378282246310005']);
  });

  it('leaves out numbers that fail Luhn, repeat one digit, start like a phone number or mix separators', () => {
    expect(findCards('4242 4242 4242 4241')).toEqual([]);
    expect(findCards('0000 0000 0000 0000')).toEqual([]);
    // Luhn-valid but starts with 0 or 8: not a card network.
    expect(findCards('0049 1512 3456 7893')).toEqual([]);
    expect(findCards('8000 0000 0000 0011')).toEqual([]);
    expect(findCards('4242 4242-4242 4242')).toEqual([]);
    // Part of a longer number or a decimal.
    expect(findCards('42424242424242421234567')).toEqual([]);
  });

  it('skips the digits of an IBAN', () => {
    const text = 'DE89 3704 0044 0532 0130 00';
    const ibans = findIbans(text);
    expect(findCards(text, ibans)).toEqual([]);
  });

  it('shows only the last four digits', () => {
    expect(cardLastFour('4242424242424242')).toBe('4242');
  });
});

describe('keywords', () => {
  const keywords = parseKeywords('Confidential\n# a comment\nproject falcon\n\nC++\nconfidential');

  it('matches whole words in any case, once per keyword', () => {
    expect(keywords.map((k) => k.keyword)).toEqual(['Confidential', 'project falcon', 'C++']);
    expect(findKeywords('This is CONFIDENTIAL.', keywords)).toEqual(['Confidential']);
    expect(findKeywords('About Project  falcon', keywords)).toEqual([]);
    expect(findKeywords('about project falcon!', keywords)).toEqual(['project falcon']);
  });

  it('does not match inside a longer word', () => {
    expect(findKeywords('confidentiality', keywords)).toEqual([]);
  });

  it('matches keywords that end in a symbol anywhere', () => {
    expect(findKeywords('we use C++ here', keywords)).toEqual(['C++']);
  });
});

describe('patterns', () => {
  it('reads named rules, plain and /literal/ forms', () => {
    const { rules, skipped } = parsePatterns('Customer number: KD-\\d{6}\nInternal: /PRJ-[A-Z]{3}/\n\\bSECRET-\\d+');
    expect(skipped).toEqual([]);
    expect(rules.map((r) => r.name)).toEqual(['Customer number', 'Internal', '\\bSECRET-\\d+']);
    // Without flags a pattern ignores case; a /literal/ keeps its own flags.
    expect(rules[0].re.flags).toContain('i');
    expect(rules[1].re.flags).not.toContain('i');
  });

  it('refuses catastrophic and broken patterns', () => {
    expect(patternProblem('(a+)+$')).toBe('nested quantifier');
    expect(patternProblem('(\\w*)*x')).toBe('nested quantifier');
    expect(patternProblem('(x+x+)+y')).toBe('nested quantifier');
    expect(patternProblem('(a|aa)+$')).toBe('repeated alternation');
    expect(patternProblem('(a)\\1')).toBe('back reference');
    expect(patternProblem('x'.repeat(201))).toBe('too long');
    expect(patternProblem('KD-\\d{6}')).toBeNull();
    const { rules, skipped } = parsePatterns('Bad: (a+)+$\nBroken: [abc\nGood: KD-\\d{6}');
    expect(rules.map((r) => r.name)).toEqual(['Good']);
    expect(skipped.map((s) => s.reason)).toEqual(['nested quantifier', expect.any(String)]);
  });

  it('finds the first match of each rule and stops at the deadline', () => {
    const { rules } = parsePatterns('Customer number: KD-\\d{6}');
    expect(findPatterns('see kd-123456 and KD-654321', rules).found).toEqual([{ name: 'Customer number', match: 'kd-123456' }]);
    // A match across the boundary of two scan pieces is still found.
    const long = `${'x'.repeat(8 * 1024 - 4)}KD-123456`;
    expect(findPatterns(long, rules).found).toHaveLength(1);
    expect(findPatterns('KD-123456', rules, Date.now() - 1)).toEqual({ found: [], timedOut: true });
  });

  it('masks a match', () => {
    expect(maskMatch('KD-123456')).toBe('KD…56');
    expect(maskMatch('abcdef')).toBe('a…f');
    expect(maskMatch('abc')).toBe('•••');
  });
});

describe('attachment types', () => {
  const blocked = parseTypeList('exe, .bat; js application/x-7z-compressed zip');
  const none = parseTypeList('');

  it('reads extensions and MIME types', () => {
    expect([...blocked.extensions]).toEqual(['exe', 'bat', 'js', 'zip']);
    expect([...blocked.types]).toEqual(['application/x-7z-compressed']);
    expect(extensionsOf('invoice.pdf.exe')).toEqual(['pdf', 'exe']);
    expect(extensionsOf('v1.2 notes')).toEqual([]);
  });

  it('blocks by the last extension, so a double extension is caught', () => {
    expect(typeProblem({ name: 'invoice.pdf.exe' }, blocked, none)).toEqual({ reason: 'blocked', type: 'exe' });
    expect(typeProblem({ name: 'report.exe.txt' }, blocked, none)).toBeNull();
  });

  it('blocks a renamed program by its sniffed type', () => {
    expect(typeProblem({ name: 'invoice.pdf', sniffedType: 'application/x-msdownload' }, blocked, none))
      .toEqual({ reason: 'blocked', type: 'application/x-msdownload' });
    expect(typeProblem({ name: 'a.pdf', sniffedType: 'application/x-7z-compressed' }, blocked, none))
      .toEqual({ reason: 'blocked', type: 'application/x-7z-compressed' });
  });

  it('does not take a ZIP-based document for a zip', () => {
    expect(typeProblem({ name: 'plan.docx', sniffedType: 'application/zip' }, blocked, none)).toBeNull();
    expect(typeProblem({ name: 'plan.pdf', sniffedType: 'application/zip' }, blocked, none)).toEqual({ reason: 'blocked', type: 'application/zip' });
  });

  it('with an allowed list, refuses everything else and a program under an allowed name', () => {
    const allowed = parseTypeList('pdf, docx, image/*');
    expect(typeProblem({ name: 'a.pdf', sniffedType: 'application/pdf' }, none, allowed)).toBeNull();
    expect(typeProblem({ name: 'photo.heic', type: 'image/heic' }, none, allowed)).toBeNull();
    expect(typeProblem({ name: 'a.xlsx' }, none, allowed)).toEqual({ reason: 'not-allowed', type: 'xlsx' });
    expect(typeProblem({ name: 'a.pdf', sniffedType: 'application/x-msdownload' }, none, allowed))
      .toEqual({ reason: 'not-allowed', type: 'application/x-msdownload' });
  });

  it('checks the size of every file but the type of attached files only', () => {
    const allowed = parseTypeList('pdf');
    const problems = attachmentProblems([
      { name: 'paste.png', type: 'image/png', size: 10, inline: true },
      { name: 'big.pdf', type: 'application/pdf', size: 3 * 1024 * 1024 },
      { name: 'huge.png', type: 'image/png', size: 3 * 1024 * 1024, inline: true },
    ], { blocked: none, allowed, limit: 2 * 1024 * 1024 });
    expect(problems).toEqual([
      { name: 'big.pdf', kind: 'size' },
      { name: 'huge.png', kind: 'size' },
    ]);
  });
});
