// The user's own date and time, for the model and for the cards. Every
// "today", "tomorrow" and day of an event comes from here, in the user's
// time zone: never from the UTC date, which is a different day around
// midnight in Europe and every evening in America.

const WEEKDAY = new Intl.DateTimeFormat('en-US', { weekday: 'long', timeZone: 'UTC' });

function validZone(zone) {
  if (typeof zone !== 'string' || !zone) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

function browserZone() {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; }
}

/**
 * The user's time zone. The host's (api.i18n.timeZone, webmail 1.17.2 and
 * later) follows the user's setting; it says 'UTC' only until the host has
 * sent the regional settings, so then the account's zone (`fallback`, from
 * api.user.getTimeZone) wins. Last, the browser's.
 */
export function userZone(api, fallback) {
  const host = api?.i18n?.timeZone;
  if (validZone(host) && !(host === 'UTC' && validZone(fallback) && fallback !== 'UTC')) return host;
  if (validZone(fallback)) return fallback;
  return browserZone();
}

/** Year, month, day, hour and minute of `at` in `zone`. */
function partsIn(zone, at) {
  const out = {};
  for (const p of new Intl.DateTimeFormat('en-US', {
    timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(at)) out[p.type] = p.value;
  return out;
}

/** The calendar date ('YYYY-MM-DD') of an instant in `zone`. */
export function dateIn(zone, at) {
  const d = at instanceof Date ? at : new Date(at);
  if (Number.isNaN(d.getTime())) return '';
  const p = partsIn(zone, d);
  return `${p.year}-${p.month}-${p.day}`;
}

/** 'YYYY-MM-DD' plus `days`, as calendar arithmetic (no time zone involved). */
export function addDays(date, days) {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** The weekday of a calendar date, in English. */
export function weekdayOf(date) {
  return WEEKDAY.format(new Date(`${date}T12:00:00Z`));
}

/**
 * The user's now: { zone, date, weekday, time, tomorrow, yesterday, line }.
 * `line` is what the model reads.
 */
export function clock(zone, at = new Date()) {
  const z = validZone(zone) ? zone : browserZone();
  const p = partsIn(z, at);
  const date = `${p.year}-${p.month}-${p.day}`;
  const time = `${p.hour}:${p.minute}`;
  const tomorrow = addDays(date, 1);
  const yesterday = addDays(date, -1);
  const day = (d) => `${weekdayOf(d)}, ${d}`;
  return {
    zone: z,
    date,
    weekday: weekdayOf(date),
    time,
    tomorrow,
    yesterday,
    line: `Now it is ${day(date)}, ${time} in the user's time zone (${z}). Tomorrow is ${day(tomorrow)}; yesterday was ${day(yesterday)}. Resolve relative dates such as "today", "tomorrow" or "next Monday" against this date.`,
  };
}

/** An instant as the user's local date and time, for the model: "Saturday, 2026-10-31 00:30". */
export function whenIn(zone, value) {
  if (!value) return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  const p = partsIn(zone, d);
  const date = `${p.year}-${p.month}-${p.day}`;
  return `${weekdayOf(date)}, ${date} ${p.hour}:${p.minute}`;
}
