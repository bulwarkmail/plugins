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
  { id: 'ck', kind: 'recent', name: 'Unknown team member', email: '', note: 'Id ck' },
];

function open(handlers = {}, extra = {}) {
  const api = fakeApi({ translations: manifest.locales, handlers });
  const Dialog = makeAssignDialog(React, api);
  const onResult = vi.fn();
  render(React.createElement(Dialog, { choices: CHOICES, onResult, ...extra }));
  return { api, onResult };
}

describe('Assign to…', () => {
  it('lists the user and recent assignees and closes with the one picked', () => {
    const { onResult } = open();
    const rows = screen.getAllByRole('listitem');
    expect(rows.map((r) => r.textContent)).toEqual(['Org AliceYou', 'Org Boborg-bob@example.org', 'Unknown team memberId ck']);
    fireEvent.click(rows[1]);
    expect(onResult).toHaveBeenCalledWith({ id: 'cj', name: 'Org Bob', email: 'org-bob@example.org' });
    // An unknown member comes back by id only.
    fireEvent.click(rows[2]);
    expect(onResult).toHaveBeenLastCalledWith({ id: 'ck' });
  });

  it('narrows the list as the user types, and offers a typed address nobody listed', async () => {
    vi.useFakeTimers();
    try {
      const { onResult } = open({ 'user.findPeople': async () => ({ people: [], complete: false }) });
      fireEvent.change(screen.getByRole('textbox'), { target: { value: 'bob' } });
      expect(screen.getAllByRole('listitem').map((r) => r.textContent)).toEqual(['Org Boborg-bob@example.org']);
      fireEvent.change(screen.getByRole('textbox'), { target: { value: 'dave@org-two.test' } });
      await act(async () => { await vi.advanceTimersByTimeAsync(500); });
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
      await act(async () => { await vi.advanceTimersByTimeAsync(500); });
      const names = screen.getAllByRole('listitem').map((r) => r.textContent);
      expect(names).toContain('Org Carolorg-carol@example.org');
      expect(names.some((n) => n.startsWith('Org Team'))).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("searches the team mailbox's directory from 3 characters on", async () => {
    vi.useFakeTimers();
    try {
      const { api } = open({ 'user.findPeople': async () => ({ people: [], complete: true }) }, { accountId: 'ch' });
      fireEvent.change(screen.getByRole('textbox'), { target: { value: 'bo' } });
      await act(async () => { await vi.advanceTimersByTimeAsync(500); });
      expect(api.calls('user.findPeople')).toHaveLength(0);
      fireEvent.change(screen.getByRole('textbox'), { target: { value: 'bob' } });
      await act(async () => { await vi.advanceTimersByTimeAsync(500); });
      expect(api.calls('user.findPeople').map((c) => c.args[0])).toEqual([{ text: 'bob', accountId: 'ch' }]);
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
