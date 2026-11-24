// Paperless documents into mail: attach to a new message or to the message
// being written, or download.

import { PaperlessError } from './errors.js';

/** The mail server and the host read attachments up to this size. */
export const MAX_ATTACH_BYTES = 25 * 1024 * 1024;

/** Download one document from Paperless and upload it to the mail server. */
async function uploadDocument(api, client, doc) {
  const file = await client.download(doc.id, doc.original_file_name || `${doc.title || 'document'}.pdf`);
  const size = file.data?.byteLength ?? 0;
  if (size > MAX_ATTACH_BYTES) throw new PaperlessError('error.attach_too_large', { name: file.name });
  const blob = await api.jmap.uploadBlob(new Uint8Array(file.data), file.name, file.type);
  return { blobId: blob.blobId, name: file.name, type: blob.type || file.type, size: blob.size ?? size };
}

/**
 * Download each document from Paperless, upload it to the mail server and
 * open the composer with them attached.
 * @param {Array<{ id: number, title?: string, original_file_name?: string }>} docs
 */
export async function attachDocuments(api, client, docs, onProgress) {
  if (!docs.length) return null;
  const attachments = [];
  for (let i = 0; i < docs.length; i++) {
    onProgress?.(i, docs.length);
    attachments.push(await uploadDocument(api, client, docs[i]));
  }
  const message = { attachments };
  if (docs.length === 1 && docs[0].title) message.subject = String(docs[0].title).slice(0, 200);
  return api.compose.open(message);
}

/**
 * Attach documents to the message open in a composer (its Attach menu).
 * `onAttached(doc)` runs after each one the composer took, so a caller can
 * leave those out of a second try. Resolves to how many were attached;
 * stops at the first document that fails or that the composer refuses.
 */
export async function attachToComposer(api, client, composerId, docs, { onProgress, onAttached } = {}) {
  let attached = 0;
  for (let i = 0; i < docs.length; i++) {
    onProgress?.(i, docs.length);
    const file = await uploadDocument(api, client, docs[i]);
    const ok = await api.composer.attach(composerId, file);
    if (ok === false) throw new PaperlessError('error.attach_refused', { name: file.name });
    attached++;
    onAttached?.(docs[i]);
  }
  return attached;
}

export async function downloadDocument(api, client, doc) {
  const file = await client.download(doc.id, doc.original_file_name || `${doc.title || 'document'}.pdf`);
  await api.ui.downloadFile({ content: new Uint8Array(file.data), filename: file.name, contentType: file.type });
  return file.name;
}
