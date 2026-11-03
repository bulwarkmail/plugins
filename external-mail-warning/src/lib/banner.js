// The reader info bar for an external sender or failed authentication. It
// stacks with the app's own bars (external content, invitations) and looks
// like them: the kit's InfoBar in the warning tone.

import * as React from 'react';
import { InfoBar } from '@plugin-host/ui';

// The address keeps its own text direction, so the brackets don't flip in a
// right-to-left language. It stays inline, so a very long one can still wrap.
function Address({ children }) {
  return React.createElement('bdi', null, children);
}

function Sender({ sender }) {
  if (sender.name && sender.email) return React.createElement(React.Fragment, null, `${sender.name} `, React.createElement(Address, null, `<${sender.email}>`));
  if (sender.email) return React.createElement(Address, null, sender.email);
  return sender.name || '';
}

/** "External sender · SPF, DKIM failed" */
export function warningLabel(externals, fails) {
  const parts = [];
  if (externals.length > 0) parts.push(externals.length === 1 ? 'External sender' : 'External senders');
  if (fails.length > 0) parts.push(`${fails.join(', ')} failed`);
  return parts.join(' · ');
}

export function SenderWarning({ externals, fails }) {
  if (externals.length === 0 && fails.length === 0) return null;
  const from = externals.filter(Boolean).flatMap((sender, i) => [
    i > 0 ? ', ' : null,
    React.createElement(Sender, { key: i, sender }),
  ]);
  return React.createElement(InfoBar, {
    tone: 'warning',
    icon: 'alert-triangle',
    eyebrow: warningLabel(externals, fails),
    title: from.length > 0 ? from : undefined,
  });
}
