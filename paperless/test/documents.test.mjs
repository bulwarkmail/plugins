import { describe, it, expect } from 'vitest';
import { fakeApi } from '../../test-utils/fake-api.mjs';
import { attachDocuments, attachToComposer, downloadDocument, MAX_ATTACH_BYTES } from '../src/lib/documents.js';

function client(files) {
  return { download: async (id) => files[id] };
}

describe('attachDocuments', () => {
  it('uploads each document to the mail server and opens the composer with them', async () => {
    const api = fakeApi({
      handlers: {
        'jmap.uploadBlob': async (bytes, name, type) => ({ blobId: `blob-${name}`, size: bytes.byteLength, type }),
        'compose.open': async () => 'opened',
      },
    });
    const files = {
      1: { data: new Uint8Array([1, 2, 3]).buffer, name: 'a.pdf', type: 'application/pdf' },
      2: { data: new Uint8Array([4]).buffer, name: 'b.png', type: 'image/png' },
    };
    expect(await attachDocuments(api, client(files), [{ id: 1, title: 'A' }, { id: 2, title: 'B' }])).toBe('opened');
    expect(api.calls('jmap.uploadBlob').map((c) => [c.args[1], c.args[2], c.args[0].byteLength])).toEqual([['a.pdf', 'application/pdf', 3], ['b.png', 'image/png', 1]]);
    expect(api.calls('compose.open')[0].args[0]).toEqual({
      attachments: [
        { blobId: 'blob-a.pdf', name: 'a.pdf', type: 'application/pdf', size: 3 },
        { blobId: 'blob-b.png', name: 'b.png', type: 'image/png', size: 1 },
      ],
    });
  });

  it('uses the title as subject for one document', async () => {
    const api = fakeApi({ handlers: { 'jmap.uploadBlob': async () => ({ blobId: 'x', size: 1, type: 'application/pdf' }) } });
    await attachDocuments(api, client({ 1: { data: new ArrayBuffer(1), name: 'a.pdf', type: 'application/pdf' } }), [{ id: 1, title: 'Steuerbescheid' }]);
    expect(api.calls('compose.open')[0].args[0].subject).toBe('Steuerbescheid');
  });

  it('refuses a file too big to attach before uploading anything', async () => {
    const api = fakeApi();
    const big = { data: { byteLength: MAX_ATTACH_BYTES + 1 }, name: 'huge.pdf', type: 'application/pdf' };
    await expect(attachDocuments(api, client({ 1: big }), [{ id: 1 }])).rejects.toMatchObject({ key: 'error.attach_too_large' });
    expect(api.calls('jmap.uploadBlob')).toHaveLength(0);
    expect(api.calls('compose.open')).toHaveLength(0);
  });
});

describe('attachToComposer', () => {
  const files = {
    1: { data: new Uint8Array([1, 2, 3]).buffer, name: 'a.pdf', type: 'application/pdf' },
    2: { data: new Uint8Array([4]).buffer, name: 'b.png', type: 'image/png' },
  };
  const upload = async (bytes, name, type) => ({ blobId: `blob-${name}`, size: bytes.byteLength, type });

  it('adds each document to the message being written, not a new one', async () => {
    const api = fakeApi({ handlers: { 'jmap.uploadBlob': upload, 'composer.attach': async () => true } });
    const done = [];
    const count = await attachToComposer(api, client(files), 'c-7', [{ id: 1 }, { id: 2 }], { onAttached: (d) => done.push(d.id) });
    expect(count).toBe(2);
    expect(api.calls('composer.attach').map((c) => c.args)).toEqual([
      ['c-7', { blobId: 'blob-a.pdf', name: 'a.pdf', type: 'application/pdf', size: 3 }],
      ['c-7', { blobId: 'blob-b.png', name: 'b.png', type: 'image/png', size: 1 }],
    ]);
    expect(done).toEqual([1, 2]);
    expect(api.calls('compose.open')).toHaveLength(0);
  });

  it('stops with the file name when the composer refuses one', async () => {
    let n = 0;
    const api = fakeApi({ handlers: { 'jmap.uploadBlob': upload, 'composer.attach': async () => (++n === 1) } });
    const done = [];
    await expect(attachToComposer(api, client(files), 'c-7', [{ id: 1 }, { id: 2 }], { onAttached: (d) => done.push(d.id) }))
      .rejects.toMatchObject({ key: 'error.attach_refused', vars: { name: 'b.png' } });
    expect(done).toEqual([1]);
  });
});

describe('downloadDocument', () => {
  it('hands the original file to the browser', async () => {
    const api = fakeApi();
    await downloadDocument(api, client({ 3: { data: new Uint8Array([9]).buffer, name: 'scan.pdf', type: 'application/pdf' } }), { id: 3 });
    const arg = api.calls('ui.downloadFile')[0].args[0];
    expect(arg.filename).toBe('scan.pdf');
    expect(arg.contentType).toBe('application/pdf');
    expect([...arg.content]).toEqual([9]);
  });
});
