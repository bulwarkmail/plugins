// What the assistant panel works on and how its transcript is shaped:
// plain functions and constants, no React.

import { REWRITE_STYLES } from '../../lib/prompts.js';
import { parseAnswer } from '../../lib/chat.js';
import { emailForPrompt } from '../Reader.jsx';

/** Tallest the chat input grows before it scrolls, in px (about eight lines). */
export const INPUT_MAX_HEIGHT = 200;

/** Quick actions on text in the composer. */
export const COMPOSER_ACTIONS = [...REWRITE_STYLES, 'grammar', 'translate'];
/** Quick actions on an open message, and on a highlighted passage of it. */
export const READER_ACTIONS = ['summary', 'actions', 'replies', 'translate'];
export const PASSAGE_ACTIONS = ['explain', 'translate', 'reply'];
/** With no message in context, and with an empty draft: ways to start. */
export const NO_MESSAGE_ACTIONS = ['today', 'find'];
export const EMPTY_DRAFT_ACTIONS = ['example_1', 'example_2', 'example_3'];
/** Turns kept in the transcript (older ones are dropped when saving). */
export const MAX_TURNS = 40;
/** A pending request from a right-click entry is dropped after this long. */
export const PENDING_TTL_MS = 60_000;

export const uid = () => Math.random().toString(36).slice(2, 10);
export const excerpt = (text, max = 90) => {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

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

/** The subject of message `emailId`, from the newest user turn or marker that names it. */
export function topicSubject(turns, emailId) {
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    const turn = turns[i];
    if (turn.emailId === emailId && typeof turn.subject === 'string') return turn.subject;
  }
  return '';
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
export function taskForAction(mode, action, source, { target, email, instruction, now } = {}) {
  if (mode === 'composer') {
    if (REWRITE_STYLES.includes(action)) return { task: 'rewrite', input: { text: source.text, style: action }, show: 'proposal' };
    if (action === 'translate') return { task: 'translate', input: { text: source.text, target }, show: 'proposal' };
    if (action === 'grammar') return { task: 'grammar', input: { text: source.text }, show: 'grammar' };
    if (action === 'write') return { task: 'write', input: { prompt: instruction, subject: email?.subject ?? '' }, show: 'proposal' };
    return { task: 'edit', input: { text: source.text, instruction }, show: 'proposal' };
  }
  const mail = email ? emailForPrompt(email, now?.zone) : null;
  if (action === 'summary') return { task: 'summary', input: { email: mail }, show: 'text' };
  if (action === 'actions') return { task: 'actions', input: { email: mail, now }, show: 'actions' };
  if (action === 'replies') return { task: 'replies', input: { email: mail }, show: 'replies' };
  if (action === 'explain') return { task: 'explain', input: { email: mail, text: source.text }, show: 'text' };
  return { task: 'translate', input: { text: source.text, target }, show: 'text' };
}

/** Load a saved transcript; [] when there is none. */
export async function loadTurns(api, key) {
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
