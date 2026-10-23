// @vitest-environment jsdom
// The slots of the built bundle, on the UI kit stand-in: the reader's info
// bars, the deliveries section's rows and its dialogs.
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import * as React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { fakeApi, proxyResponse } from '../../test-utils/fake-api.mjs';
import * as kit from '../../test-utils/ui-kit.mjs';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
afterEach(cleanup);

// jsdom gives import.meta.url an http scheme; tests run from the repo root.
const DIR = path.join(process.cwd(), 'parcels');
const manifest = JSON.parse(readFileSync(path.join(DIR, 'manifest.json'), 'utf8'));
let code;

// esbuild doesn't run under jsdom; bundle in a plain node process.
beforeAll(() => {
  const script = `require('esbuild').build(${JSON.stringify({
    entryPoints: [path.join(DIR, 'src/index.js')],
    bundle: true, format: 'cjs', platform: 'browser', target: 'es2020', write: false, logLevel: 'silent',
    external: ['react', 'react-dom', 'react/jsx-runtime', '@plugin-host', '@plugin-host/ui'],
  })}).then((o) => process.stdout.write(o.outputFiles[0].text))`;
  code = execFileSync(process.execPath, ['-e', script], { cwd: process.cwd(), encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
});

function load(api) {
  const mod = { exports: {} };
  const known = { react: React, '@plugin-host': api, '@plugin-host/ui': kit };
  const req = (name) => {
    if (name in known) return known[name];
    throw new Error(`module ${name} is not available`);
  };
  new Function('module', 'exports', 'require', code)(mod, mod.exports, req);
  return mod.exports.default ?? mod.exports;
}

const SHIPPING = {
  id: 'm-ship', subject: 'Your order has shipped', from: [{ name: 'Shop', email: 'orders@shop.example' }],
  text: 'Your parcel is on its way.\n\nDHL tracking number: 00340434161094042557\nUPS: 1Z999AA10123456784\n',
  source: '',
};

/** 17TRACK answering "in transit" for every number; DHL not set up. */
function makeApi({ settings = {}, locale = 'en', openDialog } = {}) {
  return fakeApi({
    id: 'parcels', settings, locale, translations: manifest.locales,
    handlers: {
      'config.get': async () => ({ track17Url: 'http://localhost:18099/17track/track/v2.2' }),
      'ui.openDialog': openDialog ?? (async () => null),
      'proxy.fetch': async (credentialId, url, init) => {
        if (credentialId === 'dhl') return { status: 404, ok: false, headers: {}, body: '', proxyError: 'no_credential' };
        const numbers = JSON.parse(init.body).map((x) => x.number);
        if (url.endsWith('/register')) return proxyResponse({ code: 0, data: { accepted: numbers.map((number) => ({ number })), rejected: [] } });
        return proxyResponse({ code: 0, data: { accepted: numbers.map((number) => ({ number, track_info: { latest_status: { status: 'InTransit' }, latest_event: { description: 'Sorted', location: 'Hannover, DE', time_iso: '2026-10-12T07:55:00+02:00' } } })), rejected: [] } });
      },
    },
  });
}

const parcel = (number, extra = {}) => ({
  number, carrier: 'dhl', carrierName: 'DHL', trackingUrl: `https://track.example/${number}`, emailId: null, subject: '',
  addedAt: Date.now(), status: null, text: '', location: '', time: '', eta: null, events: [], lastPolledAt: 0, lastChangeAt: Date.now(),
  received: false, stopped: false, error: null, ...extra,
});

async function show(element) {
  await act(async () => { render(element); });
}

describe('section title', () => {
  it('is set to the translated "Deliveries" on start and again when the language changes', async () => {
    vi.useFakeTimers();
    try {
      const api = makeApi({ locale: 'de' });
      load(api).activate();
      await vi.advanceTimersByTimeAsync(0);
      expect(api.calls('ui.setSectionTitle').map((c) => c.args)).toEqual([['Lieferungen']]);
      api.setLocale('fr');
      await vi.advanceTimersByTimeAsync(0);
      expect(api.calls('ui.setSectionTitle').map((c) => c.args)).toEqual([['Lieferungen'], ['Livraisons']]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('reader card', () => {
  it('shows one info bar per parcel with carrier, status and the bar buttons', async () => {
    const api = makeApi();
    const { component: Card } = load(api).slots['email-banner'];
    await show(React.createElement(Card, { email: SHIPPING }));
    const bars = await screen.findAllByText('In transit');
    expect(bars).toHaveLength(2);
    const ups = document.querySelector('[data-parcel="1Z999AA10123456784"]');
    expect(ups.querySelector('.bk-infobar').textContent).toMatch(/^UPS/);
    expect(within(ups).getByText('In transit').getAttribute('data-status')).toBe('in_transit');
    expect(within(ups).getByText(/Sorted · Hannover, DE/)).toBeTruthy();
    for (const name of ['Track at UPS', 'Refresh', 'Mark received']) expect(within(ups).getByRole('button', { name })).toBeTruthy();
    // No hand-made styles left in the frame.
    expect(document.querySelector('style')).toBeNull();
  });

  it('turns "Mark received" into a pressed "Received" that follows the parcel again', async () => {
    const api = makeApi({ settings: { autoLookup: false } });
    const { component: Card } = load(api).slots['email-banner'];
    await show(React.createElement(Card, { email: SHIPPING }));
    const ups = await waitFor(() => {
      const el = document.querySelector('[data-parcel="1Z999AA10123456784"]');
      if (!el) throw new Error('not yet');
      return el;
    });
    // No status yet: the line is the number and the button asks for it.
    expect(within(ups).getByRole('button', { name: 'Show status' })).toBeTruthy();
    await act(async () => { fireEvent.click(within(ups).getByRole('button', { name: 'Mark received' })); });
    const pressed = await within(ups).findByRole('button', { name: 'Received' });
    expect(pressed.getAttribute('aria-pressed')).toBe('true');
    expect(api.storageSnapshot()['parcel:1Z999AA10123456784'].received).toBe(true);
    await act(async () => { fireEvent.click(pressed); });
    await within(ups).findByRole('button', { name: 'Mark received' });
    expect(api.storageSnapshot()['parcel:1Z999AA10123456784'].received).toBe(false);
  });

  it('says why there is no status, as a status line', async () => {
    const api = makeApi({ settings: { autoLookup: false } });
    await api.storage.set('parcel:1Z999AA10123456784', parcel('1Z999AA10123456784', { carrier: 'ups', carrierName: 'UPS', error: 'auth' }));
    const { component: Card } = load(api).slots['email-banner'];
    await show(React.createElement(Card, { email: { ...SHIPPING, text: 'UPS: 1Z999AA10123456784' } }));
    expect((await screen.findByRole('status')).textContent).toBe("The tracking service didn't accept the API key. Ask your administrator to check it.");
  });
});

describe('delivery heading actions', () => {
  it('shows refresh and most recent tracking time in the inline slot', async () => {
    const api = makeApi();
    await api.storage.set('parcel:1Z999AA10123456784', parcel('1Z999AA10123456784',
      { carrier: 'ups', lastPolledAt: Date.parse('2026-10-21T19:10:00Z') }));
    const Header = load(api).slots['sidebar-section-actions'].component;
    await show(React.createElement(Header));
    const button = await screen.findByRole('button', { name: 'Refresh' });
    expect(button).toBeTruthy();
    expect(screen.getByText(/\d{1,2}:\d\d/)).toBeTruthy();
  });
});

describe('deliveries section', () => {
  it('says when nothing is on the way, and offers "Add tracking number" as a row', async () => {
    const api = makeApi();
    const { component: Section } = load(api).slots['sidebar-section'];
    await show(React.createElement(Section));
    expect(await screen.findByText('No parcels on the way.')).toBeTruthy();
    const buttons = screen.getAllByRole('button');
    expect(buttons.map((b) => b.textContent)).toEqual(['Add tracking number']);
    // No own heading: the host draws the section header.
    expect(document.querySelector('h1, h2, h3, h4')).toBeNull();
  });

  it('lists parcels as rows with a short status, and opens one in a dialog', async () => {
    const openDialog = vi.fn(async () => null);
    const api = makeApi({ openDialog });
    await api.storage.set('parcel:00340434161094042557', parcel('00340434161094042557', { subject: 'Your order has shipped', status: 'out_for_delivery' }));
    await api.storage.set('parcel:JJD000390007878901234', parcel('JJD000390007878901234', { error: 'timeout' }));
    const { component: Section } = load(api).slots['sidebar-section'];
    await show(React.createElement(Section));
    const row = await screen.findByRole('button', { name: /Your order has shipped/ });
    expect(row.textContent).toBe('Your order has shippedOut for delivery');
    expect(screen.getByRole('button', { name: /DHL JJD000390007878901234/ }).textContent).toBe('DHL JJD000390007878901234No status');
    expect(screen.queryByText('No parcels on the way.')).toBeNull();
    await act(async () => { fireEvent.click(row); });
    expect(openDialog).toHaveBeenCalledWith({
      title: 'Your order has shipped', slot: 'plugin-dialog', extraProps: { mode: 'parcel', number: '00340434161094042557' }, width: 440,
    });
  });

  it('puts the carrier in front when parcels share the subject of their mail', async () => {
    const api = makeApi();
    await api.storage.set('parcel:00340434161094042557', parcel('00340434161094042557', { subject: 'Your order has shipped', status: 'in_transit' }));
    await api.storage.set('parcel:1Z999AA10123456784', parcel('1Z999AA10123456784', { carrier: 'ups', carrierName: 'UPS', subject: 'Your order has shipped', status: 'delivered', lastChangeAt: Date.now() - 1000 }));
    await api.storage.set('parcel:JJD000390007878901234', parcel('JJD000390007878901234', { subject: 'Ihre DHL Sendung', status: 'in_transit' }));
    const { component: Section } = load(api).slots['sidebar-section'];
    await show(React.createElement(Section));
    await screen.findByRole('button', { name: /^DHL · Your order has shipped/ });
    expect(screen.getByRole('button', { name: /^UPS · Your order has shipped/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /^Ihre DHL Sendung/ })).toBeTruthy();
  });

  it('adds a number through the dialog and looks it up right away', async () => {
    const openDialog = vi.fn();
    const api = makeApi({ openDialog });
    const plugin = load(api);
    let resolve;
    openDialog.mockImplementation(() => new Promise((r) => { resolve = r; }));
    const { component: Section } = plugin.slots['sidebar-section'];
    await show(React.createElement(Section));
    await act(async () => { fireEvent.click(await screen.findByRole('button', { name: 'Add tracking number' })); });
    expect(openDialog.mock.calls[0][0]).toMatchObject({ title: 'Add tracking number', slot: 'plugin-dialog', extraProps: { mode: 'add' } });
    // The dialog (its own frame in the app) saves the number and resolves with it.
    const Dialog = plugin.slots['plugin-dialog'].component;
    const onResult = vi.fn();
    const dialog = render(React.createElement(Dialog, { mode: 'add', onResult }));
    fireEvent.change(dialog.getByLabelText('Tracking number'), { target: { value: '1Z999AA10123456784' } });
    await act(async () => { fireEvent.click(dialog.getByRole('button', { name: 'Add' })); });
    expect(onResult).toHaveBeenCalledWith({ added: '1Z999AA10123456784' });
    dialog.unmount();
    expect(api.calls('proxy.fetch')).toHaveLength(0);
    await act(async () => { resolve(onResult.mock.calls[0][0]); });
    await waitFor(() => expect(api.storageSnapshot()['parcel:1Z999AA10123456784']?.status).toBe('in_transit'));
    await screen.findByRole('button', { name: /UPS 1Z999AA10123456784/ });
  });
});

describe('dialogs', () => {
  it('add: Cancel then a primary Add in the host footer, Add disabled until there is a number', async () => {
    const api = makeApi();
    const Dialog = load(api).slots['plugin-dialog'].component;
    const setDialogButtons = vi.fn();
    const onResult = vi.fn();
    await show(React.createElement(kit.SlotPropsContext.Provider, { value: { setDialogButtons } },
      React.createElement(Dialog, { mode: 'add', onResult })));
    expect(setDialogButtons).toHaveBeenLastCalledWith([
      { id: 'cancel', label: 'Cancel', variant: 'secondary' },
      { id: 'add', label: 'Add', variant: 'primary', busy: false, disabled: true },
    ]);
    // Nothing drawn at the bottom of the body.
    expect(screen.queryByRole('button')).toBeNull();
    fireEvent.change(screen.getByLabelText('Tracking number'), { target: { value: '12' } });
    expect(setDialogButtons.mock.lastCall[0][1].disabled).toBe(false);
    // Enter submits; a number that isn't one is explained under the field.
    await act(async () => { fireEvent.keyDown(screen.getByLabelText('Tracking number'), { key: 'Enter' }); });
    expect(screen.getByRole('alert').textContent).toBe("That doesn't look like a tracking number.");
    expect(onResult).not.toHaveBeenCalled();
    expect(api.storageSnapshot()).toEqual({});
  });

  it('add: Cancel closes without saving', async () => {
    const api = makeApi();
    const Dialog = load(api).slots['plugin-dialog'].component;
    const onResult = vi.fn();
    await show(React.createElement(Dialog, { mode: 'add', onResult }));
    fireEvent.change(screen.getByLabelText('Tracking number'), { target: { value: '1Z999AA10123456784' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Cancel' })); });
    expect(onResult).toHaveBeenCalledWith(null);
    expect(api.storageSnapshot()).toEqual({});
  });

  it('parcel: says Track online when the carrier is unknown', async () => {
    const api = makeApi();
    await api.storage.set('parcel:5571562836', parcel('5571562836', { carrier: 'other', carrierName: '' }));
    const Dialog = load(api).slots['plugin-dialog'].component;
    await show(React.createElement(Dialog, { mode: 'parcel', number: '5571562836', onResult: vi.fn() }));
    await screen.findByText('Waiting for the first update');
    expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual(['Mark received', 'Track online']);
  });

  it('parcel: shows the status and puts Mark received and Track in the footer', async () => {
    const api = makeApi();
    await api.storage.set('parcel:00340434161094042557', parcel('00340434161094042557', { subject: 'Your order has shipped', status: 'in_transit', text: 'Sorted', location: 'Hannover, DE', error: 'rate_limit' }));
    const Dialog = load(api).slots['plugin-dialog'].component;
    const onResult = vi.fn();
    await show(React.createElement(Dialog, { mode: 'parcel', number: '00340434161094042557', onResult }));
    expect((await screen.findByText('In transit')).closest('[data-status]').getAttribute('data-status')).toBe('in_transit');
    expect(screen.getByText('DHL 00340434161094042557')).toBeTruthy();
    expect(screen.getByRole('status').textContent).toMatch(/busy/);
    expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual(['Mark received', 'Track at DHL']);
    expect(screen.getAllByRole('button').map((b) => b.getAttribute('data-variant'))).toEqual(['secondary', 'primary']);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Track at DHL' })); });
    expect(api.calls('ui.openExternalUrl')[0].args).toEqual(['https://track.example/00340434161094042557']);
    expect(onResult).not.toHaveBeenCalled();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Mark received' })); });
    expect(api.storageSnapshot()['parcel:00340434161094042557'].received).toBe(true);
    expect(onResult).toHaveBeenCalledWith({ received: '00340434161094042557' });
  });
});
