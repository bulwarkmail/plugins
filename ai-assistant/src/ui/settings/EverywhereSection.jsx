// Area "everywhere" of the 2.2 work: its part of the plugin's settings (see
// src/lib/areas/README.md). Shown only when the admin left the area on.

import { Section, SettingRow, Stack, Switch, Text } from '@plugin-host/ui';
import { has } from '../../lib/caps.js';

/** Shown after the standing instructions; null shows nothing. Props: { api, setup, prefs, savePrefs }. */
export function EverywhereSection({ api, prefs = {}, savePrefs }) {
  const t = api.i18n.t;
  const sidePanel = has(api, 'sidePanel');
  // The webmail has the panel, but this copy of the plugin may not use it
  // yet: it was turned on before an update asked for the permission.
  const needsGrant = api.host?.features?.sidePanel === false;
  const threads = has(api, 'threads', 'email.getThread');
  const catchUp = prefs.catchUp !== false;
  return (
    <Section title={t('view.settings.title')}>
      <Stack gap={3}>
        {needsGrant && <div data-everywhere-grant><Text tone="muted" size="sm">{t('view.settings.grant', { place: `${t('app.nav.settings')} > ${t('app.settings.addons')}` })}</Text></div>}
        {/* The panel in the other views needs a webmail that has it, and the permission. */}
        {sidePanel && (
          <SettingRow label={t('view.settings.everywhere')} description={t('view.settings.everywhere_hint')} htmlFor="ai-everywhere">
            <Switch id="ai-everywhere" label={t('view.settings.everywhere')} checked={prefs.everywhere !== false} onChange={(on) => void savePrefs({ everywhere: on })} />
          </SettingRow>
        )}
        <SettingRow label={t('brief.settings.catch_up')} description={t('brief.settings.catch_up_hint')} htmlFor="ai-catch-up">
          <Switch id="ai-catch-up" label={t('brief.settings.catch_up')} checked={catchUp} onChange={(on) => void savePrefs({ catchUp: on })} />
        </SettingRow>
        {catchUp && threads && (
          <SettingRow label={t('brief.settings.waiting')} description={t('brief.settings.waiting_hint')} htmlFor="ai-brief-waiting">
            <Switch id="ai-brief-waiting" label={t('brief.settings.waiting')} checked={prefs.briefWaiting !== false} onChange={(on) => void savePrefs({ briefWaiting: on })} />
          </SettingRow>
        )}
      </Stack>
    </Section>
  );
}
