import { describe, it, expect } from 'vitest';
import { createClient, isMedia, mediaType, normalizeBase, toAsset } from '../src/lib/client.js';
import { proxyResponse } from '../../test-utils/fake-api.mjs';

const BASE = 'https://photos.example.com';
const raw = (id, extra = {}) => ({ id, originalFileName: `${id}.jpg`, type: 'IMAGE', originalMimeType: 'image/jpeg', localDateTime: '2026-07-01T10:00:00.000Z', exifInfo: { fileSizeInByte: 1234 }, ...extra });

/** A client whose proxy answers with `answer(url, init)`; `calls` records every request. */
function clientWith(answer) {
  const calls = [];
  const proxyFetch = async (credentialId, url, init) => {
    calls.push({ credentialId, url, init, json: typeof init.body === 'string' ? JSON.parse(init.body) : null });
    return answer(url, init);
  };
  return { client: createClient({ proxyFetch, credentialId: 'personal', base: BASE }), calls };
}

const page = (items, nextPage = null) => proxyResponse(JSON.stringify({ albums: { items: [] }, assets: { items, nextPage, count: items.length } }));

describe('normalizeBase', () => {
  it('keeps the server and a sub path, without /api or a trailing slash', () => {
    expect(normalizeBase('photos.example.com/')).toBe('https://photos.example.com');
    expect(normalizeBase('https://example.com/immich/api/')).toBe('https://example.com/immich');
    expect(normalizeBase('ftp://example.com')).toBe('');
  });
});

describe('media types', () => {
  it('takes photos and videos, also when the mail calls them octet-stream', () => {
    expect(isMedia('a.jpg', 'image/jpeg')).toBe(true);
    expect(isMedia('clip.MOV', 'application/octet-stream')).toBe(true);
    expect(mediaType('IMG_1.HEIC', '')).toBe('image/heic');
    expect(isMedia('invoice.pdf', 'application/pdf')).toBe(false);
  });

  it('reads an asset with its size and date', () => {
    expect(toAsset(raw('a1', { type: 'VIDEO', originalMimeType: 'video/mp4', originalFileName: 'a1.mp4' }))).toEqual({
      id: 'a1', name: 'a1.mp4', kind: 'video', type: 'video/mp4', size: 1234, takenAt: '2026-07-01T10:00:00.000Z',
    });
  });
});

describe('assets', () => {
  it('lists the newest photos with the metadata search when nothing is typed', async () => {
    const { client, calls } = clientWith(() => page([raw('a1'), raw('a2')], '2'));
    const res = await client.assets({});
    expect(calls[0].url).toBe(`${BASE}/api/search/metadata`);
    expect(calls[0].init.method).toBe('POST');
    expect(calls[0].json).toEqual({ page: 1, size: 30, order: 'desc' });
    expect(calls[0].credentialId).toBe('personal');
    expect(res.items.map((a) => a.id)).toEqual(['a1', 'a2']);
    expect(res.nextPage).toBe(2);
  });

  it('searches with smart search and falls back to the file name without machine learning', async () => {
    const { client, calls } = clientWith((url) => (url.endsWith('/search/smart')
      ? proxyResponse(JSON.stringify({ message: 'Machine learning is disabled' }), { status: 400 })
      : page([raw('beach')])));
    const res = await client.assets({ text: ' beach ' });
    expect(calls.map((c) => c.url)).toEqual([`${BASE}/api/search/smart`, `${BASE}/api/search/metadata`]);
    expect(calls[0].json).toEqual({ page: 1, size: 30, query: 'beach' });
    expect(calls[1].json).toEqual({ page: 1, size: 30, originalFileName: 'beach', order: 'desc' });
    expect(res.items[0].id).toBe('beach');
  });

  it("doesn't hide a revoked key behind the fallback", async () => {
    const { client, calls } = clientWith(() => proxyResponse('{"message":"Invalid API key"}', { status: 401 }));
    await expect(client.assets({ text: 'beach' })).rejects.toMatchObject({ key: 'error.token' });
    expect(calls).toHaveLength(1);
  });

  it('pages through an album that lists its photos itself (Immich 2.x and older)', async () => {
    const assets = Array.from({ length: 35 }, (_, i) => raw(`p${i}`, { localDateTime: `2026-01-${String(i + 1).padStart(2, '0')}T00:00:00Z` }));
    const { client } = clientWith(() => proxyResponse(JSON.stringify({ id: 'al1', albumName: 'Trip', assets })));
    const first = await client.assets({ albumId: 'al1' });
    expect(first.items).toHaveLength(30);
    expect(first.items[0].id).toBe('p34');
    expect(first.nextPage).toBe(2);
    const second = await client.assets({ albumId: 'al1', pageNumber: 2 });
    expect(second.items.map((a) => a.id)).toEqual(['p4', 'p3', 'p2', 'p1', 'p0']);
    expect(second.nextPage).toBeNull();
  });

  it('searches an album by id where the album lists no photos (Immich 3)', async () => {
    const { client, calls } = clientWith((url) => (url.includes('/albums/') ? proxyResponse(JSON.stringify({ id: 'al1', albumName: 'Trip', assetCount: 3 })) : page([raw('x')])));
    await client.assets({ albumId: 'al1' });
    expect(calls[1].url).toBe(`${BASE}/api/search/metadata`);
    expect(calls[1].json).toEqual({ page: 1, size: 30, albumIds: ['al1'], order: 'desc' });
  });
});

describe('albums', () => {
  it('lists albums by name', async () => {
    const { client } = clientWith(() => proxyResponse(JSON.stringify([{ id: 'b', albumName: 'Zoo', assetCount: 2 }, { id: 'a', albumName: 'Alps', assetCount: 5 }])));
    expect(await client.albums()).toEqual([{ id: 'a', name: 'Alps', count: 5 }, { id: 'b', name: 'Zoo', count: 2 }]);
  });
});

describe('upload', () => {
  it('sends the file with the dates and device fields older Immich versions need', async () => {
    const { client, calls } = clientWith(() => proxyResponse(JSON.stringify({ id: 'new1', status: 'created' })));
    const result = await client.upload({ data: new Uint8Array([1, 2, 3]), name: 'IMG_1.jpg', type: 'image/jpeg', takenAt: '2026-10-01T12:00:00Z' });
    expect(result).toEqual({ id: 'new1', duplicate: false });
    expect(calls[0].url).toBe(`${BASE}/api/assets`);
    expect(calls[0].init.headers['Content-Type']).toMatch(/^multipart\/form-data; boundary=/);
    const body = new TextDecoder().decode(calls[0].init.body);
    for (const field of ['deviceAssetId', 'deviceId', 'fileCreatedAt', 'fileModifiedAt', 'filename']) expect(body).toContain(`name="${field}"`);
    expect(body).toContain('2026-10-01T12:00:00.000Z');
    expect(body).toContain('name="assetData"; filename="IMG_1.jpg"\r\nContent-Type: image/jpeg');
  });

  it('says when Immich had the photo already', async () => {
    const { client } = clientWith(() => proxyResponse(JSON.stringify({ id: 'old', status: 'duplicate' })));
    expect(await client.upload({ data: new Uint8Array([1]), name: 'a.jpg', type: 'image/jpeg' })).toEqual({ id: 'old', duplicate: true });
  });

  it('names the missing permission of a scoped key', async () => {
    const { client } = clientWith(() => proxyResponse(JSON.stringify({ message: 'Missing required permission: asset.upload' }), { status: 403 }));
    await expect(client.upload({ data: new Uint8Array([1]), name: 'a.jpg' })).rejects.toMatchObject({ key: 'error.forbidden', vars: { detail: 'Missing required permission: asset.upload' } });
  });
});

describe('download', () => {
  it('keeps the asset type when Immich answers octet-stream', async () => {
    const { client, calls } = clientWith(() => ({ status: 200, ok: true, headers: { 'content-type': 'application/octet-stream', 'content-disposition': 'attachment; filename="IMG_9.jpg"' }, body: new Uint8Array([9]).buffer }));
    const file = await client.download(toAsset(raw('a9')));
    expect(calls[0].url).toBe(`${BASE}/api/assets/a9/original`);
    expect(file.type).toBe('image/jpeg');
    expect(file.name).toBe('IMG_9.jpg');
  });
});
