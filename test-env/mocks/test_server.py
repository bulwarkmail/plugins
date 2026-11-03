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

    def test_unscripted_requests_still_echo_and_are_logged(self):
        status, raw = self.post('/anthropic/v1/messages', {'model': 'm', 'max_tokens': 9, 'messages': [{'role': 'user', 'content': 'hello there'}]}, ANTHROPIC)
        self.assertIn('You asked: "hello there"', json.loads(raw)['content'][0]['text'])
        last = self.get('/__ai/last')
        self.assertEqual(last['body']['messages'][0]['content'], 'hello there')
        self.post('/__reset', {})
        self.assertEqual(self.get('/__ai/requests'), [])


if __name__ == '__main__':
    unittest.main()
