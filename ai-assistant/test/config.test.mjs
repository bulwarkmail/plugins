import { describe, it, expect } from 'vitest';
import { resolveEndpoint, normalizeBaseUrl, adminProviders, isOfficialOpenAI, openaiApi, DEFAULT_MODELS } from '../src/lib/config.js';

const both = {
  openaiBaseUrl: 'http://localhost:18099/openai/v1/',
  openaiModel: 'mock-gpt-small',
  anthropicBaseUrl: 'https://api.anthropic.com/v1',
  defaultProvider: 'anthropic',
};

describe('normalizeBaseUrl', () => {
  it('drops trailing slashes and refuses what is not an http(s) address', () => {
    expect(normalizeBaseUrl(' https://api.openai.com/v1/ ')).toBe('https://api.openai.com/v1');
    expect(normalizeBaseUrl('ftp://x/v1')).toBeNull();
    expect(normalizeBaseUrl('https://user:pw@host/v1')).toBeNull();
    expect(normalizeBaseUrl('not a url')).toBeNull();
    expect(normalizeBaseUrl('')).toBeNull();
  });
});

describe('resolveEndpoint', () => {
  it('is null when the administrator set up nothing', () => {
    expect(resolveEndpoint({ config: {} })).toBeNull();
    expect(adminProviders({ openaiKey: 'x' })).toEqual([]);
  });

  it('uses the default provider, its admin model and the admin credential', () => {
    const ep = resolveEndpoint({ config: both });
    expect(ep).toMatchObject({
      provider: 'anthropic', credentialId: 'anthropic', baseUrl: 'https://api.anthropic.com/v1',
      origin: 'https://api.anthropic.com', model: DEFAULT_MODELS.anthropic, own: false,
    });
  });

  it('follows the user\'s provider and model choice', () => {
    const ep = resolveEndpoint({ config: both, prefs: { provider: 'openai', model: ' my-model ' } });
    expect(ep).toMatchObject({ provider: 'openai', credentialId: 'openai', baseUrl: 'http://localhost:18099/openai/v1', model: 'my-model' });
    expect(resolveEndpoint({ config: both, prefs: { provider: 'openai' } }).model).toBe('mock-gpt-small');
  });

  it('uses the user\'s own key only when the admin allows it and the key is connected', () => {
    const prefs = { useOwn: true, own: { provider: 'anthropic', baseUrl: 'https://gw.example.com/anthropic/v1', model: 'm1' } };
    const accounts = [{ credentialId: 'own-anthropic', origin: 'https://gw.example.com', connected: true }];
    expect(resolveEndpoint({ config: both, prefs, accounts }).own).toBe(false);
    const allowed = { ...both, allowUserKeys: true };
    expect(resolveEndpoint({ config: allowed, prefs, accounts })).toMatchObject({
      provider: 'anthropic', credentialId: 'own-anthropic', baseUrl: 'https://gw.example.com/anthropic/v1', model: 'm1', own: true,
    });
    expect(resolveEndpoint({ config: allowed, prefs, accounts: [{ ...accounts[0], connected: false }] }).own).toBe(false);
  });

  it('keeps the own key on the server the user approved', () => {
    const prefs = { useOwn: true, own: { provider: 'openai', baseUrl: 'https://api.openai.com/v1' } };
    const accounts = [{ credentialId: 'own-openai', origin: 'https://proxy.example.org', connected: true }];
    const ep = resolveEndpoint({ config: { allowUserKeys: true }, prefs, accounts });
    expect(ep.baseUrl).toBe('https://proxy.example.org/v1');
    expect(ep.model).toBe(DEFAULT_MODELS.openai);
  });
});

describe('which OpenAI API', () => {
  const official = { openaiBaseUrl: 'https://api.openai.com/v1', openaiModel: 'gpt-6.1-terra' };
  const ollama = { openaiBaseUrl: 'http://ollama:11434/v1', openaiModel: 'qwen2.5:7b' };

  it('knows OpenAI\'s own service by its https address alone', () => {
    expect(isOfficialOpenAI('https://api.openai.com/v1')).toBe(true);
    expect(isOfficialOpenAI('https://API.OpenAI.com')).toBe(true);
    expect(isOfficialOpenAI('http://api.openai.com/v1')).toBe(false);
    expect(isOfficialOpenAI('https://api.openai.com.example.org/v1')).toBe(false);
    expect(isOfficialOpenAI('https://gateway.example.org/api.openai.com/v1')).toBe(false);
    expect(isOfficialOpenAI('not a url')).toBe(false);
    expect(isOfficialOpenAI(undefined)).toBe(false);
  });

  it('Automatic: the Responses API for api.openai.com, chat completions for every other server', () => {
    expect(resolveEndpoint({ config: official }).api).toBe('responses');
    expect(resolveEndpoint({ config: { ...official, openaiApi: 'auto' } }).api).toBe('responses');
    expect(resolveEndpoint({ config: ollama }).api).toBe('chat');
    expect(openaiApi({}, 'http://api.openai.com/v1')).toBe('chat');
  });

  it('follows the administrator\'s choice for their service', () => {
    expect(resolveEndpoint({ config: { ...official, openaiApi: 'chat' } }).api).toBe('chat');
    expect(resolveEndpoint({ config: { ...ollama, openaiApi: 'responses' } }).api).toBe('responses');
    expect(resolveEndpoint({ config: { ...ollama, openaiApi: 'nonsense' } }).api).toBe('chat');
  });

  it('guesses from the address for the user\'s own key, whatever the administrator chose', () => {
    const accounts = [{ credentialId: 'own-openai', origin: 'https://api.openai.com', connected: true }];
    const prefs = { useOwn: true, own: { provider: 'openai', baseUrl: 'https://api.openai.com/v1' } };
    expect(resolveEndpoint({ config: { allowUserKeys: true, openaiApi: 'chat' }, prefs, accounts })).toMatchObject({ own: true, api: 'responses' });
    const proxy = [{ credentialId: 'own-openai', origin: 'https://proxy.example.org', connected: true }];
    expect(resolveEndpoint({ config: { allowUserKeys: true, openaiApi: 'responses' }, prefs, accounts: proxy })).toMatchObject({ own: true, api: 'chat' });
  });

  it('is no question for Anthropic', () => {
    expect(resolveEndpoint({ config: both })).not.toHaveProperty('api');
  });
});
