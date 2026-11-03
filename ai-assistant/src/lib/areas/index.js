// The 2.2 areas' lookups and actions, merged (see README.md). tools.js and
// actions.js offer and run them next to their own; the panel takes labels
// and icons from here.

import context from './context.js';
import actions from './actions.js';
import files from './files.js';
import chat from './chat.js';
import everywhere from './everywhere.js';

export const AREAS = { context, actions, files, chat, everywhere };

const all = (kind) => Object.entries(AREAS).flatMap(([area, def]) => (def[kind] ?? []).map((entry) => ({ ...entry, area })));

/** Every area's lookups: [{ area, name, description, parameters, available, run, label, kind, icon }]. */
export const areaTools = () => all('tools');
/** Every area's actions: [{ area, name, description, parameters, available, alwaysAsk, describe, perform, undo, icon }]. */
export const areaActions = () => all('actions');
export const areaTool = (name) => areaTools().find((entry) => entry.name === name) ?? null;
export const areaAction = (name) => areaActions().find((entry) => entry.name === name) ?? null;

/** Whether an area's lookup or action is offered in this chat (`available(ctx)`; missing means yes). */
export const offered = (entry, ctx) => typeof entry.available !== 'function' || entry.available(ctx) === true;
