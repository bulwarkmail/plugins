// The quick actions: which ones fit what the assistant works on, their
// names, and the menu that offers them above the input.

import { useEffect, useRef, useState } from 'react';
import { Button, Icon } from '@plugin-host/ui';
import { COMPOSER_ACTIONS, PASSAGE_ACTIONS, READER_ACTIONS } from './model.js';

const ACTION_ICONS = {
  improve: 'wand', shorter: 'arrows-minimize', formal: 'tie', casual: 'mood-smile', grammar: 'spell-check', translate: 'language',
  summary: 'align-left', actions: 'checklist', replies: 'message-reply', explain: 'bulb', reply: 'mail-forward',
};

/** The quick actions for the current context. */
export function actionsFor(mode, source) {
  if (mode === 'composer') return source.scope === 'empty' ? [] : COMPOSER_ACTIONS;
  return source.scope === 'passage' ? PASSAGE_ACTIONS : source.scope === 'none' ? [] : READER_ACTIONS;
}

/** A quick action's name in the menu. */
export function actionLabel(t, mode, action) {
  if (action === 'translate') return t('assistant.action.translate');
  if (mode === 'composer') return t(`assistant.action.${action}`);
  return t(action === 'explain' || action === 'reply' ? `panel.quick.${action}` : `reader.${action}`);
}

/** The quick actions, in a menu that opens above its button. */
export function ActionsMenu({ api, actions, actionLabel: labelOf, disabled, onPick }) {
  const t = api.i18n.t;
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const away = (e) => { if (!ref.current?.contains(e.target)) setOpen(false); };
    const key = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', key);
    return () => { document.removeEventListener('mousedown', away); document.removeEventListener('keydown', key); };
  }, [open]);
  return (
    <div ref={ref} style={{ position: 'relative' }} data-assistant-actions>
      <Button variant="ghost" size="sm" icon="sparkles" disabled={disabled} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        {t('panel.actions')}
        <Icon name={open ? 'chevron-up' : 'chevron-down'} size="xs" className="text-muted-foreground" />
      </Button>
      {open && (
        <div role="menu" style={{ position: 'absolute', bottom: 'calc(100% + 4px)', insetInlineStart: 0, minWidth: 200, zIndex: 20, background: 'var(--color-popover, var(--color-background))', color: 'var(--color-foreground)', border: '1px solid var(--color-border)', borderRadius: 8, boxShadow: '0 8px 24px rgba(0, 0, 0, 0.18)', padding: 4 }}>
          {actions.map((action) => (
            <button
              key={action}
              type="button"
              role="menuitem"
              className="bk hover:bg-muted rounded-md"
              style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '6px 8px', background: 'none', border: 0, font: 'inherit', fontSize: '0.875rem', color: 'inherit', textAlign: 'start', cursor: 'pointer' }}
              onClick={() => { setOpen(false); onPick(action); }}
            >
              <Icon name={ACTION_ICONS[action] ?? 'sparkles'} size="sm" className="text-muted-foreground" />
              <span>{labelOf(action)}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
