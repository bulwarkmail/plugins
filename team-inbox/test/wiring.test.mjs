import { afterEach, describe, expect, it, vi } from 'vitest';
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

/** Lets the background loads (group names, writes) run. */
const flush = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0)); };

afterEach(() => { vi.useRealTimers(); });

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
    // Offered on a message with two assignees, the user one of them.
    expect(actions[ACTION.assignMe].notKeyword).toBeUndefined();
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
    await flush();
    const [set] = api.calls('accountData.set');
    expect(set.args[0]).toBe('ch');
    expect(set.args[1].people).toEqual({
      cj: { n: 'Org Bob', e: 'org-bob@example.org' },
      ci: { n: 'Org Alice', e: 'org-alice@example.org' },
    });
    // Read, then read again right before the write.
    expect(api.calls('accountData.get').map((c) => c.args[0])).toEqual(['ch', 'ch']);
    // Opening another folder doesn't read or write it again.
    wiring.hooks.onMailboxChange({});
    await flush();
    expect(api.calls('accountData.set')).toHaveLength(1);
    expect(api.calls('accountData.get')).toHaveLength(2);
  });

  it('keeps what another member added between its read and its write', async () => {
    let value = { v: 1, people: { cj: { n: 'Org Bob', e: 'org-bob@example.org' } } };
    let reads = 0;
    const { api, wiring } = setup({
      handlers: {
        'accountData.get': async () => {
          reads += 1;
          // Carol adds herself after the first read.
          if (reads === 2) value = { v: 1, people: { ...value.people, ck: { n: 'Org Carol', e: 'org-carol@example.org' } } };
          return { supported: true, value };
        },
        'accountData.set': async (accountId, next) => { value = next; },
      },
    });
    await wiring.activate(api);
    await flush();
    expect(Object.keys(value.people)).toEqual(['cj', 'ck', 'ci']);
    expect(wiring.people.ck).toEqual({ name: 'Org Carol', email: 'org-carol@example.org' });
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
    await flush();
    expect(api.calls('accountData.get')).toHaveLength(0);
    accounts[1] = GROUP;
    wiring.hooks.onMailboxChange({});
    await flush();
    expect(api.calls('accountData.get').map((c) => c.args[0])).toEqual(['ch']);
  });

  it('tries again a little later when the server named no group yet', async () => {
    vi.useFakeTimers();
    const accounts = [OWN, { ...GROUP, kind: 'shared' }];
    const { api, wiring } = setup({ accounts });
    await wiring.activate(api);
    await vi.advanceTimersByTimeAsync(100);
    expect(api.calls('accountData.get')).toHaveLength(0);
    accounts[1] = GROUP;
    await vi.advanceTimersByTimeAsync(3000);
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
    wiring.hooks.onEmailListItemRender([], { email: { id: 'm1', keywords: ['$assigned:cj'] } });
    expect(wiring.choicesFor('ch').map((c) => [c.id, c.kind])).toEqual([['ci', 'me'], ['cj', 'recent']]);
    // An unknown member says their id, so two of them can be told apart.
    expect(wiring.choicesFor('ch')[1]).toMatchObject({ name: 'Unknown team member', note: 'Id cj' });
  });
});

describe('two assignees at once (two clients raced)', () => {
  it('shows both on the badge, the user first', async () => {
    const { api, wiring } = setup({ data: { supported: true, value: { people: { cj: { n: 'Org Bob', e: 'org-bob@example.org' } } } } });
    await wiring.activate(api);
    await flush();
    const [badge] = wiring.hooks.onEmailListItemRender([], { email: { id: 'm1', keywords: ['$assigned:cj', '$assigned:ck'] } });
    expect(badge).toMatchObject({ label: 'Org +1', title: 'Assigned to Org Bob, Unknown team member' });
    const [mine] = wiring.hooks.onEmailListItemRender([], { email: { id: 'm2', keywords: ['$assigned:cj', '$assigned:ci'] } });
    expect(mine).toMatchObject({ label: 'Me +1', title: 'Assigned to you, Org Bob' });
  });

  it('"Assign to me" takes it from the other one in one change', async () => {
    const { api, wiring, state } = setup({ keywords: ['$assigned:ci', '$assigned:cj'] });
    await wiring.activate(api);
    await click(wiring, ACTION.assignMe);
    expect(api.calls('email.updateKeywords')).toHaveLength(1);
    expect(api.calls('email.updateKeywords')[0].args[1]).toEqual({ '$assigned:cj': false });
    expect(state.keywords).toEqual(['$assigned:ci']);
    // Already the only assignee: nothing to change.
    await click(wiring, ACTION.assignMe);
    expect(api.calls('email.updateKeywords')).toHaveLength(1);
    expect(api.calls('toast.info').at(-1).args[0]).toBe("It's already assigned to you");
  });
});

describe('names from the directory', () => {
  it('looks the ids on rows up in batches of at most 20, a while after the rows settle', async () => {
    vi.useFakeTimers();
    const asked = [];
    const { api, wiring } = setup({
      handlers: {
        'user.findPeople': async ({ ids }) => {
          asked.push(ids);
          return { complete: true, people: ids.map((id) => ({ id, type: 'individual', name: `Person ${id}`, email: `${id}@example.org` })) };
        },
      },
    });
    await wiring.activate(api);
    for (let i = 0; i < 25; i++) wiring.hooks.onEmailListItemRender([], { email: { id: `m${i}`, keywords: [`$assigned:p${i}`] } });
    // The user's own id is never asked for.
    wiring.hooks.onEmailListItemRender([], { email: { id: 'mine', keywords: ['$assigned:ci'] } });
    expect(asked).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1600);
    expect(asked).toHaveLength(1);
    expect(asked[0]).toHaveLength(20);
    expect(asked[0]).not.toContain('ci');
    // The rest waits for the gap the host's 10 lookups a minute leave.
    await vi.advanceTimersByTimeAsync(5000);
    expect(asked).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(6000);
    expect(asked).toHaveLength(2);
    expect(asked[1]).toHaveLength(5);
    expect(wiring.people.p3).toEqual({ name: 'Person p3', email: 'p3@example.org' });
    expect(api.calls('ui.refreshRowBadges').length).toBeGreaterThan(1);
    // Nobody is asked for twice.
    wiring.hooks.onEmailListItemRender([], { email: { id: 'x', keywords: ['$assigned:p3'] } });
    await vi.advanceTimersByTimeAsync(20000);
    expect(asked).toHaveLength(2);
  });

  it('stops asking when the plugin may not use the directory', async () => {
    vi.useFakeTimers();
    let calls = 0;
    const { api, wiring } = setup({
      handlers: { 'user.findPeople': async () => { calls += 1; throw new Error('Plugin "team-inbox" lacks permission "directory:read"'); } },
    });
    await wiring.activate(api);
    wiring.hooks.onEmailListItemRender([], { email: { id: 'a', keywords: ['$assigned:p1'] } });
    await vi.advanceTimersByTimeAsync(1600);
    wiring.hooks.onEmailListItemRender([], { email: { id: 'b', keywords: ['$assigned:p2'] } });
    await vi.advanceTimersByTimeAsync(30000);
    expect(calls).toBe(1);
  });
});

describe('recent assignees and activation', () => {
  it('counts recent assignees by message, not by how often a row was drawn', async () => {
    const { api, wiring } = setup();
    await wiring.activate(api);
    for (let i = 0; i < 5; i++) wiring.hooks.onEmailListItemRender([], { email: { id: 'm1', keywords: ['$assigned:cj'] } });
    wiring.hooks.onEmailListItemRender([], { email: { id: 'm2', keywords: ['$assigned:ck'] } });
    wiring.hooks.onEmailListItemRender([], { email: { id: 'm3', keywords: ['$assigned:ck'] } });
    expect(wiring.choicesFor('ch').map((c) => c.id)).toEqual(['ci', 'ck', 'cj']);
  });

  it('listens to language changes once, however often it is activated', async () => {
    const { api, wiring } = setup();
    let listeners = 0;
    const onLocaleChange = api.i18n.onLocaleChange;
    api.i18n.onLocaleChange = (fn) => { listeners += 1; return onLocaleChange(fn); };
    await wiring.activate(api);
    await wiring.activate(api);
    expect(listeners).toBe(1);
  });
});

describe('a member picked without a name', () => {
  it('is assigned without learning the placeholder as their name', async () => {
    const { api, wiring, state } = setup({ handlers: { 'ui.openDialog': async () => ({ id: 'cj' }) } });
    await wiring.activate(api);
    await click(wiring, ACTION.assignTo);
    expect(state.keywords).toContain('$assigned:cj');
    expect(wiring.people.cj).toBeUndefined();
    expect(api.calls('toast.success').at(-1).args[0]).toBe('Assigned to cj');
  });
});
