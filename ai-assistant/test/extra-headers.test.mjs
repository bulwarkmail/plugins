import { describe, it, expect } from 'vitest';
import { fakeApi } from '../../test-utils/fake-api.mjs';
import { extraHeaders, resolveEndpoint, MAX_EXTRA_HEADERS } from '../src/lib/config.js';
import { buildRequest } from '../src/lib/providers.js';
import { runChat } from '../src/lib/chat.js';
import { OPENAI_EP, openaiSse, streamResponse } from './helpers.mjs';

// The admin's extra request headers per service (#52), such as OpenCode
// Go's x-opencode-session.

const config = {
  openaiBaseUrl: 'https://opencode.ai/inference/go/openai/v1',
  openaiModel: 'kimi',
  openaiHeaders: '{"X-OpenCode-Session": "{{CHAT_ID}}", "x-team": "sales"}',
  anthropicBaseUrl: 'https://api.anthropic.com/v1',
  anthropicHeaders: '{"x-gateway": "eu"}',
  defaultProvider: 'openai',
};

describe('extraHeaders', () => {
  it('reads a JSON object of names and values, names in lower case', () => {
    expect(extraHeaders('{"X-OpenCode-Session": "{{CHAT_ID}}", "x-n": 7}')).toEqual({ 'x-opencode-session': '{{CHAT_ID}}', 'x-n': '7' });
  });

  it('gives none for empty or unreadable text, or what is not an object', () => {
    for (const value of ['', '  ', '{nope', '[1]', '"x"', 'null', undefined, 42]) expect(extraHeaders(value)).toEqual({});
  });

  it('leaves out bad names, values with line breaks and the headers the assistant or the proxy sets', () => {
    expect(extraHeaders(JSON.stringify({
      'bad name': 'a', 'x-ok': 'b', 'x-split': 'c\r\nx-evil: 1', 'x-empty': '', 'x-object': { a: 1 },
      Authorization: 'Bearer stolen', 'X-Api-Key': 'k', 'Content-Type': 'text/plain', accept: 'x', 'anthropic-version': '1', Host: 'evil',
    }))).toEqual({ 'x-ok': 'b' });
  });

  it('keeps at most MAX_EXTRA_HEADERS', () => {
    const many = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`x-h${i}`, 'v']));
    expect(Object.keys(extraHeaders(many))).toHaveLength(MAX_EXTRA_HEADERS);
  });
});

describe('the endpoint\'s extra headers', () => {
  it('come with the admin\'s service they are set for', () => {
    expect(resolveEndpoint({ config }).headers).toEqual({ 'x-opencode-session': '{{CHAT_ID}}', 'x-team': 'sales' });
    expect(resolveEndpoint({ config, prefs: { provider: 'anthropic' } }).headers).toEqual({ 'x-gateway': 'eu' });
    expect(resolveEndpoint({ config: { ...config, openaiHeaders: '' } })).not.toHaveProperty('headers');
  });

  it('never go to the server of a user\'s own key', () => {
    const accounts = [{ credentialId: 'own-openai', origin: 'https://own.example.org', connected: true }];
    const prefs = { useOwn: true, own: { provider: 'openai', baseUrl: 'https://own.example.org/v1' } };
    const endpoint = resolveEndpoint({ config: { ...config, allowUserKeys: true }, prefs, accounts });
    expect(endpoint.own).toBe(true);
    expect(endpoint).not.toHaveProperty('headers');
    expect(buildRequest(endpoint, { messages: [{ role: 'user', content: 'Hi' }] }).headers).toEqual({ 'content-type': 'application/json', accept: 'text/event-stream' });
  });
});

describe('buildRequest with extra headers', () => {
  const endpoint = { ...OPENAI_EP, headers: { 'x-opencode-session': 'chat-{{CHAT_ID}}', 'x-team': 'sales' } };
  const prompt = { messages: [{ role: 'user', content: 'Hi' }] };

  it('sends them, {{CHAT_ID}} as the conversation\'s id, next to its own headers', () => {
    expect(buildRequest(endpoint, { ...prompt, session: 'abc' }).headers).toEqual({
      'x-opencode-session': 'chat-abc', 'x-team': 'sales', 'content-type': 'application/json', accept: 'text/event-stream',
    });
    const anthropic = buildRequest({ ...endpoint, provider: 'anthropic' }, { ...prompt, session: 'abc' });
    expect(anthropic.headers).toMatchObject({ 'x-opencode-session': 'chat-abc', 'anthropic-version': '2023-06-01' });
  });

  it('gives a request without a conversation a new id each time', () => {
    const a = buildRequest(endpoint, prompt).headers['x-opencode-session'];
    const b = buildRequest(endpoint, prompt).headers['x-opencode-session'];
    expect(a).toMatch(/^chat-.{8,}$/);
    expect(a).not.toBe(b);
    expect(a).not.toContain('{{CHAT_ID}}');
  });
});

describe('runChat with extra headers', () => {
  it('sends the same conversation id with every round of one question', async () => {
    const seen = [];
    const answers = [
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","type":"function","function":{"name":"check_calendar","arguments":"{}"}}]},"finish_reason":"tool_calls"}]}\n\ndata: [DONE]\n\n',
      openaiSse(['Free.']),
    ];
    const api = fakeApi({
      handlers: {
        'proxy.fetch': async (_id, _url, init) => {
          seen.push(init.headers['x-opencode-session']);
          return streamResponse(answers[seen.length - 1]);
        },
      },
    });
    const endpoint = { ...OPENAI_EP, headers: { 'x-opencode-session': '{{CHAT_ID}}' } };
    const tools = [{ name: 'check_calendar', description: 'd', parameters: { type: 'object', properties: {} } }];
    const out = await runChat(api, endpoint, { messages: [{ role: 'user', content: 'free?' }], tools, runTool: async () => 'none', session: 'turn-1' });
    expect(out.text).toBe('Free.');
    expect(seen).toEqual(['turn-1', 'turn-1']);
  });
});
