// The parcels the user follows, one storage key each ("parcel:<number>"),
// so the reader card, the deliveries widget and the background poller can
// each change one parcel without overwriting the others' changes.

import { FINAL_STATUSES } from './status.js';

export const PREFIX = 'parcel:';
/** Background polls of one parcel are at least this far apart. */
export const POLL_INTERVAL_MS = 30 * 60_000;
/** Polling stops this long after the parcel was found. */
export const MAX_AGE_MS = 30 * 24 * 3600_000;
/** Parcels asked about per background tick (once a minute). */
export const MAX_PER_TICK = 20;
/** A reader card asks again when its stored status is older than this. */
export const CARD_REFRESH_MS = 5 * 60_000;
/** The "Refresh" button asks at most this often per parcel. */
export const MANUAL_REFRESH_MS = 10_000;

/** Statuses that are not worth a notification on their own. */
const QUIET = new Set(['pending', 'unknown', 'not_found']);

export async function getParcel(storage, number) {
  const p = await storage.get(PREFIX + number);
  return p && typeof p === 'object' && p.number === number ? p : null;
}

export async function saveParcel(storage, parcel) {
  await storage.set(PREFIX + parcel.number, parcel);
}

export async function removeParcel(storage, number) {
  await storage.remove(PREFIX + number);
}

export async function listParcels(storage) {
  const keys = ((await storage.keys()) || []).filter((k) => typeof k === 'string' && k.startsWith(PREFIX));
  const out = [];
  for (const key of keys) {
    const p = await storage.get(key);
    if (p && typeof p === 'object' && typeof p.number === 'string') out.push(p);
  }
  return out;
}

export function newParcel(found, { emailId = null, subject = '', now = Date.now() } = {}) {
  return {
    number: found.number,
    carrier: found.carrier,
    carrierName: found.carrierName || '',
    trackingUrl: found.trackingUrl || '',
    emailId,
    subject: String(subject || '').slice(0, 200),
    addedAt: now,
    status: null,
    text: '',
    location: '',
    time: '',
    eta: null,
    events: [],
    lastPolledAt: 0,
    lastChangeAt: 0,
    received: false,
    stopped: false,
    error: null,
  };
}

/**
 * Add parcels found in a message unless they are already followed. A parcel
 * the user marked received stays received. Resolves to the stored parcels,
 * in the order given.
 */
export async function rememberParcels(storage, found, meta = {}) {
  const out = [];
  for (const f of found) {
    let p = await getParcel(storage, f.number);
    if (!p) {
      p = newParcel(f, meta);
      await saveParcel(storage, p);
    }
    out.push(p);
  }
  return out;
}

/** Whether the background poller should ask about this parcel now. */
export function isDue(p, now, intervalMs = POLL_INTERVAL_MS) {
  if (!p || p.received || p.stopped) return false;
  if (p.status && FINAL_STATUSES.has(p.status)) return false;
  if (now - (p.addedAt || 0) >= MAX_AGE_MS) return false;
  if (p.retryAt && now < p.retryAt) return false;
  return !p.lastPolledAt || now - p.lastPolledAt >= intervalMs;
}

/** Whether polling has run out of time for this parcel (30 days, not delivered). */
export function isTooOld(p, now) {
  return !p.received && !p.stopped && !FINAL_STATUSES.has(p.status) && now - (p.addedAt || 0) >= MAX_AGE_MS;
}

/**
 * Store what the tracking service said. Resolves to { parcel, changed },
 * where `changed` means the status moved on from an earlier known status
 * (the first answer is not a change).
 */
export function applyOutcome(p, outcome, now) {
  const next = { ...p, lastPolledAt: now };
  if (outcome?.error) {
    next.error = outcome.error.code || 'service';
    if (outcome.error.retryAfter) next.retryAt = now + outcome.error.retryAfter * 1000;
    return { parcel: next, changed: false };
  }
  const r = outcome?.result;
  if (!r) return { parcel: next, changed: false };
  const previous = p.status;
  next.error = null;
  delete next.retryAt;
  next.status = r.status;
  next.text = r.text || '';
  next.location = r.location || '';
  next.time = r.time || '';
  next.eta = r.eta || null;
  next.events = Array.isArray(r.events) ? r.events.slice(0, 20) : [];
  if (!next.carrierName && r.carrierName) next.carrierName = r.carrierName;
  const changed = previous != null && previous !== r.status && !QUIET.has(r.status);
  if (previous !== r.status) next.lastChangeAt = now;
  return { parcel: next, changed };
}

function claimToken() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** The parcels the widget lists: not marked received, newest activity first. */
export function visibleParcels(list) {
  return list
    .filter((p) => !p.received)
    .sort((a, b) => Math.max(b.lastChangeAt || 0, b.addedAt || 0) - Math.max(a.lastChangeAt || 0, a.addedAt || 0));
}

/**
 * One background round: ask about the parcels that are due (at most
 * MAX_PER_TICK, the longest-waiting first), store the answers and report
 * status changes through `onChange(parcel)`. Parcels past 30 days stop.
 *
 * Resolves to { polled, changed, retryAfter } (seconds, when a service
 * asked us to slow down).
 */
export async function pollDue(storage, tracker, { now = Date.now(), onChange, claimDelayMs = 50, intervalMs = POLL_INTERVAL_MS } = {}) {
  const all = await listParcels(storage);
  for (const p of all) {
    if (isTooOld(p, now)) await saveParcel(storage, { ...p, stopped: true });
  }
  const candidates = all.filter((p) => isDue(p, now, intervalMs))
    .sort((a, b) => (a.lastPolledAt || 0) - (b.lastPolledAt || 0))
    .slice(0, MAX_PER_TICK);
  if (!candidates.length) return { polled: 0, changed: 0, retryAfter: 0 };

  // Claim the parcels first: another tab (or a second copy of the plugin)
  // polling at the same moment sees them as just polled, or loses the
  // claim, so each parcel is asked about once.
  const token = claimToken();
  for (const p of candidates) {
    // Read again right before claiming: someone else may have claimed it
    // since the list above was read.
    const fresh = await getParcel(storage, p.number);
    if (fresh && isDue(fresh, now, intervalMs)) await saveParcel(storage, { ...fresh, lastPolledAt: now, pollClaim: token });
  }
  if (claimDelayMs) await new Promise((r) => setTimeout(r, claimDelayMs));
  const due = [];
  for (const p of candidates) {
    const current = await getParcel(storage, p.number);
    if (current && current.pollClaim === token) due.push(p);
  }
  if (!due.length) return { polled: 0, changed: 0, retryAfter: 0 };

  const outcomes = await tracker.trackMany(due);
  let changed = 0;
  let retryAfter = 0;
  for (const p of due) {
    const outcome = outcomes.get(p.number);
    if (!outcome) continue;
    if (outcome.error?.retryAfter) retryAfter = Math.max(retryAfter, outcome.error.retryAfter);
    // Read again: the user may have marked it received meanwhile.
    const current = (await getParcel(storage, p.number)) ?? p;
    if (current.received) continue;
    // The status before this round (the claim above changed only the poll time).
    const { parcel, changed: didChange } = applyOutcome({ ...current, status: p.status }, outcome, now);
    delete parcel.pollClaim;
    await saveParcel(storage, parcel);
    if (didChange) {
      changed++;
      if (onChange) await onChange(parcel, current.status);
    }
  }
  return { polled: due.length, changed, retryAfter };
}
