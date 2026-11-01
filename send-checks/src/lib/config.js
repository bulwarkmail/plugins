/**
 * The admin's settings (manifest configSchema), read with api.config.get().
 * Anything missing or invalid falls back to the defaults below, which are
 * the manifest's: IBANs and card numbers warn when the message goes outside
 * the organisation, everything else is off until the admin fills it in.
 */

export const DEFAULTS = Object.freeze({
  ibanAction: 'warn',
  ibanExternalOnly: true,
  cardAction: 'warn',
  cardExternalOnly: true,
  keywords: '',
  keywordAction: 'warn',
  keywordExternalOnly: false,
  patterns: '',
  patternAction: 'warn',
  patternExternalOnly: false,
  blockedTypes: '',
  allowedTypes: '',
  maxSizeMb: 0,
  attachmentAction: 'block',
  attachmentExternalOnly: false,
});

const ACTIONS = ['off', 'warn', 'block'];

function action(value, fallback, allowOff = true) {
  const v = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (ACTIONS.includes(v) && (allowOff || v !== 'off')) return v;
  return fallback;
}

function bool(value, fallback) {
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return fallback;
}

function text(value, fallback) {
  if (Array.isArray(value)) return value.map(String).join('\n');
  return typeof value === 'string' ? value : fallback;
}

/** The admin's config with every field set. */
export function normaliseConfig(raw) {
  const c = raw && typeof raw === 'object' ? raw : {};
  const size = Number(c.maxSizeMb);
  return {
    ibanAction: action(c.ibanAction, DEFAULTS.ibanAction),
    ibanExternalOnly: bool(c.ibanExternalOnly, DEFAULTS.ibanExternalOnly),
    cardAction: action(c.cardAction, DEFAULTS.cardAction),
    cardExternalOnly: bool(c.cardExternalOnly, DEFAULTS.cardExternalOnly),
    keywords: text(c.keywords, DEFAULTS.keywords),
    keywordAction: action(c.keywordAction, DEFAULTS.keywordAction, false),
    keywordExternalOnly: bool(c.keywordExternalOnly, DEFAULTS.keywordExternalOnly),
    patterns: text(c.patterns, DEFAULTS.patterns),
    patternAction: action(c.patternAction, DEFAULTS.patternAction, false),
    patternExternalOnly: bool(c.patternExternalOnly, DEFAULTS.patternExternalOnly),
    blockedTypes: text(c.blockedTypes, DEFAULTS.blockedTypes),
    allowedTypes: text(c.allowedTypes, DEFAULTS.allowedTypes),
    maxSizeMb: Number.isFinite(size) && size > 0 ? size : 0,
    attachmentAction: action(c.attachmentAction, DEFAULTS.attachmentAction, false),
    attachmentExternalOnly: bool(c.attachmentExternalOnly, DEFAULTS.attachmentExternalOnly),
  };
}
