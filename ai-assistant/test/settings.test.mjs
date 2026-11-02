// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import * as React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { fakeApi } from '../../test-utils/fake-api.mjs';
import { SettingsPanel } from '../src/ui/SettingsPanel.jsx';
import { allStrings } from '../src/lib/i18n.js';

// The plugin's settings: the Actions choice, within what the administrator allows.

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
afterEach(cleanup);

const CONFIG = { anthropicBaseUrl: 'http://localhost:18099/anthropic/v1' };

async function show(config) {
  const api = fakeApi({ translations: allStrings(), handlers: { 'admin.getAllConfig': async () => config } });
  await act(async () => { render(React.createElement(SettingsPanel, { api })); });
  await screen.findByText('Let the assistant look things up');
  return api;
}
const options = () => [...screen.getByRole('combobox', { name: 'Actions' }).options].map((o) => o.textContent);

describe('the Actions setting', () => {
  it('is off until the user picks a mode, and saves the choice', async () => {
    const api = await show(CONFIG);
    const select = screen.getByRole('combobox', { name: 'Actions' });
    expect(select.value).toBe('off');
    expect(options()).toEqual(['Off', 'Ask me first', 'Automatic']);
    await act(async () => { fireEvent.change(select, { target: { value: 'manual' } }); });
    expect((await api.storage.get('prefs')).actions).toBe('manual');
    expect(screen.getByRole('combobox', { name: 'Actions' }).value).toBe('manual');
  });

  it('offers only what the administrator allows', async () => {
    await show({ ...CONFIG, actions: 'manual' });
    expect(options()).toEqual(['Off', 'Ask me first']);
    cleanup();
    await show({ ...CONFIG, actions: 'off' });
    expect(screen.queryByRole('combobox', { name: 'Actions' })).toBeNull();
  });
});
