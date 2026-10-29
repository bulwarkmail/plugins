// Widgets: small interactive cards in the chat. The model asks for one by
// writing `<widget>{json}</widget>` on its own line (prompts.js tells it the
// shapes), and the lookups (tools.js) bring their own. Everything is checked
// here, so a malformed or oversized widget is dropped rather than drawn.
//
// Kinds:
//   choices    { items: [string] }                       quick replies
//   checklist  { title?, items: [{ text, due? }] }       to-dos with a copy button
//   times      { items: [{ start, end?, label? }] }      time slots to use in the message
//   contacts   { items: [{ name?, email }] }             people, address to copy or insert
//   emails     { items: [{ id, subject, from?, date? }] } messages to summarise
//   calendar   { from, to, days: [{ date, events: [{ title, start?, end?, allDay? }] }] }  busy and free days
//   table      { columns: [string], rows: [[string]] }

export const WIDGET_KINDS = ['choices', 'checklist', 'times', 'contacts', 'emails', 'calendar', 'table'];
const MAX_ITEMS = 30;
const MAX_TEXT = 300;

const str = (v, max = MAX_TEXT) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const list = (v) => (Array.isArray(v) ? v.slice(0, MAX_ITEMS) : []);
const DATE_RE = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:?\d{2})?)?$/;
const date = (v) => (typeof v === 'string' && DATE_RE.test(v.trim()) ? v.trim() : '');

/** A checked widget, or null when it is not one we draw. */
export function normalizeWidget(raw) {
  if (!raw || typeof raw !== 'object' || !WIDGET_KINDS.includes(raw.type)) return null;
  switch (raw.type) {
    case 'choices': {
      const items = list(raw.items).map((i) => str(typeof i === 'string' ? i : i?.text, 120)).filter(Boolean);
      return items.length ? { type: 'choices', items } : null;
    }
    case 'checklist': {
      const items = list(raw.items).map((i) => (typeof i === 'string' ? { text: str(i), due: '' } : { text: str(i?.text), due: date(i?.due) })).filter((i) => i.text);
      return items.length ? { type: 'checklist', title: str(raw.title, 80), items } : null;
    }
    case 'times': {
      const items = list(raw.items).map((i) => ({ start: date(i?.start), end: date(i?.end), label: str(i?.label, 120) })).filter((i) => i.start || i.label);
      return items.length ? { type: 'times', items } : null;
    }
    case 'contacts': {
      const items = list(raw.items).map((i) => ({ name: str(i?.name, 120), email: str(i?.email, 200) })).filter((i) => i.email || i.name);
      return items.length ? { type: 'contacts', items } : null;
    }
    case 'emails': {
      const items = list(raw.items).map((i) => ({ id: str(i?.id, 200), subject: str(i?.subject, 200), from: str(i?.from, 200), date: str(i?.date, 40) })).filter((i) => i.id);
      return items.length ? { type: 'emails', items } : null;
    }
    case 'calendar': {
      const days = list(raw.days).map((d) => ({
        date: date(d?.date).slice(0, 10),
        events: list(d?.events).map((e) => ({ title: str(e?.title, 120), start: str(e?.start, 40), end: str(e?.end, 40), allDay: e?.allDay === true })),
      })).filter((d) => d.date);
      return days.length ? { type: 'calendar', from: date(raw.from).slice(0, 10), to: date(raw.to).slice(0, 10), days } : null;
    }
    case 'table': {
      const columns = list(raw.columns).map((c) => str(c, 60));
      const rows = list(raw.rows).map((r) => list(r).map((c) => str(c, 200)));
      return columns.length && rows.length ? { type: 'table', columns, rows } : null;
    }
    default:
      return null;
  }
}

/** The widget in a `<widget>` block's text, or null. */
export function parseWidgetJson(text) {
  try {
    return normalizeWidget(JSON.parse(String(text ?? '').trim()));
  } catch {
    return null;
  }
}

function addDays(day, n) {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** The days of a calendar lookup with their events, busy or free. */
export function calendarWidget(events, { from, to }) {
  const days = [];
  for (let day = from; day && to && day <= to && days.length < 31; day = addDays(day, 1)) {
    const todays = events.filter((e) => {
      const start = String(e.utcStart ?? e.start ?? '');
      return start.slice(0, 10) === day || (e.isAllDay && String(e.start ?? '').slice(0, 10) === day);
    });
    days.push({
      date: day,
      events: todays.slice(0, 20).map((e) => ({ title: e.title || '', start: e.utcStart ?? e.start ?? '', end: e.utcEnd ?? '', allDay: e.isAllDay === true })),
    });
  }
  return normalizeWidget({ type: 'calendar', from, to, days });
}

/**
 * Name, addresses and company of a JSContact card (api.contacts.search):
 * name { full, components }, emails and organizations keyed by id.
 */
export function contactParts(c) {
  const components = Array.isArray(c?.name?.components) ? c.name.components : [];
  const part = (kind) => components.filter((p) => p?.kind === kind).map((p) => p.value).join(' ');
  const name = c?.name?.full || [part('given'), part('surname')].filter(Boolean).join(' ');
  const emails = Object.values(c?.emails ?? {})
    .filter((e) => e?.address)
    .sort((a, b) => (a.pref ?? 100) - (b.pref ?? 100))
    .map((e) => e.address);
  const company = Object.values(c?.organizations ?? {}).map((o) => o?.name).filter(Boolean).join(', ');
  return { name, emails, company };
}

export function contactsWidget(contacts) {
  return normalizeWidget({
    type: 'contacts',
    items: contacts.slice(0, 8).flatMap((c) => {
      const { name, emails } = contactParts(c);
      return (emails.length ? emails : ['']).map((email) => ({ name, email }));
    }),
  });
}

/** Messages found, the newest of each subject and sender (newsletters arrive twice), at most 6. */
export function emailsWidget(messages) {
  const seen = new Set();
  const items = [];
  for (const m of messages) {
    const from = m.from?.[0]?.name || m.from?.[0]?.email || '';
    const key = `${(m.subject || '').trim().toLowerCase()}|${from.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({ id: m.id, subject: m.subject || '', from, date: m.receivedAt || '' });
    if (items.length === 6) break;
  }
  return normalizeWidget({ type: 'emails', items });
}
