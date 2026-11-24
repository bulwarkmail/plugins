import { describe, it, expect } from 'vitest';
import { fakeApi } from '../../test-utils/fake-api.mjs';
import { MAX_ATTACH_BYTES, attachAssets, saveAttachment } from '../src/lib/media.js';

const asset = (id, extra = {}) => ({ id, name: `${id}.jpg`, kind: 'image', type: 'image/jpeg', size: 3, takenAt: '', ...extra });

function client({ uploads = [] } = {}) {
  return {
    downloads: [],
    async download(a) { this.downloads.push(a.id); return { data: new Uint8Array([1, 2, 3]).buffer, type: a.type, name: a.name }; },
    async upload(file) { uploads.push(file); return { id: 'n1', duplicate: false }; },
  };
}

describe('attachAssets', () => {
  it('attaches each photo to the message being written', async () => {
    const api = fakeApi({ handlers: {
      'jmap.uploadBlob': async (bytes, name, type) => ({ blobId: `b-${name}`, size: bytes.byteLength, type }),
      'composer.attach': async () => true,
    } });
    const done = [];
    const n = await attachAssets(api, client(), 'c1', [asset('a'), asset('b')], { onAttached: (x) => done.push(x.id) });
    expect(n).toBe(2);
    expect(api.calls('composer.attach').map((c) => c.args)).toEqual([
      ['c1', { blobId: 'b-a.jpg', name: 'a.jpg', type: 'image/jpeg', size: 3 }],
      ['c1', { blobId: 'b-b.jpg', name: 'b.jpg', type: 'image/jpeg', size: 3 }],
    ]);
    expect(done).toEqual(['a', 'b']);
  });

  it("doesn't download a video too big for mail", async () => {
    const api = fakeApi();
    const c = client();
    await expect(attachAssets(api, c, 'c1', [asset('v', { size: MAX_ATTACH_BYTES + 1, name: 'v.mp4' })]))
      .rejects.toMatchObject({ key: 'error.attach_too_large', vars: { name: 'v.mp4' } });
    expect(c.downloads).toEqual([]);
  });

  it('stops with the name when the composer refuses a file', async () => {
    const api = fakeApi({ handlers: { 'jmap.uploadBlob': async () => ({ blobId: 'x', size: 3 }), 'composer.attach': async () => false } });
    await expect(attachAssets(api, client(), 'c1', [asset('a')])).rejects.toMatchObject({ key: 'error.attach_refused', vars: { name: 'a.jpg' } });
  });
});

describe('saveAttachment', () => {
  it('uploads a photo with the date of the message', async () => {
    const uploads = [];
    const api = fakeApi({ handlers: {
      'email.get': async () => ({ id: 'e1', receivedAt: '2026-09-09T09:00:00Z' }),
      'email.getAttachment': async () => ({ name: 'beach.JPG', type: 'application/octet-stream', size: 2, data: new Uint8Array([7, 7]).buffer }),
    } });
    const result = await saveAttachment(api, client({ uploads }), { emailId: 'e1', blobId: 'b1', name: 'beach.JPG', type: 'application/octet-stream' });
    expect(result).toEqual({ name: 'beach.JPG', id: 'n1', duplicate: false });
    expect(uploads[0]).toMatchObject({ name: 'beach.JPG', type: 'image/jpeg', takenAt: '2026-09-09T09:00:00Z' });
  });

  it("refuses a file that isn't a photo or video before reading it", async () => {
    const api = fakeApi();
    await expect(saveAttachment(api, client(), { emailId: 'e1', blobId: 'b1', name: 'invoice.pdf', type: 'application/pdf' }))
      .rejects.toMatchObject({ key: 'error.not_media', vars: { name: 'invoice.pdf' } });
    expect(api.calls('email.getAttachment')).toHaveLength(0);
  });
});
