// Bulwark 1.19 and later have their own external mail warnings: an
// "External" label next to the sender and a confirm before sending outside
// the organisation, set by the admin in Organisation > Security. The host
// says when they are on through api.host.features; this plugin then does
// nothing, so nobody is warned twice. Older hosts have no api.host, and the
// plugin works as before there.

/** True while Bulwark's own external mail warnings are on for this user. */
export function coreHandlesExternalMail(api) {
  return api?.host?.features?.externalMailWarnings === true;
}
