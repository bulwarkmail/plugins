// The chat: a conversation with the model about the message the user writes
// or reads, with tools it may call (tools.js), proposals it makes and
// widgets it adds.
//
// A proposal is text meant for the email, marked by the model with
// <text></text> tags; a widget is a card the panel draws, marked with
// <widget></widget> around JSON (prompts.js tells it both). The panel shows
// a proposal as a marked change with Replace and Insert buttons, a widget
// as its card, and everything outside the tags as the model talking to the
// user, in Markdown. All of it is parsed while the answer is still coming
// in, so the preview grows word by word.

import { streamTurn } from './client.js';
import { AiError, failureReason } from './errors.js';
import { clip } from './prompts.js';
import { parseWidgetJson } from './widgets.js';

/** How many turns of the conversation go back to the model. */
export const HISTORY_TURNS = 12;
/** Longest message of the history sent back, in characters. */
export const HISTORY_CHARS = 6000;
/** How often the model may call tools before it has to answer. */
export const MAX_TOOL_ROUNDS = 4;

// A new email (no message to reply to) names its recipients and subject:
// <text to="anna@example.org, bo@example.org" subject="Our call">.
const TAGS = { text: /<text((?:\s+[a-z]+\s*=\s*"[^"]*")*)\s*>\s*/i, widget: /<widget>\s*/i };
const ADDRESS = /^[^\s@<>",]+@[^\s@<>",]+\.[^\s@<>",]+$/;

/** The to and subject of a <text> tag; addresses only, at most 20. */
function draftHeaders(attrs) {
  const out = {};
  for (const [, name, value] of String(attrs ?? '').matchAll(/([a-z]+)\s*=\s*"([^"]*)"/gi)) {
    const key = name.toLowerCase();
    if (key === 'to') {
      // "Anna <anna@example.org>" is taken as its address.
      const to = value.split(/[,;]/).map((a) => (/<([^<>]+)>/.exec(a)?.[1] ?? a).trim()).filter((a) => ADDRESS.test(a)).slice(0, 20);
      if (to.length) out.to = to;
    } else if (key === 'subject' && value.trim()) {
      out.subject = value.trim().slice(0, 200);
    }
  }
  return out;
}
const CLOSE = { text: /\s*<\/text>/i, widget: /\s*<\/widget>/i };

function stripFence(text) {
  const fenced = /^\s*```[a-z]*\n([\s\S]*?)\n?```\s*$/i.exec(text);
  return fenced ? fenced[1] : text;
}

/** The earliest opening tag in `rest`: { kind, index, length } or null. */
function nextTag(rest) {
  let best = null;
  for (const kind of Object.keys(TAGS)) {
    const m = TAGS[kind].exec(rest);
    if (m && (!best || m.index < best.index)) best = { kind, index: m.index, length: m[0].length, attrs: m[1] };
  }
  return best;
}

/**
 * Split an answer into what the model says and what it adds:
 * [{ kind: 'say', text } | { kind: 'proposal', text, open } | { kind: 'widget', widget, open }].
 * `open` marks a block still coming in (no closing tag yet); an unfinished
 * widget has no `widget` yet. Empty pieces and unreadable widgets are dropped.
 */
export function parseAnswer(answer) {
  const out = [];
  let rest = String(answer ?? '');
  const say = (text) => { if (text.trim()) out.push({ kind: 'say', text: text.trim() }); };
  for (;;) {
    const open = nextTag(rest);
    if (!open) {
      // An opening tag still coming in (its attributes take a while) is not talk.
      say(rest.replace(/<text\s[^>]*$/i, ''));
      break;
    }
    say(rest.slice(0, open.index));
    const after = rest.slice(open.index + open.length);
    const close = CLOSE[open.kind].exec(after);
    const headers = open.kind === 'text' ? draftHeaders(open.attrs) : {};
    if (!close) {
      // Still streaming, or the model forgot the closing tag.
      const body = after.replace(/<\/?(?:te?x?t?|wi?d?g?e?t?)$/i, '');
      if (open.kind === 'text') out.push({ kind: 'proposal', text: stripFence(body).replace(/^\n+/, ''), open: true, ...headers });
      else out.push({ kind: 'widget', widget: null, open: true });
      break;
    }
    const body = after.slice(0, close.index);
    if (open.kind === 'text') out.push({ kind: 'proposal', text: stripFence(body).trim(), open: false, ...headers });
    else {
      const widget = parseWidgetJson(stripFence(body));
      if (widget) out.push({ kind: 'widget', widget, open: false });
    }
    rest = after.slice(close.index + close[0].length);
  }
  return out;
}

/** The first proposal of an answer, finished or not; null without one. */
export function proposalOf(answer) {
  return parseAnswer(answer).find((p) => p.kind === 'proposal') ?? null;
}

/**
 * The transcript's turns as messages for the model: the last turns, each
 * clipped, assistant answers as they were (tags included), tool steps left
 * out.
 */
export function historyMessages(turns, { limit = HISTORY_TURNS, chars = HISTORY_CHARS } = {}) {
  return turns
    .filter((t) => (t.role === 'user' || t.role === 'assistant') && typeof t.content === 'string' && t.content.trim())
    .slice(-limit)
    .map((t) => ({ role: t.role, content: clip(t.content, chars) }));
}

/**
 * One exchange: send the conversation, let the model call tools (each
 * result goes back to it), and stream its final answer.
 *
 * onText(fullAnswer): the answer so far. What the model says before it
 * calls tools ("let me check your calendar") is shown while it streams and
 * dropped once the tools ran; the answer is the final round's text.
 * onStep({ id, name, args, status, result, widget }): a tool call starting
 * ('running') and finishing ('done' | 'failed'). `runTool` resolves to the
 * text for the model, or { text, widget, action } with a card for the panel
 * or the state of an action; it gets the call's { id } as third argument.
 * Resolves to { text, steps }. Rejects with AiError like streamTurn.
 */
export async function runChat(api, endpoint, { system, messages, tools = [], runTool, maxTokens = 2500 }, {
  onText = () => {},
  onStep = () => {},
  signal,
  timeouts = {},
} = {}) {
  const history = [...messages];
  const steps = [];
  let lastSaid = '';
  for (let round = 0; ; round++) {
    const canUseTools = tools.length > 0 && typeof runTool === 'function';
    const allowTools = canUseTools && round < MAX_TOOL_ROUNDS;
    // After the last round the tools stay in the request (the history holds
    // tool calls, and Anthropic refuses those without tools), but the model
    // may not call them any more: it has to answer.
    const turn = await streamTurn(api, endpoint, {
      system,
      messages: history,
      maxTokens,
      ...(canUseTools ? { tools, ...(allowTools ? {} : { toolChoice: 'none' }) } : {}),
    }, {
      signal,
      ...timeouts,
      onText: (full) => onText(full),
    });
    if (!turn.toolCalls.length || !allowTools) {
      // The answer. A model that only narrated before its last lookup and
      // then fell silent keeps that narration rather than nothing.
      const text = turn.text.trim() ? turn.text : lastSaid;
      if (!text.trim()) throw new AiError('empty');
      onText(text);
      return { text, steps };
    }
    if (turn.text.trim()) lastSaid = turn.text;
    onText('');
    history.push({ role: 'assistant', content: turn.text, toolCalls: turn.toolCalls });
    for (const call of turn.toolCalls) {
      if (signal?.aborted) throw new AiError('cancelled', { partial: lastSaid });
      const step = { id: call.id, name: call.name, args: call.args, status: 'running', result: '', widget: null };
      steps.push(step);
      onStep({ ...step });
      let result;
      try {
        const out = await runTool(call.name, call.args ?? {}, { id: call.id });
        if (out && typeof out === 'object') {
          result = String(out.text ?? '');
          step.widget = out.widget ?? null;
          if (out.action) step.action = out.action;
        } else {
          result = String(out);
        }
        step.status = 'done';
      } catch (err) {
        result = `The tool failed: ${err?.message ?? 'unknown error'}`;
        step.status = 'failed';
        step.reason = failureReason(err);
      }
      step.result = result;
      onStep({ ...step });
      history.push({ role: 'tool', toolCallId: call.id, name: call.name, content: result });
    }
  }
}
