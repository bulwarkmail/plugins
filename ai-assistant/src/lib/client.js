// One streamed completion through the webmail's proxy (api.proxy.fetch),
// with cancel and timeouts. The proxy adds the API key on the server.

import { buildRequest, createToolCallCollector, deltaFromEvent, formatOf, turnFromResponse } from './providers.js';
import { createSseParser } from './sse.js';
import { AiError, errorFromResponse, errorFromStream } from './errors.js';

/** No answer at all after this long: give up. */
export const FIRST_RESPONSE_TIMEOUT_MS = 60_000;
/** Nothing new in a running answer for this long: give up. */
export const IDLE_TIMEOUT_MS = 60_000;

function isStream(body) {
  return body && typeof body === 'object' && typeof body.getReader === 'function';
}

/**
 * Ask for one turn of the model and stream the answer.
 *
 * onText(fullText, delta) is called for every piece of text. Resolves to
 * { text, toolCalls }: the answer and the tools the model wants to call
 * (prompt.tools); with the Responses API also `raw`, the model's own items
 * of the turn, to send back with the tool results. Rejects with an
 * AiError: `cancelled` when `signal` aborts (the text so far is in error.partial), `timeout`, `empty` when
 * nothing at all came back, or what the service said.
 */
export async function streamTurn(api, endpoint, prompt, {
  onText = () => {},
  signal,
  firstResponseTimeoutMs = FIRST_RESPONSE_TIMEOUT_MS,
  idleTimeoutMs = IDLE_TIMEOUT_MS,
} = {}) {
  if (signal?.aborted) throw new AiError('cancelled');
  const format = formatOf(endpoint);
  const request = buildRequest(endpoint, prompt, { stream: true });
  const controller = new AbortController();
  let timedOut = false;
  let timer = null;
  let text = '';
  const tools = createToolCallCollector();
  // Responses API: the whole response its last event (or the body) carries.
  let final = null;

  let stopWaiting;
  const stopped = new Promise((_, reject) => { stopWaiting = reject; });
  stopped.catch(() => {});
  const fail = () => {
    stopWaiting(new AiError(timedOut ? 'timeout' : 'cancelled', { partial: text }));
  };
  const arm = (ms) => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
      fail();
    }, ms);
  };
  const onAbort = () => {
    controller.abort();
    fail();
  };
  signal?.addEventListener('abort', onAbort, { once: true });

  try {
    arm(firstResponseTimeoutMs);
    let res;
    try {
      res = await Promise.race([
        api.proxy.fetch(endpoint.credentialId, request.url, {
          method: 'POST',
          headers: request.headers,
          body: JSON.stringify(request.body),
          responseType: 'stream',
          signal: controller.signal,
        }),
        stopped,
      ]);
    } catch (err) {
      if (err instanceof AiError) throw err;
      throw new AiError('unreachable', { detail: err?.message });
    }
    if (!res || !res.ok) throw errorFromResponse(res, endpoint);

    const emit = (piece) => {
      if (!piece) return;
      text += piece;
      onText(text, piece);
    };
    const parser = createSseParser();
    const handle = (events) => {
      for (const ev of events) {
        const delta = deltaFromEvent(format, ev);
        if (delta.error) throw errorFromStream(delta.error, text);
        if (delta.text) emit(delta.text);
        if (delta.toolCalls) tools.add(delta.toolCalls);
        if (delta.response) final = turnFromResponse(format, delta.response);
        if (delta.done) return true;
      }
      return false;
    };

    let toolCalls = null;
    if (!isStream(res.body)) {
      // A host or server that answered in one piece.
      const body = typeof res.body === 'string' ? res.body : '';
      const trimmed = body.trim();
      if (trimmed.startsWith('{')) {
        let json;
        try {
          json = JSON.parse(trimmed);
        } catch {
          throw new AiError('server', { detail: 'unreadable answer' });
        }
        // An error in a body that came back ok: what the service said, not
        // "unreadable" (a Responses API body gives it in its turn).
        if (format !== 'responses' && json?.error && typeof json.error === 'object') {
          throw errorFromStream({ type: json.error.code ?? json.error.type ?? 'api_error', message: json.error.message ?? '' }, '');
        }
        const turn = turnFromResponse(format, json);
        if (format === 'responses') {
          final = turn;
        } else {
          emit(turn.text);
          toolCalls = turn.toolCalls;
        }
      } else {
        handle([...parser.feed(body), ...parser.end()]);
      }
    } else {
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      try {
        for (;;) {
          arm(idleTimeoutMs);
          const { done, value } = await Promise.race([reader.read(), stopped]);
          if (done) {
            handle([...parser.feed(decoder.decode()), ...parser.end()]);
            break;
          }
          if (handle(parser.feed(decoder.decode(value, { stream: true })))) break;
        }
      } catch (err) {
        if (err instanceof AiError) {
          if (err.code === 'cancelled' || err.code === 'timeout') err.partial = text;
          throw err;
        }
        // The stream broke: the proxy cancelled it or the connection dropped.
        if (signal?.aborted) throw new AiError('cancelled', { partial: text });
        throw new AiError(timedOut ? 'timeout' : 'unreachable', { detail: err?.message, partial: text });
      } finally {
        reader.cancel().catch(() => {});
      }
    }
    if (format === 'responses') return responsesTurn(final, text, emit);
    const calls = toolCalls ?? tools.calls();
    if (!text.trim() && calls.length === 0) throw new AiError('empty');
    return { text, toolCalls: calls };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

/** The end of a Responses API turn: tool calls only come from the whole response at the end. */
function responsesTurn(final, text, emit) {
  if (final?.error) throw errorFromStream(final.error, text);
  // A body or stream that carried the text only in the whole response.
  if (!text && final?.text) emit(final.text);
  const answer = text || final?.text || '';
  const calls = final?.toolCalls ?? [];
  if (!answer.trim() && calls.length === 0) {
    if (final?.incomplete) throw new AiError('server', { detail: `incomplete: ${final.incomplete}` });
    throw new AiError('empty');
  }
  return { text: answer, toolCalls: calls, ...(calls.length && final.raw?.length ? { raw: final.raw } : {}) };
}

/**
 * Ask for a completion and stream the answer; resolves to the whole text.
 * For prompts without tools (the quick actions and the reader).
 */
export async function streamCompletion(api, endpoint, prompt, opts = {}) {
  const { text } = await streamTurn(api, endpoint, prompt, opts);
  if (!text.trim()) throw new AiError('empty');
  return text;
}
