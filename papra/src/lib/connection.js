// Which Papra to talk to, and in which organization. Each user connects
// their own API key in the host's "Connect" dialog; the administrator may
// set the server address so users don't have to type it.

import { createClient, normalizeBase } from './client.js';
import { PapraError, toPapraError } from './errors.js';

export const PERSONAL = 'personal';
/** The organization the user last picked; it follows the account to other browsers. */
export const ORGANIZATION_KEY = 'organization';

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
    const base = configured && new URL(configured).origin === mine.origin ? configured : normalizeBase(mine.origin);
    return { state: 'connected', base, credentialId: PERSONAL };
  }
  return { state: 'disconnected', suggestedServer: configured };
}

/** A client for a connected state. */
export function clientFor(api, connection) {
  if (!connection || connection.state !== 'connected') throw new PapraError('error.not_connected');
  return createClient({ proxyFetch: (...a) => api.proxy.fetch(...a), credentialId: connection.credentialId, base: connection.base });
}

/** Open the host's dialog to connect an API key, then check it works. */
export async function connectPersonal(api, suggestedServer) {
  const result = await api.proxy.connect(PERSONAL, { mode: 'password', ...(suggestedServer ? { server: suggestedServer } : {}) });
  if (!result?.connected) return { connected: false };
  const connection = await resolveConnection(api);
  if (connection.state !== 'connected') return { connected: false };
  try {
    await clientFor(api, connection).organizations();
  } catch (err) {
    const e = toPapraError(err);
    // A wrong key is not worth keeping: the next try starts clean.
    if (e.key === 'error.token' || e.key === 'error.not_papra') await api.proxy.disconnect(PERSONAL).catch(() => {});
    return { connected: false, error: e };
  }
  return { connected: true, connection };
}

/** The organization to use: the one picked last when it is still there, else the first. */
export function chooseOrganization(organizations, stored) {
  if (!organizations.length) return '';
  return organizations.some((o) => o.id === stored) ? stored : organizations[0].id;
}

export async function storedOrganization(api) {
  try {
    const value = await api.storage.get(ORGANIZATION_KEY);
    return typeof value === 'string' ? value : '';
  } catch {
    return '';
  }
}

export async function rememberOrganization(api, id) {
  try {
    await api.storage.set(ORGANIZATION_KEY, id, { sync: true });
  } catch { /* storage blocked: the first one is used next time */ }
}
