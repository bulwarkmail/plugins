import { describe, expect, it } from 'vitest';
import { fakeApi } from '../../test-utils/fake-api.mjs';
import { runCheck, createBudget, ignoreKey, PUBLIC_MAX_BYTES } from '../src/lib/checker.js';
import { createCache } from '../src/lib/cache.js';
import { endpointFor, readAdmin, readPrefs } from '../src/lib/config.js';
import { proxyHandler } from './lt-mock.mjs';
import manifest from '../manifest.json' with { type: 'json' };

// One check from the host's request to the annotations it gets back.

const OBJ = '￼';
const SERVER = { serverUrl: 'http://languagetool:8010' };

function setup({ config = SERVER, prefs = {}, dictionary = [], respond, tokenSet = false, noThirdPartyTraffic = false, now } = {}) {
  const requests = [];
  const api = fakeApi({ translations: manifest.locales, handlers: { 'proxy.fetch': proxyHandler({ requests, respond }) } });
  const admin = readAdmin(config);
  const ctx = {
    api, admin, prefs: readPrefs(prefs), dictionary, endpoint: endpointFor(admin, { tokenSet, noThirdPartyTraffic }),
    cache: createCache(), budget: createBudget(), ignored: new Set(), t: api.i18n.t, ...(now ? { now } : {}),
  };
  return { api, ctx, requests };
}

const request = (segments, extra = {}) => ({
  composerId: 'c1', revision: 'r1', language: 'auto', full: true,
  order: segments.map((s) => s.id), segments, objectReplacement: OBJ, ...extra,
});
const words = (result) => result.annotations.map((a) => a.replacements[0] ? `${a.kind}:${a.ruleId}:${a.segmentId}@${a.offset}+${a.length}` : `${a.kind}:${a.ruleId}`);

describe('a check', () => {
  it('posts one form request to /v2/check on the admin server and maps the answer', async () => {
    const { ctx, requests } = setup();
    const segments = [{ id: 'p1', text: `I has two question ${OBJ} about teh offer.` }, { id: 'p2', text: 'Ich habe gestern dem Brief geschrieben.' }];
    const result = await runCheck(request(segments), ctx);
    expect(requests).toHaveLength(1);
    const [r] = requests;
    expect(r.credentialId).toBe('server');
    expect(r.url).toBe('http://languagetool:8010/v2/check');
    expect(r.init.method).toBe('POST');
    expect(r.init.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
    expect(r.params.language).toBe('auto');
    expect(r.params.preferredVariants).toBe('en-US,de-DE,pt-PT');
    expect(r.params.enabledOnly).toBe('false');
    expect(r.params.text).toBeUndefined();
    expect(r.full).toBe(`${segments[0].text}\n\n${segments[1].text}`);
    expect(result.status).toBe('ok');
    const text = segments[0].text;
    expect(result.annotations).toEqual([
      { segmentId: 'p1', offset: 2, length: 3, kind: 'grammar', message: expect.any(String), shortMessage: 'Grammatical problem', replacements: ['have', 'had'], ruleId: 'NON3PRS_VERB', ruleLabel: expect.any(String) },
      expect.objectContaining({ segmentId: 'p1', offset: text.indexOf('question'), length: 8, kind: 'grammar', replacements: ['questions'] }),
      expect.objectContaining({ segmentId: 'p1', offset: text.indexOf('teh'), length: 3, kind: 'spelling', replacements: ['the', 'ten', 'tea'] }),
      expect.objectContaining({ segmentId: 'p2', offset: 17, length: 3, kind: 'grammar', replacements: ['den'], ruleId: 'DE_AGREEMENT' }),
    ]);
  });

  it('uses the token credential when the admin set a token, never for the public API', async () => {
    const withToken = setup({ tokenSet: true });
    await runCheck(request([{ id: 'a', text: 'teh' }]), withToken.ctx);
    expect(withToken.requests[0].credentialId).toBe('server-token');
    const pub = setup({ config: { allowPublicApi: true }, tokenSet: true });
    await runCheck(request([{ id: 'a', text: 'teh' }]), pub.ctx);
    expect(pub.requests[0].credentialId).toBe('public');
    expect(pub.requests[0].url).toBe('https://api.languagetool.org/v2/check');
  });

  it('sends the writing language with a variant, the level, mother tongue and the admin rules', async () => {
    const { ctx, requests } = setup({
      config: { ...SERVER, preferredVariants: 'en-GB', disabledRules: 'A_RULE, B_RULE', disabledCategories: 'typography', level: 'picky' },
      prefs: { motherTongue: 'de' },
    });
    await runCheck(request([{ id: 'a', text: 'teh' }], { language: 'en' }), ctx);
    expect(requests[0].params).toMatchObject({ language: 'en-GB', level: 'picky', motherTongue: 'de-DE', disabledRules: 'A_RULE,B_RULE', disabledCategories: 'TYPOGRAPHY' });
    expect(requests[0].params.preferredVariants).toBeUndefined();
  });

  it("sends the admin's values and not the user's when the admin locked them", async () => {
    const { ctx, requests } = setup({
      config: { ...SERVER, userMayChange: false, defaultLanguage: 'de-AT', level: 'default' },
      prefs: { language: 'en', variants: ['en-GB'], picky: true, disabledRules: [{ id: 'DE_AGREEMENT' }] },
    });
    const result = await runCheck(request([{ id: 'a', text: 'Ich habe dem Brief.' }], { language: 'fr' }), ctx);
    expect(requests[0].params).toMatchObject({ language: 'de-AT', level: 'default' });
    // The user's turned-off rule doesn't count either.
    expect(result.annotations.map((a) => a.ruleId)).toEqual(['DE_AGREEMENT']);
  });
});

describe('the paragraph cache', () => {
  it('never sends a paragraph twice, also not after full: true', async () => {
    const { ctx, requests } = setup();
    const first = await runCheck(request([{ id: 'a', text: 'I has teh offer.' }, { id: 'b', text: 'Fine.' }]), ctx);
    const again = await runCheck(request([{ id: 'a', text: 'I has teh offer.' }, { id: 'b', text: 'Fine.' }], { composerId: 'c2', full: true }), ctx);
    expect(requests).toHaveLength(1);
    expect(again.annotations).toEqual(first.annotations);
    await runCheck(request([{ id: 'a', text: 'I has teh offer.' }, { id: 'c', text: 'New teh.' }]), ctx);
    expect(requests).toHaveLength(2);
    expect(requests[1].full).toBe('New teh.');
  });

  it('sends one copy of paragraphs with the same text', async () => {
    const { ctx, requests } = setup();
    const result = await runCheck(request([{ id: 'a', text: 'teh' }, { id: 'a.1', text: 'teh' }]), ctx);
    expect(requests[0].full).toBe('teh');
    expect(result.annotations.map((a) => a.segmentId)).toEqual(['a', 'a.1']);
  });

  it('asks again when a setting that changes the answer changed', async () => {
    const { ctx, requests } = setup();
    await runCheck(request([{ id: 'a', text: 'teh' }]), ctx);
    await runCheck(request([{ id: 'a', text: 'teh' }], { language: 'en' }), ctx);
    expect(requests).toHaveLength(2);
    ctx.prefs = readPrefs({ picky: true });
    await runCheck(request([{ id: 'a', text: 'teh' }], { language: 'en' }), ctx);
    expect(requests).toHaveLength(3);
    expect(requests[2].params.level).toBe('picky');
  });

  it('keeps nothing from a failed request', async () => {
    let fail = true;
    const { ctx, requests } = setup({ respond: () => (fail ? { status: 503, ok: false, headers: {}, body: 'down' } : null) });
    expect((await runCheck(request([{ id: 'a', text: 'teh' }]), ctx)).status).toBe('unavailable');
    fail = false;
    expect((await runCheck(request([{ id: 'a', text: 'teh' }]), ctx)).annotations).toHaveLength(1);
    expect(requests).toHaveLength(2);
  });

  it('forgets the least recently used paragraphs first', () => {
    const cache = createCache(2);
    cache.set('s', 'one', [1]);
    cache.set('s', 'two', [2]);
    cache.get('s', 'one');
    cache.set('s', 'three', [3]);
    expect(cache.get('s', 'two')).toBeUndefined();
    expect(cache.get('s', 'one')).toEqual([1]);
    expect(cache.size).toBe(2);
  });
});

describe('what the user does not want to see', () => {
  const segments = [{ id: 'a', text: 'Bulwark and BULWARK and Jmap and teh offer is very unique.' }];

  it('drops spelling matches of dictionary and organisation words', async () => {
    const { ctx } = setup({ config: { ...SERVER, wordList: 'jmap\nteh' }, dictionary: ['Bulwark'] });
    const result = await runCheck(request(segments), ctx);
    expect(result.annotations.map((a) => a.ruleId)).toEqual(['VERY_UNIQUE']);
  });

  it('keeps a spelling match whose case the entry does not allow', async () => {
    const { ctx } = setup({ dictionary: ['bulwarK'] });
    const result = await runCheck(request(segments), ctx);
    expect(result.annotations.filter((a) => a.kind === 'spelling').length).toBe(2);
  });

  it('drops issues ignored in this composer, rules the user turned off and admin categories', async () => {
    const { ctx } = setup({ config: { ...SERVER }, prefs: { disabledRules: [{ id: 'VERY_UNIQUE', label: 'x' }] } });
    ctx.ignored = new Set([ignoreKey('MORFOLOGIK_RULE_EN_US', 'teh')]);
    const result = await runCheck(request(segments), ctx);
    expect(result.annotations.map((a) => a.offset)).toEqual([segments[0].text.indexOf('Bulwark')]);
    ctx.admin = readAdmin({ ...SERVER, disabledCategories: 'TYPOS' });
    ctx.ignored = new Set();
    ctx.prefs = readPrefs({});
    // TYPOS goes to the server and is filtered here too.
    const second = await runCheck(request(segments), ctx);
    expect(second.annotations.map((a) => a.ruleId)).toEqual(['VERY_UNIQUE']);
  });
});

describe('when something goes wrong', () => {
  const run = async (respond, opts = {}) => {
    const { ctx } = setup({ respond, ...opts });
    return runCheck(request([{ id: 'a', text: 'teh' }]), ctx);
  };
  const en = manifest.locales.en;

  it('pauses for as long as Retry-After says on a 429, else a minute', async () => {
    expect(await run(() => ({ status: 429, ok: false, headers: { 'retry-after': '42' }, body: 'Too many' })))
      .toEqual({ status: 'paused', message: en['error.rate_limited'], retryAfterMs: 42_000 });
    expect(await run(() => ({ status: 429, ok: false, headers: {}, body: '' })))
      .toEqual({ status: 'paused', message: en['error.rate_limited'], retryAfterMs: 60_000 });
    expect((await run(() => ({ status: 429, ok: false, headers: { 'retry-after': '3' }, body: '', proxyError: 'rate_limited' }))).retryAfterMs).toBe(3000);
  });

  it.each([
    ['network failure', () => { throw new Error('Network error'); }, 'error.network'],
    ['no server set up', () => ({ status: 404, ok: false, headers: {}, body: 'No such credential', proxyError: 'no_credential' }), 'error.not_set_up'],
    ['third-party traffic off', () => ({ status: 403, ok: false, headers: {}, body: '{"error":"The plugin proxy is off","code":"no-third-party-traffic"}' }), 'error.third_party'],
    ['private address not allowed', () => ({ status: 403, ok: false, headers: {}, body: 'not allowed', proxyError: 'blocked_address' }), 'error.blocked'],
    ['proxy timeout', () => ({ status: 504, ok: false, headers: {}, body: '', proxyError: 'timeout' }), 'error.timeout'],
    ['unreachable', () => ({ status: 502, ok: false, headers: {}, body: '', proxyError: 'unreachable' }), 'error.unreachable'],
    ['wrong path', () => ({ status: 404, ok: false, headers: {}, body: '<html>Not found</html>' }), 'error.wrong_url'],
    ['not LanguageTool', () => ({ status: 200, ok: true, headers: {}, body: '<html>Welcome</html>' }), 'error.wrong_url'],
    ['unsupported language', () => ({ status: 400, ok: false, headers: {}, body: "Error: 'xx-YY' is not a language code known to LanguageTool." }), 'error.language'],
    ['text too long', () => ({ status: 413, ok: false, headers: {}, body: 'Error: Your text exceeds the limit of 20000 characters' }), 'error.too_long'],
    ['token refused', () => ({ status: 401, ok: false, headers: {}, body: 'Unauthorized' }), 'error.auth'],
  ])('%s is unavailable with its message', async (_name, respond, key) => {
    const result = await run(respond);
    expect(result).toEqual({ status: 'unavailable', message: en[key] });
    expect(result.message).not.toBe(key);
  });

  it('says which HTTP status a server error had', async () => {
    expect(await run(() => ({ status: 500, ok: false, headers: {}, body: 'Error: boom' }))).toEqual({ status: 'unavailable', message: 'The LanguageTool server has a problem (HTTP 500).' });
    expect(await run(() => ({ status: 400, ok: false, headers: {}, body: 'Error: bad' }))).toEqual({ status: 'unavailable', message: "LanguageTool couldn't read the request (HTTP 400)." });
  });

  it('gives up before the host does when the server hangs', async () => {
    const { ctx } = setup({ respond: () => new Promise(() => {}) });
    ctx.checkBudgetMs = 600;
    const started = Date.now();
    expect(await runCheck(request([{ id: 'a', text: 'teh' }]), ctx)).toEqual({ status: 'unavailable', message: en['error.timeout'] });
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('says the plugin is not set up without sending anything', async () => {
    const { ctx, requests } = setup({ config: {} });
    expect(await runCheck(request([{ id: 'a', text: 'teh' }]), ctx)).toEqual({ status: 'unavailable', message: en['error.not_set_up'] });
    const off = setup({ config: { allowPublicApi: true }, noThirdPartyTraffic: true });
    expect(await runCheck(request([{ id: 'a', text: 'teh' }]), off.ctx)).toEqual({ status: 'unavailable', message: en['error.third_party'] });
    expect(requests.length + off.requests.length).toBe(0);
  });

  it('says so for a writing language LanguageTool does not check, without a request', async () => {
    const { ctx, requests } = setup();
    expect(await runCheck(request([{ id: 'a', text: 'Dobrý den' }], { language: 'cs' }), ctx)).toEqual({ status: 'unavailable', message: en['error.language'] });
    expect(requests).toHaveLength(0);
  });
});

describe('the public API', () => {
  it('splits text above 20 KB into several requests and maps every one back', async () => {
    const { ctx, requests } = setup({ config: { allowPublicApi: true } });
    const segments = Array.from({ length: 6 }, (_, i) => ({ id: `p${i}`, text: `${i} ${'Lorem ipsum dolor sit amet. '.repeat(200)}teh end` }));
    const result = await runCheck(request(segments), ctx);
    expect(requests.length).toBeGreaterThan(1);
    for (const r of requests) expect(new TextEncoder().encode(r.full).length).toBeLessThanOrEqual(PUBLIC_MAX_BYTES);
    expect(result.annotations.map((a) => a.segmentId)).toEqual(segments.map((s) => s.id));
    for (const a of result.annotations) expect(segments.find((s) => s.id === a.segmentId).text.slice(a.offset, a.offset + a.length)).toBe('teh');
  });

  it('waits once this browser used up the minute, without asking the server', async () => {
    let clock = 1_000_000;
    const { ctx, requests } = setup({ config: { allowPublicApi: true }, now: () => clock });
    for (let i = 0; i < 20; i++) await runCheck(request([{ id: `p${i}`, text: `teh ${i}` }]), ctx);
    expect(requests).toHaveLength(20);
    clock += 30_000;
    const result = await runCheck(request([{ id: 'x', text: 'teh x' }]), ctx);
    expect(result).toEqual({ status: 'paused', message: manifest.locales.en['error.public_limit'], retryAfterMs: 30_000 });
    expect(requests).toHaveLength(20);
    clock += 30_000;
    expect((await runCheck(request([{ id: 'x', text: 'teh x' }]), ctx)).status).toBe('ok');
  });

  it('counts bytes per minute too', () => {
    const budget = createBudget({ requests: 20, bytes: 1000 });
    budget.record(600, 0);
    expect(budget.wait(300, 1000)).toBe(0);
    budget.record(300, 1000);
    expect(budget.wait(300, 2000)).toBe(58_000);
  });
});
