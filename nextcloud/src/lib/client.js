// Talks to the user's Nextcloud through the webmail's secret proxy. The
// proxy adds the app password; this code never sees it.

import { NcError, errorFromException, errorFromResponse } from './errors.js';
import { PROPFIND_BODY, parseMultistatus, searchBody, sortEntries, toEntry } from './webdav.js';
import { baseName, davFilesUrl, joinPath, normalizePath, parentPath } from './paths.js';

export const CREDENTIAL = 'nextcloud';
/** Largest download taken in one piece; bigger ones are streamed. */
export const BUFFERED_LIMIT = 24 * 1024 * 1024;

const OCS_HEADERS = { 'OCS-APIRequest': 'true', Accept: 'application/json' };

/** Low-level request: throws NcError, returns the proxy result when it went through. */
export async function ncRequest(api, url, init = {}, { kind, accept = [] } = {}) {
  let res;
  try {
    res = await api.proxy.fetch(CREDENTIAL, url, init);
  } catch (err) {
    throw errorFromException(err, init.signal);
  }
  if (init.signal?.aborted) throw new NcError('cancelled');
  if (res && accept.includes(res.status) && !res.proxyError) return res;
  const err = errorFromResponse(res, { kind });
  if (err) throw err;
  return res;
}

function parseJson(body) {
  if (body && typeof body === 'object') return body;
  try { return JSON.parse(String(body ?? '')); } catch { throw new NcError('bad_answer'); }
}

/** OCS call with JSON answer; returns ocs.data. */
export async function ocs(api, origin, path, init = {}, opts = {}) {
  const sep = path.includes('?') ? '&' : '?';
  const res = await ncRequest(api, `${origin}${path}${sep}format=json`, {
    ...init,
    headers: { ...OCS_HEADERS, ...(init.headers ?? {}) },
    responseType: 'text',
  }, opts);
  return parseJson(res.body)?.ocs?.data;
}

/**
 * A client for one connection: { origin, userId }.
 */
export function createClient(api, conn) {
  const { origin, userId } = conn;
  const fileUrl = (path) => davFilesUrl(origin, userId, path);

  async function propfind(path, depth = 1) {
    const res = await ncRequest(api, fileUrl(path), {
      method: 'PROPFIND',
      headers: { Depth: String(depth), 'Content-Type': 'application/xml; charset=utf-8' },
      body: PROPFIND_BODY,
      responseType: 'text',
    });
    return parseMultistatus(res.body).map((r) => toEntry(r, userId)).filter(Boolean);
  }

  const client = {
    origin,
    userId,

    /** The files and folders in `path`, folders first. */
    async list(path, locale) {
      const self = normalizePath(path);
      const entries = await propfind(self, 1);
      return sortEntries(entries.filter((e) => e.path !== self), locale);
    },

    /** One file or folder, or null when there is none. */
    async stat(path) {
      try {
        const [entry] = await propfind(path, 0);
        return entry ?? null;
      } catch (err) {
        if (err instanceof NcError && err.code === 'not_found') return null;
        throw err;
      }
    },

    async search(query, { limit = 50, signal } = {}) {
      const q = String(query ?? '').trim();
      if (!q) return [];
      return runSearch({ query: q, limit, signal });
    },

    async recent({ limit = 50, signal } = {}) {
      return runSearch({ recent: true, limit, signal });
    },

    /** Create a folder; an existing one is fine. */
    async mkdir(path) {
      await ncRequest(api, fileUrl(path), { method: 'MKCOL' }, { accept: [405] });
    },

    /** Create a folder and its parents. */
    async mkdirp(path) {
      const p = normalizePath(path);
      if (p === '/') return;
      if (await client.stat(p)) return;
      await client.mkdirp(parentPath(p));
      await client.mkdir(p);
    },

    /** Names taken in a folder (for picking a free name). */
    async names(path) {
      try {
        return (await client.list(path)).map((e) => e.name);
      } catch (err) {
        if (err instanceof NcError && err.code === 'not_found') return [];
        throw err;
      }
    },

    /** The bytes of a file. Large files come in as a stream. */
    async download(entry, { onProgress, signal } = {}) {
      const size = Number(entry.size) || 0;
      if (size <= BUFFERED_LIMIT) {
        const res = await ncRequest(api, fileUrl(entry.path), { method: 'GET', responseType: 'arraybuffer', signal });
        const bytes = new Uint8Array(res.body);
        onProgress?.(bytes.byteLength, bytes.byteLength);
        return bytes;
      }
      const res = await ncRequest(api, fileUrl(entry.path), { method: 'GET', responseType: 'stream', signal });
      const reader = res.body.getReader();
      const parts = [];
      let loaded = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          parts.push(value);
          loaded += value.byteLength;
          onProgress?.(loaded, size);
        }
      } catch (err) {
        throw errorFromException(err, signal);
      }
      const out = new Uint8Array(loaded);
      let offset = 0;
      for (const p of parts) { out.set(p, offset); offset += p.byteLength; }
      return out;
    },

    /** Upload in one request (small files). */
    async put(path, body, { contentType, onProgress, signal } = {}) {
      await ncRequest(api, fileUrl(path), {
        method: 'PUT',
        headers: { 'Content-Type': contentType || 'application/octet-stream' },
        body,
        onProgress,
        signal,
      });
    },

    async remove(path) {
      await ncRequest(api, fileUrl(path), { method: 'DELETE' });
    },

    /**
     * A public, read-only share link. `password` and `expireDate`
     * (YYYY-MM-DD) are optional.
     */
    async share(path, { password, expireDate } = {}) {
      const form = new URLSearchParams();
      form.set('path', normalizePath(path));
      form.set('shareType', '3');
      form.set('permissions', '1');
      if (password) form.set('password', password);
      if (expireDate) form.set('expireDate', expireDate);
      const data = await ocs(api, origin, '/ocs/v2.php/apps/files_sharing/api/v1/shares', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: form.toString(),
      }, { kind: 'share' });
      const url = data?.url;
      if (typeof url !== 'string' || !/^https?:\/\//.test(url)) throw new NcError('bad_answer');
      return { id: String(data.id ?? ''), url, password: password || '', expireDate: expireDate || '', name: baseName(path) };
    },

    /** A password that meets the server's password rules. */
    async generatePassword() {
      try {
        const data = await ocs(api, origin, '/ocs/v2.php/apps/password_policy/api/v1/generate');
        if (typeof data?.password === 'string' && data.password) return data.password;
      } catch { /* the app may be off; fall back */ }
      return localPassword();
    },

    /**
     * A public Talk conversation for a calendar event; resolves to its link.
     * Talk caps conversation names at 255 characters.
     */
    async createTalkRoom(name, description = '') {
      const data = await ocs(api, origin, '/ocs/v2.php/apps/spreed/api/v4/room', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ roomType: 3, roomName: name.slice(0, 255), ...(description ? { description } : {}) }),
      });
      if (typeof data?.token !== 'string' || !data.token) throw new NcError('bad_answer');
      return `${origin}/call/${encodeURIComponent(data.token)}`;
    },

    /** Where to open a file in the Nextcloud web interface. */
    webUrl(entry) {
      if (entry.fileId) return `${origin}/f/${encodeURIComponent(entry.fileId)}`;
      const dir = entry.isFolder ? entry.path : parentPath(entry.path);
      return `${origin}/apps/files/?dir=${encodeURIComponent(dir)}`;
    },

    joinPath,
  };

  async function runSearch({ query, recent, limit, signal }) {
    const res = await ncRequest(api, `${origin}/remote.php/dav/`, {
      method: 'SEARCH',
      headers: { 'Content-Type': 'text/xml; charset=utf-8' },
      body: searchBody({ userId, query, recent, limit }),
      responseType: 'text',
      signal,
    });
    return parseMultistatus(res.body).map((r) => toEntry(r, userId)).filter((e) => e && e.path !== '/');
  }

  return client;
}

const ALPHABETS = ['ABCDEFGHJKLMNPQRSTUVWXYZ', 'abcdefghijkmnopqrstuvwxyz', '23456789', '-_+!#'];

/** 20 characters with upper and lower case letters, digits and a symbol. */
export function localPassword(random = defaultRandom) {
  const all = ALPHABETS.join('');
  const chars = ALPHABETS.map((set) => set[random(set.length)]);
  while (chars.length < 20) chars.push(all[random(all.length)]);
  for (let i = chars.length - 1; i > 0; i--) {
    const j = random(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join('');
}

function defaultRandom(n) {
  const buf = new Uint32Array(1);
  globalThis.crypto.getRandomValues(buf);
  return buf[0] % n;
}
