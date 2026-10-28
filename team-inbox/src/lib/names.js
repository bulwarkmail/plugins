// Names for the principal ids in $assigned keywords.
//
// Where they come from, best first:
// - the session: the user's own name and address (api.user.getSelf);
// - the server's directory, when the administrator allows lookups
//   (api.user.findPeople; Stalwart 1.0 has them off by default);
// - a small map the plugin keeps in the group Inbox's shared metadata
//   (api.accountData, Stalwart 1.0 and later): every member who uses the
//   plugin adds themselves, and whoever assigns adds the assignee.
// Without either, other members' names are unknown and the badge says
// "Assigned".

/** At most this many people in the shared map; it has 8 KB. */
export const MAX_SHARED_PEOPLE = 80;
export const SHARED_VERSION = 1;

function clean(value, max) {
  return typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max) : '';
}

/** One person as the map keeps them, or null. */
export function person(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const name = clean(entry.name ?? entry.n, 80);
  const email = clean(entry.email ?? entry.e, 254).toLowerCase();
  if (!name && !email) return null;
  return { name: name || email, email };
}

/** The people of a shared map value, by id; {} for anything else. */
export function readShared(value) {
  const out = {};
  const people = value && typeof value === 'object' && value.people && typeof value.people === 'object' ? value.people : {};
  for (const [id, entry] of Object.entries(people)) {
    const p = person(entry);
    if (p && /^[a-z0-9][a-z0-9_.-]{0,100}$/i.test(id)) out[id.toLowerCase()] = p;
  }
  return out;
}

/** The value to store for `people`, the newest last, at most MAX_SHARED_PEOPLE. */
export function writeShared(people) {
  const entries = Object.entries(people).slice(-MAX_SHARED_PEOPLE);
  return { v: SHARED_VERSION, people: Object.fromEntries(entries.map(([id, p]) => [id, { n: p.name, e: p.email }])) };
}

/**
 * `shared` with `additions` merged in, or null when nothing changes (so the
 * plugin doesn't write the same map again).
 */
export function mergeShared(shared, additions) {
  let changed = false;
  const next = { ...shared };
  for (const [id, entry] of Object.entries(additions)) {
    const p = person(entry);
    if (!p) continue;
    const key = id.toLowerCase();
    const before = next[key];
    if (before && before.name === p.name && before.email === p.email) continue;
    delete next[key];
    next[key] = p;
    changed = true;
  }
  return changed ? next : null;
}

/** The short form for a row badge: the first name, else the address's local part. */
export function shortName(p) {
  if (!p) return '';
  const name = (p.name || '').trim();
  if (name && !name.includes('@')) return name.split(/\s+/)[0];
  const address = (p.email || name).split('@')[0];
  return address;
}

/** The person whose address is `address` in `people` (by id), or null. */
export function findByEmail(people, address) {
  const wanted = String(address ?? '').trim().toLowerCase();
  if (!wanted) return null;
  for (const [id, p] of Object.entries(people)) {
    if (p.email === wanted) return { id, ...p };
  }
  return null;
}

/** A loose address check for the typed field. */
export function looksLikeAddress(text) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(text ?? '').trim());
}
