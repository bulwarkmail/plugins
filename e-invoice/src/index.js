// E-invoices for Bulwark: XRechnung and ZUGFeRD / Factur-X shown as a
// readable invoice, and forwarded to accounting in one click.

import { setApi } from './ui/host.js';
import { Banner, openInvoiceDialog, tagInvoice } from './ui/Banner.jsx';
import { InvoiceView } from './ui/InvoiceView.jsx';
import { createBackground } from './lib/background.js';

let background = null;

export async function activate(api) {
  setApi(api);
  background = createBackground(api, {
    openDialog: (props) => openInvoiceDialog(api, props),
    tag: (email) => tagInvoice(api, email),
  });
  await background.registerUi();
  api.i18n.onLocaleChange(() => { void background.registerUi(); });
  api.plugin.onSettingsChange(() => { void background.registerUi(); });
}

// Hooks answer at once; the work runs on (the host gives up on slow hooks
// and turns off plugins whose hooks keep failing).
export const hooks = {
  onAction(event) {
    if (background) void background.onAction(event);
  },
  onNewEmailReceived(email) {
    if (background) void background.onNewEmail(email);
  },
  onEmailListItemRender(badges, context) {
    return background ? background.badges(badges, context) : undefined;
  },
};

export const slots = {
  'email-banner': {
    component: Banner,
    // The banner reads the attachments; without any there is nothing to do.
    shouldShow: ({ email }) => !!email && (email.hasAttachment || (email.attachments || []).length > 0),
  },
  'plugin-dialog': { component: InvoiceView },
};
