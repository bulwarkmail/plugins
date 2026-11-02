// A list that opens under the chat input while the user types a trigger:
// `/` at the start (commands, saved prompts) or `@` (a message, contact or
// file to add). The 2.2 areas give the menus (chat.areas.menus): their
// trigger, a label, `items(query)` and `onPick(item, { rest })`. Arrow keys
// move, Enter or Tab pick, Escape closes; the text field keeps the focus and
// points at the active entry (aria-activedescendant), so screen readers read it.

import { useCallback, useEffect, useRef, useState } from 'react';
import { Icon } from '@plugin-host/ui';

const MAX_ITEMS = 8;

/** Which menu the text before the caret opens, and with what query. */
export function activeMenu(menus, before) {
  for (const menu of menus) {
    if (menu.trigger === '/' && menu.atStart !== false) {
      const m = /^\/(\S{0,40})$/.exec(before);
      if (m) return { menu, query: m[1], start: 0 };
    } else {
      const escaped = menu.trigger.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const m = new RegExp(`(^|\\s)${escaped}([^\\s${escaped}]{0,40})$`).exec(before);
      if (m) return { menu, query: m[2], start: m.index + m[1].length };
    }
  }
  return null;
}

/**
 * The menu's state for the input. Returns { open, list, onKeyDown, ariaProps }:
 * onKeyDown handles the keys while it is open (true when it took the key).
 */
export function useInputMenu({ menus, input, setInput, inputRef, idBase = 'assistant-menu', t = null }) {
  const [state, setState] = useState(null); // { menu, query, start, end }
  const [items, setItems] = useState([]);
  const [index, setIndex] = useState(0);
  const [closedFor, setClosedFor] = useState(null);
  // The entries for the current query arrived (so "no matches" can be said).
  const [settled, setSettled] = useState(false);
  const seq = useRef(0);

  // Look at the text before the caret whenever the input changes.
  useEffect(() => {
    const el = inputRef.current;
    const caret = el && typeof el.selectionStart === 'number' ? el.selectionStart : input.length;
    const before = input.slice(0, caret);
    const found = menus.length ? activeMenu(menus, before) : null;
    if (!found || closedFor === before) { setState(null); return; }
    setState({ ...found, end: caret });
  }, [input, menus, inputRef, closedFor]);

  // Ask the menu for its entries (newest answer wins).
  useEffect(() => {
    setSettled(false);
    if (!state) { setItems([]); return undefined; }
    const mine = ++seq.current;
    const timer = setTimeout(() => {
      void Promise.resolve(state.menu.items(state.query)).then(
        (found) => { if (seq.current === mine) { setItems((found ?? []).slice(0, MAX_ITEMS)); setIndex(0); setSettled(true); } },
        () => { if (seq.current === mine) { setItems([]); setSettled(true); } },
      );
    }, state.menu.trigger === '/' ? 0 : 150);
    return () => clearTimeout(timer);
  }, [state]);

  const open = !!state && items.length > 0;

  const pick = useCallback((item) => {
    if (!state) return;
    const rest = (input.slice(0, state.start) + input.slice(state.end)).replace(/\s{2,}/g, ' ');
    setInput(rest);
    setState(null);
    setItems([]);
    state.menu.onPick(item, { rest });
    inputRef.current?.focus();
  }, [state, input, setInput, inputRef]);

  const onKeyDown = useCallback((e) => {
    if (!open) return false;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      setIndex((i) => (i + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length);
      return true;
    }
    if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault();
      pick(items[index]);
      return true;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      setClosedFor(input.slice(0, state.end));
      return true;
    }
    return false;
  }, [open, items, index, pick, input, state]);

  const listId = `${idBase}-list`;
  const optionId = (i) => `${idBase}-opt-${i}`;
  const ariaProps = {
    'aria-autocomplete': 'list',
    // The text field stays a text field; it says it can open a list.
    'aria-haspopup': menus.length ? 'listbox' : undefined,
    'aria-controls': open ? listId : undefined,
    'aria-activedescendant': open ? optionId(index) : undefined,
  };

  const list = open ? (
    <div
      id={listId}
      role="listbox"
      aria-label={state.menu.label}
      data-input-menu={state.menu.trigger}
      style={{
        position: 'absolute', insetInline: 12, bottom: 'calc(100% - 4px)', zIndex: 30, maxHeight: 260, overflowY: 'auto',
        background: 'var(--color-popover, var(--color-background))', color: 'var(--color-foreground)',
        border: '1px solid var(--color-border)', borderRadius: 8, boxShadow: '0 8px 24px rgba(0, 0, 0, 0.18)', padding: 4,
      }}
    >
      {items.map((item, i) => (
        <div
          key={item.id}
          id={optionId(i)}
          role="option"
          aria-selected={i === index}
          className="bk rounded-md"
          onMouseDown={(e) => { e.preventDefault(); pick(item); }}
          onMouseEnter={() => setIndex(i)}
          style={{
            display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px', cursor: 'pointer', fontSize: '0.875rem', minWidth: 0,
            background: i === index ? 'var(--color-muted)' : 'transparent',
          }}
        >
          {item.icon && <Icon name={item.icon} size="sm" className="text-muted-foreground" />}
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>{item.label}</span>
          {item.detail && <span style={{ marginInlineStart: 'auto', fontSize: '0.75rem', color: 'var(--color-muted-foreground)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0, flexShrink: 1 }}>{item.detail}</span>}
        </div>
      ))}
    </div>
  ) : null;

  // Screen readers hear how many entries the list has, or that there are none.
  const announce = !t || !state ? '' : open ? t('panel.menu.count', { count: items.length }) : settled ? t('panel.menu.none') : '';
  const status = <span role="status" aria-live="polite" data-input-menu-status style={{ position: 'absolute', width: 1, height: 1, margin: -1, overflow: 'hidden', clip: 'rect(0 0 0 0)', whiteSpace: 'nowrap', border: 0 }}>{announce}</span>;

  return { open, list: <>{list}{status}</>, onKeyDown, ariaProps };
}
