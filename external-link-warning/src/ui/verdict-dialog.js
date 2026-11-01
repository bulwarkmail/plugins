// The warning for a link Google Safe Browsing lists, in the plugin-dialog
// slot. The host draws the title, the close button, the footer buttons and
// the focus trap; this draws the text and Google's advisory link, which the
// host's plain confirm can't hold. All text comes translated in the props:
// paragraphs[0] names the target domain, [1] is the full link, [2] Google's
// verdict, the last one the note that warnings aren't always right.

import { createElement as h } from 'react';
import { Alert, DialogButtons, LinkButton, Stack, Text } from '@plugin-host/ui';

const api = require('@plugin-host');

export function VerdictDialog(props) {
  const paragraphs = Array.isArray(props?.paragraphs) ? props.paragraphs : [];
  const buttons = Array.isArray(props?.buttons) ? props.buttons : [];
  const advisory = props?.advisory;
  const [target, href, verdict, ...rest] = paragraphs;
  const note = rest.length ? rest[rest.length - 1] : '';
  const middle = rest.slice(0, -1);
  return h(Stack, { gap: 3 },
    target ? h(Text, { weight: 'medium' }, target) : null,
    href ? h(Text, { size: 'xs', tone: 'muted' }, href) : null,
    verdict ? h(Alert, { tone: 'danger' }, verdict) : null,
    ...middle.map((line, i) => h(Text, { key: `m${i}` }, line)),
    note ? h(Text, { size: 'xs', tone: 'muted' }, note) : null,
    advisory?.url
      ? h('div', null, h(LinkButton, { onClick: () => { void api.ui.openExternalUrl(advisory.url, '_blank'); } }, advisory.label))
      : null,
    h(DialogButtons, { buttons, onClick: (id) => props.onResult?.(id) }),
  );
}
