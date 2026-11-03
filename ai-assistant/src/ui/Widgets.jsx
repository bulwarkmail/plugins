// The widgets of the chat (lib/widgets.js): drawn with the app's controls,
// each with the one or two things a person wants to do with it. `onSend`
// puts a request into the chat, `onInsert` text into the message (the
// composer only).

import { useState } from 'react';
import { Badge, Button, LinkButton, Row, Stack, Text } from '@plugin-host/ui';
import { copyWithToast } from './common.jsx';
import { formatDate } from './Reader.jsx';
import { userZone } from '../lib/clock.js';

const card = { border: '1px solid var(--color-border)', borderRadius: 8, padding: '8px 10px' };
const DAYS_SHOWN = 7;

function fmt(locale, value, { time = true, zone } = {}) {
  if (!value) return '';
  try {
    // A calendar date is shown as it is; an instant in the user's zone.
    const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(value);
    const d = new Date(dateOnly ? `${value}T12:00:00Z` : value);
    if (Number.isNaN(d.getTime())) return value;
    const tz = dateOnly ? 'UTC' : zone;
    return new Intl.DateTimeFormat(locale, time && !dateOnly
      ? { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', ...(tz ? { timeZone: tz } : {}) }
      : { weekday: 'short', day: 'numeric', month: 'short', ...(tz ? { timeZone: tz } : {}) }).format(d);
  } catch {
    return value;
  }
}

function timeOnly(locale, value, zone) {
  try {
    return new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit', ...(zone ? { timeZone: zone } : {}) }).format(new Date(value));
  } catch {
    return value;
  }
}

/** A slot as a sentence for the message: "Tue, 21 Oct, 10:00 to 11:00". */
export function slotText(locale, item, zone) {
  if (item.label && !item.start) return item.label;
  const start = fmt(locale, item.start, { zone });
  const end = item.end ? (item.end.slice(0, 10) === item.start.slice(0, 10) ? timeOnly(locale, item.end, zone) : fmt(locale, item.end, { zone })) : '';
  return `${item.label ? `${item.label}: ` : ''}${start}${end ? ` – ${end}` : ''}`;
}

/** `replying` false: the reader panel with no message behind the answer, so a time goes into a new email. */
export function Widget({ api, mode, widget, onSend, onInsert, replying = true }) {
  const t = api.i18n.t;
  const locale = api.i18n.getLocale?.() ?? 'en';
  const zone = userZone(api);
  if (!widget) return null;
  switch (widget.type) {
    case 'choices':
      return (
        <div data-widget="choices"><Row gap={1}>
          {widget.items.map((item, i) => (
            <Button key={i} size="sm" variant="secondary" onClick={() => onSend?.(item)}>{item}</Button>
          ))}
        </Row></div>
      );
    case 'checklist': {
      const text = `${widget.title ? `${widget.title}:\n` : ''}${widget.items.map((i) => `- [ ] ${i.text}${i.due ? ` (${i.due})` : ''}`).join('\n')}`;
      return (
        <div style={card} data-widget="checklist">
          <Stack gap={1}>
            {widget.title && <Text weight="medium">{widget.title}</Text>}
            {widget.items.map((item, i) => <Text key={i}>☐ {item.text}{item.due ? ` · ${fmt(locale, item.due, { time: false })}` : ''}</Text>)}
            <Row><LinkButton icon="copy" onClick={() => void copyWithToast(api, text)}>{t('reader.copy_list')}</LinkButton></Row>
          </Stack>
        </div>
      );
    }
    case 'times':
      return (
        <div data-widget="times"><Stack gap={1}>
          {widget.items.map((item, i) => {
            const line = slotText(locale, item, zone);
            return (
              <div key={i} style={card}>
                <Row justify="between" wrap={false}>
                  <Text>{line}</Text>
                  {mode === 'composer'
                    ? <Button size="sm" variant="secondary" icon="text-plus" onClick={() => onInsert?.(line)}>{t('widget.use_time')}</Button>
                    : replying
                      ? <Button size="sm" variant="secondary" icon="arrow-back-up" onClick={() => onSend?.(t('widget.ask_time_prompt', { time: line }))}>{t('widget.ask_time')}</Button>
                      : <Button size="sm" variant="secondary" icon="pencil" onClick={() => onSend?.(t('widget.propose_time_prompt', { time: line }))}>{t('widget.propose_time')}</Button>}
                </Row>
              </div>
            );
          })}
        </Stack></div>
      );
    case 'contacts':
      return (
        <div data-widget="contacts"><Stack gap={1}>
          {widget.items.map((item, i) => {
            const address = item.name && item.email ? `${item.name} <${item.email}>` : (item.email || item.name);
            return (
              <div key={i} style={card}>
                <Row justify="between" wrap={false}>
                  <Stack gap={0}>
                    <Text weight="medium">{item.name || item.email}</Text>
                    {item.name && item.email && <Text size="xs" tone="muted">{item.email}</Text>}
                  </Stack>
                  <Row gap={1} wrap={false}>
                    {mode === 'composer' && item.email && <Button size="sm" variant="ghost" icon="text-plus" aria-label={t('panel.insert_cursor')} title={t('panel.insert_cursor')} onClick={() => onInsert?.(address)} />}
                    {item.email && <Button size="sm" variant="ghost" icon="copy" aria-label={t('widget.copy_address')} title={t('widget.copy_address')} onClick={() => void copyWithToast(api, item.email)} />}
                  </Row>
                </Row>
              </div>
            );
          })}
        </Stack></div>
      );
    case 'emails':
      return (
        <div data-widget="emails"><Stack gap={1}>
          {widget.items.map((item) => (
            <div key={item.id} style={card}>
              <Row justify="between" wrap={false} align="start">
                <Stack gap={0} className="min-w-0">
                  <Text weight="medium" truncate>{item.subject || '(no subject)'}</Text>
                  <Text size="xs" tone="muted">{[item.from, item.date ? fmt(locale, item.date, { zone }) : ''].filter(Boolean).join(' · ')}</Text>
                </Stack>
                <Button size="sm" variant="ghost" icon="file-text" aria-label={t('widget.read')} title={t('widget.read')} onClick={() => onSend?.(t('widget.read_prompt', { subject: item.subject || item.id, id: item.id }))} />
              </Row>
            </div>
          ))}
        </Stack></div>
      );
    case 'calendar':
      return <CalendarWidget api={api} widget={widget} locale={locale} zone={zone} />;
    case 'table':
      return (
        <div style={{ overflowX: 'auto' }} data-widget="table">
          <table style={{ borderCollapse: 'collapse', fontSize: '0.95em' }}>
            <thead><tr>{widget.columns.map((c, i) => <th key={i} style={{ border: '1px solid var(--color-border)', padding: '2px 6px', textAlign: 'start' }}>{c}</th>)}</tr></thead>
            <tbody>{widget.rows.map((row, r) => <tr key={r}>{widget.columns.map((_, c) => <td key={c} style={{ border: '1px solid var(--color-border)', padding: '2px 6px' }}>{row[c] ?? ''}</td>)}</tr>)}</tbody>
          </table>
        </div>
      );
    default:
      return null;
  }
}

/** Busy and free days of a calendar lookup, the first week open, the rest behind Show all. */
function CalendarWidget({ api, widget, locale, zone }) {
  const t = api.i18n.t;
  const [all, setAll] = useState(false);
  const days = all ? widget.days : widget.days.slice(0, DAYS_SHOWN);
  return (
    <div style={card} data-widget="calendar">
      <Stack gap={1}>
        {days.map((day) => (
          <Row key={day.date} justify="between" wrap={false} align="start">
            <Text size="xs" tone="muted" className="whitespace-nowrap">{fmt(locale, day.date, { time: false })}</Text>
            <Stack gap={0} className="min-w-0" >
              {day.events.length === 0
                ? <Badge tone="success">{t('widget.free')}</Badge>
                : day.events.map((e, i) => (
                  <Text key={i} size="xs" truncate>
                    {e.allDay ? t('widget.all_day') : `${timeOnly(locale, e.start, zone)}${e.end ? `–${timeOnly(locale, e.end, zone)}` : ''}`} {e.title}
                  </Text>
                ))}
            </Stack>
          </Row>
        ))}
        {widget.days.length > DAYS_SHOWN && (
          <Row><LinkButton onClick={() => setAll((v) => !v)}>{all ? t('widget.less') : t('widget.more', { count: widget.days.length })}</LinkButton></Row>
        )}
      </Stack>
    </div>
  );
}

export { formatDate };
