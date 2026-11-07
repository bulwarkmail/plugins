// The banner across the top of the app: the kit's one-line info bar in the
// warning tone, with its buttons as bar buttons: "Return to my account" when
// the host can take the admin back to the account that opened the
// impersonation, and the platform button. Colours come from the app's
// theme, like every other info bar.

import * as React from 'react';
import { BarButton, InfoBar } from '@plugin-host/ui';

const h = React.createElement;

export const RETURN_TO_ACCOUNT_LABEL = 'Return to my account';

export function ImpersonationBar({
  mailbox, actorRoleLabel, returnLabel, showReturn, busy, onReturn,
  showReturnToAccount = false, returningToAccount = false, onReturnToAccount,
}) {
  return h('div', { role: 'status', 'aria-live': 'polite' },
    h(InfoBar, {
      compact: true,
      tone: 'warning',
      icon: 'spy',
      title: h(React.Fragment, null, 'You are viewing ', h('strong', null, mailbox), ` ${actorRoleLabel}`),
    },
    showReturnToAccount
      ? h(BarButton, { icon: 'arrow-back-up', busy: returningToAccount, disabled: busy, onClick: onReturnToAccount }, RETURN_TO_ACCOUNT_LABEL)
      : null,
    showReturn ? h(BarButton, { icon: 'arrow-left', busy, disabled: returningToAccount, onClick: onReturn }, returnLabel) : null));
}
