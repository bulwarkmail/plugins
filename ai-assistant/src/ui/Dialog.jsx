// The one dialog slot: the assistant dialog the composer's Assistant
// button opens (api.ui.openDialog({ extraProps: { composerId } })), and the
// chat for a view whose panel has no room (a phone, Settings below 1024 px:
// extraProps { view, context }).

import { AssistantDialog } from './AssistantDialog.jsx';
import { AssistantPanel } from './Panel.jsx';
import { viewOf } from '../lib/areas/everywhere.js';

export function Dialog(props) {
  if (viewOf(props)) {
    // The dialog grows with its content (its frame has no height of its
    // own to take a share of): the chat gets a fixed one to scroll in, which
    // fits the dialog on a phone.
    return (
      <div style={{ height: 520, display: 'flex', flexDirection: 'column', minHeight: 0 }} data-assistant-view-dialog={props.view}>
        <AssistantPanel {...props} />
      </div>
    );
  }
  return <AssistantDialog {...props} />;
}
