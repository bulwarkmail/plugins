// The plugin's section in Settings: which service is used, the privacy
// note, the model, and connecting the user's own key when allowed.

import { useCallback, useEffect, useState } from 'react';
import { Alert, Button, Field, Input, Loading, Row, Section, Select, SettingRow, Stack, Switch, Text, Textarea } from '@plugin-host/ui';
import { useApi } from './common.jsx';
import { loadSetup, savePrefs, PROVIDER_LABELS } from '../lib/assistant.js';
import { ACTION_MODES, effectiveActionMode } from '../lib/actions.js';
import { MAX_INSTRUCTIONS_CHARS } from '../lib/prompts.js';
import { AREA_SECTIONS } from './settings/index.js';
import {
  DEFAULT_MODELS, OFFICIAL_BASE_URLS, OWN_CREDENTIALS, PROVIDERS,
  adminProviders, areaAllowed, hostOf, normalizeBaseUrl, userKeysAllowed,
} from '../lib/config.js';

export function SettingsPanel(props) {
  const api = useApi(props);
  const t = api.i18n.t;
  const [setup, setSetup] = useState(null);
  const [model, setModel] = useState('');
  const [instructions, setInstructions] = useState('');
  const [ownProvider, setOwnProvider] = useState('openai');
  const [ownUrl, setOwnUrl] = useState(OFFICIAL_BASE_URLS.openai);
  const [ownModel, setOwnModel] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');

  const reload = useCallback(async () => {
    const next = await loadSetup(api);
    setSetup(next);
    setModel(next.prefs.model ?? '');
    setInstructions(next.prefs.instructions ?? '');
    const own = next.prefs.own ?? {};
    if (PROVIDERS.includes(own.provider)) setOwnProvider(own.provider);
    if (own.baseUrl) setOwnUrl(own.baseUrl);
    setOwnModel(own.model ?? '');
  }, [api]);

  useEffect(() => { void reload(); }, [reload]);

  if (!setup) return <Loading label={t('common.loading')} />;

  const { config, prefs, accounts, endpoint } = setup;
  const admin = adminProviders(config);
  const allowOwn = userKeysAllowed(config);
  const ownAccount = accounts.find((a) => a.credentialId === OWN_CREDENTIALS[ownProvider] && a.connected);
  const usingOwn = !!endpoint?.own;
  // What the administrator allows at most.
  const actionLimit = ACTION_MODES.includes(config.actions) ? config.actions : 'auto';

  const save = async (patch, { quiet = false } = {}) => {
    await savePrefs(api, patch);
    await reload();
    setProblem('');
    if (!quiet) api.toast.success(t('settings.saved'));
  };

  const connect = async () => {
    const baseUrl = normalizeBaseUrl(ownUrl);
    if (!baseUrl) {
      setProblem(t('settings.bad_url'));
      return;
    }
    setBusy(true);
    setProblem('');
    try {
      const result = await api.proxy.connect(OWN_CREDENTIALS[ownProvider], { mode: 'password', server: baseUrl });
      if (result?.connected) {
        await save({ useOwn: true, own: { provider: ownProvider, baseUrl, model: ownModel.trim() } }, { quiet: true });
        api.toast.success(t('settings.connected', { host: hostOf(result.origin ?? baseUrl) }));
      }
    } catch {
      setProblem(t('settings.connect_failed'));
    } finally {
      setBusy(false);
    }
  };

  const disconnect = async () => {
    setBusy(true);
    try {
      await api.proxy.disconnect(OWN_CREDENTIALS[ownProvider]);
      await save({ useOwn: false }, { quiet: true });
      api.toast.success(t('settings.disconnected'));
    } finally {
      setBusy(false);
    }
  };

  const status = endpoint
    ? t(usingOwn ? 'settings.status_own' : 'settings.status_admin', {
      provider: PROVIDER_LABELS[endpoint.provider], host: hostOf(endpoint.baseUrl), model: endpoint.model,
    })
    : t(allowOwn ? 'settings.not_set_up_own' : 'settings.not_set_up');
  const adminModel = endpoint?.provider ? (admin.find((p) => p.provider === endpoint.provider)?.model || DEFAULT_MODELS[endpoint.provider]) : '';

  return (
    <Stack gap={6}>
      <Section title={t('settings.service')} description={<span data-testid="ai-status">{status}</span>}>
        <Text tone="muted" size="xs">{t('settings.privacy')}</Text>
        <Stack gap={0}>
          {admin.length > 1 && !usingOwn && (
            <SettingRow label={t('settings.provider')} htmlFor="ai-provider">
              <Select
                id="ai-provider"
                value={endpoint?.provider ?? admin[0].provider}
                options={admin.map((p) => ({ value: p.provider, label: `${PROVIDER_LABELS[p.provider]} (${hostOf(p.baseUrl)})` }))}
                onChange={(value) => void save({ provider: value })}
              />
            </SettingRow>
          )}
          {admin.length > 0 && !usingOwn && (
            <SettingRow label={t('settings.model')} description={t('settings.model_hint')} htmlFor="ai-model">
              <Row wrap={false}>
                <Input id="ai-model" value={model} placeholder={adminModel} onChange={(e) => setModel(e.target.value)} />
                <Button variant="secondary" onClick={() => void save({ model: model.trim() })}>{t('settings.save')}</Button>
              </Row>
            </SettingRow>
          )}
          <SettingRow label={t('settings.show_in_reader')} description={t('settings.show_in_reader_hint')} htmlFor="ai-reader">
            <Switch
              id="ai-reader"
              label={t('settings.show_in_reader')}
              checked={prefs.showInReader !== false}
              onChange={(on) => void save({ showInReader: on })}
            />
          </SettingRow>
          <SettingRow label={t('settings.lookups')} description={t('settings.lookups_hint')} htmlFor="ai-lookups">
            <Switch
              id="ai-lookups"
              label={t('settings.lookups')}
              checked={prefs.lookups !== false}
              onChange={(on) => void save({ lookups: on })}
            />
          </SettingRow>
          {actionLimit !== 'off' && (
            <SettingRow label={t('settings.actions')} description={t('settings.actions_hint')} htmlFor="ai-actions">
              <Select
                id="ai-actions"
                aria-label={t('settings.actions')}
                value={effectiveActionMode(config, prefs)}
                options={ACTION_MODES.slice(0, ACTION_MODES.indexOf(actionLimit) + 1).map((m) => ({ value: m, label: t(`settings.actions_${m}`) }))}
                onChange={(value) => void save({ actions: value })}
              />
            </SettingRow>
          )}
        </Stack>
      </Section>

      <Section title={t('settings.instructions')} description={t('settings.instructions_hint')}>
        <Stack gap={3}>
          {String(config.instructions ?? '').trim() && (
            <Field label={t('settings.instructions_admin')}>
              <Text tone="muted" className="whitespace-pre-wrap" data-testid="ai-admin-instructions">{String(config.instructions).trim()}</Text>
            </Field>
          )}
          <Field label={t('settings.instructions_mine')} hint={t('settings.instructions_example')}>
            <Textarea
              rows={4}
              maxLength={MAX_INSTRUCTIONS_CHARS}
              value={instructions}
              aria-label={t('settings.instructions_mine')}
              onChange={(e) => setInstructions(e.target.value)}
            />
          </Field>
          <Row>
            <Button variant="secondary" disabled={instructions === (prefs.instructions ?? '')} onClick={() => void save({ instructions: instructions.trim() })}>{t('settings.save')}</Button>
          </Row>
        </Stack>
      </Section>

      {/* The 2.2 areas' settings (src/ui/settings), each only when the admin left its area on. */}
      {AREA_SECTIONS.filter(([area]) => areaAllowed(config, area)).map(([area, AreaSection]) => (
        <AreaSection key={area} api={api} setup={setup} prefs={prefs} savePrefs={save} />
      ))}

      {allowOwn && (
        <Section title={t('settings.own_title')} description={t('settings.own_hint')}>
          <Stack gap={4}>
            <Field label={t('settings.provider')}>
              <Select
                block
                value={ownProvider}
                disabled={usingOwn}
                options={PROVIDERS.map((p) => ({ value: p, label: PROVIDER_LABELS[p] }))}
                onChange={(value) => {
                  setOwnProvider(value);
                  setOwnUrl(OFFICIAL_BASE_URLS[value]);
                }}
              />
            </Field>
            <Field label={t('settings.address')}>
              <Input value={ownUrl} disabled={usingOwn} onChange={(e) => setOwnUrl(e.target.value)} inputMode="url" />
            </Field>
            <Field label={t('settings.model')}>
              <Input value={ownModel} placeholder={DEFAULT_MODELS[ownProvider]} onChange={(e) => setOwnModel(e.target.value)} />
            </Field>
            {problem && <Alert tone="danger">{problem}</Alert>}
            <Row>
              {usingOwn || ownAccount ? (
                <>
                  <Button
                    variant="secondary"
                    disabled={busy}
                    onClick={() => void save({ useOwn: true, own: { provider: ownProvider, baseUrl: normalizeBaseUrl(ownUrl) ?? OFFICIAL_BASE_URLS[ownProvider], model: ownModel.trim() } })}
                  >
                    {t('settings.save')}
                  </Button>
                  <Button variant="secondary" busy={busy} onClick={() => void disconnect()}>{t('settings.disconnect')}</Button>
                </>
              ) : (
                <Button busy={busy} onClick={() => void connect()}>{t('settings.connect')}</Button>
              )}
            </Row>
          </Stack>
        </Section>
      )}
      {!allowOwn && problem && <Alert tone="danger">{problem}</Alert>}
    </Stack>
  );
}
