// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { fakeApi } from '../../test-utils/fake-api.mjs';
import manifest from '../manifest.json' with { type: 'json' };
import { makeAssignDialog } from '../src/ui/assign-dialog.js';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
afterEach(cleanup);

const CHOICES = [
  { id: 'ci', kind: 'me', name: 'Org Alice', email: 'org-alice@example.org' },
  { id: 'cj', kind: 'recent', name: 'Org Bob', email: 'org-bob@example.org' },
];

function open(handlers = {}) {
  const api = fakeApi({ translations: manifest.locales, handlers });
  const Dialog = makeAssignDialog(React, api);
  const onResult = vi.fn();
  render(React.createElement(Dialog, { choices: CHOICES, onResult }));
  return { api, onResult };
}

describe('Assign to…', () => {
  it('lists the user and recent assignees and closes with the one picked', () => {
    const { onResult } = open();
    const rows = screen.getAllByRole('listitem');
    expect(rows.map((r) => r.textContent)).toEqual(['Org AliceYou', 'Org Boborg-bob@example.org']);
    fireEvent.click(rows[1]);
    expect(onResult).toHaveBeenCalledWith({ id: 'cj', name: 'Org Bob', email: 'org-bob@example.org' });
  });

  it('narrows the list as the user types, and offers a typed address nobody listed', async () => {
    vi.useFakeTimers();
    try {
      const { onResult } = open({ 'user.findPeople': async () => ({ people: [], complete: false }) });
      fireEvent.change(screen.getByRole('textbox'), { target: { value: 'bob' } });
      expect(screen.getAllByRole('listitem').map((r) => r.textContent)).toEqual(['Org Boborg-bob@example.org']);
      fireEvent.change(screen.getByRole('textbox'), { target: { value: 'dave@org-two.test' } });
      await act(async () => { await vi.advanceTimersByTimeAsync(300); });
      expect(screen.getByText(/only people Bulwark already knows/)).toBeTruthy();
      fireEvent.click(screen.getByRole('button', { name: 'Assign to dave@org-two.test' }));
      expect(onResult).toHaveBeenCalledWith({ address: 'dave@org-two.test' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows people the directory finds, but no groups', async () => {
    vi.useFakeTimers();
    try {
      open({
        'user.findPeople': async () => ({
          complete: true,
          people: [
            { id: 'ck', type: 'individual', name: 'Org Carol', email: 'org-carol@example.org' },
            { id: 'ch', type: 'group', name: 'Org Team', email: 'org-team@example.org' },
          ],
        }),
      });
      fireEvent.change(screen.getByRole('textbox'), { target: { value: 'org' } });
      await act(async () => { await vi.advanceTimersByTimeAsync(300); });
      const names = screen.getAllByRole('listitem').map((r) => r.textContent);
      expect(names).toContain('Org Carolorg-carol@example.org');
      expect(names.some((n) => n.startsWith('Org Team'))).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancels with null', () => {
    const { onResult } = open();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onResult).toHaveBeenCalledWith(null);
  });
});
