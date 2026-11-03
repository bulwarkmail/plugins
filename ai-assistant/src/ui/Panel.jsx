// The assistant panel: a chat next to the message the user writes
// (composer-sidebar-right) or reads (email-detail-sidebar). It works on what
// the user highlights, else on the whole message; quick actions and typed
// requests go into one transcript, where the model's proposals show as a
// marked change with Replace and Insert buttons, and its lookups as steps.
// The frame fills the panel (slots[...].fill), so the input stays at the
// bottom and the transcript scrolls.
//
// The parts live in ./panel/: the state and logic (useAssistantChat), the
// header, the transcript and its turns, the lookups and actions of an
// answer, and the input box with its chips and menus.

import { Alert, Spinner, Stack, Text } from '@plugin-host/ui';
import { useAssistantChat } from './panel/useAssistantChat.js';
import { Header } from './panel/Header.jsx';
import { Transcript } from './panel/Transcript.jsx';
import { InputBox } from './panel/InputBox.jsx';

export { COMPOSER_ACTIONS, READER_ACTIONS, PASSAGE_ACTIONS, sourceFor, appLabels, contextKey, effectiveSource, lastTopic, taskForAction, partsOf } from './panel/model.js';

export function AssistantPanel(props) {
  const chat = useAssistantChat(props);
  const { t, mode, loaded, setup, turns } = chat;

  const fill = { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 };
  if (!loaded) {
    return <div style={{ ...fill, alignItems: 'center', justifyContent: 'center' }}><Spinner label={t('common.loading')} /></div>;
  }
  if (!setup?.endpoint) {
    return (
      <div style={{ padding: 16 }}>
        <Alert tone="info" icon="sparkles">
          <Stack gap={1}>
            <Text weight="medium">{t('panel.not_set_up')}</Text>
            <Text tone="muted" size="xs">{t('panel.not_set_up_hint')}</Text>
          </Stack>
        </Alert>
      </div>
    );
  }

  return (
    <div style={fill} data-assistant-panel={mode}>
      <Header api={chat.api} hasTurns={turns.length > 0} onClear={chat.clear} extra={chat.areas.header} />
      {/* An area's view in place of the transcript (a list of old chats), else the chat. */}
      {chat.areas.overlay ?? <Transcript chat={chat} onExample={(text) => { chat.setInput(text); chat.inputRef.current?.focus(); }} />}
      <InputBox chat={chat} composerId={props.composerId} />
    </div>
  );
}
