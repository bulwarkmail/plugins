# Mock APIs

`server.py` is one small Python service (standard library only) that stands in
for the paid or external APIs the plugins talk to. It runs as the `mocks`
compose service on http://localhost:18099 (container `bpt-mocks`, image
`python:3.13.16-alpine`). You can also run it directly:

```
python test-env/mocks/server.py --port 18099
```

Everything is deterministic. Replies don't depend on the clock, and ids are
fixed or counted up from a known start. State (Todoist tasks, 17TRACK
registrations, tracking poll counters) is kept in memory, so restarting the
container resets it, and so does `POST /__reset`.

## Credentials

| API | Header | Valid value | Special values |
| --- | --- | --- | --- |
| Anthropic | `x-api-key` | `test-anthropic-key` | `rate-limited` gives 429 |
| OpenAI-compatible | `Authorization: Bearer ...` | `test-openai-key` | `rate-limited` gives 429 |
| Todoist | `Authorization: Bearer ...` | `test-todoist-token` | |
| 17TRACK | `17token` | `test-17track-token` | |
| DHL | `DHL-API-Key` | `test-dhl-key` | |

Any other value gives 401 in the error shape of the real API. 429 answers carry
`retry-after: 7`.

## Meta routes

| Route | What it does |
| --- | --- |
| `GET /health` | `{"status":"ok"}` |
| `POST /__reset` | Restores the initial Todoist tasks, clears registrations and poll counters |
| `GET /__state` | Number of Todoist tasks, registered tracking numbers, poll counters per API and number |
| `POST /__ai/scripts` | Stores a scripted AI answer: `{"name", "steps"}` (see "Scripted lookups and actions") |
| `GET /__ai/requests` | The last 60 AI requests, whole: `[{at, path, provider, marker, step, tools, body}]`; `?marker=<name>` keeps those of one script |
| `GET /__ai/last` | The last AI request (404 before the first) |

`POST /__reset` also clears the scripts and the request log.

## Anthropic Messages API

`POST /anthropic/v1/messages`

- Needs `x-api-key` and `anthropic-version`. Without `anthropic-version` the
  answer is 400 `invalid_request_error`. The version value is not checked.
- 401 `{"type":"error","error":{"type":"authentication_error",...}}` for a wrong key.
- 429 `rate_limit_error` with `retry-after: 7` for the key `rate-limited`.
- 400 when `model`, `max_tokens` or `messages` is missing.
- The reply text is always
  `Mock reply. You asked: "<first 80 chars of the last user message>". This text comes from the Bulwark test mock.`
  The message id is `msg_mock0000000000000000001`, `stop_reason` is
  `end_turn`, and `usage` counts words.
- With `"stream": true` the answer is `text/event-stream` with the real event
  order: `message_start`, `content_block_start`, `ping`, four
  `content_block_delta` events (`text_delta`), `content_block_stop`,
  `message_delta` (stop reason and output tokens), `message_stop`. Each event
  has an `event:` line and a `data:` line.

## Scripted lookups and actions

A test can make either AI API call tools (lookups and actions) in a fixed
order. Register a script, then put `[[mock:<name>]]` in the message the test
types (or in the admin's standing instructions, which reach the system
prompt, for quick actions with a fixed text):

```json
{ "name": "find-invoice", "steps": [
  { "text": "Looking.", "tools": [{ "name": "search_mail", "input": { "text": "invoice" } }] },
  { "text": "Found: {{tool_results}}" }
] }
```

- The step is the number of tool-calling assistant turns after the typed
  message, so the same history always gets the same step. Past the last step
  the last one repeats; a repeated tool step ends with
  `Mock: script "<name>" has no more steps.`
- A tool step answers with `tool_use` blocks (Anthropic, `stop_reason:
  tool_use`, the input streamed as `input_json_delta` pieces) or
  `tool_calls` (OpenAI, `finish_reason: tool_calls`), streamed or not, with
  ids `toolu_mock_<step>_<i>` / `call_mock_<step>_<i>`.
- A text step may use `{{tool_results}}` (the results sent back in this
  request, one per line) and `{{last_user}}` (the typed message).
- `{"error": {"status", "type", "message"}}` answers with that error;
  `delay_ms` waits before any step, `hang` waits 60 s (Stop tests).
- A tool the request did not offer in `tools` is not called; the answer is
  `Mock: tool "<name>" was not offered.`
- Like the real Anthropic API, a request with `tool_use` or `tool_result`
  blocks but no `tools` gets 400, and so does a `tool_use` without its
  `tool_result` in the next message.
- A message without a marker gets the usual echo (of the last message the
  user typed, not of a tool result).

Tests: `python test-env/mocks/test_server.py`.

## OpenAI-compatible API

- `GET /openai/v1/models` lists `mock-gpt-small` and `mock-gpt-large`.
- `POST /openai/v1/chat/completions` returns a `chat.completion` with the same
  reply text as above (id `chatcmpl-mock0000000000001`, `finish_reason` `stop`).
- With `"stream": true`: `data:` chunks of `chat.completion.chunk`. First the
  role chunk, then four content chunks, then a chunk with
  `finish_reason: "stop"`, then `data: [DONE]`. With
  `"stream_options": {"include_usage": true}` a usage chunk with empty
  `choices` comes before `[DONE]`.
- 401 `{"error":{"code":"invalid_api_key",...}}` for a wrong key, 429
  `rate_limit_exceeded` with `retry-after: 7` for `rate-limited`, 400 when
  `model` or `messages` is missing.

## Todoist API v1

Base: `/todoist/api/v1`. Bodies may be JSON or form-encoded.

| Route | Answer |
| --- | --- |
| `GET /tasks[?project_id=]` | `{"results":[...open tasks...],"next_cursor":null}` |
| `POST /tasks` | Creates a task, returns it. 400 `ARGUMENT_MISSING` without `content` |
| `GET /tasks/{id}` | The task, or 404 |
| `POST /tasks/{id}` | Updates `content`, `description`, `priority`, `labels`, due fields; returns the task |
| `DELETE /tasks/{id}` | 204 |
| `POST /tasks/{id}/close` | 204, the task drops out of `GET /tasks` |
| `POST /tasks/{id}/reopen` | 204 |
| `GET /projects` | `Inbox` (`6Xt00000000inbox`) and `Work` (`6Xt000000000work`) |

Fixed data after a reset:

| id | content | due | priority |
| --- | --- | --- | --- |
| `6Xt0000000000001` | Review the October invoice | 2026-10-20 | 2 |
| `6Xt0000000000002` | Call Carol about the draft | 2026-10-16 | 3 |

New tasks get ids `6Xt0000000000100`, `6Xt0000000000101`, ... Due input:
`due_date` (YYYY-MM-DD), `due_datetime`, or `due_string` (`tomorrow` maps to
2026-10-15, anything else to 2026-10-14). Task objects use the v1 field names
(`checked`, `added_at`, `completed_at`, `updated_at`, `due.string`, ...).

## 17TRACK API v2.2

Base: `/17track/track/v2.2`, header `17token`. Bodies are JSON arrays of
`{"number": "..."}`.

- `POST /register`: known numbers go to `data.accepted`
  (`{"origin":1,"number":...,"carrier":...}`). An unknown number is rejected
  with code `-18019903`, and a number that is already registered with
  `-18019901`.
- `POST /gettrackinfo`: registered numbers go to `data.accepted` with a full
  `track_info` (`latest_status`, `latest_event`, `time_metrics`, `milestone`,
  `misc_info`, `tracking.providers[].events`, newest event first).
  Unregistered numbers are rejected with `-18019902`.
- A wrong token gives HTTP 401 `{"code":401,"data":{"errors":[{"code":-18010002,...}]}}`.

## DHL Shipment Tracking, Unified API

`GET /dhl/track/shipments?trackingNumber=...`, header `DHL-API-Key`.

- 200 `{"shipments":[{id, service, origin, destination, status, details, events}]}`.
  `status.statusCode` is one of `pre-transit`, `transit`, `delivered`,
  `failure`. Events are newest first.
- 404 `application/problem+json` `{"title":"No result found",...}` for
  unknown numbers, for the UPS number and for `NOTFOUND0000000001`.
- 401 `application/problem+json` for a wrong key, 400 without `trackingNumber`.
- No registration step.

## Tracking numbers

| Number | Carrier (17TRACK code) | Status |
| --- | --- | --- |
| `00340434161094042557` | DHL Paket (7041) | InTransit, 3 events (in the seeded shipping mail) |
| `1Z999AA10123456784` | UPS (100002) | Delivered, 3 events (in the seeded shipping mail); not known to the DHL API |
| `LX123456789DE` | DHL Paket (7041) | DeliveryFailure / `failure`, 5 events |
| `JJD000390007878901234` | DHL Paket (7041) | **Changes with every poll**, see below |
| `NOTFOUND0000000001` | DHL Paket (7041) | Registers fine but has no events: `NotFound` on 17TRACK, 404 on DHL |

`JJD000390007878901234` moves on each time it is fetched. 17TRACK counts
`gettrackinfo` calls and DHL counts `GET /shipments` calls, separately:

| Poll | 17TRACK `latest_status.status` | DHL `status.statusCode` | Events |
| --- | --- | --- | --- |
| 1 | InfoReceived | pre-transit | 1 |
| 2 | InTransit | transit | 3 |
| 3 | OutForDelivery | transit | 4 |
| 4 and later | Delivered | delivered | 5 |

`POST /__reset` sets the counters back to zero. `GET /__state` shows them.
