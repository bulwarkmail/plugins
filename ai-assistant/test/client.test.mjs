import { describe, it, expect } from 'vitest';
import { fakeApi, proxyResponse } from '../../test-utils/fake-api.mjs';
import { streamCompletion, streamTurn } from '../src/lib/client.js';
import { ANTHROPIC_EP, OPENAI_EP, RESPONSES_EP, anthropicSse, openaiSse, responsesSse, streamResponse } from './helpers.mjs';

const prompt = { system: 's', messages: [{ role: 'user', content: 'Hi' }] };

describe('streamCompletion', () => {
  it('streams an Anthropic answer piece by piece through the admin credential', async () => {
    const api = fakeApi({ handlers: { 'proxy.fetch': async () => streamResponse(anthropicSse(['Grüß', 'e aus ', 'Köln']), { size: 1 }) } });
    const seen = [];
    const text = await streamCompletion(api, ANTHROPIC_EP, prompt, { onText: (full) => seen.push(full) });
    expect(text).toBe('Grüße aus Köln');
    expect(seen).toEqual(['Grüß', 'Grüße aus ', 'Grüße aus Köln']);
    const [credentialId, url, init] = api.calls('proxy.fetch')[0].args;
    expect(credentialId).toBe('anthropic');
    expect(url).toBe('http://localhost:18099/anthropic/v1/messages');
    expect(init).toMatchObject({ method: 'POST', responseType: 'stream' });
    expect(JSON.parse(init.body)).toMatchObject({ model: 'm', stream: true, messages: prompt.messages });
  });

  it('streams an OpenAI-compatible answer', async () => {
    const api = fakeApi({ handlers: { 'proxy.fetch': async () => streamResponse(openaiSse(['One ', 'two'])) } });
    expect(await streamCompletion(api, OPENAI_EP, prompt)).toBe('One two');
    expect(api.calls('proxy.fetch')[0].args[1]).toBe('http://localhost:18099/openai/v1/chat/completions');
  });

  it('accepts an answer that came in one piece', async () => {
    const api = fakeApi({ handlers: { 'proxy.fetch': async () => proxyResponse('{"choices":[{"message":{"content":"Whole"}}]}') } });
    expect(await streamCompletion(api, OPENAI_EP, prompt)).toBe('Whole');
    const anthropic = fakeApi({ handlers: { 'proxy.fetch': async () => proxyResponse('{"type":"message","content":[{"type":"text","text":"Whole"}]}') } });
    expect(await streamCompletion(anthropic, ANTHROPIC_EP, prompt)).toBe('Whole');
  });

  it('says what the service said when the one piece is an error', async () => {
    const api = fakeApi({ handlers: { 'proxy.fetch': async () => proxyResponse('{"error":{"code":"rate_limit_exceeded","message":"slow down"}}') } });
    await expect(streamCompletion(api, OPENAI_EP, prompt)).rejects.toMatchObject({ code: 'rate_limit', detail: 'slow down' });
    const anthropic = fakeApi({ handlers: { 'proxy.fetch': async () => proxyResponse('{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}') } });
    await expect(streamCompletion(anthropic, ANTHROPIC_EP, prompt)).rejects.toMatchObject({ code: 'busy' });
  });

  it('rejects with rate_limit and the wait time on 429', async () => {
    const api = fakeApi({ handlers: { 'proxy.fetch': async () => proxyResponse('{"type":"error","error":{"type":"rate_limit_error","message":"Rate limited"}}', { status: 429, headers: { 'retry-after': '7' } }) } });
    await expect(streamCompletion(api, ANTHROPIC_EP, prompt)).rejects.toMatchObject({ code: 'rate_limit', retryAfter: 7 });
  });

  it('rejects with bad_key on 401', async () => {
    const api = fakeApi({ handlers: { 'proxy.fetch': async () => proxyResponse('{"error":{"code":"invalid_api_key"}}', { status: 401 }) } });
    await expect(streamCompletion(api, OPENAI_EP, prompt)).rejects.toMatchObject({ code: 'bad_key' });
  });

  it('rejects with the service error that arrives mid-stream, keeping the text so far', async () => {
    const api = fakeApi({ handlers: { 'proxy.fetch': async () => streamResponse(anthropicSse(['Half'], { error: { type: 'overloaded_error', message: 'Overloaded' } })) } });
    await expect(streamCompletion(api, ANTHROPIC_EP, prompt)).rejects.toMatchObject({ code: 'busy', partial: 'Half' });
  });

  it('times out when the service never answers, and cancels the request', async () => {
    let signal;
    const api = fakeApi({ handlers: { 'proxy.fetch': (_c, _u, init) => { signal = init.signal; return new Promise(() => {}); } } });
    await expect(streamCompletion(api, ANTHROPIC_EP, prompt, { firstResponseTimeoutMs: 30 })).rejects.toMatchObject({ code: 'timeout' });
    expect(signal.aborted).toBe(true);
  });

  it('times out when a started answer stalls', async () => {
    const api = fakeApi({ handlers: { 'proxy.fetch': async () => streamResponse(anthropicSse(['Start']).split('event: content_block_stop')[0], { hang: true, size: 4096 }) } });
    await expect(streamCompletion(api, ANTHROPIC_EP, prompt, { idleTimeoutMs: 40 })).rejects.toMatchObject({ code: 'timeout', partial: 'Start' });
  });

  it('stops when the user cancels, keeping the text so far', async () => {
    const controller = new AbortController();
    const api = fakeApi({ handlers: { 'proxy.fetch': async () => streamResponse(anthropicSse(['First']).split('event: content_block_stop')[0], { hang: true, size: 4096 }) } });
    const run = streamCompletion(api, ANTHROPIC_EP, prompt, {
      signal: controller.signal,
      onText: () => controller.abort(),
    });
    await expect(run).rejects.toMatchObject({ code: 'cancelled', partial: 'First' });
  });

  it('treats an empty answer as an error', async () => {
    const api = fakeApi({ handlers: { 'proxy.fetch': async () => streamResponse(anthropicSse([])) } });
    await expect(streamCompletion(api, ANTHROPIC_EP, prompt)).rejects.toMatchObject({ code: 'empty' });
  });
});

describe('streamTurn with the Responses API', () => {
  const reasoning = { type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: 'enc' };
  const call = { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'check_calendar', arguments: '{"from":"2026-11-19"}', status: 'completed' };
  const tools = [{ name: 'check_calendar', description: 'd', parameters: { type: 'object', properties: {} } }];

  it('streams the text to /responses', async () => {
    const api = fakeApi({ handlers: { 'proxy.fetch': async () => streamResponse(responsesSse(['One ', 'two']), { size: 5 }) } });
    const seen = [];
    expect(await streamCompletion(api, RESPONSES_EP, prompt, { onText: (full) => seen.push(full) })).toBe('One two');
    expect(seen.at(-1)).toBe('One two');
    const [, url, init] = api.calls('proxy.fetch')[0].args;
    expect(url).toBe('http://localhost:18099/openai/v1/responses');
    expect(JSON.parse(init.body)).toMatchObject({ model: 'm', instructions: 's', store: false, stream: true });
  });

  it('takes the tool calls by call_id, and the items to send back, from the whole response at the end', async () => {
    const api = fakeApi({ handlers: { 'proxy.fetch': async () => streamResponse(responsesSse([], { output: [reasoning, call] })) } });
    const turn = await streamTurn(api, RESPONSES_EP, { ...prompt, tools });
    expect(turn).toEqual({ text: '', toolCalls: [{ id: 'call_1', name: 'check_calendar', args: { from: '2026-11-19' } }], raw: [reasoning, call] });
  });

  it('calls no tools when the response stopped early or the stream broke off before its end', async () => {
    const early = fakeApi({ handlers: { 'proxy.fetch': async () => streamResponse(responsesSse(['Half'], { output: [reasoning, call], end: 'incomplete' })) } });
    expect(await streamTurn(early, RESPONSES_EP, { ...prompt, tools })).toEqual({ text: 'Half', toolCalls: [] });
    const silent = fakeApi({ handlers: { 'proxy.fetch': async () => streamResponse(responsesSse([], { output: [reasoning, call], end: 'incomplete' })) } });
    await expect(streamTurn(silent, RESPONSES_EP, { ...prompt, tools })).rejects.toMatchObject({ code: 'server', detail: 'incomplete: max_output_tokens' });
    const broken = fakeApi({ handlers: { 'proxy.fetch': async () => streamResponse(responsesSse(['Some'], { end: 'none' })) } });
    expect(await streamTurn(broken, RESPONSES_EP, { ...prompt, tools })).toEqual({ text: 'Some', toolCalls: [] });
  });

  it('says what failed: a failed response and an error event', async () => {
    const failed = 'event: response.failed\ndata: {"type":"response.failed","response":{"status":"failed","error":{"code":"server_error","message":"boom"}}}\n\n';
    const api = fakeApi({ handlers: { 'proxy.fetch': async () => streamResponse(failed) } });
    await expect(streamCompletion(api, RESPONSES_EP, prompt)).rejects.toMatchObject({ code: 'server', detail: 'boom' });
    const limited = 'event: error\ndata: {"type":"error","code":"rate_limit_exceeded","message":"slow down"}\n\n';
    const api2 = fakeApi({ handlers: { 'proxy.fetch': async () => streamResponse(limited) } });
    await expect(streamCompletion(api2, RESPONSES_EP, prompt)).rejects.toMatchObject({ code: 'rate_limit' });
  });

  it('accepts a whole response in one piece, and an error in one', async () => {
    const body = JSON.stringify({ status: 'completed', output: [reasoning, { type: 'message', content: [{ type: 'output_text', text: 'Whole' }] }, call] });
    const api = fakeApi({ handlers: { 'proxy.fetch': async () => proxyResponse(body) } });
    const seen = [];
    const turn = await streamTurn(api, RESPONSES_EP, { ...prompt, tools }, { onText: (full) => seen.push(full) });
    expect(turn.text).toBe('Whole');
    expect(seen).toEqual(['Whole']);
    expect(turn.toolCalls).toEqual([{ id: 'call_1', name: 'check_calendar', args: { from: '2026-11-19' } }]);
    expect(turn.raw).toHaveLength(3);
    const api2 = fakeApi({ handlers: { 'proxy.fetch': async () => proxyResponse('{"error":{"code":"server_error","message":"boom"}}') } });
    await expect(streamCompletion(api2, RESPONSES_EP, prompt)).rejects.toMatchObject({ code: 'server', detail: 'boom' });
  });

  it('points to the setting when chat completions refuse a model that needs the Responses API', async () => {
    const message = "Function tools with reasoning_effort are not supported for gpt-6.1-terra in /v1/chat/completions. To use function tools, use /v1/responses or set reasoning_effort to 'none'.";
    const api = fakeApi({ handlers: { 'proxy.fetch': async () => proxyResponse(JSON.stringify({ error: { message, type: 'invalid_request_error', param: 'reasoning_effort', code: null } }), { status: 400 }) } });
    await expect(streamTurn(api, { ...OPENAI_EP, api: 'chat' }, { ...prompt, tools })).rejects.toMatchObject({ code: 'needs_responses', status: 400 });
  });
});
