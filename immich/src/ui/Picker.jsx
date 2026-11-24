import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button, DialogButtons, EmptyState, Loading, Row, SearchInput, Select, Spinner, Stack, Text } from '@plugin-host/ui';
import { getApi, t, formatDate } from './host.js';
import { ConnectEmptyState, ErrorAlert, useConnection } from './common.jsx';
import { attachAssets } from '../lib/media.js';
import { createQueue } from '../lib/queue.js';

/** Wait this long after the last key press before searching. */
const SEARCH_DELAY_MS = 300;

/** One photo or video as a tile: its thumbnail, a tick when picked. */
function Tile({ asset, picked, onToggle, load }) {
  const [url, setUrl] = useState(null);
  useEffect(() => {
    let made = null;
    let cancelled = false;
    load(asset.id).then((thumb) => {
      if (cancelled || !thumb) return;
      made = URL.createObjectURL(new Blob([thumb.data], { type: thumb.type }));
      setUrl(made);
    }).catch(() => { /* no thumbnail: the name stands alone */ });
    return () => { cancelled = true; if (made) URL.revokeObjectURL(made); };
  }, [asset.id, load]);
  const label = [asset.name, asset.kind === 'video' ? t('picker.video') : '', formatDate(asset.takenAt)].filter(Boolean).join(', ');
  return (
    <button
      type="button"
      aria-pressed={picked}
      aria-label={label}
      title={label}
      onClick={onToggle}
      style={{
        position: 'relative', aspectRatio: '1 / 1', padding: 0, overflow: 'hidden', cursor: 'pointer', borderRadius: 6,
        border: picked ? '3px solid var(--color-primary)' : '1px solid var(--color-border)', background: 'var(--color-muted)',
      }}
    >
      {url
        ? <img src={url} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
        : <span style={{ fontSize: 12, color: 'var(--color-muted-foreground)', padding: 4, wordBreak: 'break-all' }}>{asset.name}</span>}
      {asset.kind === 'video' && (
        <span aria-hidden="true" style={{ position: 'absolute', insetInlineStart: 4, bottom: 4, fontSize: 11, padding: '1px 5px', borderRadius: 4, background: 'rgba(0,0,0,.6)', color: '#fff' }}>
          {t('picker.video')}
        </span>
      )}
    </button>
  );
}

/**
 * The "From Immich" dialog: search or pick an album, tick photos and videos,
 * attach them to the composer `composerId`. `onClose(count)` says how many
 * went into the message.
 */
export function Picker({ composerId, onClose }) {
  const { connection, client, loading, refresh } = useConnection();
  const [albums, setAlbums] = useState([]);
  const [text, setText] = useState('');
  const [albumId, setAlbumId] = useState('');
  const [items, setItems] = useState([]);
  const [nextPage, setNextPage] = useState(null);
  const [searching, setSearching] = useState(false);
  const [searched, setSearched] = useState(false);
  const [error, setError] = useState(null);
  const [picked, setPicked] = useState(() => new Map());
  const [busy, setBusy] = useState('');
  const attachedCount = useRef(0);
  const abortRef = useRef(null);
  const queue = useMemo(() => createQueue(4), [client]); // eslint-disable-line react-hooks/exhaustive-deps
  const api = getApi();

  const loadThumb = useCallback((id) => queue.run(() => client.thumbnail(id)), [client, queue]);

  useEffect(() => {
    if (!client) return;
    client.albums().then(setAlbums).catch(() => setAlbums([]));
  }, [client]);

  // Only the latest search may fill the grid.
  const seq = useRef(0);
  const run = useCallback(async (pageNumber, q, album) => {
    if (!client) return;
    const mine = ++seq.current;
    setSearching(true);
    setError(null);
    try {
      const res = await client.assets({ text: q, albumId: album, pageNumber });
      if (mine !== seq.current) return;
      setItems((prev) => (pageNumber === 1 ? res.items : [...prev, ...res.items]));
      setNextPage(res.nextPage);
      setSearched(true);
    } catch (err) {
      if (mine === seq.current) setError(err);
    } finally {
      if (mine === seq.current) setSearching(false);
    }
  }, [client]);

  // Typing waits for a pause; another album loads at once.
  const shownAlbum = useRef(null);
  useEffect(() => {
    if (!client) return undefined;
    const typed = searched && shownAlbum.current === albumId;
    shownAlbum.current = albumId;
    const timer = setTimeout(() => { void run(1, text, albumId); }, typed ? SEARCH_DELAY_MS : 0);
    return () => clearTimeout(timer);
  }, [client, text, albumId]); // eslint-disable-line react-hooks/exhaustive-deps

  const close = () => onClose?.(attachedCount.current);
  const toggle = (asset) => setPicked((prev) => {
    const next = new Map(prev);
    if (next.has(asset.id)) next.delete(asset.id); else next.set(asset.id, asset);
    return next;
  });

  const attach = async () => {
    const assets = [...picked.values()];
    if (!assets.length) return;
    const controller = new AbortController();
    abortRef.current = controller;
    setError(null);
    setBusy(t('picker.attaching', { current: 1, total: assets.length }));
    try {
      await attachAssets(api, client, composerId, assets, {
        signal: controller.signal,
        onProgress: (i, n) => setBusy(t('picker.attaching', { current: i + 1, total: n })),
        // What is in the message leaves the selection, so trying again doesn't attach it twice.
        onAttached: (asset) => {
          attachedCount.current++;
          setPicked((prev) => { const next = new Map(prev); next.delete(asset.id); return next; });
        },
      });
      close();
    } catch (err) {
      if (err?.key !== 'error.cancelled') setError(err);
    } finally {
      abortRef.current = null;
      setBusy('');
    }
  };

  if (loading) return <Loading label={t('common.loading')} />;
  if (connection?.state !== 'connected') return <ConnectEmptyState connection={connection} onConnected={() => refresh()} />;

  const albumOptions = [{ value: '', label: t('picker.all') }, ...albums.map((a) => ({ value: a.id, label: a.name }))];
  return (
    <Stack gap={4}>
      <div role="search">
        <Row gap={2}>
          <SearchInput value={text} onChange={setText} label={t('picker.search_label')} placeholder={t('picker.search_placeholder')} />
          {albums.length > 0 && (
            <Select value={albumId} onChange={(v) => setAlbumId(v)} options={albumOptions} aria-label={t('picker.album')} />
          )}
        </Row>
      </div>
      <ErrorAlert error={error} />
      {busy && <Spinner label={busy} />}
      <div aria-live="polite">
        <Text tone="muted" size="xs">{searching ? t('picker.searching') : t('picker.selected', { count: picked.size })}</Text>
      </div>
      {searched && items.length === 0 && !searching && !error && <EmptyState compact icon="photo" title={t('picker.none')} />}
      {items.length > 0 && (
        <div role="group" aria-label={t('picker.results')} style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(104px, 1fr))', gap: 6 }}>
          {items.map((asset) => (
            <Tile key={asset.id} asset={asset} picked={picked.has(asset.id)} onToggle={() => toggle(asset)} load={loadThumb} />
          ))}
        </div>
      )}
      {nextPage && (
        <Row>
          <Button variant="secondary" busy={searching} onClick={() => run(nextPage, text, albumId)}>{t('picker.more')}</Button>
        </Row>
      )}
      <DialogButtons
        buttons={[
          { id: 'cancel', label: t('common.cancel'), variant: 'secondary' },
          { id: 'attach', label: picked.size ? t('picker.attach_count', { count: picked.size }) : t('picker.attach'), variant: 'primary', disabled: picked.size === 0, busy: !!busy },
        ]}
        onClick={(id) => {
          if (id === 'cancel') {
            if (abortRef.current) abortRef.current.abort();
            else close();
          } else if (id === 'attach') void attach();
        }}
      />
    </Stack>
  );
}
