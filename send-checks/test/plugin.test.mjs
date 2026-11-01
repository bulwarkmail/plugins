// The send hook and the upload hook, run from the built bundle the way the
// sandbox runs it, against the fake api.
import { beforeAll, describe, expect, it } from 'vitest';
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { fakeApi } from '../../test-utils/fake-api.mjs';
import { compileRules, evaluate, goesOutside } from '../src/lib/scan.js';
import { normaliseConfig, DEFAULTS } from '../src/lib/config.js';
import { dialogFor, FALLBACK } from '../src/lib/messages.js';
import { nodeWorker } from './node-worker.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const manifest = JSON.parse(readFileSync(path.join(here, '../manifest.json'), 'utf8'));
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
    if (name === 'react' || name === 'react/jsx-runtime' || name === 'react-dom') return require(name);
    throw new Error(`module ${name} is not available`);
  };
  new Function('module', 'exports', 'require', code)(mod, mod.exports, req);
  return mod.exports;
}

async function started(config = {}, { confirm = false, locale = 'en' } = {}) {
  const api = fakeApi({
    id: 'send-checks',
    locale,
    translations: manifest.locales,
    handlers: {
      'config.get': async () => config,
      'ui.confirm': async () => confirm,
      'ui.alert': async () => undefined,
    },
  });
  const plugin = load(api);
  await plugin.activate(api);
  return { api, plugin };
}

const IBAN = 'DE89 3704 0044 0532 0130 00';
const CARD = '4242 4242 4242 4242';

function mail(extra = {}) {
  return {
    to: ['Dave <dave@partner.test>'], cc: [], bcc: [],
    subject: 'Invoice', htmlBody: '', textBody: '', identityId: 'id1', attachments: [],
    externalRecipients: ['dave@partner.test'],
    ...extra,
  };
}

describe('the defaults', () => {
  it('are the manifest defaults', () => {
    for (const [key, value] of Object.entries(DEFAULTS)) {
      expect(manifest.configSchema[key]?.default, key).toEqual(value);
    }
    expect(Object.keys(manifest.configSchema).sort()).toEqual(Object.keys(DEFAULTS).sort());
  });

  it('every string has an English fallback and a German translation', () => {
    expect(Object.keys(manifest.locales.en).sort()).toEqual(Object.keys(FALLBACK).sort());
    expect(Object.keys(manifest.locales.de).sort()).toEqual(Object.keys(FALLBACK).sort());
    for (const [key, value] of Object.entries(FALLBACK)) expect(manifest.locales.en[key], key).toBe(value);
  });
});

describe('outside the organisation', () => {
  it('follows the host list, and counts every recipient on a host without one', () => {
    expect(goesOutside(mail())).toBe(true);
    expect(goesOutside(mail({ externalRecipients: [] }))).toBe(false);
    expect(goesOutside(mail({ externalRecipients: undefined }))).toBe(true);
    expect(goesOutside(mail({ externalRecipients: undefined, to: [] }))).toBe(false);
  });

  it('skips an outside-only rule for internal recipients and runs the others', async () => {
    const rules = compileRules(normaliseConfig({ keywords: 'confidential', keywordExternalOnly: false }));
    const internal = mail({ externalRecipients: [], authoredText: `Pay ${IBAN}, card ${CARD}. Confidential.` });
    expect((await evaluate(internal, rules)).found.map((f) => f.rule)).toEqual(['keyword']);
    const external = mail({ authoredText: `Pay ${IBAN}, card ${CARD}. Confidential.` });
    expect((await evaluate(external, rules)).found.map((f) => f.rule)).toEqual(['iban', 'card', 'keyword']);
  });
});

describe('what is scanned', () => {
  const rules = compileRules(normaliseConfig({ keywords: 'falcon' }));

  it('the subject, the authored text, attachment names and text excerpts, not the quoted original', async () => {
    const quoted = mail({
      subject: 'Re: falcon',
      authoredText: 'Thanks!',
      textBody: `Thanks!\n\n> Pay to ${IBAN}`,
      attachments: [
        { name: `${IBAN.replace(/ /g, '')}.pdf`, type: 'application/pdf', size: 10 },
        { name: 'list.csv', type: 'text/csv', size: 10, textExcerpt: `card;${CARD}` },
        { name: 'photo.jpg', type: 'image/jpeg', size: 10, textExcerpt: 'falcon' },
      ],
    });
    const found = (await evaluate(quoted, rules)).found;
    expect(found.map((f) => [f.rule, f.where])).toEqual([
      ['keyword', null],
      ['iban', null],
      ['card', 'list.csv'],
    ]);
  });

  it('falls back to the text body on a host without authoredText', async () => {
    expect((await evaluate(mail({ textBody: `Pay ${IBAN}` }), rules)).found.map((f) => f.rule)).toEqual(['iban']);
  });
});

describe('onBeforeEmailSend', () => {
  it('lets a message with nothing to report through without asking', async () => {
    const { api, plugin } = await started();
    expect(await plugin.hooks.onBeforeEmailSend(mail({ authoredText: 'Hello' }))).toBeUndefined();
    expect(api.calls('ui.confirm')).toHaveLength(0);
    expect(api.calls('ui.alert')).toHaveLength(0);
  });

  it('asks for a warning and stops when the user goes back', async () => {
    const { api, plugin } = await started({}, { confirm: false });
    expect(await plugin.hooks.onBeforeEmailSend(mail({ authoredText: `Pay to ${IBAN}` }))).toBe(false);
    const [{ args: [dialog] }] = api.calls('ui.confirm');
    expect(dialog.title).toBe('Check before sending');
    expect(dialog.message).toContain('• IBAN DE89 … 3000');
    expect(dialog.message).not.toContain('0532');
    expect(dialog.message).toContain('goes outside your organisation');
    expect(dialog.confirmLabel).toBe('Send anyway');
    expect(dialog.danger).toBe(true);
    expect(api.calls('toast.info')).toHaveLength(1);
  });

  it('sends when the user confirms the warning', async () => {
    const { api, plugin } = await started({}, { confirm: true });
    expect(await plugin.hooks.onBeforeEmailSend(mail({ authoredText: `Card ${CARD}` }))).toBeUndefined();
    expect(api.calls('ui.confirm')[0].args[0].message).toContain('• Card number ending 4242');
    expect(api.calls('ui.confirm')[0].args[0].message).not.toContain('4242 4242');
  });

  it('blocks with an alert, listing the warnings too, without offering to send', async () => {
    const { api, plugin } = await started({ cardAction: 'block' }, { confirm: true });
    expect(await plugin.hooks.onBeforeEmailSend(mail({ authoredText: `Card ${CARD}, IBAN ${IBAN}` }))).toBe(false);
    expect(api.calls('ui.confirm')).toHaveLength(0);
    const [{ args: [dialog] }] = api.calls('ui.alert');
    expect(dialog.title).toBe("This message can't be sent");
    expect(dialog.message).toContain('• Card number ending 4242');
    expect(dialog.message).toContain('Also check:\n\n• IBAN DE89 … 3000');
  });

  it('blocks a disallowed attachment type at send', async () => {
    const { api, plugin } = await started({ blockedTypes: 'exe' });
    const email = mail({ attachments: [{ name: 'report.pdf', type: 'application/pdf', size: 100, sniffedType: 'application/x-msdownload' }] });
    expect(await plugin.hooks.onBeforeEmailSend(email)).toBe(false);
    expect(api.calls('ui.alert')[0].args[0].message).toContain('• report.pdf: file type not allowed (application/x-msdownload)');
  });

  it('runs an outside-only rule on a host that sends no externalRecipients', async () => {
    const { plugin } = await started();
    expect(await plugin.hooks.onBeforeEmailSend(mail({ externalRecipients: undefined, authoredText: IBAN }))).toBe(false);
  });

  it('leaves internal mail alone for the default outside-only rules', async () => {
    const { api, plugin } = await started();
    expect(await plugin.hooks.onBeforeEmailSend(mail({ externalRecipients: [], authoredText: `${IBAN} ${CARD}` }))).toBeUndefined();
    expect(api.calls('ui.confirm')).toHaveLength(0);
  });

  it('keeps the last rules when the settings can no longer be read', async () => {
    let fail = false;
    const api = fakeApi({
      id: 'send-checks',
      handlers: {
        'config.get': async () => { if (fail) throw new Error('offline'); return { keywordAction: 'block', keywords: 'falcon' }; },
        'ui.alert': async () => undefined,
      },
    });
    const plugin = load(api);
    await plugin.activate(api);
    fail = true;
    expect(await plugin.hooks.onBeforeEmailSend(mail({ externalRecipients: [], authoredText: 'falcon' }))).toBe(false);
  });

  it('speaks German with the German locale', async () => {
    const { api, plugin } = await started({}, { locale: 'de' });
    await plugin.hooks.onBeforeEmailSend(mail({ authoredText: `Karte ${CARD}` }));
    const [{ args: [dialog] }] = api.calls('ui.confirm');
    expect(dialog.title).toBe('Vor dem Senden prüfen');
    expect(dialog.message).toContain('Kartennummer mit Endziffern 4242');
  });
});

describe('onBeforeAttachmentUpload', () => {
  it('refuses a blocked type and a file over the limit right away', async () => {
    const { api, plugin } = await started({ blockedTypes: 'exe', maxSizeMb: 1 });
    expect(await plugin.hooks.onBeforeAttachmentUpload({ name: 'setup.exe', type: 'application/octet-stream', size: 10 })).toBe(false);
    expect(await plugin.hooks.onBeforeAttachmentUpload({ name: 'a.pdf', type: 'application/pdf', size: 2 * 1024 * 1024 })).toBe(false);
    expect(await plugin.hooks.onBeforeAttachmentUpload({ name: 'a.pdf', type: 'application/pdf', size: 10 })).toBeUndefined();
    expect(api.calls('ui.alert').map((c) => c.args[0].message)).toEqual([
      "Your organisation doesn't allow attaching setup.exe (exe).",
      'a.pdf is larger than 1 MB, the most your organisation allows.',
    ]);
  });

  it('leaves it to Send when the rule warns or counts only outside', async () => {
    for (const config of [{ blockedTypes: 'exe', attachmentAction: 'warn' }, { blockedTypes: 'exe', attachmentExternalOnly: true }]) {
      const { plugin } = await started(config);
      expect(await plugin.hooks.onBeforeAttachmentUpload({ name: 'setup.exe', size: 10 })).toBeUndefined();
    }
  });
});

describe('the dialog', () => {
  it('lists at most ten matches and counts the rest', () => {
    const tr = (key, vars) => String(FALLBACK[key]).replace(/\{(\w+)\}/g, (m, k) => (vars && k in vars ? String(vars[k]) : m));
    const found = Array.from({ length: 12 }, (_, i) => ({ rule: 'keyword', action: 'warn', keyword: `k${i}` }));
    const dialog = dialogFor(found, tr);
    expect(dialog.message.split('\n').filter((l) => l.startsWith('• '))).toHaveLength(10);
    expect(dialog.message).toContain('and 2 more');
  });
});

// Review findings 4, 8 and 15: a check that couldn't finish stops a
// blocking rule's send (fail closed) and is named in a warning.
describe('when a check can not finish', () => {
  function withWorker(fn) {
    const before = globalThis.Worker;
    globalThis.Worker = function FakeWorker() { return nodeWorker(); };
    return Promise.resolve(fn()).finally(() => { globalThis.Worker = before; });
  }

  it('runs the patterns in a Worker and finds a match', async () => {
    await withWorker(async () => {
      const { api, plugin } = await started({ patterns: String.raw`Customer number: KD-\d{6}`, patternAction: 'block' });
      expect(await plugin.hooks.onBeforeEmailSend(mail({ authoredText: 'Ref KD-123456' }))).toBe(false);
      const [{ args: [dialog] }] = api.calls('ui.alert');
      expect(dialog.title).toBe("This message can't be sent");
      expect(dialog.message).toContain('• Customer number: KD…56');
    });
  });

  it('stops the send when a blocking pattern rule could not run (no Worker)', async () => {
    const { api, plugin } = await started({ patterns: String.raw`Customer number: KD-\d{6}`, patternAction: 'block' });
    expect(await plugin.hooks.onBeforeEmailSend(mail({ authoredText: 'Nothing here' }))).toBe(false);
    const [{ args: [dialog] }] = api.calls('ui.alert');
    expect(dialog.title).toBe("This message couldn't be checked");
    expect(dialog.message).toContain("• Your organisation's patterns couldn't be checked in time");
  });

  it('asks when a warning pattern rule could not run', async () => {
    const { api, plugin } = await started({ patterns: String.raw`KD-\d{6}`, patternAction: 'warn' }, { confirm: true });
    expect(await plugin.hooks.onBeforeEmailSend(mail({ authoredText: 'Nothing here' }))).toBeUndefined();
    const [{ args: [dialog] }] = api.calls('ui.confirm');
    expect(dialog.title).toBe('Check before sending');
    expect(dialog.message).toContain("Some of your organisation's checks couldn't finish:");
  });

  it('names a pattern line that can not run, and a blocking one stops the send', async () => {
    await withWorker(async () => {
      const { api, plugin } = await started({ patterns: String.raw`Slow: (a+)+$` + '\n' + String.raw`Good: KD-\d{6}`, patternAction: 'block' });
      expect(await plugin.hooks.onBeforeEmailSend(mail({ authoredText: 'Nothing here' }))).toBe(false);
      expect(api.calls('ui.alert')[0].args[0].message).toContain('• The pattern “Slow” is set up wrongly. Ask your administrator to fix it.');
    });
  });

  it('stops the send when a file the host could not read may break a blocking type rule', async () => {
    const { api, plugin } = await started({ blockedTypes: 'exe' });
    const email = mail({ externalRecipients: [], attachments: [{ name: 'invoice.pdf', type: 'application/pdf', size: 10, unreadable: true }] });
    expect(await plugin.hooks.onBeforeEmailSend(email)).toBe(false);
    expect(api.calls('ui.alert')[0].args[0].message).toContain("• invoice.pdf couldn't be read");
    // Without type rules nothing about the file is unknown that matters.
    const relaxed = await started({});
    expect(await relaxed.plugin.hooks.onBeforeEmailSend(email)).toBeUndefined();
  });

  it('refuses at upload a file the host could not read when a blocking type rule is set', async () => {
    const { api, plugin } = await started({ blockedTypes: 'exe' });
    expect(await plugin.hooks.onBeforeAttachmentUpload({ name: 'x.pdf', size: 10, unreadable: true })).toBe(false);
    expect(api.calls('ui.alert')[0].args[0].message).toBe("x.pdf couldn't be checked, so it can't be attached. Try again in a moment.");
  });

  it('sends nothing when the settings were never read, instead of using the defaults', async () => {
    const api = fakeApi({
      id: 'send-checks',
      handlers: { 'config.get': async () => { throw new Error('offline'); }, 'ui.alert': async () => undefined },
    });
    const plugin = load(api);
    await plugin.activate(api);
    expect(await plugin.hooks.onBeforeEmailSend(mail({ authoredText: 'Hello' }))).toBe(false);
    expect(api.calls('ui.alert')[0].args[0]).toEqual({
      title: "This message couldn't be checked",
      message: "Your organisation's send checks couldn't load their settings, so the message wasn't sent. Try again in a moment.",
    });
  });
});
