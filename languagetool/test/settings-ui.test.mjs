// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import * as React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { fakeApi } from '../../test-utils/fake-api.mjs';
import { SettingsPanel } from '../src/ui/SettingsPanel.jsx';
import { savePrefs } from '../src/lib/prefs.js';
import manifest from '../manifest.json' with { type: 'json' };

// The settings section: where text goes, the lock, the dictionary and rules.

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
afterEach(cleanup);

async function show(config, { before, locale = 'en', hostFeatures } = {}) {
  const api = fakeApi({ locale, translations: manifest.locales, hostFeatures, handlers: { 'config.get': async () => config } });
  if (before) await before(api);
  await act(async () => { render(React.createElement(SettingsPanel, { api })); });
  await screen.findByTestId('lt-status');
  return api;
}

describe('the settings section', () => {
  it('names the server text goes to, by host name only, and where proofreading is switched', async () => {
    await show({ serverUrl: 'http://languagetool:8010/v2' });
    expect(screen.getByTestId('lt-status').textContent).toBe('Your text is checked on languagetool:8010.');
    expect(screen.getByText('Turn proofreading on or off under Composing.')).toBeTruthy();
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('links to languagetool.org when the public API is used', async () => {
    await show({ allowPublicApi: true });
    expect(screen.getByTestId('lt-status').textContent).toContain('api.languagetool.org');
    expect(screen.getByRole('link', { name: 'languagetool.org' }).getAttribute('href')).toBe('https://languagetool.org');
  });

  it('says when nothing is set up', async () => {
    await show({});
    expect(screen.getByTestId('lt-status').textContent).toBe(manifest.locales.en['settings.status_not_set_up']);
    cleanup();
    await show({ allowPublicApi: true }, { hostFeatures: { noThirdPartyTraffic: true } });
    expect(screen.getByTestId('lt-status').textContent).toBe(manifest.locales.en['settings.status_third_party']);
  });

  it('saves the language, a variant, picky mode and the send warning', async () => {
    const api = await show({ serverUrl: 'https://lt.example.com' });
    expect(screen.getByRole('combobox', { name: 'Language' }).value).toBe('follow');
    await act(async () => { fireEvent.change(screen.getByRole('combobox', { name: 'Spelling for English' }), { target: { value: 'en-GB' } }); });
    await act(async () => { fireEvent.change(screen.getByRole('combobox', { name: 'Language' }), { target: { value: 'de' } }); });
    await act(async () => { fireEvent.click(screen.getByRole('switch', { name: 'Picky mode' })); });
    await act(async () => { fireEvent.click(screen.getByRole('switch', { name: 'Warn before sending' })); });
    const prefs = await api.storage.get('prefs');
    expect(prefs).toMatchObject({ language: 'de', picky: true, warnBeforeSend: true });
    expect(prefs.variants).toContain('en-GB');
    expect(await api.storage.get('rev')).toBeTruthy();
    // With German picked, only German's variant is offered.
    expect(screen.queryByRole('combobox', { name: 'Spelling for English' })).toBeNull();
    expect(screen.getByRole('combobox', { name: 'Spelling for German' }).value).toBe('de-DE');
  });

  it('shows the admin values read-only with a lock note when users may not change them', async () => {
    await show({ serverUrl: 'https://lt.example.com', userMayChange: false, defaultLanguage: 'fr', level: 'picky' }, {
      before: (api) => savePrefs(api, { language: 'de', picky: false, disabledRules: [{ id: 'R1', label: 'Rule one' }] }),
    });
    expect(screen.getByText(manifest.locales.en['settings.locked'])).toBeTruthy();
    const language = screen.getByRole('combobox', { name: 'Language' });
    expect(language.value).toBe('fr');
    expect(language.disabled).toBe(true);
    const picky = screen.getByRole('switch', { name: 'Picky mode' });
    expect(picky.getAttribute('aria-checked')).toBe('true');
    expect(picky.disabled).toBe(true);
    expect(screen.queryByRole('button', { name: 'Turn Rule one back on' })).toBeNull();
    expect(screen.getByText('Rule one')).toBeTruthy();
    // The user's own things stay theirs.
    expect(screen.getByRole('switch', { name: 'Warn before sending' }).disabled).toBe(false);
  });

  it('adds and removes dictionary words and turns rules back on', async () => {
    const api = await show({ serverUrl: 'https://lt.example.com', wordList: 'Acme\nWidget' }, {
      before: (a) => savePrefs(a, { disabledRules: [{ id: 'R1', label: 'Rule one' }] }),
    });
    expect(screen.getByText('No words yet.')).toBeTruthy();
    expect(screen.getByText("Words from your organisation's list are accepted too: 2.")).toBeTruthy();
    const input = screen.getByRole('textbox', { name: 'Add a word' });
    await act(async () => { fireEvent.change(input, { target: { value: ' Bulwark ' } }); });
    await act(async () => { fireEvent.keyDown(input, { key: 'Enter' }); });
    expect(await api.storage.get('dictionary')).toEqual(['Bulwark']);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Remove Bulwark' })); });
    expect(await api.storage.get('dictionary')).toEqual([]);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Turn Rule one back on' })); });
    expect((await api.storage.get('prefs')).disabledRules).toEqual([]);
    expect(screen.getByText('No rules turned off.')).toBeTruthy();
  });

  it('speaks the user language', async () => {
    await show({ serverUrl: 'https://lt.example.com' }, { locale: 'de' });
    expect(screen.getByTestId('lt-status').textContent).toBe(manifest.locales.de['settings.status_server'].replace('{host}', 'lt.example.com'));
    expect(screen.getByRole('combobox', { name: manifest.locales.de['settings.language'] })).toBeTruthy();
  });
});
