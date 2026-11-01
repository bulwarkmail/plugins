// The assistant panel's state and what it does: loading the service and the
// saved transcript, sending quick actions and typed requests, the lookups
// and actions of an answer, applying proposals. The parts of the panel only
// render what this hook returns.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useApi } from '../common.jsx';
import { emailForPrompt } from '../Reader.jsx';
import { keepEdges } from '../AssistantDialog.jsx';
import { ensureConsent, loadSetup, savePrefs } from '../../lib/assistant.js';
import { composerChatSystem, readerChatSystem, buildPrompt, contextSuffix } from '../../lib/prompts.js';
import { loadPerson, localNow } from '../../lib/person.js';
import { historyMessages, runChat } from '../../lib/chat.js';
import { runTool, toolsFor } from '../../lib/tools.js';
import { MAX_AUTO_ACTIONS, actionToolsFor, describeAction, effectiveActionMode, isActionTool, performAction, undoAction } from '../../lib/actions.js';
import { streamCompletion } from '../../lib/client.js';
import { AiError } from '../../lib/errors.js';
import { defaultTarget, languageOptions } from '../../lib/languages.js';
import { diffSuggestions } from '../../lib/grammar.js';
import { COMPOSER_CONTEXT_KEY, DRAFT_KEY, READER_CHAT_KEY, chatKey, pendingKey } from '../../lib/background.js';
import {
  MAX_TURNS, PENDING_TTL_MS, appLabels, contextKey, effectiveSource, lastTopic, loadTurns, taskForAction, today, uid,
} from './model.js';

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

  /** Who the user is and their standing instructions, for this request. */
  const extraContext = useCallback(() => contextSuffix({
    person: person ? { ...person, now: localNow(person.timeZone) } : null,
    instructions: { admin: setup?.config?.instructions, user: prefs.instructions },
    place: { panel: mode, labels: appLabels(t) },
  }), [person, setup, prefs, mode, t]);

  /**
   * One exchange: a quick action (a task of prompts.js) or a typed request
   * (the chat). `label` is what the user turn shows; `sent` what the chat
   * sends when it differs.
   */
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

  return {
    api, t, locale, mode, email, setup, loaded, turns, consent, source, input, setInput, inputRef,
    target, setTarget, languages, running,
    removeContext, restoreContext, quick, submit, stop, apply, sendText, insertText, clear, retry,
    patchTurn, answerAction, undoStep,
  };
}
