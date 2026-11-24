// Documents between Papra and mail: attach to the message being written,
// and save an attachment or a whole message to Papra.

import { PapraError } from './errors.js';

/** The mail server and the host read attachments up to this size. */
export const MAX_ATTACH_BYTES = 25 * 1024 * 1024;

/**
 * Download each document from Papra, upload it to the mail server and
 * attach it to the composer `composerId`. `onAttached(doc)` runs after each
 * one the composer took. Resolves to how many were attached; stops at the
 * first that fails, is too big or that the composer refuses.
 */
export async function attachDocuments(api, client, organizationId, composerId, docs, { onProgress, onAttached, signal } = {}) {
  let attached = 0;
  for (let i = 0; i < docs.length; i++) {
    const doc = docs[i];
    if (signal?.aborted) throw new PapraError('error.cancelled');
    onProgress?.(i, docs.length);
    // Known from Papra: don't download what can't go into mail.
    if (doc.size > MAX_ATTACH_BYTES) throw new PapraError('error.attach_too_large', { name: doc.name });
    const file = await client.download(organizationId, doc, signal);
    const size = file.data?.byteLength ?? 0;
    if (size > MAX_ATTACH_BYTES) throw new PapraError('error.attach_too_large', { name: file.name });
    const blob = await api.jmap.uploadBlob(new Uint8Array(file.data), file.name, file.type);
    const ok = await api.composer.attach(composerId, { blobId: blob.blobId, name: file.name, type: blob.type || file.type, size: blob.size ?? size });
    if (ok === false) throw new PapraError('error.attach_refused', { name: file.name });
    attached++;
    onAttached?.(doc);
  }
  return attached;
}

/** A file name for a message saved as .eml. */
export function emlName(subject) {
  const base = String(subject || '').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
  return `${base || 'message'}.eml`;
}

/** What "Save to Papra" saves: one attachment, or the whole message as .eml. */
export async function readForSaving(api, { kind, emailId, blobId, name, type }) {
  if (kind === 'message') {
    const [view, raw] = await Promise.all([api.email.get(emailId).catch(() => null), api.email.getRaw(emailId)]);
    return { name: emlName(view?.subject), type: 'message/rfc822', data: raw };
  }
  const file = await api.email.getAttachment(emailId, blobId);
  return { name: file?.name || name || 'attachment', type: file?.type || type || 'application/octet-stream', data: file.data };
}
