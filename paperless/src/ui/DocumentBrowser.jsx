import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Button, DialogButtons, EmptyState, Field, Heading, Input, LinkButton, List, ListRow, Loading, Page, PageHeader, Row, RowAction,
  SearchInput, Spinner, Stack, Text,
} from '@plugin-host/ui';
import { getApi, t, formatDate } from './host.js';
import { ConnectEmptyState, ErrorAlert, PickOne, TagPicker, useConnection, useTaxonomies } from './common.jsx';
import { attachDocuments, downloadDocument } from '../lib/documents.js';

const nameOf = (list, id) => list?.find((x) => x.id === id)?.name || '';
const EMPTY_FILTERS = { text: '', tags: [], correspondent: null, documentType: null, from: '', to: '' };
/** Wait this long after the last key press before searching. */
const SEARCH_DELAY_MS = 300;
/** On a phone the app's own header above the page already names it. */
const PHONE = '(max-width: 640px)';

function usePhone() {
  const query = typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia(PHONE) : null;
  const [phone, setPhone] = useState(() => query?.matches ?? false);
  useEffect(() => {
    if (!query) return undefined;
    const on = () => setPhone(query.matches);
    query.addEventListener?.('change', on);
    return () => query.removeEventListener?.('change', on);
  }, []);
  return phone;
}

/** The image itself for picture documents, else Paperless' thumbnail of the first page. */
function Preview({ client, doc }) {
  const [url, setUrl] = useState(null);
  useEffect(() => {
    let made = null;
    let cancelled = false;
    if (!client) return undefined;
    const load = /^image\//.test(doc.mime_type || '') ? client.preview(doc.id) : client.thumbnail(doc.id);
    load.then((p) => {
      if (cancelled) return;
      made = URL.createObjectURL(new Blob([p.data], { type: p.type }));
      setUrl(made);
    }).catch(() => { /* no preview: the details stand alone */ });
    return () => { cancelled = true; if (made) URL.revokeObjectURL(made); };
  }, [client, doc.id, doc.mime_type]);
  if (!url) return null;
  return (
    <img
      src={url}
      alt={t('browse.preview_of', { title: doc.title })}
      style={{ display: 'block', width: 240, maxWidth: '100%', height: 'auto', borderRadius: 6, border: '1px solid var(--color-border)' }}
    />
  );
}

function Fact({ label, children }) {
  return (
    <Stack gap={0}>
      <Text size="xs" tone="muted">{label}</Text>
      <Text>{children || '-'}</Text>
    </Stack>
  );
}

/** One document: preview, details and text. The buttons sit in the page header or the dialog footer. */
function DocumentDetails({ client, doc, tax }) {
  const lines = String(doc.content || '').slice(0, 2000).split('\n').map((l) => l.trim()).filter(Boolean);
  const tagNames = (doc.tags || []).map((id) => nameOf(tax?.tags, id)).filter(Boolean).join(', ');
  return (
    <Stack gap={6}>
      <Row gap={6} align="start">
        <Preview client={client} doc={doc} />
        <Stack gap={3}>
          <Fact label={t('field.correspondent')}>{nameOf(tax?.correspondents, doc.correspondent)}</Fact>
          <Fact label={t('field.document_type')}>{nameOf(tax?.documentTypes, doc.document_type)}</Fact>
          <Fact label={t('field.created')}>{formatDate(doc.created)}</Fact>
          <Fact label={t('field.tags')}>{tagNames}</Fact>
          <Fact label={t('field.file')}>{doc.original_file_name}</Fact>
        </Stack>
      </Row>
      {lines.length > 0 && (
        <div role="region" aria-label={t('browse.text')}>
          <Stack gap={2}>
            <Heading level={4}>{t('browse.text')}</Heading>
            <Stack gap={1}>
              {lines.map((line, i) => <Text key={i} tone="muted">{line}</Text>)}
            </Stack>
          </Stack>
        </div>
      )}
    </Stack>
  );
}

/**
 * Search Paperless and use documents in mail. The app page (Page with a
 * header, at the app's content width) and the "Browse documents" dialog
 * (the same content, its buttons in the dialog footer).
 */
export function DocumentBrowser({ onClose, inDialog = false }) {
  const { connection, client, loading, refresh } = useConnection();
  const { tax } = useTaxonomies(client);
  const [filters, setFilters] = useState(EMPTY_FILTERS);
  const [showFilters, setShowFilters] = useState(false);
  const [results, setResults] = useState([]);
  const [count, setCount] = useState(0);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [searching, setSearching] = useState(false);
  const [searched, setSearched] = useState(false);
  const [error, setError] = useState(null);
  const [open, setOpen] = useState(null);
  const [picked, setPicked] = useState(() => new Set());
  const [busy, setBusy] = useState('');
  const phone = usePhone();
  const api = getApi();

  // Only the latest search may fill the list: an earlier, slower one must
  // not overwrite it.
  const seq = useRef(0);
  const run = useCallback(async (nextPage, f) => {
    if (!client) return;
    const mine = ++seq.current;
    setSearching(true);
    setError(null);
    try {
      const res = await client.searchDocuments(f, nextPage);
      if (mine !== seq.current) return;
      setResults((prev) => (nextPage === 1 ? res.results : [...prev, ...res.results]));
      setCount(res.count);
      setHasMore(res.hasMore);
      setPage(nextPage);
      setSearched(true);
    } catch (err) {
      if (mine === seq.current) setError(err);
    } finally {
      if (mine === seq.current) setSearching(false);
    }
  }, [client]);

  // Search as the user types or changes a filter, like the Files app's search box.
  const filterKey = JSON.stringify(filters);
  useEffect(() => {
    if (!client) return undefined;
    const timer = setTimeout(() => { void run(1, filters); }, searched ? SEARCH_DELAY_MS : 0);
    return () => clearTimeout(timer);
  }, [client, filterKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const set = (patch) => { setOpen(null); setFilters((prev) => ({ ...prev, ...patch })); };
  const pickedDocs = results.filter((d) => picked.has(d.id));
  const filtered = filters.tags.length > 0 || filters.correspondent != null || filters.documentType != null || !!filters.from || !!filters.to;

  const attach = async (docs) => {
    setBusy(t('common.working'));
    setError(null);
    try {
      await attachDocuments(api, client, docs, (i, n) => setBusy(t('browse.attaching', { current: i + 1, total: n })));
      if (inDialog) onClose?.();
    } catch (err) {
      setError(err);
    } finally {
      setBusy('');
    }
  };

  const download = async (doc) => {
    setBusy(t('common.working'));
    setError(null);
    try {
      await downloadDocument(api, client, doc);
    } catch (err) {
      setError(err);
    } finally {
      setBusy('');
    }
  };

  const openInPaperless = (doc) => { void api.ui.openExternalUrl(client.documentUrl(doc.id)); };
  const togglePick = (id) => setPicked((prev) => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  const wrap = (header, body) => (inDialog
    ? <Stack gap={4}>{body}</Stack>
    : <Page wide>{header}{body}</Page>);
  const pageHeader = (actions) => (phone
    ? actions && <Row>{actions}</Row>
    : <PageHeader title={t('page.title')} icon="archive" actions={actions} />);

  if (loading) return wrap(pageHeader(), <Loading label={t('common.loading')} />);
  if (connection?.state === 'disconnected') {
    return wrap(pageHeader(), <ConnectEmptyState connection={connection} onConnected={() => refresh()} />);
  }
  if (connection?.state === 'error') {
    return wrap(pageHeader(), <ErrorAlert error={connection.error} onRetry={refresh} />);
  }

  const status = (
    <>
      <ErrorAlert error={error} />
      {busy && <Spinner size="sm" label={busy} />}
    </>
  );

  // ─── One document ───
  if (open) {
    const back = () => setOpen(null);
    const subtitle = [nameOf(tax?.correspondents, open.correspondent), formatDate(open.created)].filter(Boolean).join(' · ');
    if (inDialog) {
      return (
        <Stack gap={4}>
          <Stack gap={1}>
            <Heading level={3}>{open.title}</Heading>
            {subtitle && <Text tone="muted">{subtitle}</Text>}
          </Stack>
          {status}
          <DocumentDetails client={client} doc={open} tax={tax} />
          <DialogButtons
            buttons={[
              { id: 'back', label: t('browse.back'), variant: 'secondary' },
              { id: 'open', label: t('browse.open_in_paperless'), variant: 'secondary' },
              { id: 'download', label: t('browse.download'), variant: 'secondary', disabled: !!busy },
              { id: 'attach', label: t('browse.attach'), variant: 'primary', busy: !!busy },
            ]}
            onClick={(id) => {
              if (id === 'back') back();
              else if (id === 'open') openInPaperless(open);
              else if (id === 'download') void download(open);
              else if (id === 'attach') void attach([open]);
            }}
          />
        </Stack>
      );
    }
    return (
      <Page wide>
        <Row>
          <Button variant="ghost" size="sm" icon="arrow-left" onClick={back}>{t('browse.back')}</Button>
        </Row>
        <PageHeader
          title={open.title}
          description={subtitle}
          actions={(
            <>
              <Button variant="secondary" icon="external-link" onClick={() => openInPaperless(open)}>{t('browse.open_in_paperless')}</Button>
              <Button variant="secondary" icon="download" disabled={!!busy} onClick={() => download(open)}>{t('browse.download')}</Button>
              <Button icon="paperclip" busy={!!busy} onClick={() => attach([open])}>{t('browse.attach')}</Button>
            </>
          )}
        />
        {status}
        <DocumentDetails client={client} doc={open} tax={tax} />
      </Page>
    );
  }

  // ─── The list ───
  const selectionActions = picked.size > 0 && (
    <>
      <Button variant="ghost" onClick={() => setPicked(new Set())}>{t('browse.clear_selection')}</Button>
      <Button icon="paperclip" busy={!!busy} disabled={pickedDocs.length === 0} onClick={() => attach(pickedDocs)}>
        {t('browse.attach_count', { count: picked.size })}
      </Button>
    </>
  );

  const body = (
    <Stack gap={4}>
      <div role="search">
        <Row gap={2}>
          <SearchInput value={filters.text} onChange={(text) => set({ text })} label={t('browse.search_label')} placeholder={t('browse.search_placeholder')} />
          <Button variant={showFilters || filtered ? 'secondary' : 'ghost'} icon="filter" aria-expanded={showFilters} onClick={() => setShowFilters((v) => !v)}>
            {t('browse.filters')}
          </Button>
        </Row>
      </div>
      {showFilters && tax && (
        <Stack gap={4}>
          <Row gap={4} align="start">
            <PickOne label={t('field.correspondent')} items={tax.correspondents} value={filters.correspondent} block={false}
              onChange={(v) => set({ correspondent: v })} noneLabel={t('common.any')} />
            <PickOne label={t('field.document_type')} items={tax.documentTypes} value={filters.documentType} block={false}
              onChange={(v) => set({ documentType: v })} noneLabel={t('common.any')} />
            <Field label={t('browse.from')}>
              <Input type="date" value={filters.from} onChange={(e) => set({ from: e.target.value })} />
            </Field>
            <Field label={t('browse.to')}>
              <Input type="date" value={filters.to} onChange={(e) => set({ to: e.target.value })} />
            </Field>
          </Row>
          <TagPicker tags={tax.tags} value={filters.tags} onChange={(v) => set({ tags: v })} label={t('browse.with_tags')} />
          {filtered && (
            <Row>
              <LinkButton icon="x" onClick={() => set({ ...EMPTY_FILTERS, text: filters.text })}>{t('browse.clear_filters')}</LinkButton>
            </Row>
          )}
        </Stack>
      )}
      {status}
      <div aria-live="polite">
        <Text tone="muted" size="xs">
          {searching ? t('browse.searching') : picked.size > 0 ? `${t('browse.count', { count })} · ${t('browse.selected', { count: picked.size })}` : t('browse.count', { count })}
        </Text>
      </div>
      {searched && results.length === 0 && !searching && !error && (
        <EmptyState compact icon="file-search" title={t('browse.none')} />
      )}
      {results.length > 0 && (
        <List label={t('browse.results')}>
          {results.map((doc) => (
            <ListRow
              key={doc.id}
              icon={doc.original_file_name || `${doc.title}.pdf`}
              title={doc.title}
              subtitle={[
                nameOf(tax?.correspondents, doc.correspondent),
                nameOf(tax?.documentTypes, doc.document_type),
                ...(doc.tags || []).map((id) => nameOf(tax?.tags, id)),
              ].filter(Boolean).join(' · ')}
              meta={[formatDate(doc.created)]}
              checked={picked.has(doc.id)}
              onCheck={() => togglePick(doc.id)}
              onClick={() => setOpen(doc)}
              actions={(
                <>
                  <RowAction icon="external-link" label={t('browse.open_in_paperless')} onClick={() => openInPaperless(doc)} />
                  <RowAction icon="download" label={t('browse.download')} onClick={() => download(doc)} />
                </>
              )}
            />
          ))}
        </List>
      )}
      {hasMore && (
        <Row>
          <Button variant="secondary" busy={searching} onClick={() => run(page + 1, filters)}>{t('browse.more')}</Button>
        </Row>
      )}
      {inDialog && (
        <DialogButtons
          buttons={[
            { id: 'cancel', label: t('common.cancel'), variant: 'secondary' },
            { id: 'attach', label: picked.size ? t('browse.attach_count', { count: picked.size }) : t('browse.attach'), variant: 'primary', disabled: pickedDocs.length === 0, busy: !!busy },
          ]}
          onClick={(id) => {
            if (id === 'cancel') onClose?.();
            else if (id === 'attach') void attach(pickedDocs);
          }}
        />
      )}
    </Stack>
  );

  return wrap(pageHeader(selectionActions || null), body);
}
