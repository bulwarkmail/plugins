// What this webmail offers the assistant. The 2.2 host calls are announced in
// api.host.features (webmail 1.20 and later); an older webmail has none of
// these flags, so the assistant hides what needs them and keeps working with
// what 1.17 to 1.19 offer.

/** The flags of the 2.2 host calls (lib/plugin-sandbox/assistant in the webmail). */
export const CAPS = [
  'attachmentText', 'attachmentImages', 'threads', 'listSelection',
  'answerInvitation', 'filterRules', 'batchMail', 'changeSettings',
  'files', 'sidePanel',
];

/** Whether the webmail offers `flag` (and, when given, the method `ns.fn` exists). */
export function has(api, flag, method) {
  if (api?.host?.features?.[flag] !== true) return false;
  if (!method) return true;
  const [ns, fn] = method.split('.');
  return typeof api?.[ns]?.[fn] === 'function';
}

/** Every flag of CAPS as a boolean, false on webmails without it. */
export function caps(api) {
  return Object.fromEntries(CAPS.map((flag) => [flag, has(api, flag)]));
}
