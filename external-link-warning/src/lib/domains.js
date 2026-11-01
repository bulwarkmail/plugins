// Trusted domains and the host a link goes to.

export function normaliseDomain(raw) {
  let d = String(raw).trim().toLowerCase();
  if (!d) return '';
  d = d.replace(/^\*\./, '');
  d = d.replace(/^https?:\/\//, '');
  d = d.replace(/[/?#].*$/, '');
  d = d.replace(/:\d+$/, '');
  d = d.replace(/\.+$/, '');
  return d;
}

/** A comma-, space- or newline-separated list (or an array) as domains. */
export function parseDomains(input) {
  if (!input) return [];
  const list = Array.isArray(input) ? input.map(String) : String(input).split(/[\s,;]+/);
  return [...new Set(list.map(normaliseDomain).filter(Boolean))];
}

/** The lowercase host of an http(s) link; '' for anything else (mailto:, relative). */
export function hostnameFromHref(href) {
  try {
    const url = new URL(href);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
    return url.hostname.toLowerCase().replace(/\.+$/, '');
  } catch {
    return '';
  }
}

/** True when the host is one of the domains or a subdomain of one. */
export function isTrusted(hostname, list) {
  if (!hostname) return false;
  for (const d of list) {
    if (!d) continue;
    if (hostname === d || hostname.endsWith('.' + d)) return true;
  }
  return false;
}

/**
 * The domain a link's visible text names, when it looks like a web address
 * ("paypal.com", "https://paypal.com/login", "www.paypal.com"), else ''.
 * Plain words ("Click here") name none.
 */
export function domainInText(text) {
  if (typeof text !== 'string') return '';
  const trimmed = text.trim();
  if (!trimmed || trimmed.length > 200 || /\s/.test(trimmed)) return '';
  // An address with a scheme, or something shaped like host.tld[/...].
  let candidate = trimmed;
  if (!/^https?:\/\//i.test(candidate)) {
    if (!/^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}(?:[:/?#].*)?$/i.test(candidate)) return '';
    candidate = `http://${candidate}`;
  }
  const host = hostnameFromHref(candidate);
  return host.includes('.') ? host : '';
}

/**
 * The domain the link text names when it isn't where the link goes (the
 * text says paypal.com, the link goes to paypal.com.evil.example), else ''.
 * A text naming the target host or a parent domain of it matches.
 */
export function linkTextMismatch(text, targetHost) {
  const named = domainInText(text);
  if (!named || !targetHost) return '';
  const strip = (h) => h.replace(/^www\./, '');
  const a = strip(named);
  const b = strip(targetHost);
  if (a === b || b.endsWith('.' + a)) return '';
  return named;
}
