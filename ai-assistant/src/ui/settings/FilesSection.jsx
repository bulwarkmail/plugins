// Area "files" of the 2.2 work: its part of the plugin's settings (see src/lib/areas/README.md).
//
// Two switches: finding and reading files (and attaching them), and saving
// and creating them. Shown only where the webmail offers Files to plugins
// and the administrator left the area on.

import { Section, SettingRow, Stack, Switch } from '@plugin-host/ui';
import { filesFlags } from '../../lib/areas/files.js';

/** Shown after the standing instructions; null shows nothing. Props: { api, setup, prefs, savePrefs }. */
export function FilesSection({ api, setup, prefs = {}, savePrefs }) {
  const t = api.i18n.t;
  // On here means offered: the user's own switches are shown as they are.
  if (!filesFlags(api, { config: setup?.config ?? {} }).on) return null;
  const save = (patch) => void savePrefs(patch);
  return (
    <Section title={t('files.settings.title')} description={t('files.settings.hint')}>
      <Stack gap={0}>
        <SettingRow label={t('files.settings.read')} description={t('files.settings.read_hint')} htmlFor="ai-files-read">
          <Switch id="ai-files-read" label={t('files.settings.read')} checked={prefs.filesRead !== false} onChange={(on) => save({ filesRead: on })} />
        </SettingRow>
        <SettingRow label={t('files.settings.write')} description={t('files.settings.write_hint')} htmlFor="ai-files-write">
          <Switch id="ai-files-write" label={t('files.settings.write')} checked={prefs.filesWrite !== false} onChange={(on) => save({ filesWrite: on })} />
        </SettingRow>
      </Stack>
    </Section>
  );
}
