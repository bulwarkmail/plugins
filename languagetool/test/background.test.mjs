import { describe, expect, it } from 'vitest';
import { fakeApi } from '../../test-utils/fake-api.mjs';
import { createBackground } from '../src/lib/background.js';
import { savePrefs, addToDictionary } from '../src/lib/prefs.js';
import { LT_LANGUAGES } from '../src/lib/languages.js';
import { proxyHandler } from './lt-mock.mjs';
import manifest from '../manifest.json' with { type: 'json' };

// The background frame: what it registers, what the actions do, and how
// changes from the settings section reach it.

const SERVER = { serverUrl: 'http://languagetool:8010' };

async function start({ config = SERVER, accounts = [], hostFeatures } = {}) {
  const requests = [];
  const registered = [];
  const updates = [];
  let rechecks = 0;
  let tick = null;
  let clock = 0;
  const cfg = { current: config };
  const api = fakeApi({
    translations: manifest.locales,
    hostFeatures,
    handlers: {
      'proxy.fetch': proxyHandler({ requests }),
      'config.get': async () => cfg.current,
      'proxy.accounts': async () => accounts,
      'composer.registerChecker': async (def) => {
        registered.push(def);
        return { id: def.id, update: async (patch) => { updates.push(patch); return true; }, recheck: async () => { rechecks++; return true; }, dispose: async () => {} };
      },
    },
  });
  const bg = createBackground(api, { now: () => clock, setInterval: (fn) => { tick = fn; return 1; }, clearInterval: () => {} });
  await bg.activate();
  const flush = () => new Promise((r) => setTimeout(r, 0));
  return {
    api, bg, requests, registered, updates, cfg,
    get rechecks() { return rechecks; },
    advance: (ms) => { clock += ms; },
    poll: async () => { tick(); for (let i = 0; i < 5; i++) await flush(); },
    flush,
  };
}

const req = (text, extra = {}) => ({ composerId: 'c1', revision: 'r', language: 'en', full: true, order: ['a'], segments: [{ id: 'a', text }], objectReplacement: '￼', ...extra });
const ruleIds = (result) => result.annotations.map((a) => a.ruleId);

describe('registration', () => {
  it('registers one typing checker for every kind and the languages LanguageTool checks', async () => {
    const { registered } = await start();
    expect(registered).toHaveLength(1);
    const def = registered[0];
    expect(def).toMatchObject({ id: 'languagetool', label: 'LanguageTool', kinds: ['spelling', 'grammar', 'style', 'other'], debounceMs: 800, warnBeforeSend: false });
    expect(def.languages).toEqual(LT_LANGUAGES);
    expect(def.languages.length).toBeLessThanOrEqual(100);
    for (const l of def.languages) expect(l).toMatch(/^[A-Za-z]{2,3}(-[A-Za-z0-9]{1,8}){0,3}$/);
    expect(typeof def.check).toBe('function');
    expect(typeof def.onAction).toBe('function');
    expect(def.mode).toBeUndefined();
  });

  it('registers also without a server and answers every check with "not set up"', async () => {
    const { registered, requests } = await start({ config: {} });
    expect(await registered[0].check(req('teh'))).toEqual({ status: 'unavailable', message: manifest.locales.en['error.not_set_up'] });
    expect(requests).toHaveLength(0);
  });

  it('starts with the send warning the user chose', async () => {
    const api = fakeApi({ handlers: { 'config.get': async () => SERVER, 'composer.registerChecker': async (def) => ({ ...def, update: async () => true, recheck: async () => true }) } });
    await savePrefs(api, { warnBeforeSend: true });
    const bg = createBackground(api, { setInterval: () => 1 });
    await bg.activate();
    expect(api.calls('composer.registerChecker')[0].args[0].warnBeforeSend).toBe(true);
  });

  it('uses the server with the token when the admin set one', async () => {
    const { registered, requests } = await start({ accounts: [{ credentialId: 'server-token', scope: 'admin', connected: true }] });
    await registered[0].check(req('teh'));
    expect(requests[0].credentialId).toBe('server-token');
  });

  it('turns the public API off in no-third-party mode', async () => {
    const { registered, requests } = await start({ config: { allowPublicApi: true }, hostFeatures: { noThirdPartyTraffic: true } });
    expect((await registered[0].check(req('teh'))).message).toBe(manifest.locales.en['error.third_party']);
    expect(requests).toHaveLength(0);
  });
});

describe('actions from the popup', () => {
  it('adds a word to the dictionary, rechecks and stops flagging it, without a new request', async () => {
    const t = await start();
    const check = t.registered[0].check;
    const first = await check(req('Bulwark and teh'));
    expect(first.annotations.map((a) => a.text ?? a.offset)).toHaveLength(2);
    const bulwark = { ...first.annotations[0], text: 'Bulwark' };
    await t.registered[0].onAction({ composerId: 'c1', annotation: bulwark, action: 'dictionary' });
    expect(await t.api.storage.get('dictionary')).toEqual(['Bulwark']);
    expect(t.rechecks).toBe(1);
    const second = await check(req('Bulwark and teh', { composerId: 'c2' }));
    expect(second.annotations).toHaveLength(1);
    expect(t.requests).toHaveLength(1);
    // The poll doesn't recheck again for the plugin's own change.
    await t.poll();
    expect(t.rechecks).toBe(1);
  });

  it('turns a rule off for this user when allowed', async () => {
    const t = await start();
    const check = t.registered[0].check;
    const first = await check(req('I has two question.'));
    const has = first.annotations.find((a) => a.ruleId === 'NON3PRS_VERB');
    await t.registered[0].onAction({ composerId: 'c1', annotation: { ...has, text: 'has' }, action: 'disable-rule' });
    expect((await t.api.storage.get('prefs')).disabledRules).toEqual([{ id: 'NON3PRS_VERB', label: has.ruleLabel }]);
    expect(t.rechecks).toBe(1);
    expect(ruleIds(await check(req('I has two question.')))).toEqual(['CD_NN']);
  });

  it('ignores "turn off rule" when the admin locked the rules', async () => {
    const t = await start({ config: { ...SERVER, userMayChange: false } });
    await t.registered[0].onAction({ composerId: 'c1', annotation: { ruleId: 'NON3PRS_VERB', text: 'has', kind: 'grammar' }, action: 'disable-rule' });
    expect(await t.api.storage.get('prefs')).toBeNull();
    expect(t.rechecks).toBe(0);
  });

  it('ignores an issue in that composer only', async () => {
    const t = await start();
    const check = t.registered[0].check;
    const [teh] = (await check(req('teh'))).annotations;
    await t.registered[0].onAction({ composerId: 'c1', annotation: { ...teh, text: 'teh' }, action: 'ignore' });
    expect(t.rechecks).toBe(0);
    expect((await check(req('Again teh.'))).annotations).toHaveLength(0);
    expect((await check(req('Again teh.', { composerId: 'c2' }))).annotations).toHaveLength(1);
  });
});

describe('changes from the settings section', () => {
  it('applies a new dictionary word and the send warning on the next poll', async () => {
    const t = await start();
    await addToDictionary(t.api, 'teh');
    await savePrefs(t.api, { warnBeforeSend: true });
    await t.poll();
    expect(t.updates).toEqual([{ warnBeforeSend: true }]);
    expect(t.rechecks).toBe(1);
    expect((await t.registered[0].check(req('teh'))).annotations).toHaveLength(0);
    await t.poll();
    expect(t.rechecks).toBe(1);
  });

  it('reads a changed admin config after a minute and rechecks', async () => {
    const t = await start({ config: {} });
    t.cfg.current = SERVER;
    await t.poll();
    expect(t.rechecks).toBe(0);
    t.advance(61_000);
    await t.poll();
    expect(t.rechecks).toBe(1);
    expect((await t.registered[0].check(req('teh'))).status).toBe('ok');
  });
});
