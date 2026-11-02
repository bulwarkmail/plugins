// The input: one box with the text field on top and, under it, what the
// assistant works on, the quick actions and Send. A click on the box
// outside its buttons goes to the text field.

import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { Button, Select, Textarea } from '@plugin-host/ui';
import { savePrefs } from '../../lib/assistant.js';
import { COMPOSER_PANEL } from '../../lib/background.js';
import { INPUT_MAX_HEIGHT } from './model.js';
import { ActionsMenu, actionLabel, actionsFor, startAction } from './ActionsMenu.jsx';
import { ContextChips, rowFit } from './ContextChips.jsx';

/** The Actions button's width with its text, until it is measured. */
const ACTIONS_GUESS = 104;

export function InputBox({ chat, composerId }) {
  const { api, t, mode, source, email, input, setInput, inputRef, running, target, setTarget, languages, translating, setTranslating } = chat;
  const [inputFocused, setInputFocused] = useState(false);
  // The box around the text field shows its focus, so the field drops the
  // kit's own outline, which would draw a second frame inside the box. In
  // forced colours the box's border colour is lost, so the outline stays.
  const setInputEl = useCallback((el) => {
    inputRef.current = el;
    if (el && !window.matchMedia?.('(forced-colors: active)').matches) el.style.setProperty('outline', 'none', 'important');
  }, [inputRef]);
  // The text field grows with its text up to INPUT_MAX_HEIGHT, then scrolls.
  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    if (el.scrollHeight > 0) el.style.height = `${Math.min(el.scrollHeight, INPUT_MAX_HEIGHT)}px`;
  }, [input, inputRef]);

  const actions = actionsFor(mode, source, { lookups: chat.lookups });

  // The chip row never overlaps: it measures its width and shrinks the chip,
  // then the Actions button, to their icons when the text doesn't fit.
  const rowRef = useRef(null);
  const actionsRef = useRef(null);
  const actionsFull = useRef(0);
  const [rowWidth, setRowWidth] = useState(0);
  useLayoutEffect(() => {
    const el = rowRef.current;
    if (!el) return undefined;
    setRowWidth(el.clientWidth);
    if (typeof ResizeObserver !== 'function') return undefined;
    const observer = new ResizeObserver(() => setRowWidth(el.clientWidth));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const hasChip = (source.removed && !!email) || (source.scope !== 'none' && source.scope !== 'empty');
  const removable = !source.removed && ['message', 'passage', 'selection'].includes(source.scope);
  const showActions = actions.length > 0 && !translating;
  const fit = translating
    ? { chip: rowWidth && rowWidth < 300 ? 'icon' : 'full', actions: 'full' }
    : rowFit({ width: rowWidth, actionsWidth: showActions ? (actionsFull.current || ACTIONS_GUESS) : 0, chip: hasChip, removable });
  // The button's width with its text, measured whenever it shows its text.
  useLayoutEffect(() => {
    if (showActions && fit.actions === 'full' && actionsRef.current?.offsetWidth) actionsFull.current = actionsRef.current.offsetWidth;
  });

  const placeholder = mode === 'reader'
    ? t(source.scope === 'none' ? 'panel.placeholder.none' : 'panel.placeholder.read')
    : source.scope === 'empty' ? t('panel.placeholder.write') : t('panel.placeholder.compose');

  return (
    <div style={{ padding: '8px 12px 12px', flexShrink: 0 }}>
      <div
        data-assistant-input
        data-focused={inputFocused ? '' : undefined}
        onMouseDown={(e) => {
          if (e.target.closest('button, select, textarea, [data-context-chip], [role="menu"]')) return;
          e.preventDefault();
          inputRef.current?.focus();
        }}
        style={{
          display: 'flex', flexDirection: 'column', gap: 6, padding: '10px 8px 8px 12px', cursor: 'text',
          borderRadius: 16, background: 'var(--color-muted)',
          border: `1px solid ${inputFocused ? 'var(--color-ring)' : 'var(--color-border)'}`,
          boxShadow: inputFocused ? '0 0 0 1px var(--color-ring)' : 'none',
          transition: 'border-color 120ms, box-shadow 120ms',
        }}
      >
        <Textarea
          ref={setInputEl}
          rows={1}
          value={input}
          placeholder={placeholder}
          aria-label={t('panel.input_label')}
          title={t('panel.enter_hint')}
          style={{ border: 0, borderRadius: 0, boxShadow: 'none', background: 'transparent', padding: '2px 4px 2px 0', minHeight: 24, maxHeight: INPUT_MAX_HEIGHT, overflowY: 'auto', resize: 'none', lineHeight: 1.5 }}
          onFocus={() => setInputFocused(true)}
          onBlur={() => setInputFocused(false)}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent?.isComposing) {
              e.preventDefault();
              chat.submit();
            } else if (e.key === 'Escape' && !input && mode === 'composer') {
              // Back to the message; Alt+A brings the panel back.
              e.preventDefault();
              void api.ui.closePanel?.(COMPOSER_PANEL, { composerId })?.catch?.(() => {});
            }
          }}
        />
        <div style={{ display: 'flex', alignItems: 'center', gap: 4, minWidth: 0 }}>
          <div ref={rowRef} data-chip-row style={{ display: 'flex', alignItems: 'center', gap: 4, flex: 1, minWidth: 0 }}>
            <ContextChips api={api} source={source} email={email} onRemove={chat.removeContext} onRestore={chat.restoreContext} fit={fit.chip} />
            {(actions.length > 0 || translating) && (translating ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: 4, flex: '1 1 auto', minWidth: 0 }}>
                <Select
                  style={{ flex: '1 1 auto', minWidth: 0, maxWidth: '100%' }}
                  // Starts on an empty entry, so the last language used can be picked too.
                  value=""
                  autoFocus
                  data-translate-to
                  aria-label={t('composer.translate_label')}
                  options={[
                    { value: '', label: `${t('composer.translate_label')}…` },
                    ...languages.filter((l) => l.tag === target),
                    ...languages.filter((l) => l.tag !== target),
                  ].map((l) => ('tag' in l ? { value: l.tag, label: l.label } : l))}
                  onChange={(value) => {
                    if (!value) return;
                    setTarget(value);
                    const text = translating.text;
                    setTranslating(null);
                    void savePrefs(api, { translateTo: value });
                    chat.quick('translate', { targetTag: value, ...(text ? { text } : {}) });
                  }}
                />
                <Button variant="ghost" size="icon" icon="x" aria-label={t('common.cancel')} onClick={() => setTranslating(null)} />
              </div>
            ) : (
              <ActionsMenu
                api={api}
                actions={actions}
                actionLabel={(action) => actionLabel(t, mode, action)}
                disabled={running}
                compact={fit.actions === 'icon'}
                rootRef={actionsRef}
                onPick={(action) => {
                  if (action === 'translate') return setTranslating({});
                  const start = startAction(t, action);
                  if (start?.send) return chat.sendText(start.send);
                  if (start?.fill) { setInput(start.fill); inputRef.current?.focus(); return undefined; }
                  return chat.quick(action);
                }}
              />
            ))}
          </div>
          {running
            ? <Button variant="secondary" size="icon" icon="player-stop" className="h-8 w-8 shrink-0 rounded-full" title={t('common.stop')} aria-label={t('common.stop')} onClick={chat.stop} />
            : <Button variant={input.trim() ? 'primary' : 'secondary'} size="icon" icon="arrow-up" className="h-8 w-8 shrink-0 rounded-full" disabled={!input.trim()} title={t('panel.send')} aria-label={t('panel.send')} onClick={chat.submit} />}
        </div>
      </div>
    </div>
  );
}
