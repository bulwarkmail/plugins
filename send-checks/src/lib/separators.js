/**
 * The characters account and card numbers are grouped with, ready for a
 * regular expression character class: spaces (also no-break, figure, thin
 * and narrow no-break spaces, which word processors and some mail apps put
 * in numbers) and dashes (also the Unicode hyphens and en dash).
 */

const chars = (...codes) => String.fromCharCode(...codes);

export const GROUP_SPACES = ` ${chars(0xa0, 0x2007, 0x2009, 0x202f)}`;
export const GROUP_DASHES = `\\-${chars(0x2010, 0x2011, 0x2012, 0x2013)}`;

/** One grouping character. */
export const GROUP_SEPARATOR = new RegExp(`[${GROUP_SPACES}${GROUP_DASHES}]`, 'u');
