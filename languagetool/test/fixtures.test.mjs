import { describe, expect, it } from 'vitest';
import { fakeApi } from '../../test-utils/fake-api.mjs';
import { runCheck, createBudget } from '../src/lib/checker.js';
import { createCache } from '../src/lib/cache.js';
import { endpointFor, readAdmin, readPrefs } from '../src/lib/config.js';
import { check } from '../e2e/mock-server.mjs';

// The recorded LanguageTool answers the end-to-end mock serves, run
// through the plugin: the sentences the e2e specs type are flagged where
// the specs expect it.

const DE = 'Ich habe gestern dem Brief geschrieben. Das ist ein Feler.';
const EN = 'I has two question about teh offer.';

async function annotate(segments, language = 'auto') {
  const api = fakeApi({ handlers: { 'proxy.fetch': async (_c, _u, init) => ({ status: 200, ok: true, headers: {}, body: JSON.stringify(check(init.body)) }) } });
  const admin = readAdmin({ serverUrl: 'http://localhost:18110' });
  return runCheck({ composerId: 'c', language, segments, objectReplacement: '￼' }, {
    api, admin, prefs: readPrefs({}), dictionary: [], endpoint: endpointFor(admin), cache: createCache(), budget: createBudget(),
  });
}

describe('the e2e fixtures', () => {
  it('flag "dem" as grammar with "den", and "Feler" as spelling', async () => {
    const { annotations } = await annotate([{ id: 'x', text: `Hallo ￼,` }, { id: 'd', text: DE }]);
    expect(annotations.map((a) => [a.segmentId, DE.slice(a.offset, a.offset + a.length), a.kind, a.replacements[0]])).toEqual([
      ['d', 'dem', 'grammar', 'den'],
      ['d', 'Feler', 'spelling', 'Fehler'],
    ]);
  });

  it('flag "has" and "teh" in the English sentence', async () => {
    const { annotations } = await annotate([{ id: 'e', text: `${EN} 👋` }]);
    expect(annotations.map((a) => [EN.slice(a.offset, a.offset + a.length), a.kind, a.replacements[0]])).toEqual([
      ['has', 'grammar', 'have'],
      ['teh', 'spelling', 'the'],
    ]);
  });
});
