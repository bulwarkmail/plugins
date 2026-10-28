// The built bundle, evaluated the way the webmail's sandbox does it
// (CommonJS with React and '@plugin-host' handed in), against the fake api.
import { beforeAll, describe, expect, it } from 'vitest';
import { build } from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { fakeApi, proxyResponse } from '../../test-utils/fake-api.mjs';
import manifest from '../manifest.json' with { type: 'json' };
import * as kit from '../../test-utils/ui-kit.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
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
  return mod.exports.default ?? mod.exports;
}

const SHIPPING = {
  id: 'm-ship', subject: 'Your order has shipped', from: [{ name: 'Shop', email: 'orders@shop.example' }],
  preview: 'Your parcel is on its way. DHL tracking number: 00340434161094042557',
  text: 'Your parcel is on its way.\n\nDHL tracking number: 00340434161094042557\nUPS: 1Z999AA10123456784\n',
  source: '',
};
const NEWSLETTER = { id: 'm-news', subject: 'October newsletter', from: [{ name: 'News', email: 'news@lists.example' }], preview: 'Monthly news.', text: 'Monthly news. Call 0800 1234567.', source: '' };

/** 17TRACK that moves the JJD-style status on with each read, like the test mock. */
function api17({ settings = {}, locale = 'en', statuses = ['InfoReceived', 'InTransit', 'OutForDelivery', 'Delivered'] } = {}) {
  let reads = 0;
  const registered = new Set();
  return fakeApi({
    id: 'parcels', settings, locale, translations: manifest.locales,
    handlers: {
      'config.get': async () => ({ track17Url: 'http://localhost:18099/17track/track/v2.2' }),
      'email.get': async (id) => ({ [SHIPPING.id]: SHIPPING, [NEWSLETTER.id]: NEWSLETTER }[id] ?? null),
      'notifications.show': async () => 'toast',
      'proxy.fetch': async (credentialId, url, init) => {
        if (credentialId === 'dhl') return { status: 404, ok: false, headers: {}, body: '', proxyError: 'no_credential' };
        const numbers = JSON.parse(init.body).map((x) => x.number);
        if (url.endsWith('/register')) {
          numbers.forEach((n) => registered.add(n));
          return proxyResponse({ code: 0, data: { accepted: numbers.map((number) => ({ number })), rejected: [] } });
        }
        const accepted = [];
        const rejected = [];
        for (const number of numbers) {
          if (!registered.has(number)) { rejected.push({ number, error: { code: -18019902 } }); continue; }
          const status = statuses[Math.min(reads, statuses.length - 1)];
          accepted.push({ number, track_info: { latest_status: { status }, latest_event: { description: `Now ${status}`, location: 'Hildesheim, DE', time_iso: '2026-10-12T07:55:00+02:00' } } });
        }
        if (accepted.length) reads++;
        return proxyResponse({ code: 0, data: { accepted, rejected } });
      },
    },
  });
}

describe('the bundle', () => {
  it('offers the reader card, the deliveries section, its dialogs and the hooks', () => {
    const plugin = load(fakeApi());
    expect(Object.keys(plugin.slots)).toEqual(['email-banner', 'sidebar-section', 'sidebar-section-actions', 'plugin-dialog']);
    for (const slot of Object.values(plugin.slots)) expect(typeof slot.component).toBe('function');
    expect(Object.keys(plugin.hooks).sort()).toEqual(['onInterval', 'onNewEmailReceived']);
  });

  it('shows the reader card only on messages with a tracking number', () => {
    const { shouldShow } = load(fakeApi()).slots['email-banner'];
    expect(shouldShow({ email: SHIPPING })).toBe(true);
    expect(shouldShow({ email: NEWSLETTER })).toBe(false);
    expect(shouldShow({ email: null })).toBe(false);
    expect(shouldShow({})).toBe(false);
  });

  it('picks up parcels from new shipping mail, without opening other mail', async () => {
    const api = api17();
    const { hooks } = load(api);
    await hooks.onNewEmailReceived({ ...NEWSLETTER, text: undefined });
    expect(api.calls('email.get')).toHaveLength(0);
    await hooks.onNewEmailReceived({ ...SHIPPING, text: undefined });
    expect(api.calls('email.get').map((c) => c.args[0])).toEqual(['m-ship']);
    expect(Object.keys(api.storageSnapshot()).sort()).toEqual(['parcel:00340434161094042557', 'parcel:1Z999AA10123456784']);
    expect(api.storageSnapshot()['parcel:00340434161094042557']).toMatchObject({ emailId: 'm-ship', subject: 'Your order has shipped', carrier: 'dhl' });
  });

  it('leaves new mail alone when the user turned that off', async () => {
    const api = api17({ settings: { trackNewMail: false } });
    await load(api).hooks.onNewEmailReceived({ ...SHIPPING });
    expect(api.calls('email.get')).toHaveLength(0);
    expect(api.storageSnapshot()).toEqual({});
  });

  it('notifies on a status change found by the once-a-minute poll, in the user\'s language', async () => {
    const api = api17({ locale: 'de' });
    const { hooks } = load(api);
    await hooks.onNewEmailReceived({ ...SHIPPING });
    // Only the DHL number this time.
    await api.storage.remove('parcel:1Z999AA10123456784');
    await hooks.onInterval({ now: new Date().toISOString() });
    expect(api.storageSnapshot()['parcel:00340434161094042557'].status).toBe('info_received');
    expect(api.calls('notifications.show')).toHaveLength(0);
    // Half an hour later the next poll sees "in transit".
    const p = api.storageSnapshot()['parcel:00340434161094042557'];
    await api.storage.set('parcel:00340434161094042557', { ...p, lastPolledAt: p.lastPolledAt - 30 * 60_000 });
    await hooks.onInterval({});
    const shown = api.calls('notifications.show');
    expect(shown).toHaveLength(1);
    expect(shown[0].args[0]).toEqual({
      title: 'Paket-Update: Unterwegs',
      body: 'DHL 00340434161094042557 · Your order has shipped · Now InTransit',
      tag: 'parcel-00340434161094042557',
    });
    // A poll right after is skipped (30 minutes per parcel).
    await hooks.onInterval({});
    expect(api.calls('proxy.fetch').filter((c) => c.args[1].endsWith('/gettrackinfo'))).toHaveLength(3);
  });

  it('stays quiet when notifications are off', async () => {
    const api = api17({ settings: { notify: false } });
    const { hooks } = load(api);
    await hooks.onNewEmailReceived({ ...SHIPPING });
    await hooks.onInterval({});
    for (const key of Object.keys(api.storageSnapshot())) {
      const p = api.storageSnapshot()[key];
      await api.storage.set(key, { ...p, lastPolledAt: 1 });
    }
    await hooks.onInterval({});
    expect(api.calls('notifications.show')).toHaveLength(0);
  });
});
