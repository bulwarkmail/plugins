// A small Immich REST client on top of api.proxy.fetch. The API key never
// reaches the plugin: the server proxy adds the `x-api-key` header.
//
// Checked against the API of Immich 1.132, 2.x and 3.x: albums list their
// photos up to 2.x and only through the search from 3.x on; uploads need a
// device id up to 2.x and ignore it from 3.x on.

import { ImmichError, errorFromResponse } from './errors.js';
import { buildMultipart } from './multipart.js';

export const PAGE_SIZE = 30;
const ACCEPT = 'application/json';

/** "https://photos.example.com/api/" → "https://photos.example.com", or '' when not a URL. */
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

const BY_EXTENSION = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', heic: 'image/heic',
  heif: 'image/heif', avif: 'image/avif', tif: 'image/tiff', tiff: 'image/tiff', bmp: 'image/bmp', jxl: 'image/jxl',
  dng: 'image/x-adobe-dng', cr2: 'image/x-canon-cr2', nef: 'image/x-nikon-nef', arw: 'image/x-sony-arw',
  mp4: 'video/mp4', mov: 'video/quicktime', m4v: 'video/x-m4v', webm: 'video/webm', mkv: 'video/x-matroska',
  avi: 'video/x-msvideo', '3gp': 'video/3gpp', mts: 'video/mp2t', m2ts: 'video/mp2t',
};

/** The real type of a file, from its extension when the mail says application/octet-stream. */
export function mediaType(name, type) {
  const t = String(type || '').toLowerCase().split(';')[0].trim();
  if (t && t !== 'application/octet-stream') return t;
  const ext = String(name || '').toLowerCase().split('.').pop();
  return BY_EXTENSION[ext] || t || 'application/octet-stream';
}

/** Whether Immich takes this file: a photo or a video. */
export function isMedia(name, type) {
  return /^(image|video)\//.test(mediaType(name, type));
}

/** An Immich asset as the plugin uses it. */
export function toAsset(raw) {
  const name = String(raw?.originalFileName || 'photo');
  const kind = raw?.type === 'VIDEO' ? 'video' : 'image';
  return {
    id: String(raw?.id || ''),
    name,
    kind,
    type: raw?.originalMimeType || mediaType(name, '') || (kind === 'video' ? 'video/mp4' : 'image/jpeg'),
    size: Number(raw?.exifInfo?.fileSizeInByte) || 0,
    takenAt: raw?.localDateTime || raw?.fileCreatedAt || '',
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

export function createClient({ proxyFetch, credentialId, base }) {
  if (!base) throw new ImmichError('error.not_connected');

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
    const init = { ...opts, responseType: 'text' };
    if (opts.json !== undefined) {
      init.body = JSON.stringify(opts.json);
      init.headers = { 'Content-Type': 'application/json', ...opts.headers };
      delete init.json;
    }
    const res = await request(path, init);
    const text = typeof res.body === 'string' ? res.body : '';
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      throw new ImmichError('error.not_immich', {}, res.status);
    }
  }

  const page = (data) => {
    const assets = data?.assets ?? {};
    const items = Array.isArray(assets.items) ? assets.items.map(toAsset).filter((a) => a.id) : [];
    return { items, nextPage: assets.nextPage ? Number(assets.nextPage) || null : null };
  };

  async function search({ text = '', albumId = '', pageNumber = 1 } = {}) {
    const query = text.trim();
    const common = { page: pageNumber, size: PAGE_SIZE, ...(albumId ? { albumIds: [albumId] } : {}) };
    if (query) {
      try {
        return page(await json('/search/smart', { method: 'POST', json: { ...common, query } }));
      } catch (err) {
        // Smart search needs Immich's machine learning; without it, the file name.
        if (!(err instanceof ImmichError) || (err.status !== 400 && err.status < 500)) throw err;
      }
      return page(await json('/search/metadata', { method: 'POST', json: { ...common, originalFileName: query, order: 'desc' } }));
    }
    return page(await json('/search/metadata', { method: 'POST', json: { ...common, order: 'desc' } }));
  }

  return {
    base,
    credentialId,
    request,

    /** Who the key belongs to; also checks the connection. */
    async whoAmI() {
      const data = await json('/users/me');
      if (!data || typeof data !== 'object' || !('email' in data || 'name' in data)) throw new ImmichError('error.not_immich');
      return { name: String(data.name || ''), email: String(data.email || '') };
    },

    /** Own and shared albums, by name. */
    async albums() {
      const data = await json('/albums');
      const list = Array.isArray(data) ? data : [];
      return list
        .map((a) => ({ id: String(a.id || ''), name: String(a.albumName || ''), count: Number(a.assetCount) || 0 }))
        .filter((a) => a.id)
        .sort((a, b) => a.name.localeCompare(b.name));
    },

    /**
     * One page of photos and videos, newest first: all of them, those in an
     * album, or those matching `text` (smart search, else the file name).
     * @returns {Promise<{ items: ReturnType<typeof toAsset>[], nextPage: number|null }>}
     */
    async assets({ text = '', albumId = '', pageNumber = 1 } = {}) {
      if (albumId && !text.trim()) {
        // Up to Immich 2.x the album lists its photos itself.
        const album = await json(`/albums/${encodeURIComponent(albumId)}`);
        if (Array.isArray(album?.assets)) {
          const all = album.assets.map(toAsset).filter((a) => a.id)
            .sort((a, b) => String(b.takenAt).localeCompare(String(a.takenAt)));
          const start = (pageNumber - 1) * PAGE_SIZE;
          const items = all.slice(start, start + PAGE_SIZE);
          return { items, nextPage: start + PAGE_SIZE < all.length ? pageNumber + 1 : null };
        }
      }
      return search({ text, albumId, pageNumber });
    },

    async thumbnail(id, signal) {
      const res = await request(`/assets/${encodeURIComponent(id)}/thumbnail?size=thumbnail`, { responseType: 'arraybuffer', signal, headers: { Accept: 'image/*' } });
      return { data: res.body, type: (res.headers?.['content-type'] || 'image/webp').split(';')[0].trim() };
    },

    /** The original file, with its name. */
    async download(asset, signal) {
      const res = await request(`/assets/${encodeURIComponent(asset.id)}/original`, { responseType: 'arraybuffer', signal, headers: { Accept: '*/*' } });
      const header = (res.headers?.['content-type'] || '').split(';')[0].trim();
      const type = header && header !== 'application/octet-stream' ? header : asset.type || 'application/octet-stream';
      return { data: res.body, type, name: filenameFromDisposition(res.headers?.['content-disposition']) || asset.name };
    },

    /**
     * Upload a photo or video. Immich files it by the date in the file
     * itself; `takenAt` is the fallback. Resolves to { id, duplicate }.
     * @param {{ data: Uint8Array|ArrayBuffer, name: string, type?: string, takenAt?: string }} file
     */
    async upload(file, { signal } = {}) {
      const at = file.takenAt && !Number.isNaN(Date.parse(file.takenAt)) ? new Date(file.takenAt).toISOString() : new Date().toISOString();
      const size = file.data?.byteLength ?? 0;
      const { body, contentType } = buildMultipart([
        // Required up to Immich 2.x, ignored from 3.x on.
        ['deviceAssetId', `bulwark-${file.name}-${size}`.slice(0, 200)],
        ['deviceId', 'bulwark-webmail'],
        ['fileCreatedAt', at],
        ['fileModifiedAt', at],
        ['filename', file.name],
        ['assetData', { filename: file.name, type: file.type, data: file.data }],
      ]);
      const data = await json('/assets', { method: 'POST', headers: { 'Content-Type': contentType }, body, signal });
      if (!data?.id) throw new ImmichError('error.unexpected', { detail: 'no asset id' });
      return { id: String(data.id), duplicate: data.status === 'duplicate' };
    },

    /** The photo's page in Immich's web app. */
    assetUrl(id) {
      return `${base}/photos/${encodeURIComponent(id)}`;
    },
  };
}
