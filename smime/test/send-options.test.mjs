// The raw send that completes a takeover hands the host's labelToken back,
// so Bulwark can tell two S/MIME sends at once from one address apart.
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { rawSendOptions } from '../src/send-options.js';

const src = path.join(path.dirname(fileURLToPath(import.meta.url)), '../src');

describe('rawSendOptions', () => {
  it('passes the label token, the schedule and every recipient once', () => {
    expect(rawSendOptions({ labelToken: 'tok-1', delayedUntil: '2026-11-02T08:00:00Z' }, ['a@x.test', 'b@x.test', 'a@x.test']))
      .toEqual({ envelopeRecipients: ['a@x.test', 'b@x.test'], delayedUntil: '2026-11-02T08:00:00Z', labelToken: 'tok-1' });
  });

  it('leaves out what the request doesn\'t have (older hosts send no token)', () => {
    expect(rawSendOptions({}, ['a@x.test'])).toEqual({ envelopeRecipients: ['a@x.test'] });
    expect(rawSendOptions({ labelToken: '' }, [])).toEqual({ envelopeRecipients: [] });
  });
});

describe('every raw send in the plugin', () => {
  it('goes through rawSendOptions(req, ...)', () => {
    const calls = [];
    for (const file of readdirSync(src).filter((f) => f.endsWith('.js'))) {
      const text = readFileSync(path.join(src, file), 'utf8');
      for (const match of text.matchAll(/jmap\.(sendRaw|submitRaw)\(([^;]*)\);/g)) calls.push({ file, args: match[2] });
    }
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) expect(call.args, call.file).toMatch(/rawSendOptions\(req,/);
  });
});
