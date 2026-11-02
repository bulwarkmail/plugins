// The conversation: what to try when it is empty, the turns, and the
// privacy notice when a request waits for the user's OK. It scrolls, and
// keeps the newest turn in view.

import { useEffect, useRef } from 'react';
import { Button, LinkButton, Row, Stack, Text } from '@plugin-host/ui';
import { ConsentNotice } from '../common.jsx';
import { AssistantTurn, ContextMarker, UserTurn } from './Turns.jsx';

export function Transcript({ chat, onExample }) {
  const { api, t, mode, turns, consent, source, email, lookups } = chat;
  const scrollRef = useRef(null);
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [turns]);
  return (
    <div ref={scrollRef} style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '12px 16px' }} data-assistant-transcript>
      {turns.length === 0 && !consent && (
        <Stack gap={2}>
          <Text tone="muted" size="xs">{chat.areas.empty?.text ?? t(mode === 'reader' ? (source.scope === 'none' ? (lookups ? 'panel.empty.none' : 'panel.empty.none_plain') : 'panel.empty.read') : source.scope === 'empty' ? 'panel.empty.write' : 'panel.empty.compose')}</Text>
          {/* Ways to start an area offers here (Catch me up). */}
          {chat.areas.empty?.actions?.length > 0 && (
            <Row gap={1}>
              {chat.areas.empty.actions.map((a) => (
                <Button key={a.id} size="sm" variant="secondary" icon={a.icon} disabled={chat.running} busy={a.busy} data-empty-action={a.id} onClick={a.run}>{a.label}</Button>
              ))}
            </Row>
          )}
          {mode === 'composer' && source.scope === 'empty' && (
            <Stack gap={1}>
              {[1, 2, 3].map((n) => (
                <LinkButton key={n} icon="arrow-right" onClick={() => onExample(t(`panel.example_${n}`))}>{t(`panel.example_${n}`)}</LinkButton>
              ))}
            </Stack>
          )}
        </Stack>
      )}
      <Stack gap={4}>
        {turns.map((turn) => (
          turn.role === 'context'
            ? <ContextMarker key={turn.id} api={api} turn={turn} />
            : turn.role === 'user'
            ? <UserTurn key={turn.id} turn={turn} />
            : (
              <AssistantTurn
                key={turn.id}
                api={api}
                mode={mode}
                turn={turn}
                email={email}
                waiting={!!consent}
                onApply={chat.apply}
                onReply={chat.replyFor}
                onRetry={chat.retry}
                onReview={(review) => chat.patchTurn(turn.id, { review })}
                onSend={chat.sendText}
                onInsert={chat.insertText}
                onAnswerAction={chat.answerAction}
                onUndo={chat.undoStep}
              />
            )
        ))}
        {consent && (
          <Stack gap={2}>
            <ConsentNotice api={api} consent={consent} />
            <Row justify="end">
              <Button variant="secondary" size="sm" onClick={() => consent.answer(false)}>{t('common.cancel')}</Button>
              <Button size="sm" onClick={() => consent.answer(true)}>{t('privacy.continue')}</Button>
            </Row>
          </Stack>
        )}
      </Stack>
    </div>
  );
}
