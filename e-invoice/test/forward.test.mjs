// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { fakeApi } from '../../test-utils/fake-api.mjs';
import { parseInvoice } from '../src/lib/parse.js';
import { ADDRESS_KEY, forwardToAccounting, forwardedInfo, resolveAddress } from '../src/lib/forward.js';
import { fixture, manifest } from './helpers.mjs';

const invoice = parseInvoice(fixture('xrechnung-ubl.xml'));
const email = { id: 'm1', subject: 'Rechnung RE-2026-117' };
const source = { blobId: 'x1', name: 'RE-2026-117.xml', kind: 'xml' };

function api({ settings = {}, config = {}, forward = async () => ({ sent: true, emailId: 's1', to: ['books@example.com'] }), prompt } = {}) {
  return fakeApi({
    settings: { forwardWhat: 'forward.all', ...settings },
    translations: manifest.locales,
    handlers: {
      'config.get': async () => config,
      'email.forward': forward,
      ...(prompt ? { 'ui.prompt': prompt } : {}),
    },
  });
}

describe('resolveAddress', () => {
  it('takes the admin address for everyone, else the user’s, else the admin’s, else the one typed', () => {
    expect(resolveAddress({ config: { accountingAddress: 'a@x.example', lockAddress: true }, settings: { accountingAddress: 'u@x.example' } })).toBe('a@x.example');
    expect(resolveAddress({ config: { accountingAddress: 'a@x.example' }, settings: { accountingAddress: 'u@x.example' } })).toBe('u@x.example');
    expect(resolveAddress({ config: { accountingAddress: 'a@x.example' }, settings: { accountingAddress: '' } })).toBe('a@x.example');
    expect(resolveAddress({ remembered: 'r@x.example', settings: { accountingAddress: 'not an address' } })).toBe('r@x.example');
    expect(resolveAddress({})).toBe('');
  });
});

describe('forwardToAccounting', () => {
  it('forwards the message with a note for the bookkeeper and remembers it', async () => {
    const a = api({ settings: { accountingAddress: 'books@example.com' } });
    expect(await forwardToAccounting(a, { email: { ...email, accountId: 'team' }, invoice, source })).toBe('sent');
    const [[id, input]] = a.calls('email.forward').map((c) => c.args);
    expect(id).toBe('m1');
    expect(input).toEqual({
      to: ['books@example.com'],
      text: expect.stringMatching(/^For accounting: Invoice RE-2026-117 from Musterlieferant GmbH, €846\.00, due /),
      accountId: 'team',
    });
    expect(input.text).toContain('Buyer reference: 04011000-12345-34');
    expect(input.text).toContain('Order number: PO-4711');
    expect(await forwardedInfo(a.storage, { ...email, accountId: 'team' })).toEqual({ to: 'books@example.com', at: expect.any(String) });
    expect(await forwardedInfo(a.storage, email)).toBeNull();
  });

  it('sends only the invoice file when the user chose that', async () => {
    const a = api({ settings: { accountingAddress: 'books@example.com', forwardWhat: 'forward.invoice_only' } });
    await forwardToAccounting(a, { email, invoice, source });
    expect(a.calls('email.forward')[0].args[1].attachments).toEqual(['x1']);
  });

  it('asks for the address once and keeps the answer', async () => {
    const prompt = vi.fn()
      .mockResolvedValueOnce({ address: 'nope' })
      .mockResolvedValueOnce({ address: ' books@example.com ' });
    const a = api({ prompt });
    expect(await forwardToAccounting(a, { email, invoice, source })).toBe('sent');
    expect(prompt).toHaveBeenCalledTimes(2);
    expect(await a.storage.get(ADDRESS_KEY)).toBe('books@example.com');
    expect(a.calls('email.forward')[0].args[1].to).toEqual(['books@example.com']);
    await forwardToAccounting(a, { email, invoice, source });
    expect(prompt).toHaveBeenCalledTimes(2);
  });

  it('does nothing when the user cancels the question or declines the address', async () => {
    const cancelled = api({ prompt: async () => null });
    expect(await forwardToAccounting(cancelled, { email, invoice, source })).toBe('no-address');
    expect(cancelled.calls('email.forward')).toEqual([]);

    const declined = api({ settings: { accountingAddress: 'books@example.com' }, forward: async () => ({ sent: false, reason: 'declined' }) });
    expect(await forwardToAccounting(declined, { email, invoice, source })).toBe('declined');
    expect(await forwardedInfo(declined.storage, email)).toBeNull();
  });

  it('never asks for an address when forwarding on its own', async () => {
    const prompt = vi.fn();
    const a = api({ prompt });
    expect(await forwardToAccounting(a, { email, invoice, source, quiet: true })).toBe('no-address');
    expect(prompt).not.toHaveBeenCalled();
  });

  it('reports a failed send', async () => {
    const a = api({ settings: { accountingAddress: 'books@example.com' }, forward: async () => { throw new Error('quota exceeded'); } });
    expect(await forwardToAccounting(a, { email, invoice, source })).toBe('failed');
    expect(a.calls('toast.error')[0].args[0]).toBe('The invoice could not be forwarded: quota exceeded');
  });
});
