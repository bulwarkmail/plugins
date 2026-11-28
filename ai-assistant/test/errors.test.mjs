import { describe, it, expect } from 'vitest';
import { AiError, errorFromResponse, errorFromStream, messageFor, parseRetryAfter } from '../src/lib/errors.js';
import { allStrings } from '../src/lib/i18n.js';

const en = allStrings().en;
const t = (key, vars = {}) => (en[key] ?? key).replace(/\{(\w+)\}/g, (m, n) => (n in vars ? String(vars[n]) : m));

describe('parseRetryAfter', () => {
  it('reads seconds and HTTP dates', () => {
    expect(parseRetryAfter('7')).toBe(7);
    expect(parseRetryAfter('0.2')).toBe(1);
    expect(parseRetryAfter('Wed, 14 Oct 2026 10:00:30 GMT', Date.parse('Wed, 14 Oct 2026 10:00:00 GMT'))).toBe(30);
    expect(parseRetryAfter(undefined)).toBeUndefined();
    expect(parseRetryAfter('soon')).toBeUndefined();
  });
});

describe('errorFromResponse', () => {
  it('maps the cases users can act on', () => {
    expect(errorFromResponse({ status: 401, headers: {}, body: '{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}' }).code).toBe('bad_key');
    const limited = errorFromResponse({ status: 429, headers: { 'retry-after': '7' }, body: '{"error":{"code":"rate_limit_exceeded","message":"Rate limit"}}' });
    expect(limited).toMatchObject({ code: 'rate_limit', retryAfter: 7 });
    expect(errorFromResponse({ status: 429, headers: {}, body: '{"error":{"code":"insufficient_quota","message":"You exceeded your current quota"}}' }).code).toBe('quota');
    expect(errorFromResponse({ status: 529, headers: {}, body: '{"type":"error","error":{"type":"overloaded_error"}}' }).code).toBe('busy');
    expect(errorFromResponse({ status: 400, headers: {}, body: '{"error":{"message":"prompt is too long: 250000 tokens"}}' }).code).toBe('too_long');
    expect(errorFromResponse({ status: 404, headers: {}, body: '{"error":{"message":"model \\"x\\" not found"}}' })).toMatchObject({ code: 'not_found', detail: 'model "x" not found' });
    expect(errorFromResponse({ status: 500, headers: {}, body: 'oops' }).code).toBe('server');
  });

  it('maps the proxy\'s own refusals', () => {
    expect(errorFromResponse({ status: 404, proxyError: 'no_credential', headers: {} }).code).toBe('not_configured');
    // A plain-http address the server may not reach: blocked, not "not set up".
    expect(errorFromResponse({ status: 404, proxyError: 'no_credential', headers: {} }, { baseUrl: 'http://10.0.0.5:11434/v1' }).code).toBe('blocked');
    expect(errorFromResponse({ status: 404, proxyError: 'no_credential', headers: {} }, { baseUrl: 'https://api.openai.com/v1' }).code).toBe('not_configured');
    expect(errorFromResponse({ status: 504, proxyError: 'timeout', headers: {} }).code).toBe('timeout');
    expect(errorFromResponse({ status: 429, proxyError: 'rate_limited', headers: { 'retry-after': '3' } })).toMatchObject({ code: 'rate_limit', retryAfter: 3 });
    expect(errorFromResponse({ status: 403, proxyError: 'blocked_address', headers: {} }).code).toBe('blocked');
  });
});

describe('errorFromStream', () => {
  it('keeps the partial answer', () => {
    const e = errorFromStream({ type: 'overloaded_error', message: 'Overloaded' }, 'Half an ans');
    expect(e).toMatchObject({ code: 'busy', partial: 'Half an ans' });
  });
});

describe('messageFor', () => {
  it('says plainly what happened, with the wait time for a rate limit', () => {
    expect(messageFor(t, new AiError('rate_limit', { retryAfter: 7 }))).toBe('The AI service is getting too many requests. You can try again in 7 s.');
    expect(messageFor(t, new AiError('bad_key'))).toMatch(/didn't accept the API key/);
    expect(messageFor(t, new AiError('timeout'))).toBe('The AI service took too long to answer.');
    expect(messageFor(t, new Error('TypeError: x is undefined'))).toBe('Could not reach the AI service.');
    expect(messageFor(t, new AiError('bad_request', { detail: 'max_tokens too large' }))).toBe('The AI service refused the request. It said: max_tokens too large');
  });

  it('has an English text for every error code', () => {
    for (const code of ['not_configured', 'declined', 'bad_key', 'forbidden', 'not_found', 'rate_limit', 'quota', 'busy', 'timeout', 'too_long', 'bad_request', 'blocked', 'unreachable', 'server', 'empty', 'cancelled', 'needs_responses', 'needs_responses_own']) {
      expect(en[`error.${code}`], code).toBeTruthy();
    }
  });
});

describe('why an action failed', () => {
  it('names a missing folder, also one with a name', async () => {
    const { failureReason } = await import('../src/lib/errors.js');
    expect(failureReason(new Error('email.archive: this account has no Archive folder'))).toBe('folder');
    expect(failureReason(new Error('no folder "Projects"; the folders are: Inbox'))).toBe('folder');
    expect(failureReason(new Error('no message with that id'))).toBe('gone');
    expect(failureReason(new Error('boom'))).toBe('other');
  });
});

describe('a model that needs the Responses API', () => {
  const said = "Function tools with reasoning_effort are not supported for gpt-6.1-terra in /v1/chat/completions. To use function tools, use /v1/responses or set reasoning_effort to 'none'.";
  const res = (message, status = 400) => ({ status, headers: {}, body: JSON.stringify({ error: { message, type: 'invalid_request_error', param: 'reasoning_effort', code: null } }) });
  const chat = { provider: 'openai', api: 'chat', baseUrl: 'https://gw.example.org/v1' };

  it('is told apart only when chat completions refused it so', () => {
    expect(errorFromResponse(res(said), chat)).toMatchObject({ code: 'needs_responses', status: 400, detail: said });
    expect(errorFromResponse(res(said), { provider: 'openai', baseUrl: 'http://ollama:11434/v1' }).code).toBe('needs_responses');
    expect(errorFromResponse(res(said), { ...chat, api: 'responses' }).code).toBe('bad_request');
    expect(errorFromResponse(res(said), { provider: 'anthropic' }).code).toBe('bad_request');
    expect(errorFromResponse(res('Unsupported parameter: responses'), chat).code).toBe('bad_request');
    expect(errorFromResponse(res(said, 500), chat).code).toBe('server');
  });

  it('names the setting and what the service said', () => {
    const text = messageFor(t, new AiError('needs_responses', { detail: 'use /v1/responses' }));
    expect(text).toContain('"OpenAI-compatible: API"');
    expect(text).toMatch(/It said: use \/v1\/responses$/);
    expect(en['error.needs_responses']).toBeTruthy();
  });

  it('with the user\'s own key, points to what applies there instead of the admin\'s setting', () => {
    const err = errorFromResponse(res(said), { ...chat, own: true });
    expect(err.code).toBe('needs_responses_own');
    const text = messageFor(t, err);
    expect(text).not.toContain('OpenAI-compatible: API');
    expect(text).toContain('https://api.openai.com/v1');
    expect(text).toContain(`It said: ${said}`);
  });
});
