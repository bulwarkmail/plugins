// What the assistant may do for the user (tool calls that change things),
// when the user turned actions on: archive, move or mark a message, add a
// calendar event, a task or a contact, open a reply or a new message in the
// composer. It never sends and never deletes mail.
//
// Each action runs in two steps so the panel can show it before it happens:
// describeAction() checks the arguments, looks up what they refer to (the
// message's subject, the folder) and returns a plan with a summary in the
// user's language; performAction() carries the plan out and returns the text
// for the model and, where it can be taken back, how to undo it.

import { areaAction, areaActions, offered } from './areas/index.js';

const ADDRESS_IN_TEXT = /[^\s@<>"',;()]+@[^\s@<>"',;()]+\.[^\s@<>"',;().]+/g;

/** Whether the user named `address`: typed in the chat (ctx.userTyped) or a participant of the open message (ctx.participants). */
export function knownRecipient(address, ctx = {}) {
  const wanted = String(address ?? '').trim().toLowerCase();
  if (!wanted) return false;
  const typed = (String(ctx.userTyped ?? '').match(ADDRESS_IN_TEXT) ?? []).map((a) => a.toLowerCase());
  const people = (ctx.participants ?? []).map((a) => String(a).toLowerCase());
  return typed.includes(wanted) || people.includes(wanted);
}

/** Most actions one answer may take without asking, in automatic mode. */
export const MAX_AUTO_ACTIONS = 5;

/** The modes of the setting, from least to most. */
export const ACTION_MODES = ['off', 'manual', 'auto'];

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DATE_TIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/;
const EMAIL_RE = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

const MESSAGE_ID = { type: 'string', description: 'The message id: the open message\'s, or one from search_mail' };

export const ACTION_DEFINITIONS = {
  archive_message: {
    description: 'Archive a message (move it to the Archive folder).',
    parameters: { type: 'object', properties: { id: MESSAGE_ID }, required: ['id'], additionalProperties: false },
  },
  move_message: {
    description: 'Move a message to another folder of the user, by the folder\'s name or role (inbox, archive, junk, trash).',
    parameters: {
      type: 'object',
      properties: { id: MESSAGE_ID, folder: { type: 'string', description: 'Folder name, or inbox, archive, junk, trash' } },
      required: ['id', 'folder'],
      additionalProperties: false,
    },
  },
  mark_message: {
    description: 'Mark a message read or unread, starred or not. Give read, starred or both.',
    parameters: {
      type: 'object',
      properties: { id: MESSAGE_ID, read: { type: 'boolean' }, starred: { type: 'boolean' } },
      required: ['id'],
      additionalProperties: false,
    },
  },
  create_event: {
    description: 'Add an event to the user\'s calendar. Times are the user\'s local time, YYYY-MM-DDTHH:MM; a date alone (YYYY-MM-DD) makes an all-day event.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        start: { type: 'string', description: 'YYYY-MM-DDTHH:MM, or YYYY-MM-DD for all day' },
        end: { type: 'string', description: 'Same form as start; for all-day events the last day. Default: one hour, or the one day' },
        location: { type: 'string' },
        description: { type: 'string' },
      },
      required: ['title', 'start'],
      additionalProperties: false,
    },
  },
  create_task: {
    description: 'Add a task to the user\'s task list.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        due: { type: 'string', description: 'YYYY-MM-DD or YYYY-MM-DDTHH:MM, optional' },
        description: { type: 'string' },
      },
      required: ['title'],
      additionalProperties: false,
    },
  },
  create_contact: {
    description: 'Add a person to the user\'s address book.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        email: { type: 'string' },
        phone: { type: 'string' },
        company: { type: 'string' },
      },
      required: ['name'],
      additionalProperties: false,
    },
  },
  draft_reply: {
    description: 'Open a reply to the open message in the composer, starting with the given text, for the user to check and send. It does not send.',
    parameters: {
      type: 'object',
      properties: { text: { type: 'string', description: 'The reply text, without subject or signature' }, all: { type: 'boolean', description: 'Reply to all' } },
      required: ['text'],
      additionalProperties: false,
    },
  },
  draft_email: {
    description: 'Open a new message in the composer, filled in, for the user to check and send. It does not send.',
    parameters: {
      type: 'object',
      properties: {
        to: { type: 'array', items: { type: 'string' }, description: 'Email addresses' },
        subject: { type: 'string' },
        body: { type: 'string', description: 'Plain text, without signature' },
      },
      required: ['to', 'subject', 'body'],
      additionalProperties: false,
    },
  },
};

export const ACTION_TOOLS = new Set(Object.keys(ACTION_DEFINITIONS));
export const isActionTool = (name) => ACTION_TOOLS.has(name) || !!areaAction(name);

/**
 * The action tools for a chat. `ctx.actions` is the mode ('off' offers
 * none); a reply is offered only next to an open message (the webmail opens
 * replies to that one only), a new message only outside the composer.
 */
export function actionToolsFor(ctx = {}) {
  if (!ctx.actions || ctx.actions === 'off') return [];
  const core = Object.entries(ACTION_DEFINITIONS)
    .filter(([name]) => (name === 'draft_reply' ? !!ctx.openEmailId : name === 'draft_email' ? ctx.mode !== 'composer' : true))
    .map(([name, def]) => ({ name, ...def }));
  // The 2.2 areas' actions (src/lib/areas), where they are offered.
  const extra = areaActions().filter((action) => offered(action, ctx)).map(({ name, description, parameters }) => ({ name, description, parameters }));
  return [...core, ...extra];
}

/** The mode in effect: the user's choice, at most what the administrator allows. */
export function effectiveActionMode(config = {}, prefs = {}) {
  const limit = ACTION_MODES.includes(config.actions) ? config.actions : 'auto';
  const want = ACTION_MODES.includes(prefs.actions) ? prefs.actions : 'off';
  return ACTION_MODES.indexOf(want) <= ACTION_MODES.indexOf(limit) ? want : limit;
}

const text = (value, max = 500) => String(value ?? '').trim().slice(0, max);

async function messageFor(api, id) {
  const messageId = text(id, 200);
  if (!messageId) throw new Error('id is empty');
  const email = await api.email.get(messageId);
  if (!email) throw new Error('no message with that id');
  return email;
}

/** The folder a name or role means: the role first, then the name, then a unique partial match. */
export function findFolder(mailboxes, wanted) {
  const want = text(wanted, 200).toLowerCase();
  if (!want) return null;
  const roles = { spam: 'junk', 'deleted items': 'trash', bin: 'trash' };
  const role = roles[want] ?? want;
  return mailboxes.find((m) => m.role === role)
    ?? mailboxes.find((m) => m.name.toLowerCase() === want)
    ?? (() => {
      const partial = mailboxes.filter((m) => m.name.toLowerCase().includes(want));
      return partial.length === 1 ? partial[0] : null;
    })();
}

function formatWhen(locale, start, end, allDay) {
  const day = (value) => new Intl.DateTimeFormat(locale, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${value.slice(0, 10)}T00:00:00Z`));
  const time = (value) => value.slice(11, 16);
  try {
    if (allDay) return end && end !== start ? `${day(start)} – ${day(end)}` : day(start);
    if (end && end.slice(0, 10) === start.slice(0, 10)) return `${day(start)}, ${time(start)}–${time(end)}`;
    if (end) return `${day(start)}, ${time(start)} – ${day(end)}, ${time(end)}`;
    return `${day(start)}, ${time(start)}`;
  } catch {
    return end ? `${start} – ${end}` : start;
  }
}

function nextDay(date) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/**
 * Check an action and say what it will do. Resolves to { summary, plan };
 * throws with a message for the model when the arguments are wrong.
 */
export async function describeAction(api, name, args = {}, ctx = {}) {
  const area = areaAction(name);
  if (area) {
    if (!offered(area, ctx)) throw new Error(`${name} is not available here`);
    const { summary, plan } = await area.describe(api, args, ctx);
    const alwaysAsk = typeof area.alwaysAsk === 'function' ? area.alwaysAsk(args, ctx) === true : area.alwaysAsk === true;
    return { summary, plan: { ...plan, name, area: area.area }, alwaysAsk };
  }
  const t = api.i18n.t;
  // (draft_email sets alwaysAsk itself; the other core actions follow the mode.)
  const locale = api.i18n?.getLocale?.() ?? 'en';
  switch (name) {
    case 'archive_message': {
      const email = await messageFor(api, args.id);
      return { summary: t('action.archive', { subject: email.subject || '…' }), plan: { name, email } };
    }
    case 'move_message': {
      const email = await messageFor(api, args.id);
      const mailboxes = (await api.mailboxes.list()) ?? [];
      const folder = findFolder(mailboxes, args.folder);
      if (!folder) throw new Error(`no folder "${text(args.folder, 100)}"; the folders are: ${mailboxes.map((m) => m.name).join(', ')}`);
      return { summary: t('action.move', { subject: email.subject || '…', folder: folder.name }), plan: { name, email, folder } };
    }
    case 'mark_message': {
      const email = await messageFor(api, args.id);
      const read = typeof args.read === 'boolean' ? args.read : undefined;
      const starred = typeof args.starred === 'boolean' ? args.starred : undefined;
      if (read === undefined && starred === undefined) throw new Error('give read, starred or both');
      const subject = email.subject || '…';
      const parts = [];
      if (read !== undefined) parts.push(t(read ? 'action.mark_read' : 'action.mark_unread', { subject }));
      if (starred !== undefined) parts.push(t(starred ? 'action.star' : 'action.unstar', { subject }));
      return { summary: parts.join(' · '), plan: { name, email, read, starred } };
    }
    case 'create_event': {
      const title = text(args.title);
      if (!title) throw new Error('title is empty');
      const start = text(args.start, 30);
      const allDay = DATE_RE.test(start);
      if (!allDay && !DATE_TIME_RE.test(start)) throw new Error('start must look like 2026-05-04T10:00 or 2026-05-04');
      let end = text(args.end, 30) || undefined;
      if (end && !(allDay ? DATE_RE : DATE_TIME_RE).test(end)) throw new Error(`end must have the same form as start (${allDay ? 'YYYY-MM-DD' : 'YYYY-MM-DDTHH:MM'})`);
      if (end && end < start) throw new Error('end is before start');
      const input = { title, start: allDay ? start : start.slice(0, 16), isAllDay: allDay };
      if (allDay) input.end = nextDay(end ?? start);
      else if (end) input.end = end.slice(0, 16);
      else input.duration = 'PT1H';
      const location = text(args.location);
      const description = text(args.description, 5000);
      if (location) input.location = location;
      if (description) input.description = description;
      const shownEnd = allDay ? end : (end ?? null);
      return { summary: t('action.create_event', { title, when: formatWhen(locale, start, shownEnd, allDay) }), plan: { name, input } };
    }
    case 'create_task': {
      const title = text(args.title);
      if (!title) throw new Error('title is empty');
      const due = text(args.due, 30) || undefined;
      if (due && !DATE_RE.test(due) && !DATE_TIME_RE.test(due)) throw new Error('due must look like 2026-05-04 or 2026-05-04T17:00');
      const input = { title };
      if (due) input.due = due.slice(0, 16);
      const description = text(args.description, 5000);
      if (description) input.description = description;
      const summary = due
        ? t('action.create_task_due', { title, due: formatWhen(locale, due, null, DATE_RE.test(due)) })
        : t('action.create_task', { title });
      return { summary, plan: { name, input } };
    }
    case 'create_contact': {
      const fullName = text(args.name, 200);
      const email = text(args.email, 200);
      const phone = text(args.phone, 50);
      const company = text(args.company, 200);
      if (!fullName) throw new Error('name is empty');
      if (email && !EMAIL_RE.test(email)) throw new Error('email is not an address');
      const words = fullName.split(/\s+/);
      const card = {
        name: {
          components: words.length > 1
            ? [{ kind: 'given', value: words[0] }, { kind: 'surname', value: words.slice(1).join(' ') }]
            : [{ kind: 'given', value: fullName }],
          isOrdered: true,
          full: fullName,
        },
        ...(email ? { emails: { e1: { address: email } } } : {}),
        ...(phone ? { phones: { p1: { number: phone } } } : {}),
        ...(company ? { organizations: { o1: { name: company } } } : {}),
      };
      return { summary: t('action.create_contact', { who: email ? `${fullName} <${email}>` : fullName }), plan: { name, card } };
    }
    case 'draft_reply': {
      if (!ctx.openEmailId) throw new Error('a reply can be opened only for the open message');
      const email = await messageFor(api, ctx.openEmailId);
      const body = text(args.text, 20000);
      if (!body) throw new Error('text is empty');
      const all = args.all === true;
      return { summary: t(all ? 'action.draft_reply_all' : 'action.draft_reply', { subject: email.subject || '…' }), plan: { name, email, text: body, all } };
    }
    case 'draft_email': {
      const to = (Array.isArray(args.to) ? args.to : String(args.to ?? '').split(/[,;]/)).map((a) => text(a, 200)).filter(Boolean).slice(0, 20);
      if (!to.length) throw new Error('to is empty');
      const bad = to.find((a) => !EMAIL_RE.test(a));
      if (bad) throw new Error(`"${bad}" is not an address; find_contact gives addresses`);
      const subject = text(args.subject, 300);
      const body = text(args.body, 20000);
      // Recipients the model chose ask first, whatever the mode: an address
      // counts as the user's only when they typed it in the chat or it is a
      // participant of the open message (never one found only in data).
      const alwaysAsk = to.some((a) => !knownRecipient(a, ctx));
      return { summary: t('action.draft_email', { to: to.join(', '), subject: subject || '…' }), plan: { name, message: { to, subject, body } }, alwaysAsk };
    }
    default:
      throw new Error(`unknown action ${name}`);
  }
}

/**
 * Carry out a plan. Resolves to { text, undo } (undo null when the action
 * can't be taken back); throws when the webmail refused.
 */
export async function performAction(api, plan) {
  const area = plan?.area ? areaAction(plan.name) : null;
  if (area) {
    const done = await area.perform(api, plan);
    return { text: done?.text ?? 'Done.', undo: done?.undo ? { ...done.undo, action: plan.name } : null };
  }
  switch (plan.name) {
    case 'archive_message':
    case 'move_message': {
      const { email } = plan;
      const from = Array.isArray(email.mailboxIds) ? email.mailboxIds[0] : undefined;
      if (plan.name === 'archive_message') await api.email.archive([email.id]);
      else await api.email.move([email.id], plan.folder.id);
      const where = plan.name === 'archive_message' ? 'archived' : `moved to ${plan.folder.name}`;
      return { text: `Done: the message "${email.subject ?? ''}" is ${where}.`, undo: from ? { kind: 'move', id: email.id, mailboxId: from } : null };
    }
    case 'mark_message': {
      const { email, read, starred } = plan;
      if (read !== undefined) await (read ? api.email.setKeyword(email.id, '$seen') : api.email.removeKeyword(email.id, '$seen'));
      if (starred !== undefined) await (starred ? api.email.setKeyword(email.id, '$flagged') : api.email.removeKeyword(email.id, '$flagged'));
      const undo = { kind: 'keywords', id: email.id };
      if (read !== undefined) undo.read = !!email.isRead;
      if (starred !== undefined) undo.starred = !!email.isFlagged;
      return { text: `Done: the message "${email.subject ?? ''}" is marked.`, undo };
    }
    case 'create_event': {
      const event = await api.calendar.createEvent(plan.input);
      return { text: `Done: the event "${plan.input.title}" is in the calendar.`, undo: event?.id ? { kind: 'event', id: event.id } : null };
    }
    case 'create_task': {
      const task = await api.tasks.create(plan.input);
      return { text: `Done: the task "${plan.input.title}" is added.`, undo: task?.id ? { kind: 'task', id: task.id } : null };
    }
    case 'create_contact': {
      const card = await api.contacts.create(plan.card);
      return { text: `Done: ${plan.card.name.full} is in the address book.`, undo: card?.id ? { kind: 'contact', id: card.id } : null };
    }
    case 'draft_reply': {
      const opened = await api.compose.reply(plan.email.id, { text: plan.text, all: plan.all });
      if (opened === false) throw new Error('the composer did not open');
      return { text: 'Done: the reply is open in the composer for the user to check and send (not sent).', undo: null };
    }
    case 'draft_email': {
      await api.compose.open(plan.message);
      return { text: 'Done: the message is open in the composer for the user to check and send (not sent).', undo: null };
    }
    default:
      throw new Error(`unknown action ${plan.name}`);
  }
}

/** Take an action back. */
export async function undoAction(api, undo) {
  const area = undo?.action ? areaAction(undo.action) : null;
  if (area) return area.undo(api, undo);
  switch (undo?.kind) {
    case 'move': return api.email.move([undo.id], undo.mailboxId);
    case 'keywords':
      if (undo.read !== undefined) await (undo.read ? api.email.setKeyword(undo.id, '$seen') : api.email.removeKeyword(undo.id, '$seen'));
      if (undo.starred !== undefined) await (undo.starred ? api.email.setKeyword(undo.id, '$flagged') : api.email.removeKeyword(undo.id, '$flagged'));
      return undefined;
    case 'event': return api.calendar.deleteEvent(undo.id);
    case 'task': return api.tasks.delete(undo.id);
    case 'contact': return api.contacts.remove(undo.id);
    default: throw new Error('nothing to undo');
  }
}
