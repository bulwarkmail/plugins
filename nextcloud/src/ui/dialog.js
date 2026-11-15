// The plugin's dialog (api.ui.openDialog with slot "plugin-dialog"). The
// `view` prop picks what it shows; every view but "account" needs a
// connection first. Buttons go in the host's footer (DialogButtons).

import { createElement as h, useMemo } from 'react';
import { getApi } from '../lib/host.js';
import { createClient } from '../lib/client.js';
import { useConnection } from './connection-ui.js';
import { AccountDialog, ConnectionDialogBody } from './account-dialog.js';
import { PickerDialog } from './picker-dialog.js';
import { OffloadDialog } from './offload-dialog.js';
import { SaveDialog } from './save-dialog.js';
import { ShareDialog } from './share-dialog.js';

const VIEWS = {
  picker: PickerDialog,
  offload: OffloadDialog,
  save: SaveDialog,
  share: ShareDialog,
};

export function registerView(name, component) {
  VIEWS[name] = component;
}

export function PluginDialog(props) {
  const api = getApi();
  const connection = useConnection(api);
  const client = useMemo(() => (connection.conn ? createClient(api, connection.conn) : null), [connection.conn]);
  if (props.view === 'account') return h(AccountDialog, { api, connection, onResult: props.onResult });
  const View = VIEWS[props.view];
  if (!View) return null;
  if (connection.status !== 'connected' || !client) {
    // A large file whose offer can't go ahead (the sign-in expired): Cancel
    // attaches it as usual rather than leaving it out of the message.
    const cancelled = props.view === 'offload' ? { action: 'attach' } : null;
    return h(ConnectionDialogBody, { api, connection, onCancel: () => props.onResult?.(cancelled) });
  }
  return h(View, { ...props, api, client, report: connection.report });
}
