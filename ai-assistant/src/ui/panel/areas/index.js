// The 2.2 areas' parts of the panel, merged (shapes in src/lib/areas/README.md).
// Each area's hook runs on every render, always in this order.

import { useArea as useContextArea } from './context.js';
import { useArea as useActionsArea } from './actions.js';
import { useArea as useFilesArea } from './files.js';
import { useArea as useChatArea } from './chat.js';
import { useArea as useEverywhereArea } from './everywhere.js';

/** Everything the areas add, as one object with every field present. */
export function mergeAreas(parts) {
  const out = { chips: [], promptBlocks: [], toolsCtx: {}, quick: [], menus: [], header: [], overlay: null, privacyParts: [] };
  for (const part of parts) {
    if (!part) continue;
    for (const list of ['chips', 'promptBlocks', 'quick', 'menus', 'header', 'privacyParts']) {
      if (Array.isArray(part[list])) out[list].push(...part[list].filter(Boolean));
    }
    if (part.toolsCtx && typeof part.toolsCtx === 'object') Object.assign(out.toolsCtx, part.toolsCtx);
    if (part.overlay && !out.overlay) out.overlay = part.overlay;
  }
  return out;
}

export function useAreas(chat, props) {
  return mergeAreas([
    useContextArea(chat, props),
    useActionsArea(chat, props),
    useFilesArea(chat, props),
    useChatArea(chat, props),
    useEverywhereArea(chat, props),
  ]);
}
