/**
 * Outlook-style Quote Headers
 *
 * Replaces the default reply/forward header with the Outlook layout:
 *
 *   From:    John Smith <john@example.com>
 *   Sent:    Friday, May 16, 2026 2:30 PM
 *   To:      Linus <linus@example.com>
 *   Cc:      Others <others@example.com>
 *   Subject: Headers
 *
 *   <original message follows, no blockquote indent>
 *
 * Hook contract (set by the host in lib/quote-header.ts):
 *   onBuildQuoteHeader(current: QuoteHeader, ctx: QuoteHeaderContext)
 *     -> QuoteHeader | undefined
 *
 * Returning undefined falls through to the host default. We do that when the
 * "applyTo" setting opts out of this mode (reply / forward / both).
 */

let pluginApi = null;

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escapeText(s) {
  return String(s ?? '');
}

function joinAddresses(list) {
  if (!Array.isArray(list) || list.length === 0) return '';
  return list
    .filter((a) => a && a.email)
    .map((a) => (a.name ? `${a.name} <${a.email}>` : a.email))
    .join(', ');
}

function shouldApply(mode) {
  const setting = pluginApi?.plugin?.settings?.applyTo ?? 'both';
  if (setting === 'both') return true;
  if (setting === 'reply') return mode === 'reply' || mode === 'replyAll';
  if (setting === 'forward') return mode === 'forward';
  return true;
}

// Build the localized "Sent:" datetime. We deliberately use Intl rather than
// the host's date string so the long Outlook-style format ("Friday, May 16,
// 2026 2:30 PM") survives even though the host passes only the short form.
function formatSent(ctx) {
  if (!ctx.receivedAt) return ctx.date || '';
  const d = new Date(ctx.receivedAt);
  if (isNaN(d.getTime())) return ctx.date || '';
  try {
    return new Intl.DateTimeFormat(ctx.locale || 'en', {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    }).format(d);
  } catch {
    return d.toISOString();
  }
}

function buildOutlookHtml(ctx, opts) {
  const fromStr = ctx.from
    ? (ctx.from.name ? `${ctx.from.name} <${ctx.from.email}>` : ctx.from.email)
    : '';
  const sent = formatSent(ctx);
  const toStr = joinAddresses(ctx.to);
  const ccStr = joinAddresses(ctx.cc);
  const subject = ctx.subject || '';

  const labelOpen = opts.boldLabels ? '<strong>' : '';
  const labelClose = opts.boldLabels ? '</strong>' : '';
  const row = (label, value) =>
    value ? `<div>${labelOpen}${label}:${labelClose} ${escapeHtml(value)}</div>` : '';

  const rule = opts.thinRuleAbove
    ? '<hr style="border:none;border-top:1px solid #ccc;margin:12px 0">'
    : '';

  // Header block ends with a blank line. The composer appends the quoted body
  // directly after, with no blockquote (we set wrapInBlockquote: false).
  return (
    rule +
    `<div style="font-family:inherit">` +
    row('From', fromStr) +
    row('Sent', sent) +
    row('To', toStr) +
    (ccStr ? row('Cc', ccStr) : '') +
    row('Subject', subject) +
    `</div><div><br></div>`
  );
}

function buildOutlookText(ctx) {
  const fromStr = ctx.from
    ? (ctx.from.name ? `${ctx.from.name} <${ctx.from.email}>` : ctx.from.email)
    : '';
  const sent = formatSent(ctx);
  const toStr = joinAddresses(ctx.to);
  const ccStr = joinAddresses(ctx.cc);
  const subject = ctx.subject || '';

  const lines = [];
  if (fromStr) lines.push(`From: ${escapeText(fromStr)}`);
  if (sent) lines.push(`Sent: ${escapeText(sent)}`);
  if (toStr) lines.push(`To: ${escapeText(toStr)}`);
  if (ccStr) lines.push(`Cc: ${escapeText(ccStr)}`);
  if (subject) lines.push(`Subject: ${escapeText(subject)}`);
  lines.push('');
  return lines.join('\n');
}

// ─── Hooks ───────────────────────────────────────────────────

export const hooks = {
  onBuildQuoteHeader(current, ctx) {
    if (!pluginApi || !ctx) return undefined;
    if (!shouldApply(ctx.mode)) return undefined;
    const opts = {
      boldLabels: pluginApi.plugin.settings.boldLabels !== false,
      thinRuleAbove: pluginApi.plugin.settings.thinRuleAbove !== false,
    };
    return {
      html: buildOutlookHtml(ctx, opts),
      text: buildOutlookText(ctx),
      wrapInBlockquote: false,
    };
  },
};

// ─── Activate ────────────────────────────────────────────────

export async function activate(api) {
  pluginApi = api;
  api.log.info('Outlook-style Quote Headers activated');
}
