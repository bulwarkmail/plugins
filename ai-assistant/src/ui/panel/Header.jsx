// The panel's title row: its name and, once there is a conversation, New chat.

import { Button, Icon, Row, Text } from '@plugin-host/ui';

export function Header({ api, hasTurns, onClear }) {
  const t = api.i18n.t;
  return (
    <div style={{ padding: '10px 16px 8px', borderBottom: '1px solid var(--color-border)', flexShrink: 0 }}>
      <Row justify="between" wrap={false}>
        <Row gap={1} wrap={false}>
          <Icon name="sparkles" size="sm" className="text-primary" />
          <Text size="sm" weight="semibold">{t('composer.title')}</Text>
        </Row>
        {hasTurns && (
          <Button variant="ghost" size="icon" icon="eraser" title={t('panel.new_chat')} aria-label={t('panel.new_chat')} onClick={onClear} />
        )}
      </Row>
    </div>
  );
}
