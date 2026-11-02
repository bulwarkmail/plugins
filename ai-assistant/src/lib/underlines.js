// The grammar check's suggestions as underlines in the composer (Bulwark
// 1.20 and later): the open suggestions of a review become annotations for
// the host's text checker hook (api.composer.setAnnotations), on demand only,
// never while the user types.
//
// The model corrected `source`, the message as getBody gave it. The host
// cuts the message into paragraphs ("segments") with one character per
// editor position: U+FFFC stands for a mention or an image, which getBody
// leaves out. Each segment is found in `source` in order, and a suggestion
// becomes an annotation only when it lies inside one segment.

export const CHECKER_ID = 'ai-grammar';

/** Register the on-demand checker; false on a Bulwark without the hook. */
export async function registerGrammarChecker(api, label) {
  if (typeof api?.composer?.registerChecker !== 'function') return false;
  try {
    await api.composer.registerChecker({ id: CHECKER_ID, label, kinds: ['grammar'], mode: 'on-demand' });
    return true;
  } catch (err) {
    api.log?.warn?.('registerChecker failed', err?.message ?? err);
    return false;
  }
}

function leadingSpace(s) {
  return s.length - s.trimStart().length;
}

function trailingSpace(s) {
  return s.length - s.trimEnd().length;
}

/**
 * Annotations for the open suggestions of a review.
 * - request: what api.composer.getCheckText returned
 * - source: the text the model corrected
 * - segments, states: the review (grammar.js diffSuggestions / reviewStep)
 */
export function annotationsFromReview(request, source, segments, states, message) {
  const objectChar = request?.objectReplacement ?? '\uFFFC';
  // Where each open change is in the source.
  const changes = [];
  let pos = 0;
  for (const s of segments ?? []) {
    if (s.kind === 'same') { pos += s.text.length; continue; }
    if (!states?.[s.id] && s.from.trim() && s.to.trim()) changes.push({ id: s.id, start: pos, from: s.from, to: s.to });
    pos += s.from.length;
  }
  if (!changes.length) return [];

  // Where each segment is in the source, and its positions without objects.
  const located = [];
  let cursor = 0;
  for (const seg of request?.segments ?? []) {
    const map = [];
    let plain = '';
    for (let i = 0; i < seg.text.length; i++) {
      if (seg.text[i] === objectChar) continue;
      map.push(i);
      plain += seg.text[i];
    }
    if (!plain.trim()) continue;
    const at = source.indexOf(plain, cursor);
    if (at < 0) continue;
    located.push({ seg, at, plain, map });
    cursor = at + plain.length;
  }

  const out = [];
  for (const c of changes) {
    // Without the spaces around it: "teh  " → "the " underlines "teh".
    const lead = leadingSpace(c.from);
    const trail = trailingSpace(c.from);
    const start = c.start + lead;
    const end = c.start + c.from.length - trail;
    const replacement = c.to.slice(leadingSpace(c.to), c.to.length - trailingSpace(c.to));
    if (end <= start || !replacement || replacement.includes('\n')) continue;
    const loc = located.find((l) => start >= l.at && end <= l.at + l.plain.length);
    if (!loc) continue;
    const from = loc.map[start - loc.at];
    const to = loc.map[end - 1 - loc.at] + 1;
    if (loc.seg.text.slice(from, to).includes(objectChar)) continue;
    out.push({ segmentId: loc.seg.id, offset: from, length: to - from, kind: 'grammar', message, replacements: [replacement], id: c.id });
  }
  return out;
}

/** Show a review's open suggestions as underlines; quiet when the host can't. */
export async function showUnderlines(api, composerId, request, source, review, message) {
  if (!request || typeof api?.composer?.setAnnotations !== 'function') return;
  const annotations = annotationsFromReview(request, source, review.segments, review.states, message);
  try {
    await api.composer.setAnnotations(composerId, CHECKER_ID, request.revision, annotations);
  } catch (err) {
    api.log?.debug?.('setAnnotations failed', err?.message ?? err);
  }
}

/** The message's text for underlining, or null where checking is off or the host is older. */
export async function checkText(api, composerId) {
  if (typeof api?.composer?.getCheckText !== 'function') return null;
  try {
    return await api.composer.getCheckText(composerId, CHECKER_ID);
  } catch {
    return null;
  }
}
