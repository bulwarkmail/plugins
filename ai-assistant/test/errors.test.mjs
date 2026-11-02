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
    for (const code of ['not_configured', 'declined', 'bad_key', 'forbidden', 'not_found', 'rate_limit', 'quota', 'busy', 'timeout', 'too_long', 'bad_request', 'blocked', 'unreachable', 'server', 'empty', 'cancelled']) {
      expect(en[`error.${code}`], code).toBeTruthy();
    }
  });
});
