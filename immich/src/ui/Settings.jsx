import { useEffect, useState } from 'react';
import { Button, Loading, Section, SettingRow, Stack } from '@plugin-host/ui';
import { getApi, t, hostOf } from './host.js';
import { ErrorAlert, connectIntro, useConnect, useConnection } from './common.jsx';
import { PERSONAL } from '../lib/connection.js';

/** The plugin's page in Settings: connect or disconnect the Immich account. */
export function Settings() {
  const { connection, client, loading, refresh } = useConnection();
  const { busy, error: connectError, connect } = useConnect(connection, () => refresh());
  const [who, setWho] = useState('');
  const [error, setError] = useState(null);
  const api = getApi();

  useEffect(() => {
    if (!client) return;
    client.whoAmI().then((w) => setWho(w.email || w.name)).catch((err) => setError(err));
  }, [client]);

  const disconnect = async () => {
    await api.proxy.disconnect(PERSONAL).catch(() => {});
    setWho('');
    setError(null);
    await refresh();
  };

  const host = connection?.base ? hostOf(connection.base) : '';
  return (
    <Stack gap={6}>
      <Section title={t('settings.title')} description={t('settings.intro', { attach: t('composer.attach_menu'), save: t('save.action') })}>
        {loading && <Loading />}
        {!loading && connection?.state === 'disconnected' && (
          <>
            <SettingRow label={t('settings.connection')} description={connectIntro(connection)}>
              <Button busy={busy} onClick={connect}>{t('connect.button')}</Button>
            </SettingRow>
            <ErrorAlert error={connectError} />
          </>
        )}
        {!loading && connection?.state === 'connected' && (
          <SettingRow label={t('settings.connection')} description={who ? t('settings.connected_as', { host, user: who }) : t('settings.connected', { host })}>
            <Button variant="secondary" onClick={disconnect}>{t('settings.disconnect')}</Button>
          </SettingRow>
        )}
        <ErrorAlert error={error} />
      </Section>
    </Stack>
  );
}
