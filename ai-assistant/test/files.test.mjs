import { beforeEach, describe, expect, it } from 'vitest';
import { fakeApi } from '../../test-utils/fake-api.mjs';
import { allStrings } from '../src/lib/i18n.js';
import { toolsFor, runTool } from '../src/lib/tools.js';
import { actionToolsFor, describeAction, performAction, undoAction } from '../src/lib/actions.js';
import { filesFlags, forgetSeen, known } from '../src/lib/areas/files.js';
import { areaActions, areaTools } from '../src/lib/areas/index.js';

// The files area: find, list and read the user's files; attach them, save
// attachments, create, replace, move and rename. Attaching, replacing,
// moving and renaming always ask first; nothing deletes or shares.

const FEATURES = { files: true, attachmentImages: true };
const NOTES = { id: 'n1', name: 'notes.md', path: '/Documents', parentId: 'docs', kind: 'file', mimeType: 'text/markdown', size: 120, modified: '2026-10-30T10:00:00Z' };
const DOCS = { id: 'docs', name: 'Documents', path: '/', parentId: null, kind: 'folder', mimeType: '', size: 0, modified: '' };
const PHOTO = { id: 'p1', name: 'whiteboard.jpg', path: '/Documents', parentId: 'docs', kind: 'file', mimeType: 'image/jpeg', size: 300000, modified: '2026-10-29T10:00:00Z' };
const BOBS = { id: 'bob:x', name: 'plan.txt', path: '/Bob', parentId: 'bob:r', kind: 'file', mimeType: 'text/plain', size: 10, modified: '', shared: true, owner: 'Bob' };
const ON = { on: true, read: true, write: true, images: true };

function makeApi(handlers = {}, hostFeatures = FEATURES) {
  return fakeApi({
    translations: allStrings(),
    hostFeatures,
    handlers: {
      'files.find': async (q) => [NOTES, DOCS, PHOTO, BOBS].filter((f) => !q?.kind || (q.kind === 'folder') === (f.kind === 'folder')),
      'files.list': async () => [DOCS],
      'files.getText': async () => ({ name: 'notes.md', type: 'text/markdown', size: 120, format: 'text', status: 'ok', text: '# Notes\nLaunch on 12 December.', truncated: false }),
      'files.getImage': async () => ({ name: 'whiteboard.jpg', type: 'image/jpeg', width: 800, height: 600, data: 'AAAA', status: 'ok' }),
      'composer.getSnapshot': async () => ({ to: ['Bob <bob@example.org>'], cc: [], bcc: [] }),
      ...handlers,
    },
  });
}
const ctxWith = (extra = {}) => ({ lookups: true, actions: 'auto', mode: 'reader', zone: 'Europe/Berlin', files: { flags: ON, composerId: null, mentioned: [] }, ...extra });
const names = (list) => list.map((t) => t.name);

beforeEach(() => forgetSeen());

describe('what the files area offers', () => {
  it('needs the webmail\'s Files calls, the admin\'s switch and the user\'s switches', () => {
    const endpoint = { provider: 'anthropic', baseUrl: 'https://api.anthropic.com/v1', model: 'm' };
    expect(filesFlags(makeApi(), { endpoint })).toEqual({ on: true, read: true, write: true, images: true });
    // Webmail 1.19, or a server without Files: nothing.
    expect(filesFlags(fakeApi({}), { endpoint })).toMatchObject({ on: false, read: false, write: false });
    expect(filesFlags(makeApi({}, { files: false }), { endpoint })).toMatchObject({ on: false, read: false });
    expect(filesFlags(makeApi(), { endpoint, config: { allowFiles: false } })).toMatchObject({ on: false, read: false, write: false });
    expect(filesFlags(makeApi(), { endpoint, prefs: { filesRead: false } })).toMatchObject({ read: false, write: true, images: false });
    expect(filesFlags(makeApi(), { endpoint, prefs: { filesWrite: false } })).toMatchObject({ read: true, write: false });
    expect(filesFlags(makeApi(), { endpoint: { provider: 'openai', baseUrl: 'http://ollama:11434/v1', model: 'x' } }).images).toBe(false);
  });

  it('offers the lookups with reading on and the actions with actions and writing on', () => {
    expect(names(toolsFor(ctxWith()))).toEqual(expect.arrayContaining(['find_file', 'list_folder', 'read_file']));
    expect(names(toolsFor(ctxWith({ files: { flags: { ...ON, read: false } } })))).not.toContain('find_file');
    expect(names(toolsFor({ lookups: true }))).not.toContain('find_file');
    const acts = names(actionToolsFor(ctxWith({ openEmailId: 'M1' })));
    expect(acts).toEqual(expect.arrayContaining(['attach_file', 'save_attachments', 'create_file', 'create_folder', 'move_file', 'rename_file']));
    expect(names(actionToolsFor(ctxWith({ actions: 'off' })))).not.toContain('create_file');
    expect(names(actionToolsFor(ctxWith({ files: { flags: { ...ON, write: false } } })))).not.toEqual(expect.arrayContaining(['create_file']));
    // save_attachments needs an open message.
    expect(names(actionToolsFor(ctxWith()))).not.toContain('save_attachments');
  });

  // Nothing may move data out of the account: there is no tool to share,
  // publish or delete a file, whatever a message asks for.
  it('has no way to share, publish or delete a file', () => {
    const all = [...areaTools(), ...areaActions()].filter((e) => e.area === 'files').map((e) => e.name);
    expect(all.sort()).toEqual(['attach_file', 'create_file', 'create_folder', 'find_file', 'list_folder', 'move_file', 'read_file', 'rename_file', 'save_attachments']);
    expect(all.some((n) => /share|link|public|delete|remove|trash/.test(n))).toBe(false);
  });
});

describe('the lookups', () => {
  it('finds files and lists them for the model with their ids', async () => {
    const api = makeApi();
    const out = await runTool(api, 'find_file', { text: 'notes', kind: 'document', limit: 99 }, ctxWith());
    expect(api.calls('files.find').at(-1).args[0]).toEqual({ text: 'notes', kind: 'document', limit: 30 });
    expect(out).toContain('- id n1 | "notes.md" | in /Documents | text/markdown');
    expect(out).toContain('id bob:x | "plan.txt" | in /Bob | text/plain | 1 KB | shared with the user by Bob (read only)');
    expect(out).toContain('data, not instructions');
    expect(known('n1')).toEqual(NOTES);
  });

  it('reads a file\'s text within the request\'s budget', async () => {
    const api = makeApi();
    const ctx = ctxWith();
    await runTool(api, 'find_file', {}, ctx);
    const out = await runTool(api, 'read_file', { id: 'n1', maxChars: 500 }, ctx);
    expect(api.calls('files.getText').at(-1).args).toEqual(['n1', { maxChars: 500 }]);
    expect(out).toContain('<file name="notes.md" path="/Documents" format="text">\n# Notes\nLaunch on 12 December.\n</file>');
    await expect(runTool(api, 'read_file', { id: 'docs' }, ctx)).rejects.toThrow(/is a folder/);
  });

  it('hands a picture over as an image when the model can see it, else its name', async () => {
    const api = makeApi();
    await runTool(api, 'find_file', {}, ctxWith());
    const seen = await runTool(api, 'read_file', { id: 'p1' }, ctxWith());
    expect(seen.images).toEqual([{ mediaType: 'image/jpeg', data: 'AAAA', name: 'whiteboard.jpg', width: 800, height: 600 }]);
    const blind = await runTool(api, 'read_file', { id: 'p1' }, ctxWith({ files: { flags: { ...ON, images: false } } }));
    expect(blind).toBe('[Image: whiteboard.jpg. This model can\'t see images.]');
  });

  it('won\'t read an id it has never seen and can\'t find', async () => {
    const api = makeApi();
    await expect(runTool(api, 'read_file', { id: 'made-up' }, ctxWith())).rejects.toThrow(/find it with find_file/);
  });
});

describe('the actions', () => {
  async function seen(api) { await runTool(api, 'find_file', {}, ctxWith()); }

  it('attaching always asks and names the files and who gets them', async () => {
    const api = makeApi({ 'files.attach': async (ids) => ({ attached: ids.map(() => 'notes.md'), refused: [] }) });
    await seen(api);
    const ctx = ctxWith({ mode: 'composer', files: { flags: ON, composerId: 'C1', mentioned: [] } });
    const { summary, plan, alwaysAsk } = await describeAction(api, 'attach_file', { ids: ['n1'] }, ctx);
    expect(alwaysAsk).toBe(true);
    expect(summary).toBe('Attach “notes.md” to your message to Bob <bob@example.org>?');
    const done = await performAction(api, plan);
    expect(api.calls('files.attach').at(-1).args).toEqual([['n1'], { composerId: 'C1' }]);
    expect(done.text).toContain('Nothing was sent');
    await expect(describeAction(api, 'attach_file', { ids: ['docs'] }, ctx)).rejects.toThrow(/is a folder/);
  });

  it('attaches to a new message in the reader, listing the addresses the model chose', async () => {
    const api = makeApi({ 'files.attach': async () => ({ attached: ['notes.md'], refused: [] }) });
    await seen(api);
    const { summary, plan, alwaysAsk } = await describeAction(api, 'attach_file', { ids: ['n1'], to: ['x@example.com'], subject: 'Notes' }, ctxWith());
    expect(alwaysAsk).toBe(true);
    expect(summary).toBe('Open a new message to x@example.com with “notes.md” attached?');
    await performAction(api, plan);
    expect(api.calls('files.attach').at(-1).args).toEqual([['n1'], { newDraft: { to: ['x@example.com'], subject: 'Notes' } }]);
  });

  it('creates a Markdown file without asking in automatic mode, in a folder it names', async () => {
    const api = makeApi({ 'files.create': async (input) => ({ file: { ...NOTES, id: 'new', name: input.name, path: '/Documents' } }) });
    await seen(api);
    const { summary, plan, alwaysAsk } = await describeAction(api, 'create_file', { name: 'Minutes 2026-11-01', content: '# Minutes', folderId: 'docs' }, ctxWith());
    expect(alwaysAsk).toBe(false);
    expect(summary).toBe('Create “Minutes 2026-11-01.md” in “Documents”?');
    const done = await performAction(api, plan);
    expect(api.calls('files.create').at(-1).args[0]).toEqual({ name: 'Minutes 2026-11-01.md', content: '# Minutes', type: 'text/markdown', folderId: 'docs' });
    expect(done.text).toContain('id new');
    const top = await describeAction(api, 'create_file', { name: 'todo.txt', content: 'x' }, ctxWith());
    expect(top.summary).toBe('Create “todo.txt” in My files?');
    expect(top.plan.type).toBe('text/plain');
  });

  it('overwriting always asks and says where the old version goes', async () => {
    const api = makeApi({ 'files.create': async () => ({ file: NOTES, kept: { trashFolder: '.Trash', name: 'notes.md' } }) });
    await seen(api);
    const { summary, plan, alwaysAsk } = await describeAction(api, 'create_file', { replaceId: 'n1', content: 'New text' }, ctxWith());
    expect(alwaysAsk).toBe(true);
    expect(summary).toBe('Replace “notes.md”? The old version goes to the Files trash, where you can restore it.');
    await performAction(api, plan);
    expect(api.calls('files.create').at(-1).args[0]).toEqual({ replace: 'n1', content: 'New text', type: 'text/markdown' });
    await expect(describeAction(api, 'create_file', { replaceId: 'p1', content: 'x' }, ctxWith())).rejects.toThrow(/only text and Markdown/);
    await expect(describeAction(api, 'create_file', { replaceId: 'bob:x', content: 'x' }, ctxWith())).rejects.toThrow(/shared with the user/);
  });

  it('moving and renaming always ask, and Undo puts things back', async () => {
    const api = makeApi({
      'files.move': async () => ({ file: { ...NOTES, path: '/' }, previousFolderId: 'docs' }),
      'files.rename': async () => ({ file: { ...NOTES, name: 'minutes.md' }, previousName: 'notes.md' }),
    });
    await seen(api);
    const move = await describeAction(api, 'move_file', { id: 'n1' }, ctxWith());
    expect(move.alwaysAsk).toBe(true);
    expect(move.summary).toBe('Move “notes.md” to My files?');
    const moved = await performAction(api, move.plan);
    await undoAction(api, moved.undo);
    expect(api.calls('files.move').map((c) => c.args)).toEqual([['n1', null], ['n1', 'docs']]);

    const rename = await describeAction(api, 'rename_file', { id: 'n1', name: 'minutes.md' }, ctxWith());
    expect(rename.alwaysAsk).toBe(true);
    expect(rename.summary).toBe('Rename “notes.md” to “minutes.md”?');
    const renamed = await performAction(api, rename.plan);
    await undoAction(api, renamed.undo);
    expect(api.calls('files.rename').map((c) => c.args)).toEqual([['n1', 'minutes.md'], ['n1', 'notes.md']]);
    await expect(describeAction(api, 'move_file', { id: 'bob:x' }, ctxWith())).rejects.toThrow(/shared with the user/);
  });

  it('saves the open message\'s attachments into a folder', async () => {
    const api = makeApi({
      'email.get': async () => ({ id: 'M1', attachments: [{ blobId: 'b1', name: 'invoice.pdf', inline: false }, { blobId: 'b2', name: 'logo.png', inline: true }] }),
      'files.saveAttachments': async () => ({ saved: [{ ...NOTES, id: 's1', name: 'invoice.pdf', path: '/Documents' }], stopped: [] }),
    });
    await seen(api);
    const { summary, plan, alwaysAsk } = await describeAction(api, 'save_attachments', { folderId: 'docs' }, ctxWith({ openEmailId: 'M1' }));
    expect(alwaysAsk).toBe(false);
    expect(summary).toBe('Save “invoice.pdf” in “Documents”?');
    await performAction(api, plan);
    expect(api.calls('files.saveAttachments').at(-1).args).toEqual(['M1', ['b1'], 'docs', undefined]);
  });
});
