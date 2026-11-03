// Area "actions" of the 2.2 work: what it adds to the panel (shapes in README.md).
//
// The lookups and actions need to know which host calls this webmail offers
// (toolsCtx.doCaps) and whether its out-of-office says when it forwards mail
// (toolsCtx.doVacationKnown, checked once per frame). The privacy notice
// names what these lookups and actions send.

import { useEffect, useMemo, useState } from 'react';
import { actionCaps, groupOn } from '../../../lib/areas/actions.js';
import { areaAllowed } from '../../../lib/config.js';
import { effectiveActionMode } from '../../../lib/actions.js';

const vacationChecks = new WeakMap();

/** Whether vacation.get says if the out-of-office forwards mail (newer webmails). Asked once per api object. */
export function vacationKnown(api) {
  if (!api || typeof api !== 'object') return Promise.resolve(false);
  let check = vacationChecks.get(api);
  if (!check) {
    check = Promise.resolve()
      .then(() => api.vacation.get())
      .then((v) => typeof v?.forwardActive === 'boolean', () => false);
    vacationChecks.set(api, check);
  }
  return check;
}

/** Called on every render of the panel, in a fixed order with the other areas. */
export function useArea(chat) {
  const api = chat?.api;
  const config = chat?.setup?.config ?? {};
  const prefs = chat?.prefs ?? {};
  const allowed = areaAllowed(config, 'actions');
  const mode = effectiveActionMode(config, prefs);
  const lookups = prefs.lookups !== false;
  const caps = useMemo(() => actionCaps(api), [api]);
  const [known, setKnown] = useState(false);
  // Only ask the webmail when the out-of-office could be offered at all.
  const wantVacation = allowed && caps.vacation && (lookups || (mode !== 'off' && groupOn(prefs, 'vacation')));

  useEffect(() => {
    if (!wantVacation) return undefined;
    let live = true;
    void vacationKnown(api).then((value) => { if (live) setKnown(value); });
    return () => { live = false; };
  }, [api, wantVacation]);

  const anything = Object.values(caps).some(Boolean);
  return useMemo(() => ({
    toolsCtx: { doCaps: caps, doVacationKnown: wantVacation && known },
    privacyParts: allowed && anything && (lookups || mode !== 'off') ? ['do.privacy'] : [],
  }), [caps, wantVacation, known, allowed, anything, lookups, mode]);
}
