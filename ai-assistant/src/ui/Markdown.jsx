// A small Markdown renderer for the assistant's answers: paragraphs,
// headings, bullet and numbered lists, quotes, code, bold, italic and links.
// It builds React elements only (never HTML), so an answer can't inject
// markup into the frame. Links open in a new tab through the host; a link
// whose text is not its own address, or whose address could mislead, shows
// the host it leads to next to it.

import { Fragment } from 'react';

// Blocks are spaced like a short document: a gap between paragraphs, air
// around lists and headings, real bullets (the frame's CSS reset removes
// them), nothing after the last block.
const GAP = 10;
const styles = {
  root: { fontSize: '0.875rem', lineHeight: 1.55, overflowWrap: 'anywhere' },
  p: { margin: `0 0 ${GAP}px` },
  h: { margin: `${GAP + 4}px 0 4px`, fontWeight: 600, fontSize: '0.95em', lineHeight: 1.3 },
  ul: { margin: `0 0 ${GAP}px`, paddingInlineStart: 22, listStyleType: 'disc', listStylePosition: 'outside' },
  ol: { margin: `0 0 ${GAP}px`, paddingInlineStart: 22, listStyleType: 'decimal', listStylePosition: 'outside' },
  li: { margin: '4px 0', paddingInlineStart: 2, display: 'list-item' },
  quote: { margin: `0 0 ${GAP}px`, padding: '2px 0 2px 10px', borderInlineStart: '2px solid var(--color-border)', color: 'var(--color-muted-foreground)' },
  pre: { margin: `0 0 ${GAP}px`, padding: '8px 10px', background: 'var(--color-muted)', borderRadius: 6, overflowX: 'auto', fontSize: '0.9em', whiteSpace: 'pre-wrap' },
  code: { padding: '1px 4px', background: 'var(--color-muted)', borderRadius: 4, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: '0.9em' },
  hr: { border: 0, borderTop: '1px solid var(--color-border)', margin: `${GAP}px 0` },
  link: { color: 'var(--color-primary)', textDecoration: 'underline', background: 'none', border: 0, padding: 0, font: 'inherit', cursor: 'pointer' },
  host: { color: 'var(--color-muted-foreground)', fontSize: '0.9em' },
  table: { borderCollapse: 'collapse', margin: `0 0 ${GAP}px`, fontSize: '0.95em' },
  cell: { border: '1px solid var(--color-border)', padding: '4px 8px', verticalAlign: 'top' },
};

/** The block's style, with no margin above the first block and none below the last. */
function at(style, i, n) {
  const out = { ...style };
  if (i === 0) out.marginTop = 0;
  if (i === n - 1) out.marginBottom = 0;
  if (i === 0 && i === n - 1) out.margin = 0;
  return out;
}

/** Blocks of a Markdown text: { kind, ... }. */
export function parseBlocks(text) {
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
  const blocks = [];
  let i = 0;
  const flushParagraph = (buf) => {
    if (buf.length) blocks.push({ kind: 'p', lines: buf.splice(0) });
  };
  const para = [];
  while (i < lines.length) {
    const line = lines[i];
    const fence = /^\s*```(\w*)\s*$/.exec(line);
    if (fence) {
      flushParagraph(para);
      const code = [];
      i++;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) code.push(lines[i++]);
      i++;
      blocks.push({ kind: 'code', text: code.join('\n'), lang: fence[1] });
      continue;
    }
    if (!line.trim()) { flushParagraph(para); i++; continue; }
    const heading = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (heading) { flushParagraph(para); blocks.push({ kind: 'h', level: heading[1].length, text: heading[2] }); i++; continue; }
    if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) { flushParagraph(para); blocks.push({ kind: 'hr' }); i++; continue; }
    const bullet = /^\s{0,3}[-*•]\s+(.*)$/;
    const numbered = /^\s{0,3}\d{1,3}[.)]\s+(.*)$/;
    if (bullet.test(line) || numbered.test(line)) {
      flushParagraph(para);
      const ordered = numbered.test(line);
      const re = ordered ? numbered : bullet;
      const items = [];
      while (i < lines.length && re.test(lines[i])) {
        let item = re.exec(lines[i])[1];
        i++;
        // Continuation lines indented under the item.
        while (i < lines.length && /^\s{2,}\S/.test(lines[i]) && !re.test(lines[i]) && !bullet.test(lines[i]) && !numbered.test(lines[i])) item += `\n${lines[i++].trim()}`;
        items.push(item);
      }
      blocks.push({ kind: ordered ? 'ol' : 'ul', items });
      continue;
    }
    if (/^\s{0,3}>\s?/.test(line)) {
      flushParagraph(para);
      const quote = [];
      while (i < lines.length && /^\s{0,3}>\s?/.test(lines[i])) quote.push(lines[i++].replace(/^\s{0,3}>\s?/, ''));
      blocks.push({ kind: 'quote', lines: quote });
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1])) {
      flushParagraph(para);
      const cells = (l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
      const columns = cells(line);
      i += 2;
      const rows = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) rows.push(cells(lines[i++]));
      blocks.push({ kind: 'table', columns, rows });
      continue;
    }
    para.push(line);
    i++;
  }
  flushParagraph(para);
  return blocks;
}

const INLINE_RE = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(__[^_\n]+__)|(\*[^*\n]+\*)|(\b_[^_\n]+_\b)|(~~[^~\n]+~~)|(\[[^\]\n]+\]\((https?:\/\/[^)\s]+)\))|(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])/g;

/** Characters that change the direction text is shown in; a link's text drops them. */
const DIRECTION_CONTROLS = /[؜‎‏‪-‮⁦-⁩]/g;
/** Something in brackets that looks like a host ("(bank.example)"). */
const BRACKETED_HOST = String.raw`[(\[（［]\s*[^\s()\[\]（）［］]+\.[^\s()\[\]（）［］]+\s*[)\]）］]`;
const ENDS_IN_HOST = new RegExp(`${BRACKETED_HOST}\\s*$`);
const STARTS_WITH_HOST = new RegExp(`^\\s*${BRACKETED_HOST}`);

/**
 * The host a link leads to, for showing next to its text. '' when the text
 * is the link's own address (scheme, case and a closing slash aside), which
 * already says where it goes, unless that address could mislead: a user
 * part before the host ("https://bank.example@other.example/"), a host in
 * punycode or other than ASCII letters (shown as the browser reads it), or
 * bracketed text that looks like a host at the end of the link's text or
 * right after the link (`after`).
 */
export function linkHost(label, href, after = '') {
  let url;
  try {
    url = new URL(href);
  } catch {
    return String(href);
  }
  const host = url.host || String(href);
  const bare = (value) => String(value ?? '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/$/, '');
  if (bare(label) !== bare(href)) return host;
  const misleading = url.username !== '' || url.password !== ''
    || url.hostname.split('.').some((part) => part.startsWith('xn--'))
    || ENDS_IN_HOST.test(label) || STARTS_WITH_HOST.test(after);
  return misleading ? host : '';
}

/** The host next to a link, isolated so text around it can't turn it around. */
const hostOf = (host) => <>{' '}<bdi dir="ltr" data-link-host style={styles.host}>({host})</bdi></>;

/** Inline Markdown as React nodes. `open(url)` handles links. */
export function renderInline(text, open, keyBase = 'i') {
  const out = [];
  let last = 0;
  let n = 0;
  const push = (node) => { out.push(<Fragment key={`${keyBase}${n++}`}>{node}</Fragment>); };
  for (const m of String(text ?? '').matchAll(INLINE_RE)) {
    if (m.index > last) push(text.slice(last, m.index));
    const [whole, code, bold, bold2, em, em2, strike, link, href, bare] = m;
    const after = text.slice(m.index + whole.length);
    if (code) push(<code style={styles.code}>{whole.slice(1, -1)}</code>);
    else if (bold || bold2) push(<strong>{renderInline(whole.slice(2, -2), open, `${keyBase}${n}b`)}</strong>);
    else if (em || em2) push(<em>{renderInline(whole.slice(1, -1), open, `${keyBase}${n}e`)}</em>);
    else if (strike) push(<del>{whole.slice(2, -2)}</del>);
    else if (link) {
      const label = whole.slice(1, whole.indexOf('](')).replace(DIRECTION_CONTROLS, '');
      const host = linkHost(label, href, after);
      push(
        <>
          <button type="button" style={styles.link} onClick={() => open?.(href)} title={href}>{label}</button>
          {host && hostOf(host)}
        </>,
      );
    } else if (bare) {
      const label = bare.replace(DIRECTION_CONTROLS, '');
      const host = linkHost(label, bare, after);
      push(
        <>
          <button type="button" style={styles.link} onClick={() => open?.(bare)} title={bare}>{label}</button>
          {host && hostOf(host)}
        </>,
      );
    }
    last = m.index + whole.length;
  }
  if (last < text.length) push(text.slice(last));
  return out;
}

function Lines({ lines, open, keyBase }) {
  return lines.map((line, i) => (
    <Fragment key={`${keyBase}${i}`}>
      {i > 0 && <br />}
      {renderInline(line, open, `${keyBase}${i}-`)}
    </Fragment>
  ));
}

/** The answer as formatted text. `onOpenLink(url)` is called for links. */
export function Markdown({ text, onOpenLink }) {
  const blocks = parseBlocks(text);
  const open = onOpenLink ?? (() => {});
  const n = blocks.length;
  return (
    <div data-markdown style={styles.root}>
      {blocks.map((b, i) => {
        const key = `b${i}`;
        switch (b.kind) {
          case 'h': return <div key={key} role="heading" aria-level={Math.min(6, b.level + 2)} style={at(styles.h, i, n)}>{renderInline(b.text, open, `${key}-`)}</div>;
          case 'ul': return <ul key={key} style={at(styles.ul, i, n)}>{b.items.map((item, j) => <li key={j} style={styles.li}><Lines lines={item.split('\n')} open={open} keyBase={`${key}-${j}-`} /></li>)}</ul>;
          case 'ol': return <ol key={key} style={at(styles.ol, i, n)}>{b.items.map((item, j) => <li key={j} style={styles.li}><Lines lines={item.split('\n')} open={open} keyBase={`${key}-${j}-`} /></li>)}</ol>;
          case 'quote': return <blockquote key={key} style={at(styles.quote, i, n)}><Lines lines={b.lines} open={open} keyBase={`${key}-`} /></blockquote>;
          case 'code': return <pre key={key} style={at(styles.pre, i, n)}><code>{b.text}</code></pre>;
          case 'hr': return <hr key={key} style={at(styles.hr, i, n)} />;
          case 'table': return (
            <table key={key} style={at(styles.table, i, n)}>
              <thead><tr>{b.columns.map((c, j) => <th key={j} style={{ ...styles.cell, fontWeight: 600 }}>{renderInline(c, open, `${key}h${j}-`)}</th>)}</tr></thead>
              <tbody>{b.rows.map((row, r) => <tr key={r}>{b.columns.map((_, j) => <td key={j} style={styles.cell}>{renderInline(row[j] ?? '', open, `${key}r${r}c${j}-`)}</td>)}</tr>)}</tbody>
            </table>
          );
          default: return <p key={key} style={at(styles.p, i, n)}><Lines lines={b.lines} open={open} keyBase={`${key}-`} /></p>;
        }
      })}
    </div>
  );
}

/** The text without Markdown marks, for the clipboard and the message. */
export function stripMarkdown(text) {
  return parseBlocks(text).map((b) => {
    const plain = (s) => String(s).replace(/`([^`]+)`/g, '$1').replace(/\*\*([^*]+)\*\*/g, '$1').replace(/__([^_]+)__/g, '$1').replace(/(^|\W)\*([^*]+)\*/g, '$1$2').replace(/~~([^~]+)~~/g, '$1').replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, '$1 ($2)');
    switch (b.kind) {
      case 'h': return plain(b.text);
      case 'ul': return b.items.map((it) => `- ${plain(it)}`).join('\n');
      case 'ol': return b.items.map((it, i) => `${i + 1}. ${plain(it)}`).join('\n');
      case 'quote': return b.lines.map((l) => `> ${plain(l)}`).join('\n');
      case 'code': return b.text;
      case 'hr': return '';
      case 'table': return [b.columns.join(' | '), ...b.rows.map((r) => r.join(' | '))].join('\n');
      default: return b.lines.map(plain).join('\n');
    }
  }).filter((s) => s !== '').join('\n\n');
}
