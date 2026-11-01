// What a click on a link leads to, from the trusted list and the checks,
// and the dialog that says so. Pure functions; src/index.js shows them.

import { linkTextMismatch } from './domains.js';
import { ADVISORY_URL, THREAT_TYPES } from './safebrowsing.js';

/**
 * kind:
 * - 'open':    open the link, no dialog (a trusted domain with nothing found);
 * - 'warn':    the domain warning, with what the check said ('safe' or 'failed');
 * - 'unsafe':  a strong warning: the company check flagged it;
 * - 'google':  the same with Google's verdict, which needs Google's advisory link;
 * - 'closed':  the check failed and the admin chose fail closed: only Close.
 * `block` on unsafe and google: the admin doesn't allow opening it anyway.
 */
export function decide({ host, text, trusted, check, config }) {
  const mismatch = trusted ? '' : linkTextMismatch(text, host);
  const verdict = check?.verdict ?? 'off';
  if (verdict === 'unsafe') {
    const threats = check.google?.verdict === 'unsafe' ? check.google.threats ?? [] : [];
    const reason = check.endpoint?.verdict === 'unsafe' ? check.endpoint.reason : undefined;
    return {
      kind: threats.length ? 'google' : 'unsafe',
      block: config.onUnsafe === 'block',
      threats,
      ...(reason ? { reason } : {}),
      mismatch,
    };
  }
  if (verdict === 'failed') {
    if (config.onFailure === 'closed') return { kind: 'closed', mismatch };
    // Fail open: a trusted domain opens as it would without a check.
    if (trusted) return { kind: 'open' };
    return { kind: 'warn', line: 'failed', mismatch };
  }
  if (trusted) return { kind: 'open' };
  return { kind: 'warn', line: verdict === 'safe' ? 'safe' : null, mismatch };
}

const paragraphs = (...parts) => parts.filter(Boolean).join('\n\n');

/**
 * The dialog for a decision: `{ type: 'confirm' | 'alert', options }` for
 * the host's own dialogs, or `{ type: 'dialog', options }` for the plugin's
 * dialog slot (Google's verdict, which must link to Google's advisory).
 */
export function dialogFor(decision, { host, href, text }, tr) {
  const mismatchLine = decision.mismatch ? tr('text.mismatch', { text: decision.mismatch || text, host }) : '';
  switch (decision.kind) {
    case 'warn':
      return {
        type: 'confirm',
        options: {
          title: tr('dialog.title'),
          message: paragraphs(
            tr('dialog.message', { host, href }),
            mismatchLine,
            decision.line === 'safe' ? tr('check.safe') : decision.line === 'failed' ? tr('check.failed') : '',
          ),
          confirmLabel: tr('dialog.continue'),
          cancelLabel: tr('dialog.cancel'),
        },
      };
    case 'unsafe': {
      const reason = decision.reason ? tr('unsafe.reason', { reason: decision.reason }) : '';
      if (decision.block) {
        return { type: 'alert', options: { title: tr('blocked.title'), message: paragraphs(tr('blocked.message', { host, href }), reason, mismatchLine), confirmLabel: tr('close') } };
      }
      return {
        type: 'confirm',
        options: {
          title: tr('unsafe.title'),
          message: paragraphs(tr('unsafe.message', { host, href }), reason, mismatchLine),
          confirmLabel: tr('unsafe.continue'),
          cancelLabel: tr('unsafe.cancel'),
          danger: true,
        },
      };
    }
    case 'closed':
      return { type: 'alert', options: { title: tr('closed.title'), message: paragraphs(tr('closed.message', { host, href }), mismatchLine), confirmLabel: tr('close') } };
    case 'google': {
      const threats = THREAT_TYPES.filter((t) => decision.threats.includes(t));
      const lines = [
        tr('google.target', { host }),
        href,
        ...threats.map((t) => tr(`google.${t}`)),
        decision.reason ? tr('unsafe.reason', { reason: decision.reason }) : '',
        mismatchLine,
        decision.block ? tr('google.blocked') : '',
        tr('google.imperfect'),
      ].filter(Boolean);
      const buttons = decision.block
        ? [{ id: 'close', label: tr('close'), variant: 'secondary' }]
        : [
          { id: 'cancel', label: tr('unsafe.cancel'), variant: 'secondary' },
          { id: 'open', label: tr('unsafe.continue'), variant: 'destructive' },
        ];
      return {
        type: 'dialog',
        options: {
          title: tr('google.title'),
          slot: 'plugin-dialog',
          extraProps: { paragraphs: lines, advisory: { label: tr('google.advisory'), url: ADVISORY_URL }, buttons },
        },
      };
    }
    default:
      return null;
  }
}
