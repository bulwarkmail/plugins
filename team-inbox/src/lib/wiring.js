// The plugin's background part: the actions on messages of team mailboxes,
// the "Assigned to me" and "Open" list filters, the row badges and the names
// behind the ids. Kept apart from src/index.js so tests can drive it with a
// fake api.
//
// Bulwark draws the buttons and chips and shows them only where they apply:
// every action and filter is limited to group accounts (`accounts:
// ['group']`), and the keyword conditions pick "Mark done" or "Reopen" and
// "Unassign" per message. The plugin never sees a user's own mail through
// these.

import {
  ASSIGNED_PREFIX, DONE, assignChanges, assignedKeyword, assigneesOf, doneChanges, isAssigneeId,
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

/** Unknown ids are looked up in the directory in batches, after rows settle. */
export const LOOKUP_DELAY_MS = 1500;
/** The host takes at most 20 ids a call and 10 calls a minute; stay well under. */
export const LOOKUP_BATCH = 20;
export const LOOKUP_MIN_GAP_MS = 10_000;
/** Group names are read again this late when the server named no group yet. */
export const GROUP_RETRY_MS = [3000, 15000];

/** Whether the host has the APIs the plugin needs (Bulwark 1.19 and later). */
export function hostSupports(api) {
  return typeof api?.user?.getSelf === 'function'
    && typeof api?.user?.getMailAccounts === 'function'
    && typeof api?.ui?.setListFilters === 'function'
    && typeof api?.email?.updateKeywords === 'function';
}

/**
 * The actions, the same on message rows and in the reader. "Assign to me"
 * stays offered on a message that is (also) assigned to the user: with two
 * assignees, taking it replaces the other.
 */
export function teamActions(t) {
  return [
    { id: ACTION.assignMe, label: t('action.assign_me'), icon: 'user-check', order: 50, accounts: GROUP },
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
  /** The group accounts whose shared names were read; null where the server keeps none. */
  let shared = {};
  let readOnly = new Set();
  /** Assignees seen on rows: id → the messages assigned to them, for "recent". */
  const seen = new Map();
  /** Ids to look up in the directory, and the ones already asked. */
  const unknown = new Set();
  const asked = new Set();
  let lookupTimer = null;
  let lastLookup = 0;
  let directoryAllowed = true;
  let groupRetries = 0;
  let dialogOpen = false;
  let started = null;
  let localeHooked = false;

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

  // The host takes one refresh a second; one asked for right after another
  // would be dropped.
  let lastRefresh = 0;
  function refreshBadges() {
    const wait = Math.max(0, lastRefresh + 1100 - Date.now());
    lastRefresh = Date.now() + wait;
    if (wait === 0) void api.ui.refreshRowBadges?.();
    else setTimeout(() => { void api.ui.refreshRowBadges?.(); }, wait);
  }

  async function publish() {
    if (!self) return;
    const actions = teamActions(t);
    for (const surface of SURFACES) await api.ui.setActions(surface, actions);
    await api.ui.setListFilters(teamFilters(t, self.accountId));
  }

  /**
   * Add people to a group's shared names, if the server keeps them and the
   * user may write. Reads the map again right before writing, so what
   * another member added since isn't lost.
   */
  async function share(accountId, additions) {
    if (!(accountId in shared) || shared[accountId] === null || readOnly.has(accountId)) return;
    try {
      const data = await api.accountData.get(accountId);
      if (!data?.supported) return;
      const current = readShared(data.value);
      if (learn(current)) await saveLocal();
      const next = mergeShared(current, additions);
      shared[accountId] = next ?? current;
      if (next) await api.accountData.set(accountId, writeShared(next));
    } catch (err) {
      api.log.warn('could not update the names in the team mailbox', err);
    }
  }

  /**
   * Read the shared names of the group accounts not read yet, and add the
   * user to each. Runs again when a folder opens, and a little later when
   * the server named no group yet. Resolves to whether a name was learned.
   */
  async function loadGroups() {
    if (!self) return false;
    let accounts;
    try { accounts = await api.user.getMailAccounts(); } catch { return false; }
    const groups = accounts.filter((a) => a.kind === 'group');
    if (groups.length === 0 && accounts.some((a) => a.kind === 'shared') && groupRetries < GROUP_RETRY_MS.length) {
      setTimeout(() => { void loadGroups().then((learned) => { if (learned) refreshBadges(); }); }, GROUP_RETRY_MS[groupRetries++]);
    }
    let learned = false;
    for (const account of groups) {
      if (account.accountId in shared) continue;
      shared[account.accountId] = null;
      if (account.isReadOnly) readOnly.add(account.accountId);
      let data;
      try { data = await api.accountData?.get?.(account.accountId); } catch { data = null; }
      if (!data?.supported) continue;
      const map = readShared(data.value);
      shared[account.accountId] = map;
      if (learn(map)) learned = true;
      if (!map[self.accountId]) await share(account.accountId, { [self.accountId]: selfPerson() });
    }
    if (learned) await saveLocal();
    return learned;
  }

  /** Ask the directory for the names of ids seen on rows, a batch at a time. */
  function scheduleLookup() {
    if (!directoryAllowed || lookupTimer || unknown.size === 0 || typeof api.user?.findPeople !== 'function') return;
    const wait = Math.max(LOOKUP_DELAY_MS, lastLookup + LOOKUP_MIN_GAP_MS - Date.now());
    lookupTimer = setTimeout(() => { lookupTimer = null; void lookup(); }, wait);
  }

  async function lookup() {
    const ids = [...unknown].slice(0, LOOKUP_BATCH);
    for (const id of ids) { unknown.delete(id); asked.add(id); }
    if (ids.length === 0) return;
    lastLookup = Date.now();
    let result;
    try {
      result = await api.user.findPeople({ ids });
    } catch (err) {
      // Without directory:read (not granted) there's nothing to ask.
      if (/permission/i.test(String(err?.message ?? err))) directoryAllowed = false;
      return;
    }
    const found = {};
    for (const p of result?.people ?? []) {
      if (p.type !== 'group' && ids.includes(p.id)) found[p.id] = { name: p.name, email: p.email };
    }
    if (learn(found)) {
      await saveLocal();
      refreshBadges();
    }
    scheduleLookup();
  }

  function noteUnknown(id) {
    if (asked.has(id) || unknown.has(id) || nameOf(id)) return;
    unknown.add(id);
    scheduleLookup();
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
    unknown.clear();
    asked.clear();
    groupRetries = 0;
    const cached = await api.storage.get(PEOPLE_KEY);
    if (cached && typeof cached === 'object') learn(cached);
    await publish();
    // Rows drawn before the plugin knew the user carry no badges; the host
    // keeps that answer until asked again.
    refreshBadges();
    // Names come later, and a server that can't answer metadata may take a
    // while to fail; nothing waits for them.
    void loadGroups().then((learned) => { if (learned) refreshBadges(); });
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
      // Without a name, the id tells two unknown members apart.
      out.push({ id, kind, name: p?.name || t('choice.unknown'), email: p?.email || '', ...(p ? {} : { note: t('choice.unknown_id', { id }) }) });
    };
    add(self.accountId, 'me');
    for (const id of recentAssignees(new Map([...seen].map(([id, emails]) => [id, emails.size])), { exclude: [self.accountId] })) add(id, 'recent');
    for (const id of Object.keys(shared[accountId] ?? {})) add(id, 'member');
    return out;
  }

  /** The principal of a typed address: from the names known, else the directory. */
  async function resolveAddress(address, accountId) {
    const known = findByEmail({ ...people, [self.accountId]: selfPerson() }, address);
    if (known) return known;
    let result;
    try { result = await api.user.findPeople({ text: address, ...(accountId ? { accountId } : {}) }); } catch { result = null; }
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
      target = await resolveAddress(picked.address.trim().toLowerCase(), accountId);
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
        const changes = assignChanges(keywords, self.accountId);
        if (Object.keys(changes).length === 0) api.toast.info(t('toast.already_mine'));
        else await change(emailId, accountId, changes, t('toast.assigned_me'));
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

  function badgeFor(ids) {
    const mine = ids[0] === self.accountId;
    const names = ids.map((id) => (id === self.accountId ? t('badge.you') : nameOf(id)?.name ?? null));
    const first = mine ? t('badge.me') : nameOf(ids[0]) ? shortName(nameOf(ids[0])) : t('badge.assigned');
    const label = ids.length > 1 ? t('badge.more', { name: first, count: ids.length - 1 }) : first;
    let title;
    if (ids.length > 1) {
      title = t('badge.assigned_many', { names: names.map((n) => n ?? t('choice.unknown')).join(', ') });
    } else if (mine) {
      title = t('badge.assigned_me_title');
    } else {
      const p = nameOf(ids[0]);
      title = p ? t('badge.assigned_to', { name: p.email ? `${p.name} <${p.email}>` : p.name }) : t('badge.assigned_unknown');
    }
    return { key: BADGE.assignee, icon: 'user', label, title };
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
      // The user first when they are one of two.
      const ids = assigneesOf(keywords).sort((a, b) => Number(b === self.accountId) - Number(a === self.accountId));
      if (ids.length > 0) {
        for (const id of ids) {
          if (email?.id) {
            const messages = seen.get(id) ?? new Set();
            messages.add(email.id);
            seen.set(id, messages);
          }
          noteUnknown(id);
        }
        out.push(badgeFor(ids));
      }
      if (keywords.includes(DONE)) {
        out.push({ key: BADGE.done, icon: 'check', label: t('badge.done'), title: t('badge.done_title'), color: 'var(--color-success)' });
      }
      return out.length === before ? undefined : out;
    },

    onMailboxChange() {
      void ensureStarted().then(loadGroups).then((learned) => { if (learned) refreshBadges(); });
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
      if (!localeHooked) {
        localeHooked = true;
        api.i18n.onLocaleChange?.(() => { void publish(); });
      }
    },
    /** For tests. */
    get self() { return self; },
    get people() { return people; },
    choicesFor,
  };
}
