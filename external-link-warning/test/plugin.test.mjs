// The built bundle runs the way the sandbox runs it, against the fake api.
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { build } from 'esbuild';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { fakeApi, proxyResponse } from '../../test-utils/fake-api.mjs';
import * as kit from '../../test-utils/ui-kit.mjs';
import { EN } from '../src/lib/strings.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const manifest = JSON.parse(readFileSync(path.join(here, '../manifest.json'), 'utf8'));
const sbMatch = JSON.parse(readFileSync(path.join(here, 'fixtures/sb-match.json'), 'utf8'));
let code;

beforeAll(async () => {
  const out = await build({
    entryPoints: [path.join(here, '../src/index.js')],
    bundle: true, format: 'cjs', platform: 'browser', target: 'es2020', write: false, logLevel: 'silent',
    external: ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime', '@plugin-host', '@plugin-host/ui'],
  });
  code = out.outputFiles[0].text;
});

function load(api) {
  const mod = { exports: {} };
  const req = (name) => {
    if (name === '@plugin-host') return api;
    if (name === '@plugin-host/ui') return kit;
    if (name === 'react' || name === 'react/jsx-runtime' || name === 'react-dom') return require(name);
    throw new Error(`module ${name} is not available`);
  };
  new Function('module', 'exports', 'require', code)(mod, mod.exports, req);
  return mod.exports;
}

const ALL_READY = [
  { credentialId: 'safebrowsing', scope: 'admin', connected: true },
  { credentialId: 'linkcheck', scope: 'admin', connected: false },
  { credentialId: 'linkcheck-open', scope: 'admin', connected: true },
];

async function started({ config = {}, accounts = ALL_READY, endpoint, google, confirm = false, dialog = null, hostFeatures = { noThirdPartyTraffic: false }, settings = {} } = {}) {
  const api = fakeApi({
    id: 'external-link-warning',
    settings: { rememberLocalChoices: false, ...settings },
    translations: { en: manifest.locales.en },
    hostFeatures,
    handlers: {
      'config.get': async () => config,
      'proxy.accounts': async () => accounts,
      'proxy.fetch': async (credentialId, url, init) => {
        if (credentialId === 'safebrowsing') return google ? google(url, init) : proxyResponse({ cacheDuration: '300s' });
        return endpoint ? endpoint(url, init, credentialId) : proxyResponse(JSON.stringify({ verdict: 'safe' }));
      },
      'ui.confirm': async () => confirm,
      'ui.alert': async () => undefined,
      'ui.openDialog': async () => dialog,
    },
  });
  const plugin = load(api);
  await plugin.activate(api);
  return { api, plugin };
}

const click = (plugin, href, text) => plugin.hooks.onBeforeExternalLink({ href, ...(text ? { text } : {}) });

describe('the manifest', () => {
  it('ships the English texts the code falls back to, and German for every key', () => {
    expect(manifest.locales.en).toEqual(EN);
    expect(Object.keys(manifest.locales.de).sort()).toEqual(Object.keys(EN).sort());
    for (const [key, text] of Object.entries(EN)) {
      const vars = (s) => (s.match(/\{\w+\}/g) ?? []).sort();
      expect(vars(manifest.locales.de[key]), key).toEqual(vars(text));
    }
    // Formal German: no "du" forms.
    expect(Object.values(manifest.locales.de).join(' ')).not.toMatch(/\b(du|dein|deine|deinen|dir|fahre)\b/i);
  });

  it('keeps the keys on the server and reads no admin config with secrets', () => {
    expect(manifest.permissions).toEqual(['http:proxy']);
    expect(manifest.minAppVersion).toBe('1.20.0');
    expect(manifest.configSchema.safeBrowsingKey.type).toBe('secret');
    expect(manifest.configSchema.endpointToken.type).toBe('secret');
    expect(manifest.credentials.safebrowsing).toMatchObject({ origin: 'https://safebrowsing.googleapis.com', inject: { type: 'header', name: 'X-Goog-Api-Key' }, secretKey: 'safeBrowsingKey' });
    expect(manifest.credentials.linkcheck).toMatchObject({ inject: { type: 'bearer' }, originKey: 'endpointUrl' });
    expect(manifest.credentials['linkcheck-open']).toMatchObject({ inject: { type: 'none' }, originKey: 'endpointUrl' });
    expect(code).not.toMatch(/admin\.getConfig|admin\.getAllConfig/);
  });
});

describe('without a lookup (the default)', () => {
  it('opens trusted domains and warns for others, as before', async () => {
    const { api, plugin } = await started({ config: { trustedDomains: 'example.com' } });
    expect(await click(plugin, 'https://docs.example.com/a')).toBeUndefined();
    expect(await click(plugin, 'https://unknown.test/a')).toBe(false);
    await vi.waitFor(() => expect(api.calls('ui.confirm')).toHaveLength(1));
    expect(api.calls('ui.confirm')[0].args[0].message).toContain('unknown.test');
    expect(api.calls('proxy.fetch')).toHaveLength(0);
  });

  it('opens the link itself after Continue', async () => {
    const { api, plugin } = await started({ confirm: true });
    expect(await click(plugin, 'https://unknown.test/a')).toBe(false);
    await vi.waitFor(() => expect(api.calls('ui.openExternalUrl')).toHaveLength(1));
    expect(api.calls('ui.openExternalUrl')[0].args[0]).toBe('https://unknown.test/a');
  });

  it('checks, shows and opens the address the browser opens, not the raw text', async () => {
    const posted = [];
    const { api, plugin } = await started({
      config: { lookup: 'endpoint', endpointUrl: 'https://check.corp.example/v1' },
      confirm: true,
      endpoint: (url, init) => { posted.push(JSON.parse(init.body)); return proxyResponse(JSON.stringify({ verdict: 'safe' })); },
    });
    expect(await click(plugin, 'http://evil.example\\@good.example/login')).toBe(false);
    await vi.waitFor(() => expect(api.calls('ui.openExternalUrl')).toHaveLength(1));
    expect(posted).toEqual([{ url: 'http://evil.example/@good.example/login', host: 'evil.example' }]);
    const message = api.calls('ui.confirm')[0].args[0].message;
    expect(message).toContain('evil.example');
    expect(message).not.toMatch(/visit good\.example/);
    expect(api.calls('ui.openExternalUrl')[0].args[0]).toBe('http://evil.example/@good.example/login');
  });

  it('leaves mailto: and relative links alone', async () => {
    const { plugin } = await started();
    expect(await click(plugin, 'mailto:a@b.test')).toBeUndefined();
    expect(await click(plugin, '/inbox')).toBeUndefined();
  });
});

describe('with the company endpoint', () => {
  const config = { lookup: 'endpoint', endpointUrl: 'https://check.corp.example/v1', trustedDomains: 'corp.example' };

  it('warns strongly for an unsafe verdict and names the real domain', async () => {
    const { api, plugin } = await started({
      config,
      endpoint: () => proxyResponse(JSON.stringify({ verdict: 'unsafe', reason: 'Known phishing kit' })),
    });
    expect(await click(plugin, 'https://login.evil.example/x', 'https://www.paypal.com')).toBe(false);
    await vi.waitFor(() => expect(api.calls('ui.confirm')).toHaveLength(1));
    const options = api.calls('ui.confirm')[0].args[0];
    expect(options.title).toBe('This link may be dangerous');
    expect(options.danger).toBe(true);
    expect(options.message).toContain('login.evil.example');
    expect(options.message).toContain('Reason: Known phishing kit');
    expect(options.message).toContain('The link text says www.paypal.com');
    expect(api.calls('ui.openExternalUrl')).toHaveLength(0);
  });

  it('uses the token credential only when the admin set a token', async () => {
    const used = [];
    const endpoint = (_url, _init, credentialId) => { used.push(credentialId); return proxyResponse(JSON.stringify({ verdict: 'safe' })); };
    const open = await started({ config, endpoint });
    await click(open.plugin, 'https://a.test/');
    const withToken = await started({ config, endpoint, accounts: ALL_READY.map((a) => (a.credentialId === 'linkcheck' ? { ...a, connected: true } : a)) });
    await click(withToken.plugin, 'https://a.test/');
    expect(used).toEqual(['linkcheck-open', 'linkcheck']);
  });

  it('opens a trusted, checked link without a dialog when trusted domains are checked too', async () => {
    const { api, plugin } = await started({ config: { ...config, skipTrusted: false } });
    expect(await click(plugin, 'https://wiki.corp.example/')).toBeUndefined();
    expect(api.calls('proxy.fetch')).toHaveLength(1);
    expect(api.calls('ui.confirm')).toHaveLength(0);
  });

  it('skips the check for trusted domains by default', async () => {
    const { api, plugin } = await started({ config });
    expect(await click(plugin, 'https://wiki.corp.example/')).toBeUndefined();
    expect(api.calls('proxy.fetch')).toHaveLength(0);
  });

  it('fails open by default: the warning says it couldn\'t check', async () => {
    const { api, plugin } = await started({ config, endpoint: () => proxyResponse('oops', { status: 502 }) });
    expect(await click(plugin, 'https://unknown.test/')).toBe(false);
    await vi.waitFor(() => expect(api.calls('ui.confirm')).toHaveLength(1));
    expect(api.calls('ui.confirm')[0].args[0].message).toContain("Couldn't check this link.");
  });

  it('fails closed when the admin says so: only Close, never an open', async () => {
    const { api, plugin } = await started({ config: { ...config, onFailure: 'closed' }, confirm: true, endpoint: () => { throw new Error('down'); } });
    expect(await click(plugin, 'https://unknown.test/')).toBe(false);
    await vi.waitFor(() => expect(api.calls('ui.alert')).toHaveLength(1));
    expect(api.calls('ui.alert')[0].args[0].message).toContain('unknown.test');
    expect(api.calls('ui.confirm')).toHaveLength(0);
    expect(api.calls('ui.openExternalUrl')).toHaveLength(0);
  });
});

describe('with Google Safe Browsing', () => {
  const config = { lookup: 'safebrowsing' };
  const MALWARE = 'http://malware.testing.google.test/testing/malware/';

  it('opens Google\'s dialog with the advisory for a listed link', async () => {
    const { api, plugin } = await started({ config, google: () => proxyResponse(sbMatch), dialog: 'open' });
    expect(await click(plugin, MALWARE)).toBe(false);
    await vi.waitFor(() => expect(api.calls('ui.openDialog')).toHaveLength(1));
    const options = api.calls('ui.openDialog')[0].args[0];
    expect(options.slot).toBe('plugin-dialog');
    expect(options.extraProps.paragraphs[0]).toContain('malware.testing.google.test');
    await vi.waitFor(() => expect(api.calls('ui.openExternalUrl')).toHaveLength(1));
    // The URL went to Google only as hash prefixes.
    expect(api.calls('proxy.fetch')[0].args[1]).not.toContain('malware');
  });

  it('is off in the no-third-party mode, and fail closed doesn\'t block links because of it', async () => {
    const google = vi.fn(() => proxyResponse(sbMatch));
    const { api, plugin } = await started({
      config: { ...config, onFailure: 'closed', skipTrusted: false, trustedDomains: 'google.test' },
      google,
      hostFeatures: { noThirdPartyTraffic: true },
    });
    expect(await click(plugin, MALWARE)).toBeUndefined();
    expect(google).not.toHaveBeenCalled();
    expect(api.calls('ui.alert')).toHaveLength(0);
    // An untrusted link gets the plain domain warning, not the fail-closed refusal.
    expect(await click(plugin, 'https://unknown.test/')).toBe(false);
    await vi.waitFor(() => expect(api.calls('ui.confirm')).toHaveLength(1));
    expect(api.calls('ui.alert')).toHaveLength(0);
  });

  it('follows the mode when it changes while running', async () => {
    const google = vi.fn(() => proxyResponse({ cacheDuration: '300s' }));
    const { api, plugin } = await started({ config: { ...config, skipTrusted: false, trustedDomains: 'a.test' }, google, hostFeatures: { noThirdPartyTraffic: true } });
    await click(plugin, 'https://a.test/');
    expect(google).not.toHaveBeenCalled();
    api.setHostFeatures({ noThirdPartyTraffic: false });
    await click(plugin, 'https://a.test/');
    expect(google).toHaveBeenCalledTimes(1);
  });

  it('counts a missing key as a failed check', async () => {
    const { api, plugin } = await started({ config, accounts: [] });
    expect(await click(plugin, 'https://unknown.test/')).toBe(false);
    await vi.waitFor(() => expect(api.calls('ui.confirm')).toHaveLength(1));
    expect(api.calls('ui.confirm')[0].args[0].message).toContain("Couldn't check this link.");
    expect(api.calls('proxy.fetch')).toHaveLength(0);
  });
});
