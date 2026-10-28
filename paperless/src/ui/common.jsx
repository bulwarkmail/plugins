import { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, Badge, Button, Combobox, EmptyState, Field, LinkButton, Stack } from '@plugin-host/ui';
import { getApi, t, hostOf } from './host.js';
import { clientFor, connectPersonal, resolveConnection } from '../lib/connection.js';
import { errorText } from '../lib/errors.js';

/** The connection, resolved once per mount; `refresh` re-checks it. */
export function useConnection(initial) {
  const [connection, setConnection] = useState(initial || null);
  const [loading, setLoading] = useState(!initial);
  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setConnection(await resolveConnection(getApi()));
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { if (!initial) void refresh(); }, [initial, refresh]);
  const client = useMemo(() => (connection?.state === 'connected' ? clientFor(getApi(), connection) : null), [connection]);
  return { connection, client, loading, refresh };
}

/** An error in the app's error bar, with "Retry" when there is something to retry. */
export function ErrorAlert({ error, onRetry }) {
  if (!error) return null;
  return (
    <Alert tone="danger" icon="alert-circle" action={onRetry ? <LinkButton onClick={onRetry}>{t('common.retry')}</LinkButton> : null}>
      {errorText(t, error)}
    </Alert>
  );
}

/** Runs the host's "Connect" dialog. */
export function useConnect(connection, onConnected) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const connect = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await connectPersonal(getApi(), connection?.suggestedServer || '');
      if (result.connected) onConnected?.(result.connection);
      else if (result.error) setError(result.error);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, connect };
}

export function connectIntro(connection) {
  return connection?.suggestedServer
    ? t('connect.intro_server', { host: hostOf(connection.suggestedServer) })
    : t('connect.intro');
}

/** "Connect Paperless" for a user without a connection, as the Files app's empty state. */
export function ConnectEmptyState({ connection, onConnected }) {
  const { busy, error, connect } = useConnect(connection, onConnected);
  return (
    <Stack gap={4}>
      <EmptyState
        icon="archive"
        title={t('connect.title')}
        description={`${connectIntro(connection)} ${t('connect.token_hint')}`}
        actions={<Button busy={busy} onClick={connect}>{t('connect.button')}</Button>}
      />
      <ErrorAlert error={error} />
    </Stack>
  );
}

/** A searchable combobox over Paperless objects, with an empty "none" entry. */
export function PickOne({ label, items, value, onChange, noneLabel, suggested, block = true, placeholder }) {
  const options = useMemo(() => [
    { value: '', label: noneLabel || t('common.none') },
    ...(items || []).map((it) => ({ value: String(it.id), label: it.name })),
  ], [items, noneLabel]);

  const handleChange = useCallback((v) => {
    onChange?.(v === '' ? null : Number(v));
  }, [onChange]);

  const strValue = value == null ? '' : String(value);
  const fieldLabel = suggested ? <>{label} <Badge tone="success">{t('send.suggested')}</Badge></> : label;

  return (
    <Field label={fieldLabel}>
      <Combobox
        block={block}
        value={strValue}
        onChange={handleChange}
        options={options}
        placeholder={placeholder || noneLabel || t('common.none')}
      />
    </Field>
  );
}


/** Tags selector using multiselect Combobox. */
export function TagPicker({ tags, value = [], onChange, label }) {
  const options = useMemo(() => (tags || []).map((t) => ({ value: String(t.id), label: t.name })), [tags]);
  const stringValues = useMemo(() => (value || []).map(String), [value]);
  const handleChange = useCallback((newVals) => {
    onChange?.(newVals.map(Number));
  }, [onChange]);
  const name = label || t('field.tags');
  if (!tags?.length) return null;
  return (
    <Field label={name}>
      <Combobox
        multiple
        block
        options={options}
        value={stringValues}
        onChange={handleChange}
        placeholder={name}
      />
    </Field>
  );
}

/** The taxonomies of a client, loaded once. */
export function useTaxonomies(client) {
  const [tax, setTax] = useState(null);
  const [error, setError] = useState(null);
  const load = useCallback(async () => {
    if (!client) return;
    setError(null);
    try {
      setTax(await client.taxonomies());
    } catch (err) {
      setError(err);
    }
  }, [client?.base, client?.credentialId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { void load(); }, [load]);
  return { tax, error, reload: load };
}
