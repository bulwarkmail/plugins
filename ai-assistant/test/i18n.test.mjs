import { describe, it, expect } from 'vitest';
import { AREAS } from '../src/locales/index.js';
import { allStrings, withStrings } from '../src/lib/i18n.js';
import { fakeApi } from '../../test-utils/fake-api.mjs';

const WEBMAIL_LOCALES = 'ar ca cs da de en es fa fr he hu it ja ko lv mn nb nl pl pt ro ru sk tr uk zh zh-TW'.split(' ');
const placeholders = (s) => (s.match(/\{\w+\}/g) ?? []).sort();

// The texts live in the bundle, one folder per area (src/locales/<area>).
describe('translations', () => {
  for (const [area, tables] of Object.entries(AREAS)) {
    const en = tables.en;
    if (!en) {
      it(`${area} has no texts yet, in no language`, () => {
        expect(Object.keys(tables)).toEqual([]);
      });
      continue;
    }

    it(`${area} covers every webmail language`, () => {
      expect(Object.keys(tables).sort()).toEqual([...WEBMAIL_LOCALES].sort());
    });

    for (const locale of WEBMAIL_LOCALES.filter((l) => l !== 'en')) {
      it(`${area}: ${locale} has every string with the same placeholders`, () => {
        const table = tables[locale];
        for (const [key, text] of Object.entries(en)) {
          expect(typeof table[key], `${locale} ${key}`).toBe('string');
          expect(table[key].trim(), `${locale} ${key}`).not.toBe('');
          expect(placeholders(table[key]), `${locale} ${key}`).toEqual(placeholders(text));
        }
        expect(Object.keys(table).filter((k) => !(k in en))).toEqual([]);
      });
    }
  }

  it('never uses a key in two areas', () => {
    const seen = new Map();
    for (const [area, tables] of Object.entries(AREAS)) {
      for (const key of Object.keys(tables.en ?? {})) {
        expect(seen.get(key), `${key} in ${area}`).toBeUndefined();
        seen.set(key, area);
      }
    }
  });

  it('reach a frame through api.i18n once, in its language', () => {
    const api = fakeApi({ locale: 'de' });
    expect(api.i18n.t('composer.title')).toBe('composer.title');
    withStrings(api);
    withStrings(api);
    expect(api.i18n.t('composer.title')).toBe(allStrings().de['composer.title']);
  });
});
