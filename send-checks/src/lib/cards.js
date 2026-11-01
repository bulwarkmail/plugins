/**
 * Payment card numbers in free text: 13 to 19 digits, written together or
 * with single spaces (any kind: also no-break and thin spaces) or dashes,
 * that pass the Luhn check and start like a card a network issues, with a
 * length that network uses. Runs of one repeated digit, the digits of an
 * IBAN found in the same text and numbers after "+" or starting "00"
 * (international phone numbers) don't count. A run that doesn't pass as a
 * whole is tried again as its first 16 digits (4-4-4-4) or 15 (4-6-5), so
 * a card number followed by the expiry date or the security code is found.
 */

import { GROUP_DASHES, GROUP_SPACES } from './separators.js';

/** The Luhn (mod 10) check over a string of digits. */
export function luhnOk(digits) {
  if (!/^\d+$/.test(digits)) return false;
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

/**
 * The networks' number starts and the lengths they use: Visa 4 (13, 16,
 * 19), Mastercard 51-55 and 2221-2720 (16), American Express 34 and 37
 * (15), Diners 300-305, 309, 36, 38, 39 (14-19), JCB 3528-3589 (16-19),
 * Discover 6011, 644-649, 65 and UnionPay 62 (16-19), Maestro 50, 56-58,
 * 67 (13-19). Other starts and other lengths are order and phone numbers
 * more often than cards.
 */
const NETWORKS = [
  { test: (d) => d[0] === '4', lengths: [13, 16, 19] },
  { test: (d) => { const n = Number(d.slice(0, 2)); return n >= 51 && n <= 55; }, lengths: [16] },
  { test: (d) => { const n = Number(d.slice(0, 4)); return n >= 2221 && n <= 2720; }, lengths: [16] },
  { test: (d) => /^3[47]/.test(d), lengths: [15] },
  { test: (d) => /^(?:30[0-5]|309|36|38|39)/.test(d), lengths: [14, 15, 16, 17, 18, 19] },
  { test: (d) => { const n = Number(d.slice(0, 4)); return n >= 3528 && n <= 3589; }, lengths: [16, 17, 18, 19] },
  { test: (d) => /^(?:6011|64[4-9]|65|62)/.test(d), lengths: [16, 17, 18, 19] },
  { test: (d) => /^(?:50|5[6-8]|67)/.test(d), lengths: [13, 14, 15, 16, 17, 18, 19] },
];

export function looksLikeCard(digits) {
  if (digits.length < 13 || digits.length > 19) return false;
  if (/^(\d)\1+$/.test(digits)) return false;
  return NETWORKS.some((n) => n.test(digits) && n.lengths.includes(digits.length));
}

const SEP_CLASS = `[${GROUP_SPACES}${GROUP_DASHES}]`;
/** A run of 13 or more digits, with at most one separator between two digits. */
const RUN = new RegExp(`(?<![0-9.,${GROUP_DASHES}])[0-9](?:${SEP_CLASS}?[0-9]){12,}(?![0-9]|[.,][0-9])`, 'gu');
const SEP = new RegExp(SEP_CLASS, 'u');
const SPACE = new RegExp(`[${GROUP_SPACES}]`, 'u');
const DASH = new RegExp(`[${GROUP_DASHES}]`, 'u');

/** The card number in a run of digit groups, or null: the whole run, else its 4-4-4-4 or 4-6-5 start. */
function cardIn(raw) {
  const groups = raw.split(SEP);
  const lengths = groups.map((g) => g.length);
  const candidates = [groups.join('')];
  const startsWith = (shape) => lengths.length > shape.length && shape.every((len, i) => lengths[i] === len);
  if (startsWith([4, 4, 4, 4])) candidates.push(groups.slice(0, 4).join(''));
  if (startsWith([4, 6, 5])) candidates.push(groups.slice(0, 3).join(''));
  return candidates.find((d) => looksLikeCard(d) && luhnOk(d)) ?? null;
}

/**
 * Every card number in `text`, as { digits, start, end }. `skip` lists
 * ranges (an IBAN's) to leave out.
 */
export function findCards(text, skip = []) {
  const out = [];
  if (!text) return out;
  let m;
  RUN.lastIndex = 0;
  while ((m = RUN.exec(text))) {
    const raw = m[0];
    const start = m.index;
    const end = start + raw.length;
    if (skip.some((r) => start < r.end && end > r.start)) continue;
    // A phone number: "+49 151 ..." (also "+ 49") or "0049 151 ...".
    const before = text.slice(Math.max(0, start - 2), start);
    if (/\+\s?$/u.test(before) || raw.startsWith('00')) continue;
    // Spaces or dashes, not both.
    if (SPACE.test(raw) && DASH.test(raw)) continue;
    const digits = cardIn(raw);
    if (!digits) continue;
    out.push({ digits, start, end });
  }
  return out;
}

/** The last four digits, the only part the warning shows. */
export function cardLastFour(digits) {
  return String(digits ?? '').slice(-4);
}
