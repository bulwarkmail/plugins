// Area "chat" of the 2.2 work: what it adds to the panel (shapes in
// src/lib/areas/README.md).
//
// - History (reader only): a header button opens the earlier chats in place
//   of the transcript; after 8 hours without use the next opening of the
//   panel moves the chat there and starts a fresh one.
// - Saved prompts (the user's and the administrator's) in the Actions menu.
// - Slash commands: `/` at the start of the input lists the quick actions
//   and saved prompts.
// - Notes the user asked to remember go into the prompt.
// - While the user edits their last message, a chip says so (its x stops it).
// All of it only while the administrator leaves chat tools on.

import { createElement, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { areaAllowed } from '../../../lib/config.js';
import { memoryOn, loadNotes, notesBlock, onNotesChange } from '../../../lib/chat-memory.js';
import { matchCommands, savedPrompts, slashName } from '../../../lib/chat-prompts.js';
import { archiveRunning, deleteHistoryChat, isIdle, loadHistoryChat, startChat } from '../../../lib/chat-history.js';
import { actionLabel, actionsFor, startAction } from '../ActionsMenu.jsx';
import { HistoryPanel } from '../History.jsx';
import { NOTHING } from './nothing.js';

const ACTION_ICONS = {
  improve: 'wand', shorter: 'arrows-minimize', formal: 'tie', casual: 'mood-smile', grammar: 'spell-check', translate: 'language',
  summary: 'align-left', actions: 'checklist', replies: 'message-reply', explain: 'bulb', reply: 'mail-forward',
  today: 'calendar', find: 'search', example_1: 'pencil', example_2: 'pencil', example_3: 'pencil',
};

/** Whether the webmail offers the templates API (all of it the actions use). */
export const templatesOffered = (api) => ['list', 'get', 'create', 'delete'].every((fn) => typeof api?.templates?.[fn] === 'function');

const templateChecks = new WeakMap();
/**
 * Whether the plugin may use the templates: a plugin enabled before the
 * update that added templates:read and templates:write lacks them until the
 * user turns it off and on (or the admin installs it again). Asked once per
 * frame; false after a refusal.
 */
export function templatesUsable(api) {
  if (!api || typeof api !== 'object' || !templatesOffered(api)) return Promise.resolve(false);
  let check = templateChecks.get(api);
  if (!check) {
    check = Promise.resolve()
      .then(() => api.templates.list())
      .then(() => true, (err) => !/permission/i.test(String(err?.message ?? err)));
    templateChecks.set(api, check);
  }
  return check;
}

/**
 * The entries of the / menu: the quick actions that fit what the panel
 * works on, then the areas' entries (saved prompts, Catch me up, ...).
 * Each: { id, label, icon, detail: '/name', run }.
 */
export function slashEntries(chat, extra = []) {
  const { t, mode, source, prefs, bridge } = chat;
  const b = () => bridge?.current ?? {};
  const own = actionsFor(mode, source, { lookups: prefs?.lookups !== false }).map((action) => ({
    id: `action-${action}`,
    label: actionLabel(t, mode, action),
    icon: ACTION_ICONS[action] ?? 'sparkles',
    run: () => {
      const start = startAction(t, action);
      if (start?.send) return b().sendText?.(start.send);
      if (start?.fill) { b().setInput?.(start.fill); b().focus?.(); return undefined; }
      return b().quick?.(action);
    },
  }));
  return [...own, ...extra.map((q) => ({ id: `quick-${q.id}`, label: q.label, icon: q.icon ?? 'sparkles', run: q.run, prompt: q.prompt === true }))]
    .map((entry) => ({ ...entry, detail: `/${slashName(entry.label)}` }));
}

/** Called on every render of the panel, in a fixed order with the other areas. */
export function useArea(chat, props = {}) {
  const { api, t, mode, setup, prefs, turns, setTurns, key, bridge } = chat;
  const config = setup?.config ?? {};
  const allowed = !!setup?.endpoint && areaAllowed(config, 'chat');
  const reader = allowed && mode === 'reader' && !!key;
  const memory = allowed && memoryOn(config, prefs ?? {});
  const [templatesOk, setTemplatesOk] = useState(false);
  useEffect(() => {
    if (!allowed) return undefined;
    let live = true;
    void templatesUsable(api).then((ok) => { if (live) setTemplatesOk(ok); });
    return () => { live = false; };
  }, [api, allowed]);
  const templates = allowed && templatesOk && templatesOffered(api);
  const turnsRef = useRef(turns);
  turnsRef.current = turns;
  const running = (turns ?? []).some((turn) => turn.status === 'running');

  // ─── Notes to remember: read when the panel opens or gets the focus, and when this frame changes them ───
  const [notes, setNotes] = useState([]);
  useEffect(() => {
    if (!memory) { setNotes([]); return undefined; }
    let live = true;
    const read = () => { void loadNotes(api).then((list) => { if (live) setNotes(list); }); };
    read();
    const off = onNotesChange((list) => { if (live) setNotes(list); });
    window.addEventListener('focus', read);
    document.addEventListener('visibilitychange', read);
    return () => { live = false; off(); window.removeEventListener('focus', read); document.removeEventListener('visibilitychange', read); };
  }, [api, memory, props.focusRequest]);

  // ─── History ───
  const [history, setHistory] = useState(false);
  const closeHistory = useCallback(() => {
    setHistory(false);
    // Back to the button that opened it.
    requestAnimationFrame(() => document.querySelector(`[data-assistant-header] button[aria-label="${t('chat.history.title')}"]`)?.focus());
  }, [t]);

  // After 8 hours without use, opening the panel (or coming back to the
  // tab) starts a fresh chat. When another tab started one meanwhile, this
  // one shows that instead of moving it away; when the history can't take
  // the chat (storage full), it stays.
  const archiving = useRef(false);
  useEffect(() => {
    if (!reader) return undefined;
    const check = () => {
      const now = turnsRef.current;
      if (archiving.current || !now.length || now.some((turn) => turn.status === 'running') || !isIdle(api, key, now)) return;
      archiving.current = true;
      void archiveRunning(api, key, now).then(
        (done) => setTurns(done.stale ? done.turns : []),
        (err) => api.log?.warn?.('could not keep the old chat', err?.message ?? err),
      ).finally(() => { archiving.current = false; });
    };
    check();
    const onVisible = () => { if (document.visibilityState === 'visible') check(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [reader, api, key, setTurns, props.focusRequest]);

  // A new request goes to the running chat: the list makes way for it.
  const count = turns?.length ?? 0;
  const lastCount = useRef(count);
  useEffect(() => {
    if ((count > lastCount.current || running) && history) setHistory(false);
    lastCount.current = count;
  }, [count, history, running]);

  /**
   * An old chat becomes the running one: the current chat (with what other
   * frames added) goes into the history first, then the old one starts, and
   * only then leaves the history. Throws when the history is full.
   */
  const continueChat = useCallback(async (id) => {
    const old = await loadHistoryChat(api, id);
    if (!old.length) return;
    const now = turnsRef.current;
    if (now.some((turn) => turn.role === 'user')) await archiveRunning(api, key, now);
    await startChat(api, key, old, { id });
    await deleteHistoryChat(api, id);
    setTurns(old);
    closeHistory();
  }, [api, key, setTurns, closeHistory]);

  // ─── Saved prompts and the / menu ───
  const prompts = useMemo(() => (allowed ? savedPrompts(config, prefs ?? {}) : []), [allowed, config, prefs]);
  const quick = useMemo(() => prompts.map((p) => ({
    id: `chat-prompt-${p.id}`,
    label: p.name,
    prompt: true,
    icon: p.admin ? 'building' : 'bookmark',
    run: () => bridge?.current?.sendText?.(p.text),
  })), [prompts, bridge]);

  const chatRef = useRef(chat);
  chatRef.current = chat;
  const menus = useMemo(() => (allowed ? [{
    trigger: '/',
    label: t('chat.slash.label'),
    items: (query) => {
      const extra = bridge?.current?.areas?.()?.quick ?? quick;
      return matchCommands(slashEntries(chatRef.current, extra), query);
    },
    onPick: (item) => item.run?.(),
    complete: (item) => `/${slashName(item.label)}`,
  }] : []), [allowed, t, bridge, quick]);

  if (!allowed) return NOTHING;
  return {
    toolsCtx: { chatMemory: memory, chatTemplates: templates, chatComposerId: mode === 'composer' ? props.composerId : undefined },
    promptBlocks: memory && notes.length ? [notesBlock(notes)] : [],
    quick,
    menus,
    chips: chat.editing ? [{ key: 'chat-editing', icon: 'pencil', label: t('chat.edit.chip'), title: t('chat.edit.chip'), onRemove: chat.cancelEdit, removeLabel: t('chat.edit.cancel') }] : [],
    // While an answer runs the list can't open (the answer goes to the running chat).
    header: reader ? [{ key: 'chat-history', icon: 'history', label: t('chat.history.title'), onClick: () => (history ? closeHistory() : (!running && setHistory(true))), pressed: history && !running }] : [],
    overlay: reader && history && !running ? createElement(HistoryPanel, { api, onClose: closeHistory, onContinue: continueChat }) : null,
    privacyParts: [
      ...(memory ? ['chat.privacy.notes'] : []),
      ...(templates && prefs?.lookups !== false ? ['chat.privacy.templates'] : []),
    ],
  };
}
