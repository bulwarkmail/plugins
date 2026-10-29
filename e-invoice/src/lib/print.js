// The invoice as a printable HTML page (api.ui.print), from present().
// Plain HTML with one style sheet: the host prints it without scripts and
// without loading anything.

const esc = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const lines = (s) => esc(s).replace(/\n/g, '<br>');

const STYLE = `
  .inv { font-size: 10pt; line-height: 1.4; color: #111; }
  .inv h1 { font-size: 16pt; margin: 0 0 2mm; }
  .inv h2 { font-size: 10pt; text-transform: uppercase; letter-spacing: .04em; color: #555; margin: 6mm 0 2mm; }
  .inv .parties { display: flex; gap: 8mm; margin-top: 4mm; }
  .inv .party { flex: 1; }
  .inv .party b { display: block; }
  .inv .muted { color: #555; }
  .inv dl { display: grid; grid-template-columns: 38mm 1fr; gap: 1mm 4mm; margin: 0; }
  .inv dt { color: #555; }
  .inv dd { margin: 0; }
  .inv table { width: 100%; border-collapse: collapse; margin-top: 2mm; }
  .inv th { text-align: start; font-weight: 600; border-bottom: 1px solid #999; padding: 1.5mm 2mm; font-size: 9pt; color: #333; }
  .inv td { padding: 1.5mm 2mm; border-bottom: 1px solid #ddd; vertical-align: top; }
  .inv .num { text-align: end; white-space: nowrap; font-variant-numeric: tabular-nums; }
  .inv .sub td:first-child { padding-inline-start: 6mm; }
  .inv .detail { color: #555; font-size: 9pt; }
  .inv tfoot td, .inv tfoot th { border: 0; padding: 1mm 2mm; font-weight: normal; }
  .inv tfoot .strong th, .inv tfoot .strong td { font-weight: 700; border-top: 1px solid #999; padding-top: 2mm; }
  .inv tr { break-inside: avoid; }
  .inv .footer { margin-top: 8mm; font-size: 8pt; color: #777; }
`;

function party(title, p) {
  if (!p) return '';
  const details = p.details.map((d) => `${esc(d.label)}: ${esc(d.value)}`).join('<br>');
  return `<div class="party"><h2>${esc(title)}</h2><b>${esc(p.name)}</b>${p.lines.map(esc).join('<br>')}${details ? `<div class="muted">${details}</div>` : ''}</div>`;
}

function list(items) {
  return `<dl>${items.map((i) => `<dt>${esc(i.label)}</dt><dd>${lines(i.value)}</dd>`).join('')}</dl>`;
}

/** `p` from present(), `t` for the headings. */
export function printHtml(p, t, { generatedFrom = '' } = {}) {
  const lineRows = p.lines.map((l) => `<tr class="${l.sub ? 'sub' : ''}">
    <td>${esc(l.position)}</td>
    <td>${esc(l.name)}${l.details.length ? `<div class="detail">${l.details.map(lines).join('<br>')}</div>` : ''}</td>
    <td class="num">${esc(l.quantity)}</td>
    <td class="num">${esc(l.unitPrice)}</td>
    <td class="num">${esc(l.vat)}</td>
    <td class="num">${esc(l.net)}</td>
  </tr>`).join('');
  const summary = p.summary.map((s) => `<tr class="${s.strong ? 'strong' : ''}"><th colspan="5" class="num">${esc(s.label)}</th><td class="num">${esc(s.value)}</td></tr>`).join('');
  const vat = p.vatRows.length ? `<h2>${esc(t('section.vat'))}</h2><table>
    <thead><tr><th>${esc(t('col.category'))}</th><th class="num">${esc(t('col.rate'))}</th><th class="num">${esc(t('col.basis'))}</th><th class="num">${esc(t('col.vat_amount'))}</th></tr></thead>
    <tbody>${p.vatRows.map((v) => `<tr><td>${esc(v.category)}${v.reason ? `<div class="detail">${esc(v.reason)}</div>` : ''}</td><td class="num">${esc(v.rate)}</td><td class="num">${esc(v.basis)}</td><td class="num">${esc(v.amount)}</td></tr>`).join('')}</tbody>
  </table>` : '';

  return `<style>${STYLE}</style><div class="inv">
  <h1>${esc(p.title)} ${esc(p.number)}</h1>
  <div class="parties">${party(t('section.seller'), p.seller)}${party(t('section.buyer'), p.buyer)}</div>
  ${p.payee || p.shipTo ? `<div class="parties">${party(t('section.payee'), p.payee)}${party(t('section.ship_to'), p.shipTo)}</div>` : ''}
  <h2>${esc(t('section.details'))}</h2>${list(p.facts)}
  <h2>${esc(t('section.items'))}</h2>
  ${p.noLines ? `<p class="muted">${esc(t('items.none'))}</p>` : ''}
  <table>
    ${p.noLines ? '' : `<thead><tr><th>${esc(t('col.pos'))}</th><th>${esc(t('col.item'))}</th><th class="num">${esc(t('col.quantity'))}</th><th class="num">${esc(t('col.unit_price'))}</th><th class="num">${esc(t('col.vat'))}</th><th class="num">${esc(t('col.net'))}</th></tr></thead>
    <tbody>${lineRows}</tbody>`}
    <tfoot>${summary}</tfoot>
  </table>
  ${vat}
  ${p.payment.length ? `<h2>${esc(t('section.payment'))}</h2>${list(p.payment)}` : ''}
  ${p.notes.length ? `<h2>${esc(t('section.notes'))}</h2>${p.notes.map((n) => `<p>${lines(n)}</p>`).join('')}` : ''}
  ${generatedFrom ? `<div class="footer">${esc(generatedFrom)}</div>` : ''}
</div>`;
}
