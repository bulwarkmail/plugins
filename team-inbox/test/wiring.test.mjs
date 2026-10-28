import { describe, expect, it } from 'vitest';
import { fakeApi } from '../../test-utils/fake-api.mjs';
import manifest from '../manifest.json' with { type: 'json' };
import { ACTION, BADGE, SURFACES, createWiring, hostSupports } from '../src/lib/wiring.js';

const SELF = { accountId: 'ci', email: 'org-alice@example.org', name: 'Org Alice' };
const GROUP = { accountId: 'ch', name: 'org-team@example.org', kind: 'group', isReadOnly: false, isOpen: true };
const OWN = { accountId: 'ci', name: 'org-alice@example.org', kind: 'personal', isReadOnly: false, isOpen: false };

function setup({ keywords = ['$seen'], accounts = [OWN, GROUP], data = { supported: false, value: null }, handlers = {} } = {}) {
  const state = { keywords: [...keywords] };
  const api = fakeApi({
    id: 'team-inbox',
    translations: manifest.locales,
    handlers: {
      'user.getSelf': async () => SELF,
      'user.getMailAccounts': async () => accounts,
      'accountData.get': async () => data,
      'accountData.set': async () => undefined,
      'email.get': async () => ({ id: 'm1', keywords: state.keywords }),
      'email.updateKeywords': async (emailId, changes) => {
        for (const [k, on] of Object.entries(changes)) {
          state.keywords = on ? [...state.keywords, k] : state.keywords.filter((x) => x !== k);
        }
        return true;
      },
      'user.findPeople': async () => ({ people: [], complete: false }),
      ...handlers,
    },
  });
  // The real api has these; the fake answers any method, so the host check passes.
  return { api, state, wiring: createWiring(api) };
}

const click = (wiring, actionId, context = { emailId: 'm1', accountId: 'ch' }, surface = 'reader-actions') =>
  wiring.hooks.onAction({ surface, actionId, context });

describe('what the plugin offers', () => {
  it('limits every action and both filters to group accounts', async () => {
    const { api, wiring } = setup();
    await wiring.activate(api);
    const surfaces = api.calls('ui.setActions').map((c) => c.args[0]);
    expect(surfaces.sort()).toEqual([...SURFACES].sort());
    for (const call of api.calls('ui.setActions')) {
      expect(call.args[1].map((a) => a.id)).toEqual(Object.values(ACTION));
      for (const action of call.args[1]) expect(action.accounts).toEqual(['group']);
    }
    const [filters] = api.calls('ui.setListFilters').at(-1).args;
    expect(filters).toEqual([
      expect.objectContaining({ id: 'mine', label: 'Assigned to me', hasKeyword: '$assigned:ci', accounts: ['group'] }),
      expect.objectContaining({ id: 'open', label: 'Open', notKeyword: '$done', accounts: ['group'] }),
    ]);
  });

  it('picks the actions per message state through keyword conditions', async () => {
    const { api, wiring } = setup();
    await wiring.activate(api);
    const actions = Object.fromEntries(api.calls('ui.setActions')[0].args[1].map((a) => [a.id, a]));
    expect(actions[ACTION.assignMe].notKeyword).toBe('$assigned:ci');
    expect(actions[ACTION.unassign].hasKeyword).toBe('$assigned:*');
    expect(actions[ACTION.done].notKeyword).toBe('$done');
    expect(actions[ACTION.reopen].hasKeyword).toBe('$done');
  });

  it('does nothing on an older Bulwark without the team APIs', async () => {
    const api = fakeApi({ id: 'team-inbox' });
    const old = new Proxy(api, { get: (t, k) => (k === 'user' ? { getAccounts: () => [] } : t[k]) });
    expect(hostSupports(old)).toBe(false);
    const wiring = createWiring(old);
    await wiring.activate(old);
    expect(api.calls('ui.setActions')).toHaveLength(0);
  });
});

describe('assignment and status', () => {
  it('assigns to me, keeping one assignee at a time, in the message\'s account', async () => {
    const { api, wiring, state } = setup({ keywords: ['$seen', '$assigned:cj'] });
    await wiring.activate(api);
    await click(wiring, ACTION.assignMe);
    const [call] = api.calls('email.updateKeywords');
    expect(call.args).toEqual(['m1', { '$assigned:cj': false, '$assigned:ci': true }, 'ch']);
    expect(state.keywords).toEqual(['$seen', '$assigned:ci']);
    expect(api.calls('toast.success')[0].args[0]).toBe('Assigned to you');
  });

  it('unassigns, marks done and reopens without touching $seen', async () => {
    const { api, wiring, state } = setup({ keywords: ['$seen', '$assigned:cj'] });
    await wiring.activate(api);
    await click(wiring, ACTION.done);
    expect(state.keywords).toEqual(['$seen', '$assigned:cj', '$done']);
    await click(wiring, ACTION.unassign, { emailId: 'm1', accountId: 'ch' }, 'message-row-actions');
    expect(state.keywords).toEqual(['$seen', '$done']);
    await click(wiring, ACTION.reopen);
    expect(state.keywords).toEqual(['$seen']);
    for (const call of api.calls('email.updateKeywords')) expect(Object.keys(call.args[1])).not.toContain('$seen');
  });

  it('assigns to the person picked in the dialog and remembers their name', async () => {
    const { api, wiring, state } = setup({
      handlers: { 'ui.openDialog': async () => ({ id: 'cj', name: 'Org Bob', email: 'org-bob@example.org' }) },
    });
    await wiring.activate(api);
    await click(wiring, ACTION.assignTo);
    expect(api.calls('ui.openDialog')[0].args[0].extraProps.choices[0]).toEqual({ id: 'ci', kind: 'me', name: 'Org Alice', email: 'org-alice@example.org' });
    expect(state.keywords).toContain('$assigned:cj');
    expect(api.calls('toast.success').at(-1).args[0]).toBe('Assigned to Org Bob');
    expect(api.storageSnapshot().people.cj).toEqual({ name: 'Org Bob', email: 'org-bob@example.org' });
  });

  it('says why a typed address can\'t be assigned while the directory is off', async () => {
    const { api, wiring, state } = setup({ handlers: { 'ui.openDialog': async () => ({ address: 'org-bob@example.org' }) } });
    await wiring.activate(api);
    await click(wiring, ACTION.assignTo);
    expect(state.keywords).toEqual(['$seen']);
    expect(api.calls('toast.error')[0].args[0]).toMatch(/doesn't allow directory lookups/);
  });

  it('assigns a typed address the directory knows', async () => {
    const { api, wiring, state } = setup({
      handlers: {
        'ui.openDialog': async () => ({ address: 'org-bob@example.org' }),
        'user.findPeople': async () => ({ complete: true, people: [{ id: 'cj', type: 'individual', name: 'Org Bob', email: 'org-bob@example.org' }] }),
      },
    });
    await wiring.activate(api);
    await click(wiring, ACTION.assignTo);
    expect(state.keywords).toContain('$assigned:cj');
  });

  it('ignores clicks on other surfaces and without a message', async () => {
    const { api, wiring } = setup();
    await wiring.activate(api);
    await wiring.hooks.onAction({ surface: 'top-bar-actions', actionId: ACTION.done, context: {} });
    await wiring.hooks.onAction({ surface: 'reader-actions', actionId: ACTION.done, context: {} });
    expect(api.calls('email.updateKeywords')).toHaveLength(0);
  });
});

describe('names in the team mailbox (Stalwart 1.0 metadata)', () => {
  it('adds the user to the shared names once, where the server keeps them', async () => {
    const { api, wiring } = setup({ data: { supported: true, value: { v: 1, people: { cj: { n: 'Org Bob', e: 'org-bob@example.org' } } } } });
    await wiring.activate(api);
    const [set] = api.calls('accountData.set');
    expect(set.args[0]).toBe('ch');
    expect(set.args[1].people).toEqual({
      cj: { n: 'Org Bob', e: 'org-bob@example.org' },
      ci: { n: 'Org Alice', e: 'org-alice@example.org' },
    });
    expect(api.calls('accountData.get').map((c) => c.args[0])).toEqual(['ch']);
    // Opening another folder doesn't read or write it again.
    wiring.hooks.onMailboxChange({});
    await new Promise((r) => setTimeout(r, 0));
    expect(api.calls('accountData.set')).toHaveLength(1);
    expect(api.calls('accountData.get')).toHaveLength(1);
  });

  it('writes nothing on servers without metadata, and reads no personal account', async () => {
    const { api, wiring } = setup();
    await wiring.activate(api);
    expect(api.calls('accountData.get').map((c) => c.args[0])).toEqual(['ch']);
    expect(api.calls('accountData.set')).toHaveLength(0);
  });

  it('reads a group that the server names only later, when a folder opens', async () => {
    const accounts = [OWN, { ...GROUP, kind: 'shared' }];
    const { api, wiring } = setup({ accounts });
    await wiring.activate(api);
    expect(api.calls('accountData.get')).toHaveLength(0);
    accounts[1] = GROUP;
    wiring.hooks.onMailboxChange({});
    await new Promise((r) => setTimeout(r, 0));
    expect(api.calls('accountData.get').map((c) => c.args[0])).toEqual(['ch']);
  });
});

describe('row badges', () => {
  it('shows the assignee by name and a done mark', async () => {
    const { api, wiring } = setup({ data: { supported: true, value: { people: { cj: { n: 'Org Bob', e: 'org-bob@example.org' } } } } });
    await wiring.activate(api);
    const badges = wiring.hooks.onEmailListItemRender([], { email: { id: 'm1', keywords: ['$assigned:cj', '$done'] } });
    expect(badges).toEqual([
      { key: BADGE.assignee, icon: 'user', label: 'Org', title: 'Assigned to Org Bob <org-bob@example.org>' },
      { key: BADGE.done, icon: 'check', label: 'Done', title: 'Marked done', color: 'var(--color-success)' },
    ]);
  });

  it('asks for the rows\' badges again once it knows the user, for rows drawn before', async () => {
    const { api, wiring } = setup();
    expect(wiring.hooks.onEmailListItemRender([], { email: { keywords: ['$assigned:cj'] } })).toBeUndefined();
    await wiring.activate(api);
    expect(api.calls('ui.refreshRowBadges')).toHaveLength(1);
  });

  it('doesn\'t wait for a server that takes long to answer the shared names', async () => {
    const { api, wiring } = setup({ handlers: { 'accountData.get': () => new Promise(() => {}) } });
    await wiring.activate(api);
    expect(api.calls('ui.refreshRowBadges')).toHaveLength(1);
    expect(wiring.hooks.onEmailListItemRender([], { email: { keywords: ['$assigned:ci'] } })[0].label).toBe('Me');
  });

  it('says "Me" for the user, "Assigned" for someone unknown, and adds nothing to other mail', async () => {
    const { api, wiring } = setup();
    await wiring.activate(api);
    expect(wiring.hooks.onEmailListItemRender([], { email: { keywords: ['$assigned:ci'] } })[0].label).toBe('Me');
    expect(wiring.hooks.onEmailListItemRender([], { email: { keywords: ['$assigned:zz'] } })[0]).toMatchObject({ label: 'Assigned' });
    expect(wiring.hooks.onEmailListItemRender([{ key: 'x', label: 'X' }], { email: { keywords: ['$seen'] } })).toBeUndefined();
  });

  it('offers recent assignees from the rows in the dialog', async () => {
    const { api, wiring } = setup();
    await wiring.activate(api);
    wiring.hooks.onEmailListItemRender([], { email: { keywords: ['$assigned:cj'] } });
    expect(wiring.choicesFor('ch').map((c) => [c.id, c.kind])).toEqual([['ci', 'me'], ['cj', 'recent']]);
    // An unknown member says their id, so two of them can be told apart.
    expect(wiring.choicesFor('ch')[1]).toMatchObject({ name: 'Unknown team member', note: 'Id cj' });
  });
});
