// The plugin's background part: the actions on messages of team mailboxes,
// the "Assigned to me" and "Open" list filters, the row badges and the names
// behind the ids. Kept apart from src/index.js so tests can drive it with a
// fake api.
//
// Bulwark draws the buttons and chips and shows them only where they apply:
// every action and filter is limited to group accounts (`accounts:
// ['group']`), and the keyword conditions pick "Mark done" or "Reopen",
// "Assign to me" or not, per message. The plugin never sees a user's own
// mail through these.

import {
  ASSIGNED_PREFIX, DONE, assignChanges, assignedKeyword, assigneeOf, doneChanges, isAssigneeId,
  keywordList, recentAssignees, reopenChanges, unassignChanges,
} from './keywords.js';
import { findByEmail, looksLikeAddress, mergeShared, person, readShared, shortName, writeShared } from './names.js';

export const SURFACES = ['message-row-actions', 'reader-actions'];
export const ACTION = {
  assignMe: 'assign-me',
  assignTo: 'assign-to',
  unassign: 'unassign',
  done: 'done',
  reopen: 'reopen',
};
export const FILTER = { mine: 'mine', open: 'open' };
export const BADGE = { assignee: 'team-inbox-assignee', done: 'team-inbox-done' };
const GROUP = ['group'];
const PEOPLE_KEY = 'people';

/** Whether the host has the APIs the plugin needs (Bulwark 1.19 and later). */
export function hostSupports(api) {
  return typeof api?.user?.getSelf === 'function'
    && typeof api?.user?.getMailAccounts === 'function'
    && typeof api?.ui?.setListFilters === 'function'
    && typeof api?.email?.updateKeywords === 'function';
}

/** The actions for one user, the same on message rows and in the reader. */
export function teamActions(t, selfId) {
  return [
    { id: ACTION.assignMe, label: t('action.assign_me'), icon: 'user-check', order: 50, accounts: GROUP, notKeyword: assignedKeyword(selfId) },
    { id: ACTION.assignTo, label: t('action.assign_to'), icon: 'user-plus', order: 51, accounts: GROUP },
    { id: ACTION.unassign, label: t('action.unassign'), icon: 'user-x', order: 52, accounts: GROUP, hasKeyword: `${ASSIGNED_PREFIX}*` },
    { id: ACTION.done, label: t('action.done'), icon: 'circle-check', order: 53, accounts: GROUP, notKeyword: DONE },
    { id: ACTION.reopen, label: t('action.reopen'), icon: 'arrow-back-up', order: 53, accounts: GROUP, hasKeyword: DONE },
  ];
}

export function teamFilters(t, selfId) {
  return [
    { id: FILTER.mine, label: t('filter.mine'), icon: 'user', hasKeyword: assignedKeyword(selfId), accounts: GROUP, order: 1 },
    { id: FILTER.open, label: t('filter.open'), icon: 'circle-dashed', notKeyword: DONE, accounts: GROUP, order: 2 },
  ];
}

export function createWiring(initialApi) {
  let api = initialApi;
  let self = null;
  /** Names by principal id: the local cache, the shared maps and the directory. */
  let people = {};
  /** The shared map of each group account read so far; null where the server keeps none. */
  let shared = {};
  let readOnly = new Set();
  /** Assignees seen on rows, for "recent" in the dialog. */
  const seen = new Map();
  let dialogOpen = false;
  let started = null;

  const t = (key, vars) => api.i18n.t(key, vars);

  function selfPerson() {
    return { name: self.name, email: self.email };
  }

  function nameOf(id) {
    if (self && id === self.accountId) return selfPerson();
    return people[id] ?? null;
  }

  async function saveLocal() {
    try { await api.storage.set(PEOPLE_KEY, people); } catch { /* full or blocked: names come back from the server */ }
  }

  function learn(additions) {
    let changed = false;
    for (const [id, entry] of Object.entries(additions)) {
      const p = person(entry);
      if (!p || !isAssigneeId(id)) continue;
      const key = id.toLowerCase();
      const before = people[key];
      if (before && before.name === p.name && before.email === p.email) continue;
      people[key] = p;
      changed = true;
    }
    return changed;
  }

  async function publish() {
    if (!self) return;
    const actions = teamActions(t, self.accountId);
    for (const surface of SURFACES) await api.ui.setActions(surface, actions);
    await api.ui.setListFilters(teamFilters(t, self.accountId));
  }

  /** Add people to a group's shared map, if the server keeps one and the user may write it. */
  async function share(accountId, additions) {
    const current = shared[accountId];
    if (!current || readOnly.has(accountId)) return;
    const next = mergeShared(current, additions);
    if (!next) return;
    try {
      await api.accountData.set(accountId, writeShared(next));
      shared[accountId] = next;
    } catch (err) {
      api.log.warn('could not update the names in the team mailbox', err);
    }
  }

  /**
   * Read the shared names of the group accounts not read yet, and add the
   * user to each. Runs again when a folder opens: which accounts are groups
   * is known only once the server said so. Resolves to whether a name was
   * learned.
   */
  async function loadGroups() {
    if (!self) return;
    let accounts;
    try { accounts = await api.user.getMailAccounts(); } catch { return; }
    let learned = false;
    for (const account of accounts) {
      if (account.kind !== 'group' || account.accountId in shared) continue;
      shared[account.accountId] = null;
      if (account.isReadOnly) readOnly.add(account.accountId);
      let data;
      try { data = await api.accountData?.get?.(account.accountId); } catch { data = null; }
      if (!data?.supported) continue;
      const map = readShared(data.value);
      shared[account.accountId] = map;
      if (learn(map)) learned = true;
      await share(account.accountId, { [self.accountId]: selfPerson() });
    }
    if (learned) await saveLocal();
    return learned;
  }

  async function start() {
    if (!hostSupports(api)) {
      api.log.info('team-inbox needs Bulwark 1.19 or later');
      return;
    }
    self = await api.user.getSelf();
    people = {};
    shared = {};
    readOnly = new Set();
    seen.clear();
    const cached = await api.storage.get(PEOPLE_KEY);
    if (cached && typeof cached === 'object') learn(cached);
    await publish();
    await loadGroups();
    // Rows drawn before the plugin knew the user carry no badges; the host
    // keeps that answer until asked again.
    void api.ui.refreshRowBadges?.();
  }

  function ensureStarted() {
    started ??= start().catch((err) => { api.log.error('team-inbox failed to start', err); });
    return started;
  }

  async function keywordsOf(emailId, accountId) {
    const view = await api.email.get(emailId, accountId);
    if (!view) throw new Error('The message is gone');
    return view.keywords ?? [];
  }

  async function change(emailId, accountId, changes, success) {
    if (Object.keys(changes).length === 0) return true;
    const ok = await api.email.updateKeywords(emailId, changes, accountId);
    if (ok === false) return false;
    if (success) api.toast.success(success);
    return true;
  }

  function choicesFor(accountId) {
    const out = [];
    const add = (id, kind) => {
      if (!id || out.some((c) => c.id === id)) return;
      const p = nameOf(id);
      out.push({ id, kind, name: p?.name || t('choice.unknown'), email: p?.email || '' });
    };
    add(self.accountId, 'me');
    for (const id of recentAssignees(seen, { exclude: [self.accountId] })) add(id, 'recent');
    for (const id of Object.keys(shared[accountId] ?? {})) add(id, 'member');
    return out;
  }

  /** The principal of a typed address: from the names known, else the directory. */
  async function resolveAddress(address) {
    const known = findByEmail({ ...people, [self.accountId]: selfPerson() }, address);
    if (known) return known;
    let result;
    try { result = await api.user.findPeople({ text: address }); } catch { result = null; }
    const match = result?.people?.find((p) => p.email === address.toLowerCase() && p.type !== 'group');
    if (match) return { id: match.id, name: match.name, email: match.email };
    throw new Error(result && !result.complete ? t('error.no_directory', { address }) : t('error.not_found', { address }));
  }

  async function assignTo(emailId, accountId) {
    if (dialogOpen) return;
    dialogOpen = true;
    let picked;
    try {
      picked = await api.ui.openDialog({
        title: t('dialog.title'),
        slot: 'plugin-dialog',
        extraProps: { choices: choicesFor(accountId), accountId },
        width: 440,
      });
    } finally {
      dialogOpen = false;
    }
    if (!picked || typeof picked !== 'object') return;
    let target;
    if (typeof picked.address === 'string') {
      if (!looksLikeAddress(picked.address)) return;
      target = await resolveAddress(picked.address.trim().toLowerCase());
    } else if (isAssigneeId(picked.id)) {
      target = { id: picked.id.toLowerCase(), name: picked.name, email: picked.email };
    } else {
      return;
    }
    const p = person(target);
    if (p && target.id !== self.accountId) {
      if (learn({ [target.id]: p })) await saveLocal();
      if (accountId) await share(accountId, { [target.id]: p });
    }
    const keywords = await keywordsOf(emailId, accountId);
    const success = target.id === self.accountId ? t('toast.assigned_me') : t('toast.assigned', { name: p?.name || target.id });
    await change(emailId, accountId, assignChanges(keywords, target.id), success);
  }

  async function run(actionId, emailId, accountId) {
    await ensureStarted();
    if (!self) return;
    switch (actionId) {
      case ACTION.assignMe: {
        const keywords = await keywordsOf(emailId, accountId);
        await change(emailId, accountId, assignChanges(keywords, self.accountId), t('toast.assigned_me'));
        if (accountId) await share(accountId, { [self.accountId]: selfPerson() });
        return;
      }
      case ACTION.assignTo:
        await assignTo(emailId, accountId);
        return;
      case ACTION.unassign: {
        const keywords = await keywordsOf(emailId, accountId);
        await change(emailId, accountId, unassignChanges(keywords), t('toast.unassigned'));
        return;
      }
      case ACTION.done: {
        const keywords = await keywordsOf(emailId, accountId);
        await change(emailId, accountId, doneChanges(keywords), t('toast.done'));
        return;
      }
      case ACTION.reopen: {
        const keywords = await keywordsOf(emailId, accountId);
        await change(emailId, accountId, reopenChanges(keywords), t('toast.reopened'));
        return;
      }
      default:
    }
  }

  const hooks = {
    onAction({ surface, actionId, context } = {}) {
      if (!SURFACES.includes(surface) || typeof context?.emailId !== 'string') return undefined;
      const accountId = typeof context.accountId === 'string' ? context.accountId : undefined;
      return run(actionId, context.emailId, accountId).catch((err) => {
        api.log.error('team-inbox action failed', err);
        api.toast.error(err instanceof Error && err.message && !/^The message is gone$/.test(err.message)
          ? err.message : t('error.failed'));
      });
    },

    onEmailListItemRender(badges, { email } = {}) {
      if (!self) return undefined;
      const keywords = keywordList(email?.keywords);
      const out = Array.isArray(badges) ? [...badges] : [];
      const before = out.length;
      const id = assigneeOf(keywords);
      if (id) {
        seen.set(id, (seen.get(id) ?? 0) + 1);
        const p = nameOf(id);
        const mine = id === self.accountId;
        out.push({
          key: BADGE.assignee,
          icon: 'user',
          label: mine ? t('badge.me') : p ? shortName(p) : t('badge.assigned'),
          title: mine ? t('badge.assigned_me_title')
            : p ? t('badge.assigned_to', { name: p.email ? `${p.name} <${p.email}>` : p.name }) : t('badge.assigned_unknown'),
        });
      }
      if (keywords.includes(DONE)) {
        out.push({ key: BADGE.done, icon: 'check', label: t('badge.done'), title: t('badge.done_title'), color: 'var(--color-success)' });
      }
      return out.length === before ? undefined : out;
    },

    onMailboxChange() {
      void ensureStarted().then(loadGroups).then((learned) => {
        if (learned) void api.ui.refreshRowBadges?.();
      });
    },

    onAccountSwitch() {
      started = null;
      void ensureStarted();
    },
  };

  return {
    hooks,
    async activate(next) {
      if (next) api = next;
      started = null;
      await ensureStarted();
      api.i18n.onLocaleChange?.(() => { void publish(); });
    },
    /** For tests. */
    get self() { return self; },
    get people() { return people; },
    choicesFor,
  };
}
