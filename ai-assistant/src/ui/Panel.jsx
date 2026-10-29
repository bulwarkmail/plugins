// The assistant panel: a chat next to the message the user writes
// (composer-sidebar-right) or reads (email-detail-sidebar). It works on what
// the user highlights, else on the whole message; quick actions and typed
// requests go into one transcript, where the model's proposals show as a
// marked change with Replace and Insert buttons, and its lookups as steps.
// The frame fills the panel (slots[...].fill), so the input stays at the
// bottom and the transcript scrolls.

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  Alert, Badge, Button, DiffView, Icon, LinkButton, List, ListRow, Row, RowAction, Select, Spinner, Stack, Text, Textarea,
} from '@plugin-host/ui';
import { ConsentNotice, ErrorMessage, copyWithToast, useApi } from './common.jsx';
import { Markdown, stripMarkdown } from './Markdown.jsx';
import { Widget } from './Widgets.jsx';
import { ActionItems, Replies, emailForPrompt } from './Reader.jsx';
import { keepEdges } from './AssistantDialog.jsx';
import { ensureConsent, loadPrefs, loadSetup, savePrefs } from '../lib/assistant.js';
import { composerChatSystem, readerChatSystem, buildPrompt, contextSuffix, REWRITE_STYLES } from '../lib/prompts.js';
import { loadPerson, localNow } from '../lib/person.js';
import { historyMessages, parseAnswer, runChat } from '../lib/chat.js';
import { runTool, toolsFor } from '../lib/tools.js';
import { MAX_AUTO_ACTIONS, actionToolsFor, describeAction, effectiveActionMode, isActionTool, performAction, undoAction } from '../lib/actions.js';
import { streamCompletion } from '../lib/client.js';
import { AiError } from '../lib/errors.js';
import { defaultTarget, languageOptions } from '../lib/languages.js';
import { acceptAll, applySuggestions, diffSuggestions, pendingSuggestions, reviewParts, reviewStep } from '../lib/grammar.js';
import { diffWords, plainParts } from '../lib/diff.js';
import { COMPOSER_CONTEXT_KEY, COMPOSER_PANEL, DRAFT_KEY, READER_CHAT_KEY, chatKey, pendingKey } from '../lib/background.js';

/** Tallest the chat input grows before it scrolls, in px (about eight lines). */
const INPUT_MAX_HEIGHT = 200;

/** Quick actions on text in the composer. */
export const COMPOSER_ACTIONS = [...REWRITE_STYLES, 'grammar', 'translate'];
/** Quick actions on an open message, and on a highlighted passage of it. */
export const READER_ACTIONS = ['summary', 'actions', 'replies', 'translate'];
export const PASSAGE_ACTIONS = ['explain', 'translate', 'reply'];
/** Turns kept in the transcript (older ones are dropped when saving). */
const MAX_TURNS = 40;
/** A pending request from a right-click entry is dropped after this long. */
const PENDING_TTL_MS = 60_000;

const uid = () => Math.random().toString(36).slice(2, 10);
const excerpt = (text, max = 90) => {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};
const today = () => new Date().toISOString().slice(0, 10);

/** The text a request works on: the selection, else the message. */
export function sourceFor(mode, { selection, body, email }) {
  const selected = selection?.text?.trim() ? selection.text : '';
  if (mode === 'composer') {
    if (selected) return { scope: 'selection', text: selected };
    return body?.trim() ? { scope: 'body', text: body } : { scope: 'empty', text: '' };
  }
  if (selected) return { scope: 'passage', text: selected };
  if (!email) return { scope: 'none', text: '' };
  return { scope: 'message', text: email.text ?? '' };
}

/** The app's areas and settings pages as the user sees them (the webmail's own names, copied per language). */
export function appLabels(t) {
  const keys = ['nav.mail', 'nav.calendar', 'nav.contacts', 'nav.files', 'nav.settings',
    'settings.account', 'settings.security', 'settings.notifications', 'settings.general', 'settings.appearance',
    'settings.message_list', 'settings.reading', 'settings.composing', 'settings.organize', 'settings.filters',
    'settings.vacation', 'settings.calendar', 'settings.contacts', 'settings.files', 'settings.addons', 'settings.backup'];
  return Object.fromEntries(keys.map((key) => [key, t(`app.${key}`)]));
}

/** A context the user can take out: the same text of the same message or draft. */
export function contextKey(mode, source, owner) {
  const text = source.scope === 'selection' || source.scope === 'passage' ? source.text.slice(0, 500) : '';
  return `${mode}:${owner ?? ''}:${source.scope}:${text}`;
}

/**
 * The context in effect: the first one, from the narrowest, that the user
 * did not take out. A highlighted passage falls back to the message, the
 * message to none; in the composer a selection falls back to the draft,
 * which stays (rewrites need it).
 */
export function effectiveSource(mode, { selection, body, email }, removed, owner) {
  const first = sourceFor(mode, { selection, body, email });
  const out = (src) => removed.has(contextKey(mode, src, owner));
  if (!out(first)) return first;
  if (mode === 'composer') return sourceFor(mode, { selection: null, body, email });
  if (first.scope === 'passage') {
    const whole = sourceFor(mode, { selection: null, body, email });
    if (!out(whole)) return whole;
  }
  return { scope: 'none', text: '', removed: true };
}

/** The message the conversation was last about (user turns and markers carry it). */
export function lastTopic(turns) {
  for (let i = turns.length - 1; i >= 0; i--) {
    const turn = turns[i];
    if ((turn.role === 'user' || turn.role === 'context') && turn.emailId !== undefined) return turn.emailId;
  }
  return undefined;
}

/** What a quick action sends, as a task of prompts.js, and how its result is shown. */
export function taskForAction(mode, action, source, { target, email, instruction } = {}) {
  if (mode === 'composer') {
    if (REWRITE_STYLES.includes(action)) return { task: 'rewrite', input: { text: source.text, style: action }, show: 'proposal' };
    if (action === 'translate') return { task: 'translate', input: { text: source.text, target }, show: 'proposal' };
    if (action === 'grammar') return { task: 'grammar', input: { text: source.text }, show: 'grammar' };
    if (action === 'write') return { task: 'write', input: { prompt: instruction, subject: email?.subject ?? '' }, show: 'proposal' };
    return { task: 'edit', input: { text: source.text, instruction }, show: 'proposal' };
  }
  const mail = email ? emailForPrompt(email) : null;
  if (action === 'summary') return { task: 'summary', input: { email: mail }, show: 'text' };
  if (action === 'actions') return { task: 'actions', input: { email: mail, today: today() }, show: 'actions' };
  if (action === 'replies') return { task: 'replies', input: { email: mail }, show: 'replies' };
  if (action === 'explain') return { task: 'explain', input: { email: mail, text: source.text }, show: 'text' };
  return { task: 'translate', input: { text: source.text, target }, show: 'text' };
}

/** Load a saved transcript; [] when there is none. */
async function loadTurns(api, key) {
  try {
    const saved = await api.storage.get(key);
    const turns = Array.isArray(saved?.turns) ? saved.turns : [];
    // A turn that was still running when the panel went away is shown as
    // stopped, and an action that waited for the user's OK did not happen.
    return turns.map((t) => {
      const turn = t.status === 'running' ? { ...t, status: t.content ? 'stopped' : 'error', error: t.content ? undefined : { code: 'cancelled' } } : t;
      if (!Array.isArray(turn.steps) || !turn.steps.some((s) => s.action && (s.action.state === 'waiting' || s.action.state === 'running'))) return turn;
      return { ...turn, steps: turn.steps.map((s) => (s.action && (s.action.state === 'waiting' || s.action.state === 'running') ? { ...s, action: { ...s.action, state: 'skipped' } } : s)) };
    });
  } catch {
    return [];
  }
}

export function AssistantPanel(props) {
  const api = useApi(props);
  const t = api.i18n.t;
  const locale = api.i18n.getLocale?.() ?? 'en';
  const mode = props.composerId ? 'composer' : 'reader';
  const id = mode === 'composer' ? props.composerId : props.email?.id;
  const email = props.email ?? null;
  const selection = props.selection ?? null;
  // The composer keeps a chat per draft; the reader one conversation across
  // the messages the user opens.
  const key = mode === 'composer' ? (id ? chatKey(mode, id) : null) : READER_CHAT_KEY;

  const [setup, setSetup] = useState(null);
  const [prefs, setPrefs] = useState({});
  const [person, setPerson] = useState(null);
  const [turns, setTurns] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [body, setBody] = useState('');
  const [context, setContext] = useState(null);
  const [subject, setSubject] = useState('');
  const [input, setInput] = useState('');
  const [consent, setConsent] = useState(null);
  const [target, setTarget] = useState(defaultTarget(locale));
  const [translating, setTranslating] = useState(false);
  const languages = useMemo(() => languageOptions(locale), [locale]);
  const inputRef = useRef(null);
  const [inputFocused, setInputFocused] = useState(false);
  // The box around the text field shows its focus, so the field drops the
  // kit's own outline, which would draw a second frame inside the box. In
  // forced colours the box's border colour is lost, so the outline stays.
  const setInputEl = useCallback((el) => {
    inputRef.current = el;
    if (el && !window.matchMedia?.('(forced-colors: active)').matches) el.style.setProperty('outline', 'none', 'important');
  }, []);
  // The text field grows with its text up to INPUT_MAX_HEIGHT, then scrolls.
  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    if (el.scrollHeight > 0) el.style.height = `${Math.min(el.scrollHeight, INPUT_MAX_HEIGHT)}px`;
  }, [input]);
  const scrollRef = useRef(null);
  const controller = useRef(null);
  const turnsRef = useRef(turns);
  turnsRef.current = turns;

  // Contexts the user took out with the chip's x, until another message or
  // another selection brings a new one.
  const [removed, setRemoved] = useState(() => new Set());
  const owner = mode === 'composer' ? props.composerId : email?.id;
  const source = useMemo(() => effectiveSource(mode, { selection, body, email }, removed, owner), [mode, selection, body, email, removed, owner]);
  // The message as far as the model may see it.
  const contextEmail = source.scope === 'none' ? null : email;
  const removeContext = useCallback(() => {
    setRemoved((prev) => new Set(prev).add(contextKey(mode, source, owner)));
  }, [mode, source, owner]);
  const restoreContext = useCallback(() => setRemoved(new Set()), []);
  const running = turns.some((turn) => turn.status === 'running');
  const lookups = prefs.lookups !== false;
  const actionMode = effectiveActionMode(setup?.config ?? {}, prefs);
  // Actions waiting for the user's OK: step id → answer(ok).
  const approvals = useRef(new Map());

  // ─── Loading: the service, the user's choices, the saved transcript ───
  const refreshBody = useCallback(async () => {
    if (mode !== 'composer' || !props.composerId) return;
    try {
      const read = await api.composer.getBody(props.composerId);
      setBody(read?.text ?? '');
    } catch { /* the composer is gone */ }
  }, [api, mode, props.composerId]);

  useEffect(() => {
    let live = true;
    // Another message or composer: nothing of the old chat is shown or saved
    // under the new key while its own transcript loads.
    setLoaded(false);
    setTurns([]);
    void (async () => {
      const [next, saved, ctx, draft, who] = await Promise.all([
        loadSetup(api).catch(() => ({ endpoint: null, prefs: {} })),
        key ? loadTurns(api, key) : [],
        api.storage.get(COMPOSER_CONTEXT_KEY).catch(() => null),
        api.storage.get(DRAFT_KEY).catch(() => null),
        loadPerson(api, locale).catch(() => null),
      ]);
      if (!live) return;
      setSetup(next);
      setPerson(who);
      setPrefs(next.prefs ?? {});
      setTarget(defaultTarget(locale, next.prefs?.translateTo));
      setTurns(saved);
      setContext(ctx && typeof ctx === 'object' ? ctx : null);
      if (typeof draft?.subject === 'string') setSubject(draft.subject);
      setLoaded(true);
    })();
    void refreshBody();
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  // The message the user wrote changes while they type; look again when
  // they pick text or come back to the panel.
  useEffect(() => { void refreshBody(); }, [refreshBody, selection?.text, props.focusRequest]);

  // Save the transcript as it changes (not while an answer streams).
  useEffect(() => {
    if (!loaded || !key || running) return;
    const timer = setTimeout(() => {
      void api.storage.set(key, { turns: turns.slice(-MAX_TURNS), at: Date.now() }).catch(() => {});
    }, 300);
    return () => clearTimeout(timer);
  }, [api, key, turns, loaded, running]);

  // Keep the newest turn in view.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [turns]);

  // ─── The transcript ───
  const patchTurn = useCallback((turnId, patch) => {
    setTurns((prev) => prev.map((turn) => (turn.id === turnId ? { ...turn, ...(typeof patch === 'function' ? patch(turn) : patch) } : turn)));
  }, []);

  const stop = useCallback(() => {
    controller.current?.abort();
    consent?.answer(false);
  }, [consent]);

  const patchStep = useCallback((turnId, stepId, patch) => {
    patchTurn(turnId, (cur) => ({ steps: (cur.steps ?? []).map((s) => (s.id === stepId ? { ...s, ...(typeof patch === 'function' ? patch(s) : patch) } : s)) }));
  }, [patchTurn]);

  /** The user's answer to an action waiting for it. */
  const answerAction = useCallback((stepId, ok) => {
    const answer = approvals.current.get(stepId);
    if (!answer) return;
    approvals.current.delete(stepId);
    answer(ok);
  }, []);

  const undoStep = useCallback(async (turnId, step) => {
    try {
      await undoAction(api, step.action?.undo);
      patchStep(turnId, step.id, (s) => ({ action: { ...s.action, state: 'undone', undo: null } }));
    } catch (err) {
      api.toast.error(t('action.undo_failed'));
      api.log?.warn?.('undo failed', err?.message ?? err);
    }
  }, [api, patchStep, t]);

  const askConsent = useCallback((endpoint) => new Promise((resolve) => {
    setConsent({ endpoint, answer: (ok) => { setConsent(null); resolve(ok); } });
  }), []);

  /**
   * One exchange: a quick action (a task of prompts.js) or a typed request
   * (the chat). `label` is what the user turn shows; `sent` what the chat
   * sends when it differs.
   */
  /** Who the user is and their standing instructions, for this request. */
  const extraContext = useCallback(() => contextSuffix({
    person: person ? { ...person, now: localNow(person.timeZone) } : null,
    instructions: { admin: setup?.config?.instructions, user: prefs.instructions },
    place: { panel: mode, labels: appLabels(t) },
  }), [person, setup, prefs, mode, t]);

  const send = useCallback(async ({ label, sent, task, input: taskInput, show, scope, src }) => {
    const endpoint = setup?.endpoint;
    if (!endpoint) return;
    controller.current?.abort();
    const abort = new AbortController();
    controller.current = abort;
    const previous = turnsRef.current;
    // In the reader the conversation runs on while the user opens other
    // messages: a line in the transcript names the message a question is
    // about when it is not the one before, and the model hears of it.
    const emailId = mode === 'reader' ? (contextEmail?.id ?? null) : undefined;
    const switched = mode === 'reader' && contextEmail && previous.length > 0 && lastTopic(previous) !== contextEmail.id;
    const marker = switched ? [{ id: uid(), role: 'context', emailId: contextEmail.id, subject: contextEmail.subject ?? '' }] : [];
    const note = switched ? `(Now about another message: "${contextEmail.subject ?? ''}" from ${contextEmail.from?.[0]?.name || contextEmail.from?.[0]?.email || 'unknown'}.)\n` : '';
    const userTurn = { id: uid(), role: 'user', content: note + (sent ?? label), label, ...(emailId !== undefined ? { emailId } : {}) };
    const turn = { id: uid(), role: 'assistant', content: '', status: 'running', task: task ?? 'chat', show: show ?? 'chat', scope, source: src ?? '', steps: [], ...(task ? { input: taskInput ?? {} } : {}) };
    setTurns([...previous, ...marker, userTurn, turn]);
    try {
      if (!(await ensureConsent(api, endpoint, askConsent))) throw new AiError('declined');
      if (abort.signal.aborted) throw new AiError('cancelled');
      const onText = (full) => patchTurn(turn.id, { content: full });
      let text;
      const extra = extraContext();
      if (task) {
        const prompt = buildPrompt(task, { language: locale, extra, ...taskInput });
        text = await streamCompletion(api, endpoint, prompt, { onText, signal: abort.signal });
      } else {
        const ctx = { inReplyToId: mode === 'composer' ? context?.inReplyToId : undefined, lookups, actions: actionMode, mode, openEmailId: mode === 'reader' ? contextEmail?.id : undefined, settingsName: t('app.nav.settings') };
        const tools = [...toolsFor(ctx), ...actionToolsFor(ctx)];
        let autoActions = 0;
        // Lookups run straight away; an action is shown first, then waits for
        // the user's OK (ask-first mode, or past the automatic limit) or runs.
        const callTool = async (name, args, call) => {
          if (!isActionTool(name)) return runTool(api, name, args, ctx);
          const { summary, plan } = await describeAction(api, name, args, ctx);
          const ask = actionMode === 'manual' || autoActions >= MAX_AUTO_ACTIONS;
          patchStep(turn.id, call.id, { action: { summary, state: ask ? 'waiting' : 'running' } });
          if (ask) {
            const ok = await new Promise((resolve) => {
              approvals.current.set(call.id, resolve);
              abort.signal.addEventListener('abort', () => { approvals.current.delete(call.id); resolve(false); }, { once: true });
            });
            if (!ok) return { text: 'The user did not allow this action; it was not done.', action: { summary, state: 'skipped' } };
            patchStep(turn.id, call.id, (st) => ({ action: { ...st.action, state: 'running' } }));
          } else {
            autoActions++;
          }
          try {
            const done = await performAction(api, plan);
            return { text: done.text, action: { summary, state: 'done', undo: done.undo ?? null } };
          } catch (err) {
            patchStep(turn.id, call.id, (st) => ({ action: { ...st.action, state: 'failed' } }));
            throw err;
          }
        };
        const system = mode === 'composer'
          ? composerChatSystem({ language: locale, today: today(), subject, mode: context?.mode, originalSubject: context?.originalSubject, scope, text: src, hasTools: tools.length > 0, actions: actionMode, extra })
          : readerChatSystem({ language: locale, today: today(), email: contextEmail ? emailForPrompt(contextEmail) : null, emailId: contextEmail?.id, selection: scope === 'passage' ? src : '', hasTools: tools.length > 0, actions: actionMode, extra });
        const messages = [...historyMessages(previous), { role: 'user', content: userTurn.content }];
        const out = await runChat(api, endpoint, {
          system, messages, tools, runTool: callTool,
        }, {
          onText,
          onStep: (step) => patchTurn(turn.id, (cur) => ({ steps: cur.steps.some((s) => s.id === step.id) ? cur.steps.map((s) => (s.id === step.id ? { ...s, ...step } : s)) : [...cur.steps, step] })),
          signal: abort.signal,
        });
        text = out.text;
      }
      if (task === 'grammar') {
        const corrected = keepEdges(src, text) || src;
        patchTurn(turn.id, { content: text, status: 'done', review: { segments: diffSuggestions(src, corrected), states: {} } });
      } else {
        patchTurn(turn.id, { content: text, status: 'done' });
      }
    } catch (err) {
      const error = err instanceof AiError ? err : new AiError('unreachable', { detail: err?.message });
      if (!(err instanceof AiError) || error.detail) api.log?.warn?.(`${task ?? 'chat'} failed`, err?.message ?? err);
      if (error.code === 'declined') {
        setTurns((prev) => prev.filter((x) => x.id !== turn.id && x.id !== userTurn.id));
      } else if (error.code === 'cancelled') {
        patchTurn(turn.id, (cur) => ({ status: 'stopped', content: error.partial || cur.content }));
      } else {
        patchTurn(turn.id, (cur) => ({ status: 'error', content: error.partial || cur.content, error: { code: error.code, detail: error.detail, retryAfter: error.retryAfter } }));
      }
    } finally {
      if (controller.current === abort) controller.current = null;
    }
  }, [api, setup, askConsent, patchTurn, locale, mode, context, lookups, subject, contextEmail, extraContext, t]);

  /** A quick action on the current source (or on `text` from a right-click). */
  const quick = useCallback((action, { text, targetTag } = {}) => {
    const src = text ? { scope: mode === 'composer' ? 'selection' : 'passage', text } : source;
    if (action === 'reply') {
      void send({
        label: `${t('panel.quick.reply')} · ${t(`panel.scope.${src.scope}`)}`,
        sent: src.scope === 'passage' ? `Draft a reply to this email that answers the passage I highlighted:\n<passage>\n${src.text}\n</passage>` : 'Draft a reply to this email.',
        scope: src.scope, src: src.text,
      });
      return;
    }
    const { task, input: taskInput, show } = taskForAction(mode, action, src, { target: targetTag ?? target, email });
    const scopeLabel = t(`panel.scope.${src.scope}`);
    const name = action === 'translate'
      ? t('panel.translate_to', { language: languages.find((l) => l.tag === (targetTag ?? target))?.label ?? (targetTag ?? target) })
      : t(mode === 'composer' ? `assistant.action.${action}` : `reader.${action}`, {});
    if (action !== 'translate' && mode === 'composer') void savePrefs(api, { lastAction: action });
    void send({ label: `${name} · ${scopeLabel}`, task, input: taskInput, show, scope: src.scope, src: src.text });
  }, [api, mode, source, target, email, languages, send, t]);

  /** The typed request. */
  const submit = useCallback(() => {
    const text = input.trim();
    if (!text || running || !setup?.endpoint) return;
    setInput('');
    void send({ label: text, scope: source.scope, src: source.text });
  }, [input, running, setup, send, source]);

  // ─── Requests from the toolbar button and the right-click menu ───
  // The input takes the focus when the panel is asked for (a new
  // focusRequest) or a request waits; opening another message leaves the
  // focus where the user is (the list, the message).
  const lastFocusRequest = useRef(props.focusRequest);
  useEffect(() => {
    const asked = props.focusRequest !== lastFocusRequest.current;
    lastFocusRequest.current = props.focusRequest;
    if (asked) inputRef.current?.focus();
  }, [props.focusRequest]);
  useEffect(() => {
    if (!loaded || !id) return;
    let live = true;
    void (async () => {
      const pkey = pendingKey(mode, id);
      let pending = null;
      try { pending = await api.storage.get(pkey); } catch { pending = null; }
      if (!live || !pending || typeof pending !== 'object') return;
      await api.storage.remove(pkey).catch(() => {});
      if (!pending.at || Date.now() - pending.at > PENDING_TTL_MS) return;
      if (pending.action === 'ask' || !pending.action) {
        inputRef.current?.focus();
        return;
      }
      quick(pending.action, pending.text ? { text: pending.text } : {});
    })();
    if (mode === 'composer') inputRef.current?.focus();
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded, id, props.focusRequest]);

  // ─── Applying a proposal ───
  const apply = useCallback(async (turn, how, text) => {
    patchTurn(turn.id, { applying: how });
    try {
      let ok;
      if (mode === 'reader') {
        ok = await api.compose.reply(email.id, { text: text.trim() });
      } else if (how === 'below') {
        ok = await api.composer.replaceSelection(props.composerId, { text: text.trim() }, { below: true });
      } else if (how === 'cursor') {
        ok = await api.composer.replaceSelection(props.composerId, { text: text.trim() });
      } else if (turn.scope === 'selection') {
        ok = await api.composer.replaceSelection(props.composerId, { text });
      } else {
        ok = await api.composer.replaceBody(props.composerId, { text: text.trim() });
      }
      if (ok === false) throw new Error('refused');
      patchTurn(turn.id, { applying: null, applied: how });
      void refreshBody();
    } catch (err) {
      api.log?.warn?.('could not change the message', err?.message ?? err);
      patchTurn(turn.id, { applying: null, applyFailed: true });
    }
  }, [api, mode, email, props.composerId, patchTurn, refreshBody]);

  /** A widget's request: into the chat, on the current text. */
  const sendText = useCallback((text) => {
    const value = String(text ?? '').trim();
    if (!value || running || !setup?.endpoint) return;
    void send({ label: value, scope: source.scope, src: source.text });
  }, [running, setup, send, source]);

  /** A widget's text into the message, where the cursor is. */
  const insertText = useCallback(async (text) => {
    if (mode !== 'composer') return;
    try {
      const ok = await api.composer.replaceSelection(props.composerId, { text: String(text ?? '') });
      if (ok === false) throw new Error('refused');
      void refreshBody();
    } catch (err) {
      api.log?.warn?.('could not insert', err?.message ?? err);
      api.toast.error(t('assistant.apply_failed'));
    }
  }, [api, mode, props.composerId, refreshBody, t]);

  const clear = useCallback(() => {
    stop();
    setTurns([]);
    if (key) void api.storage.remove(key).catch(() => {});
  }, [api, key, stop]);

  const retry = useCallback((turn) => {
    const i = turnsRef.current.findIndex((x) => x.id === turn.id);
    const userTurn = i > 0 ? turnsRef.current[i - 1] : null;
    if (!userTurn || userTurn.role !== 'user') return;
    // send() starts from turnsRef: drop the failed exchange there too, before React re-renders.
    const rest = turnsRef.current.filter((x) => x.id !== turn.id && x.id !== userTurn.id);
    turnsRef.current = rest;
    setTurns(rest);
    if (turn.task && turn.task !== 'chat' && turn.input) {
      // The quick action again, with what it was asked the first time.
      void send({ label: userTurn.label ?? userTurn.content, task: turn.task, input: turn.input, show: turn.show, scope: turn.scope, src: turn.source });
    } else {
      void send({ label: userTurn.label ?? userTurn.content, sent: userTurn.content, scope: turn.scope, src: turn.source });
    }
  }, [send]);

  // ─── Rendering ───
  const fill = { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 };
  if (!loaded) {
    return <div style={{ ...fill, alignItems: 'center', justifyContent: 'center' }}><Spinner label={t('common.loading')} /></div>;
  }
  if (!setup?.endpoint) {
    return (
      <div style={{ padding: 16 }}>
        <Alert tone="info" icon="sparkles">
          <Stack gap={1}>
            <Text weight="medium">{t('panel.not_set_up')}</Text>
            <Text tone="muted" size="xs">{t('panel.not_set_up_hint')}</Text>
          </Stack>
        </Alert>
      </div>
    );
  }

  const contextLabel = {
    selection: t('panel.context.selection'),
    body: t('panel.context.body'),
    empty: t('panel.context.empty'),
    message: t('panel.context.message'),
    passage: t('panel.context.passage'),
    none: t('panel.context.none'),
  }[source.scope];
  const contextIcon = source.scope === 'selection' || source.scope === 'passage' ? 'highlight' : source.scope === 'empty' ? 'pencil' : source.scope === 'none' ? 'mail-off' : 'mail';
  // A whole message goes by its subject; highlighted text and the draft by their first words.
  const mailSubject = (email?.subject ?? '').trim();
  const contextDetail = source.scope === 'message' && mailSubject ? excerpt(mailSubject, 60) : source.text ? excerpt(source.text, 40) : '';
  const contextTitle = source.scope === 'message' && mailSubject ? mailSubject : source.text ? excerpt(source.text, 400) : contextLabel;
  const actions = mode === 'composer'
    ? (source.scope === 'empty' ? [] : COMPOSER_ACTIONS)
    : (source.scope === 'passage' ? PASSAGE_ACTIONS : source.scope === 'none' ? [] : READER_ACTIONS);
  const actionLabel = (action) => {
    if (action === 'translate') return t('assistant.action.translate');
    if (mode === 'composer') return t(`assistant.action.${action}`);
    return t(action === 'explain' || action === 'reply' ? `panel.quick.${action}` : `reader.${action}`);
  };
  const placeholder = mode === 'reader'
    ? t(source.scope === 'none' ? 'panel.placeholder.none' : 'panel.placeholder.read')
    : source.scope === 'empty' ? t('panel.placeholder.write') : t('panel.placeholder.compose');

  return (
    <div style={fill} data-assistant-panel={mode}>
      <div style={{ padding: '10px 16px 8px', borderBottom: '1px solid var(--color-border)', flexShrink: 0 }}>
        <Row justify="between" wrap={false}>
          <Row gap={1} wrap={false}>
            <Icon name="sparkles" size="sm" className="text-primary" />
            <Text size="sm" weight="semibold">{t('composer.title')}</Text>
          </Row>
          {turns.length > 0 && (
            <Button variant="ghost" size="icon" icon="eraser" title={t('panel.new_chat')} aria-label={t('panel.new_chat')} onClick={clear} />
          )}
        </Row>
      </div>

      {/* The transcript. */}
      <div ref={scrollRef} style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '12px 16px' }} data-assistant-transcript>
        {turns.length === 0 && !consent && (
          <Stack gap={2}>
            <Text tone="muted" size="xs">{t(mode === 'reader' ? (source.scope === 'none' ? 'panel.empty.none' : 'panel.empty.read') : source.scope === 'empty' ? 'panel.empty.write' : 'panel.empty.compose')}</Text>
            {mode === 'composer' && source.scope === 'empty' && (
              <Stack gap={1}>
                {[1, 2, 3].map((n) => (
                  <LinkButton key={n} icon="arrow-right" onClick={() => { setInput(t(`panel.example_${n}`)); inputRef.current?.focus(); }}>{t(`panel.example_${n}`)}</LinkButton>
                ))}
              </Stack>
            )}
          </Stack>
        )}
        <Stack gap={4}>
          {turns.map((turn) => (
            turn.role === 'context'
              ? <ContextMarker key={turn.id} api={api} turn={turn} />
              : turn.role === 'user'
              ? <UserTurn key={turn.id} turn={turn} />
              : (
                <AssistantTurn
                  key={turn.id}
                  api={api}
                  mode={mode}
                  turn={turn}
                  email={email}
                  onApply={apply}
                  onRetry={retry}
                  onReview={(review) => patchTurn(turn.id, { review })}
                  onSend={sendText}
                  onInsert={insertText}
                  onAnswerAction={answerAction}
                  onUndo={undoStep}
                />
              )
          ))}
          {consent && (
            <Stack gap={2}>
              <ConsentNotice api={api} consent={consent} />
              <Row justify="end">
                <Button variant="secondary" size="sm" onClick={() => consent.answer(false)}>{t('common.cancel')}</Button>
                <Button size="sm" onClick={() => consent.answer(true)}>{t('privacy.continue')}</Button>
              </Row>
            </Stack>
          )}
        </Stack>
      </div>

      {/* The input: one box with the text field on top and, under it, what
          the assistant works on, the quick actions and Send. A click on the
          box outside its buttons goes to the text field. */}
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
                submit();
              } else if (e.key === 'Escape' && !input && mode === 'composer') {
                // Back to the message; Alt+A brings the panel back.
                e.preventDefault();
                void api.ui.closePanel?.(COMPOSER_PANEL, { composerId: props.composerId })?.catch?.(() => {});
              }
            }}
          />
          <div style={{ display: 'flex', alignItems: 'center', gap: 4, minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 4, flex: 1, minWidth: 0 }}>
              {source.removed && email ? (
                <ContextChip icon="plus" label={t('panel.context.add_message')} title={email.subject || contextLabel} dashed onClick={restoreContext} />
              ) : source.scope !== 'none' && source.scope !== 'empty' && (
                <ContextChip
                  icon={contextIcon}
                  label={contextLabel}
                  detail={contextDetail || undefined}
                  title={contextTitle}
                  removeLabel={t('panel.context.remove')}
                  onRemove={source.scope === 'message' || source.scope === 'passage' || source.scope === 'selection' ? removeContext : undefined}
                />
              )}
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
                      quick('translate', { targetTag: value });
                    }}
                  />
                  <Button variant="ghost" size="icon" icon="x" aria-label={t('common.cancel')} onClick={() => setTranslating(false)} />
                </Row>
              ) : (
                <ActionsMenu
                  api={api}
                  actions={actions}
                  actionLabel={actionLabel}
                  disabled={running}
                  onPick={(action) => (action === 'translate' ? setTranslating(true) : quick(action))}
                />
              ))}
            </div>
            {running
              ? <Button variant="secondary" size="icon" icon="player-stop" className="h-8 w-8 shrink-0 rounded-full" title={t('common.stop')} aria-label={t('common.stop')} onClick={stop} />
              : <Button variant={input.trim() ? 'primary' : 'secondary'} size="icon" icon="arrow-up" className="h-8 w-8 shrink-0 rounded-full" disabled={!input.trim()} title={t('panel.send')} aria-label={t('panel.send')} onClick={submit} />}
          </div>
        </div>
      </div>
    </div>
  );
}

const ACTION_ICONS = {
  improve: 'wand', shorter: 'arrows-minimize', formal: 'tie', casual: 'mood-smile', grammar: 'spell-check', translate: 'language',
  summary: 'align-left', actions: 'checklist', replies: 'message-reply', explain: 'bulb', reply: 'mail-forward',
};

/** The quick actions, in a menu that opens above its button. */
function ActionsMenu({ api, actions, actionLabel, disabled, onPick }) {
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
              <span>{actionLabel(action)}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * What the assistant works on, as a chip above the input. With onRemove an
 * x shows while the pointer is over the chip (or the keyboard is in it) and
 * takes the context out; `dashed` with onClick is the chip that brings it back.
 */
function ContextChip({ icon, label, detail, title, onRemove, removeLabel, onClick, dashed = false }) {
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

/** A line in the transcript: from here on the conversation is about another message. */
function ContextMarker({ api, turn }) {
  const rule = { flex: 1, height: 1, background: 'var(--color-border)' };
  return (
    <div data-turn="context" style={{ display: 'flex', alignItems: 'center', gap: 8 }} title={turn.subject}>
      <span style={rule} />
      <Icon name="mail" size="xs" className="text-muted-foreground" />
      <Text size="xs" tone="muted" className="truncate">{api.i18n.t('panel.context.now', { subject: turn.subject || '…' })}</Text>
      <span style={rule} />
    </div>
  );
}

function UserTurn({ turn }) {
  return (
    <Row justify="end">
      <div style={{ maxWidth: '85%', background: 'var(--color-muted)', color: 'var(--color-foreground)', borderRadius: 12, padding: '6px 10px' }} data-turn="user">
        <Text size="sm">{turn.label ?? turn.content}</Text>
      </div>
    </Row>
  );
}

/** The model's answer: what it says, what it proposes, what it looked up. */
function AssistantTurn({ api, mode, turn, email, onApply, onRetry, onReview, onSend, onInsert, onAnswerAction, onUndo }) {
  const t = api.i18n.t;
  const running = turn.status === 'running';
  const parts = useMemo(() => partsOf(turn), [turn]);
  const lookupSteps = (turn.steps ?? []).filter((s) => !isActionTool(s.name));
  const actionSteps = (turn.steps ?? []).filter((s) => isActionTool(s.name) && (s.action || s.status === 'failed'));
  return (
    <div data-turn="assistant" data-status={turn.status}>
    <Stack gap={2}>
      {lookupSteps.length > 0 && <StepsGroup api={api} mode={mode} steps={lookupSteps} running={running} onSend={onSend} onInsert={onInsert} />}
      {actionSteps.map((step) => (
        <ActionCard key={step.id} api={api} step={step} onAnswer={(ok) => onAnswerAction(step.id, ok)} onUndo={() => onUndo(turn.id, step)} />
      ))}
      {running && !turn.content && (!turn.steps || turn.steps.every((s) => s.status !== 'running')) && <Spinner label={t('common.thinking')} />}
      {turn.show === 'grammar' && turn.review
        ? <GrammarCard api={api} turn={turn} onApply={onApply} onReview={onReview} />
        : parts.map((part, i) => (
          part.kind === 'say'
            ? <SayPart key={i} api={api} mode={mode} turn={turn} text={part.text} onApply={onApply} />
            : part.kind === 'widget'
              ? (part.widget ? <Widget key={i} api={api} mode={mode} widget={part.widget} onSend={onSend} onInsert={onInsert} /> : null)
            : part.kind === 'actions'
              ? <ActionItems key={i} api={api} answer={part.text} />
              : part.kind === 'replies'
                ? <Replies key={i} api={api} answer={part.text} email={email} />
                : (
                  <ProposalCard
                    key={i}
                    api={api}
                    mode={mode}
                    turn={turn}
                    text={part.text}
                    streaming={running || part.open}
                    plain={part.plain}
                    onApply={onApply}
                  />
                )
        ))}
      {turn.status === 'stopped' && <Text tone="muted" size="xs">{t('common.stopped')}</Text>}
      {turn.status === 'error' && <ErrorMessage api={api} error={Object.assign(new AiError(turn.error?.code ?? 'unreachable', turn.error ?? {}), {})} onRetry={() => onRetry(turn)} />}
      {turn.applyFailed && <Alert tone="danger">{t('assistant.apply_failed')}</Alert>}
    </Stack>
    </div>
  );
}

/** What the model says. In the composer it can still go into the message when the model left the tags out. */
function SayPart({ api, mode, turn, text, onApply }) {
  const t = api.i18n.t;
  const offer = mode === 'composer' && turn.status === 'done' && turn.show === 'chat' && !turn.applied
    && !(turn.content ?? '').includes('<text') && text.split(/\s+/).length >= 12;
  return (
    <Stack gap={1}>
      <Markdown text={text} onOpenLink={(url) => void api.ui.openExternalUrl?.(url)} />
      {offer && (
        <Row>
          <LinkButton icon="text-plus" onClick={() => onApply(turn, 'cursor', stripMarkdown(text))}>{t('panel.insert_cursor')}</LinkButton>
        </Row>
      )}
    </Stack>
  );
}

/** The pieces of an answer as the transcript shows them. */
export function partsOf(turn) {
  const text = turn.content ?? '';
  if (turn.show === 'actions') return turn.status === 'done' ? [{ kind: 'actions', text }] : [];
  if (turn.show === 'replies') return turn.status === 'done' ? [{ kind: 'replies', text }] : [];
  if (turn.show === 'text') return text ? [{ kind: 'say', text }] : [];
  if (turn.show === 'proposal') return text ? [{ kind: 'proposal', text, open: turn.status === 'running', plain: false }] : [];
  // The chat: proposals are tagged, the rest is talk.
  return proposalParts(text);
}

function proposalParts(text) {
  const out = [];
  for (const piece of (text ? parseAnswer(text) : [])) {
    if (piece.kind === 'say') out.push({ kind: 'say', text: piece.text });
    else if (piece.kind === 'widget') out.push({ kind: 'widget', widget: piece.widget, open: piece.open });
    else out.push({ kind: 'proposal', text: piece.text, open: piece.open, plain: false });
  }
  return out;
}

/** A proposal: the change marked against the text it replaces, and the buttons to take it. */
function ProposalCard({ api, mode, turn, text, streaming, onApply }) {
  const t = api.i18n.t;
  const source = turn.source ?? '';
  const scope = turn.scope;
  const composerEdit = mode === 'composer' && (scope === 'selection' || scope === 'body');
  const shown = streaming && composerEdit ? (/^\s*/.exec(source)[0] + text.replace(/^\s+/, '')) : (composerEdit ? (keepEdges(source, text) || text) : text);
  const parts = composerEdit ? diffWords(source, shown, { partial: streaming }) : plainParts(text.trim());
  const ready = !streaming && !!text.trim() && !turn.applying;
  const applied = turn.applied;
  const final = composerEdit ? (keepEdges(source, text) || text) : text;
  return (
    <div data-proposal>
    <Stack gap={2}>
      <DiffView parts={parts} streaming={streaming} label={t('assistant.preview_label')} />
      {applied ? (
        <Row gap={2}>
          <Badge tone="success">{t(applied === 'reply' ? 'panel.applied.reply' : applied === 'replace' ? 'panel.applied.replace' : 'panel.applied.insert')}</Badge>
          {applied !== 'reply' && <Text size="xs" tone="muted">{t('panel.undo_hint')}</Text>}
        </Row>
      ) : (
        <Row gap={1}>
          {mode === 'reader' ? (
            <Button size="sm" icon="arrow-back-up" disabled={!ready} busy={turn.applying === 'reply'} onClick={() => onApply(turn, 'reply', final)}>{t('panel.open_reply')}</Button>
          ) : scope === 'selection' ? (
            <>
              <Button size="sm" disabled={!ready} busy={turn.applying === 'replace'} onClick={() => onApply(turn, 'replace', final)}>{t('assistant.replace')}</Button>
              <Button size="sm" variant="secondary" disabled={!ready} busy={turn.applying === 'below'} onClick={() => onApply(turn, 'below', final)}>{t('assistant.insert_below')}</Button>
            </>
          ) : scope === 'body' ? (
            <>
              <Button size="sm" disabled={!ready} busy={turn.applying === 'replace'} onClick={() => onApply(turn, 'replace', final)}>{t('panel.replace_message')}</Button>
              <Button size="sm" variant="secondary" disabled={!ready} busy={turn.applying === 'cursor'} onClick={() => onApply(turn, 'cursor', final)}>{t('panel.insert_cursor')}</Button>
            </>
          ) : (
            <Button size="sm" disabled={!ready} busy={turn.applying === 'replace'} onClick={() => onApply(turn, 'replace', final)}>{t('assistant.insert')}</Button>
          )}
          <Button size="sm" variant="ghost" icon="copy" disabled={!ready} aria-label={t('common.copy')} title={t('common.copy')} onClick={() => void copyWithToast(api, final.trim())} />
        </Row>
      )}
    </Stack>
    </div>
  );
}

/** Spelling fixes, one by one or all at once. */
function GrammarCard({ api, turn, onApply, onReview }) {
  const t = api.i18n.t;
  const review = turn.review;
  const pending = pendingSuggestions(review.segments, review.states);
  const total = review.segments.filter((s) => s.kind === 'change').length;
  const accepted = Object.values(review.states).some((s) => s === 'accepted');
  const decide = (id, state) => onReview(reviewStep(review, id, state).review);
  const label = (s) => (s.from.trim() ? `${s.from.trim()} → ${s.to.trim() || '∅'}` : `+ ${s.to.trim()}`);
  if (total === 0) return <Alert tone="success" icon="check">{t('grammar.none')}</Alert>;
  return (
    <div data-proposal>
    <Stack gap={2}>
      <Text tone="muted" size="xs">{t('grammar.count', { open: pending.length, total })}</Text>
      <DiffView parts={reviewParts(review.segments, review.states)} label={t('assistant.preview_label')} />
      {pending.length > 0 && (
        <List label={t('assistant.suggestions')}>
          {pending.map((s) => (
            <ListRow
              key={s.id}
              title={label(s)}
              actions={(
                <>
                  <RowAction icon="check" label={t('grammar.accept_label', { from: s.from.trim(), to: s.to.trim() })} onClick={() => decide(s.id, 'accepted')} />
                  <RowAction icon="x" label={t('grammar.skip_label', { from: s.from.trim() })} onClick={() => decide(s.id, 'skipped')} />
                </>
              )}
            />
          ))}
        </List>
      )}
      {turn.applied ? (
        <Row gap={2}><Badge tone="success">{t('panel.applied.replace')}</Badge><Text size="xs" tone="muted">{t('panel.undo_hint')}</Text></Row>
      ) : (
        <Row gap={1}>
          <Button size="sm" disabled={!accepted || !!turn.applying} busy={!!turn.applying} onClick={() => onApply(turn, 'replace', applySuggestions(review.segments, review.states))}>{t('assistant.replace')}</Button>
          {pending.length > 1 && <Button size="sm" variant="secondary" onClick={() => onReview(acceptAll(review).review)}>{t('grammar.accept_all')}</Button>}
        </Row>
      )}
    </Stack>
    </div>
  );
}

/** One lookup the model made. */
const STEP_ICONS = { check_calendar: 'calendar', find_contact: 'address-book', search_mail: 'search', read_message: 'mail-opened', read_original_message: 'mail', find_setting: 'settings', read_my_settings: 'adjustments' };

function stepLabel(t, step) {
  const args = step.args ?? {};
  switch (step.name) {
    case 'check_calendar': return t('panel.step.check_calendar', { from: args.from ?? '', to: args.to ?? args.from ?? '' });
    case 'find_contact': return t('panel.step.find_contact', { query: args.query ?? '' });
    case 'read_original_message': return t('panel.step.read_original_message');
    case 'search_mail': return t('panel.step.search_mail', { query: [args.text, args.from, args.subject, args.after, args.before].filter(Boolean).join(' ') });
    case 'read_message': return t('panel.step.read_message');
    case 'find_setting': return t('panel.step.find_setting', { query: args.query ?? '' });
    case 'read_my_settings': return t('panel.step.read_my_settings');
    default: return step.name;
  }
}

const TOOL_ACTION_ICONS = {
  archive_message: 'archive', move_message: 'folder-symlink', mark_message: 'mail-check', create_event: 'calendar-plus',
  create_task: 'checkbox', create_contact: 'user-plus', draft_reply: 'arrow-back-up', draft_email: 'mail-forward',
};

/**
 * Something the assistant does for the user, as a card in the chat: what it
 * is, and its state. Waiting for the user's OK it offers Do it and Skip;
 * done, Undo where the action can be taken back.
 */
function ActionCard({ api, step, onAnswer, onUndo }) {
  const t = api.i18n.t;
  const action = step.action ?? { summary: step.result, state: 'failed' };
  const state = step.status === 'failed' && action.state !== 'skipped' ? 'failed' : action.state;
  const [busy, setBusy] = useState(false);
  return (
    <div data-action={step.name} data-action-state={state} style={{ border: '1px solid var(--color-border)', borderRadius: 8, padding: '8px 10px' }}>
      <Stack gap={2}>
        <Row gap={2} wrap={false} align="start">
          <Icon name={TOOL_ACTION_ICONS[step.name] ?? 'bolt'} size="sm" className="text-primary" />
          <Text size="sm">{action.summary}</Text>
        </Row>
        {state === 'waiting' && (
          <Row gap={1} justify="end">
            <Text size="xs" tone="muted">{t('action.waiting')}</Text>
            <span style={{ flex: 1 }} />
            <Button variant="ghost" size="sm" onClick={() => onAnswer(false)}>{t('action.skip')}</Button>
            <Button size="sm" onClick={() => onAnswer(true)}>{t('action.approve')}</Button>
          </Row>
        )}
        {state === 'running' && <Spinner size="sm" />}
        {state === 'done' && (
          <Row gap={1} wrap={false}>
            <Icon name="check" size="sm" className="text-success" />
            <Text size="xs" tone="muted">{t('action.done')}</Text>
            {action.undo && (
              <>
                <span style={{ flex: 1 }} />
                <LinkButton icon="arrow-back-up" disabled={busy} onClick={async () => { setBusy(true); await onUndo(); setBusy(false); }}>{t('action.undo')}</LinkButton>
              </>
            )}
          </Row>
        )}
        {state === 'skipped' && <Text size="xs" tone="muted">{t('action.skipped')}</Text>}
        {state === 'undone' && <Text size="xs" tone="muted">{t('action.undone')}</Text>}
        {state === 'failed' && <Text size="xs" tone="danger">{t('action.failed')}{step.result ? `: ${step.result.replace(/^The tool failed: /, '')}` : ''}</Text>}
      </Stack>
    </div>
  );
}

/**
 * The lookups of one answer, in a box of their own: "Looked up" and a chip
 * per lookup (Mail, Calendar, Message), a spinner while they run. Clicking
 * the box opens the details with the cards of what was found.
 */
function StepsGroup({ api, mode, steps, running, onSend, onInsert }) {
  const t = api.i18n.t;
  const [open, setOpen] = useState(false);
  const busy = running && steps.some((s) => s.status === 'running');
  const failed = steps.some((s) => s.status === 'failed');
  const chips = [];
  for (const step of steps) {
    const label = t(`panel.steps.kind.${step.name}`);
    const prev = chips.find((c) => c.label === label);
    if (prev) { prev.count++; prev.status = step.status === 'failed' || prev.status === 'failed' ? 'failed' : step.status === 'running' ? 'running' : prev.status; }
    else chips.push({ label, count: 1, status: step.status });
  }
  return (
    <div data-steps={steps.length} data-steps-open={open || undefined} style={{ border: '1px solid var(--color-border)', borderRadius: 8 }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        title={open ? t('panel.steps.hide') : t('panel.steps.show')}
        className="bk"
        style={{ display: 'flex', alignItems: 'center', gap: 6, width: '100%', padding: '6px 8px', background: 'none', border: 0, font: 'inherit', color: 'inherit', textAlign: 'start', cursor: 'pointer', flexWrap: 'wrap' }}
      >
        {busy ? <Spinner size="sm" /> : <Icon name={failed ? 'alert-circle' : 'list-search'} size="sm" className="text-muted-foreground" />}
        <Text size="xs" tone="muted">{busy ? t('panel.steps.running') : t('panel.steps.title')}</Text>
        {chips.map((c) => (
          <Badge key={c.label} tone={c.status === 'failed' ? 'danger' : c.status === 'running' ? 'info' : 'neutral'}>{c.label}{c.count > 1 ? ` ×${c.count}` : ''}</Badge>
        ))}
        <span style={{ marginInlineStart: 'auto' }}><Icon name={open ? 'chevron-up' : 'chevron-down'} size="sm" className="text-muted-foreground" /></span>
      </button>
      {open && (
        <div style={{ padding: '2px 8px 8px' }}>
          <Stack gap={2}>
            {steps.map((step) => <StepRow key={step.id} api={api} mode={mode} step={step} onSend={onSend} onInsert={onInsert} />)}
          </Stack>
        </div>
      )}
    </div>
  );
}

/** One lookup the model made, with a card of what it found. */
function StepRow({ api, mode, step, onSend, onInsert }) {
  const t = api.i18n.t;
  const icon = step.status === 'running' ? 'loader-2' : step.status === 'failed' ? 'alert-circle' : (STEP_ICONS[step.name] ?? 'mail');
  return (
    <div data-step={step.name} data-step-status={step.status} style={{ paddingTop: 6, borderTop: '1px solid var(--color-border)' }}>
    <Stack gap={1}>
      <Row gap={1} wrap={false} align="start">
        <Icon name={icon} size="sm" className="text-muted-foreground" />
        <Text size="xs" tone="muted">{stepLabel(t, step)}{step.status === 'failed' ? ` · ${t('panel.step.failed')}` : ''}</Text>
      </Row>
      {step.widget && <Widget api={api} mode={mode} widget={step.widget} onSend={onSend} onInsert={onInsert} />}
      {step.result && !step.widget && <Text size="xs" tone="muted" className="whitespace-pre-wrap">{step.result.slice(0, 1200)}</Text>}
    </Stack>
    </div>
  );
}
