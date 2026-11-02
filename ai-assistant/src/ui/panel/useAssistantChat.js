// The assistant panel's state and what it does: loading the service and the
// saved transcript, sending quick actions and typed requests, the lookups
// and actions of an answer, applying proposals. The parts of the panel only
// render what this hook returns.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useApi } from '../common.jsx';
import { actionLabel } from './ActionsMenu.jsx';
import { useAreas } from './areas/index.js';
import { emailForPrompt } from '../Reader.jsx';
import { keepEdges } from '../AssistantDialog.jsx';
import { ensureConsent, loadSetup, savePrefs } from '../../lib/assistant.js';
import { composerChatSystem, readerChatSystem, buildPrompt, contextSuffix } from '../../lib/prompts.js';
import { loadPerson } from '../../lib/person.js';
import { clock, userZone } from '../../lib/clock.js';
import { historyMessages, runChat } from '../../lib/chat.js';
import { runTool, toolsFor } from '../../lib/tools.js';
import { MAX_AUTO_ACTIONS, actionToolsFor, describeAction, effectiveActionMode, isActionTool, performAction, undoAction } from '../../lib/actions.js';
import { streamCompletion } from '../../lib/client.js';
import { AiError } from '../../lib/errors.js';
import { defaultTarget, languageOptions } from '../../lib/languages.js';
import { diffSuggestions } from '../../lib/grammar.js';
import { COMPOSER_CONTEXT_KEY, DRAFT_KEY, READER_CHAT_KEY, chatKey, pendingKey } from '../../lib/background.js';
import { areaAllowed } from '../../lib/config.js';
import { archiveRunning, openRunning, saveRunning, withForeign } from '../../lib/chat-history.js';
import {
  MAX_TURNS, PENDING_TTL_MS, appLabels, storedTurns, contextKey, effectiveSource, lastTopic, loadTurns, taskForAction, topicSubject, uid,
} from './model.js';

/** Scopes that are part of the text; a quick action on them says so in its bubble. */
const PART_SCOPES = new Set(['selection', 'passage']);

export function useAssistantChat(props) {
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
  // The language picker of Translate: null, or { text } (text: what the right-click handed over).
  const [translating, setTranslating] = useState(null);
  const languages = useMemo(() => languageOptions(locale), [locale]);
  const inputRef = useRef(null);
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

  // What the 2.2 areas add (chips, prompt, lookups' context, menus, ...).
  // They reach the chat's functions through `bridge` once those exist.
  const bridge = useRef({});
  // Editing the last message (chat tools): the id of the user turn whose exchange the next send replaces.
  const [editing, setEditing] = useState(null);
  const cancelEdit = useCallback(() => { setEditing(null); setInput(''); }, []);
  const areas = useAreas({ api, t, mode, email, source, turns, setTurns, key, setup, prefs, person, locale, setInput, inputRef, bridge, props, editing, cancelEdit }, props);
  const areasRef = useRef(areas);
  areasRef.current = areas;
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
      const setupLoad = loadSetup(api).catch(() => ({ endpoint: null, prefs: {} }));
      const [next, saved, ctx, draft, who] = await Promise.all([
        setupLoad,
        // The reader's chat moves into the history after 8 hours without use (chat tools).
        key ? (mode === 'reader' ? setupLoad.then((s) => openRunning(api, key, { allowed: areaAllowed(s.config ?? {}, 'chat') })).catch(() => false) : Promise.resolve()).then(() => loadTurns(api, key)) : [],
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

  // Save the transcript as it changes (not while an answer streams). When
  // the plugin's storage is full the user hears it once, not on every turn.
  const storageWarned = useRef(false);
  useEffect(() => {
    if (!loaded || !key || running) return;
    const timer = setTimeout(() => {
      // The reader's chat may be open in two frames: keep the turns the other one added.
      const saving = mode === 'reader' ? saveRunning(api, key, storedTurns(turns, mode)) : api.storage.set(key, { turns: storedTurns(turns, mode), at: Date.now() });
      void Promise.resolve(saving).then(
        (merged) => {
          storageWarned.current = false;
          if (merged?.foreign?.length || merged?.dropped?.size) setTurns((prev) => (prev.some((x) => x.status === 'running') ? prev : withForeign(prev, merged)));
        },
        (err) => {
          api.log?.warn?.('could not save the chat', err?.message ?? err);
          if (storageWarned.current) return;
          storageWarned.current = true;
          api.toast?.error?.(t('panel.storage_full'));
        },
      );
    }, 300);
    return () => clearTimeout(timer);
  }, [api, key, turns, loaded, running, mode, t]);

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

  // The notice names what this panel may send: lookups and actions only when they are on.
  const askConsent = useCallback((endpoint) => new Promise((resolve) => {
    setConsent({ endpoint, scope: { lookups, actions: actionMode !== 'off', parts: areasRef.current.privacyParts }, answer: (ok) => { setConsent(null); resolve(ok); } });
  }), [lookups, actionMode]);

  /** Who the user is and their standing instructions, for this request. */
  const extraContext = useCallback(() => {
    const base = contextSuffix({
      person,
      instructions: { admin: setup?.config?.instructions, user: prefs.instructions },
      place: { panel: mode, labels: appLabels(t) },
    });
    const blocks = areasRef.current.promptBlocks;
    return blocks.length ? `${base}\n\n${blocks.join('\n\n')}` : base;
  }, [person, setup, prefs, mode, t]);

  /**
   * One exchange: a quick action (a task of prompts.js) or a typed request
   * (the chat). `label` is what the user turn shows; `sent` what the chat
   * sends when it differs.
   */
  const send = useCallback(async ({ label, sent, task, input: taskInput, show, scope, src }) => {
    const endpoint = setup?.endpoint;
    if (!endpoint) return;
    // Any other request ends an edit (submit() used it already).
    setEditing(null);
    controller.current?.abort();
    const abort = new AbortController();
    controller.current = abort;
    const previous = turnsRef.current;
    // In the reader the conversation runs on while the user opens other
    // messages: a line in the transcript names the message a question is
    // about when it is not the one before, and the model hears of it.
    const emailId = mode === 'reader' ? (contextEmail?.id ?? null) : undefined;
    const topic = mode === 'reader' ? lastTopic(previous) : null;
    const switched = mode === 'reader' && contextEmail && previous.length > 0 && topic !== contextEmail.id;
    // The user took the message out: the line says so, instead of leaving "Now about" standing.
    const left = mode === 'reader' && !contextEmail && !!topic;
    const marker = switched
      ? [{ id: uid(), role: 'context', at: Date.now(), emailId: contextEmail.id, subject: contextEmail.subject ?? '' }]
      : left ? [{ id: uid(), role: 'context', at: Date.now(), emailId: null, left: true, subject: topicSubject(previous, topic) }] : [];
    const note = switched
      ? `(Now about another message: "${contextEmail.subject ?? ''}" from ${contextEmail.from?.[0]?.name || contextEmail.from?.[0]?.email || 'unknown'}.)\n`
      : left ? '(The user took the message out of the conversation: this is not about it.)\n' : '';
    const at = Date.now();
    const userTurn = {
      id: uid(), role: 'user', at, content: note + (sent ?? label), label,
      ...(emailId !== undefined ? { emailId } : {}),
      ...(mode === 'reader' && contextEmail ? { subject: contextEmail.subject ?? '' } : {}),
    };
    // A reader answer replies to the message it was about; replyTo null: there
    // was none (or the user took it out), so a draft opens as a new message.
    const replyTo = mode === 'reader' ? (contextEmail ? { id: contextEmail.id, subject: contextEmail.subject ?? '' } : null) : undefined;
    const turn = { id: uid(), role: 'assistant', at, content: '', status: 'running', task: task ?? 'chat', show: show ?? 'chat', scope, source: src ?? '', steps: [], ...(task ? { input: taskInput ?? {} } : {}), ...(replyTo !== undefined ? { replyTo } : {}) };
    setTurns([...previous, ...marker, userTurn, turn]);
    try {
      if (!(await ensureConsent(api, endpoint, askConsent))) throw new AiError('declined');
      if (abort.signal.aborted) throw new AiError('cancelled');
      const onText = (full) => patchTurn(turn.id, { content: full });
      let text;
      const extra = extraContext();
      const now = clock(userZone(api, person?.timeZone));
      if (task) {
        const prompt = buildPrompt(task, { language: locale, extra, ...taskInput, ...(task === 'actions' ? { now } : {}) });
        text = await streamCompletion(api, endpoint, prompt, { onText, signal: abort.signal });
      } else {
        const ctx = { ...areasRef.current.toolsCtx, inReplyToId: mode === 'composer' ? context?.inReplyToId : undefined, lookups, actions: actionMode, mode, openEmailId: mode === 'reader' ? contextEmail?.id : undefined, settingsName: t('app.nav.settings'), zone: now.zone, config: setup?.config ?? {}, prefs };
        const tools = [...toolsFor(ctx), ...actionToolsFor(ctx)];
        let autoActions = 0;
        // Lookups run straight away; an action is shown first, then waits for
        // the user's OK (ask-first mode, or past the automatic limit) or runs.
        const callTool = async (name, args, call) => {
          if (!isActionTool(name)) return runTool(api, name, args, ctx);
          const { summary, plan, alwaysAsk } = await describeAction(api, name, args, ctx);
          // Some actions always ask first, whatever the user's mode.
          const ask = alwaysAsk === true || actionMode === 'manual' || autoActions >= MAX_AUTO_ACTIONS;
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
          ? composerChatSystem({ language: locale, now, subject, mode: context?.mode, originalSubject: context?.originalSubject, scope, text: src, hasTools: tools.length > 0, actions: actionMode, extra })
          : readerChatSystem({ language: locale, now, email: contextEmail ? emailForPrompt(contextEmail, now.zone) : null, emailId: contextEmail?.id, selection: scope === 'passage' ? src : '', hasTools: tools.length > 0, actions: actionMode, extra });
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
  }, [api, setup, askConsent, patchTurn, locale, mode, context, lookups, subject, contextEmail, extraContext, person, t]);

  /** A quick action on the current source (or on `text` from a right-click). */
  const quick = useCallback((action, { text, targetTag } = {}) => {
    const src = text ? { scope: mode === 'composer' ? 'selection' : 'passage', text } : source;
    // The bubble names the action; the scope only when it is part of the text.
    const named = (name) => (PART_SCOPES.has(src.scope) ? `${name} · ${t(`panel.scope.${src.scope}`)}` : name);
    if (action === 'reply') {
      void send({
        label: named(t('panel.quick.reply')),
        sent: src.scope === 'passage' ? `Draft a reply to this email that answers the passage I highlighted:\n<passage>\n${src.text}\n</passage>` : 'Draft a reply to this email.',
        scope: src.scope, src: src.text,
      });
      return;
    }
    const { task, input: taskInput, show } = taskForAction(mode, action, src, { target: targetTag ?? target, email, now: clock(userZone(api, person?.timeZone)) });
    const name = action === 'translate'
      ? t('panel.translate_to', { language: languages.find((l) => l.tag === (targetTag ?? target))?.label ?? (targetTag ?? target) })
      : actionLabel(t, mode, action);
    if (action !== 'translate' && mode === 'composer') void savePrefs(api, { lastAction: action });
    void send({ label: named(name), task, input: taskInput, show, scope: src.scope, src: src.text });
  }, [api, mode, source, target, email, languages, send, person, t]);

  /** The typed request. While the user edits their last message, it replaces that exchange. */
  const submit = useCallback(() => {
    const text = input.trim();
    if (!text || running || !setup?.endpoint) return;
    setInput('');
    if (editing) {
      setEditing(null);
      const list = turnsRef.current;
      const i = list.findIndex((x) => x.id === editing);
      // Only while it is still the last request: otherwise this is a new one.
      const lastUser = list.reduce((last, x, j) => (x.role === 'user' ? j : last), -1);
      if (i >= 0 && i === lastUser) {
        // The "now about another message" line before it goes too; send() adds it again when it still fits.
        const from = i > 0 && list[i - 1].role === 'context' ? i - 1 : i;
        turnsRef.current = list.slice(0, from);
        setTurns(turnsRef.current);
      }
    }
    void send({ label: text, scope: source.scope, src: source.text });
  }, [input, running, setup, send, source, editing]);

  // Edit and Answer again (chat tools): the last typed request and the last
  // answer, while nothing runs. Not after an answer that did something (or
  // waits to): asking again would do it a second time.
  const chatTools = areaAllowed(setup?.config ?? {}, 'chat');
  const openId = mode === 'reader' ? (contextEmail?.id ?? null) : undefined;
  const editable = useMemo(() => {
    if (!chatTools || running) return {};
    const lastAnswer = [...turns].reverse().find((x) => x.role === 'assistant');
    if (!lastAnswer) return {};
    if ((lastAnswer.steps ?? []).some((s) => s.action && ['done', 'waiting', 'running'].includes(s.action.state))) return {};
    const i = turns.indexOf(lastAnswer);
    const ask = i > 0 && turns[i - 1].role === 'user' ? turns[i - 1] : null;
    // In the reader, Answer again only while the message the answer was about is the one open.
    const sameMessage = openId === undefined || lastAnswer.replyTo === undefined || (lastAnswer.replyTo?.id ?? null) === openId;
    return {
      answerId: (lastAnswer.status === 'done' || lastAnswer.status === 'stopped') && sameMessage ? lastAnswer.id : undefined,
      // Only typed requests: a quick action's bubble is its name, not something to edit.
      userId: ask && (lastAnswer.task ?? 'chat') === 'chat' ? ask.id : undefined,
    };
  }, [chatTools, running, turns, openId]);

  /** Put the last request back into the input; sending it replaces that exchange. */
  const edit = useCallback((turn) => {
    setEditing(turn.id);
    setInput(turn.label ?? turn.content ?? '');
    requestAnimationFrame(() => inputRef.current?.focus());
  }, []);

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
      // "Translate…" asks for the language first.
      if (pending.action === 'translate') {
        setTranslating({ text: pending.text || undefined });
        return;
      }
      quick(pending.action, pending.text ? { text: pending.text } : {});
    })();
    if (mode === 'composer') inputRef.current?.focus();
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded, id, props.focusRequest]);

  /**
   * Reply to the message an answer was about, with `text`. The host only
   * replies to the message open in the reader, so another one is opened first.
   */
  const replyFor = useCallback(async (turn, text) => {
    // Answers saved before replyTo was kept reply to the open message.
    const target = turn.replyTo !== undefined ? turn.replyTo?.id : email?.id;
    if (!target) throw new Error('no message to reply to');
    if (target === email?.id || typeof api.ui?.openEmail !== 'function') return api.compose.reply(target, { text });
    await api.ui.openEmail(target);
    // The reader needs a moment to show it.
    for (let i = 0; ; i += 1) {
      try {
        return await api.compose.reply(target, { text });
      } catch (err) {
        if (i >= 15) throw err;
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    }
  }, [api, email]);

  // ─── Applying a proposal ───
  const apply = useCallback(async (turn, how, text, headers = {}) => {
    patchTurn(turn.id, { applying: how });
    try {
      let ok;
      if (how === 'new') {
        const opened = await api.compose.open({ to: headers.to ?? [], subject: headers.subject ?? '', body: text.trim() });
        ok = opened !== false;
      } else if (mode === 'reader') {
        ok = await replyFor(turn, text.trim());
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
  }, [api, mode, props.composerId, patchTurn, refreshBody, replyFor]);

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
    const old = turnsRef.current;
    stop();
    setEditing(null);
    // With chat tools the reader's chat goes into the history instead of
    // away; it leaves the panel once it is there. When the history can't
    // take it (storage full) it stays, and the user hears why.
    if (key && mode === 'reader' && areaAllowed(setup?.config ?? {}, 'chat')) {
      void archiveRunning(api, key, storedTurns(old, mode)).then(
        (done) => setTurns(done.stale ? done.turns : []),
        (err) => {
          api.log?.warn?.('could not keep the old chat', err?.message ?? err);
          api.toast?.error?.(t('panel.storage_full'));
        },
      );
      return;
    }
    setTurns([]);
    if (key) void api.storage.remove(key).catch(() => {});
  }, [api, key, stop, mode, setup, t]);

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

  bridge.current = { send, sendText, quick, setInput, focus: () => inputRef.current?.focus(), areas: () => areasRef.current };

  return {
    areas,
    api, t, locale, mode, email, setup, loaded, turns, consent, source, input, setInput, inputRef,
    target, setTarget, languages, running, translating, setTranslating, lookups,
    removeContext, restoreContext, quick, submit, stop, apply, replyFor, sendText, insertText, clear, retry,
    patchTurn, answerAction, undoStep, editing, editable, edit, cancelEdit,
  };
}
