// Small helpers for reading invoice XML by local element names, so the
// same code reads UBL, CII and ZUGFeRD 1.0 whatever prefixes the sender
// chose. Paths are slash-separated local names: 'PostalTradeAddress/CityName'.

export function parseXml(text) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  const error = doc.getElementsByTagName('parsererror')[0];
  if (error || !doc.documentElement) throw new Error('not well-formed XML');
  return doc;
}

/** The element children of `el` named `name` (local name). */
export function kids(el, name) {
  const out = [];
  if (!el) return out;
  for (let c = el.firstElementChild; c; c = c.nextElementSibling) {
    if (c.localName === name) out.push(c);
  }
  return out;
}

/** Every element reached by `path` from `el`. */
export function all(el, path) {
  let level = el ? [el] : [];
  for (const step of path.split('/')) {
    level = level.flatMap((e) => kids(e, step));
    if (!level.length) break;
  }
  return level;
}

/** The first element reached by any of `paths`. */
export function one(el, ...paths) {
  for (const path of paths) {
    const found = all(el, path)[0];
    if (found) return found;
  }
  return null;
}

/** The trimmed text of the first element reached by any of `paths`, or ''. */
export function text(el, ...paths) {
  const found = paths.length ? one(el, ...paths) : el;
  return found ? found.textContent.replace(/\s+/g, ' ').trim() : '';
}

/** Like text(), but keeps line breaks (notes, payment terms). */
export function block(el, ...paths) {
  const found = paths.length ? one(el, ...paths) : el;
  if (!found) return '';
  return found.textContent.replace(/\r\n?/g, '\n').split('\n').map((l) => l.trim()).join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

export function attr(el, name) {
  return el ? (el.getAttribute(name) || '').trim() : '';
}

/** A decimal amount, or null when there is none. */
export function num(el, ...paths) {
  const value = text(el, ...paths);
  if (!value) return null;
  const n = Number(value.replace(/\s/g, ''));
  return Number.isFinite(n) ? n : null;
}
