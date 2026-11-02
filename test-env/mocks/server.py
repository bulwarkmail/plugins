"""Deterministic mock APIs for the Bulwark plugin tests (standard library only).

    python mocks/server.py [--port 18099]

Routes and fixed data are documented in mocks/README.md. State (Todoist tasks,
tracking registrations and poll counters) lives in memory and can be reset
with POST /__reset.
"""
import argparse
import json
import re
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

ANTHROPIC_KEY = 'test-anthropic-key'
OPENAI_KEY = 'test-openai-key'
RATE_LIMITED_KEY = 'rate-limited'
TODOIST_TOKEN = 'test-todoist-token'
TRACK17_TOKEN = 'test-17track-token'
DHL_KEY = 'test-dhl-key'
RETRY_AFTER = '7'
FIXED_TIME = 1791936000  # 2026-10-14T00:00:00Z, used for created/added timestamps

LOCK = threading.Lock()


# --------------------------------------------------------------------------
# Shared state
# --------------------------------------------------------------------------

def initial_todoist():
    tasks = {}
    for i, (content, due, prio) in enumerate([
        ('Review the October invoice', '2026-10-20', 2),
        ('Call Carol about the draft', '2026-10-16', 3),
    ], 1):
        tid = f'6Xt0000000000{i:03d}'
        tasks[tid] = todoist_task(tid, {'content': content, 'due_date': due, 'priority': prio})
    return {'tasks': tasks, 'next_id': 100}


def todoist_task(tid, body, existing=None):
    t = existing or {
        'id': tid,
        'user_id': '2671355',
        'project_id': '6Xt00000000inbox',
        'section_id': None,
        'parent_id': None,
        'added_by_uid': '2671355',
        'assigned_by_uid': None,
        'responsible_uid': None,
        'labels': [],
        'deadline': None,
        'duration': None,
        'checked': False,
        'is_deleted': False,
        'added_at': '2026-10-14T00:00:00.000000Z',
        'completed_at': None,
        'updated_at': '2026-10-14T00:00:00.000000Z',
        'due': None,
        'priority': 1,
        'child_order': 1,
        'content': '',
        'description': '',
        'note_count': 0,
        'day_order': -1,
        'is_collapsed': False,
    }
    for key in ('content', 'description', 'priority', 'labels', 'project_id', 'section_id', 'parent_id'):
        if key in body:
            t[key] = body[key]
    due_date = body.get('due_date') or (body.get('due_datetime') or '')[:10] or None
    if body.get('due_string') and not due_date:
        due_date = '2026-10-15' if 'tomorrow' in body['due_string'].lower() else '2026-10-14'
    if due_date or body.get('due_string'):
        t['due'] = {
            'date': body.get('due_datetime') or due_date,
            'timezone': None,
            'string': body.get('due_string') or due_date,
            'lang': body.get('due_lang', 'en'),
            'is_recurring': False,
        }
    if 'deadline_date' in body:
        t['deadline'] = {'date': body['deadline_date'], 'lang': 'en'} if body['deadline_date'] else None
    if existing:
        t['updated_at'] = '2026-10-14T00:00:01.000000Z'
    return t


STATE = {}


def reset_state():
    with LOCK:
        STATE.clear()
        STATE['todoist'] = initial_todoist()
        STATE['registered'] = set()
        STATE['polls'] = {}  # (api, number) -> count


reset_state()


# --------------------------------------------------------------------------
# Tracking fixtures
# --------------------------------------------------------------------------

# 17TRACK statuses: NotFound, InfoReceived, InTransit, Expired,
# AvailableForPickup, OutForDelivery, DeliveryFailure, Delivered, Exception.
# DHL statusCode: pre-transit, transit, delivered, failure, unknown.
EV = {
    'info': ('2026-10-10T09:12:00+02:00', 'InfoReceived', 'pre-transit',
             'The shipment data has been received electronically', 'Bonn, DE'),
    'pickup': ('2026-10-10T18:40:00+02:00', 'InTransit', 'transit',
               'The shipment has been picked up', 'Bonn, DE'),
    'hub': ('2026-10-11T03:05:00+02:00', 'InTransit', 'transit',
            'The shipment has been processed in the parcel center', 'Hannover, DE'),
    'out': ('2026-10-12T07:55:00+02:00', 'OutForDelivery', 'transit',
            'The shipment has been loaded onto the delivery vehicle', 'Hildesheim, DE'),
    'delivered': ('2026-10-12T13:21:00+02:00', 'Delivered', 'delivered',
                  'The shipment has been successfully delivered', 'Hildesheim, DE'),
    'failed': ('2026-10-12T14:02:00+02:00', 'DeliveryFailure', 'failure',
               'The recipient was not found at the address. The shipment is returned', 'Hildesheim, DE'),
    'ups_label': ('2026-10-09T11:00:00-04:00', 'InfoReceived', 'pre-transit',
                  'Shipper created a label, UPS has not received the package yet', 'Atlanta, GA, US'),
    'ups_depart': ('2026-10-10T22:10:00-04:00', 'InTransit', 'transit', 'Departed from facility',
                   'Louisville, KY, US'),
    'ups_delivered': ('2026-10-13T12:30:00+02:00', 'Delivered', 'delivered', 'Delivered, front door',
                      'Hildesheim, DE'),
}

# number -> (17TRACK carrier code, carrier name, DHL service, event stages)
TRACKING = {
    '00340434161094042557': (7041, 'DHL Paket', 'parcel-de', [['info', 'pickup', 'hub']]),
    '1Z999AA10123456784': (100002, 'UPS', None, [['ups_label', 'ups_depart', 'ups_delivered']]),
    'LX123456789DE': (7041, 'DHL Paket', 'parcel-de', [['info', 'pickup', 'hub', 'out', 'failed']]),
    # Changes with every poll: InfoReceived, InTransit, OutForDelivery, Delivered (stays).
    'JJD000390007878901234': (7041, 'DHL Paket', 'parcel-de', [
        ['info'],
        ['info', 'pickup', 'hub'],
        ['info', 'pickup', 'hub', 'out'],
        ['info', 'pickup', 'hub', 'out', 'delivered'],
    ]),
    # Registered fine, but the carrier has no data yet.
    'NOTFOUND0000000001': (7041, 'DHL Paket', 'parcel-de', [[]]),
}
CHANGING = 'JJD000390007878901234'


def poll(api, number):
    with LOCK:
        key = (api, number)
        STATE['polls'][key] = STATE['polls'].get(key, 0) + 1
        return STATE['polls'][key]


def stage_events(number, count):
    stages = TRACKING[number][3]
    return [EV[name] for name in stages[min(count, len(stages)) - 1]]


def iso_utc(iso):
    from datetime import datetime, timezone
    return datetime.fromisoformat(iso).astimezone(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')


def track17_info(number, count):
    carrier, name, _, _ = TRACKING[number]
    events = list(reversed(stage_events(number, count)))  # newest first
    status = events[0][1] if events else 'NotFound'
    sub = {'NotFound': 'NotFound_Other', 'InfoReceived': 'InfoReceived', 'InTransit': 'InTransit_Other',
           'OutForDelivery': 'OutForDelivery_Other', 'Delivered': 'Delivered_Other',
           'DeliveryFailure': 'DeliveryFailure_NoBody'}[status]
    ev_json = [{
        'time_iso': e[0],
        'time_utc': iso_utc(e[0]),
        'time_raw': {'date': e[0][:10], 'time': e[0][11:19], 'timezone': e[0][19:]},
        'description': e[3],
        'description_translation': None,
        'location': e[4],
        'stage': e[1],
        'sub_status': {'InfoReceived': 'InfoReceived', 'InTransit': 'InTransit_Other',
                       'OutForDelivery': 'OutForDelivery_Other', 'Delivered': 'Delivered_Other',
                       'DeliveryFailure': 'DeliveryFailure_NoBody'}[e[1]],
        'address': {'country': e[4].split(', ')[-1], 'state': None, 'city': e[4].split(',')[0],
                    'street': None, 'postal_code': None, 'coordinates': {'longitude': None, 'latitude': None}},
    } for e in events]
    latest = ev_json[0] if ev_json else None
    return {
        'number': number,
        'carrier': carrier,
        'param': None,
        'tag': '',
        'track_info': {
            'shipping_info': {
                'shipper_address': {'country': 'DE', 'state': None, 'city': 'Bonn', 'street': None,
                                    'postal_code': None, 'coordinates': {'longitude': None, 'latitude': None}},
                'recipient_address': {'country': 'DE', 'state': None, 'city': 'Hildesheim', 'street': None,
                                      'postal_code': None, 'coordinates': {'longitude': None, 'latitude': None}},
            },
            'latest_status': {'status': status, 'sub_status': sub, 'sub_status_descr': None},
            'latest_event': latest,
            'time_metrics': {
                'days_after_order': 4, 'days_of_transit': 3, 'days_of_transit_done': 3,
                'days_after_last_update': 1,
                'estimated_delivery_date': {'source': 'Official', 'from': '2026-10-12T00:00:00+02:00',
                                            'to': '2026-10-13T00:00:00+02:00'},
            },
            'milestone': [{'key_stage': s, 'time_iso': next((e['time_iso'] for e in reversed(ev_json)
                                                            if e['stage'] == s), None),
                           'time_utc': next((e['time_utc'] for e in reversed(ev_json) if e['stage'] == s), None),
                           'time_raw': {'date': None, 'time': None, 'timezone': None}}
                          for s in ('InfoReceived', 'PickedUp', 'Departure', 'Arrival', 'AvailableForPickup',
                                    'OutForDelivery', 'Delivered', 'Returning', 'Returned')],
            'misc_info': {'risk_factor': 0, 'service_type': 'Paket', 'weight_raw': '1.2 kg',
                          'weight_kg': '1.2', 'pieces': '1', 'dimensions': None, 'customer_number': None,
                          'reference_number': None, 'local_number': None, 'local_provider': None,
                          'local_key': 0},
            'tracking': {
                'providers_hash': 1000 + count,
                'providers': [{
                    'provider': {'key': carrier, 'name': name, 'alias': name, 'tel': None,
                                 'homepage': 'https://www.dhl.de/' if carrier == 7041 else 'https://www.ups.com/',
                                 'country': 'DE' if carrier == 7041 else 'US'},
                    'service_type': None,
                    'latest_sync_status': 'Success',
                    'latest_sync_time': '2026-10-14T00:00:00Z',
                    'events_hash': 2000 + count,
                    'events': ev_json,
                }],
            },
        },
    }


def dhl_shipment(number, count):
    events = list(reversed(stage_events(number, count)))
    if not events:
        return None

    def ev(e):
        return {
            'timestamp': e[0][:19],
            'location': {'address': {'addressLocality': e[4]}},
            'statusCode': e[2],
            'status': e[1],
            'description': e[3],
        }
    return {
        'id': number,
        'service': TRACKING[number][2],
        'origin': {'address': {'countryCode': 'DE', 'postalCode': '53113', 'addressLocality': 'Bonn'}},
        'destination': {'address': {'countryCode': 'DE', 'postalCode': '31134', 'addressLocality': 'Hildesheim'}},
        'status': ev(events[0]),
        'details': {'product': {'productName': 'DHL PAKET'}, 'totalNumberOfPieces': 1,
                    'pieceIds': [number], 'weight': {'value': 1.2, 'unitText': 'kg'}},
        'events': [ev(e) for e in events],
    }


# --------------------------------------------------------------------------
# AI mocks
# --------------------------------------------------------------------------

def last_user_text(messages):
    for m in reversed(messages or []):
        if m.get('role') == 'user':
            c = m.get('content')
            if isinstance(c, str):
                return c
            if isinstance(c, list):
                return ' '.join(p.get('text', '') for p in c if isinstance(p, dict))
    return ''


def reply_text(prompt):
    """Deterministic reply: echoes the start of the prompt."""
    snippet = ' '.join(prompt.split())[:80]
    return f'Mock reply. You asked: "{snippet}". This text comes from the Bulwark test mock.'


def chunks(text, n=4):
    """Split text into n roughly equal pieces (at least 3 deltas for streaming tests)."""
    size = max(1, -(-len(text) // n))
    return [text[i:i + size] for i in range(0, len(text), size)]


def count_tokens(text):
    return max(1, len(text.split()))



# --------------------------------------------------------------------------
# Scripted AI answers (lookups and actions for the e2e tests)
# --------------------------------------------------------------------------
#
# A test registers a script (POST /__ai/scripts {"name", "steps"}) and puts
# [[mock:<name>]] in the message it types (or in the admin's standing
# instructions, which go into the system prompt). Each request is answered
# with the step whose index is the number of tool-calling assistant turns
# after the typed message, so retries and parallel runs stay deterministic.
# A step is one of:
#   {"tools": [{"name", "input"}], "text"?}   call tools (text before them is optional)
#   {"text": "..."}                            the answer; {{tool_results}} and
#                                              {{last_user}} are filled in
#   {"error": {"status", "type", "message"}}   an error answer
#   {"delay_ms": n} or {"hang": true}          added to any step: wait first
# Past the last step the last one repeats. Every AI request is logged.

MARKER = re.compile(r'\[\[mock:([A-Za-z0-9_.-]+)\]\]')
AI_LOG_SIZE = 60


def _anthropic_text(content):
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return ' '.join(p.get('text', '') for p in content if isinstance(p, dict) and p.get('type') == 'text')
    return ''


def _is_tool_results_only(content):
    return isinstance(content, list) and content and all(
        isinstance(p, dict) and p.get('type') == 'tool_result' for p in content)


def typed_index(messages, provider):
    """Index of the last message the user typed (not a tool result)."""
    for i in range(len(messages) - 1, -1, -1):
        m = messages[i]
        if m.get('role') != 'user':
            continue
        if provider == 'anthropic' and _is_tool_results_only(m.get('content')):
            continue
        return i
    return -1


def typed_text(messages, provider):
    i = typed_index(messages, provider)
    if i < 0:
        return ''
    c = messages[i].get('content')
    return _anthropic_text(c) if provider == 'anthropic' else (c if isinstance(c, str) else _anthropic_text(c))


def system_text(body, provider):
    if provider == 'anthropic':
        s = body.get('system')
        return s if isinstance(s, str) else _anthropic_text(s or [])
    return '\n'.join(_anthropic_text(m.get('content')) if not isinstance(m.get('content'), str) else m['content']
                     for m in body.get('messages', []) if m.get('role') == 'system')


def step_of(messages, provider):
    start = typed_index(messages, provider)
    n = 0
    for m in messages[start + 1:]:
        if m.get('role') != 'assistant':
            continue
        if provider == 'anthropic':
            c = m.get('content')
            if isinstance(c, list) and any(isinstance(p, dict) and p.get('type') == 'tool_use' for p in c):
                n += 1
        elif m.get('tool_calls'):
            n += 1
    return n


def tool_results(messages, provider):
    """The tool results the client sent back after the typed message, in order."""
    out = []
    for m in messages[typed_index(messages, provider) + 1:]:
        if provider == 'anthropic' and m.get('role') == 'user' and isinstance(m.get('content'), list):
            for p in m['content']:
                if isinstance(p, dict) and p.get('type') == 'tool_result':
                    c = p.get('content')
                    out.append(c if isinstance(c, str) else _anthropic_text(c))
        elif provider == 'openai' and m.get('role') == 'tool':
            c = m.get('content')
            out.append(c if isinstance(c, str) else _anthropic_text(c))
    return out


def offered_tools(body, provider):
    tools = body.get('tools') or []
    if provider == 'anthropic':
        return [t.get('name') for t in tools if isinstance(t, dict)]
    return [(t.get('function') or {}).get('name') for t in tools if isinstance(t, dict)]


def anthropic_tool_problem(body):
    """What the real API refuses: tool blocks without tools, a tool_use without its result."""
    msgs = body.get('messages') or []
    uses_tools = any(isinstance(m.get('content'), list) and any(
        isinstance(p, dict) and p.get('type') in ('tool_use', 'tool_result') for p in m['content']) for m in msgs)
    if uses_tools and not body.get('tools'):
        return 'Requests which include `tool_use` or `tool_result` blocks must define tools.'
    for i, m in enumerate(msgs):
        if m.get('role') != 'assistant' or not isinstance(m.get('content'), list):
            continue
        ids = [p.get('id') for p in m['content'] if isinstance(p, dict) and p.get('type') == 'tool_use']
        if not ids:
            continue
        nxt = msgs[i + 1] if i + 1 < len(msgs) else None
        got = [p.get('tool_use_id') for p in (nxt or {}).get('content', []) if isinstance(p, dict) and p.get('type') == 'tool_result'] \
            if nxt and isinstance(nxt.get('content'), list) else []
        missing = [x for x in ids if x not in got]
        if missing:
            return f'messages.{i + 1}: `tool_use` ids were found without `tool_result` blocks immediately after: {", ".join(missing)}.'
    return None


def log_ai(path, provider, body, marker, step):
    with LOCK:
        log = STATE.setdefault('ai_log', [])
        log.append({'at': time.time(), 'path': path, 'provider': provider, 'marker': marker,
                    'step': step, 'tools': offered_tools(body, provider), 'body': body})
        del log[:-AI_LOG_SIZE]


def scripted(body, provider):
    """None for the plain echo; else a dict: kind text|tools|error, with what to send."""
    messages = body.get('messages') or []
    found = MARKER.search(typed_text(messages, provider)) or MARKER.search(system_text(body, provider))
    if not found:
        return None
    name = found.group(1)
    step_no = step_of(messages, provider)
    with LOCK:
        script = (STATE.get('ai_scripts') or {}).get(name)
    if not script:
        return {'kind': 'text', 'text': f'Mock: no script "{name}".', 'marker': name, 'step': step_no}
    steps = script.get('steps') or [{'text': ''}]
    step = steps[min(step_no, len(steps) - 1)]
    if step_no >= len(steps) and step.get('tools'):
        # The client came back for more after the last tool step: end the answer.
        return {'kind': 'text', 'text': f'Mock: script "{name}" has no more steps.', 'marker': name, 'step': step_no}
    if step.get('hang'):
        time.sleep(60)
    if step.get('delay_ms'):
        time.sleep(step['delay_ms'] / 1000)
    base = {'marker': name, 'step': step_no}
    if step.get('error'):
        return {**base, 'kind': 'error', 'error': step['error']}
    offered = offered_tools(body, provider)
    if step.get('tools'):
        for t in step['tools']:
            if t.get('name') not in offered:
                return {**base, 'kind': 'text', 'text': f'Mock: tool "{t.get("name")}" was not offered.'}
        return {**base, 'kind': 'tools', 'text': step.get('text', ''), 'tools': step['tools']}
    results = tool_results(messages, provider)
    text = str(step.get('text', ''))
    text = text.replace('{{tool_results}}', '\n'.join(results)).replace('{{last_user}}', typed_text(messages, provider))
    return {**base, 'kind': 'text', 'text': text}


def split_json(value, n=3):
    s = json.dumps(value)
    size = max(1, -(-len(s) // n))
    return [s[i:i + size] for i in range(0, len(s), size)] or ['{}']


# --------------------------------------------------------------------------
# HTTP handler
# --------------------------------------------------------------------------

class Handler(BaseHTTPRequestHandler):
    server_version = 'BulwarkMock/1.0'
    protocol_version = 'HTTP/1.1'

    def log_message(self, fmt, *args):
        print('%s %s' % (self.address_string(), fmt % args), flush=True)

    # -- helpers -----------------------------------------------------------
    def body_json(self):
        raw = self.raw_body
        if not raw:
            return {}
        text = raw.decode('utf-8')
        if text.lstrip()[:1] in ('{', '['):
            return json.loads(text)
        # Todoist also accepts form-encoded bodies.
        return {k: v[0] for k, v in parse_qs(text).items()}

    def send_json(self, status, data, headers=None, ctype='application/json'):
        body = json.dumps(data).encode()
        self.send_response(status)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(body)))
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def send_empty(self, status):
        self.send_response(status)
        self.send_header('Content-Length', '0')
        self.end_headers()

    def start_sse(self):
        self.send_response(200)
        self.send_header('Content-Type', 'text/event-stream; charset=utf-8')
        self.send_header('Cache-Control', 'no-cache')
        self.send_header('Connection', 'close')
        self.end_headers()
        self.close_connection = True

    def sse(self, data, event=None):
        out = ''
        if event:
            out += f'event: {event}\n'
        out += f'data: {data if isinstance(data, str) else json.dumps(data)}\n\n'
        self.wfile.write(out.encode())
        self.wfile.flush()
        time.sleep(0.02)

    def bearer(self):
        auth = self.headers.get('Authorization', '')
        return auth[7:] if auth.startswith('Bearer ') else None

    # -- dispatch ----------------------------------------------------------
    def do_GET(self):
        self.dispatch('GET')

    def do_POST(self):
        self.dispatch('POST')

    def do_DELETE(self):
        self.dispatch('DELETE')

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', '*')
        self.send_header('Content-Length', '0')
        self.end_headers()

    def read_chunked(self):
        body = b''
        while True:
            size = int(self.rfile.readline().split(b';')[0].strip() or b'0', 16)
            if size == 0:
                # Trailer lines end with an empty line.
                while self.rfile.readline() not in (b'\r\n', b'\n', b''):
                    pass
                return body
            body += self.rfile.read(size)
            self.rfile.readline()

    def dispatch(self, method):
        # Always drain the body, so an early error answer does not leave it
        # in the socket for the next keep-alive request.
        # Bodies sent through the webmail's plugin proxy arrive chunked.
        if 'chunked' in (self.headers.get('Transfer-Encoding') or '').lower():
            self.raw_body = self.read_chunked()
        else:
            length = int(self.headers.get('Content-Length') or 0)
            self.raw_body = self.rfile.read(length) if length else b''
        url = urlparse(self.path)
        path = url.path.rstrip('/') or '/'
        query = {k: v[0] for k, v in parse_qs(url.query).items()}
        try:
            for m, pattern, fn in ROUTES:
                match = re.fullmatch(pattern, path)
                if match and m == method:
                    return fn(self, query, *match.groups())
            if any(re.fullmatch(p, path) for _, p, _ in ROUTES):
                return self.send_json(405, {'error': 'method not allowed'})
            self.send_json(404, {'error': 'not found', 'path': path})
        except (ValueError, KeyError) as exc:
            self.send_json(400, {'error': f'bad request: {exc}'})

    # -- meta ---------------------------------------------------------------
    def health(self, q):
        self.send_json(200, {'status': 'ok'})

    def reset(self, q):
        reset_state()
        self.send_json(200, {'status': 'reset'})

    # -- scripted AI ------------------------------------------------------
    def ai_scripts(self, q):
        body = self.body_json()
        name = body.get('name')
        if not isinstance(name, str) or not MARKER.fullmatch(f'[[mock:{name}]]') or not isinstance(body.get('steps'), list):
            return self.send_json(400, {'error': 'name and steps are required'})
        with LOCK:
            STATE.setdefault('ai_scripts', {})[name] = {'steps': body['steps']}
        self.send_json(200, {'status': 'ok', 'name': name})

    def ai_requests(self, q):
        with LOCK:
            log = list(STATE.get('ai_log') or [])
        if q.get('marker'):
            log = [r for r in log if r['marker'] == q['marker']]
        self.send_json(200, log)

    def ai_last(self, q):
        with LOCK:
            log = STATE.get('ai_log') or []
            last = log[-1] if log else None
        self.send_json(200 if last else 404, last or {'error': 'no AI request yet'})

    def state(self, q):
        with LOCK:
            self.send_json(200, {
                'todoistTasks': len(STATE['todoist']['tasks']),
                'registered': sorted(STATE['registered']),
                'polls': {f'{a}:{n}': c for (a, n), c in STATE['polls'].items()},
            })

    # -- Anthropic ------------------------------------------------------------
    def anthropic_messages(self, q):
        key = self.headers.get('x-api-key')
        if not self.headers.get('anthropic-version'):
            return self.send_json(400, {'type': 'error', 'error': {
                'type': 'invalid_request_error', 'message': 'anthropic-version: header is required'}})
        if key == RATE_LIMITED_KEY:
            return self.send_json(429, {'type': 'error', 'error': {
                'type': 'rate_limit_error', 'message': 'Number of request tokens has exceeded your rate limit.'}},
                headers={'retry-after': RETRY_AFTER})
        if key != ANTHROPIC_KEY:
            return self.send_json(401, {'type': 'error', 'error': {
                'type': 'authentication_error', 'message': 'invalid x-api-key'}})
        body = self.body_json()
        if not body.get('model') or not body.get('max_tokens') or not body.get('messages'):
            return self.send_json(400, {'type': 'error', 'error': {
                'type': 'invalid_request_error', 'message': 'model, max_tokens and messages are required'}})
        problem = anthropic_tool_problem(body)
        script = None if problem else scripted(body, 'anthropic')
        log_ai(self.path, 'anthropic', body, script and script['marker'], script and script['step'])
        if problem:
            return self.send_json(400, {'type': 'error', 'error': {'type': 'invalid_request_error', 'message': problem}})
        if script and script['kind'] == 'error':
            err = script['error']
            return self.send_json(int(err.get('status', 500)), {'type': 'error', 'error': {
                'type': err.get('type', 'api_error'), 'message': err.get('message', 'Mock error')}})
        if script and script['kind'] == 'tools':
            return self.anthropic_tools(body, script)
        text = script['text'] if script else reply_text(typed_text(body['messages'], 'anthropic'))
        in_tok = count_tokens(json.dumps(body['messages']) + str(body.get('system', '')))
        out_tok = count_tokens(text)
        msg_id = 'msg_mock0000000000000000001'
        if not body.get('stream'):
            return self.send_json(200, {
                'id': msg_id, 'type': 'message', 'role': 'assistant', 'model': body['model'],
                'content': [{'type': 'text', 'text': text}],
                'stop_reason': 'end_turn', 'stop_sequence': None,
                'usage': {'input_tokens': in_tok, 'output_tokens': out_tok},
            }, headers={'request-id': 'req_mock0001'})
        self.start_sse()
        self.sse({'type': 'message_start', 'message': {
            'id': msg_id, 'type': 'message', 'role': 'assistant', 'model': body['model'], 'content': [],
            'stop_reason': None, 'stop_sequence': None,
            'usage': {'input_tokens': in_tok, 'output_tokens': 1}}}, 'message_start')
        self.sse({'type': 'content_block_start', 'index': 0, 'content_block': {'type': 'text', 'text': ''}},
                 'content_block_start')
        self.sse({'type': 'ping'}, 'ping')
        for piece in chunks(text):
            self.sse({'type': 'content_block_delta', 'index': 0,
                      'delta': {'type': 'text_delta', 'text': piece}}, 'content_block_delta')
        self.sse({'type': 'content_block_stop', 'index': 0}, 'content_block_stop')
        self.sse({'type': 'message_delta', 'delta': {'stop_reason': 'end_turn', 'stop_sequence': None},
                  'usage': {'output_tokens': out_tok}}, 'message_delta')
        self.sse({'type': 'message_stop'}, 'message_stop')

    def anthropic_tools(self, body, script):
        """A scripted turn that calls tools: optional text, then tool_use blocks."""
        msg_id = f'msg_mock_tools_{script["step"]}'
        calls = [{'id': f'toolu_mock_{script["step"]}_{i}', 'name': t['name'], 'input': t.get('input') or {}}
                 for i, t in enumerate(script['tools'])]
        text = script.get('text') or ''
        if not body.get('stream'):
            content = ([{'type': 'text', 'text': text}] if text else []) + [{'type': 'tool_use', **c} for c in calls]
            return self.send_json(200, {
                'id': msg_id, 'type': 'message', 'role': 'assistant', 'model': body['model'], 'content': content,
                'stop_reason': 'tool_use', 'stop_sequence': None, 'usage': {'input_tokens': 10, 'output_tokens': 10},
            })
        self.start_sse()
        self.sse({'type': 'message_start', 'message': {
            'id': msg_id, 'type': 'message', 'role': 'assistant', 'model': body['model'], 'content': [],
            'stop_reason': None, 'stop_sequence': None, 'usage': {'input_tokens': 10, 'output_tokens': 1}}}, 'message_start')
        index = 0
        if text:
            self.sse({'type': 'content_block_start', 'index': 0, 'content_block': {'type': 'text', 'text': ''}}, 'content_block_start')
            self.sse({'type': 'content_block_delta', 'index': 0, 'delta': {'type': 'text_delta', 'text': text}}, 'content_block_delta')
            self.sse({'type': 'content_block_stop', 'index': 0}, 'content_block_stop')
            index = 1
        for c in calls:
            self.sse({'type': 'content_block_start', 'index': index, 'content_block': {
                'type': 'tool_use', 'id': c['id'], 'name': c['name'], 'input': {}}}, 'content_block_start')
            for piece in split_json(c['input']):
                self.sse({'type': 'content_block_delta', 'index': index,
                          'delta': {'type': 'input_json_delta', 'partial_json': piece}}, 'content_block_delta')
            self.sse({'type': 'content_block_stop', 'index': index}, 'content_block_stop')
            index += 1
        self.sse({'type': 'message_delta', 'delta': {'stop_reason': 'tool_use', 'stop_sequence': None},
                  'usage': {'output_tokens': 10}}, 'message_delta')
        self.sse({'type': 'message_stop'}, 'message_stop')

    # -- OpenAI-compatible -------------------------------------------------
    def openai_auth(self):
        key = self.bearer()
        if key == RATE_LIMITED_KEY:
            self.send_json(429, {'error': {
                'message': 'Rate limit reached for requests', 'type': 'requests',
                'param': None, 'code': 'rate_limit_exceeded'}}, headers={'retry-after': RETRY_AFTER})
            return False
        if key != OPENAI_KEY:
            self.send_json(401, {'error': {
                'message': 'Incorrect API key provided.', 'type': 'invalid_request_error',
                'param': None, 'code': 'invalid_api_key'}})
            return False
        return True

    def openai_models(self, q):
        if not self.openai_auth():
            return
        self.send_json(200, {'object': 'list', 'data': [
            {'id': m, 'object': 'model', 'created': FIXED_TIME, 'owned_by': 'bulwark-mock'}
            for m in ('mock-gpt-small', 'mock-gpt-large')]})

    def openai_chat(self, q):
        if not self.openai_auth():
            return
        body = self.body_json()
        if not body.get('model') or not body.get('messages'):
            return self.send_json(400, {'error': {
                'message': 'model and messages are required', 'type': 'invalid_request_error',
                'param': None, 'code': None}})
        script = scripted(body, 'openai')
        log_ai(self.path, 'openai', body, script and script['marker'], script and script['step'])
        if script and script['kind'] == 'error':
            err = script['error']
            return self.send_json(int(err.get('status', 500)), {'error': {
                'message': err.get('message', 'Mock error'), 'type': err.get('type', 'server_error'), 'param': None, 'code': None}})
        if script and script['kind'] == 'tools':
            return self.openai_tools(body, script)
        text = script['text'] if script else reply_text(typed_text(body['messages'], 'openai'))
        cid = 'chatcmpl-mock0000000000001'
        usage = {'prompt_tokens': count_tokens(json.dumps(body['messages'])),
                 'completion_tokens': count_tokens(text)}
        usage['total_tokens'] = usage['prompt_tokens'] + usage['completion_tokens']
        if not body.get('stream'):
            return self.send_json(200, {
                'id': cid, 'object': 'chat.completion', 'created': FIXED_TIME, 'model': body['model'],
                'system_fingerprint': 'fp_mock',
                'choices': [{'index': 0, 'message': {'role': 'assistant', 'content': text, 'refusal': None},
                             'logprobs': None, 'finish_reason': 'stop'}],
                'usage': usage,
            })
        self.start_sse()

        def chunk(delta, finish=None):
            return {'id': cid, 'object': 'chat.completion.chunk', 'created': FIXED_TIME,
                    'model': body['model'], 'system_fingerprint': 'fp_mock',
                    'choices': [{'index': 0, 'delta': delta, 'logprobs': None, 'finish_reason': finish}]}
        self.sse(chunk({'role': 'assistant', 'content': ''}))
        for piece in chunks(text):
            self.sse(chunk({'content': piece}))
        self.sse(chunk({}, 'stop'))
        if (body.get('stream_options') or {}).get('include_usage'):
            self.sse({'id': cid, 'object': 'chat.completion.chunk', 'created': FIXED_TIME,
                      'model': body['model'], 'choices': [], 'usage': usage})
        self.sse('[DONE]')

    def openai_tools(self, body, script):
        """A scripted turn that calls tools, as tool_calls."""
        cid = f'chatcmpl-mock-tools-{script["step"]}'
        calls = [{'id': f'call_mock_{script["step"]}_{i}', 'type': 'function',
                  'function': {'name': t['name'], 'arguments': json.dumps(t.get('input') or {})}}
                 for i, t in enumerate(script['tools'])]
        text = script.get('text') or None
        if not body.get('stream'):
            return self.send_json(200, {
                'id': cid, 'object': 'chat.completion', 'created': FIXED_TIME, 'model': body['model'],
                'choices': [{'index': 0, 'message': {'role': 'assistant', 'content': text, 'tool_calls': calls},
                             'logprobs': None, 'finish_reason': 'tool_calls'}],
                'usage': {'prompt_tokens': 10, 'completion_tokens': 10, 'total_tokens': 20},
            })
        self.start_sse()

        def chunk(delta, finish=None):
            return {'id': cid, 'object': 'chat.completion.chunk', 'created': FIXED_TIME, 'model': body['model'],
                    'choices': [{'index': 0, 'delta': delta, 'logprobs': None, 'finish_reason': finish}]}
        self.sse(chunk({'role': 'assistant', 'content': text}))
        for i, c in enumerate(calls):
            self.sse(chunk({'tool_calls': [{'index': i, 'id': c['id'], 'type': 'function',
                                            'function': {'name': c['function']['name'], 'arguments': ''}}]}))
            for piece in split_json(json.loads(c['function']['arguments'])):
                self.sse(chunk({'tool_calls': [{'index': i, 'function': {'arguments': piece}}]}))
        self.sse(chunk({}, 'tool_calls'))
        self.sse('[DONE]')

    # -- Todoist API v1 ----------------------------------------------------
    def todoist_auth(self):
        if self.bearer() != TODOIST_TOKEN:
            self.send_json(401, {'error': 'Unauthorized', 'error_code': 401, 'http_code': 401,
                                 'error_tag': 'AUTH_INVALID_TOKEN', 'error_extra': {}})
            return False
        return True

    def todoist_list(self, q):
        if not self.todoist_auth():
            return
        with LOCK:
            tasks = [t for t in STATE['todoist']['tasks'].values() if not t['checked']]
        if q.get('project_id'):
            tasks = [t for t in tasks if t['project_id'] == q['project_id']]
        self.send_json(200, {'results': tasks, 'next_cursor': None})

    def todoist_create(self, q):
        if not self.todoist_auth():
            return
        body = self.body_json()
        if not body.get('content'):
            return self.send_json(400, {'error': 'Required argument is missing', 'error_code': 19,
                                        'http_code': 400, 'error_tag': 'ARGUMENT_MISSING',
                                        'error_extra': {'argument': 'content'}})
        with LOCK:
            st = STATE['todoist']
            tid = f'6Xt0000000000{st["next_id"]:03d}'
            st['next_id'] += 1
            st['tasks'][tid] = todoist_task(tid, body)
            task = st['tasks'][tid]
        self.send_json(200, task)

    def todoist_task_route(self, q, tid):
        if not self.todoist_auth():
            return
        with LOCK:
            task = STATE['todoist']['tasks'].get(tid)
        if not task:
            return self.send_json(404, {'error': 'Task not found', 'error_code': 478, 'http_code': 404,
                                        'error_tag': 'NOT_FOUND', 'error_extra': {}})
        if self.command == 'GET':
            return self.send_json(200, task)
        if self.command == 'DELETE':
            with LOCK:
                STATE['todoist']['tasks'].pop(tid, None)
            return self.send_empty(204)
        body = self.body_json()
        with LOCK:
            todoist_task(tid, body, existing=task)
        self.send_json(200, task)

    def todoist_close(self, q, tid):
        self.todoist_set_checked(tid, True)

    def todoist_reopen(self, q, tid):
        self.todoist_set_checked(tid, False)

    def todoist_set_checked(self, tid, checked):
        if not self.todoist_auth():
            return
        with LOCK:
            task = STATE['todoist']['tasks'].get(tid)
            if task:
                task['checked'] = checked
                task['completed_at'] = '2026-10-14T00:00:02.000000Z' if checked else None
        if not task:
            return self.send_json(404, {'error': 'Task not found', 'error_code': 478, 'http_code': 404,
                                        'error_tag': 'NOT_FOUND', 'error_extra': {}})
        self.send_empty(204)

    def todoist_projects(self, q):
        if not self.todoist_auth():
            return
        self.send_json(200, {'results': [
            {'id': '6Xt00000000inbox', 'name': 'Inbox', 'inbox_project': True, 'color': 'grey',
             'is_favorite': False, 'is_shared': False, 'view_style': 'list', 'parent_id': None,
             'child_order': 0, 'is_archived': False, 'is_deleted': False},
            {'id': '6Xt000000000work', 'name': 'Work', 'inbox_project': False, 'color': 'blue',
             'is_favorite': True, 'is_shared': False, 'view_style': 'list', 'parent_id': None,
             'child_order': 1, 'is_archived': False, 'is_deleted': False},
        ], 'next_cursor': None})

    # -- 17TRACK v2.2 ------------------------------------------------------
    def track17_auth(self):
        if self.headers.get('17token') != TRACK17_TOKEN:
            self.send_json(401, {'code': 401, 'data': {'errors': [
                {'code': -18010002, 'message': 'The access token is invalid.'}]}})
            return False
        return True

    def track17_numbers(self):
        body = self.body_json()
        if not isinstance(body, list):
            raise ValueError('body must be a JSON array')
        return body

    def track17_register(self, q):
        if not self.track17_auth():
            return
        accepted, rejected = [], []
        for item in self.track17_numbers():
            number = item.get('number', '')
            if number not in TRACKING:
                rejected.append({'number': number, 'error': {
                    'code': -18019903, 'message': 'The carrier cannot be detected for this tracking number.'}})
                continue
            with LOCK:
                already = number in STATE['registered']
                STATE['registered'].add(number)
            if already:
                rejected.append({'number': number, 'error': {
                    'code': -18019901, 'message': f'The tracking number \'{number}\' has been registered, '
                                                  'don\'t need to repeat registration.'}})
            else:
                accepted.append({'origin': 1, 'number': number, 'carrier': TRACKING[number][0]})
        self.send_json(200, {'code': 0, 'data': {'accepted': accepted, 'rejected': rejected}})

    def track17_info(self, q):
        if not self.track17_auth():
            return
        accepted, rejected = [], []
        for item in self.track17_numbers():
            number = item.get('number', '')
            with LOCK:
                registered = number in STATE['registered']
            if not registered:
                rejected.append({'number': number, 'error': {
                    'code': -18019902, 'message': f'The tracking number \'{number}\' does not register, '
                                                  'please register first.'}})
                continue
            accepted.append(track17_info(number, poll('17track', number)))
        self.send_json(200, {'code': 0, 'data': {'accepted': accepted, 'rejected': rejected}})

    # -- DHL Shipment Tracking - Unified ----------------------------------
    def dhl_track(self, q):
        if self.headers.get('DHL-API-Key') != DHL_KEY:
            return self.send_json(401, {'title': 'Unauthorized', 'status': 401,
                                        'detail': 'Invalid API key.'}, ctype='application/problem+json')
        number = q.get('trackingNumber')
        if not number:
            return self.send_json(400, {'title': 'Bad Request', 'status': 400,
                                        'detail': 'trackingNumber is required.'}, ctype='application/problem+json')
        shipment = None
        if number in TRACKING and TRACKING[number][2]:
            shipment = dhl_shipment(number, poll('dhl', number))
        if not shipment:
            return self.send_json(404, {'title': 'No result found', 'status': 404,
                                        'detail': 'No shipment with given tracking number found.'},
                                  ctype='application/problem+json')
        self.send_json(200, {'shipments': [shipment], 'possibleAdditionalShipmentsUrl': []})


ROUTES = [
    ('GET', r'/health', Handler.health),
    ('POST', r'/__reset', Handler.reset),
    ('GET', r'/__state', Handler.state),
    ('POST', r'/__ai/scripts', Handler.ai_scripts),
    ('GET', r'/__ai/requests', Handler.ai_requests),
    ('GET', r'/__ai/last', Handler.ai_last),
    ('POST', r'/anthropic/v1/messages', Handler.anthropic_messages),
    ('GET', r'/openai/v1/models', Handler.openai_models),
    ('POST', r'/openai/v1/chat/completions', Handler.openai_chat),
    ('GET', r'/todoist/api/v1/tasks', Handler.todoist_list),
    ('POST', r'/todoist/api/v1/tasks', Handler.todoist_create),
    ('GET', r'/todoist/api/v1/tasks/([A-Za-z0-9]+)', Handler.todoist_task_route),
    ('POST', r'/todoist/api/v1/tasks/([A-Za-z0-9]+)', Handler.todoist_task_route),
    ('DELETE', r'/todoist/api/v1/tasks/([A-Za-z0-9]+)', Handler.todoist_task_route),
    ('POST', r'/todoist/api/v1/tasks/([A-Za-z0-9]+)/close', Handler.todoist_close),
    ('POST', r'/todoist/api/v1/tasks/([A-Za-z0-9]+)/reopen', Handler.todoist_reopen),
    ('GET', r'/todoist/api/v1/projects', Handler.todoist_projects),
    ('POST', r'/17track/track/v2\.2/register', Handler.track17_register),
    ('POST', r'/17track/track/v2\.2/gettrackinfo', Handler.track17_info),
    ('GET', r'/dhl/track/shipments', Handler.dhl_track),
]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--host', default='0.0.0.0')
    ap.add_argument('--port', type=int, default=18099)
    args = ap.parse_args()
    server = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f'mock server listening on {args.host}:{args.port}', flush=True)
    server.serve_forever()


if __name__ == '__main__':
    main()
