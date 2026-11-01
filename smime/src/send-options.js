// The options of the api.jmap.sendRaw call that completes an onComposeSend
// takeover.
//
// - envelopeRecipients: every To, Cc and Bcc address, once.
// - delayedUntil: a scheduled send stays scheduled.
// - labelToken: Bulwark 1.20 issues one per takeover, for the classification
//   label it adds to the outer headers of what we send. Passing it back
//   names this send; without it two S/MIME sends at once from one address
//   are refused, because the host can't tell which label belongs to which.

export function rawSendOptions(req, envelopeRecipients) {
  const opts = { envelopeRecipients: [...new Set(envelopeRecipients)] };
  if (req && req.delayedUntil) opts.delayedUntil = req.delayedUntil;
  if (req && typeof req.labelToken === 'string' && req.labelToken) opts.labelToken = req.labelToken;
  return opts;
}
