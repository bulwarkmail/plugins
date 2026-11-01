/**
 * Runs the admin's rules over a message on its way out (onBeforeEmailSend's
 * OutgoingEmail) and lists what matched, and what couldn't be checked.
 *
 * Scanned: the subject, the user's own text (`authoredText`, without the
 * quoted original and the signature; `textBody` on hosts that don't send
 * it), attachment names, and the text of text attachments when the host
 * passes it (`textExcerpt`, the first 1 MB). Matches carry only a masked
 * form of what was found.
 *
 * Couldn't be checked (`incomplete`), each with the action of the rule it
 * belongs to, so a blocking rule stops the send (fail closed):
 * - 'patterns': the patterns ran out of time, or no Worker could run them;
 * - 'invalid-pattern': a pattern line the plugin refused or can't read;
 * - 'unreadable': an attachment the host couldn't read (`unreadable: true`),
 *   for the type rules and, for a text file, the text rules.
 */

import { findIbans, maskIban } from './iban.js';
import { cardLastFour, findCards } from './cards.js';
import { findKeywords, maskMatch, parseKeywords, parsePatterns } from './text-rules.js';
import { runPatterns } from './pattern-runner.js';
import { attachmentProblems, isEmptyList, isTextAttachment, maxBytes, parseTypeList } from './attachments.js';

/**
 * Whether the message goes outside the organisation. The host lists those
 * recipients (`externalRecipients`); a host that doesn't is treated as if
 * every recipient were outside, so an "outside only" rule still runs.
 */
export function goesOutside(email) {
  if (Array.isArray(email?.externalRecipients)) return email.externalRecipients.length > 0;
  return ['to', 'cc', 'bcc'].some((f) => Array.isArray(email?.[f]) && email[f].some((r) => String(r ?? '').trim()));
}

/** The texts to scan, each with where it came from (null = the message itself). */
export function textsOf(email) {
  const own = typeof email?.authoredText === 'string' ? email.authoredText : String(email?.textBody ?? '');
  const out = [
    { where: null, text: String(email?.subject ?? '') },
    { where: null, text: own },
  ];
  for (const file of Array.isArray(email?.attachments) ? email.attachments : []) {
    if (file && typeof file.textExcerpt === 'string' && file.textExcerpt && isTextAttachment(file)) {
      out.push({ where: String(file.name || 'attachment'), text: file.textExcerpt });
    }
    if (file && file.name) out.push({ where: null, text: String(file.name), isName: true });
  }
  return out;
}

/** Compiled rules for a config, so a send doesn't parse the lists again. */
export function compileRules(config) {
  const patterns = parsePatterns(config.patterns);
  return {
    config,
    keywords: parseKeywords(config.keywords),
    patterns: patterns.rules,
    skippedPatterns: patterns.skipped,
    blocked: parseTypeList(config.blockedTypes),
    allowed: parseTypeList(config.allowedTypes),
    limit: maxBytes(config.maxSizeMb),
  };
}

function applies(actionValue, externalOnly, outside) {
  return !!actionValue && actionValue !== 'off' && (!externalOnly || outside);
}

const stricter = (a, b) => (a === 'block' || b === 'block' ? 'block' : a || b);

/**
 * What matched and what couldn't be checked:
 * { found: [{ rule, action, externalOnly, where, ...details }], incomplete:
 * [{ kind, action, externalOnly, name? }], outside }.
 * found: rule iban { masked }, card { last4 }, keyword { keyword }, pattern
 * { name, masked }, type { name, type, reason }, size { name, maxMb }.
 * Each match is listed once. `runner` runs the patterns (pattern-runner.js).
 */
export async function evaluate(email, compiled, { runner = runPatterns } = {}) {
  const { config } = compiled;
  const outside = goesOutside(email);
  const found = [];
  const incomplete = [];
  const seen = new Set();
  const push = (key, finding) => {
    if (seen.has(key)) return;
    seen.add(key);
    found.push(finding);
  };

  const doIban = applies(config.ibanAction, config.ibanExternalOnly, outside);
  const doCard = applies(config.cardAction, config.cardExternalOnly, outside);
  const doKeyword = compiled.keywords.length > 0 && applies(config.keywordAction, config.keywordExternalOnly, outside);
  const patternLines = compiled.patterns.length + compiled.skippedPatterns.length;
  const doPattern = patternLines > 0 && applies(config.patternAction, config.patternExternalOnly, outside);
  const patternBase = { action: config.patternAction, externalOnly: config.patternExternalOnly };

  const texts = textsOf(email).filter((t) => t.text);
  for (const { where, text, isName } of texts) {
    const ibans = doIban || doCard ? findIbans(text) : [];
    if (doIban) {
      for (const iban of ibans) {
        push(`iban|${iban.value}`, { rule: 'iban', action: config.ibanAction, externalOnly: config.ibanExternalOnly, where, masked: maskIban(iban.value) });
      }
    }
    if (doCard && !isName) {
      for (const card of findCards(text, ibans)) {
        push(`card|${card.digits}`, { rule: 'card', action: config.cardAction, externalOnly: config.cardExternalOnly, where, last4: cardLastFour(card.digits) });
      }
    }
    if (doKeyword) {
      for (const keyword of findKeywords(text, compiled.keywords)) {
        push(`keyword|${keyword.toLowerCase()}`, { rule: 'keyword', action: config.keywordAction, externalOnly: config.keywordExternalOnly, where, keyword });
      }
    }
  }

  if (doPattern) {
    // A line the admin wrote that can't run is a rule that isn't checked.
    for (const skipped of compiled.skippedPatterns) {
      incomplete.push({ kind: 'invalid-pattern', name: skipped.name, ...patternBase });
    }
    if (compiled.patterns.length > 0) {
      const result = await runner(texts.map((t) => t.text), compiled.patterns);
      if (!result.complete) incomplete.push({ kind: 'patterns', ...patternBase });
      for (const hit of result.found) {
        const where = texts[hit.text]?.where ?? null;
        push(`pattern|${hit.name}|${hit.match}`, { rule: 'pattern', ...patternBase, where, name: hit.name, masked: maskMatch(hit.match) });
      }
    }
  }

  const doAttachments = applies(config.attachmentAction, config.attachmentExternalOnly, outside);
  if (doAttachments) {
    for (const problem of attachmentProblems(email?.attachments, compiled)) {
      const base = { action: config.attachmentAction, externalOnly: config.attachmentExternalOnly, where: null, name: problem.name };
      if (problem.kind === 'type') push(`type|${problem.name}`, { ...base, rule: 'type', type: problem.type, reason: problem.reason });
      else push(`size|${problem.name}`, { ...base, rule: 'size', maxMb: config.maxSizeMb });
    }
  }

  // Files the host couldn't read: neither their type nor their text is known.
  const typeRules = doAttachments && !(isEmptyList(compiled.blocked) && isEmptyList(compiled.allowed));
  for (const file of Array.isArray(email?.attachments) ? email.attachments : []) {
    if (!file || file.unreadable !== true) continue;
    let action = '';
    let externalOnly = true;
    const take = (a, ext) => { action = stricter(action, a); externalOnly = externalOnly && ext; };
    if (typeRules && !file.inline) take(config.attachmentAction, config.attachmentExternalOnly);
    if (isTextAttachment(file)) {
      if (doIban) take(config.ibanAction, config.ibanExternalOnly);
      if (doCard) take(config.cardAction, config.cardExternalOnly);
      if (doKeyword) take(config.keywordAction, config.keywordExternalOnly);
      if (doPattern) take(config.patternAction, config.patternExternalOnly);
    }
    if (action) incomplete.push({ kind: 'unreadable', name: String(file.name || 'attachment'), action, externalOnly });
  }

  return { found, incomplete, outside };
}

/**
 * The problem of one file at upload time, or null. Only for a blocking rule
 * that doesn't depend on the recipients: those aren't known yet, so the
 * rest waits for Send. A file the host couldn't read is 'unreadable' when
 * type rules are set.
 */
export function uploadProblem(file, compiled) {
  const { config } = compiled;
  if (config.attachmentAction !== 'block' || config.attachmentExternalOnly) return null;
  const [problem] = attachmentProblems([{ ...file, inline: !!file?.inline }], compiled);
  if (problem) return problem;
  if (file?.unreadable === true && !(isEmptyList(compiled.blocked) && isEmptyList(compiled.allowed))) {
    return { name: String(file.name || 'attachment'), kind: 'unreadable' };
  }
  return null;
}
