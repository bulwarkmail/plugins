// The input: one box with the text field on top and, under it, what the
// assistant works on, the quick actions and Send. A click on the box
// outside its buttons goes to the text field.

import { useCallback, useLayoutEffect, useState } from 'react';
import { Button, Row, Select, Textarea } from '@plugin-host/ui';
import { savePrefs } from '../../lib/assistant.js';
import { COMPOSER_PANEL } from '../../lib/background.js';
import { INPUT_MAX_HEIGHT } from './model.js';
import { ActionsMenu, actionLabel, actionsFor } from './ActionsMenu.jsx';
import { ContextChips } from './ContextChips.jsx';

export function InputBox({ chat, composerId }) {
  const { api, t, mode, source, email, input, setInput, inputRef, running, target, setTarget, languages } = chat;
  const [inputFocused, setInputFocused] = useState(false);
  const [translating, setTranslating] = useState(false);
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

  const actions = actionsFor(mode, source);
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
          <div style={{ display: 'flex', alignItems: 'center', gap: 4, flex: 1, minWidth: 0 }}>
            <ContextChips api={api} source={source} email={email} onRemove={chat.removeContext} onRestore={chat.restoreContext} />
            {actions.length > 0 && (translating ? (
              <Row gap={1} wrap={false}>
                <Select
                  value={target}
                  aria-label={t('composer.translate_label')}
                  options={languages.map((l) => ({ value: l.tag, label: l.label }))}
                  onChange={(value) => {
                    setTarget(value);
                    setTranslating(false);
                    void savePrefs(api, { translateTo: value });
                    chat.quick('translate', { targetTag: value });
                  }}
                />
                <Button variant="ghost" size="icon" icon="x" aria-label={t('common.cancel')} onClick={() => setTranslating(false)} />
              </Row>
            ) : (
              <ActionsMenu
                api={api}
                actions={actions}
                actionLabel={(action) => actionLabel(t, mode, action)}
                disabled={running}
                onPick={(action) => (action === 'translate' ? setTranslating(true) : chat.quick(action))}
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
