// The panel's title row: its name and, once there is a conversation, New chat.
// 56 px high plus its border, like the app's toolbars and its other side
// panels (h-14 with a border under it), and the same height with or without
// the button, so nothing below it jumps.

import { Button, Icon } from '@plugin-host/ui';

export const HEADER_HEIGHT = 56;

export function Header({ api, hasTurns, onClear }) {
  const t = api.i18n.t;
  return (
    <div
      data-assistant-header
      style={{
        height: HEADER_HEIGHT, boxSizing: 'content-box', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8,
        padding: '0 8px 0 16px', borderBottom: '1px solid var(--color-border)', flexShrink: 0,
      }}
    >
      <h2 style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0, margin: 0, font: 'inherit' }}>
        <Icon name="sparkles" size="sm" className="text-primary" />
        <span className="bk text-sm font-semibold text-foreground truncate">{t('composer.title')}</span>
      </h2>
      {/* Hidden, not removed, while there is nothing to clear: the row keeps its shape. */}
      <span style={{ display: 'inline-flex', flexShrink: 0, visibility: hasTurns ? 'visible' : 'hidden' }} aria-hidden={hasTurns ? undefined : 'true'}>
        <Button variant="ghost" size="icon" icon="eraser" className="h-9 w-9" title={t('panel.new_chat')} aria-label={t('panel.new_chat')} disabled={!hasTurns} onClick={onClear} />
      </span>
    </div>
  );
}
