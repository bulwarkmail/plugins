/**
 * IBANs in free text: a country code, two check digits and the country's
 * fixed number of characters, with single spaces allowed between them (the
 * usual groups of four), checked with ISO 7064 mod 97-10. Only numbers that
 * pass the check count, so an order number that happens to start with two
 * letters is left alone.
 */

// Lengths from the SWIFT IBAN registry.
export const IBAN_LENGTHS = {
  AD: 24, AE: 23, AL: 28, AT: 20, AZ: 28, BA: 20, BE: 16, BG: 22, BH: 22, BI: 27,
  BR: 29, BY: 28, CH: 21, CR: 22, CY: 28, CZ: 24, DE: 22, DJ: 27, DK: 18, DO: 28,
  EE: 20, EG: 29, ES: 24, FI: 18, FK: 18, FO: 18, FR: 27, GB: 22, GE: 22, GI: 23,
  GL: 18, GR: 27, GT: 28, HN: 28, HR: 21, HU: 28, IE: 22, IL: 23, IQ: 23, IS: 26,
  IT: 27, JO: 30, KW: 30, KZ: 20, LB: 28, LC: 32, LI: 21, LT: 20, LU: 20, LV: 21,
  LY: 25, MC: 27, MD: 24, ME: 22, MK: 19, MN: 20, MR: 27, MT: 31, MU: 30, NI: 28,
  NL: 18, NO: 15, OM: 23, PK: 24, PL: 28, PS: 29, PT: 25, QA: 29, RO: 24, RS: 22,
  RU: 33, SA: 24, SC: 31, SD: 18, SE: 24, SI: 19, SK: 24, SM: 27, SO: 23, ST: 25,
  SV: 28, TL: 23, TN: 24, TR: 26, UA: 29, VA: 22, VG: 24, XK: 20, YE: 30,
};

const ALNUM = /[A-Za-z0-9]/;

/** ISO 7064 mod 97-10 over an IBAN without spaces (upper case). */
export function ibanChecksumOk(iban) {
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]+$/.test(iban)) return false;
  const moved = iban.slice(4) + iban.slice(0, 4);
  let rest = 0;
  for (const ch of moved) {
    const code = ch.charCodeAt(0);
    const digits = code >= 65 ? String(code - 55) : ch;
    for (const d of digits) rest = (rest * 10 + (d.charCodeAt(0) - 48)) % 97;
  }
  return rest === 1;
}

/** True for a whole IBAN, spaces allowed. */
export function isValidIban(value) {
  const compact = String(value ?? '').replace(/\s+/g, '').toUpperCase();
  const length = IBAN_LENGTHS[compact.slice(0, 2)];
  return !!length && compact.length === length && ibanChecksumOk(compact);
}

/**
 * Every valid IBAN in `text`, as { value (compact, upper case), start, end }.
 * `end` is the index after the last character of the match in `text`.
 */
export function findIbans(text) {
  const out = [];
  if (!text) return out;
  const start = /(?<![A-Za-z0-9])([A-Za-z]{2})(\d{2})/g;
  let m;
  while ((m = start.exec(text))) {
    const country = m[1].toUpperCase();
    const length = IBAN_LENGTHS[country];
    if (!length) continue;
    let compact = country + m[2];
    let i = m.index + 4;
    let end = i;
    while (i < text.length && compact.length < length) {
      const ch = text[i];
      if (ALNUM.test(ch)) {
        compact += ch.toUpperCase();
        i += 1;
        end = i;
      } else if (ch === ' ' && i + 1 < text.length && ALNUM.test(text[i + 1])) {
        i += 1;
      } else {
        break;
      }
    }
    // The next character must not continue the number.
    if (compact.length !== length || (end < text.length && ALNUM.test(text[end]))) continue;
    if (!ibanChecksumOk(compact)) continue;
    out.push({ value: compact, start: m.index, end });
    start.lastIndex = end;
  }
  return out;
}

/** "DE89 … 3000": country, check digits and the last four only. */
export function maskIban(compact) {
  const value = String(compact ?? '');
  return `${value.slice(0, 4)} … ${value.slice(-4)}`;
}
