// What the model may look up while it answers (tool calls): the message a
// reply is for, the user's calendar, a contact's address, the user's mail.
// Each lookup goes through the webmail's api, so the plugin's permissions
// apply, and every one is shown in the chat as a step, with a card for
// what it found where that helps. Results are text for the model; mail and
// contact data in them is untrusted like everything else.

import { clip } from './prompts.js';
import { calendarWidget, contactParts, contactsWidget, emailsWidget } from './widgets.js';

/** Longest tool result handed to the model, in characters. */
export const MAX_TOOL_RESULT = 8000;
/** Longest stretch of days one calendar lookup covers. */
export const MAX_CALENDAR_DAYS = 31;
/** Most messages one mail search returns. */
export const MAX_SEARCH_RESULTS = 10;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const DEFINITIONS = {
  read_original_message: {
    description: 'Read the email the user is replying to or forwarding: sender, date, subject and text.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
  check_calendar: {
    description: 'List the user\'s calendar events between two dates (inclusive, at most 31 days), to find free or busy times. Dates are YYYY-MM-DD.',
    parameters: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'First day, YYYY-MM-DD' },
        to: { type: 'string', description: 'Last day, YYYY-MM-DD' },
      },
      required: ['from', 'to'],
      additionalProperties: false,
    },
  },
  find_contact: {
    description: 'Find a person in the user\'s address book by name or part of an email address: full name, email addresses, company.',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string', description: 'Name or part of the address' } },
      required: ['query'],
      additionalProperties: false,
    },
  },
  search_mail: {
    description: 'Search the user\'s mail. Returns the newest matching messages (id, sender, date, subject, a preview); read one with read_message. Give at least one of text, from, subject, after, before.',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Words to find in sender, recipients, subject or body (whole words)' },
        from: { type: 'string', description: 'Sender name or address' },
        subject: { type: 'string', description: 'Words of the subject' },
        after: { type: 'string', description: 'Only messages after this date, YYYY-MM-DD' },
        before: { type: 'string', description: 'Only messages before this date, YYYY-MM-DD' },
        limit: { type: 'integer', description: 'How many, 1 to 10 (default 5)' },
      },
      additionalProperties: false,
    },
  },
  find_setting: {
    description: 'Find where a setting or feature of this mail app is: the settings page, the setting\'s name as the user sees it, and what it does. Use it before telling the user where to change something. Query in English or the user\'s language, a few words (for example: undo send, automatic reply, dark mode, signature).',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string', description: 'A few words about the setting' } },
      required: ['query'],
      additionalProperties: false,
    },
  },
  read_my_settings: {
    description: 'Read how the user has set up the app: layout, theme, language and formats, mark-as-read delay, remote content, undo send delay, reply and signature options, notifications and more. Use it when the user asks why the app behaves as it does.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
  read_message: {
    description: 'Read one message of the user\'s mail by the id search_mail gave: sender, date, subject and text.',
    parameters: {
      type: 'object',
      properties: { id: { type: 'string', description: 'The message id from search_mail' } },
      required: ['id'],
      additionalProperties: false,
    },
  },
};

/**
 * The tools for a chat: `ctx.inReplyToId` offers the original message,
 * `ctx.lookups` (the user's setting) the calendar, the address book and mail.
 */
export function toolsFor(ctx = {}) {
  const names = [];
  if (ctx.inReplyToId) names.push('read_original_message');
  if (ctx.lookups !== false) names.push('check_calendar', 'find_contact', 'search_mail', 'read_message', 'read_my_settings');
  // Where a setting is: the app's own texts, nothing of the user's.
  names.push('find_setting');
  return names.map((name) => ({ name, ...DEFINITIONS[name] }));
}

function person(p) {
  if (!p) return '';
  return p.name && p.email ? `${p.name} <${p.email}>` : (p.email || p.name || '');
}

function addDays(date, days) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Events as lines the model reads: one per event, day first. */
export function formatEvents(events, { from, to, locale = 'en' } = {}) {
  if (!events.length) return `No events between ${from} and ${to}.`;
  const fmt = (value) => {
    if (!value) return '';
    try {
      return new Intl.DateTimeFormat(locale, { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(value));
    } catch {
      return value;
    }
  };
  const lines = events.slice(0, 60).map((e) => {
    const when = e.isAllDay ? `${String(e.start ?? '').slice(0, 10)} (all day)` : `${fmt(e.utcStart ?? e.start)}${e.utcEnd ? ` to ${fmt(e.utcEnd)}` : (e.duration ? `, ${e.duration}` : '')}`;
    const where = e.location ? ` at ${e.location}` : '';
    return `- ${when}: ${e.title || '(no title)'}${where}`;
  });
  if (events.length > 60) lines.push(`(${events.length - 60} more events not listed)`);
  return `Events between ${from} and ${to}, in the user's time zone:\n${lines.join('\n')}`;
}

/** Contacts as lines the model reads. */
export function formatContacts(contacts, query) {
  const list = contacts.slice(0, 5).map((c) => {
    const { name, emails, company } = contactParts(c);
    return `- ${name || '(no name)'}: ${emails.join(', ') || 'no email address'}${company ? ` (${company})` : ''}`;
  });
  return list.length ? `Contacts matching "${query}":\n${list.join('\n')}` : `No contact matches "${query}".`;
}

/** Settings found, as the user sees them: Settings > page > setting: what it does. */
export function formatSettings(results, query, settingsName = 'Settings') {
  if (!results.length) return `No setting matches "${query}". Try other words, or say that you do not know where it is.`;
  const lines = results.map((r) => `- ${settingsName} > ${r.page} > ${r.label}${r.description ? `: ${r.description}` : ''}`);
  return `Settings matching "${query}" (names as the user sees them):\n${lines.join('\n')}`;
}

/** Units of the settings that are numbers. */
const SETTING_UNITS = { markAsReadDelay: 'ms', autoSaveDraftInterval: 'ms', sendDelaySeconds: 's', sessionTimeout: 'min' };

/** The user's preferences as lines the model reads. */
export function formatMySettings(settings) {
  const entries = Object.entries(settings ?? {});
  if (!entries.length) return 'No settings could be read.';
  const lines = entries.map(([key, value]) => `- ${key}: ${Array.isArray(value) ? value.join(', ') : String(value)}${SETTING_UNITS[key] ? ` ${SETTING_UNITS[key]}` : ''}`);
  return `The user's settings (internal names; find_setting gives the names they see):\n${lines.join('\n')}`;
}

/** Search results as lines the model reads, with the ids read_message takes. */
export function formatMessages(messages, query) {
  const what = Object.entries(query).filter(([, v]) => v !== undefined && v !== '').map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(', ');
  if (!messages.length) return `No messages match (${what}).`;
  const lines = messages.map((m) => `- id ${m.id} | ${m.receivedAt ?? ''} | from ${m.from?.map(person).join(', ') || '?'} | ${m.subject || '(no subject)'}${m.preview ? ` | ${String(m.preview).slice(0, 120)}` : ''}`);
  return `Messages matching (${what}), newest first:\n${lines.join('\n')}`;
}

function messageText(email) {
  const from = Array.isArray(email.from) ? email.from.map(person).join(', ') : person(email.from);
  return clip(`From: ${from}\nDate: ${email.receivedAt ?? ''}\nSubject: ${email.subject ?? ''}\n\n${email.text ?? email.preview ?? ''}`, MAX_TOOL_RESULT);
}

/**
 * Run one tool. Resolves to text for the model, or { text, widget } with a
 * card for the panel; throws when the lookup failed (the chat tells the
 * model so).
 */
export async function runTool(api, name, args = {}, ctx = {}) {
  switch (name) {
    case 'read_original_message': {
      if (!ctx.inReplyToId) throw new Error('there is no original message');
      const email = await api.email.get(ctx.inReplyToId);
      if (!email) throw new Error('the message could not be read');
      return messageText(email);
    }
    case 'check_calendar': {
      const from = DATE_RE.test(args.from ?? '') ? args.from : null;
      let to = DATE_RE.test(args.to ?? '') ? args.to : from;
      if (!from) throw new Error('from must be a date like 2026-05-01');
      if (to < from) to = from;
      if (addDays(from, MAX_CALENDAR_DAYS) < to) to = addDays(from, MAX_CALENDAR_DAYS);
      // `to` of the api is exclusive: the day after the last day.
      const events = (await api.calendar.getEvents({ from, to: addDays(to, 1) })) ?? [];
      return {
        text: clip(formatEvents(events, { from, to, locale: api.i18n?.getLocale?.() ?? 'en' }), MAX_TOOL_RESULT),
        widget: calendarWidget(events, { from, to }),
      };
    }
    case 'find_contact': {
      const query = String(args.query ?? '').trim().slice(0, 200);
      if (!query) throw new Error('query is empty');
      const contacts = (await api.contacts.search(query)) ?? [];
      return { text: clip(formatContacts(contacts, query), MAX_TOOL_RESULT), widget: contactsWidget(contacts) };
    }
    case 'search_mail': {
      const query = {};
      for (const key of ['text', 'from', 'subject']) {
        const value = String(args[key] ?? '').trim().slice(0, 200);
        if (value) query[key] = value;
      }
      for (const key of ['after', 'before']) {
        if (args[key] !== undefined && args[key] !== '') {
          if (!DATE_RE.test(String(args[key]))) throw new Error(`${key} must be a date like 2026-05-01`);
          query[key] = args[key];
        }
      }
      if (!Object.keys(query).length) throw new Error('give at least one of text, from, subject, after or before');
      const limit = Math.min(MAX_SEARCH_RESULTS, Math.max(1, Number(args.limit) || 5));
      const messages = (await api.email.search({ ...query, limit })) ?? [];
      return { text: clip(formatMessages(messages, query), MAX_TOOL_RESULT), widget: emailsWidget(messages) };
    }
    case 'find_setting': {
      const query = String(args.query ?? '').trim().slice(0, 200);
      if (!query) throw new Error('query is empty');
      const results = (await api.app.searchSettings(query, { limit: 6 })) ?? [];
      return clip(formatSettings(results, query, ctx.settingsName), MAX_TOOL_RESULT);
    }
    case 'read_my_settings': {
      const settings = await api.app.getSettings();
      return clip(formatMySettings(settings), MAX_TOOL_RESULT);
    }
    case 'read_message': {
      const id = String(args.id ?? '').trim();
      if (!id) throw new Error('id is empty');
      const email = await api.email.get(id);
      if (!email) throw new Error('no message with that id');
      return messageText(email);
    }
    default:
      throw new Error(`unknown tool ${name}`);
  }
}
