import { describe, expect, it } from 'vitest';
import { fakeApi } from '../../test-utils/fake-api.mjs';
import { ANTHROPIC_EP, OPENAI_EP, anthropicSse, openaiSse, streamResponse } from './helpers.mjs';
import { historyMessages, parseAnswer, proposalOf, runChat } from '../src/lib/chat.js';

// The chat: proposals marked with <text> tags, parsed while streaming, and
// the tool loop (the model asks, the plugin looks it up, the model answers).

describe('parseAnswer', () => {
  it('separates what the model says from what it proposes', () => {
    expect(parseAnswer('Here you go:\n<text>\nDear Bob,\nsee you Tuesday.\n</text>\nShall I shorten it?')).toEqual([
      { kind: 'say', text: 'Here you go:' },
      { kind: 'proposal', text: 'Dear Bob,\nsee you Tuesday.', open: false },
      { kind: 'say', text: 'Shall I shorten it?' },
    ]);
  });

  it('keeps an unfinished proposal open while the answer streams', () => {
    expect(parseAnswer('Sure.\n<text>\nDear Bo')).toEqual([
      { kind: 'say', text: 'Sure.' },
      { kind: 'proposal', text: 'Dear Bo', open: true },
    ]);
    // Half a closing tag is not shown.
    expect(parseAnswer('<text>Dear Bob</te')).toEqual([{ kind: 'proposal', text: 'Dear Bob', open: true }]);
    expect(proposalOf('<text>Dear Bob</te')).toEqual({ kind: 'proposal', text: 'Dear Bob', open: true });
  });

  it('reads a plain answer as talk and takes code fences off a proposal', () => {
    expect(parseAnswer('No, Tuesday is fine.')).toEqual([{ kind: 'say', text: 'No, Tuesday is fine.' }]);
    expect(parseAnswer('<text>\n```\nHi there\n```\n</text>')).toEqual([{ kind: 'proposal', text: 'Hi there', open: false }]);
    expect(proposalOf('No, Tuesday is fine.')).toBeNull();
    expect(parseAnswer('')).toEqual([]);
  });

  it('takes widgets out of the answer, checked, and leaves broken ones out', () => {
    expect(parseAnswer('Options:\n<widget>{"type":"choices","items":["a","b"]}</widget>\nmore')).toEqual([
      { kind: 'say', text: 'Options:' },
      { kind: 'widget', widget: { type: 'choices', items: ['a', 'b'] }, open: false },
      { kind: 'say', text: 'more' },
    ]);
    expect(parseAnswer('<widget>{"type":"nope"}</widget>after')).toEqual([{ kind: 'say', text: 'after' }]);
    // Still streaming: the widget is not drawn yet.
    expect(parseAnswer('x\n<widget>{"type":"cho')).toEqual([{ kind: 'say', text: 'x' }, { kind: 'widget', widget: null, open: true }]);
    expect(parseAnswer('<text>a</text><widget>{"type":"choices","items":["c"]}</widget>').map((p) => p.kind)).toEqual(['proposal', 'widget']);
  });

  it('ignores case and spacing of the tags', () => {
    expect(parseAnswer('<TEXT>  Hello </TEXT>')).toEqual([{ kind: 'proposal', text: 'Hello', open: false }]);
  });

  it('reads the recipients and subject of a new email, addresses only', () => {
    expect(parseAnswer('Here:\n<text to="Jannis Gollwitzer <info@it-media-hof.de>, not-an-address, bo@example.org" subject=" Kurzes Gespräch ">\nHallo Jannis,\n</text>')).toEqual([
      { kind: 'say', text: 'Here:' },
      { kind: 'proposal', text: 'Hallo Jannis,', open: false, to: ['info@it-media-hof.de', 'bo@example.org'], subject: 'Kurzes Gespräch' },
    ]);
    // Streaming: the opening tag and its attributes are not shown as talk while they come in.
    expect(parseAnswer('Here:\n<text to="info@it-me')).toEqual([{ kind: 'say', text: 'Here:' }]);
    expect(parseAnswer('<text to="info@it-media-hof.de">Hallo')).toEqual([{ kind: 'proposal', text: 'Hallo', open: true, to: ['info@it-media-hof.de'] }]);
  });
});

describe('historyMessages', () => {
  it('sends the last turns, clipped, without tool steps and empty turns', () => {
    const turns = [
      { role: 'user', content: 'a' }, { role: 'step', content: 'lookup' }, { role: 'assistant', content: '' },
      { role: 'assistant', content: 'b' }, { role: 'user', content: 'c'.repeat(50) },
    ];
    expect(historyMessages(turns, { limit: 2, chars: 10 })).toEqual([
      { role: 'assistant', content: 'b' },
      { role: 'user', content: 'cccccccccc\n[…]' },
    ]);
  });
});

/** A model that answers each request in turn from `answers` (SSE bodies). */
function modelApi(answers, { sent = [] } = {}) {
  let i = 0;
  return fakeApi({
    handlers: {
      'proxy.fetch': async (_id, _url, init) => {
        sent.push(JSON.parse(init.body));
        return streamResponse(answers[Math.min(i++, answers.length - 1)]);
      },
    },
  });
}

const anthropicToolTurn = (text, { id, name, input }) => {
  const ev = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  let out = ev('message_start', { type: 'message_start' });
  if (text) {
    out += ev('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text' } });
    out += ev('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } });
    out += ev('content_block_stop', { type: 'content_block_stop', index: 0 });
  }
  out += ev('content_block_start', { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id, name } });
  const json = JSON.stringify(input);
  out += ev('content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: json.slice(0, 5) } });
  out += ev('content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: json.slice(5) } });
  out += ev('content_block_stop', { type: 'content_block_stop', index: 1 });
  out += ev('message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use' } });
  return out + ev('message_stop', { type: 'message_stop' });
};

const openaiToolTurn = ({ id, name, args }) => {
  const chunk = (delta, finish = null) => `data: ${JSON.stringify({ choices: [{ delta, finish_reason: finish }] })}\n\n`;
  const json = JSON.stringify(args);
  return chunk({ role: 'assistant' })
    + chunk({ tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: json.slice(0, 4) } }] })
    + chunk({ tool_calls: [{ index: 0, function: { arguments: json.slice(4) } }] })
    + chunk({}, 'tool_calls')
    + 'data: [DONE]\n\n';
};

const TOOLS = [{ name: 'check_calendar', description: 'd', parameters: { type: 'object', properties: {} } }];

describe('runChat', () => {
  it('answers without tools in one round and streams the text', async () => {
    const seen = [];
    const api = modelApi([anthropicSse(['Tues', 'day works.'])]);
    const out = await runChat(api, ANTHROPIC_EP, { system: 's', messages: [{ role: 'user', content: 'ok?' }], tools: TOOLS, runTool: async () => '' }, { onText: (t) => seen.push(t) });
    expect(out).toEqual({ text: 'Tuesday works.', steps: [] });
    expect(seen.at(-1)).toBe('Tuesday works.');
  });

  it('runs the tools the model asks for, hands the results back and reports each step (Anthropic)', async () => {
    const sent = [];
    const api = modelApi([
      anthropicToolTurn('Let me check.', { id: 'tu_1', name: 'check_calendar', input: { from: '2026-10-22', to: '2026-10-22' } }),
      anthropicSse(['You are free at 10.']),
    ], { sent });
    const steps = [];
    const texts = [];
    const runTool = async (name, args) => `events for ${name} ${args.from}: none`;
    const out = await runChat(api, ANTHROPIC_EP, { system: 's', messages: [{ role: 'user', content: 'free?' }], tools: TOOLS, runTool }, {
      onStep: (s) => steps.push(s),
      onText: (t) => texts.push(t),
    });
    // What the model said before the lookup is not part of the answer.
    expect(out.text).toBe('You are free at 10.');
    expect(steps).toEqual([
      { id: 'tu_1', name: 'check_calendar', args: { from: '2026-10-22', to: '2026-10-22' }, status: 'running', result: '', widget: null },
      { id: 'tu_1', name: 'check_calendar', args: { from: '2026-10-22', to: '2026-10-22' }, status: 'done', result: 'events for check_calendar 2026-10-22: none', widget: null },
    ]);
    // The first request offered the tools; the second carried the call and its result.
    expect(sent[0].tools).toEqual([{ name: 'check_calendar', description: 'd', input_schema: { type: 'object', properties: {} } }]);
    expect(sent[1].messages.slice(1)).toEqual([
      { role: 'assistant', content: [{ type: 'text', text: 'Let me check.' }, { type: 'tool_use', id: 'tu_1', name: 'check_calendar', input: { from: '2026-10-22', to: '2026-10-22' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'events for check_calendar 2026-10-22: none' }] },
    ]);
    // The narration streamed, was cleared when the lookup started, and the answer followed.
    expect(texts).toContain('Let me check.');
    expect(texts).toContain('');
    expect(texts.at(-1)).toBe('You are free at 10.');
  });

  it('keeps the card a tool brings for the step and hands only the text to the model', async () => {
    const sent = [];
    const api = modelApi([anthropicToolTurn('', { id: 'tu', name: 'find_contact', input: { query: 'anna' } }), anthropicSse(['Anna is anna@e.org.'])], { sent });
    const steps = [];
    await runChat(api, ANTHROPIC_EP, { system: 's', messages: [{ role: 'user', content: 'x' }], tools: TOOLS, runTool: async () => ({ text: 'Contacts: Anna', widget: { type: 'contacts', items: [{ name: 'Anna', email: 'anna@e.org' }] } }) }, { onStep: (s) => steps.push(s) });
    expect(steps.at(-1)).toMatchObject({ status: 'done', result: 'Contacts: Anna', widget: { type: 'contacts' } });
    expect(sent[1].messages.at(-1)).toEqual({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu', content: 'Contacts: Anna' }] });
  });

  it('speaks the OpenAI tool shape too, and tells the model when a tool failed', async () => {
    const sent = [];
    const api = modelApi([
      openaiToolTurn({ id: 'call_9', name: 'check_calendar', args: { from: '2026-10-22', to: '2026-10-23' } }),
      openaiSse(['Could not check.']),
    ], { sent });
    const steps = [];
    const out = await runChat(api, OPENAI_EP, { system: 's', messages: [{ role: 'user', content: 'free?' }], tools: TOOLS, runTool: async () => { throw new Error('no calendar'); } }, { onStep: (s) => steps.push(s) });
    expect(out.text).toBe('Could not check.');
    expect(steps.at(-1)).toMatchObject({ status: 'failed', result: 'The tool failed: no calendar' });
    expect(sent[0].tools[0]).toEqual({ type: 'function', function: { name: 'check_calendar', description: 'd', parameters: { type: 'object', properties: {} } } });
    expect(sent[1].messages.slice(2)).toEqual([
      { role: 'assistant', content: null, tool_calls: [{ id: 'call_9', type: 'function', function: { name: 'check_calendar', arguments: '{"from":"2026-10-22","to":"2026-10-23"}' } }] },
      { role: 'tool', tool_call_id: 'call_9', content: 'The tool failed: no calendar' },
    ]);
  });

  it('keeps the narration when the model falls silent after its last lookup', async () => {
    const api = modelApi([anthropicToolTurn('Checking your calendar.', { id: 'tu', name: 'check_calendar', input: {} }), anthropicSse([' '])]);
    await expect(runChat(api, ANTHROPIC_EP, { system: 's', messages: [{ role: 'user', content: 'x' }], tools: TOOLS, runTool: async () => 'r' })).rejects.toThrow(/empty/);
    const api2 = modelApi([anthropicToolTurn('Checking your calendar.', { id: 'tu', name: 'check_calendar', input: {} }), anthropicToolTurn('', { id: 'tu2', name: 'check_calendar', input: {} }), anthropicSse([' '])]);
    await expect(runChat(api2, ANTHROPIC_EP, { system: 's', messages: [{ role: 'user', content: 'x' }], tools: TOOLS, runTool: async () => 'r' })).rejects.toThrow(/empty/);
  });

  it('stops offering tools after a few rounds so the model has to answer', async () => {
    const sent = [];
    const loop = anthropicToolTurn('', { id: 'tu', name: 'check_calendar', input: {} });
    const api = modelApi([loop, loop, loop, loop, anthropicSse(['Done.'])], { sent });
    const out = await runChat(api, ANTHROPIC_EP, { system: 's', messages: [{ role: 'user', content: 'x' }], tools: TOOLS, runTool: async () => 'r' });
    expect(out.text).toBe('Done.');
    expect(sent).toHaveLength(5);
    expect(sent[4].tools).toBeUndefined();
  });
});
