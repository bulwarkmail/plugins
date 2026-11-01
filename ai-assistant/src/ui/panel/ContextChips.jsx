// What the assistant works on, as chips in the input box.

import { useState } from 'react';
import { Icon } from '@plugin-host/ui';
import { excerpt } from './model.js';

/** Label, icon and texts of the chip for the current context. */
export function contextChip(t, source, email) {
  const label = {
    selection: t('panel.context.selection'),
    body: t('panel.context.body'),
    empty: t('panel.context.empty'),
    message: t('panel.context.message'),
    passage: t('panel.context.passage'),
    none: t('panel.context.none'),
  }[source.scope];
  const icon = source.scope === 'selection' || source.scope === 'passage' ? 'highlight' : source.scope === 'empty' ? 'pencil' : source.scope === 'none' ? 'mail-off' : 'mail';
  // A whole message goes by its subject; highlighted text and the draft by their first words.
  const mailSubject = (email?.subject ?? '').trim();
  const detail = source.scope === 'message' && mailSubject ? excerpt(mailSubject, 60) : source.text ? excerpt(source.text, 40) : '';
  const title = source.scope === 'message' && mailSubject ? mailSubject : source.text ? excerpt(source.text, 400) : label;
  return { label, icon, detail, title };
}

/** The chip row's context chip: the one in effect, or the one that brings a removed context back. */
export function ContextChips({ api, source, email, onRemove, onRestore }) {
  const t = api.i18n.t;
  const chip = contextChip(t, source, email);
  if (source.removed && email) {
    return <ContextChip icon="plus" label={t('panel.context.add_message')} title={email.subject || chip.label} dashed onClick={onRestore} />;
  }
  if (source.scope === 'none' || source.scope === 'empty') return null;
  return (
    <ContextChip
      icon={chip.icon}
      label={chip.label}
      detail={chip.detail || undefined}
      title={chip.title}
      removeLabel={t('panel.context.remove')}
      onRemove={source.scope === 'message' || source.scope === 'passage' || source.scope === 'selection' ? onRemove : undefined}
    />
  );
}

/**
 * What the assistant works on, as a chip above the input. With onRemove an
 * x shows while the pointer is over the chip (or the keyboard is in it) and
 * takes the context out; `dashed` with onClick is the chip that brings it back.
 */
export function ContextChip({ icon, label, detail, title, onRemove, removeLabel, onClick, dashed = false }) {
  const [hover, setHover] = useState(false);
  const [focus, setFocus] = useState(false);
  const box = {
    position: 'relative', display: 'inline-flex', alignItems: 'center', gap: 6, maxWidth: '100%', minWidth: 0,
    // Sits on the input box (muted): outlined, with the box's colour inside.
    height: 28, padding: '0 10px', borderRadius: 999, border: `1px ${dashed ? 'dashed' : 'solid'} var(--color-border)`,
    background: 'transparent', color: 'var(--color-foreground)', font: 'inherit', fontSize: '0.8125rem',
  };
  const content = (
    <>
      <Icon name={icon} size="sm" className="text-muted-foreground" />
      <span style={{ whiteSpace: 'nowrap', flexShrink: 0 }}>{label}</span>
      {detail && <span style={{ fontSize: '0.75rem', color: 'var(--color-muted-foreground)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>{detail}</span>}
    </>
  );
  if (onClick) {
    return <button type="button" data-context-chip="add" title={title} onClick={onClick} className="bk hover:bg-muted" style={{ ...box, cursor: 'pointer' }}>{content}</button>;
  }
  const shown = hover || focus;
  return (
    <span
      data-context-chip=""
      title={title}
      style={box}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onFocus={() => setFocus(true)}
      onBlur={() => setFocus(false)}
    >
      {content}
      {onRemove && (
        <button
          type="button"
          aria-label={removeLabel}
          title={removeLabel}
          onClick={onRemove}
          className="bk hover:bg-accent"
          style={{
            position: 'absolute', insetInlineEnd: 4, top: '50%', transform: 'translateY(-50%)',
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 20, height: 20,
            border: 0, borderRadius: 999, padding: 0, cursor: 'pointer',
            background: 'var(--color-muted)', color: 'var(--color-foreground)',
            boxShadow: '-8px 0 8px var(--color-muted)',
            opacity: shown ? 1 : 0, pointerEvents: shown ? 'auto' : 'none', transition: 'opacity 120ms',
          }}
        >
          <Icon name="x" size="sm" />
        </button>
      )}
    </span>
  );
}
