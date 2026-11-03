// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import * as React from 'react';
import { act, cleanup, render, screen } from '@testing-library/react';
import { fakeApi } from '../../test-utils/fake-api.mjs';
import { allStrings } from '../src/lib/i18n.js';
import { SettingsPanel } from '../src/ui/SettingsPanel.jsx';
import { ActionCard } from '../src/ui/panel/Steps.jsx';
import { ActionsSection } from '../src/ui/settings/ActionsSection.jsx';

// Fixes after the review of package C, in the UI: the switches follow the
// admin's area switch, the privacy notice names contact and event details,
// and an action card works with a screen reader and at phone width.

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
afterEach(cleanup);

const CONFIG = { anthropicBaseUrl: 'http://localhost:18099/anthropic/v1' };
const FEATURES = { answerInvitation: true, filterRules: true, batchMail: true, changeSettings: true };

async function settings(config) {
  const api = fakeApi({ translations: allStrings(), hostFeatures: FEATURES, handlers: { 'admin.getAllConfig': async () => config } });
  await api.storage.set('prefs', { actions: 'manual' });
  await act(async () => { render(React.createElement(SettingsPanel, { api })); });
  await screen.findByText('Let the assistant look things up');
}

describe('the switches', () => {
  it('are gone when the admin turned the more actions off', async () => {
    await settings({ ...CONFIG, allowMoreActions: false });
    expect(screen.queryByRole('switch', { name: 'Answer invitations' })).toBeNull();
    expect(screen.queryByText('What the assistant may change')).toBeNull();
    cleanup();
    await settings(CONFIG);
    expect(screen.getByRole('switch', { name: 'Answer invitations' })).toBeTruthy();
  });

  it('the section itself shows nothing with the area off, wherever it is mounted', async () => {
    const api = fakeApi({ translations: allStrings(), hostFeatures: FEATURES });
    const props = (config) => ({ api, setup: { config }, prefs: { actions: 'manual' }, savePrefs: () => {} });
    await act(async () => { render(React.createElement(ActionsSection, props({ ...CONFIG, allowMoreActions: false }))); });
    expect(screen.queryByText('What the assistant may change')).toBeNull();
    cleanup();
    await act(async () => { render(React.createElement(ActionsSection, props(CONFIG))); });
    expect(screen.getByText('What the assistant may change')).toBeTruthy();
  });
});

describe('the privacy notice', () => {
  it('names the contact and event details the actions send', () => {
    const text = allStrings().en['do.privacy'];
    expect(text).toMatch(/contacts and events/);
    expect(text).toMatch(/invitations it answers/);
  });
});

describe('an action card', () => {
  const api = fakeApi({ translations: allStrings() });
  const step = (state) => ({ id: 's1', name: 'update_contact', action: { summary: 'Change the contact Anna?\nNew address from a message: check a-very-long-address-without-any-break@a-very-long-domain-name.example', state } });

  it('ties Do it and Skip to its text and announces that it waits', async () => {
    await act(async () => { render(React.createElement(ActionCard, { api, step: step('waiting'), onAnswer: () => {}, onUndo: () => {} })); });
    const summary = document.querySelector('[data-action-summary]');
    for (const name of ['Do it', 'Skip']) {
      expect(screen.getByRole('button', { name }).getAttribute('aria-describedby')).toBe(summary.id);
    }
    expect(screen.getByRole('status').textContent).toContain('Waiting for your OK: Change the contact Anna?');
  });

  it('wraps long addresses and scrolls a long text instead of overflowing', async () => {
    await act(async () => { render(React.createElement(ActionCard, { api, step: step('done'), onAnswer: () => {}, onUndo: () => {} })); });
    const summary = document.querySelector('[data-action-summary]');
    expect(summary.style.overflowWrap).toBe('anywhere');
    expect(summary.style.minWidth).toBe('0px');
    expect(summary.style.overflowY).toBe('auto');
    // Nothing to announce once it ran.
    expect(screen.getByRole('status').textContent).toBe('');
  });
});
