"""Tests for the scripted AI answers of the mock server (standard library only).

    python -m unittest test-env/mocks/test_server.py      (from the repository root)
    python test-env/mocks/test_server.py
"""
import importlib.util
import json
import os
import threading
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer

_spec = importlib.util.spec_from_file_location('mock_server', os.path.join(os.path.dirname(os.path.abspath(__file__)), 'server.py'))
server = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(server)

ANTHROPIC = {'x-api-key': server.ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json'}
OPENAI = {'authorization': f'Bearer {server.OPENAI_KEY}', 'content-type': 'application/json'}
LOOKUP = {'name': 'lookup', 'steps': [
    {'text': 'Looking.', 'tools': [{'name': 'search_mail', 'input': {'text': 'invoice'}}]},
    {'text': 'Found: {{tool_results}}'},
]}
TOOLS_A = [{'name': 'search_mail', 'description': 'x', 'input_schema': {'type': 'object'}}]
TOOLS_O = [{'type': 'function', 'function': {'name': 'search_mail', 'parameters': {'type': 'object'}}}]
TOOLS_R = [{'type': 'function', 'name': 'search_mail', 'description': 'x',
            'parameters': {'type': 'object'}, 'strict': False}]


class MockAI(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.httpd = ThreadingHTTPServer(('127.0.0.1', 0), server.Handler)
        cls.base = f'http://127.0.0.1:{cls.httpd.server_address[1]}'
        threading.Thread(target=cls.httpd.serve_forever, daemon=True).start()
        server.Handler.log_message = lambda *a: None

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()

    def setUp(self):
        self.post('/__reset', {})
        self.post('/__ai/scripts', LOOKUP)

    def post(self, path, body, headers=None):
        req = urllib.request.Request(self.base + path, data=json.dumps(body).encode(), method='POST',
                                     headers=headers or {'content-type': 'application/json'})
        try:
            with urllib.request.urlopen(req, timeout=10) as r:
                return r.status, r.read().decode()
        except urllib.error.HTTPError as e:
            with e:
                return e.code, e.read().decode()

    def get(self, path):
        with urllib.request.urlopen(self.base + path, timeout=10) as r:
            return json.loads(r.read().decode())

    @staticmethod
    def events(raw):
        return [json.loads(line[6:]) for line in raw.splitlines() if line.startswith('data: ') and line[6:] != '[DONE]']

    def test_anthropic_stream_calls_the_tool_then_answers_with_its_result(self):
        first = [{'role': 'user', 'content': 'find it [[mock:lookup]]'}]
        status, raw = self.post('/anthropic/v1/messages', {'model': 'm', 'max_tokens': 99, 'stream': True, 'tools': TOOLS_A, 'messages': first}, ANTHROPIC)
        self.assertEqual(status, 200)
        evs = self.events(raw)
        use = [e for e in evs if e['type'] == 'content_block_start' and e['content_block']['type'] == 'tool_use']
        self.assertEqual(len(use), 1)
        self.assertEqual(use[0]['content_block']['name'], 'search_mail')
        args = ''.join(e['delta']['partial_json'] for e in evs if e['type'] == 'content_block_delta' and e['delta']['type'] == 'input_json_delta')
        self.assertEqual(json.loads(args), {'text': 'invoice'})
        self.assertEqual([e for e in evs if e['type'] == 'message_delta'][0]['delta']['stop_reason'], 'tool_use')
        tool_id = use[0]['content_block']['id']
        second = first + [
            {'role': 'assistant', 'content': [{'type': 'text', 'text': 'Looking.'}, {'type': 'tool_use', 'id': tool_id, 'name': 'search_mail', 'input': {'text': 'invoice'}}]},
            {'role': 'user', 'content': [{'type': 'tool_result', 'tool_use_id': tool_id, 'content': 'Invoice 42 from Dan'}]},
        ]
        status, raw = self.post('/anthropic/v1/messages', {'model': 'm', 'max_tokens': 99, 'stream': True, 'tools': TOOLS_A, 'messages': second}, ANTHROPIC)
        text = ''.join(e['delta']['text'] for e in self.events(raw) if e['type'] == 'content_block_delta' and e['delta']['type'] == 'text_delta')
        self.assertEqual(text, 'Found: Invoice 42 from Dan')
        log = self.get('/__ai/requests?marker=lookup')
        self.assertEqual([r['step'] for r in log], [0, 1])
        self.assertEqual(log[0]['tools'], ['search_mail'])

    def test_anthropic_refuses_tool_blocks_without_tools_and_lone_tool_uses(self):
        msgs = [{'role': 'user', 'content': 'hi'},
                {'role': 'assistant', 'content': [{'type': 'tool_use', 'id': 't1', 'name': 'search_mail', 'input': {}}]},
                {'role': 'user', 'content': [{'type': 'tool_result', 'tool_use_id': 't1', 'content': 'x'}]}]
        status, raw = self.post('/anthropic/v1/messages', {'model': 'm', 'max_tokens': 9, 'messages': msgs}, ANTHROPIC)
        self.assertEqual(status, 400)
        self.assertIn('must define tools', raw)
        status, raw = self.post('/anthropic/v1/messages', {'model': 'm', 'max_tokens': 9, 'tools': TOOLS_A, 'messages': msgs[:2] + [{'role': 'user', 'content': 'and?'}]}, ANTHROPIC)
        self.assertEqual(status, 400)
        self.assertIn('without `tool_result`', raw)

    def test_a_tool_that_was_not_offered_is_named_instead_of_called(self):
        status, raw = self.post('/anthropic/v1/messages', {'model': 'm', 'max_tokens': 9, 'tools': [], 'messages': [{'role': 'user', 'content': '[[mock:lookup]]'}]}, ANTHROPIC)
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(raw)['content'][0]['text'], 'Mock: tool "search_mail" was not offered.')

    def test_the_marker_can_come_from_the_system_prompt(self):
        status, raw = self.post('/anthropic/v1/messages', {'model': 'm', 'max_tokens': 9, 'system': 'Standing: [[mock:lookup]]', 'tools': TOOLS_A, 'messages': [{'role': 'user', 'content': 'Summarize'}]}, ANTHROPIC)
        self.assertEqual(json.loads(raw)['stop_reason'], 'tool_use')

    def test_openai_stream_calls_the_tool_then_answers(self):
        first = [{'role': 'system', 'content': 'sys'}, {'role': 'user', 'content': 'find [[mock:lookup]]'}]
        status, raw = self.post('/openai/v1/chat/completions', {'model': 'm', 'stream': True, 'tools': TOOLS_O, 'messages': first}, OPENAI)
        self.assertEqual(status, 200)
        evs = self.events(raw)
        deltas = [c for e in evs for c in e['choices'][0]['delta'].get('tool_calls', [])]
        self.assertEqual(deltas[0]['function']['name'], 'search_mail')
        self.assertEqual(json.loads(''.join(d['function'].get('arguments', '') for d in deltas)), {'text': 'invoice'})
        self.assertEqual(evs[-1]['choices'][0]['finish_reason'], 'tool_calls')
        call_id = deltas[0]['id']
        second = first + [
            {'role': 'assistant', 'content': None, 'tool_calls': [{'id': call_id, 'type': 'function', 'function': {'name': 'search_mail', 'arguments': '{"text":"invoice"}'}}]},
            {'role': 'tool', 'tool_call_id': call_id, 'content': 'Invoice 42 from Dan'},
        ]
        status, raw = self.post('/openai/v1/chat/completions', {'model': 'm', 'stream': True, 'tools': TOOLS_O, 'messages': second}, OPENAI)
        text = ''.join(e['choices'][0]['delta'].get('content') or '' for e in self.events(raw))
        self.assertEqual(text, 'Found: Invoice 42 from Dan')

    def test_non_stream_shapes_and_errors(self):
        status, raw = self.post('/openai/v1/chat/completions', {'model': 'm', 'tools': TOOLS_O, 'messages': [{'role': 'user', 'content': '[[mock:lookup]]'}]}, OPENAI)
        msg = json.loads(raw)['choices'][0]['message']
        self.assertEqual(msg['tool_calls'][0]['function']['name'], 'search_mail')
        self.post('/__ai/scripts', {'name': 'busy', 'steps': [{'error': {'status': 529, 'type': 'overloaded_error', 'message': 'Overloaded'}}]})
        status, raw = self.post('/anthropic/v1/messages', {'model': 'm', 'max_tokens': 9, 'messages': [{'role': 'user', 'content': '[[mock:busy]]'}]}, ANTHROPIC)
        self.assertEqual(status, 529)
        self.assertEqual(json.loads(raw)['error']['type'], 'overloaded_error')

    def response_events(self, raw):
        evs = self.events(raw)
        self.assertNotIn('[DONE]', raw)
        self.assertEqual([line[7:] for line in raw.splitlines() if line.startswith('event: ')],
                         [e['type'] for e in evs])
        self.assertEqual([e['sequence_number'] for e in evs], list(range(len(evs))))
        self.assertEqual(evs[0]['type'], 'response.created')
        self.assertEqual(evs[0]['response']['status'], 'in_progress')
        self.assertEqual(evs[0]['response']['output'], [])
        self.assertEqual(evs[-1]['type'], 'response.completed')
        self.assertEqual(evs[-1]['response']['status'], 'completed')
        self.assertEqual([e['item'] for e in evs if e['type'] == 'response.output_item.done'],
                         evs[-1]['response']['output'])
        return evs

    def test_responses_json_text_reply(self):
        body = {'model': 'm', 'store': False, 'stream': False,
                'input': [{'role': 'user', 'content': 'hello there'}]}
        status, raw = self.post('/openai/v1/responses', body, OPENAI)
        self.assertEqual(status, 200)
        response = json.loads(raw)
        self.assertEqual(response['object'], 'response')
        self.assertTrue(response['id'].startswith('resp_mock'))
        self.assertEqual(response['created_at'], server.FIXED_TIME)
        self.assertEqual(response['status'], 'completed')
        self.assertEqual(response['model'], 'm')
        self.assertEqual(response['output'], [{'type': 'message', 'id': 'msg_mock_0', 'status': 'completed',
                                             'role': 'assistant', 'content': [{'type': 'output_text',
                                             'text': server.reply_text('hello there'), 'annotations': []}]}])
        usage = response['usage']
        self.assertGreater(usage['input_tokens'], 0)
        self.assertGreater(usage['output_tokens'], 0)
        self.assertEqual(usage['total_tokens'], usage['input_tokens'] + usage['output_tokens'])
        last = self.get('/__ai/last')
        self.assertEqual(last['provider'], 'openai-responses')
        self.assertEqual(last['path'], '/openai/v1/responses')
        self.assertEqual(last['body'], body)

    def test_responses_stream_text_reply(self):
        body = {'model': 'm', 'stream': True, 'input': [
            {'role': 'user', 'content': [{'type': 'input_text', 'text': 'hello'},
                                       {'type': 'input_image', 'image_url': 'data:image/png;base64,AA=='},
                                       {'type': 'input_text', 'text': 'there'}]},
            {'role': 'assistant', 'content': 'previous answer'},
        ]}
        status, raw = self.post('/openai/v1/responses', body, OPENAI)
        self.assertEqual(status, 200)
        evs = self.response_events(raw)
        text = server.reply_text('hello there')
        self.assertEqual([e['type'] for e in evs], [
            'response.created', 'response.output_item.added',
            *(['response.output_text.delta'] * len(server.chunks(text))),
            'response.output_text.done', 'response.output_item.done', 'response.completed'])
        self.assertEqual(evs[1]['item']['status'], 'in_progress')
        self.assertEqual(evs[1]['item']['content'], [])
        deltas = [e for e in evs if e['type'] == 'response.output_text.delta']
        self.assertEqual(''.join(e['delta'] for e in deltas), text)
        for e in deltas + [evs[-3]]:
            self.assertEqual((e['item_id'], e['output_index'], e['content_index']), ('msg_mock_0', 0, 0))
        self.assertEqual(evs[-3]['text'], text)
        status, raw = self.post('/openai/v1/responses', {**body, 'stream': False}, OPENAI)
        self.assertEqual(status, 200)
        self.assertEqual(evs[-1]['response'], json.loads(raw))

    def test_responses_stream_tools_then_answers_with_results(self):
        body = {'model': 'mock-gpt-reasoning', 'stream': True, 'tools': TOOLS_R, 'tool_choice': 'auto',
                'instructions': 'Standing: [[mock:lookup]]',
                'input': [{'role': 'user', 'content': 'find it'}]}
        status, raw = self.post('/openai/v1/responses', body, OPENAI)
        self.assertEqual(status, 200)
        evs = self.response_events(raw)
        output = evs[-1]['response']['output']
        self.assertEqual([item['type'] for item in output], ['reasoning', 'message', 'function_call'])
        self.assertEqual(output[0], {'type': 'reasoning', 'id': 'rs_mock_0', 'summary': [], 'encrypted_content': 'enc_mock'})
        self.assertEqual(output[1]['content'][0]['text'], 'Looking.')
        call = output[2]
        self.assertEqual(call, {'type': 'function_call', 'id': 'fc_mock_0_0', 'call_id': 'call_mock_0_0',
                                'name': 'search_mail', 'arguments': json.dumps({'text': 'invoice'}), 'status': 'completed'})
        self.assertEqual([e['output_index'] for e in evs if e['type'] == 'response.output_item.added'], [0, 1, 2])
        call_events = [e for e in evs if e.get('output_index') == 2]
        self.assertEqual([e['type'] for e in call_events], [
            'response.output_item.added',
            *(['response.function_call_arguments.delta'] * len(server.split_json({'text': 'invoice'}))),
            'response.function_call_arguments.done', 'response.output_item.done'])
        self.assertEqual(call_events[0]['item']['arguments'], '')
        args = [e for e in call_events if e['type'] == 'response.function_call_arguments.delta']
        self.assertEqual(''.join(e['delta'] for e in args), call['arguments'])
        self.assertTrue(all(e['item_id'] == call['id'] for e in args))
        self.assertEqual(call_events[-2]['arguments'], call['arguments'])
        status, raw = self.post('/openai/v1/responses', {**body, 'stream': False}, OPENAI)
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(raw), evs[-1]['response'])
        second = body['input'] + output + [{'type': 'function_call_output', 'call_id': call['call_id'], 'output': 'Invoice 42 from Dan'}]
        status, raw = self.post('/openai/v1/responses', {**body, 'stream': False, 'input': second}, OPENAI)
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(raw)['output'][0]['content'][0]['text'], 'Found: Invoice 42 from Dan')
        log = self.get('/__ai/requests?marker=lookup')
        self.assertEqual([r['step'] for r in log], [0, 0, 1])
        self.assertEqual(log[-1]['tools'], ['search_mail'])
        self.assertEqual(log[-1]['body']['input'], second)

    def test_responses_parallel_results_advance_one_step_per_turn(self):
        messages = [{'role': 'user', 'content': 'hi'},
                    {'type': 'function_call', 'call_id': 'a'}, {'type': 'function_call', 'call_id': 'b'},
                    {'type': 'function_call_output', 'call_id': 'a', 'output': 'one'},
                    {'type': 'function_call_output', 'call_id': 'b', 'output': 'two'}]
        self.assertEqual(server.step_of(messages, 'openai-responses'), 1)
        self.assertEqual(server.tool_results(messages, 'openai-responses'), ['one', 'two'])
        messages += [{'type': 'function_call', 'call_id': 'c'},
                     {'type': 'function_call_output', 'call_id': 'c', 'output': 'three'}]
        self.assertEqual(server.step_of(messages, 'openai-responses'), 2)
        messages += [{'role': 'user', 'content': 'new question'}]
        self.assertEqual(server.step_of(messages, 'openai-responses'), 0)
        self.assertEqual(server.tool_results(messages, 'openai-responses'), [])

    def test_responses_auth_validation_and_scripted_errors(self):
        body = {'model': 'm', 'input': [{'role': 'user', 'content': 'hello'}]}
        status, raw = self.post('/openai/v1/responses', body)
        self.assertEqual(status, 401)
        self.assertEqual(json.loads(raw)['error']['code'], 'invalid_api_key')
        for invalid in ({'input': body['input']}, {'model': 'm'}):
            with self.subTest(body=invalid):
                status, raw = self.post('/openai/v1/responses', invalid, OPENAI)
                self.assertEqual(status, 400)
                self.assertEqual(json.loads(raw)['error'], {
                    'message': 'model and input are required', 'type': 'invalid_request_error', 'param': None, 'code': None})
        self.post('/__ai/scripts', {'name': 'busy', 'steps': [
            {'error': {'status': 503, 'type': 'server_error', 'message': 'Busy'}}]})
        for stream in (False, True):
            status, raw = self.post('/openai/v1/responses', {**body, 'stream': stream,
                'input': [{'role': 'user', 'content': '[[mock:busy]]'}]}, OPENAI)
            self.assertEqual(status, 503)
            self.assertEqual(json.loads(raw), {'error': {'message': 'Busy', 'type': 'server_error', 'param': None, 'code': None}})

    def test_openai_reasoning_model_refuses_chat_tools(self):
        body = {'model': 'mock-gpt-reasoning', 'messages': [{'role': 'user', 'content': 'hi'}]}
        status, raw = self.post('/openai/v1/chat/completions', {**body, 'tools': TOOLS_O}, OPENAI)
        self.assertEqual(status, 400)
        self.assertEqual(json.loads(raw), {'error': {
            'message': 'Function tools with reasoning_effort are not supported for mock-gpt-reasoning in /v1/chat/completions. '
                       "To use function tools, use /v1/responses or set reasoning_effort to 'none'.",
            'type': 'invalid_request_error', 'param': 'reasoning_effort', 'code': None}})
        self.assertEqual(self.get('/__ai/last')['body']['tools'], TOOLS_O)
        status, raw = self.post('/openai/v1/chat/completions', body, OPENAI)
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(raw)['choices'][0]['message']['content'], server.reply_text('hi'))
        req = urllib.request.Request(self.base + '/openai/v1/models', headers=OPENAI)
        with urllib.request.urlopen(req, timeout=10) as r:
            self.assertIn('mock-gpt-reasoning', [m['id'] for m in json.loads(r.read())['data']])

    def test_unscripted_requests_still_echo_and_are_logged(self):
        status, raw = self.post('/anthropic/v1/messages', {'model': 'm', 'max_tokens': 9, 'messages': [{'role': 'user', 'content': 'hello there'}]}, ANTHROPIC)
        self.assertIn('You asked: "hello there"', json.loads(raw)['content'][0]['text'])
        last = self.get('/__ai/last')
        self.assertEqual(last['body']['messages'][0]['content'], 'hello there')
        self.post('/__reset', {})
        self.assertEqual(self.get('/__ai/requests'), [])


if __name__ == '__main__':
    unittest.main()
