// The two link checks against recorded answers (no network, no real key).
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createSafeBrowsing, hashesFor, LookupError, parseDuration } from '../src/lib/safebrowsing.js';
import { createEndpoint, parseAnswer } from '../src/lib/endpoint.js';

const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));
const MALWARE_URL = 'http://malware.testing.google.test/testing/malware/';

function recorded(name, { status = 200, ok = status < 300, proxyError } = {}) {
  const calls = [];
  const request = vi.fn(async (url) => {
    calls.push(url);
    return { status, ok, headers: {}, body: name ? fixture(name) : null, ...(proxyError ? { proxyError } : {}) };
  });
  return { request, calls };
}

describe('Safe Browsing hashes:search', () => {
  it('sends only 4-byte prefixes, never the URL, and asks for JSON', async () => {
    const { request, calls } = recorded('sb-miss.json');
    await createSafeBrowsing({ request }).check(`${MALWARE_URL}?user=alice@example.org`);
    const url = new URL(calls[0]);
    expect(url.origin + url.pathname).toBe('https://safebrowsing.googleapis.com/v5/hashes:search');
    expect(url.searchParams.get('alt')).toBe('json');
    const prefixes = url.searchParams.getAll('hashPrefixes');
    expect(prefixes.length).toBeGreaterThan(0);
    expect(prefixes.length).toBeLessThanOrEqual(30);
    for (const p of prefixes) expect(Buffer.from(p, 'base64')).toHaveLength(4);
    expect(calls[0]).not.toMatch(/malware|testing|alice|example/i);
    // The first prefix is that of the whole canonical expression.
    const full = createHash('sha256').update('malware.testing.google.test/testing/malware/?user=alice@example.org').digest();
    expect(prefixes[0]).toBe(full.subarray(0, 4).toString('base64'));
  });

  it('says unsafe when a returned full hash is one of the link\'s', async () => {
    const { request } = recorded('sb-match.json');
    const result = await createSafeBrowsing({ request }).check(MALWARE_URL);
    expect(result).toEqual({ verdict: 'unsafe', threats: ['MALWARE', 'SOCIAL_ENGINEERING'] });
  });

  it('says safe on an empty answer and when only another full hash shares the prefix', async () => {
    expect((await createSafeBrowsing({ request: recorded('sb-miss.json').request }).check(MALWARE_URL)).verdict).toBe('safe');
    expect((await createSafeBrowsing({ request: recorded('sb-prefix-collision.json').request }).check(MALWARE_URL)).verdict).toBe('safe');
  });

  it('ignores CANARY entries and threat types it doesn\'t know', async () => {
    expect((await createSafeBrowsing({ request: recorded('sb-canary.json').request }).check(MALWARE_URL)).verdict).toBe('safe');
    expect((await createSafeBrowsing({ request: recorded('sb-unknown-type.json').request }).check(MALWARE_URL)).verdict).toBe('safe');
  });

  it('caches answers for cacheDuration, in memory, and asks again afterwards', async () => {
    let t = 1_000_000;
    const { request } = recorded('sb-match.json');
    const sb = createSafeBrowsing({ request, now: () => t });
    await sb.check(MALWARE_URL);
    t += 299_000;
    expect((await sb.check(MALWARE_URL)).verdict).toBe('unsafe');
    expect(request).toHaveBeenCalledTimes(1);
    t += 2_000;
    await sb.check(MALWARE_URL);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('keeps a negative answer at most 24 hours, whatever Google says', async () => {
    let t = 0;
    const { request } = recorded('sb-long-cache.json');
    const sb = createSafeBrowsing({ request, now: () => t });
    await sb.check(MALWARE_URL);
    t = 23 * 3600_000;
    await sb.check(MALWARE_URL);
    expect(request).toHaveBeenCalledTimes(1);
    t = 24 * 3600_000 + 1;
    await sb.check(MALWARE_URL);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('throws LookupError on HTTP errors, proxy refusals and bad answers', async () => {
    await expect(createSafeBrowsing({ request: recorded('sb-miss.json', { status: 400 }).request }).check(MALWARE_URL)).rejects.toBeInstanceOf(LookupError);
    await expect(createSafeBrowsing({ request: recorded('sb-miss.json', { status: 403, proxyError: 'third_party_off' }).request }).check(MALWARE_URL)).rejects.toBeInstanceOf(LookupError);
    await expect(createSafeBrowsing({ request: recorded(null).request }).check(MALWARE_URL)).rejects.toBeInstanceOf(LookupError);
    await expect(createSafeBrowsing({ request: async () => { throw new Error('offline'); } }).check(MALWARE_URL)).rejects.toBeInstanceOf(LookupError);
  });

  it('reads protobuf durations', () => {
    expect(parseDuration('300s')).toBe(300_000);
    expect(parseDuration('1.5s')).toBe(1500);
    expect(parseDuration('soon')).toBeNull();
    expect(hashesFor('http://a.b.com/')[0].expression).toBe('a.b.com/');
  });
});

describe('the company endpoint', () => {
  const answer = (body, init = {}) => vi.fn(async () => ({ status: 200, ok: true, headers: {}, body: typeof body === 'string' ? body : JSON.stringify(body), ...init }));

  it('posts the full URL and host as JSON', async () => {
    const request = answer({ verdict: 'safe' });
    const result = await createEndpoint({ request }).check('https://check.corp.example/v1', 'https://evil.example/x?a=1', 'evil.example');
    expect(result).toEqual({ verdict: 'safe' });
    const [url, init] = request.mock.calls[0];
    expect(url).toBe('https://check.corp.example/v1');
    expect(init.method).toBe('POST');
    expect(init.headers['content-type']).toBe('application/json');
    expect(JSON.parse(init.body)).toEqual({ url: 'https://evil.example/x?a=1', host: 'evil.example' });
  });

  it('passes the reason of an unsafe verdict on', async () => {
    const result = await createEndpoint({ request: answer({ verdict: 'unsafe', reason: 'Known phishing kit' }) }).check('https://c.example/', 'https://e.example/', 'e.example');
    expect(result).toEqual({ verdict: 'unsafe', reason: 'Known phishing kit' });
  });

  it('caches for cacheSeconds, at most an hour', async () => {
    let t = 0;
    const request = answer({ verdict: 'unsafe', cacheSeconds: 99999 });
    const ep = createEndpoint({ request, now: () => t });
    await ep.check('https://c.example/', 'https://e.example/', 'e.example');
    t = 3599_000;
    await ep.check('https://c.example/', 'https://e.example/', 'e.example');
    expect(request).toHaveBeenCalledTimes(1);
    t = 3601_000;
    await ep.check('https://c.example/', 'https://e.example/', 'e.example');
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('doesn\'t cache without cacheSeconds', async () => {
    const request = answer({ verdict: 'safe' });
    const ep = createEndpoint({ request });
    await ep.check('https://c.example/', 'https://e.example/', 'e.example');
    await ep.check('https://c.example/', 'https://e.example/', 'e.example');
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('counts bad JSON, unknown verdicts, HTTP errors and proxy refusals as failures', async () => {
    const check = (request) => createEndpoint({ request }).check('https://c.example/', 'https://e.example/', 'e.example');
    await expect(check(answer('<html>'))).rejects.toBeInstanceOf(LookupError);
    await expect(check(answer({ verdict: 'maybe' }))).rejects.toBeInstanceOf(LookupError);
    await expect(check(answer({ verdict: 'safe' }, { status: 500, ok: false }))).rejects.toBeInstanceOf(LookupError);
    await expect(check(answer({ verdict: 'safe' }, { status: 403, ok: false, proxyError: 'not_configured' }))).rejects.toBeInstanceOf(LookupError);
  });

  it('parses answers strictly', () => {
    expect(parseAnswer({ verdict: 'unknown' })).toEqual({ verdict: 'unknown', cacheSeconds: 0 });
    expect(() => parseAnswer([])).toThrow(LookupError);
    expect(parseAnswer({ verdict: 'unsafe', reason: 'x'.repeat(500) }).reason).toHaveLength(300);
  });
});
