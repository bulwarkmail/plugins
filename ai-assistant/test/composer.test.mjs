import { describe, it, expect } from 'vitest';
import { fakeApi } from '../../test-utils/fake-api.mjs';
import { createBackground, DRAFT_KEY, COMPOSER_SURFACE, COMPOSER_MENU_SURFACE, READER_MENU_SURFACE, READER_SURFACE, COMPOSER_CONTEXT_KEY, chatKey, pendingKey } from '../src/lib/background.js';
import { ownText } from '../src/lib/draft.js';
import { appBlock, buildPrompt, clip, contextSuffix, composerChatSystem, readerChatSystem, REWRITE_STYLES } from '../src/lib/prompts.js';
import { defaultTarget, languageOptions } from '../src/lib/languages.js';
import plugin from '../src/index.js';
import manifest from '../manifest.json' with { type: 'json' };
import { allStrings } from '../src/lib/i18n.js';

const configured = { 'admin.getAllConfig': async () => ({ openaiBaseUrl: 'http://localhost:11434/v1' }) };

describe('ownText', () => {
  it('drops the quoted message of a reply and its "wrote:" line', () => {
    const text = 'Hi Bob,\n\nsounds good.\n\nOn Tue, 13 Oct 2026, Bob <bob@example.org> wrote:\n> Can we meet?\n> Bob';
    expect(ownText(text)).toBe('Hi Bob,\n\nsounds good.');
  });

  it('drops the signature and a forwarded message', () => {
    expect(ownText('Thanks!\n-- \nAlice\nACME')).toBe('Thanks!');
    expect(ownText('FYI\n\n---------- Forwarded message ---------\nFrom: x')).toBe('FYI');
  });

  it('keeps text without any of those', () => {
    expect(ownText('Line one\r\nLine two: details')).toBe('Line one\nLine two: details');
  });
});

describe('composer prompts', () => {
  it('asks for the body only, in the user\'s language, with the subject', () => {
    const p = buildPrompt('write', { prompt: 'thank Anna', subject: 'Workshop', language: 'de' });
    expect(p.system).toContain('Write in German');
    expect(p.messages[0].content).toContain('thank Anna');
    expect(p.messages[0].content).toContain('Subject of the email: Workshop');
  });

  it('has a distinct instruction for every rewrite style and keeps the draft in tags', () => {
    const systems = REWRITE_STYLES.map((style) => buildPrompt('rewrite', { text: 'Hello', style }).system);
    expect(new Set(systems).size).toBe(REWRITE_STYLES.length);
    expect(buildPrompt('rewrite', { text: 'Hello', style: 'shorter' }).messages[0].content).toBe('<draft>\nHello\n</draft>');
  });

  it('translates into the chosen language', () => {
    expect(buildPrompt('translate', { text: 'Hallo', target: 'fr' }).system).toContain('into French');
  });

  it('cuts very long text', () => {
    const long = 'x'.repeat(40_000);
    expect(clip(long).length).toBeLessThan(31_000);
    expect(clip('short')).toBe('short');
  });
});

describe('the context every request carries', () => {
  it('describes the user and puts the standing instructions last, the user\'s after the administrator\'s', () => {
    const extra = contextSuffix({
      person: { name: 'Anna', emails: ['a@e.org'], signature: 'Kind regards', timeZone: 'Europe/Zurich', language: 'de', now: 'Tuesday 20 October 2026 at 18:00' },
      instructions: { admin: ' House style: short. ', user: 'Sign with Anna' },
    });
    // The app comes first, then the user, then the instructions.
    expect(extra.startsWith('About the app (from the app itself):\nYou are the AI assistant, a plugin inside Bulwark Mail: ')).toBe(true);
    expect(extra.slice(extra.indexOf('About the user'))).toBe([
      'About the user (data, from their account):',
      'Name: Anna', 'Email addresses: a@e.org', 'Signs emails with:\nKind regards', 'Time zone: Europe/Zurich',
      'Language of the mail client: German',
      '', 'Standing instructions from the administrator:\nHouse style: short.', '',
      'Standing instructions from the user (these win over the administrator\'s):\nSign with Anna',
    ].join('\n'));
    expect(contextSuffix({})).not.toContain('About the user');
    expect(contextSuffix(null)).not.toContain('Standing instructions');
    expect(contextSuffix({ instructions: { user: 'x'.repeat(5000) } }).length).toBeLessThan(2500);
  });

  it('says which app, version, account and server it runs in, and the app\'s places by the names the user sees', () => {
    const de = Object.fromEntries(Object.entries(allStrings().de).filter(([k]) => k.startsWith('app.')).map(([k, v]) => [k.slice(4), v]));
    const block = appBlock({
      app: { product: 'Bulwark Mail', name: 'Rath Mail', version: '1.17.1', edition: 'full', stalwartFeatures: false },
      account: { email: 'linus@rath.li', server: 'mail.rath.li', accounts: 2 },
    }, { panel: 'reader', labels: de });
    expect(block).toContain('a plugin inside Rath Mail, which runs Bulwark Mail 1.17.1: an open-source webmail for JMAP mail servers');
    expect(block).toContain('The user is signed in as linus@rath.li on the mail server mail.rath.li; 2 accounts are set up in the app.');
    expect(block).toContain('to the right of the open message');
    expect(block).toContain('Einstellungen (at the bottom of the navigation)');
    expect(block).toContain('Abwesenheit (automatic replies)');
    expect(block).toContain('Verfassen (signatures, templates)');
    // What the app does, and to look a setting up rather than guess.
    expect(block).toContain('undo send (a short delay before a message goes out)');
    expect(block).toContain('Use find_setting to tell the user where a setting is');
    // Without Stalwart's features there is no Security page.
    expect(block).not.toContain(allStrings().de['app.settings.security']);
    // An older webmail without api.app: still the product, no version.
    const old = appBlock({}, { panel: 'composer', labels: {} });
    expect(old).toContain('a plugin inside Bulwark Mail: ');
    expect(old).toContain('the message the user is writing');
    expect(old).not.toContain('navigation');
  });

  it('answers in the language of the user\'s message, not the email\'s', () => {
    expect(readerChatSystem({ language: 'de' })).toContain('Answer in the language of the user\'s latest message (German when that is unclear)');
    expect(composerChatSystem({ language: 'de', scope: 'body', text: 'x' })).toContain('in the language of their latest message (German when that is unclear)');
  });

  it('asks for a reply next to a message, and for a new email with recipients without one', () => {
    const withMail = readerChatSystem({ email: { subject: 'Hi', text: 'x' } });
    expect(withMail).toContain('the complete reply text inside <text></text>');
    expect(withMail).not.toContain('to="');
    const without = readerChatSystem({ email: null });
    expect(without).toContain('No email is open, so a draft is a new email, not a reply');
    expect(without).toContain('<text to="anna@example.org" subject="Short subject">');
    expect(without).not.toContain('the complete reply text');
  });

  it('goes to the end of the task prompts and the chat prompts', () => {
    expect(buildPrompt('write', { prompt: 'hi', extra: 'CONTEXT' }).system.endsWith('CONTEXT')).toBe(true);
    expect(buildPrompt('rewrite', { text: 'hi', style: 'shorter', extra: 'CONTEXT' }).system).toContain('CONTEXT');
    // Translation and proofreading keep to the text: no instructions there.
    expect(buildPrompt('translate', { text: 'hi', target: 'fr', extra: 'CONTEXT' }).system).not.toContain('CONTEXT');
    const system = composerChatSystem({ scope: 'body', text: 'Hello', extra: 'CONTEXT', hasTools: true });
    expect(system).toContain('CONTEXT');
    expect(system).toContain('<widget>{json}</widget>');
    expect(system).toContain('search the mail');
    expect(system.indexOf('CONTEXT')).toBeLessThan(system.indexOf('<draft>'));
  });
});

describe('translation languages', () => {
  it('suggests the last language used, else English, else German for English users', () => {
    expect(defaultTarget('fr', 'it')).toBe('it');
    expect(defaultTarget('fr')).toBe('en');
    expect(defaultTarget('en-GB')).toBe('de');
    const options = languageOptions('de');
    expect(options.find((o) => o.tag === 'fr').label).toBe('Französisch');
  });
});

describe('background', () => {
  it('keeps only the subject of the open draft and forgets it when the composer closes', async () => {
    const api = fakeApi({ handlers: configured });
    const bg = createBackground(api);
    await bg.activate();
    await bg.hooks.onDraftChange({ subject: 'Hi', textBody: 'Hello there', to: ['a@b.c'] });
    expect(await api.storage.get(DRAFT_KEY)).toMatchObject({ subject: 'Hi' });
    expect(Object.keys(await api.storage.get(DRAFT_KEY)).sort()).toEqual(['at', 'subject']);
    await bg.hooks.onComposerClose({ sent: false });
    expect(await api.storage.get(DRAFT_KEY)).toBeNull();
  });

  it('forgets the per-message chats of older versions when it starts', async () => {
    const api = fakeApi({ handlers: configured });
    await api.storage.set('chat:email:M1', { turns: [{ role: 'user', content: 'x'.repeat(1000) }] });
    await api.storage.set('chat:reader', { turns: [] });
    await createBackground(api).activate();
    expect(await api.storage.get('chat:email:M1')).toBeNull();
    expect(await api.storage.get('chat:reader')).toEqual({ turns: [] });
  });

  it('forgets a draft left from an earlier session when it starts', async () => {
    const api = fakeApi({ handlers: configured });
    await api.storage.set(DRAFT_KEY, { text: 'old' });
    await createBackground(api).activate();
    expect(await api.storage.get(DRAFT_KEY)).toBeNull();
  });

  const actionsBySurface = (api) => Object.fromEntries(api.calls('ui.setActions').map((c) => [c.args[0], c.args[1]]));

  it('offers the composer button with Alt+A and the right-click entries only when a service is set up', async () => {
    const offApi = fakeApi({ handlers: { 'admin.getAllConfig': async () => ({}) } });
    const off = createBackground(offApi);
    await off.activate();
    expect(off.shouldShow.composer()).toBe(false);
    expect(actionsBySurface(offApi)).toEqual({ [COMPOSER_SURFACE]: [], [COMPOSER_MENU_SURFACE]: [], [READER_MENU_SURFACE]: [], [READER_SURFACE]: [] });
    const onApi = fakeApi({ handlers: configured, translations: allStrings() });
    const on = createBackground(onApi);
    await on.activate();
    expect(on.shouldShow.composer()).toBe(true);
    const actions = actionsBySurface(onApi);
    expect(actions[COMPOSER_SURFACE]).toEqual([{ id: 'assistant', label: 'Assistant', icon: 'sparkles', shortcut: 'Alt+A' }]);
    expect(actions[COMPOSER_MENU_SURFACE].map((a) => a.id)).toEqual(['improve', 'grammar', 'shorter', 'translate', 'ask']);
    expect(actions[COMPOSER_MENU_SURFACE][0]).toMatchObject({ label: 'Improve writing', icon: 'sparkles', order: 10 });
    expect(actions[READER_MENU_SURFACE].map((a) => a.id)).toEqual(['explain', 'translate', 'reply', 'ask']);
    // One button for the reader's panel: the host's toggle, not a second one of the plugin's.
    expect(actions[READER_SURFACE]).toEqual([]);
    // The host allows 8 entries per surface and 60-character labels.
    for (const list of Object.values(actions)) {
      expect(list.length).toBeLessThanOrEqual(8);
      for (const a of list) expect(a.label.length).toBeLessThanOrEqual(60);
    }
  });

  it('takes the buttons away again when the service is removed, and the reader entries when the reader is off', async () => {
    let config = { anthropicBaseUrl: 'https://api.anthropic.com/v1' };
    const api = fakeApi({ handlers: { 'admin.getAllConfig': async () => config } });
    const bg = createBackground(api);
    await bg.activate();
    expect(api.calls('ui.setActions')).toHaveLength(4);
    await api.storage.set('prefs', { showInReader: false });
    await bg.refresh(true);
    expect(actionsBySurface(api)[READER_MENU_SURFACE]).toEqual([]);
    expect(actionsBySurface(api)[READER_SURFACE]).toEqual([]);
    expect(actionsBySurface(api)[COMPOSER_SURFACE]).toHaveLength(1);
    config = {};
    await bg.refresh(true);
    await bg.refresh(true);
    expect(Object.values(actionsBySurface(api)).map((l) => l.length)).toEqual([0, 0, 0, 0]);
    expect(api.calls('ui.setActions')).toHaveLength(12);
  });

  it('toggles the panel of the composer that was clicked, and falls back to the dialog where there is none', async () => {
    let panel = true;
    let close;
    const api = fakeApi({ handlers: { ...configured, 'ui.togglePanel': async () => panel, 'ui.openDialog': () => new Promise((r) => { close = r; }) } });
    const bg = createBackground(api);
    await bg.activate();
    bg.hooks.onAction({ surface: COMPOSER_SURFACE, actionId: 'assistant', context: { composerId: 'c7' } });
    await new Promise((r) => setTimeout(r, 0));
    expect(api.calls('ui.togglePanel').map((c) => c.args)).toEqual([['composer-sidebar-right', { composerId: 'c7' }]]);
    expect(api.calls('ui.openDialog')).toHaveLength(0);
    // A phone: no panel answers (null). The dialog opens, once at a time.
    panel = null;
    bg.hooks.onAction({ surface: COMPOSER_SURFACE, actionId: 'assistant', context: { composerId: 'c8' } });
    await new Promise((r) => setTimeout(r, 0));
    bg.hooks.onAction({ surface: COMPOSER_SURFACE, actionId: 'assistant', context: { composerId: 'c8' } });
    await new Promise((r) => setTimeout(r, 0));
    const calls = api.calls('ui.openDialog');
    expect(calls).toHaveLength(1);
    expect(calls[0].args[0]).toMatchObject({ slot: 'plugin-dialog', extraProps: { composerId: 'c8' } });
    close(null);
    await new Promise((r) => setTimeout(r, 0));
    bg.hooks.onAction({ surface: COMPOSER_SURFACE, actionId: 'assistant', context: { composerId: 'c9' } });
    await new Promise((r) => setTimeout(r, 0));
    expect(api.calls('ui.openDialog')[1].args[0].extraProps).toEqual({ composerId: 'c9' });
  });

  it('hands a right-click entry to the panel as a pending request and opens the panel', async () => {
    const api = fakeApi({ handlers: { ...configured, 'ui.openPanel': async () => true } });
    const bg = createBackground(api);
    await bg.activate();
    bg.hooks.onAction({ surface: COMPOSER_MENU_SURFACE, actionId: 'improve', context: { composerId: 'c1', selection: { text: 'teh cat' } } });
    await new Promise((r) => setTimeout(r, 0));
    expect(await api.storage.get(pendingKey('composer', 'c1'))).toMatchObject({ action: 'improve', text: 'teh cat' });
    expect(api.calls('ui.openPanel').map((c) => c.args)).toEqual([['composer-sidebar-right', { composerId: 'c1' }]]);

    bg.hooks.onAction({ surface: READER_MENU_SURFACE, actionId: 'explain', context: { emailId: 'M1', selection: { text: 'force majeure' } } });
    await new Promise((r) => setTimeout(r, 0));
    expect(await api.storage.get(pendingKey('reader', 'M1'))).toMatchObject({ action: 'explain', text: 'force majeure' });
    expect(api.calls('ui.openPanel')[1].args).toEqual(['email-detail-sidebar']);
  });

  it('drops the pending request and opens the dialog when no panel answers a right-click', async () => {
    const api = fakeApi({ handlers: { ...configured, 'ui.openPanel': async () => null, 'ui.openDialog': async () => null } });
    const bg = createBackground(api);
    await bg.activate();
    bg.hooks.onAction({ surface: COMPOSER_MENU_SURFACE, actionId: 'grammar', context: { composerId: 'c1', selection: { text: 'teh' } } });
    await new Promise((r) => setTimeout(r, 0));
    expect(await api.storage.get(pendingKey('composer', 'c1'))).toBeNull();
    expect(api.calls('ui.openDialog')).toHaveLength(1);
  });

  it('remembers what the composer is about and forgets it, the chats and the draft when it closes', async () => {
    const api = fakeApi({ handlers: configured });
    const bg = createBackground(api);
    await bg.activate();
    await bg.hooks.onComposerOpen({ mode: 'reply', inReplyToId: 'M9', originalSubject: 'Lunch' });
    expect(await api.storage.get(COMPOSER_CONTEXT_KEY)).toMatchObject({ mode: 'reply', inReplyToId: 'M9', originalSubject: 'Lunch' });
    await api.storage.set(chatKey('composer', 'c1'), { turns: [{ role: 'user', content: 'x' }] });
    await api.storage.set(chatKey('reader', 'M1'), { turns: [] });
    await bg.hooks.onComposerClose({ sent: true });
    expect(await api.storage.get(COMPOSER_CONTEXT_KEY)).toBeNull();
    expect(await api.storage.get(chatKey('composer', 'c1'))).toBeNull();
    expect(await api.storage.get(chatKey('reader', 'M1'))).toEqual({ turns: [] });
  });

  it('notices a newly set up service at once, and a removed one within 30 s', async () => {
    let config = {};
    let now = 1_000_000;
    const api = fakeApi({ handlers: { 'admin.getAllConfig': async () => config } });
    const bg = createBackground(api, { now: () => now });
    await bg.activate();
    config = { anthropicBaseUrl: 'https://api.anthropic.com/v1' };
    now += 1_000;
    await bg.hooks.onComposerOpen();
    expect(bg.shouldShow.composer()).toBe(true);
    config = {};
    now += 5_000;
    await bg.hooks.onComposerOpen();
    expect(bg.shouldShow.composer()).toBe(true);
    expect(api.calls('admin.getAllConfig')).toHaveLength(2);
    now += 30_000;
    await bg.hooks.onComposerOpen();
    expect(bg.shouldShow.composer()).toBe(false);
  });
});

describe('plugin wiring', () => {
  it('declares a slot or hook for each permission it asks for', () => {
    expect(Object.keys(plugin.slots)).toEqual(expect.arrayContaining(['composer-sidebar-right', 'email-detail-sidebar', 'plugin-dialog', 'settings-section']));
    expect(Object.keys(plugin.slots)).not.toContain('composer-toolbar');
    // The chat panels fill their panel, so the input stays at the bottom.
    expect(plugin.slots['composer-sidebar-right']).toMatchObject({ fill: true, startFolded: true });
    expect(plugin.slots['email-detail-sidebar']).toMatchObject({ fill: true, startFolded: true });
    expect(Object.keys(plugin.hooks)).toEqual(expect.arrayContaining(['onAction', 'onDraftChange', 'onComposerOpen', 'onComposerClose']));
    expect(manifest.permissions).toEqual(expect.arrayContaining(['email:read', 'ui:composer-toolbar', 'ui:composer-sidebar', 'ui:email-details', 'ui:context-menu', 'ui:toolbar', 'compose:read', 'compose:write', 'compose:open', 'calendar:read', 'contacts:read']));
    expect(manifest.minAppVersion).toBe('1.17.0');
  });

  it('routes the hooks to the background after activate', async () => {
    const api = fakeApi({ handlers: configured });
    await plugin.activate(api);
    await plugin.hooks.onDraftChange({ subject: 'S', textBody: 'T' });
    expect(await api.storage.get(DRAFT_KEY)).toMatchObject({ subject: 'S' });
    plugin.hooks.onAction({ surface: COMPOSER_SURFACE, actionId: 'assistant', context: { composerId: 'c1' } });
    await new Promise((r) => setTimeout(r, 0));
    expect(api.calls('ui.togglePanel')[0].args).toEqual(['composer-sidebar-right', { composerId: 'c1' }]);
  });
});
