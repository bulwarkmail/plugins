// Saved prompts: the user's own (prefs.prompts, edited in the settings) and
// the administrator's (config `prompts`, one per line "Name: what to ask").
// Both show in the Actions menu and as / commands.

export const MAX_PROMPTS = 30;
export const MAX_PROMPT_NAME = 60;
export const MAX_PROMPT_TEXT = 2000;

const oneLine = (text) => String(text ?? '').replace(/\s+/g, ' ').trim();

/** The administrator's prompts from the config text: [{ id, name, text, admin: true }]. */
export function adminPrompts(config = {}) {
  const raw = typeof config.prompts === 'string' ? config.prompts : '';
  const out = [];
  for (const line of raw.split(/\r?\n/)) {
    const value = line.trim();
    if (!value || value.startsWith('#')) continue;
    const colon = value.indexOf(':');
    // ": text" has no name: left out.
    if (colon === 0) continue;
    const name = oneLine(colon > 0 ? value.slice(0, colon) : value).slice(0, MAX_PROMPT_NAME);
    const text = (colon > 0 ? value.slice(colon + 1) : value).trim().slice(0, MAX_PROMPT_TEXT);
    if (!name || !text) continue;
    out.push({ id: `admin-${out.length + 1}`, name, text, admin: true });
    if (out.length >= MAX_PROMPTS) break;
  }
  return out;
}

/** The user's prompts, cleaned: [{ id, name, text }]. */
export function userPrompts(prefs = {}) {
  const list = Array.isArray(prefs.prompts) ? prefs.prompts : [];
  return list
    .filter((p) => p && typeof p.id === 'string' && oneLine(p.name) && String(p.text ?? '').trim())
    .map((p) => ({ id: p.id, name: oneLine(p.name).slice(0, MAX_PROMPT_NAME), text: String(p.text).trim().slice(0, MAX_PROMPT_TEXT) }))
    .slice(0, MAX_PROMPTS);
}

/** Every saved prompt: the user's first, then the administrator's. */
export function savedPrompts(config = {}, prefs = {}) {
  return [...userPrompts(prefs), ...adminPrompts(config)];
}

export const promptId = () => `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/** Letters and digits only, lower case: how a / command is matched. */
export const normalize = (text) => String(text ?? '').toLowerCase().normalize('NFKD').replace(/\p{M}+/gu, '').replace(/[^\p{L}\p{N}]+/gu, '');

/** The / command for a name: "To-dos and dates" → "to-dos-and-dates" (at most 40 characters). */
export function slashName(label) {
  return String(label ?? '').toLowerCase().trim().replace(/\s+/g, '-').replace(/[^\p{L}\p{N}-]+/gu, '').replace(/-{2,}/g, '-').replace(/^-|-$/g, '').slice(0, 40);
}

/**
 * The entries a / query matches, best first: names that start with it, then
 * names with a word that starts with it, then names that hold it.
 */
export function matchCommands(entries, query) {
  const q = normalize(query);
  if (!q) return entries;
  const scored = [];
  entries.forEach((entry, i) => {
    const name = normalize(entry.label);
    const words = String(entry.label ?? '').toLowerCase().split(/[\s\-–·]+/).map(normalize);
    const rank = name.startsWith(q) ? 0 : words.some((w) => w.startsWith(q)) ? 1 : name.includes(q) ? 2 : -1;
    if (rank >= 0) scored.push({ entry, rank, i });
  });
  return scored.sort((a, b) => (a.rank - b.rank) || (a.i - b.i)).map((x) => x.entry);
}
