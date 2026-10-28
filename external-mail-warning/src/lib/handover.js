// Bulwark 1.19 and later have their own external mail warnings, set by the
// admin in Organisation > Security: an "External" label next to the sender
// and a confirm before sending outside the organisation. The host says which
// is on through api.host.features, one flag per switch, and this plugin
// steps back part by part, so nobody is warned twice:
//
//   externalRecipientWarning -> no send confirm (onBeforeEmailSend)
//   externalSenderLabel      -> no banner on incoming mail, no new-mail toast
//
// Older hosts have no api.host, and the plugin works as before there.

/** True while Bulwark confirms sends to recipients outside the organisation. */
export function coreConfirmsRecipients(api) {
  return api?.host?.features?.externalRecipientWarning === true;
}

/** True while Bulwark labels mail from senders outside the organisation. */
export function coreLabelsSenders(api) {
  return api?.host?.features?.externalSenderLabel === true;
}
