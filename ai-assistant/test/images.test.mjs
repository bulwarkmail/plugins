import { describe, expect, it } from 'vitest';
import { fakeApi } from '../../test-utils/fake-api.mjs';
import { ANTHROPIC_EP, OPENAI_EP, anthropicSse, openaiSse, streamResponse } from './helpers.mjs';
import { buildRequest } from '../src/lib/providers.js';
import { runChat } from '../src/lib/chat.js';

// Pictures for the model: both API shapes, inside tool results, and what the
// model hears when it can't see them.

const PNG = { type: 'image', mediaType: 'image/png', data: 'iVBORw0KGgo=', name: 'whiteboard.png', width: 320, height: 200 };
const anthropic = { provider: 'anthropic', baseUrl: 'https://api.anthropic.com/v1', model: 'claude-haiku-5-5' };
const openai = { provider: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' };

const withToolImage = [
  { role: 'user', content: 'What is on the whiteboard?' },
  { role: 'assistant', content: '', toolCalls: [{ id: 't1', name: 'read_attachment', args: { name: 'whiteboard.png' } }, { id: 't2', name: 'read_thread', args: {} }] },
  { role: 'tool', toolCallId: 't1', name: 'read_attachment', content: [{ type: 'text', text: 'The picture whiteboard.png is attached.' }, PNG] },
  { role: 'tool', toolCallId: 't2', name: 'read_thread', content: 'Three messages.' },
];

describe('images in requests', () => {
  it('sends Anthropic image blocks in user messages and inside tool results', () => {
    const user = buildRequest(anthropic, { messages: [{ role: 'user', content: [{ type: 'text', text: 'Look' }, PNG] }] });
    expect(user.body.messages[0].content).toEqual([
      { type: 'text', text: 'Look' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } },
    ]);
    const tool = buildRequest(anthropic, { messages: withToolImage, tools: [{ name: 'read_attachment', description: 'd', parameters: {} }] });
    expect(tool.body.messages.at(-1)).toEqual({ role: 'user', content: [
      { type: 'tool_result', tool_use_id: 't1', content: [
        { type: 'text', text: 'The picture whiteboard.png is attached.' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } },
      ] },
      { type: 'tool_result', tool_use_id: 't2', content: 'Three messages.' },
    ] });
  });

  it('sends OpenAI images as data URLs, and the images of tool results in a user message after the tool messages', () => {
    const user = buildRequest(openai, { messages: [{ role: 'user', content: [{ type: 'text', text: 'Look' }, PNG] }] });
    expect(user.body.messages[0].content).toEqual([
      { type: 'text', text: 'Look' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' } },
    ]);
    const tool = buildRequest(openai, { messages: withToolImage, tools: [{ name: 'read_attachment', description: 'd', parameters: {} }] });
    const [, , first, second, images] = tool.body.messages;
    // Tool messages stay text: both follow the assistant turn directly.
    expect(first).toEqual({ role: 'tool', tool_call_id: 't1', content: 'The picture whiteboard.png is attached.\n(The image follows in the next message.)' });
    expect(second).toEqual({ role: 'tool', tool_call_id: 't2', content: 'Three messages.' });
    expect(images.role).toBe('user');
    expect(images.content.at(-1)).toEqual({ type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' } });
    expect(tool.body.messages).toHaveLength(5);
  });

  it('gives a model that can\'t see images the name and size instead', () => {
    for (const endpoint of [anthropic, openai]) {
      const r = buildRequest(endpoint, { messages: [{ role: 'user', content: [{ type: 'text', text: 'Look' }, { ...PNG, alt: 'Plan for Q4' }] }], images: false });
      const sent = r.body.messages.at(-1).content;
      expect(sent).toBe('Look\n[Image: whiteboard.png, 320×200. This model can\'t see images.] Its description: Plan for Q4');
      expect(JSON.stringify(r.body)).not.toContain('iVBORw0KGgo');
    }
  });

  it('keeps plain text messages as strings', () => {
    expect(buildRequest(anthropic, { messages: [{ role: 'user', content: 'Hi' }] }).body.messages).toEqual([{ role: 'user', content: 'Hi' }]);
    expect(buildRequest(openai, { messages: [{ role: 'user', content: 'Hi' }] }).body.messages).toEqual([{ role: 'user', content: 'Hi' }]);
  });
});

/** A model that answers each request in turn: SSE bodies, or { status, body } for a refusal. */
function modelApi(answers, sent) {
  let i = 0;
  return fakeApi({
    handlers: {
      'proxy.fetch': async (_id, _url, init) => {
        sent.push(JSON.parse(init.body));
        const answer = answers[Math.min(i++, answers.length - 1)];
        if (typeof answer === 'string') return streamResponse(answer);
        return { status: answer.status, ok: false, headers: { 'content-type': 'application/json' }, body: JSON.stringify(answer.body) };
      },
    },
  });
}

const toolTurn = (provider) => {
  if (provider === 'openai') {
    const chunk = (delta, finish = null) => `data: ${JSON.stringify({ choices: [{ delta, finish_reason: finish }] })}\n\n`;
    return chunk({ tool_calls: [{ index: 0, id: 'c1', type: 'function', function: { name: 'read_attachment', arguments: '{"name":"whiteboard.png"}' } }] }) + chunk({}, 'tool_calls') + 'data: [DONE]\n\n';
  }
  const ev = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  return ev('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'c1', name: 'read_attachment' } })
    + ev('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"name":"whiteboard.png"}' } })
    + ev('message_stop', { type: 'message_stop' });
};
const TOOLS = [{ name: 'read_attachment', description: 'd', parameters: { type: 'object', properties: {} } }];

describe('images from lookups in the chat', () => {
  it('hands a lookup\'s image to the model but keeps it out of the step', async () => {
    for (const endpoint of [ANTHROPIC_EP, OPENAI_EP]) {
      const sent = [];
      const api = modelApi([toolTurn(endpoint.provider), endpoint === ANTHROPIC_EP ? anthropicSse(['A plan.']) : openaiSse(['A plan.'])], sent);
      const steps = [];
      const out = await runChat(api, endpoint, {
        system: 's', messages: [{ role: 'user', content: 'what is on it?' }], tools: TOOLS,
        runTool: async () => ({ text: 'The picture whiteboard.png is attached.', images: [{ mediaType: 'image/png', data: 'iVBORw0KGgo=', name: 'whiteboard.png' }] }),
      }, { onStep: (s) => steps.push(s) });
      expect(out.text).toBe('A plan.');
      expect(JSON.stringify(sent[1])).toContain('iVBORw0KGgo=');
      expect(JSON.stringify(steps)).not.toContain('iVBORw0KGgo=');
      expect(steps.at(-1).result).toBe('The picture whiteboard.png is attached.');
    }
  });

  it('asks once more without the images when the service refuses them, and the model hears why', async () => {
    const sent = [];
    const api = modelApi([
      toolTurn('openai'),
      { status: 400, body: { error: { message: 'image input is not supported - hint: if this is unexpected, you may need to provide the mmproj' } } },
      openaiSse(['I can only see the file name.']),
    ], sent);
    const out = await runChat(api, OPENAI_EP, {
      system: 's', messages: [{ role: 'user', content: 'what is on it?' }], tools: TOOLS,
      runTool: async () => ({ text: 'The picture whiteboard.png is attached.', images: [{ mediaType: 'image/png', data: 'iVBORw0KGgo=', name: 'whiteboard.png' }] }),
    });
    expect(out.text).toBe('I can only see the file name.');
    expect(sent).toHaveLength(3);
    expect(JSON.stringify(sent[1])).toContain('iVBORw0KGgo=');
    expect(JSON.stringify(sent[2])).not.toContain('iVBORw0KGgo=');
    expect(JSON.stringify(sent[2])).toContain('[Image: whiteboard.png. The AI service refused the image');
  });

  it('does not ask again for other refusals', async () => {
    const sent = [];
    const api = modelApi([toolTurn('openai'), { status: 400, body: { error: { message: 'bad tool schema' } } }], sent);
    await expect(runChat(api, OPENAI_EP, {
      system: 's', messages: [{ role: 'user', content: 'x' }], tools: TOOLS,
      runTool: async () => ({ text: 't', images: [{ mediaType: 'image/png', data: 'AAAA', name: 'a.png' }] }),
    })).rejects.toMatchObject({ code: 'bad_request' });
    expect(sent).toHaveLength(2);
  });
});
