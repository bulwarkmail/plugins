import { describe, expect, it } from 'vitest';
import { buildData, buildForm, byteLength, mapMatches, toBatches, toUnits, OBJECT_CHAR } from '../src/lib/request.js';
import { answer, readForm } from './lt-mock.mjs';

// What goes to LanguageTool, and how its offsets come back to paragraphs.

const OBJ = OBJECT_CHAR;

function roundTrip(segments, { maxBytes = 100_000, rules } = {}) {
  const units = toUnits(segments, maxBytes);
  const texts = new Map(segments.map((s) => [s.id, s.text]));
  const out = new Map();
  for (const batch of toBatches(units, maxBytes)) {
    const { data, layout } = buildData(batch);
    const body = buildForm({ data, language: 'en-US', level: 'default' });
    for (const [id, list] of mapMatches(answer(body, rules).matches, layout, texts)) out.set(id, [...(out.get(id) ?? []), ...list]);
  }
  return out;
}

describe('the data parameter', () => {
  it('sends objects and paragraph breaks as markup', () => {
    const { data, layout } = buildData([
      { segmentId: 'a', text: `Hi ${OBJ}, I has`, base: 0 },
      { segmentId: 'b', text: 'teh offer', base: 0 },
    ]);
    expect(JSON.parse(data).annotation).toEqual([
      { text: 'Hi ' },
      { markup: OBJ, interpretAs: ' ' },
      { text: ', I has' },
      { markup: '\n\n', interpretAs: '\n\n' },
      { text: 'teh offer' },
    ]);
    expect(layout.map((u) => [u.start, u.end])).toEqual([[0, 11], [13, 22]]);
  });

  it('builds the form body', () => {
    const form = new URLSearchParams(buildForm({
      data: '{"annotation":[]}', language: 'auto', preferredVariants: ['de-AT', 'en-GB'], motherTongue: 'fr',
      level: 'picky', disabledRules: ['A', 'B'], disabledCategories: ['STYLE'],
    }));
    expect(Object.fromEntries(form)).toEqual({
      data: '{"annotation":[]}', language: 'auto', preferredVariants: 'de-AT,en-GB', motherTongue: 'fr',
      level: 'picky', disabledRules: 'A,B', disabledCategories: 'STYLE', enabledOnly: 'false',
    });
  });

  it('leaves preferredVariants out with a fixed language, which LanguageTool refuses', () => {
    const form = new URLSearchParams(buildForm({ data: '{}', language: 'de-DE', preferredVariants: ['de-AT'], level: 'default' }));
    expect(form.has('preferredVariants')).toBe(false);
    expect(form.get('level')).toBe('default');
    expect(form.has('motherTongue')).toBe(false);
  });
});

describe('offsets back in the paragraph', () => {
  it('maps matches of several paragraphs back to each one', () => {
    const out = roundTrip([{ id: 'a', text: 'I has two question.' }, { id: 'b', text: 'About teh offer.' }]);
    expect(out.get('a').map((m) => [m.offset, m.length, m.text])).toEqual([[2, 3, 'has'], [10, 8, 'question']]);
    expect(out.get('b').map((m) => [m.offset, m.text])).toEqual([[6, 'teh']]);
  });

  it('counts emoji and combining marks in UTF-16 units, like JavaScript', () => {
    const text = 'Café 👋🏽 I has teh 🇩🇪 offer';
    const out = roundTrip([{ id: 'x', text: 'First 😀 line.' }, { id: 'a', text }]);
    const got = out.get('a').map((m) => [m.offset, m.text]);
    expect(got).toEqual([[text.indexOf('has'), 'has'], [text.indexOf('teh'), 'teh']]);
    for (const m of out.get('a')) expect(text.slice(m.offset, m.offset + m.length)).toBe(m.text);
  });

  it('keeps offsets right after inline objects', () => {
    const text = `${OBJ} wrote: I has ${OBJ}${OBJ} teh offer`;
    const out = roundTrip([{ id: 'a', text }]);
    expect(out.get('a').map((m) => m.offset)).toEqual([text.indexOf('has'), text.indexOf('teh')]);
  });

  it('drops a match that covers an object or a paragraph break', () => {
    const rule = (text) => ({ text, language: '*', message: 'm', replacements: [' '], rule: { id: 'WHITESPACE_RULE', issueType: 'whitespace', category: { id: 'TYPOGRAPHY' } } });
    const rules = { obj: rule(` ${OBJ} `), brk: rule('end\n\nnext'), ok: rule('fine') };
    const segments = [{ id: 'a', text: `x ${OBJ} y fine` }, { id: 'b', text: 'the end' }, { id: 'c', text: 'next' }];
    // LanguageTool does report them...
    const { data } = buildData(toUnits(segments, 1000));
    expect(answer(buildForm({ data, language: 'en-US' }), rules).matches).toHaveLength(3);
    // ...and only the one inside a paragraph's own text is kept.
    const out = roundTrip(segments, { rules });
    expect(out.get('a').map((m) => m.text)).toEqual(['fine']);
    expect(out.get('b')).toEqual([]);
    expect(out.get('c')).toEqual([]);
  });

  it('drops a match that covers a line break inside a paragraph', () => {
    const layout = [{ segmentId: 'a', text: 'one\ntwo', base: 0, start: 0, end: 7 }];
    const raw = [{ offset: 2, length: 3, message: 'm', rule: { id: 'R' } }, { offset: 4, length: 3, message: 'm', rule: { id: 'R' } }];
    const out = mapMatches(raw, layout, new Map([['a', 'one\ntwo']]));
    expect(out.get('a').map((m) => m.text)).toEqual(['two']);
  });
});

describe('request size', () => {
  it('puts paragraphs together up to the limit and starts a new request after it', () => {
    const segments = Array.from({ length: 5 }, (_, i) => ({ id: `s${i}`, text: `${'word '.repeat(80)}teh` })); // 403 bytes each
    const batches = toBatches(toUnits(segments, 1000), 1000);
    expect(batches.map((b) => b.length)).toEqual([2, 2, 1]);
    for (const b of batches) {
      const { data } = buildData(b);
      expect(byteLength(readForm(buildForm({ data, language: 'en-US' })).full)).toBeLessThanOrEqual(1000);
    }
  });

  it('counts bytes, not characters', () => {
    const segments = [{ id: 'a', text: 'ä'.repeat(300) }, { id: 'b', text: 'ö'.repeat(300) }];
    expect(toBatches(toUnits(segments, 1000), 1000).length).toBe(2);
  });

  it('cuts a paragraph longer than the limit at sentence ends and maps both halves back', () => {
    const sentence = 'This sentence has teh typo in it. ';
    const text = sentence.repeat(60).trim(); // about 2 KB
    const out = roundTrip([{ id: 'long', text }], { maxBytes: 500 });
    const units = toUnits([{ id: 'long', text }], 500);
    expect(units.length).toBeGreaterThan(3);
    expect(units.map((u) => u.text).join('')).toBe(text);
    for (const u of units.slice(0, -1)) expect(u.text.endsWith('. ')).toBe(true);
    const offsets = out.get('long').filter((m) => m.text === 'teh').map((m) => m.offset);
    expect(offsets).toHaveLength(60);
    for (const o of offsets) expect(text.slice(o, o + 3)).toBe('teh');
  });

  it('never cuts an emoji in half', () => {
    const text = '😀'.repeat(400);
    const units = toUnits([{ id: 'a', text }], 101);
    expect(units.map((u) => u.text).join('')).toBe(text);
    for (const u of units) expect(u.text.length % 2).toBe(0);
  });
});
