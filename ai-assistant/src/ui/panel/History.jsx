// The reader's earlier chats, shown in place of the transcript: a list to
// search, open, rename and delete, and one old chat to read with "Continue
// this chat". Arrow keys move through the list, Escape goes back one step.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button, Icon, Input, RowAction, SearchInput, Spinner, Stack, Text } from '@plugin-host/ui';
import { Markdown } from '../Markdown.jsx';
import { ContextMarker, UserTurn } from './Turns.jsx';
import { partsOf } from './model.js';
import {
  deleteHistoryChat, filterIndex, loadHistoryChat, loadIndex, renameHistoryChat, searchText,
} from '../../lib/chat-history.js';

const fill = { display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 };
const bar = { display: 'flex', alignItems: 'center', gap: 6, padding: '8px 12px', borderBottom: '1px solid var(--color-border)', flexShrink: 0, minWidth: 0 };
const plainButton = {
  display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 2, flex: 1, minWidth: 0, padding: '6px 8px',
  background: 'none', border: 0, borderRadius: 6, font: 'inherit', color: 'inherit', textAlign: 'start', cursor: 'pointer',
};
/** The selector of a chat's row button. */
const openSel = (id) => `[data-history-open="${String(id).replace(/["\\]/g, '\\$&')}"]`;
const oneLine = { display: 'block', maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' };

function when(api, at) {
  try {
    return api.i18n.formatDate(new Date(at), { dateStyle: 'medium', timeStyle: 'short' }) || new Date(at).toLocaleString();
  } catch {
    return new Date(at).toLocaleString();
  }
}

/** The list of earlier chats, or one of them. `onContinue(id)` makes an old chat the running one. */
export function HistoryPanel({ api, onClose, onContinue }) {
  const t = api.i18n.t;
  const [index, setIndex] = useState(null);
  const [query, setQuery] = useState('');
  const [texts, setTexts] = useState(() => new Map());
  const [shown, setShown] = useState(null); // { entry, turns } of the chat being read
  const [renaming, setRenaming] = useState(null); // id
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const rootRef = useRef(null);
  const backTo = useRef(null); // the id whose row gets the focus back

  useEffect(() => {
    let live = true;
    void loadIndex(api).then((list) => { if (live) setIndex(list); });
    return () => { live = false; };
  }, [api]);

  // Searching looks into the chats too: their texts load once, when the query is long enough.
  const wantTexts = query.trim().length >= 2 && index && texts.size < index.length;
  useEffect(() => {
    if (!wantTexts) return undefined;
    let live = true;
    void (async () => {
      const next = new Map(texts);
      for (const entry of index) {
        if (!next.has(entry.id)) next.set(entry.id, searchText(await loadHistoryChat(api, entry.id)));
      }
      if (live) setTexts(next);
    })();
    return () => { live = false; };
  }, [wantTexts, index, texts, api]);

  const found = useMemo(() => (index ? filterIndex(index, query, texts) : []), [index, query, texts]);

  // The focus: the search field when the list opens, the heading when a chat opens, its row when it closes.
  const focus = useCallback((selector) => {
    requestAnimationFrame(() => rootRef.current?.querySelector(selector)?.focus());
  }, []);
  useEffect(() => {
    if (shown) focus('[data-history-heading]');
    else if (backTo.current) focus(openSel(backTo.current));
    else focus('input[type="search"]');
  }, [shown, focus]);

  const openChat = async (entry) => {
    setBusy(true);
    const turns = await loadHistoryChat(api, entry.id);
    setBusy(false);
    backTo.current = entry.id;
    setShown({ entry, turns });
  };

  // The chat now running goes into the history first; when that is full, nothing changes and the user hears why.
  const continueShown = async () => {
    setBusy(true);
    try {
      await onContinue(shown.entry.id);
    } catch (err) {
      api.log?.warn?.('could not continue the chat', err?.message ?? err);
      api.toast?.error?.(t('panel.storage_full'));
    } finally {
      setBusy(false);
    }
  };

  const rename = async (id) => {
    const list = await renameHistoryChat(api, id, name);
    setIndex(list);
    setRenaming(null);
    focus(openSel(id));
  };

  const remove = async (entry) => {
    const ok = await Promise.resolve(api.ui.confirm?.({
      title: t('chat.history.delete_title'),
      message: t('chat.history.delete_message', { title: entry.title || t('chat.history.untitled') }),
      confirmLabel: t('chat.history.delete'),
      danger: true,
    })).catch(() => false);
    if (!ok) return;
    const i = found.findIndex((e) => e.id === entry.id);
    const list = await deleteHistoryChat(api, entry.id);
    setIndex(list);
    if (shown) setShown(null);
    // The focus goes to the row that takes its place, else the search field.
    const next = found[i + 1] ?? found[i - 1];
    backTo.current = next?.id ?? null;
    focus(next ? openSel(next.id) : 'input[type="search"]');
  };

  const onKeyDown = (e) => {
    if (e.key === 'Escape' && !renaming) {
      e.preventDefault();
      e.stopPropagation();
      if (shown) setShown(null);
      else onClose();
      return;
    }
    if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && !shown && !renaming) {
      const rows = [...(rootRef.current?.querySelectorAll('[data-history-open]') ?? [])];
      if (!rows.length) return;
      const at = rows.indexOf(document.activeElement);
      // From the search field, down goes to the first chat.
      if (at < 0 && e.target?.type !== 'search') return;
      e.preventDefault();
      const next = at < 0 ? 0 : Math.max(0, Math.min(rows.length - 1, at + (e.key === 'ArrowDown' ? 1 : -1)));
      rows[next].focus();
    }
  };

  const title = (entry) => entry.title || t('chat.history.untitled');
  const detail = (entry) => t('chat.history.detail', { when: when(api, entry.at), count: entry.count ?? 0 });

  return (
    <div ref={rootRef} style={fill} data-chat-history={shown ? 'chat' : 'list'} onKeyDown={onKeyDown}>
      {shown ? (
        <>
          <div style={bar}>
            <Button variant="ghost" size="sm" icon="arrow-left" onClick={() => setShown(null)}>{t('chat.history.all')}</Button>
          </div>
          <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '12px 16px' }}>
            <Stack gap={3}>
              <div>
                <h3 data-history-heading tabIndex={-1} className="bk text-sm font-semibold text-foreground" style={{ margin: 0, outline: 'none', overflowWrap: 'anywhere' }}>{title(shown.entry)}</h3>
                <Text size="xs" tone="muted">{detail(shown.entry)}</Text>
              </div>
              <Stack gap={4}>
                {shown.turns.map((turn) => <ReadOnlyTurn key={turn.id} api={api} turn={turn} />)}
              </Stack>
            </Stack>
          </div>
          <div style={{ ...bar, borderBottom: 0, borderTop: '1px solid var(--color-border)', justifyContent: 'space-between', flexWrap: 'wrap' }}>
            <Button size="sm" icon="message-forward" busy={busy} onClick={() => void continueShown()}>{t('chat.history.continue')}</Button>
            <Button size="sm" variant="ghost" icon="trash" aria-label={t('chat.history.delete_named', { title: title(shown.entry) })} title={t('chat.history.delete')} onClick={() => void remove(shown.entry)} />
          </div>
        </>
      ) : (
        <>
          <div style={{ ...bar, flexWrap: 'wrap' }}>
            <Button variant="ghost" size="icon" icon="arrow-left" className="h-8 w-8" aria-label={t('chat.history.back')} title={t('chat.history.back')} onClick={onClose} />
            <h3 className="bk text-sm font-semibold text-foreground" style={{ margin: 0, flex: 1, minWidth: 0 }} id="assistant-history-title">{t('chat.history.title')}</h3>
            <div style={{ flexBasis: '100%', minWidth: 0 }}>
              <SearchInput value={query} onChange={setQuery} placeholder={t('chat.history.search')} label={t('chat.history.search')} className="w-full" />
            </div>
          </div>
          <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '4px 8px 8px' }}>
            {!index ? <Spinner label={t('common.loading')} /> : (
              <>
                <p role="status" className="bk text-xs text-muted-foreground" style={{ margin: '4px 8px 6px' }}>
                  {index.length === 0 ? t('chat.history.empty') : found.length === 0 ? t('chat.history.none_found') : query.trim() ? t('chat.history.found', { count: found.length }) : t('chat.history.count', { count: index.length })}
                </p>
                <ul aria-labelledby="assistant-history-title" style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
                  {found.map((entry) => (
                    <li key={entry.id} data-history-entry={entry.id} style={{ display: 'flex', alignItems: 'center', gap: 2, minWidth: 0, borderRadius: 6 }} className="bk hover:bg-muted">
                      {renaming === entry.id ? (
                        <form
                          style={{ display: 'flex', alignItems: 'center', gap: 4, flex: 1, minWidth: 0, padding: '4px 0 4px 4px' }}
                          onSubmit={(e) => { e.preventDefault(); void rename(entry.id); }}
                        >
                          <Input
                            autoFocus
                            value={name}
                            maxLength={120}
                            aria-label={t('chat.history.rename_label', { title: title(entry) })}
                            onChange={(e) => setName(e.target.value)}
                            onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setRenaming(null); focus(openSel(entry.id)); } }}
                            style={{ flex: 1, minWidth: 0 }}
                          />
                          <Button type="submit" size="sm" disabled={!name.trim()}>{t('chat.history.save')}</Button>
                        </form>
                      ) : (
                        <>
                          <button
                            type="button"
                            data-history-open={entry.id}
                            className="bk"
                            style={plainButton}
                            aria-describedby={`assistant-history-${entry.id}`}
                            onClick={() => void openChat(entry)}
                          >
                            <span className="bk text-sm text-foreground" style={oneLine}>{title(entry)}</span>
                            {/* Read as the button's description, not twice as part of its name. */}
                            <span id={`assistant-history-${entry.id}`} aria-hidden="true" className="bk text-xs text-muted-foreground" style={oneLine}>{detail(entry)}</span>
                          </button>
                          <RowAction icon="pencil" label={t('chat.history.rename_named', { title: title(entry) })} onClick={() => { setName(entry.title ?? ''); setRenaming(entry.id); }} />
                          <RowAction icon="trash" danger label={t('chat.history.delete_named', { title: title(entry) })} onClick={() => void remove(entry)} />
                        </>
                      )}
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}

/** A turn of an old chat, to read only: no buttons that would act on it. */
function ReadOnlyTurn({ api, turn }) {
  if (turn.role === 'context') return <ContextMarker api={api} turn={turn} />;
  if (turn.role === 'user') return <UserTurn turn={turn} />;
  const parts = partsOf({ ...turn, status: turn.status === 'running' ? 'stopped' : turn.status });
  const said = parts.filter((p) => p.kind === 'say' || p.kind === 'proposal' || p.kind === 'actions' || p.kind === 'replies');
  if (!said.length && !turn.content) return null;
  return (
    <div data-turn="assistant" data-read-only>
      <Stack gap={2}>
        {(said.length ? said : [{ kind: 'say', text: turn.content }]).map((part, i) => (
          part.kind === 'proposal'
            ? <div key={i} style={{ whiteSpace: 'pre-wrap', border: '1px solid var(--color-border)', borderRadius: 8, padding: '8px 10px', fontSize: '0.875rem' }}><Icon name="pencil" size="xs" className="text-muted-foreground" /> {part.text.trim()}</div>
            : <Markdown key={i} text={part.text} onOpenLink={(url) => void api.ui.openExternalUrl?.(url)} />
        ))}
      </Stack>
    </div>
  );
}
