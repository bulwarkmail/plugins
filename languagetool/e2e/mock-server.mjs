// A LanguageTool stand-in for the end-to-end tests: node http, no
// dependencies. Start it from a spec (startMock) or on its own:
//
//   node languagetool/e2e/mock-server.mjs 18110
//
// POST /v2/check reads the form like LanguageTool (`text` or `data` with
// markup) and answers from the recorded fixtures in fixtures/: every place
// a fixture's sentence occurs in the text gets that fixture's matches,
// with offsets counted in the whole string, markup included. GET
// /v2/languages answers the recorded language list. GET /requests lists
// the form parameters of every check so far (DELETE /requests clears it),
// so a spec can see what the webmail's proxy sent.

import http from 'node:http';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readForm } from '../test/lt-mock.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name) => JSON.parse(readFileSync(path.join(HERE, 'fixtures', name), 'utf8'));

export const FIXTURES = [fixture('de-DE.json'), fixture('en-US.json')];
const LANGUAGES = fixture('languages.json');

/** The /v2/check answer for a form body. */
export function check(body) {
  const { params, full } = readForm(body);
  const matches = [];
  let language = null;
  for (const f of FIXTURES) {
    for (let at = full.indexOf(f._text); at >= 0; at = full.indexOf(f._text, at + 1)) {
      language ??= f.language;
      for (const m of f.matches) matches.push({ ...m, offset: m.offset + at, context: { text: full, offset: m.offset + at, length: m.length } });
    }
  }
  const disabled = new Set(String(params.disabledRules ?? '').split(',').filter(Boolean));
  const kept = matches.filter((m) => !disabled.has(m.rule.id)).sort((a, b) => a.offset - b.offset);
  return { ...FIXTURES[1], _note: undefined, _text: undefined, language: language ?? FIXTURES[1].language, matches: kept };
}

export function startMock(port = 18110, host = '0.0.0.0') {
  const requests = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://mock');
    const send = (status, body, type = 'application/json') => {
      res.writeHead(status, { 'content-type': type });
      res.end(typeof body === 'string' ? body : JSON.stringify(body));
    };
    if (url.pathname === '/requests') {
      if (req.method === 'DELETE') requests.length = 0;
      send(200, requests);
      return;
    }
    if (url.pathname === '/v2/languages') { send(200, LANGUAGES); return; }
    if (url.pathname !== '/v2/check') { send(404, 'Not found', 'text/plain'); return; }
    if (req.method !== 'POST') { send(405, 'Error: use POST', 'text/plain'); return; }
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      const { params, full } = readForm(body);
      requests.push({ ...params, full, authorization: req.headers.authorization ?? null });
      if (params.language !== 'auto' && params.preferredVariants) {
        send(400, "Error: You specified 'preferredVariants' but you didn't specify 'language=auto'", 'text/plain');
        return;
      }
      send(200, check(body));
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve({ server, requests, close: () => new Promise((r) => server.close(() => r())) }));
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const port = Number(process.argv[2]) || 18110;
  await startMock(port);
  console.log(`LanguageTool mock on http://localhost:${port}`);
}
