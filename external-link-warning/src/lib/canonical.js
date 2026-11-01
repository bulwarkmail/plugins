// URL canonicalisation and the host/path expressions of Google Safe
// Browsing, as https://developers.google.com/safe-browsing/reference/URLs.and.Hashing
// describes them. Google publishes no JavaScript implementation; the tests
// run Google's own examples through this file.
//
// Everything works on "byte strings": JS strings whose characters are all
// below 256, one per byte. Characters above that are UTF-8 encoded first,
// and percent escapes decode to single bytes, so %C3%A9 and a literal é
// both end up as the same two bytes.

/** A string as a byte string (see the top of the file). */
function toByteString(text) {
  let out = '';
  for (const ch of String(text)) {
    const code = ch.codePointAt(0);
    if (code < 0x100) {
      out += ch;
      continue;
    }
    for (const byte of new TextEncoder().encode(ch)) out += String.fromCharCode(byte);
  }
  return out;
}

/** Percent-decode once; a % not followed by two hex digits stays. */
function unescapeOnce(text) {
  return text.replace(/%([0-9a-fA-F]{2})/g, (_m, hex) => String.fromCharCode(parseInt(hex, 16)));
}

/** Percent-decode until nothing changes (Google: "repeatedly"). */
function unescapeFully(text) {
  let current = text;
  // A bound, so a hostile URL can't keep us busy: each round shortens it.
  for (let i = 0; i < 1024; i++) {
    const next = unescapeOnce(current);
    if (next === current) return current;
    current = next;
  }
  return current;
}

/** Escape bytes <= 0x20, >= 0x7f, '#' and '%' as %XX (uppercase hex). */
function escape(text) {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code <= 0x20 || code >= 0x7f || code === 0x23 || code === 0x25) {
      out += '%' + code.toString(16).toUpperCase().padStart(2, '0');
    } else {
      out += text[i];
    }
  }
  return out;
}

/** One part of an IPv4 address in decimal, octal (leading 0) or hex (0x). */
function ipv4Part(part) {
  if (/^0[xX][0-9a-fA-F]*$/.test(part)) return part.length === 2 ? 0 : parseInt(part.slice(2), 16);
  if (/^0[0-7]*$/.test(part)) return part.length === 1 ? 0 : parseInt(part.slice(1), 8);
  if (/^[1-9][0-9]*$/.test(part)) return parseInt(part, 10);
  return null;
}

/**
 * The host as four decimal numbers when it is an IPv4 address in any form
 * inet_aton accepts (1 to 4 parts, the last one filling the rest), else null.
 */
export function normaliseIpv4(host) {
  const parts = host.split('.');
  if (parts.length < 1 || parts.length > 4 || parts.some((p) => p === '')) return null;
  const values = parts.map(ipv4Part);
  if (values.some((v) => v === null || !Number.isFinite(v))) return null;
  const last = values.pop();
  if (values.some((v) => v > 255)) return null;
  const restBytes = 4 - values.length;
  if (last >= 2 ** (8 * restBytes)) return null;
  const bytes = [...values];
  for (let i = restBytes - 1; i >= 0; i--) bytes.push(Math.floor(last / 2 ** (8 * i)) % 256);
  return bytes.join('.');
}

/** A bracketed IPv6 address in its RFC 5952 form (lowercase, shortest), or null. */
export function normaliseIpv6(host) {
  const match = /^\[([0-9a-fA-F:.]+)\]$/.exec(host);
  if (!match) return null;
  let text = match[1].toLowerCase();
  // An IPv4 tail (::ffff:1.2.3.4) becomes two groups.
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (v4) {
    const ip = normaliseIpv4(v4[1]);
    if (!ip) return null;
    const [a, b, c, d] = ip.split('.').map(Number);
    text = text.slice(0, -v4[1].length) + ((a << 8) | b).toString(16) + ':' + ((c << 8) | d).toString(16);
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? head.length !== 8 : missing < 1) return null;
  const groups = [...head, ...Array(halves.length === 2 ? missing : 0).fill('0'), ...tail];
  if (groups.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return null;
  const values = groups.map((g) => parseInt(g, 16).toString(16));
  // The longest run of two or more zero groups becomes "::".
  let bestStart = -1;
  let bestLength = 0;
  for (let i = 0; i < 8;) {
    if (values[i] !== '0') { i++; continue; }
    let j = i;
    while (j < 8 && values[j] === '0') j++;
    if (j - i > bestLength && j - i >= 2) { bestStart = i; bestLength = j - i; }
    i = j;
  }
  if (bestStart < 0) return `[${values.join(':')}]`;
  const left = values.slice(0, bestStart).join(':');
  const right = values.slice(bestStart + bestLength).join(':');
  return `[${left}::${right}]`;
}

function canonicalHost(raw) {
  let host = unescapeFully(raw);
  host = host.replace(/^\.+|\.+$/g, '').replace(/\.{2,}/g, '.').toLowerCase();
  const v6 = normaliseIpv6(host);
  if (v6) return v6;
  const v4 = normaliseIpv4(host);
  if (v4) return v4;
  return host;
}

function canonicalPath(raw) {
  let path = unescapeFully(raw || '/');
  if (!path.startsWith('/')) path = '/' + path;
  path = path.replace(/\/{2,}/g, '/');
  const segments = path.split('/').slice(1);
  const stack = [];
  let trailingSlash = false;
  segments.forEach((segment, i) => {
    const last = i === segments.length - 1;
    if (segment === '.' || segment === '..') {
      if (segment === '..') stack.pop();
      if (last) trailingSlash = true;
      return;
    }
    if (segment === '' && last) {
      trailingSlash = true;
      return;
    }
    stack.push(segment);
  });
  if (stack.length === 0) return '/';
  return '/' + stack.join('/') + (trailingSlash ? '/' : '');
}

/**
 * The canonical form of a URL: `{ scheme, host, path, query }` with every
 * part already escaped (query is null when the URL has no "?"), and `url`,
 * the whole canonical URL. Null when there is no host.
 */
export function canonicalize(input) {
  let text = toByteString(input).replace(/[\t\r\n]/g, '').replace(/^[\x00-\x20]+|[\x00-\x20]+$/g, '');
  const hash = text.indexOf('#');
  if (hash >= 0) text = text.slice(0, hash);
  let scheme = 'http';
  const schemeMatch = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\//.exec(text);
  if (schemeMatch) {
    scheme = schemeMatch[1].toLowerCase();
    text = text.slice(schemeMatch[0].length);
  }
  const authorityEnd = text.search(/[/?]/);
  let authority = authorityEnd < 0 ? text : text.slice(0, authorityEnd);
  let rest = authorityEnd < 0 ? '' : text.slice(authorityEnd);
  const at = authority.lastIndexOf('@');
  if (at >= 0) authority = authority.slice(at + 1);
  // The port: after the last ':' outside an IPv6 bracket.
  const portMatch = /:(\d*)$/.exec(authority);
  if (portMatch && !(authority.startsWith('[') && !authority.slice(0, portMatch.index).endsWith(']'))) {
    authority = authority.slice(0, portMatch.index);
  }
  const host = escape(canonicalHost(authority));
  if (!host) return null;
  let query = null;
  const q = rest.indexOf('?');
  if (q >= 0) {
    query = escape(unescapeFully(rest.slice(q + 1)));
    rest = rest.slice(0, q);
  }
  const path = escape(canonicalPath(rest));
  const url = `${scheme}://${host}${path}${query === null ? '' : `?${query}`}`;
  return { scheme, host, path, query, url };
}

/** The host suffixes to look up: the host, then up to four from its last five parts. */
export function hostSuffixes(host) {
  const out = [host];
  if (normaliseIpv4(host) === host || host.startsWith('[')) return out;
  const parts = host.split('.');
  // Start from the last five components and drop one at a time, never
  // down to the top-level domain alone.
  const start = Math.max(1, parts.length - 5);
  for (let i = start; i <= parts.length - 2 && out.length < 5; i++) {
    const suffix = parts.slice(i).join('.');
    if (!out.includes(suffix)) out.push(suffix);
  }
  return out;
}

/** The path prefixes to look up: with query, without, then up to four from the root. */
export function pathPrefixes(path, query) {
  const out = [];
  if (query !== null && query !== undefined) out.push(`${path}?${query}`);
  out.push(path);
  const segments = path.split('/').slice(1, -1);
  const prefixes = ['/'];
  let current = '/';
  for (const segment of segments) {
    if (prefixes.length >= 4) break;
    current += `${segment}/`;
    prefixes.push(current);
  }
  for (const prefix of prefixes) {
    if (out.length >= 6) break;
    if (!out.includes(prefix)) out.push(prefix);
  }
  return out;
}

/** Every host/path expression of a URL (at most 30), or [] when it has no host. */
export function expressions(input) {
  const canonical = canonicalize(input);
  if (!canonical) return [];
  const out = [];
  for (const host of hostSuffixes(canonical.host)) {
    for (const path of pathPrefixes(canonical.path, canonical.query)) {
      const expression = `${host}${path}`;
      if (!out.includes(expression)) out.push(expression);
    }
  }
  return out.slice(0, 30);
}
