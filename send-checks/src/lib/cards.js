/**
 * Payment card numbers in free text: 13 to 19 digits, written together or
 * with single spaces or dashes, that pass the Luhn check and start like a
 * card a network issues. Runs of one repeated digit and the digits of an
 * IBAN found in the same text don't count.
 */

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
 * Starts the networks issue cards with: Visa 4, Mastercard 51-55 and
 * 2221-2720, American Express 34 and 37, Diners 30, 36, 38, 39, Discover
 * 6011, 64, 65, JCB 35, UnionPay 62, Maestro 50, 56-58, 6. Numbers that
 * start with 0, 1, 7, 8 or 9 (phone and account numbers) are left out.
 */
export function looksLikeCard(digits) {
  if (digits.length < 13 || digits.length > 19) return false;
  if (/^(\d)\1+$/.test(digits)) return false;
  const two = Number(digits.slice(0, 2));
  const four = Number(digits.slice(0, 4));
  if (digits[0] === '4') return true;
  if (two >= 51 && two <= 55) return true;
  if (four >= 2221 && four <= 2720) return true;
  if ([30, 34, 35, 36, 37, 38, 39].includes(two)) return true;
  if (digits[0] === '5' || digits[0] === '6') return true;
  return false;
}

/** Separators: all spaces or all dashes, never mixed, one at a time. */
const RUN = /(?<![\d.,-])\d(?:[ -]?\d){12,18}(?![\d]|[.,]\d)/g;

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
    const seps = raw.replace(/\d/g, '');
    if (seps && !/^( +|-+)$/.test(seps)) continue;
    const digits = raw.replace(/\D/g, '');
    if (!looksLikeCard(digits) || !luhnOk(digits)) continue;
    out.push({ digits, start, end });
  }
  return out;
}

/** The last four digits, the only part the warning shows. */
export function cardLastFour(digits) {
  return String(digits ?? '').slice(-4);
}
