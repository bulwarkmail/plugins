// The Nextcloud page (api.ui.setPages, slot "app-page"), laid out like the
// Files app: a toolbar with the path, search and actions, the files below.
// Upload, download, share, and attach a file to a new message.

import { createElement as h, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert, EmptyState, Button, ListRow, Page, ProgressBar, RowAction, Stack, Text, Toolbar, ToolbarButton, ToolbarSpacer,
} from '@plugin-host/ui';
import { getApi } from '../lib/host.js';
import { createClient } from '../lib/client.js';
import { uploadFile, discardUpload } from '../lib/chunked.js';
import { NcError, errorText } from '../lib/errors.js';
import { formatSize } from '../lib/format.js';
import { attachToNewMessage, canDownload, createFolder, downloadToComputer } from '../lib/files.js';
import { accountName } from '../lib/account.js';
import { planUpload } from '../lib/save.js';
import { ConnectionEmpty, useConnection } from './connection-ui.js';
import { BrowserList, browserBar, useBrowser } from './browser.js';

const NARROW = '(max-width: 640px)';

function useNarrow() {
  const query = typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia(NARROW) : null;
  const [narrow, setNarrow] = useState(() => query?.matches ?? false);
  useEffect(() => {
    if (!query) return undefined;
    const on = () => setNarrow(query.matches);
    query.addEventListener?.('change', on);
    return () => query.removeEventListener?.('change', on);
  }, []);
  return narrow;
}

/** An upload as a row at the top of the list: name, progress, and what can be done. */
function UploadRow({ api, job, onResume, onCancel, onDiscard }) {
  const t = api.i18n.t;
  const locale = api.i18n.getLocale();
  const status = job.state === 'running'
    ? h(Stack, { gap: 1 },
      t('files.statusProgress', { loaded: formatSize(job.loaded, locale), total: formatSize(job.total, locale) }),
      h(ProgressBar, { value: job.total ? job.loaded / job.total : null, label: job.file.name }))
    : job.state === 'paused' ? t('files.statusPaused')
      : job.state === 'done' ? t('files.statusDone')
        : errorText(t, job.error);
  const actions = job.state === 'running'
    ? h(RowAction, { icon: 'x', label: t('common.cancel'), onClick: () => onCancel(job) })
    : job.state === 'done'
      ? h(RowAction, { icon: 'x', label: t('files.discard'), onClick: () => onDiscard(job) })
      : [
        h(RowAction, { key: 'resume', icon: 'player-play', label: t('files.resume'), onClick: () => onResume(job) }),
        h(RowAction, { key: 'discard', icon: 'trash', label: t('files.discard'), danger: true, onClick: () => onDiscard(job) }),
      ];
  return h(ListRow, { title: job.file.name, icon: job.file.name, subtitle: status, actions });
}

export function FilesPage() {
  const api = getApi();
  const connection = useConnection(api);
  const client = useMemo(() => (connection.conn ? createClient(api, connection.conn) : null), [connection.conn]);
  if (connection.status !== 'connected' || !client) {
    return h(Page, { flush: true }, h(ConnectionEmpty, { api, connection }));
  }
  return h(FilesBrowser, { api, client, connection });
}

function FilesBrowser({ api, client, connection }) {
  const t = api.i18n.t;
  const narrow = useNarrow();
  const [path, setPath] = useState('/');
  const [selected, setSelected] = useState(() => new Map());
  const [reloadKey, setReloadKey] = useState(0);
  const [jobs, setJobs] = useState([]);
  const [busy, setBusy] = useState(null);
  const [dragging, setDragging] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const inputRef = useRef(null);
  const controllers = useRef(new Map());
  // The proxy can reject simultaneous browser uploads. Keep one in flight.
  const pendingUploads = useRef(new Set());
  const uploadQueue = useRef(Promise.resolve());
  const browser = useBrowser({ api, client, path, reloadKey, onError: connection.report });

  const fail = (err) => {
    if (err instanceof NcError && err.code === 'cancelled') return;
    connection.report(err);
    api.toast.error(errorText(t, err));
  };
  const navigate = (p) => { setPath(p); setSelected(new Map()); };
  const update = (id, patch) => setJobs((list) => list.map((j) => (j.id === id ? { ...j, ...patch } : j)));

  const runJob = async (job) => {
    const controller = new AbortController();
    controllers.current.set(job.id, controller);
    update(job.id, { state: 'running', error: null });
    try {
      const target = job.target ?? await planUpload(client, job.folder, job.file.name);
      update(job.id, { target });
      await uploadFile(api, client, job.file, target, {
        signal: controller.signal,
        onProgress: (loaded, total) => update(job.id, { loaded, total }),
      });
      update(job.id, { state: 'done', loaded: job.file.size });
      setReloadKey((k) => k + 1);
    } catch (err) {
      if (err instanceof NcError && err.code === 'cancelled') update(job.id, { state: 'paused' });
      else { connection.report(err); update(job.id, { state: 'error', error: err }); }
    } finally {
      controllers.current.delete(job.id);
    }
  };

  const enqueueUpload = (job) => {
    if (pendingUploads.current.has(job.id) || controllers.current.has(job.id)) return;
    pendingUploads.current.add(job.id);
    uploadQueue.current = uploadQueue.current.catch(() => {}).then(() => {
      if (!pendingUploads.current.delete(job.id)) return; // Cancelled while waiting.
      return runJob(job);
    });
  };

  const addFiles = (files) => {
    const added = [...files].map((file) => ({ id: `${Date.now()}-${Math.random()}`, file, folder: path, state: 'running', loaded: 0, total: file.size }));
    setJobs((list) => [...list.filter((j) => j.state !== 'done'), ...added]);
    for (const job of added) enqueueUpload(job);
  };

  const run = async (kind, fn) => {
    setBusy(kind);
    try { await fn(); } catch (err) { fail(err); } finally { setBusy(null); }
  };

  const newFolder = () => run('folder', async () => {
    const created = await createFolder(api, client, path);
    if (created) { browser.showView('files'); navigate(created); setReloadKey((k) => k + 1); }
  });

  const share = async (entry) => {
    await api.ui.openDialog({ title: t('share.title', { name: entry.name }), slot: 'plugin-dialog', extraProps: { view: 'share', path: entry.path, name: entry.name }, width: 520 });
  };

  const showAccount = async () => {
    await api.ui.openDialog({ title: t('settings.title'), slot: 'plugin-dialog', extraProps: { view: 'account' }, width: 520 });
    await connection.refresh();
  };

  const current = [...selected.values()][0] ?? null;
  const file = current && !current.isFolder ? current : null;

  let toolbar;
  if (file) {
    // Like the Files app's selection toolbar.
    toolbar = h(Toolbar, null,
      h(ToolbarButton, { icon: 'x', label: t('files.clearSelection'), compact: true, onClick: () => setSelected(new Map()) }),
      h(Text, { weight: 'medium', truncate: true }, file.name),
      canDownload(file)
        ? h(ToolbarButton, { icon: 'download', label: t('files.download'), compact: narrow, busy: busy === 'download', disabled: !!busy, onClick: () => void run('download', () => downloadToComputer(api, client, file)) })
        : null,
      h(ToolbarButton, { icon: 'share-2', label: t('files.share'), compact: narrow, disabled: !!busy, onClick: () => void share(file) }),
      h(ToolbarButton, { icon: 'paperclip', label: t('files.attachNew'), compact: narrow, busy: busy === 'attach', disabled: !!busy, onClick: () => void run('attach', () => attachToNewMessage(api, client, file)) }),
      h(ToolbarButton, { icon: 'external-link', label: t('files.open'), compact: true, onClick: () => void api.ui.openExternalUrl(client.webUrl(file)) }),
      h(ToolbarSpacer, null));
  } else if (narrow && searchOpen) {
    toolbar = h(Toolbar, null,
      ...browserBar({ api, browser, path, onNavigate: navigate, compact: true }).slice(1, 2),
      h(ToolbarButton, { icon: 'x', label: t('common.close'), compact: true, onClick: () => { browser.setQuery(''); setSearchOpen(false); } }));
  } else {
    const [crumbs, search, recent] = browserBar({ api, browser, path, onNavigate: navigate, compact: true });
    toolbar = h(Toolbar, null,
      crumbs,
      narrow ? h(ToolbarButton, { key: 'search', icon: 'search', label: t('browser.search'), compact: true, onClick: () => setSearchOpen(true) }) : search,
      recent,
      h(ToolbarButton, { icon: 'upload', label: t('files.upload'), compact: narrow, onClick: () => inputRef.current?.click() }),
      h(ToolbarButton, { icon: 'folder-plus', label: t('save.newFolder'), compact: true, busy: busy === 'folder', onClick: () => void newFolder() }),
      narrow ? null : h(ToolbarButton, { icon: 'refresh', label: t('files.refresh'), compact: true, busy: browser.loading, onClick: browser.reload }),
      h(ToolbarButton, { icon: 'user-circle', label: accountName(connection.conn), compact: narrow, onClick: () => void showAccount() }));
  }

  const uploads = jobs.map((job) => h(UploadRow, {
    key: job.id, api, job,
    onCancel: (j) => {
      if (pendingUploads.current.delete(j.id)) update(j.id, { state: 'paused' });
      else controllers.current.get(j.id)?.abort();
    },
    onResume: (j) => enqueueUpload(jobs.find((x) => x.id === j.id) ?? j),
    onDiscard: async (j) => {
      pendingUploads.current.delete(j.id);
      const latest = jobs.find((x) => x.id === j.id) ?? j;
      if (latest.state !== 'done' && latest.target) await discardUpload(api, client, latest.file, latest.target).catch(() => {});
      setJobs((list) => list.filter((x) => x.id !== j.id));
    },
  }));

  const empty = h(EmptyState, {
    icon: path === '/' ? 'upload' : 'folder-open',
    title: t('browser.empty'),
    description: t('files.uploadHint'),
    actions: [
      h(Button, { key: 'upload', size: 'sm', icon: 'upload', onClick: () => inputRef.current?.click() }, t('files.upload')),
      h(Button, { key: 'folder', size: 'sm', variant: 'secondary', icon: 'folder-plus', onClick: () => void newFolder() }, t('save.newFolder')),
    ],
  });

  return h('div', {
    onDragOver: (e) => { if (e.dataTransfer?.types?.includes('Files')) { e.preventDefault(); setDragging(true); } },
    onDragLeave: () => setDragging(false),
    onDrop: (e) => { e.preventDefault(); setDragging(false); if (e.dataTransfer?.files?.length) addFiles(e.dataTransfer.files); },
  },
  h(Page, { flush: true },
    h('input', {
      ref: inputRef, type: 'file', multiple: true, hidden: true, 'aria-hidden': 'true', tabIndex: -1,
      'data-testid': 'nc-upload-input',
      onChange: (e) => { if (e.target.files?.length) addFiles(e.target.files); e.target.value = ''; },
    }),
    toolbar,
    dragging ? h(Alert, { tone: 'info', icon: 'upload' }, t('files.uploadHint')) : null,
    h(BrowserList, {
      api, browser, mode: 'manage', selected, columns: true, empty,
      before: uploads.length ? uploads : null,
      onNavigate: navigate,
      onToggle: (entry) => setSelected((prev) => (prev.has(entry.path) ? new Map() : new Map([[entry.path, entry]]))),
    })));
}
