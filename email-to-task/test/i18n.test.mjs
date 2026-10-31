import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(fs.readFileSync(path.join(DIR, 'manifest.json'), 'utf8'));
const LOCALES = 'ar ca cs da de en es fa fr he hu it ja ko lv mn nb nl pl pt ro ru sk tr uk zh zh-TW'.split(' ');

function sources(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory()
    ? sources(path.join(dir, e.name))
    : e.name.endsWith('.js') ? [fs.readFileSync(path.join(dir, e.name), 'utf8')] : []));
}

/** Keys the code asks for: t('x.y'), t(`error.${code}`) etc. Template keys are expanded below. */
function usedKeys() {
  const keys = new Set();
  for (const src of sources(path.join(DIR, 'src'))) {
    for (const m of src.matchAll(/\bt\(\s*'([a-z_]+\.[a-z_.]+)'/g)) keys.add(m[1]);
  }
  return keys;
}

const placeholders = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

describe('translations', () => {
  it('cover every webmail language', () => {
    expect(Object.keys(manifest.locales).sort()).toEqual([...LOCALES].sort());
  });

  it('have every key the code uses, in every language', () => {
    const used = usedKeys();
    // Built from a variable: error.<code>, priority.<level>, after.<choice>, connect.needed.<target>.
    for (const code of ['auth', 'not_connected', 'forbidden', 'not_found', 'conflict', 'too_large', 'rate_limited', 'quota', 'timeout', 'bad_request', 'server', 'unreachable', 'blocked', 'wrong_server', 'permission', 'no_task_list', 'no_project', 'no_title', 'stopped', 'unknown']) used.add(`error.${code}`);
    for (const p of ['none', 'low', 'medium', 'high']) used.add(`priority.${p}`);
    for (const a of ['keyword', 'read', 'both', 'none']) used.add(`after.${a}`);
    for (const target of ['vikunja', 'todoist', 'caldav', 'donetick']) used.add(`connect.needed.${target}`);
    expect(used.size).toBeGreaterThan(40);
    for (const lang of LOCALES) {
      const missing = [...used].filter((k) => typeof manifest.locales[lang][k] !== 'string' || !manifest.locales[lang][k].trim());
      expect(missing, lang).toEqual([]);
    }
  });

  it('keep the placeholders of the English text and use real characters', () => {
    const en = manifest.locales.en;
    for (const lang of LOCALES) {
      for (const [key, text] of Object.entries(en)) {
        expect(placeholders(manifest.locales[lang][key]), `${lang} ${key}`).toEqual(placeholders(text));
      }
    }
    expect(fs.readFileSync(path.join(DIR, 'manifest.json'), 'utf8')).not.toMatch(/\\u[0-9a-f]{4}/i);
  });
});
