// What the model did inside an answer: its lookups (folded into one box)
// and its actions (a card each, waiting for the user's OK or done).

import { useState } from 'react';
import { Badge, Button, Icon, LinkButton, Row, Spinner, Stack, Text } from '@plugin-host/ui';
import { Widget } from '../Widgets.jsx';
import { areaAction, areaTool } from '../../lib/areas/index.js';

/** One lookup the model made. */
const STEP_ICONS = { check_calendar: 'calendar', find_contact: 'address-book', search_mail: 'search', read_message: 'mail-opened', read_original_message: 'mail', find_setting: 'settings', read_my_settings: 'adjustments' };

function stepLabel(t, step) {
  const args = step.args ?? {};
  switch (step.name) {
    case 'check_calendar': return t('panel.step.check_calendar', { from: args.from ?? '', to: args.to ?? args.from ?? '' });
    case 'find_contact': return t('panel.step.find_contact', { query: args.query ?? '' });
    case 'read_original_message': return t('panel.step.read_original_message');
    case 'search_mail': return t('panel.step.search_mail', { query: [args.text, args.from, args.subject, args.after, args.before].filter(Boolean).join(' ') });
    case 'read_message': return t('panel.step.read_message');
    case 'find_setting': return t('panel.step.find_setting', { query: args.query ?? '' });
    case 'read_my_settings': return t('panel.step.read_my_settings');
    // A lookup of a 2.2 area says itself what it did; one without words never shows its code name.
    default: return areaTool(step.name)?.label?.(t, args) ?? t('panel.step.generic');
  }
}

const TOOL_ACTION_ICONS = {
  archive_message: 'archive', move_message: 'folder-symlink', mark_message: 'mail-check', create_event: 'calendar-plus',
  create_task: 'checkbox', create_contact: 'user-plus', draft_reply: 'arrow-back-up', draft_email: 'mail-forward',
};

/**
 * Something the assistant does for the user, as a card in the chat: what it
 * is, and its state. Waiting for the user's OK it offers Do it and Skip;
 * done, Undo where the action can be taken back.
 */
export function ActionCard({ api, step, onAnswer, onUndo }) {
  const t = api.i18n.t;
  const action = step.action ?? { summary: step.result, state: 'failed' };
  const state = step.status === 'failed' && action.state !== 'skipped' ? 'failed' : action.state;
  const [busy, setBusy] = useState(false);
  return (
    <div data-action={step.name} data-action-state={state} style={{ border: '1px solid var(--color-border)', borderRadius: 8, padding: '8px 10px' }}>
      <Stack gap={2}>
        <Row gap={2} wrap={false} align="start">
          <Icon name={TOOL_ACTION_ICONS[step.name] ?? areaAction(step.name)?.icon ?? 'bolt'} size="sm" className="text-primary" />
          <Text size="sm">{action.summary}</Text>
        </Row>
        {state === 'waiting' && (
          <Row gap={1} justify="end">
            <Text size="xs" tone="muted">{t('action.waiting')}</Text>
            <span style={{ flex: 1 }} />
            <Button variant="ghost" size="sm" onClick={() => onAnswer(false)}>{t('action.skip')}</Button>
            <Button size="sm" onClick={() => onAnswer(true)}>{t('action.approve')}</Button>
          </Row>
        )}
        {state === 'running' && <Spinner size="sm" />}
        {state === 'done' && (
          <Row gap={1} wrap={false}>
            <Icon name="check" size="sm" className="text-success" />
            <Text size="xs" tone="muted">{t('action.done')}</Text>
            {action.undo && (
              <>
                <span style={{ flex: 1 }} />
                <LinkButton icon="arrow-back-up" disabled={busy} onClick={async () => { setBusy(true); await onUndo(); setBusy(false); }}>{t('action.undo')}</LinkButton>
              </>
            )}
          </Row>
        )}
        {state === 'skipped' && <Text size="xs" tone="muted">{t('action.skipped')}</Text>}
        {state === 'undone' && <Text size="xs" tone="muted">{t('action.undone')}</Text>}
        {/* The model's error text stays for the model; the user reads why in their language. */}
        {state === 'failed' && <Text size="xs" tone="danger">{t(`action.reason.${step.reason ?? 'other'}`)}</Text>}
      </Stack>
    </div>
  );
}

/**
 * The lookups of one answer, in a box of their own: "Looked up" and a chip
 * per lookup (Mail, Calendar, Message), a spinner while they run. Clicking
 * the box opens the details with the cards of what was found.
 */
export function StepsGroup({ api, mode, replying, steps, running, onSend, onInsert }) {
  const t = api.i18n.t;
  const [open, setOpen] = useState(false);
  const busy = running && steps.some((s) => s.status === 'running');
  const failed = steps.some((s) => s.status === 'failed');
  const chips = [];
  for (const step of steps) {
    const area = areaTool(step.name);
    const label = step.name in STEP_ICONS ? t(`panel.steps.kind.${step.name}`) : area?.kind ? t(area.kind) : t('panel.steps.kind.other');
    const prev = chips.find((c) => c.label === label);
    if (prev) { prev.count++; prev.status = step.status === 'failed' || prev.status === 'failed' ? 'failed' : step.status === 'running' ? 'running' : prev.status; }
    else chips.push({ label, count: 1, status: step.status });
  }
  return (
    <div data-steps={steps.length} data-steps-open={open || undefined} style={{ border: '1px solid var(--color-border)', borderRadius: 8 }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        title={open ? t('panel.steps.hide') : t('panel.steps.show')}
        className="bk"
        style={{ display: 'flex', alignItems: 'center', gap: 6, width: '100%', padding: '6px 8px', background: 'none', border: 0, font: 'inherit', color: 'inherit', textAlign: 'start', cursor: 'pointer', flexWrap: 'wrap' }}
      >
        {busy ? <Spinner size="sm" /> : <Icon name={failed ? 'alert-circle' : 'list-search'} size="sm" className="text-muted-foreground" />}
        <Text size="xs" tone="muted">{busy ? t('panel.steps.running') : t('panel.steps.title')}</Text>
        {chips.map((c) => (
          <Badge key={c.label} tone={c.status === 'failed' ? 'danger' : c.status === 'running' ? 'info' : 'neutral'}>{c.label}{c.count > 1 ? ` ×${c.count}` : ''}</Badge>
        ))}
        <span style={{ marginInlineStart: 'auto' }}><Icon name={open ? 'chevron-up' : 'chevron-down'} size="sm" className="text-muted-foreground" /></span>
      </button>
      {open && (
        <div style={{ padding: '2px 8px 8px' }}>
          <Stack gap={2}>
            {steps.map((step) => <StepRow key={step.id} api={api} mode={mode} replying={replying} step={step} onSend={onSend} onInsert={onInsert} />)}
          </Stack>
        </div>
      )}
    </div>
  );
}

/** One lookup the model made, with a card of what it found. */
function StepRow({ api, mode, replying, step, onSend, onInsert }) {
  const t = api.i18n.t;
  const icon = step.status === 'running' ? 'loader-2' : step.status === 'failed' ? 'alert-circle' : (STEP_ICONS[step.name] ?? areaTool(step.name)?.icon ?? 'mail');
  return (
    <div data-step={step.name} data-step-status={step.status} style={{ paddingTop: 6, borderTop: '1px solid var(--color-border)' }}>
    <Stack gap={1}>
      <Row gap={1} wrap={false} align="start">
        <Icon name={icon} size="sm" className="text-muted-foreground" />
        <Text size="xs" tone="muted">{stepLabel(t, step)}{step.status === 'failed' ? ` · ${t('panel.step.failed')}` : ''}</Text>
      </Row>
      {step.widget && <Widget api={api} mode={mode} replying={replying} widget={step.widget} onSend={onSend} onInsert={onInsert} />}
      {step.status === 'failed'
        ? <Text size="xs" tone="danger">{t(`action.reason.${step.reason ?? 'other'}`)}</Text>
        : step.result && !step.widget && <Text size="xs" tone="muted" className="whitespace-pre-wrap">{step.result.slice(0, 1200)}</Text>}
    </Stack>
    </div>
  );
}
