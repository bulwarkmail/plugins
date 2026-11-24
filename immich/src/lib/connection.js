// Which Immich to talk to. Each user connects their own API key in the
// host's "Connect" dialog; the administrator may set the server address so
// users don't have to type it.

import { createClient, normalizeBase } from './client.js';
import { ImmichError, toImmichError } from './errors.js';

export const PERSONAL = 'personal';

/** The admin's server URL (a non-secret config field), or ''. */
export async function adminServer(api) {
  try {
    return normalizeBase(await api.admin.getConfig('serverUrl'));
  } catch {
    return '';
  }
}

/**
 * @returns {Promise<{ state: 'connected', base: string, credentialId: string }
 *   | { state: 'disconnected', suggestedServer: string }>}
 */
export async function resolveConnection(api) {
  const configured = await adminServer(api);
  let accounts = [];
  try {
    accounts = (await api.proxy.accounts()) || [];
  } catch {
    accounts = [];
  }
  const mine = accounts.find((a) => a && a.credentialId === PERSONAL && a.connected);
  if (mine) {
    // Keep the admin's path (Immich under /photos) when it is the same server.
    const base = configured && new URL(configured).origin === mine.origin ? configured : normalizeBase(mine.origin);
    return { state: 'connected', base, credentialId: PERSONAL };
  }
  return { state: 'disconnected', suggestedServer: configured };
}

/** A client for a connected state. */
export function clientFor(api, connection) {
  if (!connection || connection.state !== 'connected') throw new ImmichError('error.not_connected');
  return createClient({ proxyFetch: (...a) => api.proxy.fetch(...a), credentialId: connection.credentialId, base: connection.base });
}

/** Open the host's dialog to connect an API key, then check it works. */
export async function connectPersonal(api, suggestedServer) {
  const result = await api.proxy.connect(PERSONAL, { mode: 'password', ...(suggestedServer ? { server: suggestedServer } : {}) });
  if (!result?.connected) return { connected: false };
  const connection = await resolveConnection(api);
  if (connection.state !== 'connected') return { connected: false };
  try {
    await clientFor(api, connection).whoAmI();
  } catch (err) {
    const e = toImmichError(err);
    // A wrong key is not worth keeping: the next try starts clean.
    if (e.key === 'error.token' || e.key === 'error.not_immich') await api.proxy.disconnect(PERSONAL).catch(() => {});
    return { connected: false, error: e };
  }
  return { connected: true, connection };
}
