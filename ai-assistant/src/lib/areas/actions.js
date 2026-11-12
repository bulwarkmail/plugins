// Area "actions" of the 2.2 work: its lookups and actions (shapes in README.md).
//
// More things the assistant can do for the user: answer an invitation,
// change or delete an event, tag messages, set or turn off the
// out-of-office reply, create a filter, act on many messages at once,
// change a setting and change a contact. Most of them always ask first
// (alwaysAsk), whatever the user's mode. None of them moves data out of the
// account: no forwarding, redirecting, rejecting or discarding filters, no
// out-of-office while it forwards mail, no moves to the trash.
//
// Whether an action is offered (`available(ctx)`) depends on the admin
// (areaAllowed, settingsChangesAllowed, batchLimit), the user's mode and
// switch (ctx.actions, ctx.prefs.doActions) and the host calls this webmail
// offers (ctx.doCaps, from actionCaps(api) in the panel's hook).
//
// This file must not import ../actions.js or ../tools.js: they import the
// areas, and the cycle would leave this module's export undefined.

import { has } from '../caps.js';
import { areaAllowed, batchLimit, settingsChangesAllowed } from '../config.js';
import { clip } from '../prompts.js';
import { contactParts } from '../widgets.js';
import EN from '../../locales/actions/en.json';

// ─── What the user may switch ─────────────────────────────────

/** The user's switches (prefs.doActions) and their defaults: settings changes are off until the user turns them on. */
export const ACTION_GROUPS = {
  invitations: true,
  events: true,
  tags: true,
  vacation: true,
  filters: true,
  batch: true,
  settings: false,
  contacts: true,
};

/** Whether the user left a group of actions on (prefs.doActions). */
export function groupOn(prefs, group) {
  const value = prefs?.doActions?.[group];
  return typeof value === 'boolean' ? value : ACTION_GROUPS[group] === true;
}

const fn = (api, method) => {
  const [ns, name] = method.split('.');
  return typeof api?.[ns]?.[name] === 'function';
};

/**
 * Which of this area's host calls the webmail offers. The out-of-office
 * actions also need vacation.get to say whether it forwards mail; the panel's
 * hook checks that once (ctx.doVacationKnown).
 */
export function actionCaps(api) {
  return {
    invitations: has(api, 'answerInvitation', 'calendar.respond'),
    updateEvent: fn(api, 'calendar.getEvent') && fn(api, 'calendar.updateEvent'),
    // Only with the host's undo, so a deleted event can always come back.
    deleteEvent: fn(api, 'calendar.getEvent') && fn(api, 'calendar.deleteEvent') && fn(api, 'calendar.undoDelete'),
    tags: fn(api, 'email.get') && fn(api, 'email.updateKeywords') && fn(api, 'keywords.list'),
    vacation: typeof api?.host?.features === 'object' && !!api.host.features && fn(api, 'vacation.get') && fn(api, 'vacation.set'),
    filters: has(api, 'filterRules', 'filters.create') && fn(api, 'filters.undo') && fn(api, 'mailboxes.list'),
    filtersRead: has(api, 'filterRules', 'filters.list'),
    batch: has(api, 'batchMail', 'email.batch') && fn(api, 'email.undoBatch'),
    settings: has(api, 'changeSettings', 'app.setSettings') && fn(api, 'app.describeSettings') && fn(api, 'app.undoSettings'),
    contacts: fn(api, 'contacts.get') && fn(api, 'contacts.update') && fn(api, 'contacts.search'),
  };
}

/** Which switches the settings show: those whose host calls exist. */
export function groupsOffered(api) {
  const c = actionCaps(api);
  return {
    invitations: c.invitations,
    events: c.updateEvent || c.deleteEvent,
    tags: c.tags,
    vacation: c.vacation,
    filters: c.filters,
    batch: c.batch,
    settings: c.settings,
    contacts: c.contacts,
  };
}

const capOf = (ctx, name) => ctx?.doCaps?.[name] === true;

/** An action of `group` may be offered: the admin left the area on, actions are on, the user's switch is on. */
function actionOn(ctx, group) {
  return areaAllowed(ctx?.config ?? {}, 'actions')
    && !!ctx?.actions && ctx.actions !== 'off'
    && groupOn(ctx?.prefs, group);
}

/** A lookup of this area may be offered: lookups on and the area allowed. */
function lookupOn(ctx) {
  return ctx?.lookups !== false && areaAllowed(ctx?.config ?? {}, 'actions');
}

// ─── Small helpers ────────────────────────────────────────────

/** An error whose `reason` is the locale key of what the user reads on the card; the message is for the model. */
export function refusal(reasonKey, message) {
  const err = new Error(message);
  err.reason = reasonKey;
  return err;
}

const text = (value, max = 500) => String(value ?? '').trim().slice(0, max);
const fill = (template, vars = {}) => String(template).replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
/** The English texts of this area, for what the model reads. */
const english = (key, vars) => fill(EN[key] ?? key, vars);

/** Longest text an action saves for the user (event description, out-of-office): the card shows it whole. */
export const MAX_SHOWN_TEXT = 1000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DATE_TIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/;
const EMAIL_RE = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

function localeOf(api) {
  return api?.i18n?.dateLocale || api?.i18n?.getLocale?.() || 'en';
}

const hour12Of = (api) => (typeof api?.i18n?.hour12 === 'boolean' ? { hour12: api.i18n.hour12 } : {});

/** A wall-clock value ('2026-11-03' or '2026-11-03T10:00') as milliseconds, read as UTC. */
const wallMs = (value) => Date.parse(value.length <= 10 ? `${value}T00:00:00Z` : `${value.slice(0, 16)}:00Z`);

/** A wall-clock date or date and time in words: "Tuesday, 3 November, 10:00". */
export function wallClock(api, value) {
  const v = String(value ?? '');
  if (!DATE_RE.test(v.slice(0, 10))) return v;
  const time = v.length > 10 ? v.slice(11, 16) : '';
  try {
    const at = new Date(`${v.slice(0, 10)}T${time || '00:00'}:00Z`);
    const day = new Intl.DateTimeFormat(localeOf(api), { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' }).format(at);
    if (!time) return day;
    return `${day}, ${new Intl.DateTimeFormat(localeOf(api), { hour: '2-digit', minute: '2-digit', timeZone: 'UTC', ...hour12Of(api) }).format(at)}`;
  } catch {
    return v;
  }
}

/** Seconds of an ISO 8601 duration (P1D, PT1H30M), or 0. */
function durationSeconds(value) {
  const m = /^P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(String(value ?? ''));
  if (!m) return 0;
  const [, w, d, h, min, s] = m.map((x) => Number(x ?? 0));
  return (((w * 7 + d) * 24 + h) * 60 + min) * 60 + s;
}

/** A wall-clock value plus seconds, in the same form. */
function plusSeconds(value, seconds) {
  const allDay = value.length <= 10;
  const at = new Date(wallMs(value));
  at.setUTCSeconds(at.getUTCSeconds() + seconds);
  return allDay ? at.toISOString().slice(0, 10) : at.toISOString().slice(0, 16);
}

/** When an event is, in words: "Tuesday, 3 November, 10:00–11:00", or the days of an all-day event. */
function eventWhen(api, start, durationSecs, allDay) {
  if (!start) return '';
  if (allDay) {
    const last = durationSecs > 86400 ? plusSeconds(start.slice(0, 10), durationSecs - 86400) : null;
    return last ? `${wallClock(api, start.slice(0, 10))} – ${wallClock(api, last)}` : wallClock(api, start.slice(0, 10));
  }
  const first = wallClock(api, start.slice(0, 16));
  if (!durationSecs) return first;
  const end = plusSeconds(start.slice(0, 16), durationSecs);
  if (end.slice(0, 10) !== start.slice(0, 10)) return `${first} – ${wallClock(api, end)}`;
  try {
    return `${first}–${new Intl.DateTimeFormat(localeOf(api), { hour: '2-digit', minute: '2-digit', timeZone: 'UTC', ...hour12Of(api) }).format(new Date(wallMs(end)))}`;
  } catch {
    return first;
  }
}

/** A wall-clock time in a zone as an instant ('2026-11-09T00:00' in Europe/Berlin → '2026-11-08T23:00:00.000Z'). */
export function zonedInstant(local, zone) {
  let tz = zone || 'UTC';
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); } catch { tz = 'UTC'; }
  const wall = wallMs(local);
  const offset = (at) => {
    const p = {};
    for (const part of new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(at))) p[part.type] = part.value;
    return Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute)) - at;
  };
  let at = wall - offset(wall);
  at = wall - offset(at);
  return new Date(at).toISOString();
}

/** The folder a name or role means: the role first, then the name, then a unique partial match (as in ../actions.js). */
function findFolder(mailboxes, wanted) {
  const want = text(wanted, 200).toLowerCase();
  if (!want) return null;
  const roles = { spam: 'junk', 'deleted items': 'trash', bin: 'trash' };
  const role = roles[want] ?? want;
  return mailboxes.find((m) => m.role === role)
    ?? mailboxes.find((m) => String(m.name ?? '').toLowerCase() === want)
    ?? (() => {
      const partial = mailboxes.filter((m) => String(m.name ?? '').toLowerCase().includes(want));
      return partial.length === 1 ? partial[0] : null;
    })();
}

async function folderFor(api, wanted) {
  const mailboxes = (await api.mailboxes.list()) ?? [];
  const folder = findFolder(mailboxes, wanted);
  if (!folder) throw new Error(`no folder "${text(wanted, 100)}"; the folders are: ${mailboxes.map((m) => m.name).join(', ')}`);
  // Moving mail to the trash comes close to deleting it, which the assistant never does.
  if (folder.role === 'trash') throw refusal('do.refuse.trash', 'refused: the assistant never moves messages to the trash');
  return folder;
}

/** One of the user's tags, by id or name (keywords.list). */
async function tagFor(api, wanted) {
  const tags = (await api.keywords.list()) ?? [];
  const want = text(wanted, 100).toLowerCase();
  if (!want) throw new Error('tag is empty');
  const tag = tags.find((k) => String(k.id).toLowerCase() === want)
    ?? tags.find((k) => String(k.label ?? '').toLowerCase() === want)
    ?? (() => {
      const partial = tags.filter((k) => String(k.label ?? '').toLowerCase().includes(want));
      return partial.length === 1 ? partial[0] : null;
    })();
  if (!tag) throw new Error(`no tag "${text(wanted, 100)}"; the tags are: ${tags.map((k) => k.label || k.id).join(', ') || 'none'}`);
  return tag;
}

async function messageFor(api, id) {
  const messageId = text(id, 200);
  if (!messageId) throw new Error('id is empty');
  const email = await api.email.get(messageId);
  if (!email) throw new Error('no message with that id');
  return email;
}

const senderOf = (email) => {
  const from = Array.isArray(email?.from) ? email.from[0] : email?.from;
  return from?.name || from?.email || '…';
};

/** A line "What: old → new" of a card. */
const changeLine = (t, what, before, after) => t('do.line', {
  what,
  old: before === '' || before == null ? t('do.none') : before,
  new: after === '' || after == null ? t('do.none') : after,
});

const MESSAGE_ID = { type: 'string', description: 'The message id: the open message\'s, or one from search_mail' };

// ─── Invitations ──────────────────────────────────────────────

const INVITE_STATUS = ['accepted', 'tentative', 'declined'];

/** The ORGANIZER address of the invitation a message carries (its .ics), or null. */
export async function invitationOrganizer(api, email) {
  const part = (email.attachments ?? []).find((a) => /calendar/i.test(a.type ?? '') || /\.ics$/i.test(a.name ?? ''));
  if (!part?.blobId || typeof api.email?.getAttachment !== 'function') return null;
  try {
    const file = await api.email.getAttachment(email.id, part.blobId);
    const ics = new TextDecoder().decode(file.data).replace(/\r?\n[ \t]/g, '');
    const m = /^ORGANIZER[^:\r\n]*:(?:mailto:)?([^\s]+)$/im.exec(ics);
    return m ? m[1].trim() : null;
  } catch {
    return null;
  }
}

const answerInvitation = {
  name: 'answer_invitation',
  description: 'Answer a calendar invitation in a message: accept, maybe (tentative) or decline. Bulwark sends the answer to the organiser. Only when the user asks for it.',
  parameters: {
    type: 'object',
    properties: {
      emailId: { type: 'string', description: 'The invitation message\'s id; default: the open message' },
      status: { type: 'string', enum: INVITE_STATUS },
    },
    required: ['status'],
    additionalProperties: false,
  },
  icon: 'calendar-check',
  // An answer goes to the organiser at once and can't be taken back.
  alwaysAsk: true,
  available: (ctx) => actionOn(ctx, 'invitations') && capOf(ctx, 'invitations'),
  async describe(api, args, ctx) {
    const status = text(args.status, 20);
    if (!INVITE_STATUS.includes(status)) throw new Error(`status must be one of ${INVITE_STATUS.join(', ')}`);
    const id = text(args.emailId, 200) || ctx?.openEmailId;
    if (!id) throw new Error('no invitation: give emailId, or open the invitation');
    const email = await messageFor(api, id);
    const t = api.i18n.t;
    // Where the answer goes: the organiser the invitation names, which need
    // not be the sender shown on the message.
    const organizer = await invitationOrganizer(api, email);
    const lines = [t(`do.invite.${status}`, { title: email.subject || '…', from: senderOf(email) })];
    lines.push(organizer ? t('do.invite.goes_to', { address: organizer }) : t('do.invite.goes_to_unknown'));
    return { summary: lines.join('\n'), plan: { emailId: email.id, status, subject: email.subject ?? '' } };
  },
  async perform(api, plan) {
    const answer = await api.calendar.respond(plan.emailId, plan.status);
    if (!answer) throw new Error('the answer was stopped and not sent');
    const to = answer.organizer ? ` to ${answer.organizer}` : ' to the organiser';
    return { text: `Done: answered "${answer.status ?? plan.status}" to "${answer.title || plan.subject}" and sent the answer${to}. This can't be undone; to change it, answer again.`, undo: null };
  },
  async undo() {
    throw new Error('an answer to an invitation can\'t be undone');
  },
};

// ─── Events ───────────────────────────────────────────────────

async function eventFor(api, id) {
  const eventId = text(id, 300);
  if (!eventId) throw new Error('id is empty');
  const event = await api.calendar.getEvent(eventId);
  if (!event) throw new Error('no event with that id; check_calendar gives the ids');
  return event;
}

/** Whether an event repeats or is one occurrence of a series (fields of newer webmails included). */
export function isRepeating(event) {
  return !!(event?.isRecurring || event?.repeat || event?.recurrenceId || event?.isOccurrence || event?.baseEventId || event?.recurrenceRules?.length);
}

async function userAddresses(api) {
  const safe = async (call) => { try { return (await call()) ?? []; } catch { return []; } };
  const [identities, accounts] = await Promise.all([safe(() => api.user.getIdentities()), safe(() => api.user.getAccounts())]);
  return new Set([...identities, ...accounts].map((x) => String(x?.email ?? '').toLowerCase()).filter(Boolean));
}

/** Someone besides the user takes part in the event. */
async function hasOtherPeople(api, event) {
  const people = Array.isArray(event.participants) ? event.participants : [];
  if (!people.length) return false;
  const mine = await userAddresses(api);
  return people.some((p) => !mine.has(String(p.email ?? '').toLowerCase()));
}

/** The user organises or owns the event: nobody else is in it, or its owner is one of the user's addresses. */
async function ownsEvent(api, event) {
  const people = Array.isArray(event.participants) ? event.participants : [];
  if (!people.length) return true;
  const owner = people.find((p) => String(p.role ?? '').split(',').map((r) => r.trim()).includes('owner'));
  if (!owner?.email) return false;
  return (await userAddresses(api)).has(String(owner.email).toLowerCase());
}

/**
 * The event is in a calendar of another account: one someone shared with
 * the user or gave them access to. The webmail's view marks those only by
 * the "<accountId>:" in front of the event's and the calendar's ids.
 */
const inOtherAccount = (event) => event?.isShared === true || String(event?.id ?? '').includes(':') || String(event?.calendarId ?? '').includes(':');

/**
 * The event is the user's alone: in the user's own calendars, nobody else
 * listed, and the user its owner when anyone is listed. False whenever the
 * view can't tell (no participant list, the user's addresses unreadable, no
 * owner among the people listed).
 */
async function ownsAlone(api, event) {
  if (inOtherAccount(event) || !Array.isArray(event.participants)) return false;
  if (await hasOtherPeople(api, event)) return false;
  return ownsEvent(api, event);
}

const updateEvent = {
  name: 'update_event',
  description: 'Change an event in the user\'s calendar: title, start, end, place, description or all day. Times are the user\'s local time, YYYY-MM-DDTHH:MM, or YYYY-MM-DD for all-day events. It never changes the people invited.',
  parameters: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'The event id from check_calendar' },
      title: { type: 'string' },
      start: { type: 'string', description: 'YYYY-MM-DDTHH:MM, or YYYY-MM-DD for all day' },
      end: { type: 'string', description: 'Same form as start; for all-day events the last day' },
      location: { type: 'string' },
      description: { type: 'string' },
      isAllDay: { type: 'boolean' },
    },
    required: ['id'],
    additionalProperties: false,
  },
  icon: 'calendar-event',
  available: (ctx) => actionOn(ctx, 'events') && capOf(ctx, 'updateEvent'),
  async describe(api, args) {
    const t = api.i18n.t;
    const event = await eventFor(api, args.id);
    const patch = {};
    const lines = [];
    if (args.title !== undefined) {
      const title = text(args.title);
      if (!title) throw new Error('title is empty');
      if (title !== event.title) { patch.title = title; lines.push(changeLine(t, t('do.field.title'), event.title, title)); }
    }
    if (args.location !== undefined) {
      const location = text(args.location);
      if (location !== (event.location ?? '')) { patch.location = location; lines.push(changeLine(t, t('do.field.place'), event.location, location)); }
    }
    if (args.description !== undefined) {
      const description = text(args.description, MAX_SHOWN_TEXT + 1);
      // The card shows the new text whole, so nothing is saved the user didn't see.
      if (description.length > MAX_SHOWN_TEXT) throw new Error(`description is longer than ${MAX_SHOWN_TEXT} characters; keep it shorter`);
      if (description !== (event.description ?? '')) { patch.description = description; lines.push(changeLine(t, t('do.field.description'), clip(event.description ?? '', 80), description)); }
    }
    const wasAllDay = !!event.isAllDay;
    const oldStart = wasAllDay ? String(event.start ?? '').slice(0, 10) : String(event.start ?? '').slice(0, 16);
    const isAllDay = typeof args.isAllDay === 'boolean' ? args.isAllDay : undefined;
    const start = args.start !== undefined ? text(args.start, 30) : undefined;
    const end = args.end !== undefined ? text(args.end, 30) : undefined;
    if (start !== undefined || end !== undefined || (isAllDay !== undefined && isAllDay !== wasAllDay)) {
      const allDay = isAllDay ?? (start ? DATE_RE.test(start) : wasAllDay);
      const form = allDay ? DATE_RE : DATE_TIME_RE;
      if (start !== undefined && !form.test(start)) throw new Error(`start must look like ${allDay ? '2026-05-04' : '2026-05-04T10:00'}`);
      if (end !== undefined && !form.test(end)) throw new Error(`end must have the same form as start (${allDay ? 'YYYY-MM-DD' : 'YYYY-MM-DDTHH:MM'})`);
      const newStart = start !== undefined ? (allDay ? start : start.slice(0, 16)) : (allDay ? oldStart.slice(0, 10) : `${oldStart.slice(0, 10)}T${oldStart.slice(11, 16) || '09:00'}`);
      // An all-day event's end is the day after its last day.
      const newEnd = end !== undefined ? (allDay ? plusSeconds(end, 86400) : end.slice(0, 16)) : undefined;
      if (newEnd !== undefined && wallMs(newEnd) <= wallMs(newStart)) throw new Error('end is before start');
      if (allDay !== wasAllDay) patch.isAllDay = allDay;
      if (start !== undefined || patch.isAllDay !== undefined) patch.start = newStart;
      if (newEnd !== undefined) patch.end = newEnd;
      const oldSecs = durationSeconds(event.duration);
      const newSecs = newEnd !== undefined ? (wallMs(newEnd) - wallMs(newStart)) / 1000 : (allDay === wasAllDay ? oldSecs : (allDay ? 86400 : 3600));
      lines.push(changeLine(t, t('do.field.time'), eventWhen(api, oldStart, oldSecs, wasAllDay), eventWhen(api, newStart, newSecs, allDay)));
    }
    if (!Object.keys(patch).length) throw new Error('nothing to change: give a field with a new value');
    const summary = [t('do.event.update', { title: event.title || '…' }), ...lines].join('\n');
    // What Undo writes back: the old values of the fields that change.
    const before = {};
    if ('title' in patch) before.title = event.title;
    if ('location' in patch) before.location = event.location ?? '';
    if ('description' in patch) before.description = event.description ?? '';
    if ('start' in patch || 'end' in patch || 'isAllDay' in patch) {
      before.isAllDay = wasAllDay;
      before.start = oldStart;
      if (event.duration) before.duration = event.duration;
      if (!wasAllDay && event.timeZone) before.timeZone = event.timeZone;
    }
    // An event that isn't the user's alone always asks first, whichever field
    // changes: other people take part in it (they read its title, place and
    // description, and a new time moves the meeting in their calendars), it
    // is in a calendar someone shared, the user is listed but not as its
    // owner, or the view can't tell. An event of the user alone follows the
    // mode.
    const alwaysAsk = !(await ownsAlone(api, event));
    return { summary, plan: { id: event.id, title: patch.title ?? event.title ?? '', patch, before }, alwaysAsk };
  },
  async perform(api, plan) {
    await api.calendar.updateEvent(plan.id, plan.patch);
    return { text: `Done: the event "${plan.title}" is changed (${Object.keys(plan.patch).join(', ')}).`, undo: { id: plan.id, patch: plan.before } };
  },
  async undo(api, undo) {
    await api.calendar.updateEvent(undo.id, undo.patch);
  },
};

const deleteEvent = {
  name: 'delete_event',
  description: 'Delete one event from the user\'s calendar: a single event the user created, not a repeating one and not one someone else invited them to.',
  parameters: {
    type: 'object',
    properties: { id: { type: 'string', description: 'The event id from check_calendar' } },
    required: ['id'],
    additionalProperties: false,
  },
  icon: 'calendar-x',
  alwaysAsk: true,
  available: (ctx) => actionOn(ctx, 'events') && capOf(ctx, 'deleteEvent'),
  async describe(api, args) {
    const event = await eventFor(api, args.id);
    if (isRepeating(event)) throw refusal('do.refuse.repeating', 'refused: the event repeats or is one occurrence of a series; the user deletes repeating events in the calendar');
    if (!(await ownsEvent(api, event))) throw refusal('do.refuse.not_own_event', 'refused: someone else organises this event; the user can decline it or delete it in the calendar');
    const start = String(event.start ?? '');
    const when = event.isAllDay ? wallClock(api, start.slice(0, 10)) : wallClock(api, start.slice(0, 16));
    return { summary: api.i18n.t('do.event.delete', { title: event.title || '…', when }), plan: { id: event.id, title: event.title ?? '' } };
  },
  async perform(api, plan) {
    const result = await api.calendar.deleteEvent(plan.id);
    const token = typeof result?.undoToken === 'string' && result.undoToken ? result.undoToken : null;
    return {
      text: `Done: the event "${plan.title}" is deleted.${token ? '' : ' It can\'t be undone.'}`,
      undo: token ? { token } : null,
    };
  },
  async undo(api, undo) {
    await api.calendar.undoDelete(undo.token);
  },
};

// ─── Tags ─────────────────────────────────────────────────────

function tagAction(name, on) {
  return {
    name,
    description: on
      ? 'Tag a message with one of the user\'s tags (by the tag\'s name).'
      : 'Remove one of the user\'s tags from a message (by the tag\'s name).',
    parameters: {
      type: 'object',
      properties: { id: MESSAGE_ID, tag: { type: 'string', description: 'The tag\'s name' } },
      required: ['id', 'tag'],
      additionalProperties: false,
    },
    icon: on ? 'tag' : 'tag-off',
    available: (ctx) => actionOn(ctx, 'tags') && capOf(ctx, 'tags'),
    async describe(api, args) {
      const email = await messageFor(api, args.id);
      const tag = await tagFor(api, args.tag);
      const keyword = `$label:${tag.id}`;
      const keywords = Array.isArray(email.keywords) ? email.keywords : Object.keys(email.keywords ?? {});
      const had = keywords.some((k) => String(k).toLowerCase() === keyword.toLowerCase());
      const summary = api.i18n.t(on ? 'do.tag.add' : 'do.tag.remove', { subject: email.subject || '…', tag: tag.label || tag.id });
      return { summary, plan: { id: email.id, keyword, had, label: tag.label || tag.id, subject: email.subject ?? '' } };
    },
    async perform(api, plan) {
      await api.email.updateKeywords(plan.id, { [plan.keyword]: on });
      return {
        text: on ? `Done: "${plan.subject}" is tagged ${plan.label}.` : `Done: the tag ${plan.label} is removed from "${plan.subject}".`,
        undo: { id: plan.id, keyword: plan.keyword, had: plan.had },
      };
    },
    async undo(api, undo) {
      await api.email.updateKeywords(undo.id, { [undo.keyword]: undo.had });
    },
  };
}

// ─── Out-of-office ────────────────────────────────────────────

/** The reply as it is now; refuses while it forwards mail, and on webmails that can't tell. */
async function vacationNow(api) {
  const vacation = await api.vacation.get();
  if (!vacation || typeof vacation.forwardActive !== 'boolean') throw new Error('this webmail can\'t tell whether the out-of-office forwards mail, so the assistant doesn\'t change it');
  if (vacation.forwardActive) throw refusal('do.refuse.vacation_forward', 'refused: the out-of-office forwards mail; the user changes it in Settings > Out of office');
  return vacation;
}

/** What Undo writes back: the reply as it was. */
const vacationBefore = (v) => ({
  isEnabled: !!v.isEnabled,
  subject: v.subject ?? '',
  textBody: v.textBody ?? '',
  htmlBody: v.htmlBody ? v.htmlBody : null,
  fromDate: v.fromDate ?? null,
  toDate: v.toDate ?? null,
});

async function saveVacation(api, input) {
  const saved = await api.vacation.set(input);
  if (saved === null) throw new Error('the change was stopped and not saved');
}

const setVacation = {
  name: 'set_vacation',
  description: 'Turn on the user\'s out-of-office reply with a subject and text, optionally from and until a date. Dates are the user\'s local time, YYYY-MM-DD or YYYY-MM-DDTHH:MM; "to" is the last day.',
  parameters: {
    type: 'object',
    properties: {
      subject: { type: 'string' },
      text: { type: 'string', description: 'The reply, plain text' },
      from: { type: 'string', description: 'First day, YYYY-MM-DD or YYYY-MM-DDTHH:MM; default now' },
      to: { type: 'string', description: 'Last day, YYYY-MM-DD or YYYY-MM-DDTHH:MM; default until turned off' },
    },
    required: ['subject', 'text'],
    additionalProperties: false,
  },
  icon: 'plane',
  alwaysAsk: true,
  available: (ctx) => actionOn(ctx, 'vacation') && capOf(ctx, 'vacation') && ctx?.doVacationKnown === true,
  async describe(api, args, ctx) {
    const t = api.i18n.t;
    const subject = text(args.subject, 501);
    const body = text(args.text, MAX_SHOWN_TEXT + 1);
    if (!subject) throw new Error('subject is empty');
    if (!body) throw new Error('text is empty');
    // The card shows subject and text whole: what goes out to everyone who
    // writes is exactly what the user saw.
    if (subject.length > 500) throw new Error('subject is longer than 500 characters; keep it shorter');
    if (body.length > MAX_SHOWN_TEXT) throw new Error(`text is longer than ${MAX_SHOWN_TEXT} characters; keep the out-of-office reply shorter`);
    const from = text(args.from, 30) || null;
    const to = text(args.to, 30) || null;
    for (const [key, value] of [['from', from], ['to', to]]) {
      if (value && !DATE_RE.test(value) && !DATE_TIME_RE.test(value)) throw new Error(`${key} must look like 2026-05-04 or 2026-05-04T17:00`);
    }
    const zone = ctx?.zone || api?.i18n?.timeZone || 'UTC';
    const fromDate = from ? zonedInstant(DATE_RE.test(from) ? from : from.slice(0, 16), zone) : null;
    // A last day ends at midnight after it.
    const toDate = to ? zonedInstant(DATE_RE.test(to) ? plusSeconds(to, 86400) : to.slice(0, 16), zone) : null;
    if (fromDate && toDate && toDate <= fromDate) throw new Error('to is before from');
    const before = vacationBefore(await vacationNow(api));
    const head = from && to ? t('do.vacation.set_range', { from: wallClock(api, from), to: wallClock(api, to) })
      : from ? t('do.vacation.set_from', { from: wallClock(api, from) })
        : to ? t('do.vacation.set_until', { to: wallClock(api, to) })
          : t('do.vacation.set_now');
    const summary = [head, t('do.vacation.subject', { subject }), t('do.vacation.text', { text: body })].join('\n');
    return { summary, plan: { input: { isEnabled: true, subject, textBody: body, htmlBody: null, fromDate, toDate }, before } };
  },
  async perform(api, plan) {
    await vacationNow(api);
    await saveVacation(api, plan.input);
    const when = [plan.input.fromDate && `from ${plan.input.fromDate}`, plan.input.toDate && `until ${plan.input.toDate}`].filter(Boolean).join(' ');
    return { text: `Done: the out-of-office reply is on${when ? ` ${when}` : ''}.`, undo: { before: plan.before } };
  },
  async undo(api, undo) {
    // The forward may have been set since: check again before switching the reply back on.
    await vacationNow(api);
    await saveVacation(api, undo.before);
  },
};

const turnOffVacation = {
  name: 'turn_off_vacation',
  description: 'Turn off the user\'s out-of-office reply.',
  parameters: { type: 'object', properties: {}, additionalProperties: false },
  icon: 'plane-off',
  alwaysAsk: true,
  available: (ctx) => actionOn(ctx, 'vacation') && capOf(ctx, 'vacation') && ctx?.doVacationKnown === true,
  async describe(api) {
    const now = await vacationNow(api);
    if (!now.isEnabled) throw new Error('the out-of-office reply is already off');
    const lines = [api.i18n.t('do.vacation.off')];
    if (now.subject) lines.push(api.i18n.t('do.vacation.subject', { subject: now.subject }));
    return { summary: lines.join('\n'), plan: { before: vacationBefore(now) } };
  },
  async perform(api, plan) {
    await vacationNow(api);
    await saveVacation(api, { isEnabled: false });
    return { text: 'Done: the out-of-office reply is off.', undo: { before: plan.before } };
  },
  async undo(api, undo) {
    // The forward may have been set since: check again before switching the reply back on.
    await vacationNow(api);
    await saveVacation(api, undo.before);
  },
};

const getVacation = {
  name: 'get_vacation',
  description: 'Read the user\'s out-of-office reply: on or off, dates, subject and text.',
  parameters: { type: 'object', properties: {}, additionalProperties: false },
  icon: 'plane',
  kind: 'do.kind.vacation',
  label: (t) => t('do.step.get_vacation'),
  available: (ctx) => lookupOn(ctx) && capOf(ctx, 'vacation') && ctx?.doVacationKnown === true,
  async run(api, args, ctx) {
    const v = (await api.vacation.get()) ?? {};
    const zone = ctx?.zone;
    const when = (value) => {
      if (!value) return 'not set';
      try {
        return new Intl.DateTimeFormat('en-GB', { dateStyle: 'full', timeStyle: 'short', ...(zone ? { timeZone: zone } : {}) }).format(new Date(value));
      } catch {
        return value;
      }
    };
    const lines = [
      `The out-of-office reply is ${v.isEnabled ? 'on' : 'off'}.`,
      `From: ${when(v.fromDate)}`,
      `Until: ${when(v.toDate)}`,
      `Subject: ${v.subject || '(none)'}`,
      `Text:\n${clip(v.textBody || '(none)', 3000)}`,
    ];
    if (v.forwardActive === true) lines.push('It also forwards mail to another address while it is on (set in Settings > Out of office; the assistant can\'t change that).');
    return lines.join('\n');
  },
};

// ─── Filters ──────────────────────────────────────────────────

export const FILTER_FIELDS = ['from', 'to', 'cc', 'subject', 'body', 'header', 'size', 'attachment'];
export const FILTER_OPS = ['contains', 'not_contains', 'is', 'not_is', 'starts_with', 'ends_with', 'address_is', 'domain_is', 'greater_than', 'less_than', 'has_any', 'has_type'];
/** The only things a filter of the assistant may do. Forward, redirect, reject, discard and keep don't exist here. */
export const FILTER_ACTIONS = ['move', 'copy', 'mark_read', 'star', 'add_label', 'stop'];

const sizeText = (value) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return String(value);
  if (n >= 1048576) return `${Math.round((n / 1048576) * 10) / 10} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} B`;
};

/** One condition in words, with `t` (the user's language, or English for the model). */
function conditionWords(t, c) {
  const field = FILTER_FIELDS.includes(c.field) ? t(`do.filter.field.${c.field}`, { header: c.headerName ?? '' }) : String(c.field);
  const values = (Array.isArray(c.value) ? c.value : [c.value]).filter((v) => v !== undefined && v !== null && v !== '');
  const value = values.map((v) => (c.field === 'size' ? sizeText(v) : String(v))).join(t('do.filter.or'));
  if (!FILTER_OPS.includes(c.op)) return `${field} ${c.op} “${value}”`;
  return t(`do.filter.op.${c.op}`, { field, value });
}

/** One action in words; ones the assistant can't create (forward, reject, ...) only show in list_filters. */
function actionWords(t, a, tagLabel) {
  switch (a.type) {
    case 'move': case 'copy': return t(`do.filter.act.${a.type}`, { folder: a.folder ?? a.mailboxId ?? '' });
    case 'mark_read': case 'star': case 'stop': return t(`do.filter.act.${a.type}`);
    case 'add_label': return t('do.filter.act.add_label', { tag: tagLabel ? tagLabel(a.tagId) : (a.tagId ?? '') });
    default: return `${a.type}${a.value ? ` ${a.value}` : ''}`;
  }
}

/** A rule in plain words: "If the sender is newsletter@shop.example: move to “Newsletters”, mark as read". */
export function ruleWords(t, rule, tagLabel) {
  const conditions = (rule.conditions ?? []).map((c) => conditionWords(t, c)).join(t(rule.match === 'any' ? 'do.filter.or' : 'do.filter.and'));
  const actions = (rule.actions ?? []).map((a) => actionWords(t, a, tagLabel)).join(', ');
  return t('do.filter.rule', { conditions, actions });
}

function filterCondition(raw) {
  const field = text(raw?.field, 20);
  const op = text(raw?.op, 20);
  if (!FILTER_FIELDS.includes(field)) throw new Error(`condition field must be one of ${FILTER_FIELDS.join(', ')}`);
  if (!FILTER_OPS.includes(op)) throw new Error(`condition op must be one of ${FILTER_OPS.join(', ')}`);
  const out = { field, op };
  if (field === 'header') {
    const headerName = text(raw.headerName, 100);
    if (!/^[A-Za-z0-9-]+$/.test(headerName)) throw new Error('a header condition needs headerName');
    out.headerName = headerName;
  }
  if (op !== 'has_any') {
    const list = (Array.isArray(raw.value) ? raw.value : [raw.value]).map((v) => text(v, 500)).filter(Boolean).slice(0, 20);
    if (!list.length) throw new Error(`condition "${field} ${op}" needs a value`);
    if (field === 'size' && list.some((v) => !/^\d+$/.test(v))) throw new Error('a size is a number of bytes');
    out.value = list.length === 1 ? list[0] : list;
  }
  return out;
}

const createFilter = {
  name: 'create_filter',
  description: 'Create a mail filter for new messages: conditions (sender, recipient, subject, text, header, size, attachment) and what it does: move or copy to a folder, mark as read, star, tag, stop. Filters can\'t forward, redirect, reject or delete mail.',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string' },
      match: { type: 'string', enum: ['all', 'any'], description: 'All conditions must match (default), or any one' },
      conditions: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            field: { type: 'string', enum: FILTER_FIELDS },
            op: { type: 'string', enum: FILTER_OPS },
            value: { type: 'string', description: 'What to compare with; a size in bytes; none for has_any' },
            headerName: { type: 'string', description: 'For field header' },
          },
          required: ['field', 'op'],
          additionalProperties: false,
        },
      },
      actions: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            type: { type: 'string', enum: FILTER_ACTIONS },
            folder: { type: 'string', description: 'For move and copy: the folder\'s name' },
            tag: { type: 'string', description: 'For add_label: the tag\'s name' },
          },
          required: ['type'],
          additionalProperties: false,
        },
      },
    },
    required: ['conditions', 'actions'],
    additionalProperties: false,
  },
  icon: 'filter-plus',
  alwaysAsk: true,
  available: (ctx) => actionOn(ctx, 'filters') && capOf(ctx, 'filters'),
  async describe(api, args) {
    const t = api.i18n.t;
    const rawConditions = Array.isArray(args.conditions) ? args.conditions : [];
    const rawActions = Array.isArray(args.actions) ? args.actions : [];
    if (!rawConditions.length || rawConditions.length > 10) throw new Error('give 1 to 10 conditions');
    if (!rawActions.length || rawActions.length > 5) throw new Error('give 1 to 5 actions');
    const conditions = rawConditions.map(filterCondition);
    const actions = [];
    const shown = [];
    for (const raw of rawActions) {
      const type = text(raw?.type, 30);
      switch (type) {
        case 'move':
        case 'copy': {
          const folder = await folderFor(api, raw.folder);
          actions.push({ type, mailboxId: folder.id });
          shown.push({ type, folder: folder.name });
          break;
        }
        case 'mark_read':
        case 'star':
        case 'stop':
          actions.push({ type });
          shown.push({ type });
          break;
        case 'add_label': {
          const tag = await tagFor(api, raw.tag);
          actions.push({ type, tagId: tag.id });
          shown.push({ type, tagId: tag.label || tag.id });
          break;
        }
        default:
          // Forward, redirect, reject, discard, keep or anything else: never.
          throw refusal('do.refuse.filter_action', `refused: a filter of the assistant can only ${FILTER_ACTIONS.join(', ')}; it never forwards, redirects, rejects or deletes mail`);
      }
    }
    const match = args.match === 'any' ? 'any' : 'all';
    const conditionsOnly = (tr) => (match === 'any' ? conditions.map((c) => conditionWords(tr, c)).join(tr('do.filter.or')) : conditions.map((c) => conditionWords(tr, c)).join(tr('do.filter.and')));
    const name = text(args.name, 100) || clip(conditionsOnly(english), 60);
    return {
      summary: [t('do.filter.create', { name }), ruleWords(t, { match, conditions, actions: shown })].join('\n'),
      plan: { rule: { name, match, conditions, actions }, words: ruleWords(english, { match, conditions, actions: shown }) },
    };
  },
  async perform(api, plan) {
    const created = await api.filters.create(plan.rule);
    const token = typeof created?.undoToken === 'string' && created.undoToken ? created.undoToken : null;
    return { text: `Done: the filter "${plan.rule.name}" is created (${plan.words}). It works on new mail.`, undo: token ? { token } : null };
  },
  async undo(api, undo) {
    await api.filters.undo(undo.token);
  },
};

const listFilters = {
  name: 'list_filters',
  description: 'Read the user\'s mail filters (rules for new mail), in the order they run.',
  parameters: { type: 'object', properties: {}, additionalProperties: false },
  icon: 'filter',
  kind: 'do.kind.filters',
  label: (t) => t('do.step.list_filters'),
  available: (ctx) => lookupOn(ctx) && capOf(ctx, 'filtersRead'),
  async run(api) {
    const list = (await api.filters.list()) ?? {};
    if (list.supported === false) return 'This mail server has no filters.';
    const rules = Array.isArray(list.rules) ? list.rules : [];
    if (!rules.length) return 'The user has no filters.';
    let tags = [];
    try { tags = (await api.keywords.list()) ?? []; } catch { tags = []; }
    const tagLabel = (id) => tags.find((k) => k.id === id)?.label ?? id ?? '';
    const lines = rules.map((r) => `- "${r.name || '(no name)'}"${r.isActive === false ? ' (off)' : ''}: ${ruleWords(english, r, tagLabel)}`);
    const note = list.editable === false ? '\nThe filters were edited by hand, so the assistant can\'t add any.' : '';
    return clip(`The user's filters, in the order they run:\n${lines.join('\n')}${note}`, 8000);
  },
};

// ─── Many messages at once ────────────────────────────────────

export const BATCH_ACTIONS = ['archive', 'move', 'read', 'unread', 'tag', 'untag'];

const batchMessages = {
  name: 'batch_messages',
  description: 'Do one thing to several messages at once: archive, move to a folder, mark read or unread, tag or untag. Give the ids from search_mail, or a search; the user sees the count and confirms. For one message use the single-message actions.',
  parameters: {
    type: 'object',
    properties: {
      ids: { type: 'array', items: { type: 'string' }, description: 'Message ids from search_mail' },
      search: {
        type: 'object',
        description: 'Instead of ids: the messages that match (newest first)',
        properties: {
          text: { type: 'string' },
          from: { type: 'string' },
          subject: { type: 'string' },
          after: { type: 'string', description: 'YYYY-MM-DD' },
          before: { type: 'string', description: 'YYYY-MM-DD' },
          folder: { type: 'string', description: 'Only in this folder' },
        },
        additionalProperties: false,
      },
      action: { type: 'string', enum: BATCH_ACTIONS },
      folder: { type: 'string', description: 'For move: the folder\'s name' },
      tag: { type: 'string', description: 'For tag and untag: the tag\'s name' },
    },
    required: ['action'],
    additionalProperties: false,
  },
  icon: 'stack-2',
  alwaysAsk: true,
  available: (ctx) => actionOn(ctx, 'batch') && capOf(ctx, 'batch'),
  async describe(api, args, ctx) {
    const t = api.i18n.t;
    const action = text(args.action, 20);
    if (!BATCH_ACTIONS.includes(action)) throw new Error(`action must be one of ${BATCH_ACTIONS.join(', ')}`);
    const limit = batchLimit(ctx?.config ?? {});
    let ids;
    let subjects = [];
    let more = false;
    if (Array.isArray(args.ids) && args.ids.length) {
      ids = [...new Set(args.ids.map((id) => text(id, 200)).filter(Boolean))];
    } else if (args.search && typeof args.search === 'object') {
      const query = {};
      for (const key of ['text', 'from', 'subject']) {
        const value = text(args.search[key], 200);
        if (value) query[key] = value;
      }
      for (const key of ['after', 'before']) {
        const value = text(args.search[key], 20);
        if (value) {
          if (!DATE_RE.test(value)) throw new Error(`search.${key} must be a date like 2026-05-01`);
          query[key] = value;
        }
      }
      if (!Object.keys(query).length) throw new Error('search needs at least one of text, from, subject, after, before');
      if (args.search.folder) query.mailboxId = (await folderFor(api, args.search.folder)).id;
      // One more than allowed shows that there are too many; one search returns at most 50.
      const found = (await api.email.search({ ...query, limit: Math.min(50, limit + 1) })) ?? [];
      ids = [...new Set(found.map((m) => m.id))];
      subjects = found.slice(0, 5).map((m) => m.subject || '…');
      more = found.length >= 50;
    } else {
      throw new Error('give ids or a search');
    }
    if (ids.length === 0) throw new Error('no messages match');
    if (ids.length === 1) throw new Error(`only one message (id ${ids[0]}); use the single-message action for it`);
    if (ids.length > limit) throw refusal('do.refuse.batch_limit', `refused: that is ${ids.length} messages; at most ${limit} can be changed at once. Ask the user to narrow it down.`);
    const input = { emailIds: ids, action };
    const vars = { count: ids.length };
    if (action === 'move') {
      const folder = await folderFor(api, args.folder);
      input.mailboxId = folder.id;
      vars.folder = folder.name;
    }
    if (action === 'tag' || action === 'untag') {
      const tag = await tagFor(api, args.tag);
      input.tagId = tag.id;
      vars.tag = tag.label || tag.id;
    }
    if (!subjects.length) {
      for (const id of ids.slice(0, 5)) {
        try {
          const email = await api.email.get(id);
          if (email) subjects.push(email.subject || '…');
        } catch { /* a message that can't be read shows as one subject less */ }
      }
    }
    const lines = [t(`do.batch.${action}`, vars), ...subjects.map((s) => `• ${clip(s, 100)}`)];
    if (ids.length > subjects.length) lines.push(t('do.batch.more', { count: ids.length - subjects.length }));
    return { summary: lines.join('\n'), plan: { input, more } };
  },
  async perform(api, plan) {
    const result = await api.email.batch(plan.input);
    const done = Number(result?.done ?? 0);
    const failed = Number(result?.failed ?? 0);
    if (!done && failed) throw new Error(`none of the ${failed} messages could be changed`);
    const token = typeof result?.undoToken === 'string' && result.undoToken ? result.undoToken : null;
    const rest = plan.more ? ' More messages may match; run it again for them.' : '';
    return { text: `Done: ${plan.input.action} for ${done} messages${failed ? `; ${failed} could not be changed` : ''}.${rest}`, undo: token ? { token } : null };
  },
  async undo(api, undo) {
    await api.email.undoBatch(undo.token);
  },
};

// ─── Settings ─────────────────────────────────────────────────

const settingRefusal = (reason) => (reason === 'locked' ? 'do.refuse.setting_locked' : 'do.refuse.setting');

const changeSetting = {
  name: 'change_setting',
  description: 'Change one or more of the user\'s settings of this app, by the internal names read_my_settings gives: { key, value } or { changes: { key: value, ... } }. Only settings the assistant may change; never account, security, forwarding or plugin settings.',
  parameters: {
    type: 'object',
    properties: {
      key: { type: 'string' },
      value: { description: 'The new value: a string, number or boolean' },
      changes: { type: 'object', description: 'Several at once: { key: value }' },
    },
    additionalProperties: false,
  },
  icon: 'adjustments',
  alwaysAsk: true,
  // Off unless the admin allows it and the user turned it on.
  available: (ctx) => actionOn(ctx, 'settings') && settingsChangesAllowed(ctx?.config ?? {}) && capOf(ctx, 'settings'),
  async describe(api, args) {
    const t = api.i18n.t;
    const changes = {};
    if (args.changes && typeof args.changes === 'object' && !Array.isArray(args.changes)) Object.assign(changes, args.changes);
    if (typeof args.key === 'string' && args.key.trim()) changes[args.key.trim()] = args.value;
    const keys = Object.keys(changes);
    if (!keys.length) throw new Error('give key and value, or changes');
    if (keys.length > 20) throw new Error('at most 20 settings at once');
    const described = (await api.app.describeSettings(changes)) ?? {};
    const refused = keys.filter((k) => described[k]?.allowed !== true);
    if (refused.length) {
      const why = refused.map((k) => `${k}: ${described[k]?.reason ?? 'unknown'}`).join(', ');
      throw refusal(settingRefusal(described[refused[0]]?.reason), `refused: ${why}. A locked setting is set by the organisation; the others the assistant can't change. find_setting tells the user where to change it.`);
    }
    const label = (k) => described[k].label || k;
    const before = (k) => described[k].currentLabel ?? String(described[k].current ?? '');
    const after = (k) => described[k].nextLabel ?? String(described[k].next ?? changes[k]);
    const lines = keys.map((k) => changeLine(t, label(k), before(k), after(k)));
    const one = keys[0];
    const summary = keys.length === 1
      ? t('do.setting.change_one', { setting: label(one), old: before(one) || t('do.none'), new: after(one) || t('do.none') })
      : [t('do.setting.change_many'), ...lines].join('\n');
    return { summary, plan: { changes, words: keys.map((k) => `${label(k)}: ${before(k)} → ${after(k)}`).join('; ') } };
  },
  async perform(api, plan) {
    const result = (await api.app.setSettings(plan.changes)) ?? {};
    const applied = Object.keys(result.applied ?? {});
    const refused = Object.entries(result.refused ?? {});
    if (!applied.length) {
      throw refusal(settingRefusal(refused[0]?.[1]), `refused: ${refused.map(([k, r]) => `${k}: ${r}`).join(', ') || 'nothing changed'}`);
    }
    const token = typeof result.undoToken === 'string' && result.undoToken ? result.undoToken : null;
    const notDone = refused.length ? ` Not changed: ${refused.map(([k, r]) => `${k} (${r})`).join(', ')}.` : '';
    return { text: `Done: changed ${applied.join(', ')} (${plan.words}).${notDone}`, undo: token ? { token } : null };
  },
  async undo(api, undo) {
    const result = (await api.app.undoSettings(undo.token)) ?? {};
    const refused = Object.keys(result.refused ?? {});
    if (refused.length) throw new Error(`could not restore ${refused.join(', ')}`);
  },
};

// ─── Contacts ─────────────────────────────────────────────────

function nameOf(fullName) {
  const words = fullName.split(/\s+/);
  return {
    components: words.length > 1
      ? [{ kind: 'given', value: words[0] }, { kind: 'surname', value: words.slice(1).join(' ') }]
      : [{ kind: 'given', value: fullName }],
    isOrdered: true,
    full: fullName,
  };
}

/** A JSContact map from a list, keeping the entries (with their labels) of values that stay. */
function keyedList(old, values, field, prefix) {
  const entries = Object.entries(old ?? {});
  const out = {};
  let n = 1;
  for (const value of values) {
    const kept = entries.find(([, e]) => String(e?.[field] ?? '').toLowerCase() === value.toLowerCase());
    if (kept) { out[kept[0]] = kept[1]; continue; }
    while (`${prefix}${n}` in out || entries.some(([k]) => k === `${prefix}${n}`)) n++;
    out[`${prefix}${n}`] = { [field]: value };
  }
  return out;
}

const listOf = (value, max) => (value === undefined ? undefined : (Array.isArray(value) ? value : String(value).split(/[,;]/)))
  ?.map((v) => text(v, 200)).filter(Boolean).slice(0, max);

const digits = (value) => String(value ?? '').replace(/\D/g, '');

/** Addresses in a text, whole (the same pattern as knownRecipient in ../actions.js). */
const ADDRESS_IN_TEXT = /[^\s@<>"',;()]+@[^\s@<>"',;()]+\.[^\s@<>"',;().]+/g;

/**
 * Whether the user typed this address or number in the chat themselves
 * (ctx.userText). An address counts only whole: "ann@example.org" is not in
 * "joann@example.org". One the model took from a message could send the
 * user's future mail to someone else, so the card points it out.
 */
export function typedByUser(ctx, value) {
  const typed = String(ctx?.userText ?? '');
  if (!typed) return false;
  if (value.includes('@')) return (typed.match(ADDRESS_IN_TEXT) ?? []).some((a) => a.toLowerCase() === value.toLowerCase());
  const d = digits(value);
  return d.length > 0 && digits(typed).includes(d);
}

const updateContact = {
  name: 'update_contact',
  description: 'Change a contact in the user\'s address book: name, email addresses, phone numbers, company or postal address. emails and phones are the full new lists. Find the contact by id or by a name or address (query).',
  parameters: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'The contact\'s id' },
      query: { type: 'string', description: 'Instead of id: a name or address that finds exactly one contact' },
      name: { type: 'string' },
      emails: { type: 'array', items: { type: 'string' } },
      phones: { type: 'array', items: { type: 'string' } },
      company: { type: 'string' },
      address: { type: 'string', description: 'The postal address in one line' },
    },
    additionalProperties: false,
  },
  icon: 'user-edit',
  alwaysAsk: true,
  available: (ctx) => actionOn(ctx, 'contacts') && capOf(ctx, 'contacts'),
  async describe(api, args, ctx) {
    const t = api.i18n.t;
    let card;
    const id = text(args.id, 200);
    if (id) {
      card = await api.contacts.get(id);
      if (!card) throw new Error('no contact with that id');
    } else {
      const query = text(args.query, 200);
      if (!query) throw new Error('give id or query');
      const found = (await api.contacts.search(query)) ?? [];
      if (!found.length) throw new Error(`no contact matches "${query}"`);
      if (found.length > 1) {
        const list = found.slice(0, 5).map((c) => { const p = contactParts(c); return `${p.name || '(no name)'} ${p.emails[0] ?? ''} (id ${c.id})`; }).join('; ');
        throw new Error(`${found.length} contacts match "${query}"; give the id of one: ${list}`);
      }
      card = (await api.contacts.get(found[0].id)) ?? found[0];
    }
    const old = contactParts(card);
    const patch = {};
    const lines = [];
    if (args.name !== undefined) {
      const name = text(args.name, 200);
      if (!name) throw new Error('name is empty');
      if (name !== old.name) { patch.name = nameOf(name); lines.push(changeLine(t, t('do.field.name'), old.name, name)); }
    }
    const emails = listOf(args.emails, 10);
    if (emails) {
      const bad = emails.find((e) => !EMAIL_RE.test(e));
      if (bad) throw new Error(`"${bad}" is not an address`);
      const before = Object.values(card.emails ?? {}).map((e) => e?.address).filter(Boolean);
      if (emails.join('\n').toLowerCase() !== before.join('\n').toLowerCase()) {
        patch.emails = emails.length ? keyedList(card.emails, emails, 'address', 'e') : null;
        lines.push(changeLine(t, t('do.field.emails'), before.join(', '), emails.join(', ')));
        const known = new Set(before.map((e) => e.toLowerCase()));
        for (const e of emails) if (!known.has(e.toLowerCase()) && !typedByUser(ctx, e)) lines.push(t('do.contact.check_email', { value: e }));
      }
    }
    const phones = listOf(args.phones, 10);
    if (phones) {
      const before = Object.values(card.phones ?? {}).map((p) => p?.number).filter(Boolean);
      if (phones.join('\n') !== before.join('\n')) {
        patch.phones = phones.length ? keyedList(card.phones, phones, 'number', 'p') : null;
        lines.push(changeLine(t, t('do.field.phones'), before.join(', '), phones.join(', ')));
        const known = new Set(before.map(digits));
        for (const p of phones) if (!known.has(digits(p)) && !typedByUser(ctx, p)) lines.push(t('do.contact.check_phone', { value: p }));
      }
    }
    if (args.company !== undefined) {
      const company = text(args.company, 200);
      if (company !== old.company) {
        const [key, org] = Object.entries(card.organizations ?? {})[0] ?? ['o1', {}];
        patch.organizations = company ? { [key]: { ...org, name: company } } : null;
        lines.push(changeLine(t, t('do.field.company'), old.company, company));
      }
    }
    if (args.address !== undefined) {
      const address = text(args.address, 500);
      const [key, first] = Object.entries(card.addresses ?? {})[0] ?? ['a1', null];
      const before = first?.full || first?.fullAddress || [first?.street, first?.postcode, first?.locality, first?.country].filter(Boolean).join(', ') || '';
      if (address !== before) {
        patch.addresses = address ? { [key]: { full: address } } : null;
        lines.push(changeLine(t, t('do.field.address'), before, address));
      }
    }
    if (!Object.keys(patch).length) throw new Error('nothing to change: give a field with a new value');
    // Undo writes the old card's properties back (null where there were none).
    const before = Object.fromEntries(Object.keys(patch).map((k) => [k, card[k] === undefined ? null : card[k]]));
    const who = old.name || old.emails[0] || '';
    return { summary: [t('do.contact.update', { name: who || '…' }), ...lines].join('\n'), plan: { id: card.id, name: who, patch, before } };
  },
  async perform(api, plan) {
    await api.contacts.update(plan.id, plan.patch);
    return { text: `Done: the contact ${plan.name} is changed (${Object.keys(plan.patch).join(', ')}).`, undo: { id: plan.id, patch: plan.before } };
  },
  async undo(api, undo) {
    await api.contacts.update(undo.id, undo.patch);
  },
};

export default {
  tools: [getVacation, listFilters],
  actions: [
    answerInvitation,
    updateEvent,
    deleteEvent,
    tagAction('tag_message', true),
    tagAction('untag_message', false),
    setVacation,
    turnOffVacation,
    createFilter,
    batchMessages,
    changeSetting,
    updateContact,
  ],
};
