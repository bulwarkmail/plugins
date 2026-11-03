// The 2.2 areas' parts of the plugin's settings, in this order.

import { ContextSection } from './ContextSection.jsx';
import { ActionsSection } from './ActionsSection.jsx';
import { FilesSection } from './FilesSection.jsx';
import { ChatSection } from './ChatSection.jsx';
import { EverywhereSection } from './EverywhereSection.jsx';

export const AREA_SECTIONS = [
  ['context', ContextSection],
  ['actions', ActionsSection],
  ['files', FilesSection],
  ['chat', ChatSection],
  ['everywhere', EverywhereSection],
];
