import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { fakeApi } from '../../test-utils/fake-api.mjs';
import { allStrings } from '../src/lib/i18n.js';
import { describeAction } from '../src/lib/actions.js';
import { actionCaps } from '../src/lib/areas/actions.js';

// A contact change that adds an address the user didn't type in the chat
// points it out on the card ("New address from a message"). An address
// counts as typed only whole: part of a longer address the user typed
// doesn't count. And the administrator's text for "More actions" says which
// of those actions ask the user first.

const CARD = { id: 'C1', name: { full: 'Ann' }, emails: { e1: { address: 'ann@old.example' } } };
const NOTE = 'New address from a message: check ann@example.org';

async function linesFor(userText) {
  const api = fakeApi({ translations: allStrings(), hostFeatures: {}, handlers: { 'contacts.get': async () => CARD, 'contacts.update': async () => null } });
  const ctx = { actions: 'auto', lookups: true, config: {}, prefs: {}, doCaps: actionCaps(api), userText };
  const { summary } = await describeAction(api, 'update_contact', { id: 'C1', emails: ['ann@example.org'] }, ctx);
  return summary.split('\n');
}

describe('the "new address" line on a contact change', () => {
  it.each([
    ['inside a longer address the user typed', 'my colleague is joann@example.org'],
    ['as the start of a longer address the user typed', 'write to ann@example.org.uk'],
    ['nowhere in what the user typed', 'update Ann from her signature'],
  ])('points out an address that appears only %s', async (_where, typed) => {
    expect(await linesFor(typed)).toContain(NOTE);
  });

  it.each([
    ['as typed', 'Ann is now ann@example.org'],
    ['in other capitals', 'Ann is now Ann@Example.org.'],
  ])('leaves out an address the user typed whole, %s (control)', async (_how, typed) => {
    expect(await linesFor(typed)).not.toContain(NOTE);
  });
});

describe('the administrator\'s text for "More actions"', () => {
  const manifest = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));
  const text = manifest.configSchema.allowMoreActions.description;

  it('names every group the setting turns on, contacts included', () => {
    for (const part of ['invitations', 'events', 'tag', 'out-of-office', 'filters', 'many messages', 'contacts']) expect(text).toContain(part);
  });

  it('says that tags and changes to the user\'s own events don\'t ask first', () => {
    expect(text).not.toMatch(/Each of these asks the user first\.$/);
    expect(text).toMatch(/except tags and changes to events that are the user's alone/);
  });
});
