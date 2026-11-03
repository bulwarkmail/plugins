import { describe, it, expect } from 'vitest';
import { fakeApi } from '../../test-utils/fake-api.mjs';
import { runTask, loadSetup, ensureConsent, consentKey } from '../src/lib/assistant.js';
import { anthropicSse, streamResponse } from './helpers.mjs';
import { allStrings } from '../src/lib/i18n.js';

const config = { anthropicBaseUrl: 'http://localhost:18099/anthropic/v1', anthropicModel: 'mock' };

function apiWith({ cfg = config, confirm = true, accounts = [] } = {}) {
  return fakeApi({
    translations: allStrings(),
    handlers: {
      'admin.getAllConfig': async () => cfg,
      'proxy.accounts': async () => accounts,
      'ui.confirm': async () => confirm,
      'proxy.fetch': async () => streamResponse(anthropicSse(['- point'])),
    },
  });
}

describe('privacy notice', () => {
  it('asks once per service, naming the provider and the server, before anything is sent', async () => {
    const api = apiWith();
    expect(await runTask(api, 'summary', { email: { subject: 'S', text: 'Body' } })).toBe('- point');
    const [opts] = api.calls('ui.confirm')[0].args;
    expect(opts.message).toContain('Anthropic');
    expect(opts.message).toContain('localhost:18099');
    expect(opts.message).toContain('mock');
    await runTask(api, 'summary', { email: { subject: 'S', text: 'Body' } });
    expect(api.calls('ui.confirm')).toHaveLength(1);
    expect(api.calls('proxy.fetch')).toHaveLength(2);
  });

  it('sends nothing when the user says no', async () => {
    const api = apiWith({ confirm: false });
    await expect(runTask(api, 'summary', { email: { text: 'Body' } })).rejects.toMatchObject({ code: 'declined' });
    expect(api.calls('proxy.fetch')).toHaveLength(0);
    expect(await api.storage.get(consentKey({ provider: 'anthropic', origin: 'http://localhost:18099' }))).toBeNull();
  });

  it("can ask in the plugin's own UI instead of the host dialog", async () => {
    const api = apiWith();
    const asked = [];
    await runTask(api, 'summary', { email: { text: 'Body' } }, { askConsent: async (ep) => { asked.push(ep.provider); return true; } });
    expect(asked).toEqual(['anthropic']);
    expect(api.calls('ui.confirm')).toHaveLength(0);
    expect(api.calls('proxy.fetch')).toHaveLength(1);
  });

  it('asks again for a different server', async () => {
    const api = apiWith();
    await ensureConsent(api, { provider: 'anthropic', origin: 'https://a.example', baseUrl: 'https://a.example/v1', model: 'x' });
    await ensureConsent(api, { provider: 'anthropic', origin: 'https://b.example', baseUrl: 'https://b.example/v1', model: 'x' });
    expect(api.calls('ui.confirm')).toHaveLength(2);
  });
});

describe('runTask', () => {
  it('refuses plainly when nothing is set up, without asking or sending', async () => {
    const api = apiWith({ cfg: {} });
    await expect(runTask(api, 'summary', { email: { text: 'x' } })).rejects.toMatchObject({ code: 'not_configured' });
    expect(api.calls('ui.confirm')).toHaveLength(0);
    expect(api.calls('proxy.fetch')).toHaveLength(0);
  });

  it('only looks up the user\'s own keys when the admin allows them', async () => {
    const plain = apiWith();
    await loadSetup(plain);
    expect(plain.calls('proxy.accounts')).toHaveLength(0);
    const api = apiWith({ cfg: { ...config, allowUserKeys: true } });
    await loadSetup(api);
    expect(api.calls('proxy.accounts')).toHaveLength(1);
  });

  it('goes through the user\'s own credential when it is connected', async () => {
    const api = apiWith({
      cfg: { ...config, allowUserKeys: true },
      accounts: [{ credentialId: 'own-openai', origin: 'https://api.openai.com', connected: true }],
    });
    await api.storage.set('prefs', { useOwn: true, own: { provider: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-x' } });
    api.calls().length = 0;
    await runTask(api, 'grammar', { text: 'teh' }).catch(() => {});
    const [credentialId, url] = api.calls('proxy.fetch')[0].args;
    expect(credentialId).toBe('own-openai');
    expect(url).toBe('https://api.openai.com/v1/chat/completions');
    expect(api.calls('ui.confirm')[0].args[0].message).toContain('your own key');
  });
});
