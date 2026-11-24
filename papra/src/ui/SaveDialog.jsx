import { useState } from 'react';
import { DialogButtons, Stack, Text } from '@plugin-host/ui';
import { t } from './host.js';
import { OrganizationPicker } from './Picker.jsx';

/**
 * "Save to Papra" when the user is in several organizations: which one.
 * Resolves the dialog with { organizationId }, or null when cancelled.
 */
export function SaveDialog({ kind, name, organizations = [], organizationId, onResult }) {
  const [value, setValue] = useState(organizationId || organizations[0]?.id || '');
  return (
    <Stack gap={4}>
      <Text>{kind === 'message' ? t('save.intro_message') : t('save.intro_attachment', { name })}</Text>
      <OrganizationPicker organizations={organizations} value={value} onChange={setValue} />
      <DialogButtons
        buttons={[
          { id: 'cancel', label: t('common.cancel'), variant: 'secondary' },
          { id: 'save', label: t('save.button'), variant: 'primary', disabled: !value },
        ]}
        onClick={(id) => onResult?.(id === 'save' ? { organizationId: value } : null)}
      />
    </Stack>
  );
}
