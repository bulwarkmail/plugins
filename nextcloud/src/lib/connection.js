// Connecting a Nextcloud account with Login Flow v2, through the secret
// proxy: the host's dialog approves the server, Nextcloud hands out an app
// password after the user approves in their browser, and the proxy stores it
// straight away (capture) without the plugin ever seeing it.

import { CREDENTIAL, ncRequest, ocs } from './client.js';
import { NcError } from './errors.js';
import { originOf } from './paths.js';

export const POLL_INTERVAL_MS = 2000;
/** Nextcloud keeps a login flow open for 20 minutes. */
export const POLL_TIMEOUT_MS = 20 * 60 * 1000;

/**
 * The server the administrator fixed (configSchema serverUrl), as an origin,
 * or null. api.config.get returns the plugin's non-secret admin settings
 * without the admin:config permission.
 */
export async function adminServer(api) {
  try {
    const config = await api.config.get();
    return originOf(config?.serverUrl) ?? null;
  } catch {
    return null;
  }
}

/** The stored account for this plugin, connected or not, or null. */
export async function storedAccount(api) {
  let list;
  try {
    list = await api.proxy.accounts();
  } catch {
    return null;
  }
  const account = Array.isArray(list) ? list.find((a) => a.credentialId === CREDENTIAL) : null;
  return account ?? null;
}

function userKey(origin, username) {
  return `user:${origin}:${username ?? ''}`;
}

/**
 * The connection to use, or null when there is none. Throws NcError
 * "wrong_server" when the account is for a server other than the one the
 * administrator fixed, and the errors of the user lookup.
 */
export async function getConnection(api, { fixedServer } = {}) {
  const account = await storedAccount(api);
  if (!account || !account.connected) return null;
  const fixed = fixedServer === undefined ? await adminServer(api) : fixedServer;
  if (fixed && account.origin !== fixed) throw new NcError('wrong_server');
  const key = userKey(account.origin, account.username);
  const cached = await api.storage.get(key);
  if (cached && typeof cached.userId === 'string' && cached.userId) {
    return { origin: account.origin, username: account.username ?? '', userId: cached.userId, displayName: cached.displayName ?? '' };
  }
  const data = await ocs(api, account.origin, '/ocs/v2.php/cloud/user');
  const userId = typeof data?.id === 'string' && data.id ? data.id : account.username;
  if (!userId) throw new NcError('bad_answer');
  const displayName = typeof data?.displayname === 'string' ? data.displayname : (data?.['display-name'] ?? '');
  await api.storage.set(key, { userId, displayName });
  return { origin: account.origin, username: account.username ?? '', userId, displayName };
}

/**
 * Step 1: the host's dialog, where the user approves the server. Returns the
 * approved origin, or null when they cancelled.
 */
export async function approveServer(api, { fixedServer, suggestedServer } = {}) {
  const server = fixedServer || suggestedServer || undefined;
  const result = await api.proxy.connect(CREDENTIAL, { mode: 'signin', ...(server ? { server } : {}) });
  const origin = result?.origin ? originOf(result.origin) : null;
  if (!origin) return null;
  if (fixedServer && origin !== fixedServer) {
    await api.proxy.disconnect(CREDENTIAL).catch(() => {});
    throw new NcError('wrong_server');
  }
  return origin;
}

/** Step 2: open a login flow on the server. */
export async function startLoginFlow(api, origin) {
  const res = await ncRequest(api, `${origin}/index.php/login/v2`, { method: 'POST', responseType: 'text' });
  let data;
  try { data = JSON.parse(String(res.body)); } catch { throw new NcError('bad_answer', { detail: 'login/v2' }); }
  const loginUrl = data?.login;
  const endpoint = data?.poll?.endpoint;
  const token = data?.poll?.token;
  if (typeof loginUrl !== 'string' || typeof endpoint !== 'string' || typeof token !== 'string' || !token) {
    throw new NcError('bad_answer', { detail: 'login/v2' });
  }
  if (originOf(loginUrl) === null) throw new NcError('bad_answer', { detail: 'login url' });
  // The proxy only sends the poll to the approved server. A Nextcloud whose
  // overwrite settings name another address can't finish the flow.
  if (originOf(endpoint) !== origin) throw new NcError('blocked', { detail: endpoint });
  return { loginUrl, endpoint, token };
}

const sleepFor = (ms, signal) => new Promise((resolve, reject) => {
  const timer = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(timer); reject(new NcError('cancelled')); }, { once: true });
});

/**
 * Step 3: wait until the user approved the app in Nextcloud. The proxy keeps
 * the app password; resolves once it did. The answers are read as text:
 * Nextcloud says "not yet" with a 404, and a reverse proxy in front of the
 * webmail may swap that answer's body for its own HTML error page.
 */
export async function pollLoginFlow(api, { endpoint, token }, { signal, intervalMs = POLL_INTERVAL_MS, timeoutMs = POLL_TIMEOUT_MS, sleep = sleepFor, now = Date.now } = {}) {
  const started = now();
  for (;;) {
    if (signal?.aborted) throw new NcError('cancelled');
    const res = await ncRequest(api, endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `token=${encodeURIComponent(token)}`,
      responseType: 'text',
      capture: { secret: 'appPassword', username: 'loginName' },
      signal,
    }, { accept: [404] });
    if (res.status === 200) {
      let data = res.body;
      if (typeof data === 'string') {
        try { data = JSON.parse(data); } catch { data = null; }
      }
      if (data?.captured) return true;
      throw new NcError('bad_answer', { detail: 'no app password' });
    }
    if (now() - started > timeoutMs) throw new NcError('login_expired');
    await sleep(intervalMs, signal);
  }
}

/** Forget the account here and revoke its app password on the server. */
export async function disconnect(api) {
  const account = await storedAccount(api);
  if (account?.connected) {
    // Best effort: an expired password can't revoke itself.
    await ocs(api, account.origin, '/ocs/v2.php/core/apppassword', { method: 'DELETE' }).catch(() => {});
  }
  if (account) await api.storage.remove(userKey(account.origin, account.username)).catch(() => {});
  await api.proxy.disconnect(CREDENTIAL);
}
