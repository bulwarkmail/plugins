import { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, Button, EmptyState, LinkButton, Stack } from '@plugin-host/ui';
import { getApi, t, hostOf } from './host.js';
import { clientFor, connectPersonal, resolveConnection } from '../lib/connection.js';
import { errorText } from '../lib/errors.js';

/** The connection, resolved once per mount; `refresh` re-checks it. */
export function useConnection() {
  const [connection, setConnection] = useState(null);
  const [loading, setLoading] = useState(true);
  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setConnection(await resolveConnection(getApi()));
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);
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
  const intro = connection?.suggestedServer
    ? t('connect.intro_server', { host: hostOf(connection.suggestedServer) })
    : t('connect.intro');
  return `${intro} ${t('connect.key_hint')}`;
}

/** "Connect Immich" for a user without a connection. */
export function ConnectEmptyState({ connection, onConnected }) {
  const { busy, error, connect } = useConnect(connection, onConnected);
  return (
    <Stack gap={4}>
      <EmptyState
        icon="photo"
        title={t('connect.title')}
        description={connectIntro(connection)}
        actions={<Button busy={busy} onClick={connect}>{t('connect.button')}</Button>}
      />
      <ErrorAlert error={error} />
    </Stack>
  );
}
