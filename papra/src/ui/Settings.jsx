import { useEffect, useState } from 'react';
import { Button, Loading, Section, SettingRow, Select, Stack } from '@plugin-host/ui';
import { getApi, t, hostOf } from './host.js';
import { ErrorAlert, connectIntro, useConnect, useConnection } from './common.jsx';
import { PERSONAL, chooseOrganization, rememberOrganization, storedOrganization } from '../lib/connection.js';

/** The plugin's page in Settings: the connection and the organization to use. */
export function Settings() {
  const { connection, client, loading, refresh } = useConnection();
  const { busy, error: connectError, connect } = useConnect(connection, () => refresh());
  const [organizations, setOrganizations] = useState([]);
  const [organizationId, setOrganizationId] = useState('');
  const [error, setError] = useState(null);
  const api = getApi();

  useEffect(() => {
    if (!client) return;
    (async () => {
      try {
        const list = await client.organizations();
        setOrganizations(list);
        setOrganizationId(chooseOrganization(list, await storedOrganization(api)));
      } catch (err) {
        setError(err);
      }
    })();
  }, [client]); // eslint-disable-line react-hooks/exhaustive-deps

  const disconnect = async () => {
    await api.proxy.disconnect(PERSONAL).catch(() => {});
    setOrganizations([]);
    setError(null);
    await refresh();
  };

  const pick = (id) => {
    setOrganizationId(id);
    void rememberOrganization(api, id);
  };

  const host = connection?.base ? hostOf(connection.base) : '';
  const intro = t('settings.intro', { attach: t('composer.attach_menu'), save: t('save.action'), message: t('save.message_action') });
  return (
    <Stack gap={6}>
      <Section title={t('settings.title')} description={intro}>
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
          <div>
            <SettingRow label={t('settings.connection')} description={t('settings.connected', { host })}>
              <Button variant="secondary" onClick={disconnect}>{t('settings.disconnect')}</Button>
            </SettingRow>
            {organizations.length > 1 && (
              <SettingRow label={t('settings.organization')} description={t('settings.organization_hint')}>
                <Select value={organizationId} onChange={pick} options={organizations.map((o) => ({ value: o.id, label: o.name }))} aria-label={t('settings.organization')} />
              </SettingRow>
            )}
          </div>
        )}
        <ErrorAlert error={error} />
      </Section>
    </Stack>
  );
}
