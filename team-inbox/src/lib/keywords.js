// How the plugin keeps assignment and status on a message: JMAP keywords,
// which every member of a group account sees the same (and which IMAP
// clients see as flags).
//
//   $assigned:<principal id>   who the message is assigned to, one at a time
//   $done                      the message is dealt with
//
// Stalwart uses a user's account id as their principal id ("cj"), so the
// keyword names the person the same way on every member's screen. Ids are
// short letters and digits; the plugin API refuses "@" in keywords, so an
// address can't go in. Keywords are case-insensitive in JMAP.
//
// "Open" means not done. Read state can't say it: in a group account $seen
// is shared too, so whoever opens a message marks it read for everyone.

export const ASSIGNED_PREFIX = '$assigned:';
export const DONE = '$done';

// What fits in a keyword after the prefix (the plugin API's keyword rule).
const ID_RE = /^[a-z0-9][a-z0-9_.-]{0,100}$/i;

export function isAssigneeId(id) {
  return typeof id === 'string' && ID_RE.test(id);
}

export function assignedKeyword(id) {
  if (!isAssigneeId(id)) throw new Error(`Not an id that fits in a keyword: ${id}`);
  return ASSIGNED_PREFIX + id.toLowerCase();
}

/** The keywords as a lowercase list, from an array or a JMAP keyword map. */
export function keywordList(keywords) {
  if (Array.isArray(keywords)) return keywords.filter((k) => typeof k === 'string').map((k) => k.toLowerCase());
  if (keywords && typeof keywords === 'object') {
    return Object.keys(keywords).filter((k) => keywords[k]).map((k) => k.toLowerCase());
  }
  return [];
}

/** Every id a message is assigned to (normally one; two if clients raced). */
export function assigneesOf(keywords) {
  return keywordList(keywords)
    .filter((k) => k.startsWith(ASSIGNED_PREFIX))
    .map((k) => k.slice(ASSIGNED_PREFIX.length))
    .filter(isAssigneeId);
}

export function assigneeOf(keywords) {
  return assigneesOf(keywords)[0] ?? null;
}

export function isDone(keywords) {
  return keywordList(keywords).includes(DONE);
}

/**
 * The keyword changes that assign the message to `id` and to nobody else.
 * Empty when it already is.
 */
export function assignChanges(keywords, id) {
  const wanted = assignedKeyword(id);
  const changes = {};
  for (const other of assigneesOf(keywords)) {
    const kw = ASSIGNED_PREFIX + other;
    if (kw !== wanted) changes[kw] = false;
  }
  if (!keywordList(keywords).includes(wanted)) changes[wanted] = true;
  return changes;
}

/** The changes that leave the message assigned to nobody. */
export function unassignChanges(keywords) {
  const changes = {};
  for (const id of assigneesOf(keywords)) changes[ASSIGNED_PREFIX + id] = false;
  return changes;
}

export function doneChanges(keywords) {
  return isDone(keywords) ? {} : { [DONE]: true };
}

export function reopenChanges(keywords) {
  return isDone(keywords) ? { [DONE]: false } : {};
}

/**
 * People messages were assigned to lately, most often first: from the
 * keywords of the rows the user saw. `seen` maps id → count.
 */
export function recentAssignees(seen, { exclude = [], limit = 8 } = {}) {
  const skip = new Set(exclude.map((id) => String(id).toLowerCase()));
  return [...seen.entries()]
    .filter(([id]) => !skip.has(id))
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([id]) => id);
}
