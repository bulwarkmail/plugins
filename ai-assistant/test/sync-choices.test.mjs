import { describe, it, expect } from 'vitest';
import { fakeApi } from '../../test-utils/fake-api.mjs';
import { allStrings } from '../src/lib/i18n.js';
import { consentKey, ensureConsent, savePrefs, syncChoices } from '../src/lib/assistant.js';
import { createBackground } from '../src/lib/background.js';

const ENDPOINT = { provider: 'openai', origin: 'https://llm.example', baseUrl: 'https://llm.example/v1', model: 'm' };

/** A fakeApi whose storage.set notes which keys went out with { sync: true }. */
function syncingApi({ full = false, handlers = {} } = {}) {
  const api = fakeApi({ translations: allStrings(), handlers: { 'ui.confirm': async () => true, ...handlers } });
  const synced = [];
  const local = api.storage.set;
  api.storage.set = async (key, value, opts) => {
    if (opts?.sync) {
      if (full) throw new Error('Synced plugin storage is full');
      synced.push(key);
    }
    return local(key, value);
  };
  return { api, synced };
}

describe('choices that follow the account to other browsers (#27)', () => {
  it('stores the own-key choice for every browser of the account', async () => {
    const { api, synced } = syncingApi();
    await savePrefs(api, { useOwn: true, own: { provider: 'openai', baseUrl: 'https://llm.example/v1', model: 'qwen' } });
    expect(synced).toEqual(['prefs']);
    expect((await api.storage.get('prefs')).own.model).toBe('qwen');
  });

  it("stores the OK for a service for every browser, so the notice isn't asked again there", async () => {
    const { api, synced } = syncingApi();
    expect(await ensureConsent(api, ENDPOINT)).toBe(true);
    expect(synced).toEqual([consentKey(ENDPOINT)]);
  });

  it('keeps a choice in this browser when the synced space is full', async () => {
    const { api, synced } = syncingApi({ full: true });
    await savePrefs(api, { model: 'x' });
    expect(synced).toEqual([]);
    expect((await api.storage.get('prefs')).model).toBe('x');
  });

  it('hands choices made before the sync to the account at start, and nothing else', async () => {
    const { api, synced } = syncingApi({ handlers: { 'admin.getAllConfig': async () => ({}) } });
    const set = api.storage.set;
    api.storage.set = (key, value) => set(key, value); // written as an older version would
    await api.storage.set('prefs', { useOwn: true });
    await api.storage.set(consentKey(ENDPOINT), true);
    await api.storage.set('consent:v1:openai:https://old.example', true);
    await api.storage.set('chat:email:e1', { turns: [] });
    api.storage.set = set;
    await createBackground(api, { every: () => {} }).activate();
    expect(synced.sort()).toEqual([consentKey(ENDPOINT), 'prefs'].sort());
  });

  it('does nothing at start when this browser has no choices yet', async () => {
    const { api, synced } = syncingApi();
    await syncChoices(api);
    expect(synced).toEqual([]);
  });
});
