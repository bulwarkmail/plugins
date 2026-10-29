import { useEffect, useState } from 'react';
import { Badge, BarButton, InfoBar, Row, Text } from '@plugin-host/ui';
import { getApi, i18n } from './host.js';
import { candidates, findInvoice } from '../lib/detect.js';
import { formatName, oneLine } from '../lib/present.js';
import { checkInvoice } from '../lib/check.js';
import { forwardToAccounting, forwardedInfo, messageKey } from '../lib/forward.js';
import { EINVOICE_KEYWORD, rememberNoInvoice, knownNoInvoice } from '../lib/scan-cache.js';

export function openInvoiceDialog(api, { invoice, source, email }) {
  return api.ui.openDialog({
    title: api.i18n.t('dialog.title'),
    slot: 'plugin-dialog',
    width: 880,
    extraProps: { invoice, source, email: email ? { id: email.id, accountId: email.accountId, subject: email.subject } : null },
  });
}

/** Tag the message so the list shows a badge and the E-invoices filter finds it. */
export function tagInvoice(api, email) {
  if (api.plugin.settings?.tagMessages === false) return;
  if ((email.keywords || []).includes(EINVOICE_KEYWORD)) return;
  void Promise.resolve(api.email.setKeyword(email.id, EINVOICE_KEYWORD, email.accountId)).catch(() => {});
}

/** The info bar above an open message that holds an e-invoice. */
export function Banner({ email }) {
  const api = getApi();
  const { t, has, locale } = i18n();
  const [found, setFound] = useState(null);
  const [forwarded, setForwarded] = useState(null);
  const [busy, setBusy] = useState(false);
  const attachmentKey = (email?.attachments || []).map((a) => a.blobId).join(',');

  useEffect(() => {
    setFound(null);
    setForwarded(null);
    if (!email || candidates(email.attachments).length === 0) return undefined;
    let live = true;
    (async () => {
      if (await knownNoInvoice(api.storage, messageKey(email), attachmentKey)) return;
      const result = await findInvoice(email.attachments, async (blobId) => (await api.email.getAttachment(email.id, blobId, email.accountId)).data);
      if (!live) return;
      if (!result) {
        await rememberNoInvoice(api.storage, messageKey(email), attachmentKey);
        return;
      }
      setFound(result);
      setForwarded(await forwardedInfo(api.storage, email));
      tagInvoice(api, email);
    })().catch(() => {});
    return () => { live = false; };
  }, [email?.id, email?.accountId, attachmentKey]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!found) return null;
  const { invoice, source } = found;
  const warnings = checkInvoice(invoice).filter((c) => c.level === 'warning').length;

  const forward = async () => {
    setBusy(true);
    try {
      if (await forwardToAccounting(api, { email, invoice, source }) === 'sent') setForwarded(await forwardedInfo(api.storage, email));
    } finally {
      setBusy(false);
    }
  };
  const show = async () => {
    await openInvoiceDialog(api, { invoice, source, email });
    // The dialog may have forwarded it.
    setForwarded(await forwardedInfo(api.storage, email));
  };

  return (
    <InfoBar icon="file-invoice" tone="info" eyebrow={formatName(invoice, source)} title={oneLine(invoice, { t, has, locale })}>
      <Row gap={2}>
        <BarButton icon="file-invoice" onClick={() => void show()}>{t('banner.show')}</BarButton>
        <BarButton icon="mail-forward" busy={busy} onClick={() => void forward()}>
          {forwarded ? t('banner.forward_again') : t('banner.forward')}
        </BarButton>
        {forwarded && <Text tone="muted" size="xs">{t('banner.forwarded', { address: forwarded.to, date: new Date(forwarded.at).toLocaleDateString(locale) })}</Text>}
        {warnings > 0 && <Badge tone="warning">{t('banner.warnings', { count: warnings })}</Badge>}
      </Row>
    </InfoBar>
  );
}
