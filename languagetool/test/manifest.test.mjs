import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import manifest from '../manifest.json' with { type: 'json' };
import pkg from '../package.json' with { type: 'json' };

// The manifest: permissions, credentials, admin fields and the strings.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LOCALES = ['ar', 'ca', 'cs', 'da', 'de', 'en', 'es', 'et', 'fa', 'fr', 'he', 'hu', 'it', 'ja', 'ko', 'lv', 'mn', 'nb', 'nl', 'pl', 'pt', 'ro', 'ru', 'sk', 'th', 'tr', 'uk', 'vi', 'zh', 'zh-TW'];

describe('manifest', () => {
  it('asks for exactly the permissions it needs', () => {
    expect([...manifest.permissions].sort()).toEqual(['compose:check', 'http:proxy', 'ui:settings-section']);
  });

  it('needs the webmail that has text checkers', () => {
    expect(manifest.id).toBe('languagetool');
    expect(manifest.minAppVersion).toBe('1.20.0');
    expect(pkg.version).toBe(manifest.version);
  });

  it('declares admin credentials the webmail accepts, the token never for the public API', () => {
    const { credentials, configSchema } = manifest;
    expect(Object.keys(credentials).sort()).toEqual(['public', 'server', 'server-token']);
    for (const c of Object.values(credentials)) {
      expect(c.scope).toBe('admin');
      expect(configSchema[c.secretKey].type).toBe('secret');
      expect(!!c.origin !== !!c.originKey).toBe(true);
    }
    expect(credentials.server).toMatchObject({ inject: { type: 'none' }, originKey: 'serverUrl' });
    expect(credentials['server-token']).toMatchObject({ inject: { type: 'bearer' }, originKey: 'serverUrl' });
    expect(credentials.public).toEqual(expect.objectContaining({ inject: { type: 'none' }, origin: 'https://api.languagetool.org' }));
  });

  it('starts with no server and without the public API', () => {
    // An empty default also keeps the server reachable in no-third-party mode,
    // which refuses a server that equals the field's default.
    expect(manifest.configSchema.serverUrl.default).toBe('');
    expect(manifest.configSchema.allowPublicApi.default).toBe(false);
    expect(manifest.configSchema.userMayChange.default).toBe(true);
    expect(manifest.configSchema.wordList.multiline).toBe(true);
    expect(manifest.configSchema.serverUrl.description).toContain('PLUGIN_PROXY_PRIVATE_ORIGINS');
  });

  it('has every string in all 30 languages, with the same placeholders', () => {
    expect(Object.keys(manifest.locales).sort()).toEqual([...LOCALES].sort());
    const en = manifest.locales.en;
    const holes = (s) => (s.match(/\{\w+\}/g) ?? []).sort();
    for (const locale of LOCALES) {
      const table = manifest.locales[locale];
      expect(Object.keys(table).sort(), locale).toEqual(Object.keys(en).sort());
      for (const [key, text] of Object.entries(en)) {
        expect(table[key].trim(), `${locale} ${key}`).not.toBe('');
        expect(holes(table[key]), `${locale} ${key}`).toEqual(holes(text));
      }
    }
  });

  it('has a string for every key the code uses', () => {
    const files = [];
    const walk = (dir) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.(js|jsx)$/.test(e.name)) files.push(readFileSync(p, 'utf8'));
      }
    };
    walk(path.join(HERE, '..', 'src'));
    const code = files.join('\n');
    const used = new Set([...code.matchAll(/['"`]((?:settings|error)\.[a-z_]+)['"`]/g)].map((m) => m[1]));
    expect(used.size).toBeGreaterThan(30);
    for (const key of used) expect(manifest.locales.en, key).toHaveProperty([key]);
  });
});
