// The reader: an info bar above the message with Summarize, To-dos and
// dates, and Reply ideas, the results shown in the bar; and a summary of a
// whole conversation above it. Nothing is sent until a button is clicked.
// The privacy notice before the first request is the host's confirm.

import { useEffect, useState } from 'react';
import { BarButton, InfoBar, Row, Spinner, Stack, Text } from '@plugin-host/ui';
import { ErrorMessage, Lines, copyWithToast, useApi, useTask } from './common.jsx';
import { formatActionItems, parseActionItems, parseReplies } from '../lib/parse.js';
import { ownText } from '../lib/draft.js';
import { clock, userZone, whenIn } from '../lib/clock.js';

/** The fields of a message the prompts use; its date in the user's time zone. */
export function emailForPrompt(email, zone) {
  return {
    from: email.from?.[0] ?? null,
    date: email.receivedAt ? whenIn(zone ?? userZone(null), email.receivedAt) : '',
    subject: email.subject ?? '',
    text: email.text ?? '',
  };
}

async function loadText(api, email) {
  if (email.text) return email;
  const full = await api.email.get(email.id);
  return { ...email, text: full?.text ?? email.preview ?? '' };
}

export const READER_TASKS = ['summary', 'actions', 'replies'];
const TASK_ICONS = { summary: 'file-text', actions: 'checklist', replies: 'message' };
/**
 * The bar is for phones, where there is no side panel. The host says which
 * layout the frame is in (`deviceType`); without that, the frame's own
 * width stands in (it is as wide as the reader).
 */
export const BAR_MAX_WIDTH = 480;

function usePhone(deviceType, max = BAR_MAX_WIDTH) {
  const [narrow, setNarrow] = useState(() => typeof window === 'undefined' || window.innerWidth < max);
  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const on = () => setNarrow(window.innerWidth < max);
    on();
    window.addEventListener('resize', on);
    return () => window.removeEventListener('resize', on);
  }, [max]);
  return deviceType ? deviceType === 'mobile' : narrow;
}

export function ReaderBar(props) {
  const { email } = props;
  const api = useApi(props);
  const t = api.i18n.t;
  const task = useTask(api);
  const phone = usePhone(props.deviceType);
  const emailId = email?.id;
  // A new message: forget the old result.
  useEffect(() => { task.reset(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [emailId]);
  if (!email || !phone) return null;

  const run = async (name) => {
    const full = await loadText(api, email);
    const zone = userZone(api);
    await task.run(name, { email: emailForPrompt(full, zone), now: clock(zone) });
  };
  const running = task.status === 'running';
  const open = task.status !== 'idle';

  const buttons = READER_TASKS.map((name) => (
    <BarButton
      key={name}
      icon={TASK_ICONS[name]}
      active={open && task.task === name}
      busy={running && task.task === name}
      disabled={running && task.task !== name}
      onClick={() => void run(name)}
    >
      {t(`reader.${name}`)}
    </BarButton>
  ));

  if (!open) {
    return (
      <InfoBar compact icon="sparkles" tone="primary" eyebrow={t('reader.toolbar')}>
        {buttons}
      </InfoBar>
    );
  }

  return (
    <InfoBar icon="sparkles" tone="primary" eyebrow={t('reader.toolbar')} title={t(`reader.result.${task.task}`)}>
      <Stack gap={3}>
        <ReaderResult api={api} task={task} email={email} onRetry={() => void run(task.task)} />
        {/* The other actions come back with Close: one row of buttons, not three. */}
        <Row>
          {task.task === 'summary' && task.status === 'done' && task.text.trim() && (
            <BarButton icon="copy" onClick={() => void copyWithToast(api, task.text.trim())}>{t('common.copy')}</BarButton>
          )}
          {running && <BarButton icon="player-stop" onClick={task.cancel}>{t('common.stop')}</BarButton>}
          {!running && <BarButton icon="x" onClick={task.reset}>{t('common.close')}</BarButton>}
        </Row>
      </Stack>
    </InfoBar>
  );
}

function ReaderResult({ api, task, email, onRetry }) {
  const t = api.i18n.t;
  const running = task.status === 'running';
  const done = task.status === 'done' || task.status === 'stopped';
  const structured = task.task === 'actions' || task.task === 'replies';
  return (
    <Stack gap={2}>
      {running && (structured || !task.text) && <Spinner label={t('common.thinking')} />}
      {!structured && task.text && <Lines text={task.text} />}
      {done && task.task === 'actions' && <ActionItems api={api} answer={task.text} />}
      {done && task.task === 'replies' && <Replies api={api} answer={task.text} email={email} />}
      {task.status === 'stopped' && <Text tone="muted">{t('common.stopped')}</Text>}
      {task.status === 'error' && <ErrorMessage api={api} error={task.error} onRetry={onRetry} bar />}
    </Stack>
  );
}

export function ActionItems({ api, answer }) {
  const t = api.i18n.t;
  const items = parseActionItems(answer);
  if (!items.tasks.length && !items.dates.length) {
    return <Text tone="muted">{t('reader.nothing_to_do')}</Text>;
  }
  const locale = api.i18n.getLocale?.() ?? 'en';
  const copy = () => copyWithToast(api, formatActionItems(items, { tasksTitle: t('reader.todos'), datesTitle: t('reader.dates') }));
  return (
    <Stack gap={3}>
      {items.tasks.length > 0 && (
        <Stack gap={1}>
          <Text weight="medium">{t('reader.todos')}</Text>
          {items.tasks.map((item, i) => (
            <Text key={i}>• {item.text}{item.due ? ` · ${formatDate(locale, item.due)}` : ''}</Text>
          ))}
        </Stack>
      )}
      {items.dates.length > 0 && (
        <Stack gap={1}>
          <Text weight="medium">{t('reader.dates')}</Text>
          {items.dates.map((item, i) => (
            <Text key={i}>• {item.date ? `${formatDate(locale, item.date, item.time)}: ` : ''}{item.text}</Text>
          ))}
        </Stack>
      )}
      <Stack gap={1}>
        <Row><BarButton icon="copy" onClick={() => void copy()}>{t('reader.copy_list')}</BarButton></Row>
        <Text tone="muted" size="xs">{t('reader.tasks_hint')}</Text>
      </Stack>
    </Stack>
  );
}

export function formatDate(locale, date, time) {
  try {
    const value = new Date(`${date}T${time ?? '12:00'}:00`);
    return new Intl.DateTimeFormat(locale, time
      ? { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }
      : { weekday: 'short', day: 'numeric', month: 'short' }).format(value);
  } catch {
    return [date, time].filter(Boolean).join(' ');
  }
}

/** Reply ideas: each opens a reply that already says it. */
export function Replies({ api, answer, email }) {
  const t = api.i18n.t;
  const replies = parseReplies(answer);
  const [opening, setOpening] = useState(-1);
  if (!replies.length) return <Text tone="muted">{t('reader.no_replies')}</Text>;
  const reply = async (text, i) => {
    setOpening(i);
    try {
      await api.compose.reply(email.id, { text });
    } catch (err) {
      api.log?.warn?.('reply failed', err?.message ?? err);
      api.toast.error(t('reader.reply_failed'));
    } finally {
      setOpening(-1);
    }
  };
  return (
    <Stack gap={2}>
      {replies.map((text, i) => (
        <Row key={i} align="start" wrap={false} gap={3}>
          <BarButton icon="arrow-back-up" busy={opening === i} onClick={() => void reply(text, i)}>{t('reader.reply')}</BarButton>
          <Lines text={text} />
        </Row>
      ))}
    </Stack>
  );
}

/** Most recent messages first are cut when a conversation is very long. */
const MAX_THREAD_MESSAGES = 20;

export function ThreadSummary(props) {
  const { emailIds } = props;
  const api = useApi(props);
  const t = api.i18n.t;
  const task = useTask(api);
  const [loading, setLoading] = useState(false);
  const key = (emailIds ?? []).join(',');
  useEffect(() => { task.reset(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [key]);
  if (!Array.isArray(emailIds) || emailIds.length < 2) return null;

  const run = async () => {
    setLoading(true);
    try {
      const ids = emailIds.slice(-MAX_THREAD_MESSAGES);
      const emails = (await Promise.all(ids.map((id) => api.email.get(id).catch(() => null)))).filter(Boolean);
      const zone = userZone(api);
      const input = emails.map((e) => ({ ...emailForPrompt(e, zone), text: ownText(e.text ?? '') || e.preview || '' }));
      await task.run('thread', { emails: input });
    } finally {
      setLoading(false);
    }
  };
  const running = task.status === 'running' || loading;

  if (task.status === 'idle') {
    return (
      <InfoBar compact icon="sparkles" tone="primary" eyebrow={t('reader.toolbar')}>
        <BarButton icon="messages" busy={running} onClick={() => void run()}>{t('thread.summarize', { count: emailIds.length })}</BarButton>
      </InfoBar>
    );
  }
  return (
    <InfoBar icon="sparkles" tone="primary" eyebrow={t('reader.toolbar')} title={t('thread.title', { count: emailIds.length })}>
      <Stack gap={3}>
        {running && !task.text && <Spinner label={t('common.thinking')} />}
        {task.text && <Lines text={task.text} />}
        {task.status === 'stopped' && <Text tone="muted">{t('common.stopped')}</Text>}
        {task.status === 'error' && <ErrorMessage api={api} error={task.error} onRetry={() => void run()} bar />}
        <Row>
          {task.status === 'running' && <BarButton icon="player-stop" onClick={task.cancel}>{t('common.stop')}</BarButton>}
          {task.status === 'done' && <BarButton icon="copy" onClick={() => void copyWithToast(api, task.text.trim())}>{t('common.copy')}</BarButton>}
          {task.status !== 'running' && <BarButton icon="x" onClick={task.reset}>{t('common.close')}</BarButton>}
        </Row>
      </Stack>
    </InfoBar>
  );
}
