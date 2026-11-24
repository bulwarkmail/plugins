import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Button, ColorDot, DialogButtons, EmptyState, Field, List, ListRow, Loading, Row, RowAction, SearchInput, Select, Spinner, Stack, Text,
} from '@plugin-host/ui';
import { getApi, t, formatDate } from './host.js';
import { ConnectEmptyState, ErrorAlert, useConnection } from './common.jsx';
import { attachDocuments } from '../lib/documents.js';
import { chooseOrganization, rememberOrganization, storedOrganization } from '../lib/connection.js';

/** Wait this long after the last key press before searching. */
const SEARCH_DELAY_MS = 300;

/** A document's tags, each with its colour when Papra has one. */
function Tags({ tags }) {
  if (!tags.length) return null;
  return (
    <span style={{ display: 'inline-flex', flexWrap: 'wrap', gap: 8 }}>
      {tags.map((tag) => (
        <span key={tag.id || tag.name} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          {tag.color && <ColorDot color={tag.color} />}
          {tag.name}
        </span>
      ))}
    </span>
  );
}

/** "Organization": a choice only when the user is in more than one. */
export function OrganizationPicker({ organizations, value, onChange }) {
  if (organizations.length < 2) return null;
  return (
    <Field label={t('settings.organization')}>
      <Select value={value} onChange={(v) => onChange(v)} options={organizations.map((o) => ({ value: o.id, label: o.name }))} />
    </Field>
  );
}

/**
 * The "From Papra" dialog: pick an organization, search, tick documents and
 * attach them to the composer `composerId`. `onClose(count)` says how many
 * went into the message.
 */
export function Picker({ composerId, onClose }) {
  const { connection, client, loading, refresh } = useConnection();
  const [organizations, setOrganizations] = useState(null);
  const [organizationId, setOrganizationId] = useState('');
  const [text, setText] = useState('');
  const [items, setItems] = useState([]);
  const [count, setCount] = useState(0);
  const [pageIndex, setPageIndex] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [searching, setSearching] = useState(false);
  const [searched, setSearched] = useState(false);
  const [error, setError] = useState(null);
  const [picked, setPicked] = useState(() => new Map());
  const [busy, setBusy] = useState('');
  const attachedCount = useRef(0);
  const abortRef = useRef(null);
  const api = getApi();

  useEffect(() => {
    if (!client) return;
    (async () => {
      try {
        const list = await client.organizations();
        setOrganizations(list);
        setOrganizationId(chooseOrganization(list, await storedOrganization(api)));
      } catch (err) {
        setOrganizations([]);
        setError(err);
      }
    })();
  }, [client]); // eslint-disable-line react-hooks/exhaustive-deps

  // Only the latest search may fill the list.
  const seq = useRef(0);
  const run = useCallback(async (index, q, orgId) => {
    if (!client || !orgId) return;
    const mine = ++seq.current;
    setSearching(true);
    setError(null);
    try {
      const res = await client.documents(orgId, { text: q, pageIndex: index });
      if (mine !== seq.current) return;
      setItems((prev) => (index === 0 ? res.items : [...prev, ...res.items]));
      setCount(res.count);
      setHasMore(res.hasMore);
      setPageIndex(index);
      setSearched(true);
    } catch (err) {
      if (mine === seq.current) setError(err);
    } finally {
      if (mine === seq.current) setSearching(false);
    }
  }, [client]);

  // Typing waits for a pause; another organization loads at once.
  const shownOrganization = useRef('');
  useEffect(() => {
    if (!client || !organizationId) return undefined;
    const typed = searched && shownOrganization.current === organizationId;
    shownOrganization.current = organizationId;
    const timer = setTimeout(() => { void run(0, text, organizationId); }, typed ? SEARCH_DELAY_MS : 0);
    return () => clearTimeout(timer);
  }, [client, text, organizationId]); // eslint-disable-line react-hooks/exhaustive-deps

  const close = () => onClose?.(attachedCount.current);
  const toggle = (doc) => setPicked((prev) => {
    const next = new Map(prev);
    if (next.has(doc.id)) next.delete(doc.id); else next.set(doc.id, doc);
    return next;
  });
  const switchOrganization = (id) => {
    setOrganizationId(id);
    setPicked(new Map());
    void rememberOrganization(api, id);
  };

  const attach = async () => {
    const docs = [...picked.values()];
    if (!docs.length) return;
    const controller = new AbortController();
    abortRef.current = controller;
    setError(null);
    setBusy(t('picker.attaching', { current: 1, total: docs.length }));
    try {
      await attachDocuments(api, client, organizationId, composerId, docs, {
        signal: controller.signal,
        onProgress: (i, n) => setBusy(t('picker.attaching', { current: i + 1, total: n })),
        // What is in the message leaves the selection, so trying again doesn't attach it twice.
        onAttached: (doc) => {
          attachedCount.current++;
          setPicked((prev) => { const next = new Map(prev); next.delete(doc.id); return next; });
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
  if (!organizations) return <Loading label={t('common.loading')} />;
  if (!organizations.length && !error) return <EmptyState icon="folder" title={t('error.no_organization')} />;

  return (
    <Stack gap={4}>
      <OrganizationPicker organizations={organizations} value={organizationId} onChange={switchOrganization} />
      <div role="search">
        <SearchInput value={text} onChange={setText} label={t('picker.search_label')} placeholder={t('picker.search_placeholder')} />
      </div>
      <ErrorAlert error={error} />
      {busy && <Spinner label={busy} />}
      <div aria-live="polite">
        <Text tone="muted" size="xs">
          {searching ? t('picker.searching') : picked.size > 0 ? `${t('picker.count', { count })} · ${t('picker.selected', { count: picked.size })}` : t('picker.count', { count })}
        </Text>
      </div>
      {searched && items.length === 0 && !searching && !error && <EmptyState compact icon="file-search" title={t('picker.none')} />}
      {items.length > 0 && (
        <List label={t('picker.results')}>
          {items.map((doc) => (
            <ListRow
              key={doc.id}
              icon={doc.name}
              title={doc.name}
              subtitle={<Tags tags={doc.tags} />}
              meta={[formatDate(doc.createdAt)]}
              checked={picked.has(doc.id)}
              onCheck={() => toggle(doc)}
              onClick={() => toggle(doc)}
              actions={<RowAction icon="external-link" label={t('picker.open')} onClick={() => { void api.ui.openExternalUrl(client.documentUrl(organizationId, doc.id)); }} />}
            />
          ))}
        </List>
      )}
      {hasMore && (
        <Row>
          <Button variant="secondary" busy={searching} onClick={() => run(pageIndex + 1, text, organizationId)}>{t('picker.more')}</Button>
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
