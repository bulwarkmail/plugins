// Files over JMAP for the assistant's end-to-end tests (package D): put
// files and folders into the test user's Files and read back what the
// assistant changed. Works on Stalwart 0.16 (nodeType, type) and 1.0
// (File Storage draft 18: @type, mediaType).

import { jmap, USER } from './jmap.mjs';

const FILENODE = 'urn:ietf:params:jmap:filenode';
const USING = ['urn:ietf:params:jmap:core', FILENODE];
const PROPS = ['id', 'parentId', 'name', 'blobId', 'size', 'type', 'nodeType', '@type', 'mediaType', 'shareWith', 'modified'];

/** The user's Files account and whether the server speaks draft 18 (Stalwart 1.0). */
async function files(user = USER) {
  const client = await jmap(user);
  const accountId = client.session.primaryAccounts[FILENODE];
  if (!accountId) throw new Error(`${user} has no Files on this server`);
  const cap = client.session.accounts[accountId]?.accountCapabilities?.[FILENODE] ?? {};
  return { client, accountId, draft18: 'supportedNodeTypes' in cap };
}

const isFolder = (n) => (n.nodeType ? n.nodeType === 'directory' : n['@type'] ? n['@type'] === 'Directory' : n.blobId == null);

/** Every node of the user's own drive, with `folder: boolean`. */
export async function listNodes(user = USER) {
  const { client, accountId } = await files(user);
  const [[name, res]] = await client.call([['FileNode/get', { accountId, ids: null, properties: PROPS }]], USING);
  if (name !== 'FileNode/get') throw new Error(`FileNode/get: ${JSON.stringify(res)}`);
  return res.list.map((n) => ({ ...n, folder: isFolder(n) }));
}

async function create(user, props) {
  const { client, accountId, draft18 } = await files(user);
  const wire = draft18
    ? (props.blobId ? { '@type': 'File', name: props.name, parentId: props.parentId, blobId: props.blobId, mediaType: props.type } : { '@type': 'Directory', name: props.name, parentId: props.parentId })
    : (props.blobId ? { name: props.name, parentId: props.parentId, blobId: props.blobId, type: props.type } : { name: props.name, parentId: props.parentId });
  if (!wire.parentId) delete wire.parentId;
  const [[, res]] = await client.call([['FileNode/set', { accountId, create: { n: wire } }]], USING);
  if (!res?.created?.n) throw new Error(`FileNode/set create "${props.name}": ${JSON.stringify(res?.notCreated ?? res)}`);
  return res.created.n.id;
}

/** A folder in the user's drive (null: the top). Resolves to its id. */
export async function createFolder(name, parentId = null, user = USER) {
  return create(user, { name, parentId });
}

/** A text file in the user's drive. Resolves to its id. */
export async function createTextFile(name, text, parentId = null, { type = 'text/markdown', user = USER } = {}) {
  const { client, accountId } = await files(user);
  const blobId = await uploadTo(client, accountId, Buffer.from(text, 'utf8'), type);
  return create(user, { name, parentId, blobId, type });
}

async function uploadTo(client, accountId, bytes, type) {
  // jmap.mjs uploads to the mail account; Files may have its own.
  if (accountId === client.accountId) return client.upload(bytes, type);
  throw new Error('the Files account differs from the mail account; not supported by these tests');
}

/** The text of a blob of the user's Files account. */
export async function blobText(blobId, user = USER) {
  const { client, accountId } = await files(user);
  const url = client.session.downloadUrl
    .replace('{accountId}', encodeURIComponent(accountId))
    .replace('{blobId}', encodeURIComponent(blobId))
    .replace('{name}', 'file')
    .replace('{type}', encodeURIComponent('text/plain'));
  const abs = url.startsWith('http') ? url : (process.env.BULWARK_JMAP_URL || 'http://localhost:18025').replace(/\/+$/, '') + url;
  const password = process.env.BULWARK_PASSWORD || 'test-pass-123';
  const res = await fetch(abs, { headers: { authorization: `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}` } });
  if (!res.ok) throw new Error(`download ${blobId}: HTTP ${res.status}`);
  return res.text();
}

/** Nodes that are shared with anyone (shareWith not empty). */
export async function sharedNodes(user = USER) {
  return (await listNodes(user)).filter((n) => n.shareWith && Object.keys(n.shareWith).length > 0);
}
