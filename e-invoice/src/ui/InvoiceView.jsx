import { useEffect, useMemo, useState } from 'react';
import {
  Alert, Badge, DetailHeading, DetailList, DetailRow, DialogButtons, LinkButton, Row, Stack, Table, Text,
} from '@plugin-host/ui';
import { getApi, i18n } from './host.js';
import { present, formatName } from '../lib/present.js';
import { checkInvoice } from '../lib/check.js';
import { printHtml } from '../lib/print.js';
import { currentAddress, forwardToAccounting, forwardedInfo } from '../lib/forward.js';

const preLine = { whiteSpace: 'pre-line' };

function fromBase64(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function Party({ title, party }) {
  if (!party) return null;
  return (
    <Stack gap={1}>
      <DetailHeading>{title}</DetailHeading>
      <Text weight="medium">{party.name}</Text>
      {party.lines.map((line, i) => <Text key={i} tone="muted">{line}</Text>)}
      {party.details.length > 0 && (
        <div style={{ marginTop: 6 }}>
          <DetailList>
            {party.details.map((d) => <DetailRow key={d.label} label={d.label}>{d.value}</DetailRow>)}
          </DetailList>
        </div>
      )}
    </Stack>
  );
}

/** A message from the checks, in the user's language. */
function checkText(t, c, fmt) {
  const vars = { ...c.vars };
  if (Array.isArray(vars.fields)) vars.fields = vars.fields.map((f) => t(`field.${f}`)).join(', ');
  if (typeof vars.expected === 'number') vars.expected = fmt(vars.expected, vars.currency);
  if (typeof vars.actual === 'number') vars.actual = fmt(vars.actual, vars.currency);
  return t(`check.${c.id}`, vars);
}

/**
 * The readable invoice, in the plugin's dialog. `email` is { id, accountId,
 * subject }; `invoice` and `source` come from detect.findInvoice.
 */
export function InvoiceView({ invoice, source, email, onResult }) {
  const api = getApi();
  const { t, has, locale } = i18n();
  const p = useMemo(() => present(invoice, { t, has, locale, source }), [invoice, source, locale]); // eslint-disable-line react-hooks/exhaustive-deps
  const checks = useMemo(() => checkInvoice(invoice), [invoice]);
  const [forwarded, setForwarded] = useState(null);
  const [busy, setBusy] = useState(false);
  const [address, setAddress] = useState('');

  useEffect(() => {
    if (!email) return;
    void forwardedInfo(api.storage, email).then(setForwarded);
    void currentAddress(api).then(setAddress);
  }, [email?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const forward = async () => {
    setBusy(true);
    try {
      const outcome = await forwardToAccounting(api, { email, invoice, source });
      if (outcome === 'sent') setForwarded(await forwardedInfo(api.storage, email));
      setAddress(await currentAddress(api));
    } finally {
      setBusy(false);
    }
  };

  const print = () => {
    void Promise.resolve(api.ui.print({
      title: `${p.title} ${p.number}`.trim(),
      html: printHtml(p, t, { generatedFrom: t('print.footer', { format: formatName(invoice, source), file: source?.embeddedName || source?.name || '' }) }),
    })).catch((err) => api.toast.error(err?.message || String(err)));
  };

  const download = (a) => {
    void Promise.resolve(api.ui.downloadFile({ content: fromBase64(a.base64), filename: a.name, contentType: a.mimeType || 'application/octet-stream' }))
      .catch((err) => api.toast.error(t('attachment.download_failed', { error: err?.message || String(err) })));
  };

  const columns = [
    { key: 'position', label: t('col.pos'), hideNarrow: true, width: '3rem' },
    { key: 'item', label: t('col.item') },
    { key: 'quantity', label: t('col.quantity'), align: 'end', hideNarrow: true },
    { key: 'unitPrice', label: t('col.unit_price'), align: 'end', hideNarrow: true },
    { key: 'vat', label: t('col.vat'), align: 'end', hideNarrow: true },
    { key: 'net', label: t('col.net'), align: 'end' },
  ];
  const rows = p.lines.map((l) => ({
    key: l.key,
    position: l.position,
    item: (
      <div style={l.sub ? { paddingInlineStart: 16 } : undefined}>
        <span>{l.name}</span>
        {l.details.map((d, i) => <Text key={i} size="xs" tone="muted"><span style={preLine}>{d}</span></Text>)}
      </div>
    ),
    quantity: l.quantity,
    unitPrice: l.unitPrice,
    vat: l.vat,
    net: l.net,
  }));

  const warnings = checks.filter((c) => c.level === 'warning');
  const infos = checks.filter((c) => c.level === 'info');
  const ok = checks.some((c) => c.level === 'ok');
  const fmtMoney = (n, cur) => {
    try { return new Intl.NumberFormat(locale, cur ? { style: 'currency', currency: cur } : {}).format(n); } catch { return String(n); }
  };

  const buttons = [
    { id: 'close', label: t('dialog.close'), variant: 'secondary' },
    { id: 'print', label: t('dialog.print'), variant: 'secondary' },
    ...(email ? [{ id: 'forward', label: forwarded ? t('dialog.forward_again') : t('dialog.forward'), variant: forwarded ? 'secondary' : 'primary', disabled: busy }] : []),
  ];
  const onButton = (id) => {
    if (id === 'close') onResult?.(null);
    else if (id === 'print') print();
    else if (id === 'forward') void forward();
  };

  return (
    <Stack gap={4}>
      <Stack gap={1}>
        <Row gap={2} align="baseline">
          <Text size="base" weight="semibold">{p.title} {p.number}</Text>
          {invoice.isCreditNote && <Badge tone="info">{t('badge.credit_note')}</Badge>}
        </Row>
        <Text tone="muted" size="xs">{formatName(invoice, source)}{source?.name ? ` · ${source.name}` : ''}</Text>
      </Stack>

      {(warnings.length > 0 || infos.length > 0 || ok || forwarded) && (
        <Stack gap={2}>
          {forwarded && <Alert tone="success" icon="mail-forward">{t('forward.already', { address: forwarded.to, date: new Date(forwarded.at).toLocaleString(locale) })}</Alert>}
          {warnings.map((c, i) => <Alert key={`w${i}`} tone="warning" icon="alert-triangle">{checkText(t, c, fmtMoney)}</Alert>)}
          {infos.map((c, i) => <Alert key={`i${i}`} tone="info" icon="info-circle">{checkText(t, c, fmtMoney)}</Alert>)}
          {ok && warnings.length === 0 && <Text tone="success" size="xs">{t('check.sums_ok')} {t('check.not_validation')}</Text>}
        </Stack>
      )}

      <Row fill gap={6} align="start">
        <Party title={t('section.seller')} party={p.seller} />
        <Party title={t('section.buyer')} party={p.buyer} />
      </Row>
      {(p.payee || p.shipTo) && (
        <Row fill gap={6} align="start">
          {p.payee ? <Party title={t('section.payee')} party={p.payee} /> : <div />}
          {p.shipTo ? <Party title={t('section.ship_to')} party={p.shipTo} /> : <div />}
        </Row>
      )}

      <Stack gap={1}>
        <DetailHeading>{t('section.details')}</DetailHeading>
        <DetailList>
          {p.facts.map((f) => <DetailRow key={f.label} label={f.label}>{f.value}</DetailRow>)}
        </DetailList>
      </Stack>

      <Stack gap={1}>
        <DetailHeading>{t('section.items')}</DetailHeading>
        {p.noLines && <Text tone="muted" size="xs">{t('items.none')}</Text>}
        <Table label={t('section.items')} columns={columns} rows={rows} summary={p.summary} />
      </Stack>

      {p.vatRows.length > 1 || p.vatRows.some((v) => v.reason) ? (
        <Stack gap={1}>
          <DetailHeading>{t('section.vat')}</DetailHeading>
          <Table
            label={t('section.vat')}
            columns={[
              { key: 'category', label: t('col.category') },
              { key: 'rate', label: t('col.rate'), align: 'end' },
              { key: 'basis', label: t('col.basis'), align: 'end' },
              { key: 'amount', label: t('col.vat_amount'), align: 'end' },
            ]}
            rows={p.vatRows.map((v) => ({ ...v, category: v.reason ? <div><span>{v.category}</span><Text size="xs" tone="muted">{v.reason}</Text></div> : v.category }))}
          />
        </Stack>
      ) : null}

      {p.payment.length > 0 && (
        <Stack gap={1}>
          <DetailHeading>{t('section.payment')}</DetailHeading>
          <DetailList>
            {p.payment.map((d, i) => (
              <DetailRow key={`${d.label}${i}`} label={d.label} mono={d.label === t('pay.iban') || d.label === t('pay.bic')}>
                <span style={preLine}>{d.value}</span>
              </DetailRow>
            ))}
          </DetailList>
        </Stack>
      )}

      {p.notes.length > 0 && (
        <Stack gap={1}>
          <DetailHeading>{t('section.notes')}</DetailHeading>
          {p.notes.map((n, i) => <Text key={i}><span style={preLine}>{n}</span></Text>)}
        </Stack>
      )}

      {p.attachments.length > 0 && (
        <Stack gap={1}>
          <DetailHeading>{t('section.attachments')}</DetailHeading>
          {p.attachments.map((a) => (
            <Row key={a.key} gap={2} justify="between">
              <Text truncate>{a.name}{a.description ? ` · ${a.description}` : ''}</Text>
              {a.base64 ? <LinkButton icon="download" onClick={() => download(a)}>{t('attachment.download')}</LinkButton> : <Text tone="muted" size="xs">{a.uri}</Text>}
            </Row>
          ))}
        </Stack>
      )}

      {email && address && <Text tone="muted" size="xs">{t('forward.goes_to', { address })}</Text>}
      <DialogButtons buttons={buttons} onClick={onButton} />
    </Stack>
  );
}
