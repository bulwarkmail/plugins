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

/** The chip row's context chip: the one in effect, or the one that brings a removed context back. `fit`: 'full' or 'icon'. */
export function ContextChips({ api, source, email, onRemove, onRestore, fit = 'full' }) {
  const t = api.i18n.t;
  const chip = contextChip(t, source, email);
  if (source.removed && email) {
    // Names the message, so it can't be mistaken for another one the transcript mentions.
    const subject = (email.subject ?? '').trim();
    const label = subject ? t('panel.context.add_named', { subject: excerpt(subject, 40) }) : t('panel.context.add_message');
    return <ContextChip icon="plus" label={label} title={subject || chip.label} dashed onClick={onRestore} fit={fit} />;
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
      fit={fit}
    />
  );
}

/** Pixel widths the chip row's layout works with. */
export const CHIP = { icon: 16, gap: 6, pad: 20, border: 2, remove: 20, text: 40, iconOnly: 28 };

/** The narrowest a chip may get before it shows only its icon. */
export const chipMinWidth = (removable) => CHIP.icon + CHIP.gap + CHIP.text + CHIP.pad + CHIP.border + (removable ? CHIP.gap + CHIP.remove : 0);

/**
 * How the chip row fits `width` pixels: the chip shrinks to its icon first,
 * then the Actions button to its icon. `actionsWidth` is the button's width
 * with its text (0 when there is no button).
 */
export function rowFit({ width, actionsWidth, chip, removable }) {
  if (!width) return { chip: 'full', actions: 'full' };
  const actions = actionsWidth ? actionsWidth + 4 : 0;
  if (!chip) return { chip: 'full', actions: width >= actions ? 'full' : 'icon' };
  if (width - actions >= chipMinWidth(removable)) return { chip: 'full', actions: 'full' };
  const iconChip = CHIP.iconOnly + (removable ? CHIP.gap + CHIP.remove : 0);
  if (width - actions >= iconChip) return { chip: 'icon', actions: 'full' };
  return { chip: 'icon', actions: 'icon' };
}

const touchOnly = () => typeof window !== 'undefined' && !!window.matchMedia?.('(hover: none)').matches;
const visuallyHidden = { position: 'absolute', width: 1, height: 1, padding: 0, margin: -1, overflow: 'hidden', clip: 'rect(0 0 0 0)', whiteSpace: 'nowrap', border: 0 };
const ellipsis = { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 };

/**
 * What the assistant works on, as a chip in the input box. When space runs
 * out the detail (the subject) gives way first, then the label; with fit
 * 'icon' only the icon shows. The full text stays in the title and the
 * accessible name. With onRemove an x follows the text: always on touch
 * screens, else on hover and keyboard focus, and its place is kept so
 * nothing moves. `dashed` with onClick is the chip that brings a context back.
 */
export function ContextChip({ icon, label, detail, title, onRemove, removeLabel, onClick, dashed = false, fit = 'full' }) {
  const [hover, setHover] = useState(false);
  const [focus, setFocus] = useState(false);
  const iconOnly = fit === 'icon';
  const more = detail ? (title || detail) : title;
  const name = more && more !== label ? `${label}: ${more}` : label;
  const box = {
    display: 'inline-flex', alignItems: 'center', gap: CHIP.gap, flex: '0 1 auto', minWidth: iconOnly ? CHIP.iconOnly : 0, maxWidth: '100%', overflow: 'hidden', boxSizing: 'border-box',
    // Sits on the input box (muted): outlined, with the box's colour inside.
    height: 28, padding: iconOnly ? '0 5px' : '0 10px', borderRadius: 999, border: `1px ${dashed ? 'dashed' : 'solid'} var(--color-border)`,
    background: 'transparent', color: 'var(--color-foreground)', font: 'inherit', fontSize: '0.8125rem',
  };
  const content = (
    <>
      <span aria-hidden="true" style={{ display: 'inline-flex', flexShrink: 0 }}><Icon name={icon} size="sm" className="text-muted-foreground" /></span>
      {iconOnly ? (
        <span data-chip-label style={visuallyHidden}>{label}</span>
      ) : (
        <>
          <span data-chip-label style={{ ...ellipsis, flex: '0 1 auto' }}>{label}</span>
          {/* The detail gives way long before the label does. */}
          {detail && <span data-chip-detail aria-hidden="true" style={{ ...ellipsis, flex: '0 1000 auto', fontSize: '0.75rem', color: 'var(--color-muted-foreground)' }}>{detail}</span>}
        </>
      )}
    </>
  );
  if (onClick) {
    return <button type="button" data-context-chip="add" data-fit={fit} title={name} onClick={onClick} className="bk hover:bg-muted" style={{ ...box, cursor: 'pointer' }}>{content}</button>;
  }
  const shown = hover || focus || touchOnly();
  return (
    <span
      data-context-chip=""
      data-fit={fit}
      role="group"
      aria-label={name}
      title={name}
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
          data-chip-remove
          style={{
            // A normal item after the text, never over it.
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, width: CHIP.remove, height: CHIP.remove,
            marginInlineEnd: iconOnly ? 0 : -6, border: 0, borderRadius: 999, padding: 0, cursor: 'pointer',
            background: 'transparent', color: 'var(--color-foreground)',
            opacity: shown ? 1 : 0, transition: 'opacity 120ms',
          }}
        >
          <Icon name="x" size="sm" />
        </button>
      )}
    </span>
  );
}
