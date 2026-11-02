// The one dialog slot: the assistant dialog the composer's Assistant
// button opens (api.ui.openDialog({ extraProps: { composerId } })), and the
// chat for a view whose panel has no room (a phone, Settings below 1024 px:
// extraProps { view, context }).

import { AssistantDialog } from './AssistantDialog.jsx';
import { AssistantPanel } from './Panel.jsx';
import { viewOf } from '../lib/areas/everywhere.js';

/** Whether the host made this frame fill its dialog (the sandbox then sets the document to the frame's height). */
export const fillsFrame = () => typeof document !== 'undefined' && document.documentElement.style.height === '100%';

export function Dialog(props) {
  if (viewOf(props)) {
    // Where the webmail fills the dialog with the frame (1.20 and later)
    // the chat takes all of it; elsewhere the dialog grows with its content
    // and the chat gets a height of its own to scroll in.
    return (
      <div style={{ height: fillsFrame() ? '100%' : 480, display: 'flex', flexDirection: 'column', minHeight: 0 }} data-assistant-view-dialog={props.view}>
        <AssistantPanel {...props} />
      </div>
    );
  }
  return <AssistantDialog {...props} />;
}
