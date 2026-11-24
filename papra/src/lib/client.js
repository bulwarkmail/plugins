// A small Papra REST client on top of api.proxy.fetch. The API key never
// reaches the plugin: the server proxy adds `Authorization: Bearer ...`.
// Papra keeps documents per organization; every call names one.

import { PapraError, errorFromResponse } from './errors.js';
import { buildMultipart } from './multipart.js';

export const PAGE_SIZE = 25;
const ACCEPT = 'application/json';

/** "https://docs.example.com/api/" → "https://docs.example.com", or '' when not a URL. */
export function normalizeBase(value) {
  if (typeof value !== 'string' || !value.trim()) return '';
  let text = value.trim();
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) text = `https://${text}`;
  try {
    const url = new URL(text);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return '';
    const path = url.pathname.replace(/\/+$/, '').replace(/\/api$/, '');
    return `${url.origin}${path}`;
  } catch {
    return '';
  }
}

/** A tag colour the host's ColorDot takes (#rgb or #rrggbb), or ''. */
export function tagColor(value) {
  return typeof value === 'string' && /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(value.trim()) ? value.trim() : '';
}

/** A Papra document as the plugin uses it. */
export function toDocument(raw) {
  return {
    id: String(raw?.id || ''),
    name: String(raw?.name || raw?.originalName || 'document'),
    type: String(raw?.mimeType || 'application/octet-stream'),
    size: Number(raw?.originalSize) || 0,
    createdAt: raw?.createdAt || '',
    tags: (Array.isArray(raw?.tags) ? raw.tags : [])
      .map((tag) => ({ id: String(tag?.id || ''), name: String(tag?.name || ''), color: tagColor(tag?.color) }))
      .filter((tag) => tag.name),
  };
}

/** The file name in a Content-Disposition header, preferring RFC 5987 filename*. */
export function filenameFromDisposition(header) {
  if (typeof header !== 'string') return '';
  const star = /filename\*\s*=\s*([^']*)'[^']*'([^;]+)/i.exec(header);
  if (star) {
    try { return decodeURIComponent(star[2].trim()); } catch { /* fall through */ }
  }
  const plain = /filename\s*=\s*"((?:[^"\\]|\\.)*)"|filename\s*=\s*([^;]+)/i.exec(header);
  if (plain) return (plain[1] ?? plain[2] ?? '').replace(/\\(.)/g, '$1').trim();
  return '';
}

const org = (id) => `/organizations/${encodeURIComponent(id)}`;

export function createClient({ proxyFetch, credentialId, base }) {
  if (!base) throw new PapraError('error.not_connected');

  async function request(path, { method = 'GET', headers = {}, body, responseType = 'json', signal } = {}) {
    const init = { method, headers: { Accept: ACCEPT, ...headers }, responseType };
    if (body !== undefined) init.body = body;
    if (signal) init.signal = signal;
    const res = await proxyFetch(credentialId, `${base}/api${path}`, init);
    if (!res || !res.ok) throw errorFromResponse(res || { status: 0, headers: {} });
    return res;
  }

  // Asked for as text and parsed here: a proxy or server error page in HTML
  // would make the host's JSON parsing throw before the status is seen.
  async function json(path, opts = {}) {
    const res = await request(path, { ...opts, responseType: 'text' });
    const text = typeof res.body === 'string' ? res.body : '';
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      throw new PapraError('error.not_papra', {}, res.status);
    }
  }

  return {
    base,
    credentialId,
    request,

    /** The organizations the key's user is in, by name; also checks the connection. */
    async organizations() {
      const data = await json('/organizations');
      if (!data || !Array.isArray(data.organizations)) throw new PapraError('error.not_papra');
      return data.organizations
        .map((o) => ({ id: String(o?.id || ''), name: String(o?.name || '') }))
        .filter((o) => o.id)
        .sort((a, b) => a.name.localeCompare(b.name));
    },

    /**
     * One page of an organization's documents, newest first, or those
     * matching `text` (Papra's own search over names and content).
     * @returns {Promise<{ items: ReturnType<typeof toDocument>[], count: number, hasMore: boolean }>}
     */
    async documents(organizationId, { text = '', pageIndex = 0 } = {}) {
      const q = new URLSearchParams();
      if (text.trim()) q.set('searchQuery', text.trim());
      q.set('pageIndex', String(pageIndex));
      q.set('pageSize', String(PAGE_SIZE));
      const data = await json(`${org(organizationId)}/documents?${q}`);
      const items = (Array.isArray(data?.documents) ? data.documents : []).map(toDocument).filter((d) => d.id);
      const count = Number(data?.documentsCount) || items.length;
      return { items, count, hasMore: (pageIndex + 1) * PAGE_SIZE < count };
    },

    /** The original file. Papra sends every file as octet-stream; the type comes from the document. */
    async download(organizationId, doc, signal) {
      const res = await request(`${org(organizationId)}/documents/${encodeURIComponent(doc.id)}/file`, { responseType: 'arraybuffer', signal, headers: { Accept: '*/*' } });
      const header = (res.headers?.['content-type'] || '').split(';')[0].trim();
      const type = doc.type && doc.type !== 'application/octet-stream' ? doc.type : header || 'application/octet-stream';
      return { data: res.body, type, name: filenameFromDisposition(res.headers?.['content-disposition']) || doc.name };
    },

    /**
     * Add a file to an organization. Resolves to the new document's { id, name }.
     * @param {{ data: Uint8Array|ArrayBuffer, name: string, type?: string }} file
     */
    async upload(organizationId, file, { signal } = {}) {
      const { body, contentType } = buildMultipart([['file', { filename: file.name, type: file.type, data: file.data }]]);
      const data = await json(`${org(organizationId)}/documents`, { method: 'POST', headers: { 'Content-Type': contentType }, body, signal });
      const doc = data?.document;
      if (!doc?.id) throw new PapraError('error.unexpected', { detail: 'no document id' });
      return { id: String(doc.id), name: String(doc.name || file.name) };
    },

    /** The document's page in Papra's web app. */
    documentUrl(organizationId, id) {
      return `${base}${org(organizationId)}/documents/${encodeURIComponent(id)}`;
    },
  };
}
