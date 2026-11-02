// Area "everywhere" of the 2.2 work: the assistant next to Calendar,
// Contacts, Files and Settings (the webmail's app-side-panel), and Catch me
// up. No lookups or actions of its own: what a view shows goes into the
// prompt, and Catch me up gathers its data before it asks the model.

import { clock, dateIn, addDays, whenIn } from '../clock.js';
import { clip } from '../prompts.js';
import { normalizeWidget } from '../widgets.js';
import { has } from '../caps.js';

/** The views of the app-side-panel. Mail has the reader's panel. */
export const VIEWS = ['calendar', 'contacts', 'files', 'settings'];
export const APP_PANEL = 'app-side-panel';

/** When the user last looked: the start of "unread since". Set when a panel closes, and every 10 minutes while one is open. */
export const LAST_VISIT_KEY = 'view:lastVisit';
export const LAST_VISIT_EVERY_MS = 10 * 60_000;
/** Without a last visit: the last day. */
export const FIRST_VISIT_HOURS = 24;
/** Unread messages one Catch me up looks at. */
export const MAX_UNREAD = 30;
/** Sent messages whose threads it checks for a reply. */
export const MAX_WAITING_THREADS = 20;
export const WAITING_DAYS = 7;
/** Longest text of the data the model reads, in characters. */
export const MAX_BRIEF_CHARS = 20_000;

/** The view a panel's props name, or null (the reader, the composer). */
export function viewOf(props) {
  return VIEWS.includes(props?.view) ? props.view : null;
}

const cleanText = (value, max = 300) => (typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : '');
const person = (p) => (p ? (p.name && p.email ? `${p.name} <${p.email}>` : (p.email || p.name || '')) : '');

/**
 * What the view shows, for the model: the open event, contact, selected
 * files or settings page, as data inside tags. `context` is the
 * app-side-panel's context prop; the webmail leaves out each part the
 * plugin has no permission for.
 */
export function viewBlock(view, context = {}, zone) {
  if (!viewOf({ view })) return '';
  const names = { calendar: 'Calendar', contacts: 'Contacts', files: 'Files', settings: 'Settings' };
  const lines = [`The panel is open next to ${names[view]}, not next to a message. There is no open message: do not offer to reply to one.`];
  const data = [];
  const c = context ?? {};
  if (view === 'calendar' && c.event) {
    const e = c.event;
    const when = e.isAllDay
      ? `${String(e.start ?? '').slice(0, 10)} (all day)`
      : `${whenIn(zone, e.utcStart ?? e.start) || e.start}${e.utcEnd ? ` to ${whenIn(zone, e.utcEnd)}` : (e.duration ? `, ${e.duration}` : '')}`;
    data.push([
      `Title: ${cleanText(e.title, 200) || '(no title)'}`,
      `When: ${when}${e.isRecurring ? ', repeats' : ''}`,
      e.location ? `Where: ${cleanText(e.location, 200)}` : '',
      e.participants?.length ? `Participants: ${e.participants.slice(0, 30).map((p) => `${person(p)}${p.status ? ` (${p.status})` : ''}`).join(', ')}` : '',
      e.description ? `Description:\n${clip(e.description, 4000)}` : '',
    ].filter(Boolean).join('\n'));
    lines.push('The user has this calendar event open:');
  }
  if (view === 'contacts') {
    if (c.selectedCount > 0) lines.push(`${c.selectedCount} contacts are ticked in the list.`);
    if (c.contact) {
      const p = c.contact;
      data.push([
        `Name: ${cleanText(p.fullName, 200) || [p.firstName, p.lastName].filter(Boolean).join(' ') || '(no name)'}`,
        p.emails?.length ? `Email addresses: ${p.emails.slice(0, 10).join(', ')}` : '',
        p.phones?.length ? `Phone numbers: ${p.phones.slice(0, 10).join(', ')}` : '',
        p.company ? `Company: ${cleanText(p.company, 200)}` : '',
        p.anniversaries?.length ? `Dates: ${p.anniversaries.slice(0, 10).map((a) => `${a.kind} ${a.date}`).join(', ')}` : '',
        p.notes ? `Notes:\n${clip(p.notes, 2000)}` : '',
      ].filter(Boolean).join('\n'));
      lines.push('The user has this contact open:');
    }
  }
  if (view === 'files') {
    if (c.folder?.path) lines.push(`The open folder is ${cleanText(c.folder.path, 500)}.`);
    if (Array.isArray(c.files) && c.files.length) {
      data.push(c.files.slice(0, 20).map((f) => {
        const about = [f.mimeType, f.size ? `${f.size} bytes` : '', f.modified ? `changed ${String(f.modified).slice(0, 10)}` : ''].filter(Boolean).join(', ');
        return `- ${f.type === 'directory' ? 'folder' : 'file'} ${cleanText(f.name, 200)}${about ? ` (${about})` : ''}`;
      }).join('\n'));
      const count = c.fileCount ?? c.files.length;
      lines.push(`The user selected ${count} item(s) here${count > c.files.length ? ` (the first ${c.files.length} are listed)` : ''}:`);
    }
  }
  if (view === 'settings' && c.page?.label) {
    lines.push(`The user has the settings page "${cleanText(c.page.label, 100)}" (${cleanText(c.page.id, 100)}) open. find_setting and read_my_settings tell you more about it.`);
  }
  return data.length ? `${lines.join('\n')}\n<view>\n${data.join('\n\n')}\n</view>` : lines.join('\n');
}

/** Whether a message is unread (no $seen keyword). */
const isUnread = (m) => !(Array.isArray(m.keywords) && m.keywords.includes('$seen'));

async function mailboxByRole(api, role) {
  try {
    const list = (await api.mailboxes.list()) ?? [];
    return list.find((m) => m.role === role) ?? null;
  } catch {
    return null;
  }
}

/**
 * Sent messages that nobody answered: the newest sent message of each
 * thread (at most MAX_WAITING_THREADS threads) with no later message from
 * someone else in its thread. Needs api.email.getThread (caps threads).
 */
export async function waitingForReply(api, { sentId, since, ownEmails = [] }) {
  const sent = (await api.email.search({ mailboxId: sentId, after: since, limit: 50 })) ?? [];
  const own = new Set(ownEmails.map((e) => String(e).toLowerCase()));
  const newest = new Map();
  for (const m of sent) {
    const key = m.threadId || m.id;
    const prev = newest.get(key);
    if (!prev || String(m.receivedAt) > String(prev.receivedAt)) newest.set(key, m);
  }
  const out = [];
  const threads = [...newest.values()].sort((a, b) => String(b.receivedAt).localeCompare(String(a.receivedAt))).slice(0, MAX_WAITING_THREADS);
  for (const m of threads) {
    let thread;
    try {
      thread = (await api.email.getThread(m.id, m.accountId ? { accountId: m.accountId } : undefined)) ?? [];
    } catch {
      continue;
    }
    const at = String(m.receivedAt ?? '');
    const answered = thread.some((x) => x.id !== m.id && String(x.receivedAt ?? '') > at
      && !(x.from ?? []).some((f) => own.has(String(f.email ?? '').toLowerCase())));
    if (!answered) out.push(m);
  }
  return out;
}

/**
 * Everything Catch me up shows: unread mail in the inbox since the last
 * visit, today's events, open tasks due today or before, and (where the
 * webmail reads threads and the user left it on) sent mail of the last
 * week without a reply. A part that can't be read is left out; `skipped`
 * names it.
 */
export async function gatherBrief(api, { zone, lastVisit, ownEmails = [], now = new Date(), waiting = true } = {}) {
  const today = clock(zone, now).date;
  const sinceMs = Number.isFinite(lastVisit) && lastVisit < now.getTime() ? lastVisit : now.getTime() - FIRST_VISIT_HOURS * 3600_000;
  const since = new Date(sinceMs).toISOString();
  const skipped = [];
  const brief = { today, since, unread: [], events: [], tasks: [], waiting: [], skipped };

  const [inbox, sentBox] = await Promise.all([mailboxByRole(api, 'inbox'), mailboxByRole(api, 'sent')]);
  try {
    const found = (await api.email.search({ after: since, ...(inbox ? { mailboxId: inbox.id } : {}), limit: 50 })) ?? [];
    brief.unread = found.filter(isUnread).slice(0, MAX_UNREAD);
  } catch {
    skipped.push('unread');
  }
  try {
    const events = (await api.calendar.getEvents({ from: today, to: addDays(today, 1) })) ?? [];
    // Timed events by their start in the user's zone; all-day ones that cover today.
    brief.events = events.filter((e) => (e.isAllDay
      ? String(e.start ?? '').slice(0, 10) <= today
      : (e.utcStart ? dateIn(zone, e.utcStart) : String(e.start ?? '').slice(0, 10)) === today));
  } catch {
    skipped.push('events');
  }
  try {
    const tasks = (await api.tasks.list()) ?? [];
    brief.tasks = tasks.filter((x) => !x.isComplete && x.dueDate && String(x.dueDate).slice(0, 10) <= today).slice(0, 30);
  } catch {
    skipped.push('tasks');
  }
  if (waiting && sentBox && has(api, 'threads', 'email.getThread')) {
    try {
      brief.waiting = await waitingForReply(api, { sentId: sentBox.id, since: new Date(now.getTime() - WAITING_DAYS * 86_400_000).toISOString(), ownEmails });
    } catch {
      skipped.push('waiting');
    }
  } else {
    skipped.push('waiting');
  }
  return brief;
}

/**
 * The request Catch me up sends: what to do, and as data the unread mail,
 * today's events, the open tasks and the mail waiting for a reply. The
 * model sorts the unread mail; the rest the panel shows itself under the
 * answer (briefParts).
 */
export function briefRequest(brief, zone) {
  const line = (m) => `- id ${m.id} | ${whenIn(zone, m.receivedAt)} | from ${(m.from ?? []).map(person).join(', ') || '?'}${m.to?.length ? ` | to ${m.to.map(person).join(', ')}` : ''} | ${cleanText(m.subject, 200) || '(no subject)'} | ${cleanText(m.preview, 200)}`;
  const list = (items, fmt) => items.map(fmt).join('\n') || '(none)';
  const event = (e) => `- ${e.isAllDay ? 'all day' : `${whenIn(zone, e.utcStart ?? e.start)}${e.utcEnd ? ` to ${whenIn(zone, e.utcEnd)}` : ''}`}: ${cleanText(e.title, 200) || '(no title)'}${e.location ? ` at ${cleanText(e.location, 200)}` : ''}`;
  const task = (x) => `- ${cleanText(x.title, 200) || '(no title)'}, due ${String(x.dueDate ?? '').slice(0, 10)}`;
  const instructions = [
    `Catch me up: the user wants to know what came in since ${whenIn(zone, brief.since)} and what needs them today.`,
    brief.unread.length
      ? 'Sort the unread messages into two groups: those that need an answer or an action from the user, and those that are only for their information. For each group write one short heading line, then one widget of type "emails" with the messages of that group (id, subject, from and date as given). Leave out a group that is empty. Then add one or two sentences about what matters most.'
      : 'There is no unread mail since then. Say so in one sentence.',
    'Under your answer the panel shows today\'s events, the open tasks and the sent mail waiting for a reply by itself: do not list them again, but mention one in your sentences when it is urgent.',
  ].join(' ');
  const block = (tag, text) => `<${tag}>\n${text}\n</${tag}>`;
  const blocks = [
    block('unread', list(brief.unread, line)),
    block('today_events', list(brief.events, event)),
    block('open_tasks', list(brief.tasks, task)),
    ...(brief.skipped.includes('waiting') ? [] : [block('waiting_for_reply', list(brief.waiting, line))]),
  ];
  return clip(`${instructions}\n${blocks.join('\n')}`, MAX_BRIEF_CHARS);
}

const widgetBlock = (widget) => (widget ? `\n<widget>${JSON.stringify(widget)}</widget>\n` : '');
const mailItems = (list) => list.map((m) => ({ id: m.id, subject: m.subject || '', from: m.from?.[0]?.name || m.from?.[0]?.email || '', date: m.receivedAt || '' }));

/** Ids of the messages the model put into its "emails" widgets. */
function shownIds(text) {
  const ids = new Set();
  for (const m of String(text ?? '').matchAll(/<widget>([\s\S]*?)<\/widget>/g)) {
    try {
      const w = normalizeWidget(JSON.parse(m[1]));
      if (w?.type === 'emails') for (const item of w.items) ids.add(item.id);
    } catch { /* not a widget we draw */ }
  }
  return ids;
}

/** A time for a heading: "31 Oct, 08:15" in the user's language and zone. */
function shortTime(locale, zone, iso) {
  try {
    return new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: zone }).format(new Date(iso));
  } catch {
    return iso;
  }
}

/**
 * What the panel adds under the model's answer, with the chat's cards:
 * unread messages the model left out of its groups, today's events, the
 * open tasks and the mail waiting for a reply, each under its heading.
 */
export function briefParts(brief, text, { t, zone, locale = 'en' }) {
  const shown = shownIds(text);
  const missing = brief.unread.filter((m) => !shown.has(m.id));
  const out = [];
  if (missing.length) {
    out.push(`\n**${t('brief.unread', { time: shortTime(locale, zone, brief.since) })}**\n`);
    out.push(widgetBlock(normalizeWidget({ type: 'emails', items: mailItems(missing) })));
  }
  out.push(`\n**${t('brief.today')}**\n`);
  out.push(brief.events.length
    ? widgetBlock(normalizeWidget({
      type: 'calendar', from: brief.today, to: brief.today,
      days: [{ date: brief.today, events: brief.events.map((e) => ({ title: e.title || '', start: e.utcStart ?? e.start ?? '', end: e.utcEnd ?? '', allDay: e.isAllDay === true })) }],
    }))
    : `\n${t('brief.no_events')}\n`);
  if (brief.tasks.length) {
    out.push(`\n**${t('brief.tasks')}**\n`);
    out.push(widgetBlock(normalizeWidget({ type: 'checklist', items: brief.tasks.map((x) => ({ text: x.title || '…', due: String(x.dueDate ?? '').slice(0, 10) })) })));
  }
  if (!brief.skipped.includes('waiting')) {
    out.push(`\n**${t('brief.waiting')}**\n`);
    out.push(brief.waiting.length ? widgetBlock(normalizeWidget({ type: 'emails', items: mailItems(brief.waiting) })) : `\n${t('brief.no_waiting')}\n`);
  }
  return out.join('');
}

export default {
  tools: [],
  actions: [],
};
