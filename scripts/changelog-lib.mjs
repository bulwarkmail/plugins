// Reading and writing a plugin's CHANGELOG.md.
//
//   # Changelog
//
//   ## Unreleased
//
//   ## 1.4.1 (2026-10-29)
//
//   ### Fixed
//   - Sort the signed attributes in DER order. #31 (thanks @kah-ja)
//
// A version section is a level-2 heading that starts with the version, with or
// without brackets or a "v", and maybe a date after it. The extension directory
// reads the tagged version's section the same way.

export const GROUPS = ['Breaking', 'Security', 'Added', 'Changed', 'Fixed'];

const SECTION = /^##(?!#)\s*(.*?)\s*$/;
const SUBSECTION = /^###(?!#)\s*(.*?)\s*$/;

/** The version a level-2 heading names, "unreleased", or null. */
export function headingVersion(title) {
  if (/^\[?unreleased\]?$/i.test(title)) return 'unreleased';
  const m = title.match(/^\[?v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)\]?(?=$|[\s(:-])/);
  return m ? m[1] : null;
}

/** Level-2 sections as { title, version, start, end } (line indexes, end exclusive). */
export function sections(lines) {
  const out = [];
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*(```|~~~)/.test(lines[i])) inFence = !inFence;
    if (inFence) continue;
    const m = lines[i].match(SECTION);
    if (!m) continue;
    if (out.length) out[out.length - 1].end = i;
    out.push({ title: m[1], version: headingVersion(m[1]), start: i, end: lines.length });
  }
  return out;
}

const splitLines = (text) => text.replace(/\r\n/g, '\n').split('\n');
const trimBlank = (lines) => {
  let a = 0;
  let b = lines.length;
  while (a < b && !lines[a].trim()) a++;
  while (b > a && !lines[b - 1].trim()) b--;
  return lines.slice(a, b);
};

/** The notes of one version ("unreleased" for that section), trimmed; null when there is no such section. */
export function sectionBody(text, version) {
  const lines = splitLines(text);
  const s = sections(lines).find((x) => x.version === version);
  return s ? trimBlank(lines.slice(s.start + 1, s.end)).join('\n') : null;
}

/** Whether notes say anything: a line that is not blank and not a heading. */
export function hasNotes(body) {
  return !!body && splitLines(body).some((l) => l.trim() && !/^#{1,6}\s/.test(l));
}

export const newChangelog = (eol = '\n') => ['# Changelog', '', '## Unreleased', ''].join(eol);

/**
 * A commit as a changelog entry: { group, text }, or null for commits users
 * don't notice (chore, test, ci, docs, style, build).
 */
export function commitEntry({ subject, body = '' }) {
  const m = subject.match(/^(\w+)(?:\([^)]*\))?(!)?:\s*(.+)$/);
  const type = m ? m[1].toLowerCase() : null;
  if (type && ['chore', 'test', 'tests', 'ci', 'docs', 'style', 'build'].includes(type)) return null;
  const summary = (m ? m[3] : subject).trim();
  const text = summary.charAt(0).toUpperCase() + summary.slice(1);
  const breaking = !!m?.[2] || /^BREAKING[ -]CHANGE:/m.test(body);
  let group = 'Changed';
  if (breaking) group = 'Breaking';
  else if (/\bGHSA(-[23456789cfghjmpqrvwx]{4}){3}\b/i.test(`${subject}\n${body}`) || type === 'security') group = 'Security';
  else if (type === 'feat') group = 'Added';
  else if (type === 'fix') group = 'Fixed';
  return { group, text };
}

/** Commits as entries per group, in the order given, without repeats. */
export function groupCommits(commits) {
  const groups = {};
  for (const c of commits) {
    const e = commitEntry(c);
    if (!e) continue;
    let text = e.text;
    if (c.pr && !/#\d+\b/.test(text)) text += ` #${c.pr}`;
    if (c.thanks) text += ` (thanks @${c.thanks})`;
    const list = (groups[e.group] ??= []);
    if (!list.includes(text)) list.push(text);
  }
  return groups;
}

const normal = (s) => s.replace(/^[-*]\s+/, '').replace(/\s+/g, ' ').trim().toLowerCase();

/**
 * Add entries to the Unreleased section, creating the section (or the file,
 * when text is empty) if needed. An entry already anywhere in the section is
 * not added again. Keeps the file's line ends.
 */
export function addToUnreleased(text, groups) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = splitLines(text.trim() ? text : newChangelog());
  let s = sections(lines).find((x) => x.version === 'unreleased');
  if (!s) {
    // Above the first version, or at the end.
    const first = sections(lines)[0];
    const at = first ? first.start : lines.length;
    const insert = first ? ['## Unreleased', ''] : [...(lines[lines.length - 1]?.trim() ? [''] : []), '## Unreleased', ''];
    lines.splice(at, 0, ...insert);
    s = sections(lines).find((x) => x.version === 'unreleased');
  }

  const body = lines.slice(s.start + 1, s.end);
  const seen = new Set(body.filter((l) => /^\s*[-*]\s/.test(l)).map(normal));
  // The section's own lines, split at its ### headings.
  const parts = [{ title: null, lines: [] }];
  for (const l of body) {
    const m = l.match(SUBSECTION);
    if (m) parts.push({ title: m[1], lines: [] });
    else parts[parts.length - 1].lines.push(l);
  }
  for (const g of GROUPS) {
    const fresh = (groups[g] ?? []).filter((t) => !seen.has(normal(t)));
    if (!fresh.length) continue;
    let part = parts.find((p) => p.title?.toLowerCase() === g.toLowerCase());
    if (!part) {
      part = { title: g, lines: [] };
      // Known groups in their usual order, before any the author made up.
      const after = parts.findIndex((p) => p.title && GROUPS.indexOf(p.title) > GROUPS.indexOf(g));
      const custom = parts.findIndex((p) => p.title && !GROUPS.includes(p.title));
      const at = [after, custom].filter((i) => i > 0).sort((a, b) => a - b)[0] ?? parts.length;
      parts.splice(at, 0, part);
    }
    part.lines = [...trimBlank(part.lines), ...fresh.map((t) => `- ${t}`)];
    fresh.forEach((t) => seen.add(normal(t)));
  }

  const out = [''];
  const intro = trimBlank(parts[0].lines);
  if (intro.length) out.push(...intro, '');
  for (const p of parts.slice(1)) out.push(`### ${p.title}`, ...trimBlank(p.lines), '');
  lines.splice(s.start + 1, s.end - s.start - 1, ...out);
  return lines.join(eol).replace(/(\r?\n)*$/, eol);
}

/**
 * Turn the Unreleased section into the version's section and start a new,
 * empty Unreleased above it. When Unreleased has no notes, nothing changes
 * and `released` is false.
 */
export function releaseUnreleased(text, version, date) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = splitLines(text);
  const s = sections(lines).find((x) => x.version === 'unreleased');
  if (!s || !hasNotes(lines.slice(s.start + 1, s.end).join('\n'))) return { text, released: false };
  lines.splice(s.start, 1, '## Unreleased', '', `## ${version} (${date})`);
  return { text: lines.join(eol), released: true };
}
