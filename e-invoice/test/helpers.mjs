import { readFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const here = (p) => new URL(p, import.meta.url);

export const fixture = (name) => readFileSync(here(`fixtures/${name}`), 'utf8');
export const manifest = JSON.parse(readFileSync(here('../manifest.json'), 'utf8'));

/** api.i18n's lookup over the manifest's strings, for present() and friends. */
export function i18nFor(locale = 'en') {
  const strings = { ...manifest.locales.en, ...(manifest.locales[locale] || {}) };
  return {
    locale,
    has: (key) => key in strings,
    t: (key, vars = {}) => (strings[key] ?? key).replace(/\{(\w+)\}/g, (m, k) => (vars[k] !== undefined ? String(vars[k]) : m)),
  };
}

const enc = (s) => new TextEncoder().encode(s);
const concat = (parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
};

/**
 * A small PDF with embedded files, laid out like a ZUGFeRD PDF: a stream
 * object /Type /EmbeddedFile per file and a /Filespec pointing at it.
 * `lengthAs`: 'direct' (/Length 123), 'ref' (/Length 9 0 R) or 'wrong'
 * (a /Length longer than the data, so the reader has to find endstream).
 */
export function makePdf(files, { lengthAs = 'direct', compress = true, junkAfterData = false, hexNames = false } = {}) {
  const parts = [enc('%PDF-1.7\n%\xe2\xe3\xcf\xd3\n'), enc('1 0 obj\n<< /Type /Catalog >>\nendobj\n')];
  let objectNumber = 10;
  for (const { name, content } of files) {
    const raw = typeof content === 'string' ? enc(content) : content;
    let data = compress ? new Uint8Array(deflateSync(raw)) : raw;
    if (junkAfterData) data = concat([data, enc('\n\n')]);
    const streamNo = objectNumber++;
    const lengthNo = objectNumber++;
    const specNo = objectNumber++;
    const length = lengthAs === 'ref' ? `${lengthNo} 0 R` : lengthAs === 'wrong' ? String(data.length + 500) : String(data.length);
    parts.push(enc(`${streamNo} 0 obj\n<< /Type /EmbeddedFile /Subtype /text#2Fxml ${compress ? '/Filter /FlateDecode ' : ''}/Length ${length} /Params << /Size ${raw.length} >> >>\nstream\n`));
    parts.push(data);
    parts.push(enc('\nendstream\nendobj\n'));
    parts.push(enc(`${lengthNo} 0 obj\n${data.length}\nendobj\n`));
    const fileName = hexNames ? `<FEFF${[...name].map((c) => c.charCodeAt(0).toString(16).padStart(4, '0')).join('')}>` : `(${name})`;
    parts.push(enc(`${specNo} 0 obj\n<< /Type /Filespec /F ${fileName} /UF ${fileName} /AFRelationship /Alternative /EF << /F ${streamNo} 0 R /UF ${streamNo} 0 R >> >>\nendobj\n`));
  }
  parts.push(enc('trailer\n<< /Root 1 0 R >>\n%%EOF\n'));
  return concat(parts);
}
