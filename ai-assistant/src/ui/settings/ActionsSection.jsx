// Area "actions" of the 2.2 work: its part of the plugin's settings (see src/lib/areas/README.md).
//
// A switch per group of actions (prefs.doActions), shown only where the
// webmail offers the host calls. Settings changes stay off and greyed out
// unless the administrator allows them (allowSettingsChanges).

import { useMemo } from 'react';
import { Section, SettingRow, Stack, Switch, Text } from '@plugin-host/ui';
import { ACTION_GROUPS, groupOn, groupsOffered } from '../../lib/areas/actions.js';
import { effectiveActionMode } from '../../lib/actions.js';
import { areaAllowed, batchLimit, settingsChangesAllowed } from '../../lib/config.js';

/** Shown after the standing instructions; null shows nothing. Props: { api, setup, prefs, savePrefs }. */
export function ActionsSection({ api, setup, prefs = {}, savePrefs }) {
  const t = api.i18n.t;
  const config = setup?.config ?? {};
  const offered = useMemo(() => groupsOffered(api), [api]);
  const groups = Object.keys(ACTION_GROUPS).filter((group) => offered[group]);
  // Nothing to switch when the webmail offers none of the calls or the admin turned the area off.
  if (!groups.length || !areaAllowed(config, 'actions')) return null;
  const adminAllowsSettings = settingsChangesAllowed(config);
  const actionsOff = effectiveActionMode(config, prefs) === 'off';

  const toggle = (group, on) => savePrefs({ doActions: { ...(prefs.doActions ?? {}), [group]: on } });

  return (
    <Section title={t('do.settings.title')} description={t('do.settings.hint')}>
      <Stack gap={0}>
        {actionsOff && <Text tone="muted" size="xs" data-testid="ai-do-actions-off">{t('do.settings.actions_off')}</Text>}
        {groups.map((group) => {
          const locked = group === 'settings' && !adminAllowsSettings;
          const id = `ai-do-${group}`;
          const hint = locked ? t('do.settings.settings_admin') : t(`do.settings.${group}_hint`, { limit: batchLimit(config) });
          return (
            <SettingRow key={group} label={t(`do.settings.${group}`)} description={hint} htmlFor={id}>
              <Switch
                id={id}
                label={t(`do.settings.${group}`)}
                checked={!locked && groupOn(prefs, group)}
                disabled={locked}
                onChange={(on) => void toggle(group, on)}
              />
            </SettingRow>
          );
        })}
      </Stack>
    </Section>
  );
}
