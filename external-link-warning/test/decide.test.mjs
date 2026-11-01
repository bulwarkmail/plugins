// Which checks run, what they say together, and the dialog that follows.
import { describe, expect, it, vi } from 'vitest';
import { plannedChecks, runChecks } from '../src/lib/lookup.js';
import { decide, dialogFor } from '../src/lib/decide.js';
import { domainInText, isTrusted, linkTextMismatch, normaliseHref, parseDomains } from '../src/lib/domains.js';
import { readConfig } from '../src/lib/config.js';
import { EN } from '../src/lib/strings.js';

const tr = (key, vars) => String(EN[key] ?? key).replace(/\{(\w+)\}/g, (m, k) => (vars && k in vars ? String(vars[k]) : m));
const cfg = (over = {}) => readConfig({ lookup: 'both', endpointUrl: 'https://check.corp.example/v1', ...over });
const HREF = 'https://login.evil.example/x';
const HOST = 'login.evil.example';

function services({ endpoint = { verdict: 'safe' }, google = { verdict: 'safe', threats: [] }, ready = { endpoint: true, google: true } } = {}) {
  const fn = (v) => vi.fn(async () => {
    if (v instanceof Error) throw v;
    if (v === 'hang') return new Promise(() => {});
    return v;
  });
  return { ready: vi.fn(async () => ready), endpoint: { check: fn(endpoint) }, google: { check: fn(google) } };
}

describe('plannedChecks', () => {
  it('follows the lookup mode and turns Google off in the no-third-party mode', () => {
    expect(plannedChecks({ lookup: 'off' }, {})).toEqual({ endpoint: false, google: false });
    expect(plannedChecks({ lookup: 'both' }, {})).toEqual({ endpoint: true, google: true });
    expect(plannedChecks({ lookup: 'both' }, { noThirdPartyTraffic: true })).toEqual({ endpoint: true, google: false });
    expect(plannedChecks({ lookup: 'safebrowsing' }, { noThirdPartyTraffic: true })).toEqual({ endpoint: false, google: false });
    expect(plannedChecks({ lookup: 'nonsense' }, {})).toEqual({ endpoint: false, google: false });
  });
});

describe('runChecks', () => {
  const run = (s, config = cfg(), features = {}, budgetMs) => runChecks({ href: HREF, host: HOST, config, features, services: s, budgetMs });

  it('is off without a planned check', async () => {
    const s = services();
    expect((await run(s, cfg({ lookup: 'off' }))).verdict).toBe('off');
    expect(s.endpoint.check).not.toHaveBeenCalled();
  });

  it('says unsafe when either check does', async () => {
    expect((await run(services({ google: { verdict: 'unsafe', threats: ['MALWARE'] } }))).verdict).toBe('unsafe');
    const both = await run(services({ endpoint: { verdict: 'unsafe', reason: 'kit' } }));
    expect(both.verdict).toBe('unsafe');
    expect(both.endpoint.reason).toBe('kit');
  });

  it('says failed when one check fails and none flags the link', async () => {
    expect((await run(services({ endpoint: new Error('down') }))).verdict).toBe('failed');
    expect((await run(services({ endpoint: new Error('down'), google: { verdict: 'unsafe', threats: ['MALWARE'] } }))).verdict).toBe('unsafe');
  });

  it('gives up after the budget', async () => {
    const result = await run(services({ endpoint: 'hang' }), cfg({ lookup: 'endpoint' }), {}, 50);
    expect(result.verdict).toBe('failed');
  });

  it('counts a check the admin didn\'t set up as failed', async () => {
    expect((await run(services({ ready: { endpoint: false, google: true } }), cfg({ lookup: 'endpoint' }))).verdict).toBe('failed');
    expect((await run(services(), cfg({ lookup: 'endpoint', endpointUrl: '' }))).verdict).toBe('failed');
  });

  it('never asks Google in the no-third-party mode, and that is no failure', async () => {
    const s = services({ google: new Error('refused') });
    const result = await run(s, cfg({ lookup: 'both' }), { noThirdPartyTraffic: true });
    expect(s.google.check).not.toHaveBeenCalled();
    expect(result.verdict).toBe('safe');
    expect((await run(services(), cfg({ lookup: 'safebrowsing' }), { noThirdPartyTraffic: true })).verdict).toBe('off');
  });
});

describe('decide', () => {
  const base = { host: HOST, text: undefined, trusted: false };

  it('opens a trusted link with nothing found, and warns for an untrusted one', () => {
    expect(decide({ ...base, trusted: true, check: { verdict: 'safe' }, config: cfg() })).toEqual({ kind: 'open' });
    expect(decide({ ...base, check: { verdict: 'safe' }, config: cfg() })).toMatchObject({ kind: 'warn', line: 'safe' });
    expect(decide({ ...base, check: { verdict: 'off' }, config: cfg() })).toMatchObject({ kind: 'warn', line: null });
  });

  it('follows the admin\'s choice when a link can\'t be checked', () => {
    expect(decide({ ...base, check: { verdict: 'failed' }, config: cfg() })).toMatchObject({ kind: 'warn', line: 'failed' });
    expect(decide({ ...base, trusted: true, check: { verdict: 'failed' }, config: cfg() })).toEqual({ kind: 'open' });
    expect(decide({ ...base, check: { verdict: 'failed' }, config: cfg({ onFailure: 'closed' }) }).kind).toBe('closed');
    expect(decide({ ...base, trusted: true, check: { verdict: 'failed' }, config: cfg({ onFailure: 'closed' }) }).kind).toBe('closed');
  });

  it('warns strongly for an unsafe verdict, even on a trusted domain, and blocks when the admin says so', () => {
    const check = { verdict: 'unsafe', endpoint: { verdict: 'unsafe', reason: 'kit' } };
    expect(decide({ ...base, trusted: true, check, config: cfg() })).toMatchObject({ kind: 'unsafe', block: false, reason: 'kit' });
    expect(decide({ ...base, check, config: cfg({ onUnsafe: 'block' }) })).toMatchObject({ kind: 'unsafe', block: true });
    const google = { verdict: 'unsafe', google: { verdict: 'unsafe', threats: ['SOCIAL_ENGINEERING'] } };
    expect(decide({ ...base, check: google, config: cfg() })).toMatchObject({ kind: 'google', threats: ['SOCIAL_ENGINEERING'] });
  });
});

describe('dialogFor', () => {
  const ctx = { host: HOST, href: HREF };

  it('always names the real target domain', () => {
    for (const decision of [
      { kind: 'warn', line: 'safe', mismatch: '' },
      { kind: 'warn', line: 'failed', mismatch: '' },
      { kind: 'unsafe', block: false, threats: [], mismatch: '' },
      { kind: 'unsafe', block: true, threats: [], mismatch: '' },
      { kind: 'closed', mismatch: '' },
    ]) {
      const dialog = dialogFor(decision, ctx, tr);
      expect(dialog.options.message).toContain(HOST);
      expect(dialog.options.message).toContain(HREF);
    }
    const google = dialogFor({ kind: 'google', block: false, threats: ['MALWARE'], mismatch: '' }, ctx, tr);
    expect(google.options.extraProps.paragraphs[0]).toContain(HOST);
  });

  it('says what the check found', () => {
    expect(dialogFor({ kind: 'warn', line: 'safe', mismatch: '' }, ctx, tr).options.message).toContain('no known threats');
    expect(dialogFor({ kind: 'warn', line: 'failed', mismatch: '' }, ctx, tr).options.message).toContain("Couldn't check this link");
  });

  it('offers only Close when fail closed or blocked', () => {
    expect(dialogFor({ kind: 'closed', mismatch: '' }, ctx, tr).type).toBe('alert');
    expect(dialogFor({ kind: 'unsafe', block: true, threats: [], mismatch: '' }, ctx, tr).type).toBe('alert');
    const blocked = dialogFor({ kind: 'google', block: true, threats: ['MALWARE'], mismatch: '' }, ctx, tr);
    expect(blocked.options.extraProps.buttons.map((b) => b.id)).toEqual(['close']);
  });

  it('shows Google\'s verdict hedged, with the advisory link', () => {
    const dialog = dialogFor({ kind: 'google', block: false, threats: ['SOCIAL_ENGINEERING'], mismatch: '' }, ctx, tr);
    expect(dialog.type).toBe('dialog');
    expect(dialog.options.slot).toBe('plugin-dialog');
    expect(dialog.options.extraProps.paragraphs.join(' ')).toMatch(/may be a phishing site/);
    expect(dialog.options.extraProps.advisory).toEqual({ label: 'Advisory provided by Google', url: 'https://developers.google.com/safe-browsing/v4/advisory' });
    expect(dialog.options.extraProps.buttons.map((b) => b.id)).toEqual(['cancel', 'open']);
  });

  it('points out link text that names another domain', () => {
    const decision = decide({ host: HOST, text: 'https://www.paypal.com/signin', trusted: false, check: { verdict: 'off' }, config: cfg() });
    expect(dialogFor(decision, ctx, tr).options.message).toContain('The link text says www.paypal.com, but the link goes to login.evil.example.');
  });
});

describe('link text', () => {
  it('finds a domain only in address-like text', () => {
    expect(domainInText('paypal.com')).toBe('paypal.com');
    expect(domainInText('https://paypal.com/login')).toBe('paypal.com');
    expect(domainInText('Click here')).toBe('');
    expect(domainInText('Read more about paypal.com')).toBe('');
    expect(domainInText(undefined)).toBe('');
  });

  it('takes file names for file names, not domains', () => {
    for (const name of ['report.pdf', 'invoice.docx', 'setup.exe', 'photo.jpg', 'Daten.zip']) expect(domainInText(name), name).toBe('');
    expect(linkTextMismatch('report.pdf', 'evil.example')).toBe('');
    // With a scheme or a path it is an address again.
    expect(domainInText('https://report.pdf/x')).toBe('report.pdf');
    expect(domainInText('files.example.com/report.pdf')).toBe('files.example.com');
    expect(domainInText('paypal.com')).toBe('paypal.com');
  });

  it('matches the target host and its parents', () => {
    expect(linkTextMismatch('paypal.com', 'www.paypal.com')).toBe('');
    expect(linkTextMismatch('www.paypal.com', 'paypal.com')).toBe('');
    expect(linkTextMismatch('paypal.com', 'paypal.com.evil.example')).toBe('paypal.com');
    expect(linkTextMismatch('Click here', 'evil.example')).toBe('');
  });
});

describe('trusted domains and addresses', () => {
  it('trusts an international domain in the form links have', () => {
    const list = parseDomains('bücher.example, https://Straße.example/path, *.corp.example');
    // Browsers keep ß (nontransitional IDNA), so links to Straße.example have this host too.
    expect(list).toEqual(['xn--bcher-kva.example', 'xn--strae-oqa.example', 'corp.example']);
    expect(isTrusted(new URL('https://www.bücher.example/').hostname, list)).toBe(true);
  });

  it('reads a link the way the browser opens it', () => {
    expect(normaliseHref('http://evil.example\\@good.example/login')).toBe('http://evil.example/@good.example/login');
    expect(normaliseHref('HTTPS://Bücher.Example/a b')).toBe('https://xn--bcher-kva.example/a%20b');
    expect(normaliseHref('mailto:a@b.test')).toBe('');
    expect(normaliseHref('/inbox')).toBe('');
  });
});
