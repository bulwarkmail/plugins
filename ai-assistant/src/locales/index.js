// Every text of the assistant, by area. Each package of the 2.2 work keeps
// its texts in its own folder, so their translations never touch the same file.

import core from './core/index.js';
import context from './context/index.js';
import actions from './actions/index.js';
import files from './files/index.js';
import chat from './chat/index.js';
import everywhere from './everywhere/index.js';

export const AREAS = { core, context, actions, files, chat, everywhere };
