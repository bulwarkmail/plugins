// Area "context" of the 2.2 work: its part of the plugin's settings (see src/lib/areas/README.md).
//
// What the assistant may read besides the open message, each with its own
// switch: attachments, pictures, the whole conversation. Shown only where
// the webmail offers the call (older webmails don't).

import { Section, SettingRow, Stack, Switch, Text } from '@plugin-host/ui';
import { has } from '../../lib/caps.js';
import { canSeeImages } from '../../lib/areas/context.js';

/** Shown after the standing instructions; null shows nothing. Props: { api, setup, prefs, savePrefs }. */
export function ContextSection({ api, setup, prefs = {}, savePrefs }) {
  const t = api.i18n.t;
  const reads = has(api, 'attachmentText', 'email.getAttachmentText');
  const looks = has(api, 'attachmentImages', 'email.getAttachmentImage');
  const thread = has(api, 'threads', 'email.getThread');
  if (!reads && !looks && !thread) return null;
  const endpoint = setup?.endpoint ?? null;
  const own = !!endpoint?.own;
  const sees = canSeeImages(setup?.config ?? {}, endpoint, prefs);
  const attachmentsOn = prefs.ctxAttachments !== false;
  const save = (patch) => void savePrefs(patch);
  return (
    <Section title={t('ctx.settings.title')} description={t('ctx.settings.hint')}>
      <Stack gap={0}>
        {(reads || looks) && (
          <SettingRow label={t('ctx.settings.attachments')} description={t('ctx.settings.attachments_hint')} htmlFor="ai-ctx-attachments">
            <Switch id="ai-ctx-attachments" label={t('ctx.settings.attachments')} checked={attachmentsOn} onChange={(on) => save({ ctxAttachments: on })} />
          </SettingRow>
        )}
        {looks && own && (
          <SettingRow label={t('ctx.settings.own_images')} description={t('ctx.settings.own_images_hint')} htmlFor="ai-ctx-own-images">
            <Switch id="ai-ctx-own-images" label={t('ctx.settings.own_images')} checked={sees} onChange={(on) => save({ ownImages: on })} />
          </SettingRow>
        )}
        {looks && sees && (
          <SettingRow label={t('ctx.settings.images')} description={t('ctx.settings.images_hint')} htmlFor="ai-ctx-images">
            <Switch id="ai-ctx-images" label={t('ctx.settings.images')} checked={attachmentsOn && prefs.ctxImages !== false} disabled={!attachmentsOn} onChange={(on) => save({ ctxImages: on })} />
          </SettingRow>
        )}
        {looks && sees && (
          <SettingRow label={t('ctx.settings.photo_details')} description={t('ctx.settings.photo_details_hint')} htmlFor="ai-ctx-photo-details">
            <Switch id="ai-ctx-photo-details" label={t('ctx.settings.photo_details')} checked={attachmentsOn && prefs.ctxImages !== false && prefs.ctxPhotoDetails === true} disabled={!attachmentsOn || prefs.ctxImages === false} onChange={(on) => save({ ctxPhotoDetails: on })} />
          </SettingRow>
        )}
        {looks && !sees && endpoint && !own && <Text tone="muted" size="xs">{t('ctx.settings.no_images')}</Text>}
        {thread && (
          <SettingRow label={t('ctx.settings.thread')} description={t('ctx.settings.thread_hint')} htmlFor="ai-ctx-thread">
            <Switch id="ai-ctx-thread" label={t('ctx.settings.thread')} checked={prefs.ctxThread !== false} onChange={(on) => save({ ctxThread: on })} />
          </SettingRow>
        )}
      </Stack>
    </Section>
  );
}
