// "Assign to…": the plugin-dialog slot, opened by the background with the
// people it knows (the user, recent assignees, the team mailbox's members
// from the shared names). Typing searches the server's directory where the
// administrator allows it; an address that isn't listed can be typed out
// and is looked up when the dialog closes.

import { DialogButtons, Field, Icon, Input, List, ListRow, Stack, Text } from '@plugin-host/ui';
import { looksLikeAddress } from '../lib/names.js';

const SEARCH_DELAY_MS = 400;
/** Bulwark answers directory searches from 3 characters. */
const MIN_SEARCH = 3;

export function makeAssignDialog(React, api) {
  const { createElement: h, useEffect, useState } = React;
  const t = (key, vars) => api.i18n.t(key, vars);

  return function AssignDialog(props) {
    const choices = Array.isArray(props.choices) ? props.choices : [];
    const [text, setText] = useState('');
    const [found, setFound] = useState([]);
    const [directoryOff, setDirectoryOff] = useState(false);
    const query = text.trim().toLowerCase();

    useEffect(() => {
      if (query.length < MIN_SEARCH || typeof api.user?.findPeople !== 'function') {
        setFound([]);
        return undefined;
      }
      let live = true;
      const timer = setTimeout(() => {
        api.user.findPeople({ text: query, ...(props.accountId ? { accountId: props.accountId } : {}) }).then((result) => {
          if (!live) return;
          setDirectoryOff(result?.complete === false);
          setFound((result?.people ?? []).filter((p) => p.type !== 'group'));
        }).catch(() => { if (live) setFound([]); });
      }, SEARCH_DELAY_MS);
      return () => { live = false; clearTimeout(timer); };
    }, [query, props.accountId]);

    const close = (value) => props.onResult?.(value);
    const listed = choices.filter((c) => !query || c.name.toLowerCase().includes(query) || c.email.includes(query));
    for (const p of found) {
      if (!listed.some((c) => c.id === p.id)) listed.push({ id: p.id, name: p.name, email: p.email, kind: 'directory' });
    }
    const typed = looksLikeAddress(query) && !listed.some((c) => c.email === query) ? query : null;

    const subtitle = (c) => (c.kind === 'me' ? t('dialog.you') : c.email || c.note || undefined);
    return h(Stack, { gap: 3 },
      h(Field, { label: t('dialog.search'), hint: directoryOff ? t('dialog.no_directory') : undefined },
        h(Input, {
          value: text,
          autoFocus: true,
          placeholder: t('dialog.placeholder'),
          onChange: (e) => setText(e.target.value),
          onKeyDown: (e) => {
            if (e.key !== 'Enter') return;
            if (typed) close({ address: typed });
            else if (listed.length === 1) close(listed[0]);
          },
        })),
      listed.length > 0
        ? h(List, { label: t('dialog.people') },
          ...listed.map((c) => h(ListRow, {
            key: c.id,
            icon: h(Icon, { name: c.kind === 'me' ? 'user-check' : 'user' }),
            title: c.name,
            subtitle: subtitle(c),
            // An unknown member's placeholder name isn't handed back as a name.
            onClick: () => close(c.note ? { id: c.id } : { id: c.id, name: c.name, email: c.email }),
          })))
        : h(Text, { tone: 'muted' }, t('dialog.empty')),
      h(DialogButtons, {
        buttons: [
          { id: 'cancel', label: t('dialog.cancel'), variant: 'secondary' },
          { id: 'assign', label: typed ? t('dialog.assign_address', { address: typed }) : t('dialog.assign'), variant: 'primary', disabled: !typed },
        ],
        onClick: (id) => close(id === 'assign' && typed ? { address: typed } : null),
      }));
  };
}
