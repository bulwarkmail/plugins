// Team inbox: assign messages of a team (group) mailbox to a member and mark
// them done, with "Assigned to me" and "Open" filters in the message list.
//
// Everything is kept on the message as keywords ($assigned:<principal id>,
// $done; see src/lib/keywords.js), so every member sees the same state. The
// background part (src/lib/wiring.js) offers the actions, filters and row
// badges; the "Assign to…" dialog runs in the plugin-dialog slot.

import * as React from 'react';
import { createWiring } from './lib/wiring.js';
import { makeAssignDialog } from './ui/assign-dialog.js';

const hostApi = require('@plugin-host');
const wiring = createWiring(hostApi);
const AssignDialog = makeAssignDialog(React, hostApi);

export default {
  activate: (api) => wiring.activate(api),
  hooks: wiring.hooks,
  slots: {
    'plugin-dialog': {
      component: (props) => React.createElement(AssignDialog, props),
    },
  },
};
