// One entry of the transcript: a topic change, the user's request, or the
// model's answer with what it says, proposes, looked up and did.

import { useMemo } from 'react';
import { Alert, Badge, Button, DiffView, Icon, LinkButton, List, ListRow, Row, RowAction, Spinner, Stack, Text } from '@plugin-host/ui';
import { ErrorMessage, copyWithToast } from '../common.jsx';
import { Markdown, stripMarkdown } from '../Markdown.jsx';
import { Widget } from '../Widgets.jsx';
import { ActionItems, Replies } from '../Reader.jsx';
import { keepEdges } from '../AssistantDialog.jsx';
import { isActionTool } from '../../lib/actions.js';
import { AiError } from '../../lib/errors.js';
import { acceptAll, applySuggestions, pendingSuggestions, reviewParts, reviewStep } from '../../lib/grammar.js';
import { diffWords, plainParts } from '../../lib/diff.js';
import { partsOf } from './model.js';
import { ActionCard, StepsGroup } from './Steps.jsx';

/** "Ctrl+Z takes it back", with the Mac's key on a Mac. */
export function undoHint(t, platform = typeof navigator !== 'undefined' ? (navigator.userAgentData?.platform || navigator.platform || navigator.userAgent || '') : '') {
  const hint = t('panel.undo_hint');
  return /mac|iphone|ipad/i.test(platform) ? hint.replace(/\b(?:Ctrl|Strg)\+Z/, '⌘Z') : hint;
}

/** A line in the transcript: from here on the conversation is about another message, or about none. */
export function ContextMarker({ api, turn }) {
  const rule = { flex: 1, height: 1, background: 'var(--color-border)' };
  return (
    <div data-turn="context" style={{ display: 'flex', alignItems: 'center', gap: 8 }} title={turn.subject}>
      <span style={rule} />
      <Icon name={turn.left ? 'mail-off' : 'mail'} size="xs" className="text-muted-foreground" />
      <Text size="xs" tone="muted" className="truncate">{api.i18n.t(turn.left ? 'panel.context.left' : 'panel.context.now', { subject: turn.subject || '…' })}</Text>
      <span style={rule} />
    </div>
  );
}

export function UserTurn({ turn }) {
  return (
    <Row justify="end">
      <div style={{ maxWidth: '85%', background: 'var(--color-muted)', color: 'var(--color-foreground)', borderRadius: 12, padding: '6px 10px' }} data-turn="user">
        <Text size="sm">{turn.label ?? turn.content}</Text>
      </div>
    </Row>
  );
}

/** The model's answer: what it says, what it proposes, what it looked up. */
export function AssistantTurn({ api, mode, turn, email, waiting = false, onApply, onReply, onRetry, onReview, onSend, onInsert, onAnswerAction, onUndo }) {
  const t = api.i18n.t;
  const running = turn.status === 'running';
  const parts = useMemo(() => partsOf(turn), [turn]);
  const lookupSteps = (turn.steps ?? []).filter((s) => !isActionTool(s.name));
  const actionSteps = (turn.steps ?? []).filter((s) => isActionTool(s.name) && (s.action || s.status === 'failed'));
  // In the reader with no message behind the answer there is nothing to reply to.
  const replying = !(mode === 'reader' && turn.replyTo === null);
  return (
    <div data-turn="assistant" data-status={turn.status}>
    <Stack gap={2}>
      {lookupSteps.length > 0 && <StepsGroup api={api} mode={mode} replying={replying} steps={lookupSteps} running={running} onSend={onSend} onInsert={onInsert} />}
      {actionSteps.map((step) => (
        <ActionCard key={step.id} api={api} step={step} onAnswer={(ok) => onAnswerAction(step.id, ok)} onUndo={() => onUndo(turn.id, step)} />
      ))}
      {/* Nothing is being thought while the privacy notice waits for the user's answer. */}
      {running && !waiting && !turn.content && (!turn.steps || turn.steps.every((s) => s.status !== 'running')) && <Spinner label={t('common.thinking')} />}
      {turn.show === 'grammar' && turn.review
        ? <GrammarCard api={api} turn={turn} onApply={onApply} onReview={onReview} />
        : parts.map((part, i) => (
          part.kind === 'say'
            ? <SayPart key={i} api={api} mode={mode} turn={turn} text={part.text} onApply={onApply} />
            : part.kind === 'widget'
              ? (part.widget ? <Widget key={i} api={api} mode={mode} replying={replying} widget={part.widget} onSend={onSend} onInsert={onInsert} /> : null)
            : part.kind === 'actions'
              ? <ActionItems key={i} api={api} answer={part.text} />
              : part.kind === 'replies'
                ? <Replies key={i} api={api} answer={part.text} email={email} onReply={onReply ? (text) => onReply(turn, text) : undefined} />
                : (
                  <ProposalCard
                    key={i}
                    api={api}
                    mode={mode}
                    turn={turn}
                    text={part.text}
                    headers={{ to: part.to, subject: part.subject }}
                    replying={replying}
                    streaming={running || part.open}
                    plain={part.plain}
                    onApply={onApply}
                  />
                )
        ))}
      {turn.status === 'stopped' && <Text tone="muted" size="xs">{t('common.stopped')}</Text>}
      {turn.status === 'error' && <ErrorMessage api={api} error={Object.assign(new AiError(turn.error?.code ?? 'unreachable', turn.error ?? {}), {})} onRetry={() => onRetry(turn)} />}
      {turn.applyFailed && <Alert tone="danger">{t(mode === 'reader' ? 'panel.open_failed' : 'assistant.apply_failed')}</Alert>}
    </Stack>
    </div>
  );
}

/** What the model says. In the composer it can still go into the message when the model left the tags out. */
function SayPart({ api, mode, turn, text, onApply }) {
  const t = api.i18n.t;
  const offer = mode === 'composer' && turn.status === 'done' && turn.show === 'chat' && !turn.applied
    && !(turn.content ?? '').includes('<text') && text.split(/\s+/).length >= 12;
  return (
    <Stack gap={1}>
      <Markdown text={text} onOpenLink={(url) => void api.ui.openExternalUrl?.(url)} />
      {offer && (
        <Row>
          <LinkButton icon="text-plus" onClick={() => onApply(turn, 'cursor', stripMarkdown(text))}>{t('panel.insert_cursor')}</LinkButton>
        </Row>
      )}
    </Stack>
  );
}

/** A proposal: the change marked against the text it replaces, and the buttons to take it. */
function ProposalCard({ api, mode, turn, text, headers = {}, replying = true, streaming, onApply }) {
  const t = api.i18n.t;
  const source = turn.source ?? '';
  const scope = turn.scope;
  const composerEdit = mode === 'composer' && (scope === 'selection' || scope === 'body');
  const shown = streaming && composerEdit ? (/^\s*/.exec(source)[0] + text.replace(/^\s+/, '')) : (composerEdit ? (keepEdges(source, text) || text) : text);
  const parts = composerEdit ? diffWords(source, shown, { partial: streaming }) : plainParts(text.trim());
  const ready = !streaming && !!text.trim() && !turn.applying;
  const applied = turn.applied;
  const final = composerEdit ? (keepEdges(source, text) || text) : text;
  return (
    <div data-proposal>
    <Stack gap={2}>
      {mode === 'reader' && !replying && (headers.to?.length > 0 || headers.subject) && (
        <div data-draft-headers style={{ display: 'flex', flexDirection: 'column' }}>
          {headers.to?.length > 0 && <Text size="xs" tone="muted">{t('panel.draft_to', { to: headers.to.join(', ') })}</Text>}
          {headers.subject && <Text size="xs" tone="muted">{t('panel.draft_subject', { subject: headers.subject })}</Text>}
        </div>
      )}
      <DiffView parts={parts} streaming={streaming} label={t('assistant.preview_label')} />
      {applied ? (
        <Row gap={2}>
          <Badge tone="success">{t(applied === 'reply' ? 'panel.applied.reply' : applied === 'new' ? 'panel.applied.new' : applied === 'replace' ? 'panel.applied.replace' : 'panel.applied.insert')}</Badge>
          {applied !== 'reply' && applied !== 'new' && <Text size="xs" tone="muted">{undoHint(t)}</Text>}
        </Row>
      ) : (
        <Row gap={1}>
          {mode === 'reader' && !replying ? (
            <Button size="sm" icon="pencil" disabled={!ready} busy={turn.applying === 'new'} onClick={() => onApply(turn, 'new', final, headers)}>{t('panel.open_new')}</Button>
          ) : mode === 'reader' ? (
            <Button size="sm" icon="arrow-back-up" disabled={!ready} busy={turn.applying === 'reply'} onClick={() => onApply(turn, 'reply', final)}>{t('panel.open_reply')}</Button>
          ) : scope === 'selection' ? (
            <>
              <Button size="sm" disabled={!ready} busy={turn.applying === 'replace'} onClick={() => onApply(turn, 'replace', final)}>{t('assistant.replace')}</Button>
              <Button size="sm" variant="secondary" disabled={!ready} busy={turn.applying === 'below'} onClick={() => onApply(turn, 'below', final)}>{t('assistant.insert_below')}</Button>
            </>
          ) : scope === 'body' ? (
            <>
              <Button size="sm" disabled={!ready} busy={turn.applying === 'replace'} onClick={() => onApply(turn, 'replace', final)}>{t('panel.replace_message')}</Button>
              <Button size="sm" variant="secondary" disabled={!ready} busy={turn.applying === 'cursor'} onClick={() => onApply(turn, 'cursor', final)}>{t('panel.insert_cursor')}</Button>
            </>
          ) : (
            <Button size="sm" disabled={!ready} busy={turn.applying === 'replace'} onClick={() => onApply(turn, 'replace', final)}>{t('assistant.insert')}</Button>
          )}
          <Button size="sm" variant="ghost" icon="copy" disabled={!ready} aria-label={t('common.copy')} title={t('common.copy')} onClick={() => void copyWithToast(api, final.trim())} />
        </Row>
      )}
    </Stack>
    </div>
  );
}

/** Spelling fixes, one by one or all at once. */
function GrammarCard({ api, turn, onApply, onReview }) {
  const t = api.i18n.t;
  const review = turn.review;
  const pending = pendingSuggestions(review.segments, review.states);
  const total = review.segments.filter((s) => s.kind === 'change').length;
  const accepted = Object.values(review.states).some((s) => s === 'accepted');
  const decide = (id, state) => onReview(reviewStep(review, id, state).review);
  const label = (s) => (s.from.trim() ? `${s.from.trim()} → ${s.to.trim() || '∅'}` : `+ ${s.to.trim()}`);
  if (total === 0) return <Alert tone="success" icon="check">{t('grammar.none')}</Alert>;
  return (
    <div data-proposal>
    <Stack gap={2}>
      <Text tone="muted" size="xs">{t('grammar.count', { open: pending.length, total })}</Text>
      <DiffView parts={reviewParts(review.segments, review.states)} label={t('assistant.preview_label')} />
      {pending.length > 0 && (
        <List label={t('assistant.suggestions')}>
          {pending.map((s) => (
            <ListRow
              key={s.id}
              title={label(s)}
              actions={(
                <>
                  <RowAction icon="check" label={t('grammar.accept_label', { from: s.from.trim(), to: s.to.trim() })} onClick={() => decide(s.id, 'accepted')} />
                  <RowAction icon="x" label={t('grammar.skip_label', { from: s.from.trim() })} onClick={() => decide(s.id, 'skipped')} />
                </>
              )}
            />
          ))}
        </List>
      )}
      {turn.applied ? (
        <Row gap={2}><Badge tone="success">{t('panel.applied.replace')}</Badge><Text size="xs" tone="muted">{t('panel.undo_hint')}</Text></Row>
      ) : (
        <Row gap={1}>
          <Button size="sm" disabled={!accepted || !!turn.applying} busy={!!turn.applying} onClick={() => onApply(turn, 'replace', applySuggestions(review.segments, review.states))}>{t('assistant.replace')}</Button>
          {pending.length > 1 && <Button size="sm" variant="secondary" onClick={() => onReview(acceptAll(review).review)}>{t('grammar.accept_all')}</Button>}
        </Row>
      )}
    </Stack>
    </div>
  );
}
