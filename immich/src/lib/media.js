// Photos and videos between Immich and mail: attach to the message being
// written, and save a received attachment to Immich.

import { ImmichError } from './errors.js';
import { isMedia, mediaType } from './client.js';

/** The mail server and the host read attachments up to this size. */
export const MAX_ATTACH_BYTES = 25 * 1024 * 1024;

/**
 * Download each photo from Immich, upload it to the mail server and attach
 * it to the composer `composerId`. `onAttached(asset)` runs after each one
 * the composer took. Resolves to how many were attached; stops at the first
 * that fails, is too big or that the composer refuses.
 */
export async function attachAssets(api, client, composerId, assets, { onProgress, onAttached, signal } = {}) {
  let attached = 0;
  for (let i = 0; i < assets.length; i++) {
    const asset = assets[i];
    if (signal?.aborted) throw new ImmichError('error.cancelled');
    onProgress?.(i, assets.length);
    // Known from Immich's metadata: don't download what can't go into mail.
    if (asset.size > MAX_ATTACH_BYTES) throw new ImmichError('error.attach_too_large', { name: asset.name });
    const file = await client.download(asset, signal);
    const size = file.data?.byteLength ?? 0;
    if (size > MAX_ATTACH_BYTES) throw new ImmichError('error.attach_too_large', { name: file.name });
    const blob = await api.jmap.uploadBlob(new Uint8Array(file.data), file.name, file.type);
    const ok = await api.composer.attach(composerId, { blobId: blob.blobId, name: file.name, type: blob.type || file.type, size: blob.size ?? size });
    if (ok === false) throw new ImmichError('error.attach_refused', { name: file.name });
    attached++;
    onAttached?.(asset);
  }
  return attached;
}

/**
 * Save one attachment of a message to Immich. The message's date stands in
 * for a photo without its own. Resolves to { name, id, duplicate }.
 */
export async function saveAttachment(api, client, { emailId, blobId, name, type }) {
  if (!isMedia(name, type)) throw new ImmichError('error.not_media', { name: name || '' });
  const [view, file] = await Promise.all([
    api.email.get(emailId).catch(() => null),
    api.email.getAttachment(emailId, blobId),
  ]);
  const fileName = file?.name || name || 'photo';
  const fileType = mediaType(fileName, file?.type || type);
  if (!/^(image|video)\//.test(fileType)) throw new ImmichError('error.not_media', { name: fileName });
  const result = await client.upload({ data: file.data, name: fileName, type: fileType, takenAt: view?.receivedAt || '' });
  return { name: fileName, ...result };
}
