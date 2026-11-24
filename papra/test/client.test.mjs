import { describe, it, expect } from 'vitest';
import { createClient, normalizeBase, tagColor, toDocument } from '../src/lib/client.js';
import { proxyResponse } from '../../test-utils/fake-api.mjs';

const BASE = 'https://docs.example.com';

function clientWith(answer) {
  const calls = [];
  const proxyFetch = async (credentialId, url, init) => {
    calls.push({ credentialId, url, init });
    return answer(url, init);
  };
  return { client: createClient({ proxyFetch, credentialId: 'personal', base: BASE }), calls };
}

describe('normalizeBase', () => {
  it('keeps the server and a sub path, without /api', () => {
    expect(normalizeBase('docs.example.com/api/')).toBe('https://docs.example.com');
    expect(normalizeBase('https://example.com/papra')).toBe('https://example.com/papra');
  });
});

describe('documents', () => {
  it('reads tags with their colours, leaving out a colour the host would refuse', () => {
    const doc = toDocument({ id: 'doc_1', name: 'Lease.pdf', mimeType: 'application/pdf', originalSize: 2048, createdAt: '2026-05-01T00:00:00Z',
      tags: [{ id: 't1', name: 'Home', color: '#22C55E' }, { id: 't2', name: 'Tax', color: 'red; background:url(x)' }] });
    expect(doc).toEqual({ id: 'doc_1', name: 'Lease.pdf', type: 'application/pdf', size: 2048, createdAt: '2026-05-01T00:00:00Z',
      tags: [{ id: 't1', name: 'Home', color: '#22C55E' }, { id: 't2', name: 'Tax', color: '' }] });
    expect(tagColor('#abc')).toBe('#abc');
  });

  it('lists an organization page by page and searches with Papra search', async () => {
    const { client, calls } = clientWith(() => proxyResponse(JSON.stringify({ documents: [{ id: 'doc_1', name: 'a.pdf' }], documentsCount: 26 })));
    const res = await client.documents('org_1', { text: ' lease ', pageIndex: 0 });
    expect(calls[0].url).toBe(`${BASE}/api/organizations/org_1/documents?searchQuery=lease&pageIndex=0&pageSize=25`);
    expect(calls[0].credentialId).toBe('personal');
    expect(res).toMatchObject({ count: 26, hasMore: true });
    await client.documents('org_1', { pageIndex: 1 });
    expect(calls[1].url).toBe(`${BASE}/api/organizations/org_1/documents?pageIndex=1&pageSize=25`);
  });

  it('lists organizations by name, and calls a server that answers otherwise not Papra', async () => {
    const { client } = clientWith(() => proxyResponse(JSON.stringify({ organizations: [{ id: 'o2', name: 'Work' }, { id: 'o1', name: 'Home' }] })));
    expect(await client.organizations()).toEqual([{ id: 'o1', name: 'Home' }, { id: 'o2', name: 'Work' }]);
    const other = clientWith(() => proxyResponse('{"hello":"world"}')).client;
    await expect(other.organizations()).rejects.toMatchObject({ key: 'error.not_papra' });
  });
});

describe('files', () => {
  it('takes the type from the document, as Papra sends every file as octet-stream', async () => {
    const { client, calls } = clientWith(() => ({ status: 200, ok: true, headers: { 'content-type': 'application/octet-stream', 'content-disposition': "attachment; filename*=UTF-8''Mietvertrag%20%C3%BC.pdf" }, body: new Uint8Array([1]).buffer }));
    const file = await client.download('org_1', { id: 'doc_1', name: 'x.pdf', type: 'application/pdf' });
    expect(calls[0].url).toBe(`${BASE}/api/organizations/org_1/documents/doc_1/file`);
    expect(file).toMatchObject({ type: 'application/pdf', name: 'Mietvertrag ü.pdf' });
  });

  it("uploads in the multipart field 'file' Papra reads", async () => {
    const { client, calls } = clientWith(() => proxyResponse(JSON.stringify({ document: { id: 'doc_9', name: 'scan.pdf' } })));
    expect(await client.upload('org_1', { data: new Uint8Array([1, 2]), name: 'scan.pdf', type: 'application/pdf' })).toEqual({ id: 'doc_9', name: 'scan.pdf' });
    expect(calls[0].url).toBe(`${BASE}/api/organizations/org_1/documents`);
    expect(calls[0].init.method).toBe('POST');
    expect(new TextDecoder().decode(calls[0].init.body)).toContain('name="file"; filename="scan.pdf"\r\nContent-Type: application/pdf');
  });

  it("shows Papra's own error message", async () => {
    const { client } = clientWith(() => proxyResponse(JSON.stringify({ error: { code: 'document.file_too_big', message: 'File too big' } }), { status: 413 }));
    await expect(client.upload('org_1', { data: new Uint8Array([1]), name: 'a.pdf' })).rejects.toMatchObject({ key: 'error.too_large' });
    const bad = clientWith(() => proxyResponse(JSON.stringify({ error: { code: 'x', message: 'Invalid file' } }), { status: 400 })).client;
    await expect(bad.upload('org_1', { data: new Uint8Array([1]), name: 'a.pdf' })).rejects.toMatchObject({ key: 'error.rejected', vars: { detail: 'Invalid file' } });
  });

  it('links to the document in Papra', () => {
    expect(clientWith(() => null).client.documentUrl('org_1', 'doc_1')).toBe(`${BASE}/organizations/org_1/documents/doc_1`);
  });
});
