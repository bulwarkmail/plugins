import { describe, it, expect } from 'vitest';
import { fakeApi, proxyResponse } from '../../test-utils/fake-api.mjs';
import {
  adminServer, approveServer, getConnection, startLoginFlow, pollLoginFlow, disconnect,
} from '../src/lib/connection.js';

const ORIGIN = 'https://cloud.example.com';

describe('Login Flow v2 through the proxy', () => {
  it('reads the server the admin fixed', async () => {
    const api = fakeApi({ handlers: { 'config.get': async () => ({ serverUrl: 'cloud.example.com/nextcloud/' }) } });
    expect(await adminServer(api)).toBe(ORIGIN);
    const none = fakeApi({ handlers: { 'config.get': async () => { throw new Error('no'); } } });
    expect(await adminServer(none)).toBeNull();
  });

  it('asks the host to approve the server in sign-in mode, with the fixed server', async () => {
    const api = fakeApi({ handlers: { 'proxy.connect': async () => ({ connected: false, origin: ORIGIN }) } });
    expect(await approveServer(api, { fixedServer: ORIGIN })).toBe(ORIGIN);
    expect(api.calls('proxy.connect')[0].args).toEqual(['nextcloud', { mode: 'signin', server: ORIGIN }]);
  });

  it('refuses and forgets a server other than the fixed one', async () => {
    const api = fakeApi({ handlers: { 'proxy.connect': async () => ({ connected: false, origin: 'https://evil.example' }), 'proxy.disconnect': async () => true } });
    await expect(approveServer(api, { fixedServer: ORIGIN })).rejects.toMatchObject({ code: 'wrong_server' });
    expect(api.calls('proxy.disconnect')).toHaveLength(1);
  });

  it('returns null when the user cancels the host dialog', async () => {
    const api = fakeApi({ handlers: { 'proxy.connect': async () => ({ connected: false }) } });
    expect(await approveServer(api, {})).toBeNull();
  });

  it('starts a flow and checks the poll endpoint stays on the approved server', async () => {
    const answer = { poll: { token: 'tok', endpoint: `${ORIGIN}/login/v2/poll` }, login: `${ORIGIN}/login/v2/flow/abc` };
    const api = fakeApi({ handlers: { 'proxy.fetch': async () => proxyResponse(JSON.stringify(answer)) } });
    expect(await startLoginFlow(api, ORIGIN)).toEqual({ loginUrl: answer.login, endpoint: answer.poll.endpoint, token: 'tok' });
    const [cred, url, init] = api.calls('proxy.fetch')[0].args;
    expect([cred, url, init.method]).toEqual(['nextcloud', `${ORIGIN}/index.php/login/v2`, 'POST']);

    const elsewhere = fakeApi({ handlers: { 'proxy.fetch': async () => proxyResponse(JSON.stringify({ ...answer, poll: { token: 't', endpoint: 'https://other.example/login/v2/poll' } })) } });
    await expect(startLoginFlow(elsewhere, ORIGIN)).rejects.toMatchObject({ code: 'blocked' });
  });

  it('polls with capture until Nextcloud hands out the app password', async () => {
    const answers = [proxyResponse('', { status: 404 }), proxyResponse('', { status: 404 }), proxyResponse({ server: ORIGIN, captured: true })];
    const api = fakeApi({ handlers: { 'proxy.fetch': async () => answers.shift() } });
    const sleeps = [];
    const done = await pollLoginFlow(api, { endpoint: `${ORIGIN}/login/v2/poll`, token: 'a b' }, { sleep: async (ms) => { sleeps.push(ms); } });
    expect(done).toBe(true);
    expect(sleeps).toEqual([2000, 2000]);
    const init = api.calls('proxy.fetch')[0].args[2];
    expect(init).toMatchObject({ method: 'POST', body: 'token=a%20b', capture: { secret: 'appPassword', username: 'loginName' } });
  });

  it('keeps polling when a reverse proxy swaps the 404 answers for an HTML page', async () => {
    const errorPage = '<html><body><h1>404 Not Found</h1></body></html>';
    const answers = [
      { status: 404, body: errorPage },
      { status: 200, body: JSON.stringify({ server: ORIGIN, captured: true }) },
    ];
    // Like the host's proxy client: a JSON answer is parsed there and a
    // body that isn't JSON throws.
    const api = fakeApi({ handlers: { 'proxy.fetch': async (_cred, _url, init) => {
      const { status, body } = answers.shift();
      if (init.responseType === 'json') {
        try { return proxyResponse(JSON.parse(body), { status }); } catch { throw new Error(`Response is not JSON (HTTP ${status})`); }
      }
      return proxyResponse(body, { status });
    } } });
    expect(await pollLoginFlow(api, { endpoint: `${ORIGIN}/login/v2/poll`, token: 't' }, { sleep: async () => {} })).toBe(true);
  });

  it('gives up when the flow expired', async () => {
    let clock = 0;
    const api = fakeApi({ handlers: { 'proxy.fetch': async () => proxyResponse('', { status: 404 }) } });
    await expect(pollLoginFlow(api, { endpoint: `${ORIGIN}/p`, token: 't' }, {
      timeoutMs: 5000, now: () => clock, sleep: async (ms) => { clock += ms; },
    })).rejects.toMatchObject({ code: 'login_expired' });
  });

  it('stops polling when cancelled', async () => {
    const ctrl = new AbortController();
    const api = fakeApi({ handlers: { 'proxy.fetch': async () => proxyResponse('', { status: 404 }) } });
    await expect(pollLoginFlow(api, { endpoint: `${ORIGIN}/p`, token: 't' }, {
      signal: ctrl.signal, sleep: async () => { ctrl.abort(); },
    })).rejects.toMatchObject({ code: 'cancelled' });
  });

  it('fails when the answer had no app password to capture', async () => {
    const api = fakeApi({ handlers: { 'proxy.fetch': async () => proxyResponse({ captured: false }) } });
    await expect(pollLoginFlow(api, { endpoint: `${ORIGIN}/p`, token: 't' }, { sleep: async () => {} })).rejects.toMatchObject({ code: 'bad_answer' });
  });
});

describe('the connection', () => {
  const account = { credentialId: 'nextcloud', origin: ORIGIN, username: 'alice@example.org', connected: true };

  it('is null without a connected account', async () => {
    const api = fakeApi({ handlers: { 'proxy.accounts': async () => [{ ...account, connected: false }] } });
    expect(await getConnection(api, { fixedServer: null })).toBeNull();
  });

  it('looks up the Nextcloud user id once and caches it', async () => {
    const api = fakeApi({ handlers: {
      'proxy.accounts': async () => [account],
      'proxy.fetch': async () => proxyResponse(JSON.stringify({ ocs: { data: { id: 'alice', displayname: 'Alice Example' } } })),
    } });
    const conn = await getConnection(api, { fixedServer: null });
    expect(conn).toEqual({ origin: ORIGIN, username: 'alice@example.org', userId: 'alice', displayName: 'Alice Example' });
    expect(api.calls('proxy.fetch')[0].args[1]).toBe(`${ORIGIN}/ocs/v2.php/cloud/user?format=json`);
    await getConnection(api, { fixedServer: null });
    expect(api.calls('proxy.fetch')).toHaveLength(1);
  });

  it('reports an expired app password', async () => {
    const api = fakeApi({ handlers: { 'proxy.accounts': async () => [account], 'proxy.fetch': async () => proxyResponse('', { status: 401 }) } });
    await expect(getConnection(api, { fixedServer: null })).rejects.toMatchObject({ code: 'auth' });
  });

  it('does not use an account for another server than the fixed one', async () => {
    const api = fakeApi({ handlers: { 'proxy.accounts': async () => [account] } });
    await expect(getConnection(api, { fixedServer: 'https://other.example' })).rejects.toMatchObject({ code: 'wrong_server' });
  });

  it('revokes the app password when disconnecting', async () => {
    const api = fakeApi({ handlers: {
      'proxy.accounts': async () => [account],
      'proxy.fetch': async () => proxyResponse('{}'),
      'proxy.disconnect': async () => true,
    } });
    await disconnect(api);
    const [, url, init] = api.calls('proxy.fetch')[0].args;
    expect([url, init.method]).toEqual([`${ORIGIN}/ocs/v2.php/core/apppassword?format=json`, 'DELETE']);
    expect(api.calls('proxy.disconnect')).toHaveLength(1);
  });
});
